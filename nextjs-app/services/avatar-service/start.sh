#!/bin/bash
# Start the Avatar Service
# Uses MuseTalk's venv (has all deps including PyTorch, mediapipe, etc.)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

MUSETALK_VENV="/home/nuc1/projects/MuseTalk/venv"

if [ -f "$MUSETALK_VENV/bin/activate" ]; then
    source "$MUSETALK_VENV/bin/activate"
elif [ -f "venv/bin/activate" ]; then
    source venv/bin/activate
fi

PORT="${AVATAR_SERVICE_PORT:-8020}"
echo "[AvatarService] Starting on port $PORT..."
exec python3 main.py
