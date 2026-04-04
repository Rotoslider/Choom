#!/bin/bash
# Avatar Service Setup Script
# Creates venv, installs dependencies, downloads model weights

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Avatar Service Setup ==="

# Create virtual environment
if [ ! -d "venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv venv
fi

# Activate venv
source venv/bin/activate

# Install base dependencies
echo "Installing Python dependencies..."
pip install --upgrade pip
pip install -r requirements.txt

# Install PyTorch (should already be system-installed, but ensure availability in venv)
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128 2>/dev/null || \
    echo "PyTorch already available or install skipped (using system PyTorch)"

# Create model directory and download face landmarker
mkdir -p models
if [ ! -f "models/face_landmarker.task" ]; then
    echo "Downloading MediaPipe Face Landmarker model..."
    curl -sL -o models/face_landmarker.task \
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"
    echo "Downloaded: $(du -h models/face_landmarker.task | cut -f1)"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "To start the service:"
echo "  ./start.sh"
echo ""
echo "Optional: Install DECA for higher-quality reconstruction"
echo "  pip install deca-pytorch"
echo "  Download FLAME model from https://flame.is.tue.mpg.de/"
echo "  Place model files in ./models/"
echo ""
echo "The service will use MediaPipe as a fallback if DECA is not installed."
