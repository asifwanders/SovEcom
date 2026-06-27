#!/bin/sh
# Container entrypoint for the admin and setup Vite SPAs.
# Rewrites /srv/config.js with the real API_BASE_URL from the environment,
# replacing the placeholder baked in at build time. Then hands off to Caddy.
#
# Usage:  docker run -e API_BASE_URL=https://api.example.com <image>
#
set -eu

CONFIG_FILE="/srv/config.js"
RUNTIME_BASE="${API_BASE_URL:-}"

if [ -n "$RUNTIME_BASE" ]; then
  printf 'window.__SOVECOM__ = { apiBaseUrl: "%s" };\n' "$RUNTIME_BASE" > "$CONFIG_FILE"
  echo "[entrypoint-spa] config.js written: apiBaseUrl=$RUNTIME_BASE"
else
  echo "[entrypoint-spa] API_BASE_URL not set — config.js placeholder left as-is (build-time fallback will be used)"
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
