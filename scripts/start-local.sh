#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export WP3_PROJECT_ROOT="$(pwd -P)"
docker info >/dev/null
if [[ "${1:-start}" == "stop" ]]; then
  docker compose down
  exit 0
fi
test -f data/routing/manifest.json
test ! -f data/routing/.incomplete
docker compose up --build --detach
printf 'WP3: http://127.0.0.1:5173\nStop this stack: bash scripts/start-local.sh stop\n'
