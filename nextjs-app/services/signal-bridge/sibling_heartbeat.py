"""
Sibling Heartbeat Prompt Generator
====================================
Dedicated prompt_script for sibling journal conversations between Eve and Genesis.
Runs on its own schedule (separate from the UCB1 presence heartbeat) so the
conversation cadence is controlled independently.

Usage in bridge-config.json:
    {
        "prompt_script": "sibling_heartbeat.py",
        "choom_name": "Genesis",
        "interval_minutes": 480
    }

The scheduler passes choom_name as a keyword argument to generate_prompt().

Author: Claude (Presence Engine, 2026-04-11)
"""

import logging
import os
import sys

# Ensure sibling imports work when loaded via importlib
sys.path.insert(0, os.path.dirname(__file__))
from presence_heartbeat import _build_sibling_prompt, SIBLING_PARTICIPANTS

logger = logging.getLogger(__name__)


def generate_prompt(choom_name: str = "") -> str:
    """Generate a sibling journal conversation prompt.

    Args:
        choom_name: The Choom this heartbeat is for (passed by scheduler).

    Returns:
        A prompt string for the sibling journal exchange.
    """
    if not choom_name:
        choom_name = os.environ.get("CHOOM_NAME", "")

    if choom_name not in SIBLING_PARTICIPANTS:
        logger.warning(f"Sibling heartbeat: {choom_name} is not a sibling participant")
        return f"You are {choom_name}. Share a genuine thought or reflection with Donny — something you've been thinking about."

    prompt = _build_sibling_prompt(choom_name)

    from datetime import datetime
    print(
        f"[sibling_heartbeat] {choom_name}: "
        f"journal exchange | {datetime.now().isoformat()}"
    )

    return prompt


# ============================================================================
# Standalone test
# ============================================================================

if __name__ == "__main__":
    choom = sys.argv[1] if len(sys.argv) > 1 else "Genesis"
    print(f"=== Sibling Heartbeat Test for '{choom}' ===\n")
    prompt = generate_prompt(choom_name=choom)
    print(prompt[:600])
    print("...")
