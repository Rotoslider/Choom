#!/bin/bash
# Generate the locally-trusted certificate that scripts/lan-https-proxy.js
# serves, so the mic works when Choom is opened from another machine on the LAN.
#
#   ./scripts/setup-lan-https.sh
#
# Run this once on the machine that HOSTS Choom (macOS or Linux). It is safe to
# re-run — do that whenever the LAN IP changes, since the IP is baked into the
# certificate.
#
# mkcert does two jobs here: it creates a little certificate authority of your
# own and marks it trusted on THIS machine, then issues a cert for the dev
# server's LAN names signed by it. Other machines need that authority installed
# too; the script prints how when it finishes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CERT_DIR="$APP_DIR/certificates"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

OS="$(uname -s)"

# ---------------------------------------------------------------------------
# 1. mkcert, and the NSS tools it needs to reach Firefox
# ---------------------------------------------------------------------------
# nss/certutil is not optional if you use Firefox: Firefox keeps its own trust
# store and ignores the OS one, and mkcert can only write to it when certutil is
# present. On Linux that goes for Chrome/Chromium too — it reads ~/.pki/nssdb
# rather than the system store.
install_mkcert() {
  case "$OS" in
    Darwin)
      if command -v brew > /dev/null 2>&1; then
        echo -e "${YELLOW}Installing mkcert and nss via Homebrew...${NC}"
        brew install mkcert nss
        return
      fi
      ;;
    Linux)
      if command -v apt-get > /dev/null 2>&1; then
        echo -e "${YELLOW}Installing mkcert and libnss3-tools via apt...${NC}"
        sudo apt-get update && sudo apt-get install -y mkcert libnss3-tools
        return
      elif command -v dnf > /dev/null 2>&1; then
        echo -e "${YELLOW}Installing mkcert and nss-tools via dnf...${NC}"
        sudo dnf install -y mkcert nss-tools
        return
      elif command -v pacman > /dev/null 2>&1; then
        echo -e "${YELLOW}Installing mkcert and nss via pacman...${NC}"
        sudo pacman -S --needed --noconfirm mkcert nss
        return
      fi
      ;;
  esac

  echo -e "${RED}mkcert not found, and no package manager I recognise to install it with.${NC}" >&2
  echo "  See https://github.com/FiloSottile/mkcert#installation" >&2
  exit 1
}

command -v mkcert > /dev/null 2>&1 || install_mkcert

if ! command -v certutil > /dev/null 2>&1; then
  echo -e "${YELLOW}Note: certutil is missing, so Firefox will not pick up the CA.${NC}"
  case "$OS" in
    Darwin) echo -e "${YELLOW}      brew install nss && re-run this script${NC}" ;;
    *)      echo -e "${YELLOW}      sudo apt install libnss3-tools   (or nss-tools / nss) && re-run${NC}" ;;
  esac
fi

# ---------------------------------------------------------------------------
# 2. Trust the CA here, and issue the server certificate
# ---------------------------------------------------------------------------
# Prompts for your password the first time and never again.
echo -e "${GREEN}Trusting the local CA on this machine...${NC}"
mkcert -install

# Names the certificate has to cover. The .local name is mDNS/Bonjour, which
# macOS, Windows and Linux (via avahi) all resolve on a LAN with no DNS setup —
# prefer it over the IP, because DHCP can hand out a different IP later.
HOSTS=(localhost 127.0.0.1 ::1)

case "$OS" in
  Darwin)
    HOSTS+=("$(scutil --get LocalHostName).local")
    LAN_IPS="$( { ipconfig getifaddr en0; ipconfig getifaddr en1; } 2>/dev/null || true )"
    ;;
  *)
    HOSTS+=("$(hostname -s).local")
    # Every global-scope IPv4 the box holds, minus docker/bridge noise.
    LAN_IPS="$(ip -4 -o addr show scope global 2>/dev/null \
      | grep -v -e ' docker' -e ' br-' -e ' virbr' \
      | awk '{print $4}' | cut -d/ -f1 || true)"
    ;;
esac

while read -r ip; do
  [ -n "$ip" ] && HOSTS+=("$ip")
done <<< "$LAN_IPS"

mkdir -p "$CERT_DIR"
echo -e "${GREEN}Issuing certificate for: ${HOSTS[*]}${NC}"
mkcert -cert-file "$CERT_DIR/lan.pem" -key-file "$CERT_DIR/lan-key.pem" "${HOSTS[@]}"
chmod 600 "$CERT_DIR/lan-key.pem"

CAROOT="$(mkcert -CAROOT)"

# ---------------------------------------------------------------------------
# 3. Tell the user how to trust the CA everywhere else
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}Done.${NC} Start the HTTPS front door with:"
echo "    pnpm lan:https"
echo ""
echo "Then, on each OTHER machine that should use the mic, install the CA once."
echo -e "Copy this file over — it is a public certificate, not a secret:"
echo -e "${YELLOW}    $CAROOT/rootCA.pem${NC}"
echo "  (Do NOT copy rootCA-key.pem. That one can mint a certificate for ANY"
echo "   site, for every machine that trusts this CA. It never leaves this box.)"
echo ""
echo "Easiest, on any OS — installing a CA needs no key, so rootCA.pem alone is"
echo "enough, and mkcert covers the OS store AND the browser stores in one shot:"
echo "    sudo apt install mkcert libnss3-tools    # or brew install mkcert nss"
echo "    CAROOT=<dir holding rootCA.pem> mkcert -install"
echo ""
echo "By hand instead:"
echo "  macOS    double-click it, then in Keychain Access set it to Always Trust"
echo "  Windows  double-click > Install Certificate > Local Machine >"
echo "           Place all certificates in: Trusted Root Certification Authorities"
echo "  Firefox  Settings > Privacy & Security > Certificates > View Certificates >"
echo "           Authorities > Import, and tick \"Trust this CA to identify websites\""
echo "           (Firefox ignores the OS store, so do this even on macOS/Windows.)"
echo "  Chrome on Linux   reads ~/.pki/nssdb, NOT the system store:"
echo "           certutil -d sql:\$HOME/.pki/nssdb -A -t \"C,,\" -n choom-lan-ca -i rootCA.pem"
echo "  Linux system store  only helps curl/wget, and update-ca-certificates SKIPS"
echo "           anything not ending in .crt:"
echo "           sudo cp rootCA.pem /usr/local/share/ca-certificates/choom-lan-ca.crt"
echo "           sudo update-ca-certificates"
