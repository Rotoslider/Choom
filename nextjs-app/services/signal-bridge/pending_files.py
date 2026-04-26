"""
Pending file delivery store for Signal.

When a Choom calls send_notification with non-image file_paths (e.g. .md, .pdf,
.txt, source code), we don't push the attachments immediately — they'd clog the
owner's Signal thread. Instead, the paths are queued here and a hint is appended
to the notification text. The owner replies "show me the files" (or similar) and
the bridge drains this queue as Signal attachments.

Store is JSON-backed so it survives bridge restarts. Old entries auto-prune at
load time so a forgotten queue doesn't grow forever.
"""
import json
import logging
import os
import threading
import uuid
from datetime import datetime, timedelta
from typing import List, Optional

logger = logging.getLogger(__name__)

# Project data dir: nextjs-app/data/
_DATA_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "data")
)
_STORE_PATH = os.path.join(_DATA_DIR, "signal_pending_files.json")
_TTL_DAYS = 7

_lock = threading.Lock()


def _now() -> datetime:
    return datetime.now()


def _load() -> dict:
    if not os.path.exists(_STORE_PATH):
        return {"queue": []}
    try:
        with open(_STORE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            if not isinstance(data, dict) or "queue" not in data:
                return {"queue": []}
            return data
    except Exception as e:
        logger.warning(f"pending_files: failed to load store, starting fresh: {e}")
        return {"queue": []}


def _save(data: dict) -> None:
    os.makedirs(_DATA_DIR, exist_ok=True)
    tmp = _STORE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, _STORE_PATH)


def _prune(data: dict) -> dict:
    cutoff = _now() - timedelta(days=_TTL_DAYS)
    kept = []
    dropped = 0
    for entry in data.get("queue", []):
        try:
            queued = datetime.fromisoformat(entry["queued_at"])
        except Exception:
            dropped += 1
            continue
        if queued >= cutoff:
            kept.append(entry)
        else:
            dropped += 1
    if dropped:
        logger.info(f"pending_files: pruned {dropped} entries older than {_TTL_DAYS}d")
    data["queue"] = kept
    return data


def add_batch(choom_name: Optional[str], file_paths: List[str], label: str = "") -> int:
    """Queue a batch of file paths for later delivery. Returns batch size queued."""
    if not file_paths:
        return 0
    with _lock:
        data = _prune(_load())
        entry = {
            "id": uuid.uuid4().hex[:12],
            "queued_at": _now().isoformat(),
            "choom_name": choom_name or "",
            "label": label or "",
            "file_paths": list(file_paths),
        }
        data["queue"].append(entry)
        _save(data)
    logger.info(
        f"pending_files: queued {len(file_paths)} file(s) "
        f"from {choom_name or 'unknown'} (label='{label[:40]}')"
    )
    return len(file_paths)


def count() -> int:
    """Total file count across all pending batches (after pruning stale ones)."""
    with _lock:
        data = _prune(_load())
        _save(data)
        return sum(len(e.get("file_paths", [])) for e in data.get("queue", []))


def drain_all() -> List[dict]:
    """Pop and return every pending batch. Empties the queue."""
    with _lock:
        data = _prune(_load())
        batches = data.get("queue", [])
        data["queue"] = []
        _save(data)
    return batches
