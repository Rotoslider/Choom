#!/bin/bash
# Run script for Choom Memory Server

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check if venv exists
if [ ! -d "venv" ]; then
    echo "Virtual environment not found. Running setup first..."
    ./setup.sh
fi

# Activate virtual environment
source venv/bin/activate

# Run the server against Choom's canonical long-term memory folder.
#
# macOS note: do NOT default this under ~/Documents. That folder is TCC
# ("Privacy & Security") protected, and a launchd agent has no session to show
# the consent dialog in — open() on a path under it blocks forever, so the
# server hangs at "Waiting for application startup" and never binds :8100.
# ~/Library/Application Support is not TCC-gated, so the agent can use it.
if [ -z "${CHOOM_MEMORY_DATA_DIR:-}" ]; then
    if [ "$(uname -s)" = "Darwin" ]; then
        CHOOM_MEMORY_DATA_DIR="$HOME/Library/Application Support/Choom/ai_Choom_memory"
    else
        CHOOM_MEMORY_DATA_DIR="$HOME/Documents/ai_Choom_memory"
    fi
fi
export CHOOM_MEMORY_DATA_DIR
echo "Starting Choom Memory Server..."
echo "Data folder: $CHOOM_MEMORY_DATA_DIR"
echo ""
python run.py "$@"
