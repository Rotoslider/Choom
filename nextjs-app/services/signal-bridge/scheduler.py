"""
Scheduler Service
Handles heartbeats, cron jobs, and scheduled tasks
"""
import logging
import os
from datetime import datetime, timedelta
from typing import Callable, Optional, Dict, Any, List
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
import requests

import config
from signal_handler import get_signal_handler
from choom_client import get_choom_client, get_tts_client
from google_client import get_google_client
from task_config import load_config as load_task_config, save_config as save_task_config, is_task_enabled, is_quiet_period, get_custom_heartbeats

logger = logging.getLogger(__name__)


class ScheduledTaskManager:
    """Manages scheduled tasks, heartbeats, and cron jobs"""

    def __init__(self):
        self.scheduler = BackgroundScheduler(timezone='America/Denver')
        self.signal = get_signal_handler()
        self.choom = get_choom_client()
        self.tts = get_tts_client()
        self.owner_phone = config.OWNER_PHONE_NUMBER
        self.default_choom = config.DEFAULT_CHOOM_NAME

    def start(self):
        """Start the scheduler"""
        self._setup_default_tasks()
        self.scheduler.start()
        logger.info("Scheduler started")

    def stop(self):
        """Stop the scheduler"""
        self.scheduler.shutdown()
        logger.info("Scheduler stopped")

    def _setup_default_tasks(self):
        """Set up default scheduled tasks based on bridge config"""
        task_config = load_task_config()
        tasks = task_config.get("tasks", {})

        # Morning briefing
        mb = tasks.get("morning_briefing", {})
        if mb.get("enabled", True):
            mb_time = mb.get("time", "07:00")
            hour, minute = map(int, mb_time.split(':'))
            self.add_cron_task(
                "morning_briefing",
                self._morning_briefing,
                hour=hour,
                minute=minute
            )

        # Weather checks
        for time_str in config.WEATHER_CHECK_TIMES:
            task_id = f"weather_check_{time_str}"
            wc = tasks.get(task_id, {})
            if wc.get("enabled", True):
                t = wc.get("time", time_str)
                hour, minute = map(int, t.split(':'))
                self.add_cron_task(
                    task_id,
                    self._weather_check,
                    hour=hour,
                    minute=minute
                )

        # Aurora forecast checks
        for time_str in config.AURORA_CHECK_TIMES:
            task_id = f"aurora_check_{time_str}"
            ac = tasks.get(task_id, {})
            if ac.get("enabled", True):
                t = ac.get("time", time_str)
                hour, minute = map(int, t.split(':'))
                self.add_cron_task(
                    task_id,
                    self._aurora_check,
                    hour=hour,
                    minute=minute
                )

        # System health check
        sh = tasks.get("system_health", {})
        if sh.get("enabled", True):
            interval = sh.get("interval_minutes", config.SYSTEM_HEALTH_INTERVAL)
            self.add_interval_task(
                "system_health",
                self._system_health_check,
                minutes=interval
            )

        # Daily database backup to Google Drive
        db_backup = tasks.get("db_backup", {})
        if db_backup.get("enabled", True):
            backup_time = db_backup.get("time", "03:00")
            hour, minute = map(int, backup_time.split(':'))
            self.add_cron_task(
                "db_backup",
                self._backup_databases,
                hour=hour,
                minute=minute
            )

        # Goal review — Aloy reviews goals and delegates tasks
        gr = tasks.get("goal_review", {})
        if gr.get("enabled", False):
            gr_time = gr.get("time", "09:00")
            hour, minute = map(int, gr_time.split(':'))
            self.add_cron_task(
                "goal_review",
                self._goal_review,
                hour=hour,
                minute=minute
            )

        # YouTube Music download
        yt_dl = tasks.get("yt_download", {})
        if yt_dl.get("enabled", False):
            yt_time = yt_dl.get("time", "04:00")
            hour, minute = map(int, yt_time.split(':'))
            self.add_cron_task(
                "yt_download",
                self._yt_download,
                hour=hour,
                minute=minute
            )

        # Restore pending reminders from config
        self._restore_reminders()

        # Poll for web-created reminders every 60 seconds
        self.add_interval_task(
            "check_new_reminders",
            self._check_new_reminders,
            seconds=60
        )

        # Poll for queued notifications every 15 seconds
        self.add_interval_task(
            "check_notifications",
            self._check_notifications,
            seconds=15
        )

        # Set up custom heartbeats
        self._setup_custom_heartbeats()

        # Poll for custom heartbeat config changes every 60 seconds
        self.add_interval_task(
            "reload_custom_heartbeats",
            self._reload_custom_heartbeats,
            seconds=60
        )

        # Set up skill-based automations
        self._setup_automations()

        # Poll for automation config changes every 60 seconds
        self.add_interval_task(
            "reload_automations",
            self._reload_automations,
            seconds=60
        )

        # Reload cron task schedules from config every 60 seconds
        self.add_interval_task(
            "reload_cron_tasks",
            self._reload_cron_tasks,
            seconds=60
        )

        # Signal account keepalive — refresh account with Signal's servers
        # every 6 hours to prevent "open Signal on your phone" warning.
        # Uses updateAccount (not sendSyncRequest) to actually reset the
        # server-side inactivity timer. Signal expires after ~30 days idle.
        self.add_interval_task(
            "signal_account_keepalive",
            self._signal_account_keepalive,
            hours=6
        )

        # Poll for manual triggers from the web GUI (every 10s)
        self.add_interval_task('trigger_poll', self._check_triggers, seconds=10)

        logger.info("Default scheduled tasks configured from bridge config")

    def add_cron_task(self, task_id: str, func: Callable, **cron_kwargs):
        """Add a cron-scheduled task"""
        self.scheduler.add_job(
            func,
            CronTrigger(**cron_kwargs),
            id=task_id,
            replace_existing=True
        )
        logger.info(f"Added cron task: {task_id}")

    def add_interval_task(self, task_id: str, func: Callable, **interval_kwargs):
        """Add an interval-scheduled task"""
        self.scheduler.add_job(
            func,
            IntervalTrigger(**interval_kwargs),
            id=task_id,
            replace_existing=True
        )
        logger.info(f"Added interval task: {task_id}")

    def add_one_time_task(self, task_id: str, func: Callable, run_at: datetime):
        """Add a one-time task"""
        self.scheduler.add_job(
            func,
            'date',
            run_date=run_at,
            id=task_id,
            replace_existing=True
        )
        logger.info(f"Added one-time task: {task_id} at {run_at}")

    def remove_task(self, task_id: str):
        """Remove a scheduled task"""
        try:
            self.scheduler.remove_job(task_id)
            logger.info(f"Removed task: {task_id}")
        except Exception as e:
            logger.warning(f"Failed to remove task {task_id}: {e}")

    def send_message_to_owner(self, message: str, include_audio: bool = True, choom_name: str = None):
        """
        Send a message to the owner via Signal

        Args:
            message: Text message to send
            include_audio: Whether to also send as voice note
            choom_name: Optional Choom name to attribute message to
        """
        try:
            attachments = []

            # Get the Choom's voice_id if available
            voice_id = "sophie"  # default
            if choom_name:
                choom = self.choom.get_choom_by_name(choom_name)
                if choom and choom.voice_id:
                    voice_id = choom.voice_id

            # Generate audio if requested
            if include_audio and message:
                # Strip markdown for TTS
                import re
                tts_text = re.sub(r'[*_~`#]+', '', message)
                # Strip emojis
                tts_text = re.sub(r'[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF\U0001F1E0-\U0001F1FF\U00002600-\U000026FF\U00002700-\U000027BF\U0000FE00-\U0000FE0F\U0001F900-\U0001F9FF\U0001FA00-\U0001FA6F\U0001FA70-\U0001FAFF\U0000200D\U000020E3\U000E0020-\U000E007F]+', '', tts_text)
                tts_text = re.sub(r'\s+', ' ', tts_text).strip()

                audio_path = f"{config.TEMP_AUDIO_PATH}/scheduled_{datetime.now().strftime('%Y%m%d_%H%M%S')}.wav"
                if self.tts.synthesize(tts_text, voice=voice_id, output_path=audio_path):
                    attachments.append(audio_path)

            # Format message with Choom attribution
            if choom_name:
                formatted_message = f"[{choom_name}]\n\n{message}"
            else:
                formatted_message = message

            # Send via Signal
            self.signal.send_message(
                self.owner_phone,
                formatted_message,
                attachments=attachments if attachments else None
            )

            logger.info(f"Sent scheduled message to owner")

        except Exception as e:
            logger.error(f"Failed to send scheduled message: {e}")

    def _restore_reminders(self):
        """Restore pending reminders from bridge-config.json after restart"""
        from task_config import get_reminders, remove_reminder
        reminders = get_reminders()
        now = datetime.now()
        restored = 0

        for r in reminders:
            try:
                remind_at = datetime.fromisoformat(r["remind_at"])
                if remind_at <= now:
                    # Expired while bridge was down — fire immediately
                    self.send_message_to_owner(
                        f"Reminder (delayed): {r['text']}",
                        include_audio=True,
                        choom_name=config.DEFAULT_CHOOM_NAME
                    )
                    remove_reminder(r["id"])
                else:
                    # Re-schedule
                    task_id = r["id"]
                    reminder_text = r["text"]

                    def send_reminder(tid=task_id, txt=reminder_text):
                        self.send_message_to_owner(
                            f"Reminder: {txt}",
                            include_audio=True,
                            choom_name=config.DEFAULT_CHOOM_NAME
                        )
                        remove_reminder(tid)

                    self.add_one_time_task(task_id, send_reminder, remind_at)
                    restored += 1
            except Exception as e:
                logger.warning(f"Failed to restore reminder {r.get('id')}: {e}")
                remove_reminder(r.get("id", ""))

        if restored:
            logger.info(f"Restored {restored} pending reminders from config")

    def _check_new_reminders(self):
        """Poll for web-created reminders and schedule them"""
        from task_config import get_reminders, remove_reminder
        reminders = get_reminders()
        now = datetime.now()

        for r in reminders:
            task_id = r.get("id", "")
            if not task_id:
                continue

            # Skip if already scheduled
            try:
                existing = self.scheduler.get_job(task_id)
                if existing:
                    continue
            except Exception:
                pass

            try:
                remind_at = datetime.fromisoformat(r["remind_at"].replace("Z", "+00:00"))
                # Convert to naive local time if timezone-aware
                if remind_at.tzinfo is not None:
                    import time as _time
                    utc_ts = remind_at.timestamp()
                    remind_at = datetime.fromtimestamp(utc_ts)

                if remind_at <= now:
                    # Past due — fire immediately
                    logger.info(f"Firing past-due web reminder: {task_id}")
                    self.send_message_to_owner(
                        f"Reminder: {r['text']}",
                        include_audio=True,
                        choom_name=config.DEFAULT_CHOOM_NAME
                    )
                    remove_reminder(task_id)
                else:
                    # Schedule for the future
                    reminder_text = r["text"]

                    def send_reminder(tid=task_id, txt=reminder_text):
                        self.send_message_to_owner(
                            f"Reminder: {txt}",
                            include_audio=True,
                            choom_name=config.DEFAULT_CHOOM_NAME
                        )
                        remove_reminder(tid)

                    self.add_one_time_task(task_id, send_reminder, remind_at)
                    logger.info(f"Scheduled web reminder: {task_id} at {remind_at}")
            except Exception as e:
                logger.warning(f"Failed to process web reminder {task_id}: {e}")

    def _check_notifications(self):
        """Poll for queued notifications from the web app and deliver via Signal.
        NOTE: Notifications are user-initiated (via LLM tool call), so they are
        delivered regardless of quiet period. Quiet period only suppresses
        heartbeats and system alerts."""
        try:
            base_url = config.CHOOM_BASE_URL if hasattr(config, 'CHOOM_BASE_URL') else 'http://localhost:3000'
            res = requests.get(f"{base_url}/api/notifications", timeout=5)
            if res.status_code != 200:
                return

            notifications = res.json()
            if not notifications:
                return

            delivered_ids = []
            for notif in notifications:
                try:
                    choom_id = notif.get("choomId", "")
                    message = notif.get("message", "")
                    include_audio = notif.get("includeAudio", True)
                    images = notif.get("images", [])  # Resolved by API: [{id, url}]
                    file_paths = notif.get("filePaths", [])  # Absolute workspace paths

                    if not message and not images and not file_paths:
                        delivered_ids.append(notif["id"])
                        continue

                    # Try to get choom name for attribution
                    choom_name = self.default_choom
                    try:
                        choom_data = self.choom.get_choom_by_id(choom_id)
                        if choom_data and hasattr(choom_data, 'name'):
                            choom_name = choom_data.name
                    except Exception:
                        pass

                    # Send text + audio first
                    if message:
                        self.send_message_to_owner(
                            message,
                            include_audio=include_audio,
                            choom_name=choom_name
                        )

                    # Send attached images via Signal
                    if images:
                        self._send_notification_images(images, choom_name)

                    # Send attached workspace files via Signal
                    if file_paths:
                        self._send_notification_files(file_paths, choom_name)

                    delivered_ids.append(notif["id"])
                    logger.info(f"Delivered notification {notif['id']}: {message[:50]}... (images: {len(images)}, files: {len(file_paths)})")

                except Exception as e:
                    logger.warning(f"Failed to deliver notification {notif.get('id')}: {e}")

            # Mark as delivered
            if delivered_ids:
                try:
                    requests.delete(
                        f"{base_url}/api/notifications",
                        json={"ids": delivered_ids},
                        timeout=5
                    )
                except Exception as e:
                    logger.warning(f"Failed to mark notifications delivered: {e}")

        except Exception as e:
            # Don't spam logs on connection errors
            if "Connection refused" not in str(e):
                logger.warning(f"Notification check failed: {e}")

    def _send_notification_images(self, images: list, choom_name: str = None):
        """Decode and send notification images via Signal.

        Args:
            images: List of {id, url} dicts where url is base64 data URI
            choom_name: Choom name for logging
        """
        import base64
        import time

        for i, img in enumerate(images):
            img_url = img.get("url", "")
            if not img_url or not img_url.startswith("data:image"):
                logger.warning(f"Notification image {i}: unexpected format, skipping")
                continue

            try:
                base64_data = img_url.split(",")[1] if "," in img_url else img_url
                decoded = base64.b64decode(base64_data)
                img_path = f"{config.TEMP_IMAGE_PATH}/notif_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{i}.png"

                with open(img_path, "wb") as f:
                    f.write(decoded)

                time.sleep(1)  # Small delay between messages for signal-cli
                self.signal.send_message(
                    self.owner_phone,
                    "",  # Empty message — just the image
                    attachments=[img_path]
                )
                logger.info(f"Sent notification image {i} ({len(decoded)} bytes) for {choom_name}")

                # Clean up temp file
                try:
                    import os
                    os.remove(img_path)
                except Exception:
                    pass

            except Exception as e:
                logger.error(f"Failed to send notification image {i}: {e}")

    def _send_notification_files(self, file_paths: list, choom_name: str = None):
        """Send workspace file attachments via Signal.

        Args:
            file_paths: List of absolute file paths (validated by API at creation time)
            choom_name: Choom name for logging
        """
        import time

        for i, fpath in enumerate(file_paths):
            if not isinstance(fpath, str) or not fpath.strip():
                continue

            if not os.path.exists(fpath):
                logger.warning(f"Notification file {i} not found: {fpath}")
                continue

            try:
                file_size = os.path.getsize(fpath)
                file_name = os.path.basename(fpath)
                time.sleep(1)  # Small delay between messages for signal-cli
                self.signal.send_message(
                    self.owner_phone,
                    "",  # Empty message — just the file
                    attachments=[fpath]
                )
                logger.info(f"Sent notification file: {file_name} ({file_size:,} bytes) for {choom_name}")
            except Exception as e:
                logger.error(f"Failed to send notification file {i} ({fpath}): {e}")

    # =========================================================================
    # Default Task Implementations
    # =========================================================================

    def _morning_briefing(self):
        """Send morning briefing with calendar, tasks, and reminders"""
        logger.info("Running morning briefing")

        try:
            # Fetch REAL weather data BEFORE sending to LLM
            weather_text = "Weather data unavailable."
            try:
                weather_data = self.choom.get_weather()
                weather = weather_data.get('weather', {})
                if weather:
                    temp = weather.get('temperature', 'N/A')
                    desc = weather.get('description', 'N/A')
                    wind = weather.get('windSpeed', 'N/A')
                    humidity = weather.get('humidity', 'N/A')
                    feels_like = weather.get('feelsLike', 'N/A')
                    location = weather.get('location', 'your area')
                    weather_text = f"Location: {location}. Conditions: {desc}, Temperature: {temp}°F (feels like {feels_like}°F), Wind: {wind} mph, Humidity: {humidity}%."
            except Exception as e:
                logger.warning(f"Could not fetch weather for briefing: {e}")

            # Fetch REAL calendar events BEFORE sending to LLM
            calendar_text = "No events on the calendar today."
            try:
                google = get_google_client()
                events = google.get_todays_events()
                if events:
                    event_lines = []
                    for e in events:
                        start = e.get('start', '')
                        summary = e.get('summary', 'Untitled')
                        event_lines.append(f"- {summary} ({start})" if start else f"- {summary}")
                    calendar_text = "Today's events:\n" + "\n".join(event_lines)
            except Exception as e:
                logger.warning(f"Could not fetch calendar: {e}")

            # Fetch today's reminders
            reminders_text = "No reminders set for today."
            try:
                from task_config import get_reminders
                reminders = get_reminders()
                today = datetime.now().strftime('%Y-%m-%d')
                today_reminders = [r for r in reminders if r.get('remind_at', '').startswith(today)]
                if today_reminders:
                    reminder_lines = []
                    for r in today_reminders:
                        try:
                            t = datetime.fromisoformat(r['remind_at'].replace('Z', '+00:00'))
                            time_str = t.strftime('%I:%M %p')
                        except Exception:
                            time_str = 'sometime today'
                        reminder_lines.append(f"- {r['text']} ({time_str})")
                    reminders_text = "Today's reminders:\n" + "\n".join(reminder_lines)
            except Exception as e:
                logger.warning(f"Could not fetch reminders for briefing: {e}")

            # Fetch goals from memory server
            goals_text = ""
            try:
                import requests as req_lib
                memory_endpoint = config.MEMORY_ENDPOINT
                # Search for memories tagged with "goal"
                goal_res = req_lib.post(f"{memory_endpoint}/memory/search_by_tags", json={
                    "tags": "goal",
                    "limit": 20,
                }, timeout=10)
                if goal_res.ok:
                    goal_data = goal_res.json()
                    goals = goal_data.get("data", [])
                    if goals:
                        goal_lines = []
                        for g in goals:
                            title = g.get("title", "")
                            content = g.get("content", "")
                            tags = g.get("tags", [])
                            if isinstance(tags, list):
                                tags = [t for t in tags if t.lower() != "goal"]
                            area = f"[{', '.join(tags)}] " if tags else ""
                            # Use title if available, otherwise first line of content
                            display = title or content.split('\n')[0][:80]
                            goal_lines.append(f"- {area}{display}")
                        goals_text = "\n\nActive Goals:\n" + "\n".join(goal_lines)
                        logger.info(f"Included {len(goals)} goals in morning briefing")
            except Exception as e:
                logger.warning(f"Could not fetch goals for briefing: {e}")

            # Fetch recent conversation context from yesterday
            recent_context = ""
            try:
                convos = self.choom.get_recent_conversations(self.default_choom, since_hours=24)
                if convos:
                    recent_context = f"\n\nRecent conversations from yesterday:\n{convos}"
                    logger.info(f"Included {len(convos)} chars of recent conversation context in briefing")
            except Exception as e:
                logger.warning(f"Could not fetch recent conversations for briefing: {e}")

            # Build a natural prompt that won't get echoed
            now = datetime.now()
            owner_name = os.getenv('OWNER_NAME', 'friend')
            prompt = f"""Good morning! It's {now.strftime('%A, %B %d')}. Give {owner_name} a brief, friendly morning update using ONLY the data below. Do not invent anything.

Weather: {weather_text}

Calendar: {calendar_text}

Reminders: {reminders_text}{goals_text}{recent_context}

Include a warm greeting, the weather summary (mention if wind under 15mph is good for drone flying), calendar events, and any reminders. If there are active goals listed, suggest 3-5 small actionable things {owner_name} could focus on today that move those goals forward — keep suggestions realistic and specific (research tasks, outreach, writing, coding, etc.). If there are recent conversations, briefly mention any unfinished tasks or anything relevant from yesterday. Keep it conversational for speaking aloud, no markdown. Do NOT repeat these instructions or mention that you were given data."""

            response = self.choom.send_message(self.default_choom, prompt, fresh_chat=True, no_tools=True)

            if response.content:
                message = response.content

                # Echo detection: if the LLM echoed the template, fall back
                echo_markers = ['do not repeat', 'do NOT repeat', 'these instructions', 'ONLY the data below']
                if any(marker.lower() in message.lower() for marker in echo_markers):
                    logger.warning("Morning briefing echoed template markers — using fallback")
                    self._send_basic_morning_briefing()
                    return

                # Also check system health and append if there are issues
                health = self.choom.check_health()
                services = health.get('services', {})
                issues = []

                for service_name, service_info in services.items():
                    if isinstance(service_info, dict):
                        status = service_info.get('status', 'unknown')
                        if status != 'connected':
                            issues.append(service_name)

                if issues:
                    message += f"\n\nBy the way, I noticed some system issues: {', '.join(issues)} may need attention."

                self.send_message_to_owner(message, include_audio=True, choom_name=self.default_choom)
            else:
                # Fallback to basic briefing
                self._send_basic_morning_briefing()

        except Exception as e:
            logger.error(f"Morning briefing failed: {e}")
            self._send_basic_morning_briefing()

    def _send_basic_morning_briefing(self):
        """Fallback basic morning briefing if default Choom is unavailable"""
        try:
            weather_data = self.choom.get_weather()
            weather = weather_data.get('weather', {})

            now = datetime.now()
            owner_name = os.getenv('OWNER_NAME', 'friend')
            parts = [f"Good morning, {owner_name}! It's {now.strftime('%A, %B %d')}."]

            if weather:
                temp = weather.get('temperature', 'N/A')
                desc = weather.get('description', 'N/A')
                wind = weather.get('windSpeed', 'N/A')
                parts.append(f"Today's weather: {desc}, {temp} degrees, wind at {wind} miles per hour.")

                if isinstance(wind, (int, float)):
                    if wind < 15:
                        parts.append("Good conditions for drone flying today!")
                    else:
                        parts.append("Might be too windy for drones today.")

            briefing = " ".join(parts)
            self.send_message_to_owner(briefing, include_audio=True, choom_name=self.default_choom)

        except Exception as e:
            logger.error(f"Basic morning briefing also failed: {e}")

    def _goal_review(self):
        """Aloy reviews goals and autonomously delegates tasks to other Chooms"""
        logger.info("Running goal review")

        try:
            # Find the orchestrator Choom (Aloy by default, configurable)
            task_config = load_task_config()
            goal_cfg = task_config.get("tasks", {}).get("goal_review", {})
            orchestrator = goal_cfg.get("choom_name", "Aloy")

            # Check if the orchestrator Choom exists
            choom = self.choom.get_choom_by_name(orchestrator)
            if not choom:
                logger.warning(f"Goal review orchestrator '{orchestrator}' not found — skipping")
                return

            # Fetch goals from memory server
            import requests as req_lib
            memory_endpoint = config.MEMORY_ENDPOINT
            goal_res = req_lib.post(f"{memory_endpoint}/memory/search_by_tags", json={
                "tags": "goal",
                "limit": 20,
            }, timeout=10)

            if not goal_res.ok or not goal_res.json().get("data"):
                logger.info("No goals found in memory — skipping goal review")
                return

            goals = goal_res.json()["data"]

            # Filter out completed goals (tagged "completed", "done", or content indicates completion)
            completed_tags = {"completed", "done", "finished", "achieved"}
            active_goals = []
            for g in goals:
                tags = g.get("tags", [])
                if isinstance(tags, list):
                    tag_set = {t.lower() for t in tags}
                    if tag_set & completed_tags:
                        continue  # Skip completed goals
                active_goals.append(g)

            if not active_goals:
                logger.info("All goals are completed — skipping goal review")
                return

            # Fetch recent goal-progress memories to avoid re-delegating same work
            recent_progress = ""
            try:
                progress_res = req_lib.post(f"{memory_endpoint}/memory/search_by_tags", json={
                    "tags": "goal-progress",
                    "limit": 10,
                }, timeout=10)
                if progress_res.ok and progress_res.json().get("data"):
                    progress_entries = progress_res.json()["data"]
                    progress_lines = []
                    for p in progress_entries[:10]:
                        p_title = p.get("title", "")
                        p_content = p.get("content", "")
                        p_display = p_title or p_content.split('\n')[0][:150]
                        progress_lines.append(f"- {p_display}")
                    if progress_lines:
                        recent_progress = "\n## Recent Goal Progress (already done — do NOT repeat)\n" + "\n".join(progress_lines)
            except Exception as e:
                logger.warning(f"Failed to fetch recent goal progress: {e}")

            goal_lines = []
            for g in active_goals:
                title = g.get("title", "")
                content = g.get("content", "")
                tags = g.get("tags", [])
                importance = g.get("importance", 5)
                if isinstance(tags, list):
                    tags = [t for t in tags if t.lower() != "goal"]
                area = f"[{', '.join(tags)}] " if tags else ""
                display = title or content.split('\n')[0][:100]
                detail = content if content != title else ""
                goal_lines.append(f"- {area}{display} (importance: {importance}){': ' + detail[:150] if detail else ''}")

            goals_block = "\n".join(goal_lines)
            now = datetime.now()

            prompt = f"""It's {now.strftime('%A, %B %d at %I:%M %p')}. You are reviewing the owner's goals to see if there's anything you can work on autonomously right now.

## Active Goals (not yet completed)
{goals_block}
{recent_progress}

## Your Task
1. First, use search_memories to check what work has been done recently on these goals (search for "goal progress" or specific goal topics)
2. SKIP any goal that already has recent progress entries above — do NOT re-delegate the same research or task
3. Pick 1-3 NEW tasks that can be completed RIGHT NOW using available tools — prioritize by importance
4. For each task, decide the best approach:
   - **Research tasks** (finding information, papers, repos, contacts, resources) → delegate to Genesis
   - **Coding tasks** (writing scripts, building tools, analyzing data) → delegate to Anya
   - **Writing/analysis** (drafting documents, plans, outreach emails) → handle yourself
   - **Nothing actionable right now** → that's fine, just log that you reviewed and nothing needed attention
5. After completing or delegating tasks, use the remember tool to log what was done (tag: "goal-progress")
6. If a goal is fully completed, use remember to update it with tags including "completed" so it won't appear in future reviews

Be practical. Only work on things that can actually be accomplished with the tools available. Don't repeat work that was already done. Don't force work if nothing needs attention. Quality over quantity."""

            # Send to orchestrator with tools enabled and higher iteration limit
            # Goal review involves delegation chains that need many iterations
            response = self.choom.send_message(orchestrator, prompt, fresh_chat=True, max_iterations=100)

            if response.content:
                # Send a summary to the owner via Signal
                summary = response.content
                # Only notify if actual work was done (not just "nothing to do")
                nothing_phrases = ["nothing needs attention", "no tasks to work on", "nothing actionable", "no immediate tasks"]
                if not any(phrase in summary.lower() for phrase in nothing_phrases):
                    self.send_message_to_owner(
                        f"Goal review completed:\n\n{summary}",
                        include_audio=False,
                        choom_name=orchestrator
                    )
                    logger.info(f"Goal review completed with action taken — notified owner")
                else:
                    logger.info("Goal review completed — no action needed")
            else:
                logger.warning("Goal review returned empty response")

        except Exception as e:
            logger.error(f"Goal review failed: {e}")

    def _weather_check(self):
        """Periodic weather check"""
        logger.info("Running weather check")

        try:
            weather_data = self.choom.get_weather()
            weather = weather_data.get('weather', {})

            if weather:
                temp = weather.get('temperature', 'N/A')
                desc = weather.get('description', 'N/A')
                wind = weather.get('windSpeed', 'N/A')

                now = datetime.now()
                time_of_day = "morning" if now.hour < 12 else "afternoon" if now.hour < 17 else "evening"

                message = f"Weather update ({time_of_day}): {desc}, {temp}°F, wind {wind} mph"

                # Only send if there's notable weather
                # For now, always send - can add conditions later
                # self.send_message_to_owner(message, include_audio=False, choom_name=self.default_choom)

                logger.info(f"Weather check: {message}")
            else:
                logger.warning("Weather check: no data received")

        except Exception as e:
            logger.error(f"Weather check failed: {e}")

    def _aurora_check(self):
        """Check aurora forecast with NOAA images"""
        logger.info("Running aurora forecast check")

        try:
            import urllib.request
            import os
            from pathlib import Path

            # NOAA Space Weather Prediction Center images
            aurora_urls = {
                'forecast': 'https://services.swpc.noaa.gov/images/aurora-forecast-northern-hemisphere.jpg',
                'kp_index': 'https://services.swpc.noaa.gov/images/station-k-index.png',
            }

            # Download images
            temp_dir = Path(config.TEMP_IMAGE_PATH)
            temp_dir.mkdir(parents=True, exist_ok=True)
            attachments = []

            for name, url in aurora_urls.items():
                try:
                    img_path = temp_dir / f"aurora_{name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.{'jpg' if 'jpg' in url else 'png'}"
                    urllib.request.urlretrieve(url, str(img_path))
                    attachments.append(str(img_path))
                    logger.info(f"Downloaded aurora image: {name}")
                except Exception as e:
                    logger.warning(f"Failed to download {name}: {e}")

            # Build message
            now = datetime.now()
            time_of_day = "noon" if now.hour < 15 else "evening"

            message = f"Aurora forecast update ({time_of_day}):\n\n"
            message += "Attached: Northern hemisphere aurora forecast and Kp index.\n\n"
            message += "The forecast image shows predicted aurora visibility. "
            message += "Green/yellow areas have best viewing chances. "
            message += "Kp index of 5+ means possible visibility at lower latitudes."

            # Send with images
            if attachments:
                self.signal.send_message(
                    self.owner_phone,
                    f"[{self.default_choom}]\n\n{message}",
                    attachments=attachments
                )
                logger.info(f"Sent aurora update with {len(attachments)} images")

                # Generate audio summary
                audio_path = f"{config.TEMP_AUDIO_PATH}/aurora_{datetime.now().strftime('%Y%m%d_%H%M%S')}.wav"

                # Get Choom voice
                voice_id = "sophie"
                choom = self.choom.get_choom_by_name(self.default_choom)
                if choom and choom.voice_id:
                    voice_id = choom.voice_id

                tts_message = f"Aurora forecast update. I've sent you the current northern hemisphere forecast and Kp index images. Check them to see if there's any aurora activity expected."
                if self.tts.synthesize(tts_message, voice=voice_id, output_path=audio_path):
                    self.signal.send_message(self.owner_phone, "", attachments=[audio_path])
                    try:
                        os.remove(audio_path)
                    except:
                        pass

                # Clean up images
                for path in attachments:
                    try:
                        os.remove(path)
                    except:
                        pass
            else:
                logger.warning("No aurora images downloaded")

        except Exception as e:
            logger.error(f"Aurora check failed: {e}")

    # =========================================================================
    # Custom Heartbeats
    # =========================================================================

    def _setup_custom_heartbeats(self):
        """Set up custom heartbeat tasks from bridge config.
        Staggers start times by 30s per task to prevent checkpoint race conditions
        when multiple heartbeats fire simultaneously and try to generate images."""
        custom_tasks = get_custom_heartbeats()
        setup_count = 0

        for idx, task in enumerate(custom_tasks):
            if not task.get("enabled", False):
                continue

            task_id = task.get("id", "")
            choom_name = task.get("choom_name", "")
            interval = max(5, task.get("interval_minutes", 60))
            prompt = task.get("prompt", "")
            respect_quiet = task.get("respect_quiet", True)

            if not task_id or not choom_name or not prompt:
                continue

            def run_custom_heartbeat(
                tid=task_id, cn=choom_name, p=prompt, rq=respect_quiet
            ):
                self._execute_custom_heartbeat(tid, cn, p, rq)

            # Stagger start times: each heartbeat starts 30s after the previous one
            stagger_seconds = setup_count * 30
            start_time = datetime.now() + timedelta(minutes=interval, seconds=stagger_seconds)
            self.scheduler.add_job(
                run_custom_heartbeat,
                IntervalTrigger(minutes=interval, start_date=start_time),
                id=task_id,
                replace_existing=True
            )
            setup_count += 1
            logger.info(f"Custom heartbeat: {task_id} -> {choom_name} every {interval}min (stagger +{stagger_seconds}s)")

        if setup_count:
            logger.info(f"Set up {setup_count} custom heartbeats (staggered by 30s each)")

    def _reload_custom_heartbeats(self):
        """Check for config changes and update custom heartbeat schedules"""
        custom_tasks = get_custom_heartbeats()
        current_ids = set()

        for task in custom_tasks:
            task_id = task.get("id", "")
            if not task_id:
                continue
            current_ids.add(task_id)

            if not task.get("enabled", False):
                # Remove if disabled
                try:
                    self.scheduler.get_job(task_id)
                    self.remove_task(task_id)
                    logger.info(f"Disabled custom heartbeat: {task_id}")
                except Exception:
                    pass
                continue

            choom_name = task.get("choom_name", "")
            interval = max(5, task.get("interval_minutes", 60))
            prompt = task.get("prompt", "")
            respect_quiet = task.get("respect_quiet", True)

            if not choom_name or not prompt:
                continue

            # Check if job already exists with same interval
            try:
                existing = self.scheduler.get_job(task_id)
                if existing:
                    # Job exists — only reschedule if interval changed
                    continue
            except Exception:
                pass

            # New or needs scheduling
            def run_custom_heartbeat(
                tid=task_id, cn=choom_name, p=prompt, rq=respect_quiet
            ):
                self._execute_custom_heartbeat(tid, cn, p, rq)

            self.add_interval_task(task_id, run_custom_heartbeat, minutes=interval)
            logger.info(f"Scheduled custom heartbeat: {task_id}")

        # Remove stale jobs that are no longer in config
        for job in self.scheduler.get_jobs():
            if job.id.startswith("custom_hb_") and job.id not in current_ids:
                self.remove_task(job.id)
                logger.info(f"Removed stale custom heartbeat: {job.id}")

    def _reload_cron_tasks(self):
        """Reload cron task schedules from bridge-config.json (picks up UI changes)"""
        try:
            task_config = load_task_config()
            tasks = task_config.get("tasks", {})

            # Map of cron task IDs to their config keys and handler functions
            cron_defs = {
                "morning_briefing": {
                    "cfg": tasks.get("morning_briefing", {}),
                    "default_enabled": True,
                    "default_time": "07:00",
                    "func": self._morning_briefing,
                },
                "db_backup": {
                    "cfg": tasks.get("db_backup", {}),
                    "default_enabled": True,
                    "default_time": "03:00",
                    "func": self._backup_databases,
                },
                "goal_review": {
                    "cfg": tasks.get("goal_review", {}),
                    "default_enabled": False,
                    "default_time": "09:00",
                    "func": self._goal_review,
                },
                "yt_download": {
                    "cfg": tasks.get("yt_download", {}),
                    "default_enabled": False,
                    "default_time": "04:00",
                    "func": self._yt_download,
                },
            }

            for task_id, defn in cron_defs.items():
                cfg = defn["cfg"]
                enabled = cfg.get("enabled", defn["default_enabled"])
                time_str = cfg.get("time", defn["default_time"])
                hour, minute = map(int, time_str.split(':'))

                existing = self.scheduler.get_job(task_id)
                if not enabled:
                    if existing:
                        self.remove_task(task_id)
                        logger.info(f"Cron task disabled: {task_id}")
                    continue

                # Check if schedule changed
                if existing and hasattr(existing.trigger, 'fields'):
                    fields = {f.name: f for f in existing.trigger.fields}
                    cur_hour = int(str(fields.get('hour', '')))
                    cur_minute = int(str(fields.get('minute', '')))
                    if cur_hour == hour and cur_minute == minute:
                        continue  # No change

                # Add or reschedule
                self.add_cron_task(task_id, defn["func"], hour=hour, minute=minute)
                logger.info(f"Cron task rescheduled: {task_id} → {time_str}")

        except Exception as e:
            logger.error(f"Failed to reload cron tasks: {e}")

    def _check_triggers(self):
        """Check for manual triggers from the web GUI"""
        try:
            config = load_task_config()
            triggers = config.get("pending_triggers", [])
            if not triggers:
                return

            # Process each trigger
            for trigger in triggers:
                task_id = trigger.get("taskId", "")
                task_type = trigger.get("taskType", "")
                logger.info(f"Processing manual trigger: {task_id} (type={task_type})")

                try:
                    if task_type == "cron":
                        self._run_cron_task(task_id)
                    elif task_type == "heartbeat":
                        self._run_heartbeat_task(task_id)
                    elif task_type == "automation":
                        self._run_automation_task(task_id)
                    else:
                        logger.warning(f"Unknown trigger type: {task_type}")
                except Exception as e:
                    logger.error(f"Trigger execution failed for {task_id}: {e}")

            # Clear all processed triggers
            config["pending_triggers"] = []
            save_task_config(config)

        except Exception as e:
            logger.error(f"Trigger check failed: {e}")

    def _run_cron_task(self, task_id: str):
        """Run a cron task on demand"""
        task_map = {
            "morning_briefing": self._morning_briefing,
            "goal_review": self._goal_review,
            "weather_check_07:00": self._weather_check,
            "weather_check_12:00": self._weather_check,
            "weather_check_18:00": self._weather_check,
            "aurora_check_12:00": self._aurora_check,
            "aurora_check_18:00": self._aurora_check,
            "system_health": self._system_health_check,
            "db_backup": self._backup_databases,
            "yt_download": self._yt_download,
        }
        func = task_map.get(task_id)
        if func:
            logger.info(f"Manual trigger: running cron task {task_id}")
            func()
        else:
            logger.warning(f"Unknown cron task: {task_id}")

    def _run_heartbeat_task(self, task_id: str):
        """Run a custom heartbeat on demand (bypasses quiet period)"""
        custom_tasks = get_custom_heartbeats()
        for task in custom_tasks:
            if task.get("id") == task_id:
                choom_name = task.get("choom_name", "")
                prompt = task.get("prompt", "")
                if choom_name and prompt:
                    logger.info(f"Manual trigger: running heartbeat {task_id} -> {choom_name}")
                    # Bypass quiet period for manual triggers
                    self._execute_custom_heartbeat(task_id, choom_name, prompt, respect_quiet=False)
                return
        logger.warning(f"Custom heartbeat not found: {task_id}")

    def _execute_custom_heartbeat(self, task_id: str, choom_name: str, prompt: str, respect_quiet: bool):
        """Execute a single custom heartbeat"""
        if respect_quiet and is_quiet_period():
            logger.debug(f"Custom heartbeat {task_id} suppressed (quiet period)")
            return

        # Re-read config to get the latest prompt and choom_name
        # (closure values from setup time may be stale after settings edits)
        custom_tasks = get_custom_heartbeats()
        for task in custom_tasks:
            if task.get("id") == task_id:
                choom_name = task.get("choom_name", choom_name)
                prompt = task.get("prompt", prompt)
                break

        # Skip if user is actively chatting with this Choom (avoid concurrent responses)
        if self.choom.is_user_active(choom_name, window_seconds=120):
            logger.info(f"Custom heartbeat {task_id} deferred: user active with {choom_name}")
            return

        logger.info(f"Running custom heartbeat: {task_id} -> {choom_name}")
        try:
            response = self.choom.send_message(choom_name, prompt)

            if response.content:
                self.send_message_to_owner(
                    response.content,
                    include_audio=True,
                    choom_name=choom_name
                )

                # Also deliver any images
                for img in response.images:
                    img_url = img.get("url", "")
                    if img_url:
                        try:
                            import base64
                            import tempfile
                            # Decode base64 image and send as attachment
                            if img_url.startswith("data:"):
                                img_data = base64.b64decode(img_url.split(",")[1])
                            else:
                                img_data = base64.b64decode(img_url)
                            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
                                f.write(img_data)
                                img_path = f.name
                            self.signal.send_message(
                                self.owner_phone,
                                f"[{choom_name}]",
                                attachments=[img_path]
                            )
                            import os
                            os.remove(img_path)
                        except Exception as img_err:
                            logger.warning(f"Failed to send heartbeat image: {img_err}")

                logger.info(f"Custom heartbeat {task_id} delivered")
            else:
                logger.warning(f"Custom heartbeat {task_id}: no response from {choom_name}")

        except Exception as e:
            logger.error(f"Custom heartbeat {task_id} failed: {e}")

    # =========================================================================
    # Skill-Based Automations
    # =========================================================================

    def _setup_automations(self):
        """Set up skill-based automations from bridge config"""
        task_config = load_task_config()
        automations = task_config.get("automations", [])
        setup_count = 0

        for auto in automations:
            if not auto.get("enabled", False):
                continue

            auto_id = auto.get("id", "")
            schedule = auto.get("schedule", {})
            if not auto_id or not schedule:
                continue

            steps = auto.get("steps", [])
            if not steps:
                continue

            def run_automation(a=auto):
                self._execute_automation(a)

            sched_type = schedule.get("type", "cron")
            if sched_type == "interval":
                interval_mins = max(5, schedule.get("intervalMinutes", 60))
                self.add_interval_task(auto_id, run_automation, minutes=interval_mins)
            else:
                # Parse cron expression
                cron_str = schedule.get("cron", "")
                if cron_str:
                    try:
                        parts = cron_str.split()
                        if len(parts) >= 5:
                            trigger = CronTrigger(
                                minute=parts[0],
                                hour=parts[1],
                                day=parts[2],
                                month=parts[3],
                                day_of_week=parts[4]
                            )
                            self.scheduler.add_job(
                                run_automation,
                                trigger,
                                id=auto_id,
                                replace_existing=True
                            )
                        else:
                            logger.warning(f"Invalid cron expression for {auto_id}: {cron_str}")
                            continue
                    except Exception as e:
                        logger.warning(f"Failed to parse cron for {auto_id}: {e}")
                        continue
                else:
                    logger.warning(f"Automation {auto_id} has no cron expression")
                    continue

            setup_count += 1
            logger.info(f"Automation scheduled: {auto_id} ({auto.get('name', 'unnamed')})")

        if setup_count:
            logger.info(f"Set up {setup_count} automations")

    def _reload_automations(self):
        """Check for config changes and update automation schedules"""
        task_config = load_task_config()
        automations = task_config.get("automations", [])
        current_ids = set()

        for auto in automations:
            auto_id = auto.get("id", "")
            if not auto_id:
                continue
            current_ids.add(auto_id)

            if not auto.get("enabled", False):
                # Remove if disabled
                try:
                    self.scheduler.get_job(auto_id)
                    self.remove_task(auto_id)
                    logger.info(f"Disabled automation: {auto_id}")
                except Exception:
                    pass
                continue

            # Check if already scheduled
            try:
                existing = self.scheduler.get_job(auto_id)
                if existing:
                    continue
            except Exception:
                pass

            # New automation — schedule it
            steps = auto.get("steps", [])
            schedule = auto.get("schedule", {})
            if not steps or not schedule:
                continue

            def run_automation(a=auto):
                self._execute_automation(a)

            sched_type = schedule.get("type", "cron")
            if sched_type == "interval":
                interval_mins = max(5, schedule.get("intervalMinutes", 60))
                self.add_interval_task(auto_id, run_automation, minutes=interval_mins)
            else:
                cron_str = schedule.get("cron", "")
                if cron_str:
                    try:
                        parts = cron_str.split()
                        if len(parts) >= 5:
                            trigger = CronTrigger(
                                minute=parts[0],
                                hour=parts[1],
                                day=parts[2],
                                month=parts[3],
                                day_of_week=parts[4]
                            )
                            self.scheduler.add_job(
                                run_automation,
                                trigger,
                                id=auto_id,
                                replace_existing=True
                            )
                        else:
                            continue
                    except Exception:
                        continue
                else:
                    continue

            logger.info(f"Scheduled new automation: {auto_id}")

        # Remove stale automation jobs
        for job in self.scheduler.get_jobs():
            if job.id.startswith("auto_") and job.id not in current_ids:
                self.remove_task(job.id)
                logger.info(f"Removed stale automation: {job.id}")

    def _run_automation_task(self, auto_id: str):
        """Run an automation on demand (bypasses quiet period)"""
        task_config = load_task_config()
        automations = task_config.get("automations", [])
        for auto in automations:
            if auto.get("id") == auto_id:
                logger.info(f"Manual trigger: running automation {auto_id}")
                self._execute_automation(auto, respect_quiet=False)
                return
        logger.warning(f"Automation not found: {auto_id}")

    def _evaluate_conditions(self, automation: dict) -> bool:
        """Evaluate automation conditions. Returns True if conditions are met or no conditions set."""
        conditions = automation.get("conditions", [])
        if not conditions:
            return True  # No conditions = always run (preserves current behavior)

        logic = automation.get("conditionLogic", "all")  # "all" (AND) or "any" (OR)
        auto_id = automation.get("id", "unknown")

        # Check cooldown first
        cooldown = automation.get("cooldown", {})
        cooldown_minutes = cooldown.get("minutes", 0) if cooldown else 0
        if cooldown_minutes > 0:
            last_met = automation.get("lastConditionMet")
            if last_met:
                try:
                    last_dt = datetime.fromisoformat(last_met)
                    if datetime.now() - last_dt < timedelta(minutes=cooldown_minutes):
                        logger.debug(f"Automation {auto_id}: cooldown active (last fired {last_met})")
                        return False
                except (ValueError, TypeError):
                    pass

        results = []
        for condition in conditions:
            cond_type = condition.get("type", "no_condition")
            try:
                met = self._evaluate_single_condition(condition)
                results.append(met)
                logger.debug(f"Automation {auto_id}: condition {cond_type} = {met}")
            except Exception as e:
                logger.warning(f"Automation {auto_id}: condition {cond_type} eval failed: {e}")
                results.append(False)

        if logic == "any":
            passed = any(results)
        else:
            passed = all(results)

        if passed:
            # Update lastConditionMet timestamp
            try:
                cfg = load_task_config()
                for a in cfg.get("automations", []):
                    if a.get("id") == auto_id:
                        a["lastConditionMet"] = datetime.now().isoformat()
                        break
                save_task_config(cfg)
            except Exception as e:
                logger.warning(f"Failed to update lastConditionMet for {auto_id}: {e}")

        return passed

    def _evaluate_single_condition(self, condition: dict) -> bool:
        """Evaluate a single condition. Returns True if the condition is met."""
        cond_type = condition.get("type", "no_condition")

        if cond_type == "no_condition":
            return True

        if cond_type == "weather":
            return self._eval_weather_condition(condition)

        if cond_type == "time_range":
            return self._eval_time_range_condition(condition)

        if cond_type == "day_of_week":
            return self._eval_day_of_week_condition(condition)

        if cond_type == "calendar":
            return self._eval_calendar_condition(condition)

        if cond_type == "home_assistant":
            return self._eval_home_assistant_condition(condition)

        logger.warning(f"Unknown condition type: {cond_type}")
        return False

    def _eval_weather_condition(self, condition: dict) -> bool:
        """Evaluate weather condition: compare field with op and value"""
        field = condition.get("field", "temperature")  # temperature, windSpeed, humidity
        op = condition.get("op", "<")
        value = condition.get("value", 0)

        try:
            weather_data = self.choom.get_weather()
            current = weather_data.get("current", {})

            # Map field names to weather data keys
            field_map = {
                "temperature": "temperature",
                "windSpeed": "windSpeed",
                "humidity": "humidity",
                "temp": "temperature",
                "wind": "windSpeed",
            }
            actual_field = field_map.get(field, field)
            actual_value = current.get(actual_field)

            if actual_value is None:
                logger.warning(f"Weather field '{field}' not found in data")
                return False

            actual_value = float(actual_value)
            value = float(value)

            if op == "<": return actual_value < value
            if op == ">": return actual_value > value
            if op == "<=": return actual_value <= value
            if op == ">=": return actual_value >= value
            if op == "==": return actual_value == value
            return False
        except Exception as e:
            logger.warning(f"Weather condition eval failed: {e}")
            return False

    def _eval_time_range_condition(self, condition: dict) -> bool:
        """Evaluate time_range condition: current time between after and before"""
        after_str = condition.get("after", "00:00")
        before_str = condition.get("before", "23:59")

        try:
            now = datetime.now()
            after_parts = after_str.split(":")
            before_parts = before_str.split(":")
            after_time = now.replace(hour=int(after_parts[0]), minute=int(after_parts[1]), second=0)
            before_time = now.replace(hour=int(before_parts[0]), minute=int(before_parts[1]), second=59)

            if after_time <= before_time:
                return after_time <= now <= before_time
            else:
                # Overnight range (e.g., 22:00 - 06:00)
                return now >= after_time or now <= before_time
        except Exception as e:
            logger.warning(f"Time range condition eval failed: {e}")
            return False

    def _eval_day_of_week_condition(self, condition: dict) -> bool:
        """Evaluate day_of_week condition: check if today is in the allowed days"""
        days = condition.get("days", [])
        if not days:
            return True

        # Python weekday: Mon=0..Sun=6, but JS uses Sun=0..Sat=6
        # Convert: Python weekday() to JS day convention
        py_weekday = datetime.now().weekday()  # Mon=0
        # JS convention: Sun=0, Mon=1, ..., Sat=6
        js_day = (py_weekday + 1) % 7
        return js_day in days

    def _eval_calendar_condition(self, condition: dict) -> bool:
        """Evaluate calendar condition: check if there are events today"""
        has_events = condition.get("has_events")
        keyword = condition.get("keyword")

        try:
            google = get_google_client()
            events = google.get_todays_events()

            if keyword:
                # Check if any event matches the keyword
                keyword_lower = keyword.lower()
                matching = [e for e in events if keyword_lower in e.get('summary', '').lower()]
                return len(matching) > 0

            if has_events is not None:
                return (len(events) > 0) == has_events

            # Default: true if any events exist
            return len(events) > 0
        except Exception as e:
            logger.warning(f"Calendar condition eval failed: {e}")
            return False

    def _eval_home_assistant_condition(self, condition: dict) -> bool:
        """Evaluate home_assistant condition: compare entity state with op and value"""
        entity_id = condition.get("entity_id", "")
        op = condition.get("op", "==")
        target_value = condition.get("ha_value", "")

        if not entity_id:
            logger.warning("Home Assistant condition missing entity_id")
            return False

        try:
            # Read HA settings from bridge config
            bridge_config = load_task_config()
            ha_settings = bridge_config.get("homeAssistant", {})
            base_url = ha_settings.get("baseUrl", "")
            access_token = ha_settings.get("accessToken", "")

            if not base_url or not access_token:
                logger.warning("Home Assistant not configured in bridge config")
                return False

            # Fetch entity state
            import requests
            url = f"{base_url.rstrip('/')}/api/states/{entity_id}"
            resp = requests.get(url, headers={"Authorization": f"Bearer {access_token}"}, timeout=10)
            resp.raise_for_status()
            entity = resp.json()

            actual_state = entity.get("state", "")

            # Skip unavailable/unknown
            if actual_state in ("unavailable", "unknown"):
                logger.warning(f"HA entity {entity_id} is {actual_state}")
                return False

            # Try numeric comparison first
            try:
                actual_num = float(actual_state)
                target_num = float(target_value)
                if op == "<": return actual_num < target_num
                if op == ">": return actual_num > target_num
                if op == "<=": return actual_num <= target_num
                if op == ">=": return actual_num >= target_num
                if op == "==": return actual_num == target_num
                if op == "!=": return actual_num != target_num
            except (ValueError, TypeError):
                pass

            # Fall back to string comparison
            if op == "==": return actual_state == target_value
            if op == "!=": return actual_state != target_value
            logger.warning(f"HA condition: cannot compare '{actual_state}' {op} '{target_value}' as strings")
            return False

        except Exception as e:
            logger.warning(f"Home Assistant condition eval failed: {e}")
            return False

    def _execute_automation(self, automation: dict, respect_quiet: bool = None):
        """Execute an automation by sending a structured prompt to the target Choom"""
        auto_id = automation.get("id", "unknown")
        auto_name = automation.get("name", "Unnamed")
        choom_name = automation.get("choomName", self.default_choom)
        steps = automation.get("steps", [])

        if respect_quiet is None:
            respect_quiet = automation.get("respectQuiet", True)

        if respect_quiet and is_quiet_period():
            logger.debug(f"Automation {auto_id} suppressed (quiet period)")
            return

        # Skip if user is actively chatting with this Choom
        if self.choom.is_user_active(choom_name, window_seconds=120):
            logger.info(f"Automation {auto_id} deferred: user active with {choom_name}")
            return

        # Evaluate conditions before execution
        if not self._evaluate_conditions(automation):
            logger.info(f"Automation {auto_id}: conditions not met, skipping")
            return

        logger.info(f"Executing automation: {auto_name} ({auto_id}) -> {choom_name}")

        try:
            # Build a structured prompt describing the steps
            step_lines = []
            for i, step in enumerate(steps, 1):
                tool_name = step.get("toolName", "unknown_tool")
                args = step.get("arguments", {})
                args_str = ", ".join(f'{k}="{v}"' if isinstance(v, str) else f"{k}={v}"
                                     for k, v in args.items()) if args else "no arguments"
                step_lines.append(f"Step {i}: Use the `{tool_name}` tool with {args_str}")

            prompt = (
                f"Execute this automation: \"{auto_name}\"\n\n"
                + "\n".join(step_lines)
                + "\n\nExecute each step in order. If a step fails, note the error and continue with remaining steps. "
                + "After all steps, provide a brief summary of what was done."
            )

            response = self.choom.send_message(choom_name, prompt, fresh_chat=True)

            result = 'success'
            if response.content:
                # Check for error indicators in response
                error_indicators = ['failed', 'error', 'could not', 'unable to']
                if any(ind in response.content.lower() for ind in error_indicators):
                    result = 'partial'

                if automation.get("notifyOnComplete", True):
                    notification = f"Automation \"{auto_name}\" completed:\n\n{response.content}"
                    self.send_message_to_owner(
                        notification,
                        include_audio=False,
                        choom_name=choom_name
                    )

                # Also deliver any images
                for img in response.images:
                    img_url = img.get("url", "")
                    if img_url:
                        try:
                            import base64
                            import tempfile
                            if img_url.startswith("data:"):
                                img_data = base64.b64decode(img_url.split(",")[1])
                            else:
                                img_data = base64.b64decode(img_url)
                            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
                                f.write(img_data)
                                img_path = f.name
                            self.signal.send_message(
                                self.owner_phone,
                                f"[{choom_name}]",
                                attachments=[img_path]
                            )
                            import os
                            os.remove(img_path)
                        except Exception as img_err:
                            logger.warning(f"Failed to send automation image: {img_err}")
            else:
                result = 'failed'
                logger.warning(f"Automation {auto_id}: no response from {choom_name}")

            # Update lastRun and lastResult in bridge config
            try:
                cfg = load_task_config()
                automations_list = cfg.get("automations", [])
                for a in automations_list:
                    if a.get("id") == auto_id:
                        a["lastRun"] = datetime.now().isoformat()
                        a["lastResult"] = result
                        break
                cfg["automations"] = automations_list
                save_task_config(cfg)
            except Exception as e:
                logger.warning(f"Failed to update automation status: {e}")

            logger.info(f"Automation {auto_id} completed with result: {result}")

        except Exception as e:
            logger.error(f"Automation {auto_id} failed: {e}")

            # Update status to failed
            try:
                cfg = load_task_config()
                automations_list = cfg.get("automations", [])
                for a in automations_list:
                    if a.get("id") == auto_id:
                        a["lastRun"] = datetime.now().isoformat()
                        a["lastResult"] = 'failed'
                        break
                cfg["automations"] = automations_list
                save_task_config(cfg)
            except Exception:
                pass

    def _backup_databases(self):
        """Back up dev.db and memories.db to Google Drive 'Choom Backup' folder"""
        if not is_task_enabled("db_backup"):
            logger.debug("Database backup is disabled")
            return

        logger.info("Running daily database backup to Google Drive")

        # Database files to back up
        db_files = [
            ("/home/nuc1/projects/Choom/nextjs-app/prisma/dev.db", "dev.db"),
            ("/home/nuc1/Documents/ai_Choom_memory/memory_db/memories.db", "memories.db"),
        ]

        try:
            from pathlib import Path
            google = get_google_client()

            # Find or create the "Choom Backup" folder
            folder_id = None
            try:
                results = google.drive_service.files().list(
                    q="name='Choom Backup' and mimeType='application/vnd.google-apps.folder' and trashed=false",
                    fields='files(id)',
                    pageSize=1
                ).execute()
                files = results.get('files', [])
                if files:
                    folder_id = files[0]['id']
                    logger.info(f"Found existing 'Choom Backup' folder: {folder_id}")
            except Exception as e:
                logger.warning(f"Error searching for backup folder: {e}")

            if not folder_id:
                result = google.create_drive_folder("Choom Backup")
                if result:
                    folder_id = result['id']
                    logger.info(f"Created 'Choom Backup' folder: {folder_id}")
                else:
                    logger.error("Failed to create 'Choom Backup' folder")
                    return

            # Upload each database file with date-stamped name
            date_stamp = datetime.now().strftime('%Y-%m-%d')
            uploaded = []

            for file_path, base_name in db_files:
                if not Path(file_path).exists():
                    logger.warning(f"Backup file not found: {file_path}")
                    continue

                drive_name = f"{base_name.replace('.db', '')}-{date_stamp}.db"
                result = google.upload_to_drive(file_path, folder_id, drive_name)
                if result:
                    uploaded.append(drive_name)
                    logger.info(f"Backed up {base_name} as {drive_name}")
                else:
                    logger.error(f"Failed to back up {base_name}")

            if uploaded:
                logger.info(f"Database backup complete: {', '.join(uploaded)}")

                # Rotation: keep only the last 5 backups per file type
                self._rotate_backups(google, folder_id, "dev-", 5)
                self._rotate_backups(google, folder_id, "memories-", 5)
            else:
                logger.warning("Database backup: no files were uploaded")

        except Exception as e:
            logger.error(f"Database backup failed: {e}")

    def _rotate_backups(self, google, folder_id: str, prefix: str, keep: int):
        """Delete old backups, keeping only the most recent N files matching prefix"""
        try:
            results = google.drive_service.files().list(
                q=f"'{folder_id}' in parents and name contains '{prefix}' and trashed=false",
                fields='files(id, name, createdTime)',
                orderBy='createdTime desc',
                pageSize=100
            ).execute()
            files = results.get('files', [])

            if len(files) > keep:
                for old_file in files[keep:]:
                    google.drive_service.files().delete(fileId=old_file['id']).execute()
                    logger.info(f"Backup rotation: deleted old backup {old_file['name']}")
        except Exception as e:
            logger.warning(f"Backup rotation failed for {prefix}*: {e}")

    def _yt_download(self):
        """Download new music from configured YouTube channels"""
        logger.info("Running YouTube music download")

        try:
            from yt_downloader import YouTubeDownloader

            task_config = load_task_config()
            yt_config = task_config.get("yt_downloader", {})
            channels = yt_config.get("channels", [])
            max_per = yt_config.get("max_videos_per_channel", 3)

            if not channels:
                logger.info("YouTube download: no channels configured")
                return

            enabled_channels = [c for c in channels if c.get("enabled", True)]
            if not enabled_channels:
                logger.info("YouTube download: no enabled channels")
                return

            dl = YouTubeDownloader()
            results = dl.run_all(enabled_channels, max_per_channel=max_per)
            summary = dl.format_summary(results)

            # Send notification if there were downloads or errors
            total_dl = sum(len(r["downloaded"]) for r in results)
            total_err = sum(len(r["errors"]) for r in results)

            if total_dl > 0 or total_err > 0:
                self.send_message_to_owner(
                    summary,
                    include_audio=False,
                    choom_name="System"
                )

            logger.info(f"YouTube download complete: {total_dl} downloaded, {total_err} errors")

        except Exception as e:
            logger.error(f"YouTube download failed: {e}")

    def _signal_account_keepalive(self):
        """Refresh account with Signal servers to reset inactivity timer.
        Uses updateAccount (refreshes pre-keys + account attributes) instead of
        sendSyncRequest (which only syncs between devices and doesn't count as
        server-side activity).
        """
        try:
            if self.signal.connected:
                success = self.signal.refresh_account()
                if success:
                    logger.info("Signal account keepalive OK — inactivity timer reset")
                else:
                    logger.warning("Signal account keepalive FAILED — account may show inactivity warning")
            else:
                logger.warning("Signal account keepalive skipped — not connected to daemon")
        except Exception as e:
            logger.error(f"Signal account keepalive error: {e}")

    def _system_health_check(self):
        """Check system health and alert on issues (respects quiet period)"""
        if not is_task_enabled("system_health"):
            logger.debug("System health check is disabled")
            return

        logger.info("Running system health check")

        try:
            health = self.choom.check_health()

            if 'error' in health:
                if not is_quiet_period():
                    self.send_message_to_owner(
                        f"System Alert: Health check failed - {health['error']}",
                        include_audio=False,
                        choom_name="System"
                    )
                else:
                    logger.info("Health check error during quiet period, suppressing alert")
                return

            services = health.get('services', {})
            issues = []

            for service_name, service_info in services.items():
                if isinstance(service_info, dict):
                    status = service_info.get('status', 'unknown')
                    if status != 'connected':
                        issues.append(f"- {service_name}: {status}")

            if issues:
                if not is_quiet_period():
                    message = "System Alert: Service issues detected\n\n" + "\n".join(issues)
                    self.send_message_to_owner(message, include_audio=False, choom_name="System")
                    logger.warning(f"Health check found issues: {issues}")
                else:
                    logger.info(f"Health check issues during quiet period (suppressed): {issues}")
            else:
                logger.info("Health check: all services operational")

        except Exception as e:
            logger.error(f"Health check failed: {e}")


# Singleton instance
_scheduler: Optional[ScheduledTaskManager] = None


def get_scheduler() -> ScheduledTaskManager:
    global _scheduler
    if _scheduler is None:
        _scheduler = ScheduledTaskManager()
    return _scheduler
