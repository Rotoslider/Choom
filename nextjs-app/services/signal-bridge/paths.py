"""
Centralized path configuration for the Signal Bridge.
All workspace paths should be imported from here.
"""
import os
import sys

# Root of the Next.js app (nextjs-app/), derived from this file's location:
#   nextjs-app/services/signal-bridge/paths.py -> nextjs-app/
# Hardcoding an absolute path here breaks every host but the one it was written
# on (it used to say /home/nuc1/projects/Choom/nextjs-app). Override with
# $CHOOM_APP_ROOT only if the bridge runs outside the repo tree.
APP_ROOT = os.getenv(
    'CHOOM_APP_ROOT',
    os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')),
)

WORKSPACE_ROOT = os.getenv('WORKSPACE_ROOT', os.path.expanduser('~/choom-projects'))

# Long-term memory store. Must agree with memory-server/run.sh and
# memory-server/src/memory_mcp.py — the bridge's backup job reads the same
# SQLite file the memory server writes.
#
# macOS: ~/Documents is TCC-protected, and a launchd agent has no session to
# answer the consent prompt, so open() under it blocks forever. Keep the store
# in ~/Library/Application Support, which is not gated.
if sys.platform == "darwin":
    _DEFAULT_MEMORY_DIR = os.path.join(
        os.path.expanduser("~"), "Library", "Application Support", "Choom", "ai_Choom_memory"
    )
else:
    _DEFAULT_MEMORY_DIR = os.path.join(os.path.expanduser("~"), "Documents", "ai_Choom_memory")

MEMORY_DATA_DIR = os.getenv('CHOOM_MEMORY_DATA_DIR') or _DEFAULT_MEMORY_DIR
