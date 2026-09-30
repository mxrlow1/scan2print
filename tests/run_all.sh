#!/usr/bin/env bash
# Runs every test. Needs: node 18+, python3 + playwright (pip install playwright numpy && playwright install chromium webkit)
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-8931}
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 & SRV=$!
trap "kill $SRV 2>/dev/null || true" EXIT
sleep 1
export S2P_URL="http://127.0.0.1:$PORT/"
node tests/meshops.test.mjs
node tests/fusion.test.mjs
python3 tests/make_fixtures.py
python3 tests/e2e.py chromium
python3 tests/e2e.py webkit
python3 tests/pwa.py
python3 tests/sw_upgrade.py
python3 tests/scan_e2e.py
python3 tests/screenshots.py
