"""
Signal Bridge Configuration
"""
import os
from dotenv import load_dotenv

load_dotenv()

# Signal Configuration
# SIGNAL_PHONE_NUMBER is the Choom's number (sends messages)
SIGNAL_PHONE_NUMBER = os.getenv("SIGNAL_PHONE_NUMBER", "+10000000000")
SIGNAL_CLI_PATH = os.getenv("SIGNAL_CLI_PATH", "/usr/local/bin/signal-cli")
SIGNAL_CONFIG_PATH = os.getenv("SIGNAL_CONFIG_PATH", os.path.expanduser("~/.local/share/signal-cli"))

# signal-cli daemon socket (JSON-RPC mode)
SIGNAL_SOCKET_PATH = os.getenv("SIGNAL_SOCKET_PATH", "/run/user/1000/signal-cli/socket")
SIGNAL_DAEMON_CONNECT_TIMEOUT = int(os.getenv("SIGNAL_DAEMON_CONNECT_TIMEOUT", "30"))
SIGNAL_DAEMON_RECONNECT_INTERVAL = int(os.getenv("SIGNAL_DAEMON_RECONNECT_INTERVAL", "5"))

# Your phone number (receives messages from Chooms)
OWNER_PHONE_NUMBER = os.getenv("OWNER_PHONE_NUMBER", "+10000000000")

# Choom API Configuration
CHOOM_API_URL = os.getenv("CHOOM_API_URL", "http://localhost:3000")

# LLM Configuration (Mac Ultra running LM Studio)
LLM_ENDPOINT = os.getenv("LLM_ENDPOINT", "http://localhost:1234/v1")

# Ngrok Configuration
NGROK_WEBHOOK_SECRET = os.getenv("NGROK_WEBHOOK_SECRET", "")
NGROK_URL = os.getenv("NGROK_URL", "https://your-subdomain.ngrok-free.app")

# Service Endpoints (on the Choom server)
STT_ENDPOINT = os.getenv("STT_ENDPOINT", "http://localhost:5000")
TTS_ENDPOINT = os.getenv("TTS_ENDPOINT", "http://localhost:8004")
MEMORY_ENDPOINT = os.getenv("MEMORY_ENDPOINT", "http://localhost:8100")

# Default Choom (used if no name specified)
DEFAULT_CHOOM_NAME = os.getenv("DEFAULT_CHOOM_NAME", "Choom")

# API Keys for external services
BRAVE_API_KEY = os.getenv("BRAVE_API_KEY", "")
OPENWEATHER_API_KEY = os.getenv("OPENWEATHER_API_KEY", "")

# Available Chooms (name -> choomId mapping, populated from database)
CHOOMS = {}

# Heartbeat and Scheduled Task Settings
HEARTBEAT_ENABLED = True

# Weather check times (24-hour format)
WEATHER_CHECK_TIMES = ["07:00", "12:00", "18:00"]

# Aurora forecast check times
AURORA_CHECK_TIMES = ["12:00", "18:00"]

# Morning briefing time
MORNING_BRIEFING_TIME = "07:00"

# System health check interval (minutes)
SYSTEM_HEALTH_INTERVAL = 30

# Paths for temporary files
TEMP_AUDIO_PATH = "/tmp/signal-bridge/audio"
TEMP_IMAGE_PATH = "/tmp/signal-bridge/images"

# Logging
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
LOG_FILE = os.getenv("LOG_FILE", "/var/log/signal-bridge/bridge.log")
