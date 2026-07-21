#!/bin/bash
# Headless test runner: browser unit suite + full E2E walk + hard offline check.
# Requires Google Chrome (macOS path below) and Node 22+. No dependencies.
#
#   ./tests/e2e.sh        (from the repo root)
#
# Note: plain `--dump-dom` headless Chrome hangs on this machine, which is why
# these drive Chrome over the DevTools protocol (port 9223) instead.
set -u
cd "$(dirname "$0")/.." || exit 1

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT=8741
PROFILE="$(mktemp -d)/chrome-profile"

cleanup() {
  [ -n "${CHROME_PID:-}" ] && kill "$CHROME_PID" 2>/dev/null
  pkill -f "http.server $PORT" 2>/dev/null
}
trap cleanup EXIT

pkill -f "http.server $PORT" 2>/dev/null
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
sleep 1

"$CHROME" --headless=new --disable-gpu --no-first-run --disable-extensions \
  --remote-debugging-port=9223 --user-data-dir="$PROFILE" about:blank >/dev/null 2>&1 &
CHROME_PID=$!

FAIL=0
echo "── Browser unit suite (tests/test.html) ──"
node tests/cdp-unit.mjs || FAIL=1
echo "── E2E walk (full workout flow) ──"
node tests/cdp-e2e.mjs || FAIL=1
echo "── Hard offline check (kills the server) ──"
node tests/cdp-offline.mjs || FAIL=1

exit $FAIL
