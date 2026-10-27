#!/bin/sh
# Local development / demo: starts the Home Assistant simulator and the app.
#   VENV=/path/to/venv DATA=/tmp/has-data scripts/dev-run.sh
# UI: http://localhost:18099 (acts as trusted "ingress" from 127.0.0.1) or :18100 (login)
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="${VENV:-$ROOT/.venv}"
DATA="${DATA:-/tmp/has-data}"
mkdir -p "$DATA"
cd "$ROOT/home_analytics_studio/backend"
"$VENV/bin/python" -m tests.mock_ha --port 18123 --token test --days "${DAYS:-14}" > "$DATA/mock.log" 2>&1 &
MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT INT TERM
sleep 2
HAS_DATA_DIR="$DATA" HAS_HA_URL=http://127.0.0.1:18123 HAS_HA_TOKEN=test \
HAS_INGRESS_PORT=18099 HAS_DIRECT_PORT=18100 HAS_INGRESS_TRUSTED_IPS=127.0.0.1 \
HAS_STATIC_DIR="$ROOT/home_analytics_studio/frontend/dist" \
  "$VENV/bin/python" -m has
