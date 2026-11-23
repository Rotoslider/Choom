# Drama 3 voice server

[Fish Audio Drama 3](https://fish.audio/blog/fish-audio-drama-3/) for Choom, on
MLX (Apple Silicon), at `127.0.0.1:8006`. It speaks the same small API as the
TTS bridge (`POST /v1/audio/speech {"input", "voice"}` → WAV, `GET /v1/voices`,
`GET /health`), but nothing calls it directly: the TTS bridge's `/drama` route
filters the delivery cues, calls it, and falls back to Chatterbox when it fails.

- `server.py`: loads `mlx-community/fish-audio-drama-3-4bit`, keeps every voice
  encoded, one generation at a time, trims trailing silence, caps runaway takes.
- `prepare_voices.py`: reference clips from your original recordings (mono, own
  sample rate, ≤25 s cut at a quiet moment) plus Whisper transcripts.
- Setup, provider and logs: MAC-SETUP.md, "5d. Drama 3 voices".

Built with Fish Audio. The weights are under the
[Fish Audio Community License](https://huggingface.co/fishaudio/drama-3/blob/main/LICENSE)
and are not part of this repo. Among its terms: free for personal use; don't use
it to imitate an identifiable real person's voice without their consent.
