"""Avatar Service Configuration"""

import os
from pathlib import Path

# Service
PORT = int(os.getenv("AVATAR_SERVICE_PORT", "8020"))
HOST = os.getenv("AVATAR_SERVICE_HOST", "0.0.0.0")

# Paths
WORKSPACE_ROOT = Path(os.getenv("WORKSPACE_ROOT", os.path.expanduser("~/choom-projects")))
AVATAR_MODEL_DIR = WORKSPACE_ROOT / "avatar-models"
DECA_MODEL_DIR = Path(__file__).parent / "models"

# GPU
DEVICE = os.getenv("AVATAR_DEVICE", "cuda")

# Generation defaults
DEFAULT_TEXTURE_SIZE = int(os.getenv("AVATAR_TEXTURE_SIZE", "2048"))
