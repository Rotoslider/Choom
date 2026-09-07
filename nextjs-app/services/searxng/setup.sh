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
    # --copies, NOT the default symlinks. These venvs live inside the Next.js
    # project, and a venv created with symlinks puts "bin/python3 -> /usr/bin/python3"
    # in the tree. Turbopack walks the project directory while resolving the skill
    # registry's runtime imports, hits a symlink pointing outside the filesystem
    # root, and `next build` dies with:
    #   Symlink services/*/venv/bin/python is invalid, it points out of the
    #   filesystem root
    # --copies keeps a real interpreter binary in the venv instead (~8MB) and the
    # build works. Do not drop this flag.
    # Pick the interpreter explicitly rather than trusting whatever `python3`
    # currently points at. SearXNG pulls native wheels (lxml, curl_cffi,
    # msgspec) that lag new CPython releases, and Homebrew's python3 is well
    # ahead of them — on macOS it is 3.14. Prefer a version the wheels exist
    # for. Override with $PYTHON_BIN.
    PYTHON_CMD="${PYTHON_BIN:-}"
    if [ -z "$PYTHON_CMD" ]; then
        for candidate in python3.12 python3.11 python3.13 python3; do
            if command -v "$candidate" >/dev/null 2>&1; then
                PYTHON_CMD="$candidate"
                break
            fi
        done
    fi
    echo "Using Python: $PYTHON_CMD ($($PYTHON_CMD --version 2>&1))"
    "$PYTHON_CMD" -m venv --copies "$VENV_DIR"
fi

# 3. Install dependencies
echo "Installing dependencies..."
source "$VENV_DIR/bin/activate"
pip install -U pip setuptools wheel

# Runtime requirements MUST go in before the editable install. SearXNG's
# setup.py imports searx/__init__.py, which imports msgspec at build time, so
# a plain `pip install -e .` on a clean venv dies with
# "ModuleNotFoundError: No module named 'msgspec'" while merely computing the
# build requirements. Installing requirements.txt first breaks the cycle, and
# --no-build-isolation lets the build see them.
pip install -r "$SEARXNG_DIR/requirements.txt"
pip install --no-build-isolation -e "$SEARXNG_DIR"

# 4. Settings
# Do NOT replace searx/settings.yml — that file is SearXNG's packaged set of
# defaults, and our settings.yml is a *user overlay* that says
# `use_default_settings: engines: keep_only:`. Moving the defaults aside and
# symlinking the overlay over them leaves nothing to merge against, and
# SearXNG dies at startup with `KeyError: 'engines'`.
#
# start.sh points $SEARXNG_SETTINGS_PATH at the overlay instead, which is the
# supported way to layer custom settings over the defaults.
if [ -L "$SEARXNG_DIR/searx/settings.yml" ]; then
    echo "Removing legacy settings symlink and restoring packaged defaults..."
    rm -f "$SEARXNG_DIR/searx/settings.yml"
    [ -f "$SEARXNG_DIR/searx/settings.yml.default" ] &&
        mv "$SEARXNG_DIR/searx/settings.yml.default" "$SEARXNG_DIR/searx/settings.yml"
fi

echo ""
echo "=== Setup Complete ==="
echo "Start with: ./start.sh"
echo "Test:       curl 'http://localhost:8888/search?q=test&format=json' | python3 -m json.tool | head -20"
