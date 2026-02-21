"""
Bridge Configuration Persistence
Manages bridge-config.json for scheduled tasks, heartbeat settings, etc.
"""
import json
import logging
import os
from datetime import datetime
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

CONFIG_FILE = os.path.join(os.path.dirname(__file__), "bridge-config.json")

DEFAULT_CONFIG = {
    "tasks": {
        "morning_briefing": {"enabled": True, "time": "07:00"},
        "weather_check_07:00": {"enabled": True, "time": "07:00"},
        "weather_check_12:00": {"enabled": True, "time": "12:00"},
        "weather_check_18:00": {"enabled": True, "time": "18:00"},
        "aurora_check_12:00": {"enabled": True, "time": "12:00"},
        "aurora_check_18:00": {"enabled": True, "time": "18:00"},
        "system_health": {"enabled": True, "interval_minutes": 30},
        "yt_download": {"enabled": False, "time": "04:00"},
    },
    "yt_downloader": {
        "max_videos_per_channel": 3,
        "channels": [],
    },
    "heartbeat": {
        "quiet_start": "21:00",
        "quiet_end": "06:00",
    },
}


def load_config() -> Dict[str, Any]:
    """Load bridge config from JSON file, creating with defaults if missing"""
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, "r") as f:
                config = json.load(f)
            # Merge with defaults to pick up any new keys
            merged = _deep_merge(DEFAULT_CONFIG, config)
            return merged
        else:
            save_config(DEFAULT_CONFIG)
            return DEFAULT_CONFIG.copy()
    except Exception as e:
        logger.error(f"Failed to load bridge config: {e}")
        return DEFAULT_CONFIG.copy()


def save_config(config: Dict[str, Any]) -> bool:
    """Save bridge config to JSON file"""
    try:
        with open(CONFIG_FILE, "w") as f:
            json.dump(config, f, indent=2)
        logger.info("Bridge config saved")
        return True
    except Exception as e:
        logger.error(f"Failed to save bridge config: {e}")
        return False


def update_task(task_id: str, updates: Dict[str, Any]) -> bool:
    """Update a specific task's settings"""
    config = load_config()
    if task_id not in config["tasks"]:
        config["tasks"][task_id] = {}
    config["tasks"][task_id].update(updates)
    return save_config(config)


def is_task_enabled(task_id: str) -> bool:
    """Check if a task is enabled"""
    config = load_config()
    task = config.get("tasks", {}).get(task_id, {})
    return task.get("enabled", True)


def is_quiet_period() -> bool:
    """Check if current time is within the heartbeat quiet period"""
    config = load_config()
    heartbeat = config.get("heartbeat", {})
    quiet_start = heartbeat.get("quiet_start", "21:00")
    quiet_end = heartbeat.get("quiet_end", "06:00")

    now = datetime.now()
    current_minutes = now.hour * 60 + now.minute

    start_h, start_m = map(int, quiet_start.split(":"))
    end_h, end_m = map(int, quiet_end.split(":"))
    start_minutes = start_h * 60 + start_m
    end_minutes = end_h * 60 + end_m

    if start_minutes <= end_minutes:
        # Same-day range (e.g., 06:00-18:00)
        return start_minutes <= current_minutes < end_minutes
    else:
        # Overnight range (e.g., 21:00-06:00)
        return current_minutes >= start_minutes or current_minutes < end_minutes


def get_reminders() -> list:
    """Get all pending reminders"""
    config = load_config()
    return config.get("reminders", [])


def add_reminder(reminder_id: str, text: str, remind_at: str) -> bool:
    """Add a reminder to persistent storage"""
    config = load_config()
    if "reminders" not in config:
        config["reminders"] = []
    config["reminders"].append({
        "id": reminder_id,
        "text": text,
        "remind_at": remind_at,
        "created_at": datetime.now().isoformat(),
    })
    return save_config(config)


def remove_reminder(reminder_id: str) -> bool:
    """Remove a reminder from persistent storage"""
    config = load_config()
    reminders = config.get("reminders", [])
    config["reminders"] = [r for r in reminders if r["id"] != reminder_id]
    return save_config(config)


def get_custom_heartbeats() -> list:
    """Get all custom heartbeat tasks"""
    config = load_config()
    return config.get("heartbeat", {}).get("custom_tasks", [])


def save_custom_heartbeats(tasks: list) -> bool:
    """Save custom heartbeat tasks"""
    config = load_config()
    if "heartbeat" not in config:
        config["heartbeat"] = {"quiet_start": "21:00", "quiet_end": "06:00"}
    config["heartbeat"]["custom_tasks"] = tasks
    return save_config(config)


def _deep_merge(base: dict, override: dict) -> dict:
    """Deep merge override into base, returning new dict"""
    result = base.copy()
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result
