#!/usr/bin/env python3
"""
Run script for the Choom Memory Server.
"""

import os
import sys

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("MEMORY_SERVER_PORT", "8100"))
    print(f"Starting Choom Memory Server on port {port}")

    uvicorn.run(
        "src.memory_http_wrapper:app",
        host="0.0.0.0",
        port=port,
        reload=False,
    )
