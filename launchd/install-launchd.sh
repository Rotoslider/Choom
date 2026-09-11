#!/bin/bash
# Install launchd user agents for Choom on macOS.
#
# The macOS counterpart of nextjs-app/services/signal-bridge/install-services.sh
# (systemd). Everything runs as a *user* agent in ~/Library/LaunchAgents — no
# sudo, no root — because the dev server, the memory server and signal-cli all
# need the login user's HOME, keychain and Homebrew tree.
#
#   ./install-launchd.sh              # install dev + signal services
#   ./install-launchd.sh --dev-only   # just the Next.js/memory dev server
#   ./install-launchd.sh --with-ngrok # also install the ngrok tunnel
#   ./install-launchd.sh --no-searxng # skip the local SearXNG instance
#   ./install-launchd.sh --with-tts   # local Chatterbox TTS (Rapid-MLX + bridge)
#   ./install-launchd.sh --with-lan-https  # HTTPS on :3443 so the LAN mic works

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_PATH="$(cd "$SCRIPT_DIR/.." && pwd)"
BRIDGE_DIR="$PROJECT_PATH/nextjs-app/services/signal-bridge"
AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$PROJECT_PATH/nextjs-app/data/logs"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

DEV_ONLY=false
WITH_NGROK=false
WITH_SEARXNG=true
WITH_TTS=false
WITH_LAN_HTTPS=false
for arg in "$@"; do
  case "$arg" in
    --dev-only)   DEV_ONLY=true ;;
    --with-ngrok) WITH_NGROK=true ;;
    --no-searxng) WITH_SEARXNG=false ;;
    --with-tts)   WITH_TTS=true ;;
    --with-lan-https) WITH_LAN_HTTPS=true ;;
    *) echo -e "${RED}Unknown option: $arg${NC}"; exit 1 ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo -e "${RED}This script is macOS-only. On Linux use services/signal-bridge/install-services.sh (systemd).${NC}"
  exit 1
fi

# Homebrew's bin dir differs between Apple Silicon and Intel; launchd agents
# start with a bare PATH and inherit nothing from your shell, so we have to
# bake the right one into every plist.
HOMEBREW_BIN="$(brew --prefix 2>/dev/null)/bin"
[ -d "$HOMEBREW_BIN" ] || HOMEBREW_BIN=/usr/local/bin

PNPM="$(command -v pnpm || true)"
if [ -z "$PNPM" ]; then
  echo -e "${RED}pnpm not found on PATH. Install it with: brew install pnpm${NC}"
  exit 1
fi

mkdir -p "$AGENTS_DIR" "$LOG_DIR"

# render() substitutes every placeholder unconditionally, so all of these must
# exist even for the templates that don't use them (set -u).
SIGNAL_CLI=""
SIGNAL_PHONE_NUMBER=""
SIGNAL_SOCKET_PATH=""
NGROK=""
NGROK_DOMAIN=""
TRAFFIC_POLICY=""
RAPID_MLX=""
TTS_MODEL="chatterbox"
VOICES_DIR=""
KEEP_WARM_VOICE=""

# Which numbers signal-cli has registered, read straight from its account file.
#
# Do NOT shell out to `signal-cli listAccounts` here. signal-cli takes an
# exclusive lock per account, and the daemon this script installs holds it for
# as long as it runs — so on every re-run after the first install, listAccounts
# blocks forever and takes this script with it.
ACCOUNTS_JSON="$HOME/.local/share/signal-cli/data/accounts.json"

registered_numbers() {
  [ -f "$ACCOUNTS_JSON" ] || return 0
  sed -n 's/.*"number"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ACCOUNTS_JSON" | tr '\n' ' '
}

# Read a KEY=value out of the signal-bridge .env, ignoring comments.
env_get() {
  [ -f "$BRIDGE_DIR/.env" ] || return 0
  sed -n "s/^$1=//p" "$BRIDGE_DIR/.env" | head -1 | sed 's/[[:space:]]*#.*$//' | tr -d '"'
}

render() {  # render <template> <installed-plist-name>
  local src="$SCRIPT_DIR/$1" dest="$AGENTS_DIR/$2"
  sed -e "s|__PROJECT_PATH__|$PROJECT_PATH|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__HOMEBREW_BIN__|$HOMEBREW_BIN|g" \
      -e "s|__PNPM__|$PNPM|g" \
      -e "s|__SIGNAL_CLI__|$SIGNAL_CLI|g" \
      -e "s|__SIGNAL_PHONE_NUMBER__|$SIGNAL_PHONE_NUMBER|g" \
      -e "s|__SIGNAL_SOCKET_PATH__|$SIGNAL_SOCKET_PATH|g" \
      -e "s|__NGROK__|$NGROK|g" \
      -e "s|__NGROK_DOMAIN__|$NGROK_DOMAIN|g" \
      -e "s|__TRAFFIC_POLICY__|$TRAFFIC_POLICY|g" \
      -e "s|__RAPID_MLX__|$RAPID_MLX|g" \
      -e "s|__TTS_MODEL__|$TTS_MODEL|g" \
      -e "s|__VOICES_DIR__|$VOICES_DIR|g" \
      -e "s|__KEEP_WARM_VOICE__|$KEEP_WARM_VOICE|g" \
      "$src" > "$dest"
  plutil -lint "$dest" > /dev/null
  echo -e "${GREEN}  wrote $dest${NC}"
}

reload() {  # reload <label>
  local label="$1" domain="gui/$(id -u)" i

  # bootout is the modern replacement for `unload`; it fails when the agent
  # isn't loaded, which is fine on a first install.
  launchctl bootout "$domain/$label" 2>/dev/null || true

  # bootout returns before the job is actually gone. Bootstrapping into a
  # domain that still holds the old job fails with
  #   Bootstrap failed: 5: Input/output error
  # and under `set -e` that aborts the whole install. signal-cli is the one
  # that exposes it — a JVM takes seconds to die. Wait for the service to
  # disappear, then retry the bootstrap a few times before giving up.
  for i in $(seq 1 30); do
    launchctl print "$domain/$label" >/dev/null 2>&1 || break
    sleep 1
  done

  for i in 1 2 3 4 5; do
    if launchctl bootstrap "$domain" "$AGENTS_DIR/$label.plist" 2>/dev/null; then
      launchctl enable "$domain/$label"
      echo -e "${GREEN}  loaded $label${NC}"
      return 0
    fi
    sleep 2
  done

  echo -e "${RED}  failed to load $label — try: launchctl bootstrap $domain $AGENTS_DIR/$label.plist${NC}"
  return 1
}

echo "Project:  $PROJECT_PATH"
echo "Agents:   $AGENTS_DIR"
echo "Homebrew: $HOMEBREW_BIN"
echo ""

echo -e "${GREEN}Installing com.choom.dev (Next.js + memory server)...${NC}"
render com.choom.dev.plist.template com.choom.dev.plist
reload com.choom.dev

if [ "$DEV_ONLY" = false ]; then
  SIGNAL_PHONE_NUMBER="$(env_get SIGNAL_PHONE_NUMBER)"
  SIGNAL_CLI="$(env_get SIGNAL_CLI_PATH)"
  [ -n "$SIGNAL_CLI" ] || SIGNAL_CLI="$(command -v signal-cli || true)"
  SIGNAL_SOCKET_PATH="$(env_get SIGNAL_SOCKET_PATH)"
  [ -n "$SIGNAL_SOCKET_PATH" ] || SIGNAL_SOCKET_PATH="${TMPDIR:-/tmp}/signal-cli/socket"

  if [ -z "$SIGNAL_PHONE_NUMBER" ] || [ -z "$SIGNAL_CLI" ]; then
    echo -e "${YELLOW}Skipping Signal services: set SIGNAL_PHONE_NUMBER and install signal-cli first.${NC}"
    echo -e "${YELLOW}  brew install signal-cli   # then edit $BRIDGE_DIR/.env${NC}"
  elif ! grep -q "\"$SIGNAL_PHONE_NUMBER\"" "$ACCOUNTS_JSON" 2>/dev/null; then
    echo -e "${YELLOW}Skipping Signal services: $SIGNAL_PHONE_NUMBER is not registered with signal-cli here.${NC}"
    echo -e "${YELLOW}  Migrate ~/.local/share/signal-cli from the old host, or link/register the number.${NC}"
    echo -e "${YELLOW}  Registered now: $(registered_numbers)${NC}"
  else
    echo -e "\n${GREEN}Installing com.choom.signal-cli-daemon...${NC}"
    render com.choom.signal-cli-daemon.plist.template com.choom.signal-cli-daemon.plist
    reload com.choom.signal-cli-daemon

    echo -e "\n${GREEN}Installing com.choom.signal-bridge...${NC}"
    render com.choom.signal-bridge.plist.template com.choom.signal-bridge.plist
    reload com.choom.signal-bridge
  fi
fi

if [ "$WITH_SEARXNG" = true ]; then
  if [ -x "$PROJECT_PATH/nextjs-app/services/searxng/venv/bin/python" ]; then
    echo -e "\n${GREEN}Installing com.choom.searxng...${NC}"
    render com.choom.searxng.plist.template com.choom.searxng.plist
    reload com.choom.searxng
  else
    echo -e "\n${YELLOW}Skipping SearXNG: no venv yet. Build it first:${NC}"
    echo -e "${YELLOW}  cd $PROJECT_PATH/nextjs-app/services/searxng && ./setup.sh${NC}"
  fi
fi

if [ "$WITH_TTS" = true ]; then
  # rapid-mlx must come from a pip install with the [audio] extra; the Homebrew
  # bottle refuses audio aliases ("requires the optional mlx-audio dependency").
  RAPID_MLX="${CHOOM_RAPID_MLX:-$HOME/.local/share/rapid-mlx-audio/venv/bin/rapid-mlx}"
  VOICES_DIR="${CHOOM_VOICES_DIR:-$HOME/Library/Application Support/Choom/voices-prepared}"
  KEEP_WARM_VOICE="${CHOOM_KEEP_WARM_VOICE:-sophie}"

  if [ ! -x "$RAPID_MLX" ]; then
    echo -e "\n${YELLOW}Skipping local TTS: no audio-capable rapid-mlx at $RAPID_MLX${NC}"
    echo -e "${YELLOW}  python3.12 -m venv ~/.local/share/rapid-mlx-audio/venv${NC}"
    echo -e "${YELLOW}  ~/.local/share/rapid-mlx-audio/venv/bin/pip install 'rapid-mlx[audio]'${NC}"
  elif [ ! -d "$VOICES_DIR" ]; then
    echo -e "\n${YELLOW}Skipping local TTS: no prepared voices at $VOICES_DIR${NC}"
    echo -e "${YELLOW}  Each voice needs <name>.wav (~12s, 24kHz mono) and <name>.txt (its transcript).${NC}"
  elif [ ! -x "$PROJECT_PATH/nextjs-app/services/tts-bridge/venv/bin/python" ]; then
    echo -e "\n${YELLOW}Skipping local TTS: build the bridge venv first:${NC}"
    echo -e "${YELLOW}  cd $PROJECT_PATH/nextjs-app/services/tts-bridge${NC}"
    echo -e "${YELLOW}  python3.12 -m venv --copies venv && ./venv/bin/pip install -r requirements.txt${NC}"
  else
    echo -e "\n${GREEN}Installing com.choom.rapid-mlx...${NC}"
    render com.choom.rapid-mlx.plist.template com.choom.rapid-mlx.plist
    reload com.choom.rapid-mlx

    echo -e "\n${GREEN}Installing com.choom.tts-bridge (keep-warm: $KEEP_WARM_VOICE)...${NC}"
    render com.choom.tts-bridge.plist.template com.choom.tts-bridge.plist
    reload com.choom.tts-bridge
    echo -e "${YELLOW}  Point TTS_ENDPOINT at http://localhost:8004 to cut over from the old host.${NC}"
  fi
fi

if [ "$WITH_LAN_HTTPS" = true ]; then
  # The cert is machine- and IP-specific, so it is generated by its own script
  # rather than here. Without it the proxy exits immediately and launchd would
  # just respawn it forever.
  if [ -f "$PROJECT_PATH/nextjs-app/certificates/lan.pem" ]; then
    echo -e "\n${GREEN}Installing com.choom.lan-https (HTTPS on :3443)...${NC}"
    render com.choom.lan-https.plist.template com.choom.lan-https.plist
    reload com.choom.lan-https
  else
    echo -e "\n${YELLOW}Skipping LAN HTTPS: no certificate yet. Generate one first:${NC}"
    echo -e "${YELLOW}  cd $PROJECT_PATH/nextjs-app && ./scripts/setup-lan-https.sh${NC}"
  fi
fi

if [ "$WITH_NGROK" = true ]; then
  NGROK="$(command -v ngrok || true)"
  NGROK_DOMAIN="$(env_get NGROK_URL | sed 's|^https\?://||')"
  # Kept out of the repo: it holds the basic-auth credential and the repo is public.
  TRAFFIC_POLICY="${CHOOM_NGROK_POLICY:-$HOME/Library/Application Support/Choom/ngrok-traffic-policy.yml}"
  if [ -z "$NGROK" ] || [ -z "$NGROK_DOMAIN" ]; then
    echo -e "${YELLOW}Skipping ngrok: need the ngrok binary and NGROK_URL in the bridge .env.${NC}"
  elif [ ! -f "$TRAFFIC_POLICY" ]; then
    echo -e "${YELLOW}Skipping ngrok: no traffic policy at $TRAFFIC_POLICY.${NC}"
    echo -e "${YELLOW}  Choom has no auth of its own — refusing to expose it unprotected.${NC}"
    echo -e "${YELLOW}  Write a basic-auth policy there, or set \$CHOOM_NGROK_POLICY.${NC}"
  else
    echo -e "\n${GREEN}Installing com.choom.ngrok...${NC}"
    render com.choom.ngrok.plist.template com.choom.ngrok.plist
    reload com.choom.ngrok
  fi
fi

cat <<EOF

$(echo -e "${GREEN}Done.${NC}")

Day to day (launchd's equivalents of systemctl --user):

  launchctl kickstart -k gui/\$(id -u)/com.choom.dev    # restart after code/env changes
  launchctl print gui/\$(id -u)/com.choom.dev           # is it running? last exit code?
  tail -f $LOG_DIR/choom-dev.log                        # tail the raw console

  launchctl bootout gui/\$(id -u)/com.choom.dev         # stop and unload

Agents load automatically at login. Run \`sudo caffeinate -d\` or turn off
sleep in System Settings if you need Choom reachable while the Mac idles.
EOF
