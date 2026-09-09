"""
Signal Bridge Configuration
"""
import glob
import os
import shutil
import sys
import tempfile
from dotenv import load_dotenv

load_dotenv()

_IS_MACOS = sys.platform == "darwin"


def _default_signal_cli_path() -> str:
    """Locate signal-cli, preferring a JVM build over a native-image one.

    Homebrew ships signal-cli as a GraalVM native image built without AWT, so
    every attachment fails with

        Could not initialize class javax.imageio.ImageIO (NoClassDefFoundError)

    and the Choom's message arrives as text with the picture silently missing.
    signal-cli needs ImageIO to build attachment thumbnails. The official JVM
    distribution has it, and both builds read the same account data in
    ~/.local/share/signal-cli, so switching is just a path change.

    Prefer an unpacked JVM distribution, then $PATH, then the usual prefixes.
    Override with $SIGNAL_CLI_PATH.
    """
    jvm_builds = sorted(
        glob.glob(os.path.expanduser("~/.local/opt/signal-cli-*/bin/signal-cli"))
        + glob.glob("/opt/signal-cli-*/bin/signal-cli"),
        reverse=True,
    )
    for candidate in jvm_builds:
        if os.access(candidate, os.X_OK):
            return candidate
    found = shutil.which("signal-cli")
    if found:
        return found
    for candidate in ("/opt/homebrew/bin/signal-cli", "/usr/local/bin/signal-cli"):
        if os.path.exists(candidate):
            return candidate
    return "/usr/local/bin/signal-cli"


def _default_signal_socket_path() -> str:
    """Default JSON-RPC socket path.

    Linux uses the per-user runtime dir (/run/user/$UID); macOS has no such
    thing, so fall back to the per-user temp dir launchd hands us.
    """
    if _IS_MACOS:
        return os.path.join(tempfile.gettempdir(), "signal-cli", "socket")
    return f"/run/user/{os.getuid()}/signal-cli/socket"


def _default_temp_dir(name: str) -> str:
    return os.path.join(tempfile.gettempdir(), "signal-bridge", name)

# Signal Configuration
# SIGNAL_PHONE_NUMBER is the Choom's number (sends messages)
SIGNAL_PHONE_NUMBER = os.getenv("SIGNAL_PHONE_NUMBER", "+10000000000")
SIGNAL_CLI_PATH = os.getenv("SIGNAL_CLI_PATH") or _default_signal_cli_path()
SIGNAL_CONFIG_PATH = os.getenv("SIGNAL_CONFIG_PATH", os.path.expanduser("~/.local/share/signal-cli"))

# signal-cli daemon socket (JSON-RPC mode)
SIGNAL_SOCKET_PATH = os.getenv("SIGNAL_SOCKET_PATH") or _default_signal_socket_path()
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
IMAGE_GEN_ENDPOINT = os.getenv("IMAGE_GEN_ENDPOINT", "http://localhost:7860")

# Default Choom (used if no name specified)
DEFAULT_CHOOM_NAME = os.getenv("DEFAULT_CHOOM_NAME", "Choom")

# API Keys for external services
BRAVE_API_KEY = os.getenv("BRAVE_API_KEY", "")
SERPAPI_KEY = os.getenv("SERPAPI_KEY", "")
OPENWEATHER_API_KEY = os.getenv("OPENWEATHER_API_KEY", "")
SEARXNG_ENDPOINT = os.getenv("SEARXNG_ENDPOINT", "http://localhost:8888")

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
TEMP_AUDIO_PATH = os.getenv("TEMP_AUDIO_PATH") or _default_temp_dir("audio")
TEMP_IMAGE_PATH = os.getenv("TEMP_IMAGE_PATH") or _default_temp_dir("images")

# Logging
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
# Default to a project-relative path so the GUI log viewer can read it
# without needing root access to /var/log. Override via $LOG_FILE if needed.
_DEFAULT_LOG_FILE = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "data", "logs", "bridge.log")
)
LOG_FILE = os.getenv("LOG_FILE", _DEFAULT_LOG_FILE)
