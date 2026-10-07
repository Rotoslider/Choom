#!/usr/bin/env python3
"""The tower's ears: say "OK Aloy" (or OK Optic, OK Genesis, OK Eve) and that Choom comes to the
glass and listens; what you say next goes to her main chat and she answers in the glass.

Listens to the default microphone (the EMEET on the tower) through PipeWire, finds speech with
WebRTC VAD, and checks how each utterance begins for a wake phrase with a small Whisper model on
the GPU (faster-whisper small.en). The phrase must open the utterance, so naming a Choom mid-sentence
never calls her. Nothing is kept or sent anywhere until a wake phrase is heard; then the words (the
rest of that utterance, or the next one) go to the Choom app's speech-to-text and on to
/api/hologram/talk, and the hologram follows her turn. After she answers, the mic stays open a few
seconds for a reply without the wake phrase.

Run with the hologram's own venv (launch.sh starts it when the venv exists):
    .venv-ears/bin/python tower_ears.py
"""
import collections
import io
import json
import os
import queue
import re
import select
import subprocess
import threading
import time
import urllib.request
import uuid
import wave

import numpy as np
import webrtcvad
from faster_whisper import WhisperModel

CHOOM_URL = os.environ.get("CHOOM_URL", "http://donnys-mac-studio-3.local:3000")
HOLOGRAM_URL = os.environ.get("HOLOGRAM_URL", "http://127.0.0.1:8765")
RATE = 16000                     # what VAD and Whisper get
CAPTURE_RATE = 16000             # the EMEET's microphone runs at 16 kHz (it plays at 48 kHz)
FRAME = 480                      # 30 ms at RATE
COMMAND_WAIT_S = 8               # after a bare "OK Eve", how long she waits for the words
FOLLOW_UP_S = 6                  # after her answer, how long the mic stays open for a reply
# Frames of quiet (2.5 s) that end what he's saying to her. The EMEET's noise suppression sends exact
# silence in every pause, and measured at the desk (Oct 6) Donny's pauses between sentences ran past
# 1.6 s every few sentences, which cut messages off mid-thought; only long thinking stops go past 2.5 s.
SENTENCE_QUIET = 83
MAX_SPEECH_S = 45                # the longest single message (the app's speech-to-text splits long ones)
ROOM = "Chooms"                  # "OK Chooms" / "OK girls" / "OK everyone": the group room
NAMES = {                        # what Whisper may write for each name
    "Aloy": r"aloy|aloi|eloy|eloi|aloe|alloy|alloi|a loy|aloya|aloha",
    "Optic": r"optic|optik|optics|optick",
    "Genesis": r"genesis|genisis|jenesis",
    "Eve": r"eve|eva|eave|evie",
    ROOM: r"chooms?|choom's|chums|chumps|girls|gals|everyone|everybody",   # all of them: the group room
}
WAKE = re.compile(r"^\W*(?:ok|okay|o\.k\.|hey)\W+(" + "|".join(NAMES.values()) + r")\b\W*(.*)$", re.I | re.S)


def die_with_parent():
    """pw-record ends with this process, so a relaunch never leaves a recorder holding the mic."""
    import ctypes
    ctypes.CDLL("libc.so.6").prctl(1, 15)  # PR_SET_PDEATHSIG, SIGTERM


def choom_for(word):
    return next(name for name, pattern in NAMES.items() if re.fullmatch(pattern, word, re.I))


def post_json(url, payload, timeout=10):
    request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read() or b"{}")


def tell_hologram(event, choom=None, **extra):
    """The page shows her listening (or not); server.py also wakes the screens and logs it."""
    try:
        post_json(f"{HOLOGRAM_URL}/ears", {"event": event, "choom": choom, **extra}, timeout=3)
    except Exception:
        pass


def hologram_status():
    """The page's latest status, or None if it couldn't be read (never mistaken for "idle")."""
    try:
        with urllib.request.urlopen(f"{HOLOGRAM_URL}/status", timeout=3) as response:
            return json.loads(response.read()).get("status") or None
    except Exception:
        return None


def wav_bytes(pcm):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm)
    return buffer.getvalue()


def speech_to_text(pcm):
    """The Choom app's own speech-to-text (the same as its mic button)."""
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"tower.wav\"\r\n"
            f"Content-Type: audio/wav\r\n\r\n").encode() + wav_bytes(pcm) + f"\r\n--{boundary}--\r\n".encode()
    request = urllib.request.Request(f"{CHOOM_URL}/api/stt", data=body,
                                     headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return (json.loads(response.read()).get("text") or "").strip()


class Ears:
    def __init__(self):
        self.vad = webrtcvad.Vad(2)
        self.floor = 30.0                    # the room's background level (frame RMS), tracked
        self.last_capture = {}
        self.voice_told = 0.0
        self.model = WhisperModel("small.en", device="cuda", compute_type="float16")
        list(self.model.transcribe(np.zeros(RATE, np.float32), language="en")[0])  # the first call takes seconds
        self.frames = queue.Queue()

    def capture(self):
        """Mono from the default PipeWire source, restarted if it ever stops. The recorder dies with
        this process: recorders orphaned by relaunches once wedged PipeWire's capture of the EMEET,
        and the mic went silent for every app (the browser's mic button too) until PipeWire restarted."""
        while True:
            proc = subprocess.Popen(["pw-record", "--rate", str(CAPTURE_RATE), "--channels", "1", "--format", "s16", "-"],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, preexec_fn=die_with_parent)
            step = CAPTURE_RATE // RATE
            while True:
                # A stalled microphone sends nothing at all (no error, no end): notice within 5 s.
                if not select.select([proc.stdout], [], [], 5)[0]:
                    tell_hologram("error", message="mic stalled: no audio for 5 s")
                    break
                chunk = proc.stdout.read(FRAME * step * 2)
                if len(chunk) < FRAME * step * 2:
                    break
                wide = np.frombuffer(chunk, np.int16).astype(np.int32).reshape(-1, step)
                self.frames.put(wide.mean(axis=1).astype(np.int16).tobytes())  # averaging is the low-pass
            proc.kill()
            time.sleep(2)

    def utterance(self, start_within=None, quiet_frames=25):
        """The next stretch of speech (with 300 ms before it), or None if none starts in time. It ends
        after quiet_frames of silence (25 = 750 ms, enough for "OK Aloy"; 40 for whole sentences)."""
        ring, voiced, speech, silent_run = [], [], None, 0
        recent = collections.deque(maxlen=quiet_frames)
        deadline = time.time() + start_within if start_within else None
        while True:
            try:
                frame = self.frames.get(timeout=0.5)
            except queue.Empty:
                frame = None
            if frame is None:
                if speech is None and deadline and time.time() > deadline:
                    return None
                continue
            # Speech by the detector, or clearly louder than the room: the EMEET's noise suppression
            # leaves soft syllables faint enough for WebRTC VAD to call them silence mid-sentence.
            level = float(np.sqrt(np.mean(np.frombuffer(frame, np.int16).astype(np.float32) ** 2)))
            is_speech = self.vad.is_speech(frame, RATE) or level > max(60.0, 6 * self.floor)
            if not is_speech:
                self.floor += (level - self.floor) * 0.02
            if speech is None:
                ring = (ring + [frame])[-10:]
                voiced = (voiced + [is_speech])[-10:]
                if sum(voiced) >= 6:
                    speech = list(ring)
                    if time.time() - self.voice_told > 20:  # someone is talking nearby: hold the screensaver
                        self.voice_told = time.time()
                        tell_hologram("voice")
                elif deadline and time.time() > deadline:
                    return None
                continue
            speech.append(frame)
            # It ends when nine tenths of the last quiet_frames were quiet: a stray "speech" frame in
            # the room's background can't hold it open, and a short breath doesn't end it.
            recent.append(not is_speech)
            silent_run = sum(recent) if len(recent) == quiet_frames else 0
            if silent_run >= 0.9 * quiet_frames or len(speech) >= MAX_SPEECH_S * RATE // FRAME:
                pcm = b"".join(speech)
                self.last_capture = {"seconds": round(len(pcm) / 2 / RATE, 1),
                                     "ended": "quiet" if silent_run >= 0.9 * quiet_frames else f"{MAX_SPEECH_S} s cap",
                                     "floor": round(self.floor, 1)}
                return pcm if len(pcm) >= int(0.4 * RATE) * 2 else self.utterance(start_within and max(deadline - time.time(), 0.1), quiet_frames)

    def wake(self, pcm):
        """(Choom, rest of what was said) if the utterance opens with a wake phrase."""
        audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768
        segments, _ = self.model.transcribe(audio, language="en", beam_size=1, condition_on_previous_text=False,
                                            initial_prompt="OK Aloy. OK Optic. OK Genesis. OK Eve. OK Chooms. OK girls.")
        segments = list(segments)
        if not segments or segments[0].no_speech_prob > 0.6 or segments[0].avg_logprob < -1.0:
            return None
        match = WAKE.match(" ".join(s.text for s in segments))
        return (choom_for(match.group(1)), match.group(2).strip()) if match else None

    def is_speech(self, pcm):
        """Whisper invents tidy sentences out of noise; check the clip really holds words first."""
        audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768
        segments = list(self.model.transcribe(audio, language="en", beam_size=1, condition_on_previous_text=False)[0])
        words = " ".join(s.text for s in segments).split()
        return bool(words) and min(s.no_speech_prob for s in segments) < 0.5 and max(s.avg_logprob for s in segments) > -1.0

    def send(self, choom, pcm, local_rest=""):
        """His words to her chat: the app's transcript (wake phrase removed), else Whisper's."""
        if not self.is_speech(pcm):
            return None
        tell_hologram("heard", choom, **self.last_capture)  # length and how it ended, never the words
        try:
            text = speech_to_text(pcm)
            match = WAKE.match(text)
            text = match.group(2).strip() if match else text
        except Exception as e:
            tell_hologram("error", choom, message=f"speech-to-text: {type(e).__name__}")
            text = local_rest
        if len(text.split()) < 1:
            return None  # nothing said after all (a cough, the tail of her voice): keep listening
        try:
            target = {"room": True} if choom == ROOM else {"choom": choom}
            post_json(f"{CHOOM_URL}/api/hologram/talk", {**target, "text": text}, timeout=60)
            return True
        except Exception as e:
            tell_hologram("error", choom, message=f"talk: {type(e).__name__}")
            tell_hologram("listen", choom, listening=False)
            return False

    def wait_for_answer(self, quiet_polls=2):
        """Until her turn has started and she has finished speaking: idle quiet_polls times in a row
        (an unread status is never taken for idle; that once opened the reply window mid-answer).
        A room needs longer: there are pauses between one Choom and the next."""
        started, idle_polls, deadline = False, 0, time.time() + 300
        while time.time() < deadline:
            status = hologram_status()
            if status is not None:
                busy = status.get("mood") in ("thinking", "speaking") or status.get("queued")
                if busy:
                    started, idle_polls = True, 0
                elif started:
                    idle_polls += 1
                    if idle_polls >= quiet_polls:
                        return True
            time.sleep(1)
        return False

    def conversation(self, choom, pcm=None, rest=""):
        """A wake phrase was heard: listen, send, and keep listening for replies."""
        follow_up, empty = False, 0
        while True:
            tell_hologram("listen", choom, listening=True)
            if pcm is None:
                pcm = self.utterance(start_within=FOLLOW_UP_S if follow_up else COMMAND_WAIT_S, quiet_frames=SENTENCE_QUIET)
                if pcm is None:
                    tell_hologram("listen", choom, listening=False)
                    return
                other = self.wake(pcm)
                if other and other[0] != choom:     # "OK Optic ..." while talking to Eve: switch
                    choom, rest = other
                    if not rest:
                        pcm = None
                        continue
            # In the reply window, a sound under 0.8 s (a cough, a door, the end of a word on the TV)
            # isn't a reply: keep listening without bothering speech-to-text.
            short = follow_up and len(pcm) < int(0.8 * RATE) * 2
            sent = None if short else self.send(choom, pcm, rest)
            if sent is None:
                empty += 1
                if empty >= 3:  # noise, not words: stop listening
                    tell_hologram("listen", choom, listening=False)
                    return
                pcm, rest = None, ""
                continue
            empty = 0
            if not sent:
                return
            # Ignore what the mic hears while she thinks and talks (mostly her own voice).
            self.wait_for_answer(10 if choom == ROOM else 2)
            while not self.frames.empty():
                self.frames.get_nowait()
            pcm, rest, follow_up = None, "", True

    def run(self):
        threading.Thread(target=self.capture, daemon=True).start()
        tell_hologram("ready")
        while True:
            pcm = self.utterance()
            heard = self.wake(pcm)
            if not heard:
                continue
            choom, rest = heard
            tell_hologram("wake", choom)
            if len(rest.split()) >= 2:
                # "OK Aloy, how about ..." with a pause: the sentence may go on, so listen for the rest
                # (after the same pause that would end it).
                more = self.utterance(start_within=SENTENCE_QUIET * FRAME / RATE, quiet_frames=SENTENCE_QUIET)
                self.conversation(choom, pcm + (more or b""), rest)     # "OK Genesis, what's the weather?"
            else:
                self.conversation(choom)                # "OK Genesis" ... then the question


if __name__ == "__main__":
    Ears().run()
