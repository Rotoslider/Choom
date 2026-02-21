#!/bin/bash
# Signal Bridge Setup Script
# Run this on your Ubuntu 24.04 Choom server

set -e

echo "=========================================="
echo "Signal Bridge Setup for Choom"
echo "=========================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo -e "${RED}Please do not run as root. Run as your normal user.${NC}"
    exit 1
fi

# Create directories
echo -e "\n${GREEN}Creating directories...${NC}"
mkdir -p ~/.local/share/signal-cli
mkdir -p /tmp/signal-bridge/audio
mkdir -p /tmp/signal-bridge/images
sudo mkdir -p /var/log/signal-bridge
sudo chown $USER:$USER /var/log/signal-bridge

# Install dependencies
echo -e "\n${GREEN}Installing system dependencies...${NC}"
sudo apt update
sudo apt install -y openjdk-21-jre-headless wget unzip python3-pip python3-venv ffmpeg

# Install signal-cli
SIGNAL_CLI_VERSION="0.13.2"
echo -e "\n${GREEN}Installing signal-cli v${SIGNAL_CLI_VERSION}...${NC}"

cd /tmp
wget -q "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-Linux.tar.gz"
sudo tar xf "signal-cli-${SIGNAL_CLI_VERSION}-Linux.tar.gz" -C /opt
sudo ln -sf "/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli" /usr/local/bin/signal-cli
rm "signal-cli-${SIGNAL_CLI_VERSION}-Linux.tar.gz"

echo -e "${GREEN}signal-cli installed at /usr/local/bin/signal-cli${NC}"

# Verify installation
echo -e "\n${GREEN}Verifying signal-cli installation...${NC}"
signal-cli --version

# Create Python virtual environment
echo -e "\n${GREEN}Setting up Python virtual environment...${NC}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo -e "\n${GREEN}Python dependencies installed${NC}"

# Create .env file template
if [ ! -f .env ]; then
    echo -e "\n${GREEN}Creating .env file template...${NC}"
    cat > .env << 'EOF'
# Signal Configuration
SIGNAL_PHONE_NUMBER=+1YOUR_CHOOM_NUMBER
OWNER_PHONE_NUMBER=+1YOUR_PHONE_NUMBER

# signal-cli paths
SIGNAL_CLI_PATH=/usr/local/bin/signal-cli
SIGNAL_CONFIG_PATH=$HOME/.local/share/signal-cli

# Choom API
CHOOM_API_URL=http://localhost:3000

# Service endpoints
STT_ENDPOINT=http://localhost:5000
TTS_ENDPOINT=http://localhost:8004
MEMORY_ENDPOINT=http://localhost:8100

# Ngrok (optional, for external access)
NGROK_URL=https://your-subdomain.ngrok-free.app
NGROK_WEBHOOK_SECRET=

# Default Choom name (must match a Choom in the database)
DEFAULT_CHOOM_NAME=Choom

# Owner name (used in morning briefings)
OWNER_NAME=friend

# Logging
LOG_LEVEL=INFO
EOF
    echo -e "${YELLOW}Please edit .env with your configuration${NC}"
fi

echo -e "\n=========================================="
echo -e "${GREEN}Setup complete!${NC}"
echo -e "=========================================="
echo -e "\n${YELLOW}Next steps:${NC}"
echo -e "1. Link signal-cli to your phone:"
echo -e "   ${GREEN}signal-cli link -n 'Choom Server'${NC}"
echo -e "   (Scan the QR code with Signal on your phone)"
echo -e ""
echo -e "2. Or register a new number (if you have a dedicated number):"
echo -e "   ${GREEN}signal-cli -a +1YOURNUMBER register${NC}"
echo -e ""
echo -e "3. Test signal-cli:"
echo -e "   ${GREEN}signal-cli -a +1YOUR_NUMBER receive${NC}"
echo -e ""
echo -e "4. Edit .env file with your settings"
echo -e ""
echo -e "5. Start the bridge:"
echo -e "   ${GREEN}source venv/bin/activate${NC}"
echo -e "   ${GREEN}python bridge.py${NC}"
echo -e ""
