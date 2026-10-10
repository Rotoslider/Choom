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
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "tools"))
import closet  # noqa: E402

PORTRAITS = HERE / "portraits"
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
                    if event.get("type") == "camera_request":  # for tower_eyes, not the page
                        threading.Thread(target=answer_camera, args=(event,), daemon=True).start()
                        continue
                    if event.get("type") == "glass_request":  # a Choom asking the glass (answered here)
                        threading.Thread(target=answer_glass, args=(event,), daemon=True).start()
                        continue
                    if event.get("type") in ("turn_start", "content") and event.get("source") in ("chat", "group"):
                        wake_screen()
                    elif event.get("type") == "listening" and event.get("listening"):
                        wake_screen()  # Donny started typing or talking to them
                    if event.get("source") in ("chat", "group", "mic", "tower") or event.get("type") == "listening":
                        last_conversation[0] = time.time()
                    # Which Chooms are mid-turn in a conversation (not a heartbeat): tower_ears waits for
                    # her turn to end before it opens the reply window.
                    # Per conversation: Genesis can be mid-turn in her chat and in the room at once, and
                    # the end of one is not the end of the other.
                    if event.get("source") in ("chat", "group") and event.get("choom"):
                        turn = (event["choom"], event.get("chatId") or event.get("roomId") or event["source"])
                        if event.get("type") == "turn_start":
                            chat_turns[turn] = time.time()
                        elif event.get("type") in ("turn_end", "error"):
                            chat_turns.pop(turn, None)
                        latest["chat_turns"] = sorted({c for (c, _), at in chat_turns.items() if time.time() - at < 600})
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
    """The local weather, passed to the page: windy days stir Genesis's hair, rain and snow drift
    through the glass, the temperature picks her clothes. From the Choom app (its OpenWeather settings)
    every 10 minutes, with wind, gusts and temperature from Donny's own weather station every 2 minutes
    when weather.json maps them to Home Assistant sensors, e.g. {"wind": "sensor.station_wind_average_
    10_minutes", "gust": "sensor.station_wind_gust", "temperature": "sensor.station_temperature"}
    (OpenWeather's town readings ran well under his station's and never reported gusts)."""
    town, town_at, windy_was = {}, 0.0, None
    while True:
        try:
            if time.time() - town_at > 600:
                town_at = time.time()
                with urllib.request.urlopen(f"{CHOOM_URL}/api/weather", timeout=30) as response:
                    town = json.loads(response.read()).get("weather") or {}
            entry = {"type": "weather", "wind": town.get("windSpeed") or 0, "gust": town.get("windGust") or 0,
                     "description": town.get("description") or "", "temperature": town.get("temperature"),
                     "source": "town", "time": time.strftime("%Y-%m-%dT%H:%M:%S")}
            station, url_file, token_file = HA_CONFIG / "weather.json", HA_CONFIG / "ha_url", HA_CONFIG / "ha_token"
            if station.exists() and url_file.exists() and token_file.exists():
                base, token = url_file.read_text().strip().rstrip("/"), token_file.read_text().strip()
                for key, entity in json.loads(station.read_text()).items():
                    try:
                        entry[key] = round(float(ha_get(base, token, f"/api/states/{entity}").get("state")), 1)
                        entry["source"] = "station"
                    except (TypeError, ValueError):
                        pass  # unavailable for now: keep the town reading
            latest["weather"] = entry
            broadcast(entry)
            windy = (entry["wind"] or 0) >= 12 or (entry["gust"] or 0) >= 20  # the page's rule (living.js windy())
            if windy != windy_was:  # log when it turns windy or calm
                log_entry({"kind": "weather", "windy": windy, "wind": entry["wind"], "gust": entry["gust"],
                           "temperature": entry["temperature"], "source": entry["source"]})
                windy_was = windy
        except Exception as e:
            latest["weather_error"] = f"{type(e).__name__}: {e}"
        time.sleep(120)


IMAGE_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
image_cache = {}  # the last few pictures fetched for the page: id -> (content type, bytes)


# --- Welcome back ------------------------------------------------------------------------
# When Donny sits back down after a while away, the Choom he last talked with welcomes him back (the
# Choom app's /api/hologram/welcome picks her and gives her a note; she knows from their conversation
# where he went). He's at the desk while the camera sees his face, or he has used the NUC's keyboard or
# mouse in the last 30 seconds and the camera saw him in the last 5 minutes. GNOME also resets its idle
# time when the screens wake (a Choom starting to talk wakes them) or the monitor layout is reapplied,
# which kept "bringing him back" while he was out at the gate; the camera decides when he's back.
WELCOME_AFTER_S = float(os.environ.get("HOLOGRAM_WELCOME_AFTER_S", 20 * 60))  # away at least this long
WELCOME_EVERY_S = 2 * 60 * 60    # at most one welcome back every two hours
WELCOME_HOURS = (7, 23)          # not at night
INPUT_COUNTS_S = 5 * 60          # keyboard and mouse count as him only this long after the camera saw him
last_conversation = [0.0]        # when Donny last typed, talked or was answered (from the Choom feed)
chat_turns = {}                  # (Choom, chat or room) -> when her turn there started


def idle_seconds():
    """Seconds since the last keyboard or mouse input on this desktop (GNOME), or None."""
    try:
        out = subprocess.run(["gdbus", "call", "--session", "--dest", "org.gnome.Mutter.IdleMonitor",
                              "--object-path", "/org/gnome/Mutter/IdleMonitor/Core",
                              "--method", "org.gnome.Mutter.IdleMonitor.GetIdletime"],
                             capture_output=True, text=True, timeout=5).stdout
        return int(re.search(r"uint64 (\d+)", out).group(1)) / 1000  # "(uint64 404501,)": milliseconds
    except Exception:
        return None


def log_entry(entry):
    entry.setdefault("time", time.strftime("%Y-%m-%dT%H:%M:%S"))
    with log_lock, LOG.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def send_welcome(seconds, place):
    try:
        body = {"awayMinutes": round(seconds / 60), **({"place": place} if place else {})}
        request = urllib.request.Request(f"{CHOOM_URL}/api/hologram/welcome", data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=60) as response:
            answer = json.loads(response.read())
        log_entry({"kind": "welcome", "minutes": body["awayMinutes"], "place": place, "choom": answer.get("choom"),
                   "ok": answer.get("ok"), "skipped": answer.get("skipped")})
        if answer.get("ok") and answer.get("choom"):  # tower_ears opens a reply window once she's done
            latest["welcome"] = {"choom": answer["choom"], "at": time.time()}
    except Exception as e:
        log_entry({"kind": "welcome", "minutes": round(seconds / 60), "error": type(e).__name__})


def welcome_watch():
    present_at, last_welcome, places, was_here, face_seen = time.time(), 0.0, [], [True], time.time()
    while True:
        time.sleep(5)
        try:
            idle = idle_seconds()
            face = (latest.get("gaze") or {}).get("face") is True
            if face or not latest.get("eyes_camera"):
                face_seen = time.time()  # (no camera: input alone decides, as before)
            here = face or (idle is not None and idle < 30 and time.time() - face_seen < INPUT_COUNTS_S)
            presence = latest.get("presence") or {}
            latest["welcome_watch"] = {"face": face, "idle": None if idle is None else round(idle),
                                       "here": here, "unseen_for": round(time.time() - present_at)}
            if here != was_here[0]:  # log each leaving and coming back (and why he counted as here)
                log_entry({"kind": "desk", "here": here, "face": face, "idle": None if idle is None else round(idle),
                           "after": round(time.time() - present_at)})
                was_here[0] = here
            if not here:
                # Where he is while away, from Home Assistant (the shop, the truck), if it knows.
                for role, value in presence.items():
                    if value is True and role not in ("home", "desk", "bed", "type", "time") and role not in places:
                        places.append(role)
                continue
            away = time.time() - present_at
            present_at = time.time()
            cam = camera_settings()
            if cam.get("welcome") is False:
                places = []
                continue
            after = WELCOME_AFTER_S if os.environ.get("HOLOGRAM_WELCOME_AFTER_S") else float(cam.get("welcome_minutes", 20)) * 60
            if away < after:
                places = []
                continue
            hour = time.localtime().tm_hour
            why = ("night" if not WELCOME_HOURS[0] <= hour < WELCOME_HOURS[1] else
                   "welcomed lately" if time.time() - last_welcome < WELCOME_EVERY_S else
                   "already talking" if time.time() - last_conversation[0] < 120 else
                   "in bed" if presence.get("bed") is True else None)
            if why:
                log_entry({"kind": "welcome", "minutes": round(away / 60), "skipped": why})
            else:
                last_welcome = time.time()
                threading.Thread(target=send_welcome, args=(away, places[-1] if places else None), daemon=True).start()
            places = []
        except Exception as e:
            latest["welcome_watch_error"] = f"{type(e).__name__}: {e}"


# --- The glass camera, for the Choom app -----------------------------------------------------
# The Choom app's Camera tab and the Chooms' "glass" camera send camera_request events down the feed
# server.py already follows; tower_eyes.py (127.0.0.1:8766) answers, and the answer is posted back to
# /api/hologram/camera/result. Nothing on the NUC listens beyond localhost.
EYES_URL = "http://127.0.0.1:8766"


def answer_camera(event):
    op, args, answer = event.get("op"), event.get("args") or {}, {"id": event.get("id")}
    try:
        if op == "frame":
            query = urllib.parse.urlencode({"width": int(args.get("width", 960)), "overlay": "1" if args.get("overlay") else "0",
                                            "purpose": "snapshot" if args.get("purpose") == "snapshot" else "preview"})
            with urllib.request.urlopen(f"{EYES_URL}/frame?{query}", timeout=8) as response:
                answer.update(ok=True, image=base64.b64encode(response.read()).decode())
        elif op in ("state", "settings"):
            request = (urllib.request.Request(f"{EYES_URL}/settings", data=json.dumps(args).encode(),
                                              headers={"Content-Type": "application/json"})
                       if op == "settings" else f"{EYES_URL}/state")
            with urllib.request.urlopen(request, timeout=8) as response:
                answer.update(ok=True, state=json.loads(response.read()))
        else:
            answer.update(ok=False, error=f"unknown camera op {op}")
    except urllib.error.HTTPError as e:
        try:
            answer.update(ok=False, status=e.code, error=json.loads(e.read()).get("error"))
        except Exception:
            answer.update(ok=False, status=e.code, error=f"camera answered {e.code}")
    except Exception as e:
        answer.update(ok=False, error=f"the glass camera isn't answering ({type(e).__name__})")
    try:
        request = urllib.request.Request(f"{CHOOM_URL}/api/hologram/camera/result", data=json.dumps(answer).encode(),
                                         headers={"Content-Type": "application/json"})
        urllib.request.urlopen(request, timeout=15).read()
    except Exception as e:
        latest["camera_error"] = f"{type(e).__name__}: {e}"
    if op == "settings" or (op == "frame" and args.get("purpose") == "snapshot"):  # not every preview frame
        log_entry({"kind": "camera", "op": "snapshot" if op == "frame" else op, "ok": answer.get("ok")})


# --- The Chooms asking the glass ----------------------------------------------------------------
# The looking-glass skill in the Choom app: glass_move("a little dance"), glass_wear("my red dress")
# and glass_closet() go down the feed as glass_request events. The answer is worked out here from
# what is built on the glass (tools/closet.py), the page is told what to play or wear, and the
# answer goes back to /api/hologram/glass/result, the way the camera's do.
def glass_answer(request):
    choom = str(request.get("choom") or "").strip()
    cid, op = choom.lower(), request.get("op")
    what = str(request.get("what") or "").strip()[:120]
    alive, worn = closet.load(PORTRAITS, cid)
    if not alive.get("clips"):
        return {"ok": False, "error": f"{choom or 'That Choom'} isn't on the glass yet."}
    moves, outfits = closet.moves(cid, alive, worn), closet.outfits(alive, worn)
    names = sorted({closet.move_name(w) for w in moves})
    if op == "closet":
        # What she has, never what she's wearing at the moment.
        return {"ok": True, "moves": names,
                "clothes": [f"your usual clothes{': ' + worn['usual'] if worn.get('usual') else ''}"] +
                           [o["wearing"] or ", ".join(o["tags"]) for o in outfits.values()],
                "note": "Ask for something you don't have and it goes on Donny's wish list for Glass Studio."}
    if not what:
        return {"ok": False, "error": "Say what: a move (\"a twirl\") or clothes (\"my red dress\")."}
    if op == "move":
        found = closet.match_move(what, moves)
        if not found:
            closet.add_wish(PORTRAITS, cid, "move", what)
            return {"ok": True, "done": False,
                    "message": f"There's no \"{what}\" on the glass yet. It's on Donny's wish list in Glass Studio now.",
                    "moves": names}
        word = found[0][0]
        broadcast({"type": "glass", "choom": cid, "move": sorted({s for _, srcs in found for s in srcs}), "name": word})
        return {"ok": True, "done": True, "message": f"On the glass you {closet.move_name(word)} at your next quiet moment."}
    if op == "wear":
        match = closet.match_outfit(what, outfits)
        if match is None:
            closet.add_wish(PORTRAITS, cid, "wear", what)
            return {"ok": True, "done": False,
                    "message": f"There's nothing like \"{what}\" in your closet on the glass yet. It's on Donny's wish list in Glass Studio now.",
                    "clothes": [o["wearing"] or ", ".join(o["tags"]) for o in outfits.values()]}
        name, outfit = match
        broadcast({"type": "glass", "choom": cid, "wear": None if name == "usual" else name})
        if name == "usual":
            return {"ok": True, "done": True, "message": "On the glass you change back into your usual clothes at your next quiet moment."}
        return {"ok": True, "done": True,
                "message": f"On the glass you change into {outfit['wearing'] or name} at your next quiet moment, and keep it on until bedtime unless you change again."}
    return {"ok": False, "error": f"unknown op {op}"}


def answer_glass(event):
    try:
        answer = glass_answer(event)
    except Exception as e:  # a broken closet file must not leave her waiting
        answer = {"ok": False, "error": f"the glass couldn't answer ({type(e).__name__})"}
    try:
        request = urllib.request.Request(f"{CHOOM_URL}/api/hologram/glass/result",
                                         data=json.dumps({**answer, "id": event.get("id")}).encode(),
                                         headers={"Content-Type": "application/json"})
        urllib.request.urlopen(request, timeout=15).read()
    except Exception as e:
        latest["glass_error"] = f"{type(e).__name__}: {e}"
    log_entry({"kind": "glass", "choom": event.get("choom"), "op": event.get("op"), "what": event.get("what"),
               "done": answer.get("done"), "ok": answer.get("ok")})


def camera_settings():
    """camera.json (written by tower_eyes.py from the Choom app's Camera tab), or {}."""
    try:
        return json.loads((HA_CONFIG / "camera.json").read_text())
    except (OSError, ValueError):
        return {}


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
        if self.path not in ("/log", "/control", "/speak", "/simulate", "/ears", "/eyes", "/glass"):
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
        if self.path == "/glass":
            # Test hook: a Choom's glass request without the Choom app, e.g. {"choom": "genesis", "op": "move",
            # "what": "twirl"}; answered here instead of to the Mac.
            return self._send_json(glass_answer(entry))
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
            if event in ("window", "window_closed"):  # the reply window opening, or closing unheard
                broadcast({"type": "control", "chime": "open" if event == "window" else "close"})
            if event == "voice":  # someone is talking near the tower: no screensaver turn now (not logged)
                broadcast({"type": "control", "activity": True})
                self.send_response(204)
                self.end_headers()
                return
            if event in ("wake", "listen"):
                broadcast({"type": "choom", "event": "listening", "source": "mic", "tower": True,
                           "wake": event == "wake",  # only the wake phrase itself may interrupt her
                           "group": choom == "Chooms",  # "OK Chooms": the room, all four listen
                           "listening": event == "wake" or entry.get("listening") is True,
                           "choom": choom, "chatId": None, "roomId": None})
            self._log({"kind": "ears", "event": event, "choom": choom,
                       **{k: entry[k] for k in ("message", "seconds", "ended", "floor") if k in entry}})
            self.send_response(204)
            self.end_headers()
            return
        if self.path == "/eyes":
            # tower_eyes.py: Donny looking at the glass or away, or a camera plugged in or out. Only
            # those changes are passed on and logged; no picture ever leaves tower_eyes.py.
            if "camera" in entry:
                latest["eyes_camera"] = entry["camera"]
                self._log({"kind": "eyes", "camera": entry["camera"]})
            else:
                gaze = {"looking": entry.get("looking") is True, "face": entry.get("face") is True}
                latest["gaze"] = gaze
                broadcast({"type": "gaze", **gaze})
                self._log({"kind": "eyes", **gaze})
            self.send_response(204)
            self.end_headers()
            return
        if self.path == "/control" and isinstance(entry.get("welcomeTest"), (int, float)):
            # {"welcomeTest": 30}: send a real welcome back now, as if he'd been away that many minutes
            threading.Thread(target=send_welcome, args=(entry["welcomeTest"] * 60, None), daemon=True).start()
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
    threading.Thread(target=welcome_watch, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
