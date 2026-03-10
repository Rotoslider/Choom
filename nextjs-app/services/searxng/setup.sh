#!/bin/bash
# SearXNG Local Setup for Choom
# Installs SearXNG in a Python venv, no Docker required
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/venv"
SEARXNG_DIR="$SCRIPT_DIR/searxng-src"

echo "=== SearXNG Setup for Choom ==="

# 1. Clone SearXNG if not present
if [ ! -d "$SEARXNG_DIR" ]; then
    echo "Cloning SearXNG..."
    git clone https://github.com/searxng/searxng.git "$SEARXNG_DIR" --depth 1
else
    echo "SearXNG source already exists, pulling latest..."
    cd "$SEARXNG_DIR" && git pull && cd "$SCRIPT_DIR"
fi

# 2. Create venv if not present
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating Python venv..."
    python3 -m venv "$VENV_DIR"
fi

# 3. Install dependencies
echo "Installing dependencies..."
source "$VENV_DIR/bin/activate"
pip install -U pip setuptools wheel 2>&1 | tail -1
pip install -e "$SEARXNG_DIR" 2>&1 | tail -1

# 4. Link settings
SEARXNG_SETTINGS="$SEARXNG_DIR/searx/settings.yml"
if [ -f "$SEARXNG_SETTINGS" ]; then
    mv "$SEARXNG_SETTINGS" "$SEARXNG_SETTINGS.default"
fi
ln -sf "$SCRIPT_DIR/settings.yml" "$SEARXNG_SETTINGS"

echo ""
echo "=== Setup Complete ==="
echo "Start with: ./start.sh"
echo "Test:       curl 'http://localhost:8888/search?q=test&format=json' | python3 -m json.tool | head -20"
