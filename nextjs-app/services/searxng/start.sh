#!/bin/bash
# Start SearXNG for Choom
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/venv"
SEARXNG_DIR="$SCRIPT_DIR/searxng-src"

if [ ! -d "$VENV_DIR" ]; then
    echo "Run ./setup.sh first"
    exit 1
fi

source "$VENV_DIR/bin/activate"
export SEARXNG_SETTINGS_PATH="$SCRIPT_DIR/settings.yml"

echo "Starting SearXNG on http://localhost:8888 ..."
echo "Settings: $SEARXNG_SETTINGS_PATH"
echo "Test: curl 'http://localhost:8888/search?q=test&format=json' | python3 -m json.tool | head -20"
echo ""
cd "$SEARXNG_DIR"
exec python -m searx.webapp
