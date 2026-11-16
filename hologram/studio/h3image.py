"""Glass Studio's side of the Chooms' H3 Image server (h3image_server.py, port 7870): before a clip
render or a Klein picture starts, the server lets go of the GPU and the 32 GB of RAM it keeps the model
in (a render needs nearly all of both); once the GPU has been idle a minute, it loads again, if it was
loaded before.
A server that isn't running (the Chooms on Klein, say) is simply left alone."""
import json
import time
import urllib.request
from pathlib import Path

URL = "http://127.0.0.1:7870"
TOKEN_FILE = Path.home() / ".config/choom-h3image/token"
RESTORE_AFTER_S = 60
released = {"at": 0.0}  # when the Studio last had it let go (0: not since, or it wasn't loaded)


def _post(path, body, timeout):
    token = TOKEN_FILE.read_text().strip()
    req = urllib.request.Request(URL + path, json.dumps(body).encode(),
                                 {"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def release(why):
    """The model leaves the GPU before a render or a Klein picture (after a picture being made, if any).
    Returns what to log, or None when there was nothing to do."""
    try:
        state = _post("/release", {"reason": why}, 300)
    except Exception:
        return None  # no server (or no token): nothing of it on the GPU
    if state.get("wanted"):
        released["at"] = time.time()
        return "the Chooms' H3 Image model left the GPU for this; it loads again once the GPU is idle"
    return None


def restore(idle_since):
    """Called while the GPU lane is idle: load the model again a minute after the lane went idle."""
    if not released["at"] or time.time() - idle_since < RESTORE_AFTER_S:
        return
    released["at"] = 0.0
    try:
        _post("/load", {"restore": True}, 10)
    except Exception:
        pass
