#!/usr/bin/env bash
# Smoke test of a built image: what a container must be able to do before it is
# worth publishing. The Docker workflow runs it on every build; it runs just as
# well locally:
#
#   docker build -t nsupysonic:dev . && docker/smoke.sh nsupysonic:dev
#
# A build that succeeds proves the Dockerfile ran. It says nothing about whether
# ffmpeg still has the filters the analysis drives, whether the SPA made it into
# the package, whether the entrypoint still bootstraps the admin, or whether the
# server answers at all — each of which a green build has shipped broken before
# in some project, and none of which a user can see until they pull it.
set -euo pipefail

IMAGE="${1:?usage: docker/smoke.sh IMAGE}"

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
step() { echo "== $*"; }
inside() { docker run --rm --entrypoint "$1" "$IMAGE" "${@:2}"; }

step "runs as the unprivileged user"
[ "$(inside id -u)" = "1000" ] || fail "the container does not run as uid 1000"

step "ffmpeg has every filter and encoder the app drives"
filters="$(inside ffmpeg -hide_banner -filters)"
# analysis.py (aspectralstats, ebur128, ametadata, lowpass) and edges.py
# (silencedetect); aresample is what every -ar conversion inserts.
for f in aspectralstats ebur128 ametadata lowpass silencedetect aresample; do
    grep -qw "$f" <<<"$filters" || fail "ffmpeg lacks the $f filter"
done
encoders="$(inside ffmpeg -hide_banner -encoders)"
# default.conf transcodes to Opus; FLAC for the party and exports; MP3 exports.
for e in libopus flac libmp3lame; do
    grep -qw "$e" <<<"$encoders" || fail "ffmpeg lacks the $e encoder"
done
inside ffmpeg -v error -nostdin -f lavfi -i "sine=frequency=440:duration=1" \
    -c:a libopus -b:a 64k -f ogg -y /dev/null \
    || fail "ffmpeg cannot encode Opus"

step "the Python side is complete, and the build tools are gone"
docker run --rm -i --entrypoint python "$IMAGE" - <<'EOF' || fail "python checks"
import importlib.util
import os

import gunicorn, numpy, onnxruntime, psycopg2  # noqa: F401 - the extras
import supysonic.web  # noqa: F401 - the app itself
import supysonic.webui as webui

dist = os.path.join(os.path.dirname(webui.__file__), "dist")
assert os.path.isfile(os.path.join(dist, "index.html")), "the SPA is not installed"
wasm = [n for _r, _d, files in os.walk(dist) for n in files if n.endswith(".wasm")]
assert any(n.startswith("rhythm") for n in wasm), f"no rhythm analyser in {wasm}"

from supysonic.deezer import embedding
assert embedding.available(), "the embedding extractor reports itself unavailable"

for tool in ("pip", "setuptools", "wheel"):
    assert importlib.util.find_spec(tool) is None, f"{tool} is still in the venv"
print("python: ok")
EOF

step "boots, bootstraps the admin, serves the SPA and the Subsonic API"
password="smoke-$RANDOM$RANDOM$RANDOM"
cid="$(docker run -d -p 127.0.0.1::5722 \
    -e DATABASE_URI=sqlite:////data/db/smoke.db \
    -e SUPYSONIC_ADMIN_USER=smoke \
    -e SUPYSONIC_ADMIN_PASSWORD="$password" \
    "$IMAGE")"
cleanup() {
    status=$?
    if [ "$status" -ne 0 ]; then
        echo "---- container log (last 60 lines) ----" >&2
        docker logs --tail 60 "$cid" >&2 || true
    fi
    docker rm -f "$cid" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mapping="$(docker port "$cid" 5722/tcp)"
port="$(sed -n '1s/.*://p' <<<"$mapping")"
[ -n "$port" ] || fail "no host port was published: $mapping"
base="http://127.0.0.1:$port"
for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "$base/app/" 2>/dev/null; then
        break
    fi
    [ "$(docker inspect -f '{{.State.Running}}' "$cid")" = "true" ] \
        || fail "the container exited during startup"
    sleep 1
done

# Output is captured before it is searched, never piped into `grep -q`: grep
# exits at its first match, the writer then dies of SIGPIPE, and pipefail
# turns a match into a failure.
page="$(curl -fsS "$base/app/")" || fail "/app/ did not answer"
grep -qi "<html" <<<"$page" || fail "/app/ does not serve the SPA"

ping="$(curl -fsS "$base/rest/ping.view?u=smoke&p=$password&c=smoke&v=1.16.0&f=json")"
grep -q '"status": *"ok"' <<<"$ping" || fail "the admin cannot log in: $ping"

refused="$(curl -fsS "$base/rest/ping.view?u=smoke&p=wrong&c=smoke&v=1.16.0&f=json")"
grep -q '"status": *"failed"' <<<"$refused" || fail "a wrong password was accepted: $refused"

logs="$(docker logs "$cid" 2>&1)"
grep -q "Created admin user 'smoke'" <<<"$logs" \
    || fail "the entrypoint did not report creating the admin"

step "healthy"
