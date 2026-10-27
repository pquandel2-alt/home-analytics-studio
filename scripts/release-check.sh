#!/bin/sh
# Full local release check: backend tests, frontend type check/tests/build, add-on image build + smoke start.
#   VENV=/path/to/venv scripts/release-check.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="${VENV:-$ROOT/.venv}"
ADDON="$ROOT/home_analytics_studio"
VERSION="$(sed -n 's/^version: "\(.*\)"/\1/p' "$ADDON/config.yaml")"
echo "== Backend-Tests"; (cd "$ADDON/backend" && "$VENV/bin/python" -m pytest -q)
echo "== Frontend"; (cd "$ADDON/frontend" && npm run typecheck && npx vitest run && npx vite build)
echo "== Docker-Build $VERSION"
DOCKER="${DOCKER:-docker}"
$DOCKER build --build-arg BUILD_VERSION="$VERSION" -t "local/home-analytics-studio:$VERSION" "$ADDON"
echo "== Container-Start"
TMP="$(mktemp -d)"
CID=$($DOCKER run -d -v "$TMP:/data" -p 127.0.0.1:38099:8099 "local/home-analytics-studio:$VERSION")
trap '$DOCKER rm -f $CID >/dev/null' EXIT
i=0; until curl -sf http://127.0.0.1:38099/api/health; do i=$((i+1)); [ $i -gt 30 ] && exit 1; sleep 1; done
echo; echo "OK: Release-Check $VERSION erfolgreich"
