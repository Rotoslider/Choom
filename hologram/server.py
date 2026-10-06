#!/usr/bin/env python3
"""Local server for the Portrait hologram pages.

Serves the pages, the device calibration and a /log sink for page telemetry. It also:
- reads the Portrait's own buttons straight from their input device and claims them
  exclusively, so GNOME stops treating them as media keys;
- follows the Choom app's hologram feed on the Mac (who is talking, her reply as sentences);
- proxies speech requests to the Choom app's /api/tts, so the page gets each Choom's voice.
Buttons and Choom activity reach the page over /events.
"""
import argparse
import base64
import fcntl
import json
import os
import queue
import re
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import base64
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
CALIBRATION = HERE / "calibration" / "LKG-PORT-07952_visual.json"
LOG = HERE / "telemetry.log"
LOG_MAX_BYTES = 50_000_000
log_lock = threading.Lock()
latest = {}
received_at = {}  # kind -> when the page last posted it
heartbeat_now = threading.Event()  # set when the page's voice flips, to send the heartbeat at once
CHOOM_URL = os.environ.get("CHOOM_URL", "http://donnys-mac-studio-3.local:3000")
# Home Assistant access for presence, kept outside the repo: ha_url (e.g. http://homeassistant:8123),
# ha_token (a long-lived access token) and optionally presence.json.
HA_CONFIG = Path(os.environ.get("HOLOGRAM_CONFIG", Path.home() / ".config" / "choom-hologram"))

# --- Portrait buttons --------------------------------------------------------------------
DEVICE_NAME = "Looking Glass Looking Glass Portrait Consumer Control"
BUTTONS = {165: "top", 163: "middle", 164: "bottom"}  # KEY_PREVIOUSSONG, KEY_NEXTSONG, KEY_PLAYPAUSE
EV_KEY = 1
EVIOCGRAB = 0x40044590
INPUT_EVENT = struct.Struct("llHHi")  # struct input_event on 64-bit Linux

clients = set()
clients_lock = threading.Lock()
buttons = {"state": "starting"}


_last_wake = 0.0


def wake_screen():
    """GNOME blanks every monitor after idle, the Portrait included. Wake them when a Choom starts
    talking or a Portrait button is pressed (GNOME never sees those presses: we claim the device)."""
    global _last_wake
    if time.time() - _last_wake < 10:
        return
    _last_wake = time.time()
    subprocess.run(["gdbus", "call", "--session", "--dest", "org.gnome.ScreenSaver",
                    "--object-path", "/org/gnome/ScreenSaver",
                    "--method", "org.gnome.ScreenSaver.SetActive", "false"],
                   capture_output=True, timeout=5)


def broadcast(event):
    data = json.dumps(event)
    with clients_lock:
        for q in list(clients):
            q.put(data)


def find_button_device():
    for name_file in Path("/sys/class/input").glob("event*/device/name"):
        try:
            if name_file.read_text().strip() == DEVICE_NAME:
                return Path("/dev/input") / name_file.parent.parent.name
        except OSError:
            continue
    return None


def read_buttons():
    """Retry forever, so unplugging the Portrait or adding the udev rule later just works."""
    while True:
        device = find_button_device()
        if device is None:
            buttons.update(state="not found", device=None)
            time.sleep(5)
            continue
        try:
            fd = os.open(device, os.O_RDONLY)
        except PermissionError:
            buttons.update(state="no permission (udev rule not installed)", device=str(device))
            time.sleep(5)
            continue
        try:
            try:
                fcntl.ioctl(fd, EVIOCGRAB, 1)
                buttons.update(state="claimed", device=str(device))
            except OSError:
                buttons.update(state="reading (not exclusive)", device=str(device))
            while True:
                data = os.read(fd, INPUT_EVENT.size * 16)
                for offset in range(0, len(data) - INPUT_EVENT.size + 1, INPUT_EVENT.size):
                    _sec, _usec, etype, code, value = INPUT_EVENT.unpack_from(data, offset)
                    if etype == EV_KEY and code in BUTTONS and value in (0, 1):
                        if value == 1:
                            wake_screen()
                        broadcast({"type": "button", "button": BUTTONS[code],
                                   "action": "press" if value else "release"})
        except OSError:
            buttons.update(state="lost")
        finally:
            os.close(fd)
        time.sleep(2)


# --- Display watchdog ------------------------------------------------------------------------
def xrandr_outputs():
    """Connected outputs: name -> {active, primary, preferred (w, h), portrait}."""
    text = subprocess.run(["xrandr", "--query"], capture_output=True, text=True, timeout=10).stdout
    outputs, name = {}, None
    for line in text.splitlines():
        if not line.startswith(" "):
            name = None
            if " connected" in line:
                name = line.split()[0]
                outputs[name] = {"active": re.search(r"\d+x\d+\+\d+\+\d+", line) is not None,
                                 "primary": " primary " in line, "preferred": None, "portrait": False}
        elif name:
            mode = re.match(r"\s+(\d+)x(\d+)\s+(.*)", line)
            if mode:
                w, h = int(mode.group(1)), int(mode.group(2))
                if (w, h) == (1536, 2048):
                    outputs[name]["portrait"] = True
                if "+" in mode.group(3) and outputs[name]["preferred"] is None:
                    outputs[name]["preferred"] = (w, h)
    return outputs


def display_watchdog():
    """Re-enable a monitor GNOME left switched off. When a monitor comes back from another input
    (the switch to the Mac), GNOME can settle the layout before the monitor is ready and leave it
    connected but off. If that lasts 6 s, restore the standard layout: primary at the left, the
    other monitors to its right, the Portrait at the far right. HOLOGRAM_DISPLAY_WATCHDOG=0 turns
    this off."""
    if os.environ.get("HOLOGRAM_DISPLAY_WATCHDOG", "1") == "0":
        return
    off_since, last_fix = {}, 0.0
    while True:
        time.sleep(2)
        try:
            outputs = xrandr_outputs()
        except Exception:
            continue
        now = time.time()
        for name, o in outputs.items():
            if o["active"]:
                off_since.pop(name, None)
            else:
                off_since.setdefault(name, now)
        stuck = [n for n, t in off_since.items() if n in outputs and now - t >= 6]
        if not stuck or now - last_fix < 30:
            continue
        primary = next((n for n, o in outputs.items() if o["primary"]), None) or sorted(outputs)[0]
        portrait = next((n for n, o in outputs.items() if o["portrait"]), None)
        order = [primary] + sorted(n for n in outputs if n not in (primary, portrait)) + ([portrait] if portrait else [])
        cmd, x = ["xrandr"], 0
        for n in order:
            w, _h = (1536, 2048) if n == portrait else (outputs[n]["preferred"] or (0, 0))
            if w == 0:
                continue
            cmd += ["--output", n, "--mode", f"{w}x{_h}", "--pos", f"{x}x0"] + (["--primary"] if n == primary else [])
            x += w
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        last_fix = now
        entry = {"kind": "display_fix", "time": time.strftime("%Y-%m-%dT%H:%M:%S"), "stuck": stuck,
                 "command": " ".join(cmd[1:]), "ok": result.returncode == 0, "error": result.stderr.strip()[:200]}
        latest["display_fix"] = entry
        with log_lock:
            if LOG.exists() and LOG.stat().st_size > LOG_MAX_BYTES:
                LOG.replace(LOG.with_suffix(".log.1"))  # keep one old log; status lines add ~9 MB a day
            with LOG.open("a") as f:
                f.write(json.dumps(entry) + "\n")


# --- Choom app feed -------------------------------------------------------------------------
choom_feed = {"state": "starting", "url": CHOOM_URL}


def follow_choom():
    """Relay the Choom app's /api/hologram/events to the page; reconnect whenever it drops."""
    while True:
        try:
            request = urllib.request.Request(f"{CHOOM_URL}/api/hologram/events",
                                             headers={"Accept": "text/event-stream"})
            with urllib.request.urlopen(request, timeout=45) as response:  # the feed pings every 15 s
                choom_feed.update(state="connected", since=time.strftime("%H:%M:%S"))
                last_kind = {}  # per conversation: the last event type passed on
                for raw in response:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data: "):
                        continue
                    try:
                        event = json.loads(line[6:])
                    except json.JSONDecodeError:
                        continue
                    # A model's reasoning streams in as one "thinking" event per token (60 a second);
                    # the page only needs to know it started.
                    key = (event.get("choom"), event.get("chatId"))
                    if event.get("type") == "thinking" and last_kind.get(key) == "thinking":
                        continue
                    last_kind[key] = event.get("type")
                    if event.get("type") in ("turn_start", "content") and event.get("source") in ("chat", "group"):
                        wake_screen()
                    elif event.get("type") == "listening" and event.get("listening"):
                        wake_screen()  # Donny started typing or talking to them
                    broadcast({**event, "type": "choom", "event": event.get("type")})
        except Exception as e:  # network drop, app restart, timeout
            choom_feed.update(state=f"disconnected ({type(e).__name__})")
        time.sleep(3)


def voice_heartbeat():
    """Every 10 s, tell the Choom app whether the hologram is speaking for the Chooms: true while
    the page is running with its voice on. Browsers at home then stay quiet (its voice hand-off)."""
    while True:
        status = latest.get("status") or {}
        page_alive = time.time() - received_at.get("status", 0) < 10
        voice = bool(page_alive and status.get("voiceOn"))
        try:
            request = urllib.request.Request(f"{CHOOM_URL}/api/hologram/voice",
                                             data=json.dumps({"voice": voice}).encode(),
                                             headers={"Content-Type": "application/json"})
            urllib.request.urlopen(request, timeout=10).read()
            choom_feed["voice_handoff"] = voice
        except Exception as e:
            choom_feed["voice_handoff"] = f"failed ({type(e).__name__})"
        heartbeat_now.wait(10)
        heartbeat_now.clear()


def weather_watch():
    """Every 10 minutes, the local weather from the Choom app (its OpenWeather settings), passed to
    the page: windy days stir Genesis's hair, and later rain or snow can drift through the glass."""
    while True:
        try:
            with urllib.request.urlopen(f"{CHOOM_URL}/api/weather", timeout=30) as response:
                w = json.loads(response.read()).get("weather") or {}
            entry = {"type": "weather", "wind": w.get("windSpeed") or 0, "gust": w.get("windGust") or 0,
                     "description": w.get("description") or "", "temperature": w.get("temperature"),
                     "time": time.strftime("%Y-%m-%dT%H:%M:%S")}
            latest["weather"] = entry
            broadcast(entry)
        except Exception as e:
            latest["weather_error"] = f"{type(e).__name__}: {e}"
        time.sleep(600)


IMAGE_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
image_cache = {}  # the last few pictures fetched for the page: id -> (content type, bytes)


def choom_image(image_id):
    """A picture from the Choom app's gallery as plain image bytes, so the page can draw it (the app
    keeps images as base64 data URIs, and its pages send no CORS headers)."""
    if image_id not in image_cache:
        with urllib.request.urlopen(f"{CHOOM_URL}/api/images/{image_id}", timeout=30) as response:
            record = json.loads(response.read())
        url = record.get("imageUrl") or (record.get("image") or {}).get("imageUrl") or ""
        match = re.match(r"data:(image/[\w.+-]+);base64,(.*)", url, re.S)
        if match:
            image_cache[image_id] = (match.group(1), base64.b64decode(match.group(2)))
        elif url:
            with urllib.request.urlopen(urllib.parse.urljoin(CHOOM_URL, url), timeout=30) as response:
                image_cache[image_id] = (response.headers.get_content_type(), response.read())
        else:
            raise ValueError("no image in the record")
        while len(image_cache) > 6:
            image_cache.pop(next(iter(image_cache)))
    return image_cache[image_id]


def ha_get(base, token, path):
    request = urllib.request.Request(f"{base}{path}", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read())


PRESENT_STATES = ("home", "on", "detected", "occupied", "true")
AWAY_GRACE_S = 120  # gone only after two minutes of absence: phones drop Wi-Fi now and then


def presence_watch():
    """Donny's presence from Home Assistant, passed to the page when it changes: home (a person
    entity, or the phone's Wi-Fi), and at the desk or in bed (zones of a presence sensor).
    presence.json maps roles to entities, e.g. {"home": {"entity": "sensor.phone_wi_fi_connection",
    "equals": "<home network>"}, "desk": "binary_sensor.desk_zone", "bed": "binary_sensor.bed_zone"};
    without it, "home" is the person entity named Donny. Checks every 5 s. Waits quietly (and picks
    the files up without a restart) until ha_url and ha_token exist."""
    last, entities, resolved_at = None, {}, 0.0
    shown, absent_since = {}, {}  # what the page was told per role, and since when a role has read absent
    while True:
        try:
            url_file, token_file, map_file = HA_CONFIG / "ha_url", HA_CONFIG / "ha_token", HA_CONFIG / "presence.json"
            missing = [str(f) for f in (url_file, token_file) if not f.exists()]
            if missing:
                latest["presence_state"] = f"waiting for {' and '.join(missing)}"
                time.sleep(60)
                continue
            base, token = url_file.read_text().strip().rstrip("/"), token_file.read_text().strip()
            if time.time() - resolved_at > 600:  # re-read the mapping every 10 minutes
                entities = json.loads(map_file.read_text()) if map_file.exists() else {}
                if "home" not in entities:
                    people = [e for e in ha_get(base, token, "/api/states") if e["entity_id"].startswith("person.")]
                    named = [e for e in people if "donny" in (e["entity_id"] + str(e["attributes"].get("friendly_name", ""))).lower()]
                    if named or len(people) == 1:
                        entities["home"] = (named or people)[0]["entity_id"]
                resolved_at = time.time()
            now = {}
            for role, spec in entities.items():
                # A role is an entity id (present when it reads home/on/detected/occupied), or
                # {"entity": ..., "equals": value} (present when it reads exactly that, e.g. the
                # phone's Wi-Fi network at home).
                entity = spec["entity"] if isinstance(spec, dict) else spec
                raw = str(ha_get(base, token, f"/api/states/{entity}").get("state", ""))
                if raw.lower() in ("unavailable", "unknown", ""):
                    now[role] = None
                elif isinstance(spec, dict) and "equals" in spec:
                    now[role] = raw == spec["equals"]
                else:
                    now[role] = raw.lower() in PRESENT_STATES
            # Arriving counts at once; leaving only after AWAY_GRACE_S of absence in a row.
            for role, value in now.items():
                if value is False and shown.get(role) is True:
                    absent_since.setdefault(role, time.time())
                    if time.time() - absent_since[role] < AWAY_GRACE_S:
                        now[role] = True
                        continue
                absent_since.pop(role, None)
            shown = dict(now)
            latest["presence_state"] = "watching " + ", ".join(
                f"{role}: {spec['entity'] if isinstance(spec, dict) else spec}" for role, spec in entities.items())
            if now != last:
                entry = {"type": "presence", **now, "time": time.strftime("%Y-%m-%dT%H:%M:%S")}
                latest["presence"] = entry
                broadcast(entry)
                last = now
        except Exception as e:  # HA restarting, network drop, a renamed entity
            latest["presence_state"] = f"error: {type(e).__name__}: {e}"
            time.sleep(30)
            continue
        time.sleep(5)


def synthesize(text, voice):
    """WAV bytes for `text` in `voice`, via the Choom app (which cleans text and calls Chatterbox)."""
    body = json.dumps({"text": text, "voice": voice}).encode()
    request = urllib.request.Request(f"{CHOOM_URL}/api/tts", data=body,
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=90) as response:
        result = json.loads(response.read())
    if not result.get("success") or not result.get("audio"):
        raise RuntimeError(result.get("error") or "no audio")
    return base64.b64decode(result["audio"])


# --- HTTP ----------------------------------------------------------------------------------
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/living.html")
            self.end_headers()
            return
        if self.path == "/calibration.json":
            return self._send_json(json.loads(CALIBRATION.read_text()))
        if self.path == "/status":
            return self._send_json({**latest, "buttons": buttons, "choom_feed": choom_feed})
        if self.path == "/events":
            return self._stream_events()
        if self.path.startswith("/choom-image/"):
            image_id = self.path[len("/choom-image/"):]
            if not IMAGE_ID.fullmatch(image_id):
                return self.send_error(400)
            try:
                content_type, data = choom_image(image_id)
            except Exception as e:
                self._log({"kind": "error", "message": f"picture {image_id}: {type(e).__name__}"})
                return self.send_error(404)
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return super().do_GET()

    def do_POST(self):
        if self.path not in ("/log", "/control", "/speak", "/simulate", "/ears"):
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            entry = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self.send_error(400)
            return
        if self.path == "/speak":
            text = str(entry.get("text", ""))
            started = time.time()
            try:
                audio = synthesize(text, entry.get("voice") or "sophie")
            except (urllib.error.URLError, RuntimeError, ValueError, OSError) as e:
                self._log({"kind": "speak", "chars": len(text), "ms": round((time.time() - started) * 1000), "error": str(e)})
                return self._send_json({"error": str(e)}, status=502)
            self._log({"kind": "speak", "chars": len(text), "ms": round((time.time() - started) * 1000)})
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)
            return
        if self.path == "/simulate":
            # Test hook: inject a Choom-app event, e.g. {"event": "content", "choom": "aloy", ...}
            broadcast({**entry, "type": "choom"})
            self.send_response(204)
            self.end_headers()
            return
        if self.path == "/ears":
            # tower_ears.py: "OK Eve" heard at the tower. The page shows her listening (and brings her
            # to the glass); the screens wake. Only events are logged, never what was said.
            event, choom = entry.get("event"), entry.get("choom")
            if event == "wake":
                wake_screen()
            if event in ("wake", "listen"):
                broadcast({"type": "choom", "event": "listening", "source": "mic", "tower": True,
                           "wake": event == "wake",  # only the wake phrase itself may interrupt her
                           "listening": event == "wake" or entry.get("listening") is True,
                           "choom": choom, "chatId": None, "roomId": None})
            self._log({"kind": "ears", "event": event, "choom": choom,
                       **{k: entry[k] for k in ("message", "seconds", "ended", "floor") if k in entry}})
            self.send_response(204)
            self.end_headers()
            return
        if self.path == "/control":
            # e.g. {"choom": "genesis"}, {"action": "next"}, {"listening": true}
            broadcast({**entry, "type": "control"})
            self.send_response(204)
            self.end_headers()
            return
        if entry.get("kind") == "status":
            previous = (latest.get("status") or {}).get("voiceOn")
            if previous is not None and previous != entry.get("voiceOn"):
                heartbeat_now.set()
        self._log(entry)
        self.send_response(204)
        self.end_headers()

    def _log(self, entry):
        entry.setdefault("time", time.strftime("%Y-%m-%dT%H:%M:%S"))
        latest[entry.get("kind", "unknown")] = entry
        received_at[entry.get("kind", "unknown")] = time.time()
        with LOG.open("a") as f:
            f.write(json.dumps(entry) + "\n")

    def _stream_events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        q = queue.Queue()
        with clients_lock:
            clients.add(q)
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    self.wfile.write(f"data: {q.get(timeout=15)}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with clients_lock:
                clients.discard(q)

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    threading.Thread(target=read_buttons, daemon=True).start()
    threading.Thread(target=follow_choom, daemon=True).start()
    threading.Thread(target=voice_heartbeat, daemon=True).start()
    threading.Thread(target=display_watchdog, daemon=True).start()
    threading.Thread(target=weather_watch, daemon=True).start()
    threading.Thread(target=presence_watch, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
