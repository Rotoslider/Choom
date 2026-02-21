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

# Run the server
echo "Starting Choom Memory Server..."
echo "Data folder: ~/Documents/ai_Choom_memory"
echo ""
python run.py "$@"
