#!/bin/bash
# Signal Bridge Startup Script
# This script ensures all required services are running

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Choom Signal Bridge Startup ==="

# Check if running as systemd service
if systemctl is-active --quiet signal-bridge; then
    echo "✓ Signal Bridge is running (systemd)"
else
    echo "Starting Signal Bridge..."
    sudo systemctl start signal-bridge
    sleep 2
    if systemctl is-active --quiet signal-bridge; then
        echo "✓ Signal Bridge started"
    else
        echo "✗ Failed to start Signal Bridge"
        echo "  Try: sudo systemctl status signal-bridge"
    fi
fi

# Check dependent services
echo ""
echo "=== Checking Services ==="

# STT (Whisper)
if curl -s http://localhost:5000/docs > /dev/null 2>&1; then
    echo "✓ STT (Whisper) - running on port 5000"
else
    echo "✗ STT (Whisper) - NOT running on port 5000"
fi

# TTS
if curl -s http://localhost:8004/ > /dev/null 2>&1; then
    echo "✓ TTS - running on port 8004"
else
    echo "✗ TTS - NOT running on port 8004"
fi

# Memory
if curl -s http://localhost:8100/health > /dev/null 2>&1; then
    echo "✓ Memory Service - running on port 8100"
else
    echo "✗ Memory Service - NOT running on port 8100"
fi

# Choom API (Next.js)
if curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "✓ Choom API (Next.js) - running on port 3000"
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
