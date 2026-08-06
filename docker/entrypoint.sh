#!/bin/sh
# Entrypoint for the NSupySonic image.
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
umask 077

mkdir -p /data/db /data/cache /data/archive 2>/dev/null || true

CONF=/data/supysonic.conf

render_config() {
    # The Android app version this image expects clients to run. Defaults to the
    # image's own release (baked as APP_VERSION on tagged builds) since both are
    # built from the same tag; the web player only mentions an update when this
    # is set and newer than the installed app.
    ANDROID_VERSION="${ANDROID_VERSION_NAME:-$APP_VERSION}"

    # Only generate when env-driven config is requested.
    [ -n "$DEEZER_ARL" ] || [ -n "$DATABASE_URI" ] \
        || [ -n "$SUPYSONIC_PROXY_HOPS" ] || [ -n "$SUPYSONIC_SESSION_COOKIE_SECURE" ] \
        || [ -n "$ANDROID_VERSION" ] || [ -n "$ANDROID_DOWNLOAD_URL" ] \
        || return 0

    {
        if [ -n "$DATABASE_URI" ]; then
            printf '[base]\n'
            printf 'database_uri = %s\n\n' "$DATABASE_URI"
        fi
        # Reverse-proxy / TLS hardening (off unless explicitly set).
        if [ -n "$SUPYSONIC_PROXY_HOPS" ] || [ -n "$SUPYSONIC_SESSION_COOKIE_SECURE" ] \
           || [ -n "$ANDROID_VERSION" ] || [ -n "$ANDROID_DOWNLOAD_URL" ]; then
            printf '[webapp]\n'
            [ -n "$SUPYSONIC_PROXY_HOPS" ] && printf 'proxy_fix_hops = %s\n' "$SUPYSONIC_PROXY_HOPS"
            [ -n "$SUPYSONIC_SESSION_COOKIE_SECURE" ] && printf 'session_cookie_secure = %s\n' "$SUPYSONIC_SESSION_COOKIE_SECURE"
            [ -n "$ANDROID_VERSION" ] && printf 'android_version = %s\n' "$ANDROID_VERSION"
            [ -n "$ANDROID_DOWNLOAD_URL" ] && printf 'android_url = %s\n' "$ANDROID_DOWNLOAD_URL"
            printf '\n'
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
    # The file holds the ARL — a full-account Deezer credential. Default umask
    # 022 left it world-readable on a shared volume.
    chmod 600 "$CONF"
    echo "Rendered $CONF from environment."
}

LEGACY_SQLITE=/data/db/supysonic.db

auto_migrate() {
    # One-shot, transparent SQLite -> external DB migration. Triggers only when
    # the deployment has switched DATABASE_URI to Postgres/MySQL *and* a legacy
    # SQLite database with data is still on the volume.
    [ -n "$DATABASE_URI" ] || return 0
    case "$DATABASE_URI" in
        sqlite*) return 0 ;;  # still on SQLite, nothing to migrate
    esac
    [ -f "$LEGACY_SQLITE" ] || return 0  # no legacy data to carry over

    echo "Found legacy SQLite DB and an external DATABASE_URI; migrating data…"
    if supysonic-cli db migrate-to "$DATABASE_URI" \
        --from "sqlite:///$LEGACY_SQLITE" --skip-if-populated; then
        # A deployment that has been on the external DB for a while (many
        # boots, many upgrades) hits "already populated" every single time —
        # that still ran a full connect-and-check against $DATABASE_URI on
        # every startup for no reason, and one broken migration step (e.g. a
        # bug in a migration script) then failed the boot outright even though
        # the real database was already fine. Once the external DB is
        # confirmed populated, retire the legacy file so this never runs
        # again — rename, not delete, so the data is still there if needed.
        if [ -f "$LEGACY_SQLITE" ]; then
            mv "$LEGACY_SQLITE" "$LEGACY_SQLITE.migrated" 2>/dev/null || true
        fi
        echo "Data migration step complete."
    else
        echo "Data migration step failed; check the destination database." >&2
        return 1
    fi
}

bootstrap_admin() {
    [ -n "$SUPYSONIC_ADMIN_USER" ] || return 0

    if [ -z "$SUPYSONIC_ADMIN_PASSWORD" ]; then
        # No password given: mint one instead of silently doing nothing, and
        # print it once. Beats any shared default.
        SUPYSONIC_ADMIN_PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
        GENERATED_PASSWORD=1
    fi

    # The documented placeholder is the password that actually ships to
    # production more often than any other. Refuse to start with it.
    case "$SUPYSONIC_ADMIN_PASSWORD" in
        changeme|supysonic|password|admin|123456)
            echo "Refusing to create the admin account with the placeholder password" >&2
            echo "'$SUPYSONIC_ADMIN_PASSWORD'. Set SUPYSONIC_ADMIN_PASSWORD to a real secret." >&2
            exit 1
            ;;
    esac

    # `user add` initializes the DB schema and is non-interactive with -p.
    # It fails if the user already exists, which we treat as "nothing to do".
    #
    # The password goes in on stdin: passing it as an argv element exposes it to
    # every process on the host through `ps`.
    if printf '%s' "$SUPYSONIC_ADMIN_PASSWORD" \
        | supysonic-cli user add "$SUPYSONIC_ADMIN_USER" --password-stdin 2>/dev/null; then
        supysonic-cli user setroles "$SUPYSONIC_ADMIN_USER" -A 2>/dev/null || true
        echo "Created admin user '$SUPYSONIC_ADMIN_USER'."
        if [ -n "$GENERATED_PASSWORD" ]; then
            echo "Generated admin password: $SUPYSONIC_ADMIN_PASSWORD"
            echo "Store it now — it is not printed again."
        fi
    fi
}

render_config

# Only touch the database when actually starting the server. Migration must run
# before bootstrap_admin: creating the admin would make the destination "non
# empty" and cause the migration to skip.
case "$1" in
    gunicorn | supysonic-server)
        auto_migrate
        bootstrap_admin
        ;;
esac

exec "$@"
