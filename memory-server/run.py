#!/usr/bin/env python3
"""
Run script for the Choom Memory Server.
"""

import logging
import os
import sys

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import uvicorn


class SuppressNoisyEndpoints(logging.Filter):
    """Filter out repetitive polling endpoint logs."""

    SUPPRESSED = ("/memory/stats",)

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return not any(ep in msg for ep in self.SUPPRESSED)


if __name__ == "__main__":
    port = int(os.environ.get("MEMORY_SERVER_PORT", "8100"))
    print(f"Starting Choom Memory Server on port {port}")

    log_config = uvicorn.config.LOGGING_CONFIG
    log_config["filters"] = {
        "suppress_noisy": {"()": "__main__.SuppressNoisyEndpoints"},
    }
    log_config["handlers"]["access"]["filters"] = ["suppress_noisy"]

    uvicorn.run(
        "src.memory_http_wrapper:app",
        host="0.0.0.0",
        port=port,
        reload=False,
        log_config=log_config,
    )
