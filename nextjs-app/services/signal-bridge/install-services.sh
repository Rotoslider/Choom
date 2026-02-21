#!/bin/bash
# Install systemd services for Signal Bridge, signal-cli daemon, and Ngrok

set -e

echo "Installing systemd services..."

# Copy service files
sudo cp systemd/signal-cli-daemon.service /etc/systemd/system/
sudo cp systemd/signal-bridge.service /etc/systemd/system/
sudo cp systemd/ngrok.service /etc/systemd/system/

# Reload systemd
sudo systemctl daemon-reload

# Enable services (start on boot)
sudo systemctl enable signal-cli-daemon.service
sudo systemctl enable signal-bridge.service
sudo systemctl enable ngrok.service

echo ""
echo "Services installed!"
echo ""
echo "Commands:"
echo "  Start daemon:         sudo systemctl start signal-cli-daemon"
echo "  Stop daemon:          sudo systemctl stop signal-cli-daemon"
echo "  View daemon logs:     journalctl -u signal-cli-daemon -f"
echo ""
echo "  Start Signal Bridge:  sudo systemctl start signal-bridge"
echo "  Stop Signal Bridge:   sudo systemctl stop signal-bridge"
echo "  View logs:            journalctl -u signal-bridge -f"
echo ""
echo "  Start Ngrok:          sudo systemctl start ngrok"
echo "  Stop Ngrok:           sudo systemctl stop ngrok"
echo "  View logs:            journalctl -u ngrok -f"
echo ""
echo "Note: signal-bridge depends on signal-cli-daemon."
echo "Starting signal-bridge will auto-start the daemon."
echo ""
