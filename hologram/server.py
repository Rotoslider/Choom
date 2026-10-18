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
def find_calibration():
    """The Portrait's calibration, copied from its own USB drive into calibration/ as <serial>_visual.json
    (one Portrait; with several, HOLOGRAM_CALIBRATION names the file)."""
    named = os.environ.get("HOLOGRAM_CALIBRATION")
    if named:
        return Path(named)
    found = sorted((HERE / "calibration").glob("*_visual.json")) or sorted((HERE / "calibration").glob("*.json"))
    return found[0] if found else HERE / "calibration" / "visual.json"


CALIBRATION = find_calibration()
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


def gnome(dest, path, method, *args):
    """One call to GNOME over D-Bus: its answer as text, "" if it didn't answer."""
    try:
        return subprocess.run(["gdbus", "call", "--session", "--dest", dest, "--object-path", path,
                               "--method", method, *args], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return ""


def screens_dark():
    """True while GNOME's screen shield is up (the screens blanked), None if GNOME didn't answer."""
    out = gnome("org.gnome.ScreenSaver", "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver.GetActive")
    return "true" in out if out else None


def wake_screen(why):
    """GNOME blanks every monitor after idle, the Portrait included. Only Donny wakes them: the camera
    seeing him (screen_watch), "OK Eve" at the tower, or a Portrait button press (GNOME never sees those
    presses: we claim the device). A Choom starting to talk used to wake them too, and a room the girls opened at 2:47 am lit
    the desk until morning (2026-10-15)."""
    global _last_wake
    if time.time() - _last_wake < 10:
        return
    _last_wake = time.time()
    dark = screens_dark()
    gnome("org.gnome.ScreenSaver", "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver.SetActive", "false")
    off = not dark and monitors_off()
    if off:
        subprocess.run(["xset", "dpms", "force", "on"], capture_output=True, timeout=5)
    if dark or off:
        log_entry({"kind": "screens", "on": True, "why": why, **({"dpms": True} if off else {})})


def monitors_off():
    """True if the monitors are powered down with GNOME's shield down (it went dark that way at night)."""
    try:
        state = subprocess.run(["xset", "q"], capture_output=True, text=True, timeout=5).stdout
        return "DPMS is Enabled" in state and "Monitor is On" not in state
    except Exception:
        return False


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
                            wake_screen("button")
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


def standard_layout(outputs):
    """The xrandr command for the standard layout: the primary monitor at the left, the other monitors to
    its right, the Portrait at the far right. The Portrait is never made primary (GNOME's top bar and
    notifications would land on the glass), and no output is listed twice: with no primary flagged, or the
    flag on the Portrait, the alphabetical first output (DP-3, the Portrait) became primary and was listed
    twice."""
    portrait = next((n for n, o in outputs.items() if o["portrait"]), None)
    others = sorted(n for n in outputs if n != portrait)
    primary = next((n for n in others if outputs[n]["primary"]), None) or (others[0] if others else None)
    order = ([primary] if primary else []) + [n for n in others if n != primary] + ([portrait] if portrait else [])
    cmd, x = ["xrandr"], 0
    for n in order:
        w, h = (1536, 2048) if n == portrait else (outputs[n]["preferred"] or (0, 0))
        if w == 0:
            continue
        cmd += ["--output", n, "--mode", f"{w}x{h}", "--pos", f"{x}x0"] + (["--primary"] if n == primary else [])
        x += w
    return cmd


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
        cmd = standard_layout(outputs)
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        last_fix = now
        entry = {"kind": "display_fix", "time": time.strftime("%Y-%m-%dT%H:%M:%S"), "stuck": stuck,
                 "command": " ".join(cmd[1:]), "ok": result.returncode == 0, "error": result.stderr.strip()[:200]}
        latest["display_fix"] = entry
        write_log(entry)


# --- Choom app feed -------------------------------------------------------------------------
choom_feed = {"state": "starting", "url": CHOOM_URL}
app_mute = {}  # the Choom app's mute as last heard: {"muted": bool}, replayed to a page that just started


def replay_state():
    """State that only reaches the page when it changes, for a page that has just (re)started: its mute
    (every build relaunches the glass, which came back talking while the app was muted), Donny's presence,
    whether he's looking at the glass, and the weather (sent every 2 minutes anyway)."""
    events = []
    if "muted" in app_mute:
        events.append({"type": "mute", "muted": app_mute["muted"]})
    if latest.get("presence"):
        events.append(latest["presence"])
    if latest.get("gaze"):
        events.append({"type": "gaze", **latest["gaze"]})
    if latest.get("weather"):
        events.append(latest["weather"])
    return events


def follow_choom():
    """Relay the Choom app's /api/hologram/events to the page; reconnect whenever it drops. After a drop
    the page hears "reconnected": a turn whose end was lost with the feed would otherwise leave her
    thinking (no sleep, no screensaver) until the next turn."""
    dropped = False
    while True:
        try:
            request = urllib.request.Request(f"{CHOOM_URL}/api/hologram/events",
                                             headers={"Accept": "text/event-stream"})
            with urllib.request.urlopen(request, timeout=45) as response:  # the feed pings every 15 s
                choom_feed.update(state="connected", since=time.strftime("%H:%M:%S"))
                if dropped:
                    broadcast({"type": "feed", "state": "reconnected"})
                    log_entry({"kind": "feed", "state": "reconnected"})
                    dropped = False
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
                    if event.get("type") == "mute" and isinstance(event.get("muted"), bool):
                        app_mute["muted"] = event["muted"]
                    source = event.get("source")
                    if source == "heartbeat" and event.get("chatId"):
                        autonomous_chats.add(event["chatId"])
                    if (source in ("mic", "tower") or event.get("type") == "listening"
                            or (source == "chat" and event.get("chatId") not in autonomous_chats)):
                        last_donny[0] = last_conversation[0] = time.time()
                    elif source == "group" and time.time() - last_donny[0] < DONNY_IN_ROOM_S:
                        last_conversation[0] = time.time()  # a room he's part of, not them talking among themselves
                    # Which Chooms are mid-turn answering him one to one: tower_ears waits for her turn to
                    # end before it opens the reply window. Per conversation: Genesis can be mid-turn in her
                    # chat and in the room at once, and the end of one is not the end of the other. Her room
                    # turn isn't her answer to him: one in the room she'd opened kept the window shut for 2
                    # minutes after she welcomed him back (2026-10-15).
                    if event.get("source") in ("chat", "group") and event.get("choom"):
                        turn = (event["choom"], event["source"], event.get("chatId") or event.get("roomId"))
                        if event.get("type") == "turn_start":
                            chat_turns[turn] = time.time()
                        elif event.get("type") in ("turn_end", "error"):
                            chat_turns.pop(turn, None)
                        latest["chat_turns"] = sorted({c for (c, source, _), at in chat_turns.items()
                                                       if source == "chat" and time.time() - at < 600})
                    broadcast({**event, "type": "choom", "event": event.get("type")})
        except Exception as e:  # network drop, app restart, timeout
            choom_feed.update(state=f"disconnected ({type(e).__name__})")
        dropped = True
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
    every 10 minutes, with wind, gusts, temperature and rain from Donny's own weather station every 2
    minutes when weather.json maps them to Home Assistant sensors, e.g. {"wind": "sensor.station_wind_
    average_10_minutes", "gust": "sensor.station_wind_gust", "temperature": "sensor.station_temperature",
    "rain": "sensor.station_precipitation_intensity"} (OpenWeather's town readings ran well under his
    station's and never reported gusts, and its "light rain" put rain on the glass for half an hour of a
    dry afternoon; with `rain` mapped, the page rains only while the gauge reads some)."""
    town, town_at, windy_was, rain_was, windy_seen = {}, 0.0, None, None, 0.0
    while True:
        try:
            if time.time() - town_at > 600:
                town_at = time.time()
                try:
                    with urllib.request.urlopen(f"{CHOOM_URL}/api/weather", timeout=30) as response:
                        town = json.loads(response.read()).get("weather") or {}
                except Exception as e:  # the Mac down or restarting: the station still counts (it was skipped)
                    latest["weather_error"] = f"town: {type(e).__name__}: {e}"
                    town_at = time.time() - 480  # try the town again in 2 minutes
            entry = {"type": "weather", "wind": town.get("windSpeed") or 0, "gust": town.get("windGust") or 0,
                     "description": town.get("description") or "", "temperature": town.get("temperature"),
                     "source": "town", "time": time.strftime("%Y-%m-%dT%H:%M:%S")}
            station, url_file, token_file = HA_CONFIG / "weather.json", HA_CONFIG / "ha_url", HA_CONFIG / "ha_token"
            if station.exists() and url_file.exists() and token_file.exists():
                base, token = url_file.read_text().strip().rstrip("/"), token_file.read_text().strip()
                for key, entity in json.loads(station.read_text()).items():
                    try:
                        value = float(ha_get(base, token, f"/api/states/{entity}").get("state"))
                        entry[key] = round(value, 2 if key == "rain" else 1)  # rain: inches an hour
                        entry["source"] = "station"
                    except (TypeError, ValueError):
                        pass  # unavailable for now: keep the town reading
            # Windy on a 10-minute average of 12 mph or gusts of 20, held for 20 minutes after the last
            # such reading: gusts come and go, and the rule alone turned her windy day on and off every
            # few minutes (living.js windy() uses `windy`).
            if (entry["wind"] or 0) >= 12 or (entry["gust"] or 0) >= 20:
                windy_seen = time.time()
            entry["windy"] = windy = time.time() - windy_seen < 20 * 60
            latest["weather"] = entry
            broadcast(entry)
            rain = entry.get("rain")
            if windy != windy_was or ((rain or 0) > 0) != ((rain_was or 0) > 0):  # log when it turns windy or calm, wet or dry
                log_entry({"kind": "weather", "windy": windy, "wind": entry["wind"], "gust": entry["gust"],
                           "rain": rain, "temperature": entry["temperature"], "source": entry["source"]})
                windy_was, rain_was = windy, rain
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
# time when the screens wake (a Choom starting to talk woke them then) or the monitor layout is reapplied,
# which kept "bringing him back" while he was out at the gate; the camera decides when he's back.
WELCOME_AFTER_S = float(os.environ.get("HOLOGRAM_WELCOME_AFTER_S", 20 * 60))  # away at least this long
WELCOME_EVERY_S = 2 * 60 * 60    # at most one welcome back every two hours
WELCOME_HOURS = (7, 23)          # not at night
MORNING = (5, 4 * 60 * 60)       # but back after a night away (4 h or more) counts from 5 am: up at
                                 # 6:43 after 518 minutes away went unwelcomed as "night" (2026-10-13)
INPUT_COUNTS_S = 5 * 60          # keyboard and mouse count as him only this long after the camera saw him
DESK = HERE / "desk.json"        # when he was last here and last welcomed back, kept across relaunches: the
                                 # Studio's 4:12 am relaunch after a build started his time away over, and
                                 # Genesis welcomed him back from 7 h 54 min away as "205 minutes" (2026-10-17)
DESK_SAVE_S = 60                 # saved this often while he's here
last_conversation = [0.0]        # when Donny last typed, talked or was answered (from the Choom feed)
last_donny = [0.0]               # when he himself last typed, talked or wrote (a chat, Signal, the mic)
DONNY_IN_ROOM_S = 10 * 60        # a group room counts as his conversation only this long after he took part:
                                 # the four of them talking in a room Genesis opened from her wake-up
                                 # heartbeat skipped his good morning as "already talking" (2026-10-14)
autonomous_chats = set()         # her heartbeat chats: the 7 am briefing comes through one as a "chat" turn
chat_turns = {}                  # (Choom, "chat" or "group", its id) -> when her turn there started
ROOMS_PAUSED_S = 15 * 60         # a room paused for a welcome picks up again after this even if the tower
rooms_paused = [0.0]             # never says he's done (not while he's talking at it)
ears_at = [0.0]                  # tower_ears' last word (a wake, a window, what he said)
tower_talk = {"open": False, "at": 0.0}  # a conversation at the tower under way (relaunch_when_quiet waits for it)
voice_heard = {"count": 0, "at": 0.0}  # tower_ears' "someone is talking nearby" since the last log entry
TOWER_TALK_STALE_S = 180         # open with no word from tower_ears for this long: it died mid-conversation


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


def write_log(entry):
    """One JSON line in telemetry.log. Every writer goes through here (the page's posts, the server's own
    entries, the display watchdog), so lines never interleave and the log rotates at LOG_MAX_BYTES with one
    old log kept. Rotation used to live in the display watchdog alone and the log grew to 88 MB."""
    line = json.dumps(entry) + "\n"
    with log_lock:
        try:
            if LOG.stat().st_size > LOG_MAX_BYTES:
                LOG.replace(LOG.with_suffix(".log.1"))  # status lines add ~9 MB a day
        except FileNotFoundError:
            pass
        with LOG.open("a") as f:
            f.write(line)


def log_entry(entry):
    entry.setdefault("time", time.strftime("%Y-%m-%dT%H:%M:%S"))
    write_log(entry)


def send_welcome(seconds, place):
    try:
        body = {"awayMinutes": round(seconds / 60), **({"place": place} if place else {})}
        request = urllib.request.Request(f"{CHOOM_URL}/api/hologram/welcome", data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=60) as response:
            answer = json.loads(response.read())
        # A room running now stops before its next speaker, so his answer to her isn't held behind more
        # room turns; it picks up again once he's done talking with her (resume_rooms).
        paused = len(answer.get("pausing") or [])
        log_entry({"kind": "welcome", "minutes": body["awayMinutes"], "place": place, "choom": answer.get("choom"),
                   "ok": answer.get("ok"), "skipped": answer.get("skipped"), **({"rooms_paused": paused} if paused else {})})
        if paused:
            rooms_paused[0] = time.time()
        if answer.get("ok") and answer.get("choom"):  # tower_ears opens a reply window once she's done
            latest["welcome"] = {"choom": answer["choom"], "at": time.time()}
    except Exception as e:
        log_entry({"kind": "welcome", "minutes": round(seconds / 60), "error": type(e).__name__})


def resume_rooms(why):
    """He's done talking with whoever welcomed him back: a room paused for it picks up again."""
    rooms_paused[0] = 0.0
    try:
        request = urllib.request.Request(f"{CHOOM_URL}/api/hologram/welcome", data=json.dumps({"done": True}).encode(),
                                         headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=30) as response:
            answer = json.loads(response.read())
        resumed, carried_on = len(answer.get("resumed") or []), len(answer.get("carriedOn") or [])
        if resumed or carried_on or answer.get("error"):
            log_entry({"kind": "rooms", "resumed": resumed, "carried_on": carried_on, "why": why,
                       **({"error": answer["error"]} if answer.get("error") else {})})
    except Exception as e:
        log_entry({"kind": "rooms", "why": why, "error": type(e).__name__})


def desk_saved():
    """(when he was last at the desk, the last welcome back) as the last run saved them; 0 for unknown."""
    try:
        saved = json.loads(DESK.read_text())
        here, welcomed = (float(saved.get(k) or 0) for k in ("here", "welcomed"))
    except Exception:
        return 0.0, 0.0
    now = time.time()
    return (here if here <= now else 0.0), (welcomed if welcomed <= now else 0.0)


def save_desk(here, welcomed):
    try:
        part = DESK.with_suffix(".part")
        part.write_text(json.dumps({"here": here, "welcomed": welcomed}))
        part.replace(DESK)
    except OSError:
        pass


def welcome_watch():
    # A relaunch carries on from the last run's desk.json; with none, he counts as here at the start.
    saved_here, last_welcome = desk_saved()
    present_at = saved_here or time.time()
    places, was_here, face_seen, saved_at = [], [not saved_here], present_at, 0.0
    while True:
        time.sleep(5)
        try:
            if (rooms_paused[0] and time.time() - rooms_paused[0] > ROOMS_PAUSED_S
                    and time.time() - ears_at[0] > 2 * 60):
                threading.Thread(target=resume_rooms, args=("timeout",), daemon=True).start()
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
                    save_desk(present_at, last_welcome)  # the last moment he was here
            if not here:
                # Where he is while away, from Home Assistant (the shop, the truck), if it knows.
                for role, value in presence.items():
                    if value is True and role not in ("home", "desk", "bed", "type", "time") and role not in places:
                        places.append(role)
                continue
            away = time.time() - present_at
            present_at = time.time()
            if present_at - saved_at > DESK_SAVE_S:
                save_desk(present_at, last_welcome)
                saved_at = present_at
            cam = camera_settings()
            if cam.get("welcome") is False:
                places = []
                continue
            after = WELCOME_AFTER_S if os.environ.get("HOLOGRAM_WELCOME_AFTER_S") else float(cam.get("welcome_minutes", 20)) * 60
            if away < after:
                places = []
                continue
            hour = time.localtime().tm_hour
            morning = MORNING[0] <= hour < WELCOME_HOURS[0] and away >= MORNING[1]
            why = ("night" if not (WELCOME_HOURS[0] <= hour < WELCOME_HOURS[1] or morning) else
                   "welcomed lately" if time.time() - last_welcome < WELCOME_EVERY_S else
                   "already talking" if time.time() - last_conversation[0] < 120 else
                   "in bed" if latest.get("in_bed_now") else None)
            if why:
                log_entry({"kind": "welcome", "minutes": round(away / 60), "skipped": why})
            else:
                last_welcome = time.time()
                save_desk(present_at, last_welcome)
                threading.Thread(target=send_welcome, args=(away, places[-1] if places else None), daemon=True).start()
            places = []
        except Exception as e:
            latest["welcome_watch_error"] = f"{type(e).__name__}: {e}"


# --- Screens ------------------------------------------------------------------------------------
# The screens wake only when the camera sees Donny, he says "OK Eve" at the tower, or he presses a
# Portrait button, and go dark again GNOME's idle delay (Settings > Power > Screen Blank: 8 minutes)
# after he was last seen or heard at the tower. GNOME can't do that part: once its screens are woken
# without a key or mouse touch it never blanks them again until the next touch, and they stayed lit
# from 2:47 am until morning (2026-10-15).
SCREEN_SEEN_S = 10  # the camera saw (or the tower heard) him this recently: he's here
tower_heard = [0.0]  # when the tower last heard him: "OK Eve", or his answer in a reply window


def screen_watch():
    face_at, idle_was = 0.0, False
    while True:
        time.sleep(3)
        try:
            if (latest.get("gaze") or {}).get("face") is True:
                face_at = time.time()
            unseen = time.time() - max(face_at, tower_heard[0])
            dark = screens_dark()
            status = gnome("org.gnome.SessionManager", "/org/gnome/SessionManager/Presence",
                           "org.freedesktop.DBus.Properties.Get", "org.gnome.SessionManager.Presence", "status")
            idle_now = "uint32 3" in status  # GNOME's session just went idle: its fade to dark starts
            if unseen < SCREEN_SEEN_S:
                if dark or (idle_now and not idle_was) or monitors_off():  # here: light them, or stop the fade
                    wake_screen("camera" if time.time() - face_at < SCREEN_SEEN_S else "tower")
            elif dark is False:
                idle = idle_seconds()
                delay = re.search(r"uint32 (\d+)", subprocess.run(["gsettings", "get", "org.gnome.desktop.session",
                                                                 "idle-delay"], capture_output=True, text=True, timeout=5).stdout)
                delay = int(delay.group(1)) if delay else 0  # "uint32 480": seconds, 0 for never
                inhibited = "true" in gnome("org.gnome.SessionManager", "/org/gnome/SessionManager",
                                            "org.gnome.SessionManager.IsInhibited", "8")  # a video playing, say
                # Untouched past GNOME's delay (and it hasn't blanked them), and unseen as long: dark.
                if delay and idle is not None and idle >= delay + 30 and unseen >= delay and not inhibited:
                    gnome("org.gnome.ScreenSaver", "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver.SetActive", "true")
                    log_entry({"kind": "screens", "on": False, "why": "unseen", "idle": round(idle),
                               "unseen": round(min(unseen, idle))})
            idle_was = idle_now
        except Exception as e:
            latest["screen_watch_error"] = f"{type(e).__name__}: {e}"


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
# The looking-glass skill in the Choom app: glass_move("a little dance"), glass_wear("my red dress"),
# glass_closet() and glass_wish("a silk slip dress") go down the feed as glass_request events. The
# answer is worked out here from what is built on the glass (tools/closet.py), the page is told what
# to play or wear, and the answer goes back to /api/hologram/glass/result, the way the camera's do.
def glass_answer(request):
    choom = str(request.get("choom") or "").strip()
    cid, op = choom.lower(), request.get("op")
    what = str(request.get("what") or "").strip()[:200]
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
                "note": "This only lists your closet; nothing has changed. To change clothes, use glass_wear. "
                        "Ask for something you don't have and it goes on Donny's wish list for Glass Studio."}
    if not what:
        return {"ok": False, "error": "Say what: a move (\"a twirl\") or clothes (\"my red dress\")."}
    if op == "wish":  # something new she'd like, asked for as a wish: nothing changes on the glass
        closet.add_wish(PORTRAITS, cid, "move" if request.get("kind") == "move" else "wear", what)
        return {"ok": True, "done": False, "message": f"\"{what}\" is on Donny's wish list in Glass Studio now."}
    if op == "move":
        found = closet.match_move(what, moves)
        if not found:
            closet.add_wish(PORTRAITS, cid, "move", what)
            return {"ok": True, "done": False,
                    "message": f"There's no \"{what}\" on the glass yet. It's on Donny's wish list in Glass Studio now.",
                    "moves": names}
        word, phrase = found[0][0], closet.move_name(found[0][0])
        sources = sorted({s for _, srcs in found for s in srcs})
        look_of = {c.get("source"): c.get("from", "") for c in alive.get("clips", [])}
        # A move in her usual clothes (or her usual full body) can play whatever she has on; one made only
        # in an outfit plays only while she wears it (the page picks moves from what she has on). Say which,
        # never what she's wearing now.
        anywhere = [s for s in sources if "@" not in look_of.get(s, "")]
        in_outfits = sorted({look_of[s].split("@", 1)[1] for s in sources if "@" in look_of.get(s, "")})
        wearable = [o for o in in_outfits if o in outfits]
        if not anywhere and not wearable:
            closet.add_wish(PORTRAITS, cid, "move", what)
            return {"ok": True, "done": False,
                    "message": f"You have a move like that only in clothes you can't wear on the glass yet. \"{what}\" is on Donny's wish list in Glass Studio now.",
                    "moves": names}
        broadcast({"type": "glass", "choom": cid, "move": sources, "name": word})
        if anywhere:
            return {"ok": True, "done": True, "message": f"On the glass you {phrase} next time you're on the glass and quiet."}
        clothes = " or ".join(outfits[o]["wearing"] or o for o in wearable)
        return {"ok": True, "done": True,
                "message": f"On the glass you {phrase} only in {clothes}: next time you're on the glass and quiet in it. "
                           f"glass_wear can put it on first."}
    if op == "wear":
        t = (latest.get("weather") or {}).get("temperature")
        match = closet.match_outfit(what, outfits, warm=t >= 70 if isinstance(t, (int, float)) else None,
                                    usual=closet.usual_clothes(worn, studio_main_subject(cid)))
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


def studio_main_subject(cid):
    """Her main look's subject line from her Glass Studio project, or "" (no Studio, no project)."""
    try:
        cfg = json.loads((HA_CONFIG / "studio.json").read_text())
        workspace = Path(os.path.expanduser(cfg.get("workspace", "~/choom-studio")))
        project = json.loads((workspace / "studio" / f"{cid}.json").read_text())
        return str(project.get("looks", {}).get("main", {}).get("subject", ""))
    except (OSError, ValueError, AttributeError):
        return ""


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
ZONE_GAP_S = 25     # a radar zone blinks off between readings: a gap this short doesn't end a stretch
ZONE_SOLID_S = 45   # a stretch this long in a zone is him; a ghost reading (the radar's echo of him
                    # moving in bed, shown in another zone) lasted 15 to 35 s on 2026-10-18


class Presence:
    """Home Assistant's readings, debounced into what the page is told, role by role.
    - Any role: arriving counts after "after" seconds present (at once by default), leaving after
      "away_after" seconds absent (two minutes: phones drop Wi-Fi now and then). What it reads when
      the server starts counts at once, so a relaunch keeps it.
    - A zone of a room sensor ("zone": true) is where he is in the room. A radar blinks, so a gap
      under ZONE_GAP_S doesn't break a stretch, unless another zone read him meanwhile (turning over
      at the edge of the bed, office and bed blinked by turns), and "after" is one stretch. Settling
      in another zone (it starts to count) ends it at once.
    - A zone that "stays" (the bed) is different, because a tracking radar loses someone lying still:
      the bed zone blinked on for 15 to 90 s whenever he moved and read empty in between, all night.
      It counts once it has been the last place he was seen for "after" seconds (no other zone held
      him ZONE_SOLID_S since), and it ends only when he settles in another zone or leaves home."""

    def __init__(self):
        self.shown, self.on_since, self.last_on, self.absent_since = {}, {}, {}, {}
        self.place, self.place_at = None, 0.0  # the last place he was seen, and since when

    def update(self, t, seen, entities):
        """seen: role -> True/False/None (unknown) as read at time t. Returns what to tell the page."""
        option = lambda role, key, default: (entities[role].get(key, default)
                                             if isinstance(entities.get(role), dict) else default)
        zones = [role for role in seen if option(role, "zone", False)]
        stays = [role for role in zones if option(role, "stays", False)]
        for role, value in seen.items():
            if value:
                self.on_since.setdefault(role, t)
                self.last_on[role] = t
            elif role in self.on_since and (role not in zones or t - self.last_on[role] >= ZONE_GAP_S
                                            or any(seen.get(other) for other in zones if other != role)):
                del self.on_since[role]
        # A stretch runs from its first reading to its last (a gap only counts once it's bridged).
        stretch = lambda role: self.last_on[role] - self.on_since[role] if role in self.on_since else -1.0
        solid = [role for role in zones if role not in stays and stretch(role) >= ZONE_SOLID_S]
        place = (max(solid, key=lambda role: self.on_since[role]) if solid
                 else next((role for role in stays if seen.get(role)), self.place))
        if place != self.place:
            self.place, self.place_at = place, t
        now = {}
        for role, value in seen.items():
            was = self.shown.get(role)
            if value is None or was is None:  # unknown, or the server has just started: as it reads
                now[role] = value
            elif was:
                now[role] = True  # leaving is decided below
            elif role in stays:
                now[role] = self.place == role and t - self.place_at >= option(role, "after", 0)
            else:
                now[role] = stretch(role) >= option(role, "after", 0)
        settled = {role for role in zones if now[role] and self.shown.get(role) is False}
        for role, value in seen.items():
            if not (self.shown.get(role) and now[role]):
                self.absent_since.pop(role, None)
            elif role in zones and settled - {role}:
                now[role] = False  # he's settled in another zone
            elif role in stays:
                now[role] = now.get("home") is not False
            elif value:
                self.absent_since.pop(role, None)
            else:
                self.absent_since.setdefault(role, t)
                now[role] = t - self.absent_since[role] < option(role, "away_after", AWAY_GRACE_S)
        self.shown = dict(now)
        # In bed this moment, for the welcome back: no other zone reads him (getting up into the office,
        # the bed zone still reads him for a few seconds), and the bed does, or still counts him.
        self.in_bed_now = (not any(seen.get(role) for role in zones if role != "bed")
                           and (seen.get("bed") is True or now.get("bed") is True))
        return now


def presence_watch():
    """Donny's presence from Home Assistant, passed to the page when it changes: home (a person
    entity, or the phone's Wi-Fi), and at the desk or in bed (zones of a presence sensor).
    presence.json maps roles to entities, e.g. {"home": {"entity": "sensor.phone_wi_fi_connection",
    "equals": "<home network>"}, "desk": "binary_sensor.desk_zone", "bed": "binary_sensor.bed_zone"}.
    A role can also say {"entity": ..., "after": 60, "away_after": 300}, and "zone": true (one zone of a
    room sensor) and "stays": true (the bed): see Presence.
    Without a "home" role, "home" is the person entity named by "person" (e.g. "person.donny"), else the
    only person in Home Assistant, else one named like HOLOGRAM_OWNER (default "donny"). Checks every 5 s.
    Waits quietly (and picks the files up without a restart) until ha_url and ha_token exist. ha_url should
    be an address that doesn't change: a hostname, or an IP the router always gives Home Assistant (a DHCP
    reservation), since presence and the weather station stop when it moves."""
    last, entities, resolved_at = None, {}, 0.0
    debounce = Presence()
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
                person = entities.pop("person", None)  # {"person": "person.someone"}: whose home it is
                if "home" not in entities:
                    if person:
                        entities["home"] = person
                    else:  # the only person in Home Assistant, or one named like the owner (Donny here)
                        people = [e for e in ha_get(base, token, "/api/states") if e["entity_id"].startswith("person.")]
                        owner = os.environ.get("HOLOGRAM_OWNER", "donny").lower()
                        named = [e for e in people if owner in (e["entity_id"] + str(e["attributes"].get("friendly_name", ""))).lower()]
                        if named or len(people) == 1:
                            entities["home"] = (named or people)[0]["entity_id"]
                resolved_at = time.time()
            now, gone = {}, []
            for role, spec in entities.items():
                # A role is an entity id (present when it reads home/on/detected/occupied), or
                # {"entity": ..., "equals": value} (present when it reads exactly that, e.g. the
                # phone's Wi-Fi network at home).
                entity = spec["entity"] if isinstance(spec, dict) else spec
                try:
                    raw = str(ha_get(base, token, f"/api/states/{entity}").get("state", ""))
                except urllib.error.HTTPError as e:
                    if e.code != 404:
                        raise
                    raw = ""  # renamed or removed in Home Assistant: that role is unknown, the others go on
                    gone.append(entity)
                if raw.lower() in ("unavailable", "unknown", ""):
                    now[role] = None
                elif isinstance(spec, dict) and "equals" in spec:
                    now[role] = raw == spec["equals"]
                else:
                    now[role] = raw.lower() in PRESENT_STATES
            now = debounce.update(time.time(), now, entities)
            latest["in_bed_now"] = debounce.in_bed_now
            latest["presence_state"] = "watching " + ", ".join(
                f"{role}: {spec['entity'] if isinstance(spec, dict) else spec}" for role, spec in entities.items()) + (
                f"; not found in Home Assistant: {', '.join(gone)}" if gone else "")
            if now != last:
                entry = {"type": "presence", **now, "time": time.strftime("%Y-%m-%dT%H:%M:%S")}
                latest["presence"] = entry
                broadcast(entry)
                last = now
        except Exception as e:  # HA restarting, a network drop
            latest["presence_state"] = f"error: {type(e).__name__}: {e}"
            time.sleep(30)
            continue
        time.sleep(5)


# --- Crash recovery -------------------------------------------------------------------------------
# The page posts its status every 2 s, also with the screens dark. When none has come for PAGE_SILENT_S
# (Chrome crashed, the page froze, its graphics were lost for good), launch.sh relaunches everything; it
# stops this server too, so it runs in a session of its own. Not while this launch is still starting, not
# while launch.sh is running anyway, and at most once per PAGE_RELAUNCH_EVERY_S (kept in recovery.log,
# since each relaunch starts a new server). Only the living page is watched: first-light is a test scene.
STARTED_AT = time.time()
PAGE_SILENT_S = 60
PAGE_RELAUNCH_EVERY_S = 10 * 60
STARTING_S = 120
RECOVERY_LOG = HERE / "recovery.log"
# The tower's helpers, kept running one of each: (script, the variable that turns it off in launch.sh).
HELPERS = (("tower_ears.py", "HOLOGRAM_EARS", "ears.log"), ("tower_eyes.py", "HOLOGRAM_EYES", "eyes.log"))
HELPER_RESTARTS = 3              # at most this many restarts of one helper ...
HELPER_WINDOW_S = 10 * 60        # ... in this long; then it's left down (and logged)


def recovery_note(entry):
    """A line in recovery.log (what was done and when) and in telemetry.log."""
    entry = {"time": time.strftime("%Y-%m-%dT%H:%M:%S"), **entry}
    with open(RECOVERY_LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")
    write_log({"kind": "recovery", **entry})


def last_page_relaunch():
    try:
        for line in reversed(RECOVERY_LOG.read_text().splitlines()):
            entry = json.loads(line)
            if entry.get("action") == "page relaunch":
                return time.mktime(time.strptime(entry["time"], "%Y-%m-%dT%H:%M:%S"))
    except (OSError, ValueError, KeyError):
        pass
    return 0.0


def pids_of(script):
    out = subprocess.run(["pgrep", "-f", "--", str(HERE / script)], capture_output=True, text=True).stdout
    return [int(p) for p in out.split() if int(p) != os.getpid()]


def page_watch():
    while True:
        time.sleep(10)
        try:
            now = time.time()
            if now - STARTED_AT < STARTING_S:
                continue
            page = ((latest.get("start") or {}).get("page")) or "living"
            silent = now - received_at.get("status", STARTED_AT)
            if page != "living" or silent < PAGE_SILENT_S:
                continue
            if now - last_page_relaunch() < PAGE_RELAUNCH_EVERY_S:
                continue
            if subprocess.run(["pgrep", "-f", "--", r"launch\.sh( |$)"], capture_output=True).returncode == 0:
                continue  # a relaunch is under way (also "./launch.sh living" from relaunch_when_quiet.sh)
            recovery_note({"action": "page relaunch", "silent_s": round(silent)})
            subprocess.Popen([str(HERE / "launch.sh"), "living"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
        except Exception as e:
            latest["page_watch_error"] = f"{type(e).__name__}: {e}"


def helper_watch():
    """Exactly one tower_ears and one tower_eyes: a dead one is started again (logs appended), a second one
    is stopped (the newer). launch.sh starts them; this keeps them up between relaunches."""
    restarts = {}
    python = HERE / ".venv-ears" / "bin" / "python"
    while True:
        time.sleep(30)
        try:
            if time.time() - STARTED_AT < STARTING_S or not python.exists():
                continue
            for script, switch, log_name in HELPERS:
                if os.environ.get(switch, "1") == "0":
                    continue
                pids = pids_of(script)
                if len(pids) > 1:
                    ages = {p: float((Path("/proc") / str(p) / "stat").read_text().split()[21]) for p in pids}
                    for extra in sorted(pids, key=lambda p: ages[p])[1:]:  # keep the one started first
                        os.kill(extra, 15)
                        recovery_note({"action": "stopped a second", "helper": script, "pid": extra})
                elif not pids:
                    recent = [t for t in restarts.get(script, []) if time.time() - t < HELPER_WINDOW_S]
                    if len(recent) >= HELPER_RESTARTS:
                        latest[f"{script}_down"] = f"died {len(recent)} times in {HELPER_WINDOW_S // 60} min; left down"
                        continue
                    restarts[script] = recent + [time.time()]
                    with open(HERE / log_name, "a") as log:
                        log.write(f"\n== {time.strftime('%Y-%m-%d %H:%M:%S')} restarted by server.py ==\n")
                        log.flush()
                        subprocess.Popen([str(python), str(HERE / script)], stdin=subprocess.DEVNULL, stdout=log,
                                         stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
                    recovery_note({"action": "restarted", "helper": script})
        except Exception as e:
            latest["helper_watch_error"] = f"{type(e).__name__}: {e}"


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
            talking = tower_talk["open"] and time.time() - max(tower_talk["at"], ears_at[0]) < TOWER_TALK_STALE_S
            return self._send_json({**latest, "buttons": buttons, "choom_feed": choom_feed,
                                    "tower_conversation": {"open": talking}})
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
            if event in ("wake", "heard"):  # Donny himself talking at the tower keeps the screens lit
                tower_heard[0] = time.time()
            if event == "wake":
                wake_screen("tower")
            if event != "voice":
                ears_at[0] = time.time()
            if event in ("wake", "window", "invited") or (event == "listen" and entry.get("listening") is True):
                tower_talk.update(open=True, at=time.time())
            elif event in ("window_closed", "invited_done") or (event == "listen" and entry.get("listening") is False):
                tower_talk.update(open=False, at=time.time())
            if event == "invited_done":  # his conversation with whoever welcomed him back is over
                threading.Thread(target=resume_rooms, args=("tower",), daemon=True).start()
            if event in ("window", "window_closed"):  # the reply window opening, or closing unheard
                broadcast({"type": "control", "chime": "open" if event == "window" else "close"})
            if event == "voice":  # someone is talking near the tower: no screensaver turn now
                broadcast({"type": "control", "activity": True})
                # Counted, and logged at most every 5 minutes: how often the tower thinks it hears
                # talking (a build's fans, him turning over in bed at night?).
                voice_heard["count"] += 1
                if time.time() - voice_heard["at"] >= 300:
                    log_entry({"kind": "ears", "event": "voice", "count": voice_heard["count"]})
                    voice_heard.update(count=0, at=time.time())
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
                       **{k: entry[k] for k in ("message", "seconds", "voiced", "ended", "floor") if k in entry}})
            self.send_response(204)
            self.end_headers()
            return
        if self.path == "/eyes":
            # tower_eyes.py: Donny looking at the glass or away, his face there or gone, a camera plugged
            # in or out. It sends the whole state on each change and every 30 s; only changes are passed
            # to the page and logged. Only that state comes here: the pictures it serves go to the Choom
            # app (its Camera tab, the Chooms' snapshots) through answer_camera, and none is ever kept.
            if "camera" in entry and entry["camera"] != latest.get("eyes_camera"):
                latest["eyes_camera"] = entry["camera"]
                self._log({"kind": "eyes", "camera": entry["camera"]})
            if "looking" in entry or "face" in entry:
                gaze = {"looking": entry.get("looking") is True, "face": entry.get("face") is True}
                if gaze != latest.get("gaze"):
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
        write_log(entry)

    def _stream_events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        q = queue.Queue()
        for event in replay_state():  # what a page that just started can't know yet
            q.put(json.dumps(event))
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


class Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        # The page closing a connection mid-file (a reload, a video swapped out) is routine; anything
        # else still prints its traceback to server.log.
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


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
    threading.Thread(target=screen_watch, daemon=True).start()
    threading.Thread(target=page_watch, daemon=True).start()
    threading.Thread(target=helper_watch, daemon=True).start()
    Server(("127.0.0.1", args.port), Handler).serve_forever()
