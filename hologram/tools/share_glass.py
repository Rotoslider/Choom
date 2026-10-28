#!/usr/bin/env python3
"""Share the glass with a travel glass (choom-glass-player) on the home network, for its sync.

    python3 tools/share_glass.py [port] [hours]     (default 8770, 3 hours)

Serves, read-only and to private addresses only, what a glass needs to run: the page and its
scripts, tower_ears.py, the props, and each Choom's pictures and the clips her alive.json uses
(not the build caches: *.npy, *.npz). GET /manifest.json lists every file with its size and time;
GET /files/<path> sends one. The player's sync fetches what changed. Stops by itself after the hours.
"""
import http.server
import ipaddress
import json
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent  # hologram/
PAGE = ["living.html", "living.js", "lenticular.js", "body.js", "tower_ears.py", "glass-settings.example.json"]
TREES = ["vendor", "props"]
SKIP = (".npy", ".npz", ".part", ".tmp")
TYPES = {".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".mp4": "video/mp4",
         ".html": "text/html", ".py": "text/plain", ".png": "image/png", ".jpg": "image/jpeg"}


def shared_files():
    """{published path: file} of everything a glass needs."""
    files = {name: HERE / name for name in PAGE if (HERE / name).is_file()}
    for tree in TREES:
        for f in sorted((HERE / tree).rglob("*")):
            if f.is_file() and not f.name.startswith("."):
                files[f.relative_to(HERE).as_posix()] = f
    files["portraits/manifest.json"] = HERE / "portraits" / "manifest.json"
    for entry in json.loads((HERE / "portraits" / "manifest.json").read_text()):
        folder = HERE / "portraits" / entry["id"]
        if not folder.is_dir():
            continue
        # Her pictures and notes (everything but clips and caches), and the clips her alive.json plays.
        for f in sorted(folder.iterdir()):
            if f.is_file() and f.suffix not in SKIP + (".mp4",) and not f.name.startswith("."):
                files[f.relative_to(HERE).as_posix()] = f
        try:
            clips = json.loads((folder / "alive.json").read_text()).get("clips", [])
        except (OSError, ValueError):
            clips = []
        for clip in clips:
            f = folder / clip.get("file", "")
            if clip.get("file") and f.is_file():
                files[f.relative_to(HERE).as_posix()] = f
    return files


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if not ipaddress.ip_address(self.client_address[0]).is_private:
            return self.send_error(403)
        files = self.server.files
        if self.path == "/manifest.json":
            body = json.dumps([{"path": p, "size": f.stat().st_size, "mtime": int(f.stat().st_mtime)}
                               for p, f in files.items()]).encode()
            return self._send(body, "application/json")
        path = self.path.split("?")[0].removeprefix("/files/")
        f = files.get(path)
        if not self.path.startswith("/files/") or f is None:
            return self.send_error(404)
        self.send_response(200)
        self.send_header("Content-Type", TYPES.get(f.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(f.stat().st_size))
        self.end_headers()
        with f.open("rb") as fh:
            while chunk := fh.read(1 << 20):
                self.wfile.write(chunk)

    def _send(self, body, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
    hours = float(sys.argv[2]) if len(sys.argv) > 2 else 3
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.daemon_threads = True
    server.files = shared_files()
    size = sum(f.stat().st_size for f in server.files.values())
    print(f"sharing {len(server.files)} files ({size / 1e9:.1f} GB) on port {port} for {hours:g} hours", flush=True)
    threading.Timer(hours * 3600, server.shutdown).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
