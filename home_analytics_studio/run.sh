#!/bin/sh
# Start script of the Home Analytics Studio add-on.
set -e
cd /opt/has

# Direct LAN port: the Supervisor maps 8100/tcp to the host port configured in the
# add-on "Network" tab. If the user disabled the mapping, the listener stays internal.
export HAS_INGRESS_PORT="${HAS_INGRESS_PORT:-8099}"
export HAS_DIRECT_PORT="${HAS_DIRECT_PORT:-8100}"

echo "[home-analytics-studio] Starte (Ingress ${HAS_INGRESS_PORT}, Direktport ${HAS_DIRECT_PORT})"
exec python3 -m has
