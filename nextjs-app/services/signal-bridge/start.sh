#!/bin/bash
# Signal Bridge Startup Script
# This script ensures all required services are running

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Choom Signal Bridge Startup ==="

# Endpoints can point at another host (e.g. GPU services left on the old box),
# so read them from .env rather than assuming localhost.
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$SCRIPT_DIR/.env"
    set +a
fi
STT_ENDPOINT="${STT_ENDPOINT:-http://localhost:5000}"
TTS_ENDPOINT="${TTS_ENDPOINT:-http://localhost:8004}"
MEMORY_ENDPOINT="${MEMORY_ENDPOINT:-http://localhost:8100}"
CHOOM_API_URL="${CHOOM_API_URL:-http://localhost:3000}"

# systemd on Linux, launchd on macOS — servicectl.sh papers over the difference.
CTL="$SCRIPT_DIR/servicectl.sh"

if "$CTL" is-active signal-bridge; then
    echo "✓ Signal Bridge is running"
else
    echo "Starting Signal Bridge..."
    "$CTL" start signal-bridge
    sleep 2
    if "$CTL" is-active signal-bridge; then
        echo "✓ Signal Bridge started"
    else
        echo "✗ Failed to start Signal Bridge"
        echo "  Try: $CTL status signal-bridge"
    fi
fi

# Check dependent services
echo ""
echo "=== Checking Services ==="

# STT (Whisper)
if curl -s "$STT_ENDPOINT/docs" > /dev/null 2>&1; then
    echo "✓ STT (Whisper) - $STT_ENDPOINT"
else
    echo "✗ STT (Whisper) - NOT responding at $STT_ENDPOINT"
fi

# TTS
if curl -s "$TTS_ENDPOINT/" > /dev/null 2>&1; then
    echo "✓ TTS - $TTS_ENDPOINT"
else
    echo "✗ TTS - NOT responding at $TTS_ENDPOINT"
fi

# Memory
if curl -s "$MEMORY_ENDPOINT/memory/stats" > /dev/null 2>&1; then
    echo "✓ Memory Service - $MEMORY_ENDPOINT"
else
    echo "✗ Memory Service - NOT responding at $MEMORY_ENDPOINT"
fi

# Choom API (Next.js)
if curl -s "$CHOOM_API_URL/api/health" > /dev/null 2>&1; then
    echo "✓ Choom API (Next.js) - $CHOOM_API_URL"
else
    echo "⚠ Choom API (Next.js) - NOT running"
    echo "  Start with: cd $SCRIPT_DIR/../.. && npm run dev"
fi

# LLM (Mac Ultra)
LLM_HOST="${LLM_ENDPOINT:-http://localhost:1234/v1}"
if curl -s "${LLM_HOST}/models" > /dev/null 2>&1; then
    echo "✓ LLM - running on ${LLM_HOST}"
else
    echo "⚠ LLM - NOT responding at ${LLM_HOST}"
    echo "  Check your LLM server"
fi

echo ""
echo "=== Done ==="
