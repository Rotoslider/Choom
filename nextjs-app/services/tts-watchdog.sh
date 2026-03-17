#!/bin/bash
# TTS Watchdog — restarts quite-chatter if synthesis is stuck
# Designed for the case where the service is "running" but not producing audio.
#
# Strategy:
#   1. Check if the service is active (skip if intentionally stopped)
#   2. Quick health check: GET /v1/voices (5s timeout)
#   3. Synthesis test: POST /v1/audio/speech with minimal text (30s timeout)
#   4. Validate response is actual WAV audio (RIFF header)
#   5. If any step fails → restart + log + optional Signal alert
#
# Install: sudo systemctl enable --now tts-watchdog.timer

SERVICE="quite-chatter"
TTS_ENDPOINT="http://localhost:8004"
SYNTH_TIMEOUT=30
HEALTH_TIMEOUT=5
LOG_TAG="tts-watchdog"
ALERT_PHONE="+15879881744"
SIGNAL_CLI="/usr/local/bin/signal-cli"
SIGNAL_ACCOUNT="+14036905095"

log() { logger -t "$LOG_TAG" "$1"; echo "$(date '+%Y-%m-%d %H:%M:%S') $1"; }

# 1. Only check if the service is supposed to be running
if ! systemctl is-active --quiet "$SERVICE"; then
  log "Service $SERVICE is not active — skipping (intentionally stopped?)"
  exit 0
fi

# 2. Quick health check — can we reach the service at all?
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$HEALTH_TIMEOUT" "$TTS_ENDPOINT/v1/voices" 2>/dev/null)
if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "405" ]]; then
  log "FAIL: Health check returned HTTP $HTTP_CODE (expected 200/405) — restarting $SERVICE"
  sudo systemctl restart "$SERVICE"
  log "Restarted $SERVICE after failed health check"
  # Alert via Signal if available
  if [[ -x "$SIGNAL_CLI" ]]; then
    "$SIGNAL_CLI" -a "$SIGNAL_ACCOUNT" send -m "[TTS Watchdog] Restarted $SERVICE — health check failed (HTTP $HTTP_CODE)" "$ALERT_PHONE" 2>/dev/null &
  fi
  exit 1
fi

# 3. Synthesis test — send a minimal TTS request and check for audio response
RESPONSE_FILE=$(mktemp /tmp/tts-watchdog-XXXXXX.wav)
HTTP_CODE=$(curl -s -o "$RESPONSE_FILE" -w "%{http_code}" --max-time "$SYNTH_TIMEOUT" \
  -X POST "$TTS_ENDPOINT/v1/audio/speech" \
  -H "Content-Type: application/json" \
  -d '{"model":"chatterbox","input":"test","voice":"sophie","response_format":"wav","speed":1.0}' \
  2>/dev/null)

SYNTH_OK=false

if [[ "$HTTP_CODE" == "200" ]]; then
  # 4. Validate response is actual WAV audio (starts with RIFF header)
  MAGIC=$(head -c 4 "$RESPONSE_FILE" 2>/dev/null | od -A n -t x1 | tr -d ' ')
  if [[ "$MAGIC" == "52494646" ]]; then
    FILE_SIZE=$(stat -c%s "$RESPONSE_FILE" 2>/dev/null || echo 0)
    if [[ "$FILE_SIZE" -gt 1000 ]]; then
      SYNTH_OK=true
      log "OK: Synthesis test passed (${FILE_SIZE} bytes WAV)"
    else
      log "FAIL: Response too small (${FILE_SIZE} bytes) — likely empty/corrupt audio"
    fi
  else
    log "FAIL: Response is not WAV audio (magic: $MAGIC, expected: 52494646)"
  fi
else
  log "FAIL: Synthesis request returned HTTP $HTTP_CODE (timeout or error)"
fi

rm -f "$RESPONSE_FILE"

if [[ "$SYNTH_OK" == "false" ]]; then
  log "Restarting $SERVICE after failed synthesis test"
  sudo systemctl restart "$SERVICE"
  RESTART_STATUS=$?
  if [[ $RESTART_STATUS -eq 0 ]]; then
    log "Restarted $SERVICE successfully"
  else
    log "ERROR: Failed to restart $SERVICE (exit code $RESTART_STATUS)"
  fi
  # Alert via Signal
  if [[ -x "$SIGNAL_CLI" ]]; then
    "$SIGNAL_CLI" -a "$SIGNAL_ACCOUNT" send -m "[TTS Watchdog] Restarted $SERVICE — synthesis test failed" "$ALERT_PHONE" 2>/dev/null &
  fi
  exit 1
fi

exit 0
