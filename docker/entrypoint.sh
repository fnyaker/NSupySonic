#!/bin/sh
# Entrypoint for the NSupySonic-Deezer image.
#
# Two ways to configure the container:
#   1. Env vars (great for docker compose / .env) — this script renders
#      /data/supysonic.conf from them. supysonic reads "supysonic.conf" from the
#      working dir (/data) last, so it overrides the baked /etc/supysonic.
#   2. Mount your own file at /etc/supysonic (set no Deezer/DB env vars).
#
# It also auto-creates an admin user on first boot when SUPYSONIC_ADMIN_USER and
# SUPYSONIC_ADMIN_PASSWORD are set (idempotent).
set -e

mkdir -p /data/db /data/cache /data/archive 2>/dev/null || true

CONF=/data/supysonic.conf

render_config() {
    # Only generate when env-driven config is requested.
    [ -n "$DEEZER_ARL" ] || [ -n "$DATABASE_URI" ] || return 0

    {
        if [ -n "$DATABASE_URI" ]; then
            printf '[base]\n'
            printf 'database_uri = %s\n\n' "$DATABASE_URI"
        fi
        if [ -n "$DEEZER_ARL" ]; then
            printf '[deezer]\n'
            printf 'enabled = %s\n' "${DEEZER_ENABLED:-yes}"
            printf 'arl = %s\n' "$DEEZER_ARL"
            printf 'archive_dir = %s\n' "${DEEZER_ARCHIVE_DIR:-/data/archive}"
            printf 'default_quality = %s\n' "${DEEZER_QUALITY:-FLAC}"
            printf 'sync_user = %s\n' "${DEEZER_SYNC_USER:-${SUPYSONIC_ADMIN_USER:-admin}}"
            printf 'sync_playlists = %s\n' "${DEEZER_SYNC_PLAYLISTS:-yes}"
            printf 'sync_favorites = %s\n' "${DEEZER_SYNC_FAVORITES:-yes}"
            printf 'import_new_releases = %s\n' "${DEEZER_IMPORT_NEW_RELEASES:-yes}"
            printf 'push_to_deezer = %s\n' "${DEEZER_PUSH:-yes}"
            printf 'scan_local = %s\n' "${DEEZER_SCAN_LOCAL:-yes}"
            printf 'report_listens = %s\n' "${DEEZER_REPORT_LISTENS:-no}"
            printf 'preload = %s\n' "${DEEZER_PRELOAD:-yes}"
            [ -n "$DEEZER_SYNC_AT" ] && printf 'sync_at = %s\n' "$DEEZER_SYNC_AT"
            printf '\n'
        fi
    } >"$CONF"
    echo "Rendered $CONF from environment."
}

bootstrap_admin() {
    [ -n "$SUPYSONIC_ADMIN_USER" ] && [ -n "$SUPYSONIC_ADMIN_PASSWORD" ] || return 0
    # `user add` initializes the DB schema and is non-interactive with -p.
    # It fails if the user already exists, which we treat as "nothing to do".
    if supysonic-cli user add "$SUPYSONIC_ADMIN_USER" -p "$SUPYSONIC_ADMIN_PASSWORD" 2>/dev/null; then
        supysonic-cli user setroles "$SUPYSONIC_ADMIN_USER" -A 2>/dev/null || true
        echo "Created admin user '$SUPYSONIC_ADMIN_USER'."
    fi
}

render_config

# Only touch the database when actually starting the server.
case "$1" in
    gunicorn | supysonic-server)
        bootstrap_admin
        ;;
esac

exec "$@"
