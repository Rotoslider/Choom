"""Wyoming front end for the Choom TTS bridge.

Home Assistant's Assist pipeline speaks the Wyoming protocol (its "chatterbox"
text-to-speech entry was a Wyoming server on the NUC at 192.168.1.23:10200).
The Mac's Chatterbox lives behind services/tts-bridge on :8004 as an
OpenAI-style HTTP API, which Home Assistant cannot call directly. This server
speaks Wyoming on :10200 and turns each Synthesize into one bridge request,
so HA uses the same voices Choom does (`GET /v1/voices` on the bridge —
"summer", "sophie", "aloy", …) and the NUC can be switched off.

    python server.py --uri tcp://0.0.0.0:10200 --bridge http://127.0.0.1:8004
"""
import argparse
import asyncio
import io
import logging
import wave

import requests
from wyoming.audio import AudioChunk, AudioStart, AudioStop
from wyoming.event import Event
from wyoming.info import Attribution, Describe, Info, TtsProgram, TtsVoice
from wyoming.server import AsyncEventHandler, AsyncServer
from wyoming.tts import Synthesize

_LOGGER = logging.getLogger("wyoming-tts")
CHUNK_BYTES = 4096
DEFAULT_VOICE = "summer"


def list_voices(bridge: str) -> list[str]:
    try:
        r = requests.get(f"{bridge}/v1/voices", timeout=10)
        r.raise_for_status()
        voices = r.json().get("voices") or []
        return [v for v in voices if isinstance(v, str)]
    except Exception as err:  # the bridge may be starting up
        _LOGGER.warning("Could not list bridge voices: %s", err)
        return [DEFAULT_VOICE]


def build_info(bridge: str) -> Info:
    voices = list_voices(bridge)
    return Info(
        tts=[
            TtsProgram(
                name="chatterbox",
                description="Chatterbox (Rapid-MLX) via the Choom TTS bridge on the Mac",
                attribution=Attribution(name="Choom", url="http://127.0.0.1:8004/v1/info"),
                installed=True,
                version="1.0",
                voices=[
                    TtsVoice(
                        name=v,
                        description=v,
                        attribution=Attribution(name="Choom", url=""),
                        installed=True,
                        version="1.0",
                        languages=["en"],
                    )
                    for v in voices
                ],
            )
        ]
    )


class BridgeHandler(AsyncEventHandler):
    def __init__(self, bridge: str, default_voice: str, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.bridge = bridge
        self.default_voice = default_voice

    async def handle_event(self, event: Event) -> bool:
        if Describe.is_type(event.type):
            await self.write_event(build_info(self.bridge).event())
            return True

        if not Synthesize.is_type(event.type):
            return True

        synth = Synthesize.from_event(event)
        voice = (synth.voice.name if synth.voice and synth.voice.name else "") or self.default_voice
        text = " ".join(synth.text.split())
        _LOGGER.info("Synthesize voice=%s chars=%d", voice, len(text))

        try:
            wav_bytes = await asyncio.get_running_loop().run_in_executor(
                None, self._synthesize, text, voice
            )
        except Exception as err:
            _LOGGER.error("Bridge synthesis failed (voice=%s): %s", voice, err)
            # An empty stream tells HA the request failed instead of hanging it.
            await self.write_event(AudioStart(rate=24000, width=2, channels=1).event())
            await self.write_event(AudioStop().event())
            return True

        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            rate, width, channels = wf.getframerate(), wf.getsampwidth(), wf.getnchannels()
            frames = wf.readframes(wf.getnframes())

        await self.write_event(AudioStart(rate=rate, width=width, channels=channels).event())
        for i in range(0, len(frames), CHUNK_BYTES):
            await self.write_event(
                AudioChunk(rate=rate, width=width, channels=channels, audio=frames[i:i + CHUNK_BYTES]).event()
            )
        await self.write_event(AudioStop().event())
        _LOGGER.info("Sent %.1fs of audio", len(frames) / (rate * width * channels))
        return True

    def _synthesize(self, text: str, voice: str) -> bytes:
        r = requests.post(
            f"{self.bridge}/v1/audio/speech",
            json={"input": text, "voice": voice},
            timeout=300,
        )
        if r.status_code == 404 and voice != self.default_voice:
            _LOGGER.warning("Voice %s unknown to the bridge; using %s", voice, self.default_voice)
            r = requests.post(
                f"{self.bridge}/v1/audio/speech",
                json={"input": text, "voice": self.default_voice},
                timeout=300,
            )
        r.raise_for_status()
        return r.content


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--uri", default="tcp://0.0.0.0:10200")
    parser.add_argument("--bridge", default="http://127.0.0.1:8004")
    parser.add_argument("--default-voice", default=DEFAULT_VOICE)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    _LOGGER.info("Wyoming TTS on %s → bridge %s (voices: %s)", args.uri, args.bridge, ", ".join(list_voices(args.bridge)))
    server = AsyncServer.from_uri(args.uri)
    await server.run(lambda *a, **k: BridgeHandler(args.bridge, args.default_voice, *a, **k))


if __name__ == "__main__":
    asyncio.run(main())
