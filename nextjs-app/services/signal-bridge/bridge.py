#!/usr/bin/env python3
"""
Signal Bridge Service
Main entry point for the Signal-Choom integration

This service:
1. Receives messages from Signal via polling or webhook
2. Routes messages to the appropriate Choom
3. Sends responses back via Signal (text + audio)
4. Handles image generation and delivery
5. Manages scheduled tasks (heartbeats, cron jobs)
"""
import os
import sys
import time
import signal as sig
import logging
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import re
import config
from signal_handler import get_signal_handler, MessageParser
from choom_client import get_choom_client, get_tts_client, get_stt_client
from scheduler import get_scheduler
from google_client import get_google_client

# Configure logging
logging.basicConfig(
    level=getattr(logging, config.LOG_LEVEL),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        # logging.FileHandler(config.LOG_FILE) if os.path.exists(os.path.dirname(config.LOG_FILE)) else logging.NullHandler()
    ]
)
logger = logging.getLogger(__name__)


class SignalBridge:
    """Main bridge service connecting Signal to Chooms"""

    def __init__(self):
        self.signal = get_signal_handler()
        self.choom = get_choom_client()
        self.tts = get_tts_client()
        self.stt = get_stt_client()
        self.scheduler = get_scheduler()

        # Initialize Google client (for Tasks/Calendar)
        try:
            self.google = get_google_client()
            logger.info("Google client initialized")
        except Exception as e:
            logger.warning(f"Google client not available: {e}")
            self.google = None

        self.running = False
        self.poll_interval = 0.1  # seconds (messages pushed via daemon socket)

        # Persistent active Choom - when user addresses a Choom by name,
        # it becomes the active Choom for subsequent messages without a name prefix
        self._active_choom: Optional[str] = config.DEFAULT_CHOOM_NAME

        # Ensure temp directories exist
        Path(config.TEMP_AUDIO_PATH).mkdir(parents=True, exist_ok=True)
        Path(config.TEMP_IMAGE_PATH).mkdir(parents=True, exist_ok=True)

    def start(self):
        """Start the bridge service"""
        logger.info("Starting Signal Bridge...")

        # Connect to signal-cli daemon
        if not self.signal.connect():
            logger.error("Cannot start bridge: signal-cli daemon unavailable")
            sys.exit(1)

        # Load Chooms from API
        try:
            chooms = self.choom.fetch_chooms()
            logger.info(f"Loaded {len(chooms)} Chooms: {[c.name for c in chooms]}")
        except Exception as e:
            logger.error(f"Failed to load Chooms: {e}")
            logger.info("Will retry when processing messages...")

        # Start scheduler
        self.scheduler.start()

        # Start message polling
        self.running = True
        self._poll_messages()

    def stop(self):
        """Stop the bridge service"""
        logger.info("Stopping Signal Bridge...")
        self.running = False
        self.scheduler.stop()
        self.signal.disconnect()

    def _poll_messages(self):
        """Poll for incoming Signal messages (drains daemon notification queue)"""
        logger.info("Starting message polling...")

        while self.running:
            try:
                # Reconnect if daemon connection dropped
                if not self.signal.connected:
                    logger.warning("Daemon connection lost, attempting reconnect...")
                    if not self.signal.reconnect():
                        logger.error("Reconnect failed, retrying in 5s...")
                        time.sleep(5)
                        continue

                messages = self.signal.receive_messages()

                for msg in messages:
                    self._process_message(msg)

            except Exception as e:
                logger.error(f"Error polling messages: {e}")

            time.sleep(self.poll_interval)

    def _process_message(self, raw_message: dict):
        """Process an incoming Signal message"""
        try:
            # Parse the envelope
            envelope = raw_message.get('envelope', {})
            parsed = MessageParser.parse_envelope(envelope)

            if not parsed:
                logger.debug("Skipping non-data message")
                return

            source = parsed['source']
            message_text = parsed['message'] or ""
            is_voice = parsed['is_voice_note']
            attachments = parsed['attachments']

            # Safe logging with null check
            preview = message_text[:50] if message_text else "(empty/voice)"
            logger.info(f"Received message from {source}: {preview}...")

            # Check if from owner
            if source != config.OWNER_PHONE_NUMBER:
                logger.warning(f"Message from unknown number: {source}")
                return

            # Send typing indicator
            self.signal.send_typing_indicator(source)

            # Handle voice notes
            if is_voice and attachments:
                message_text = self._handle_voice_note(attachments[0])
                if not message_text:
                    self._send_response(source, "Sorry, I couldn't understand that voice message.", None)
                    return
                logger.info(f"Voice transcription result: '{message_text}'")

            # Handle image attachments (not voice notes)
            if not is_voice and attachments:
                image_paths = self._handle_image_attachments(attachments)
                if image_paths:
                    # Prepend image context so the LLM uses analyze_image tool
                    image_instructions = []
                    for img_path in image_paths:
                        image_instructions.append(
                            f"[User attached image: {img_path}] Please analyze this image using the analyze_image tool with image_path=\"{img_path}\"."
                        )
                    image_context = "\n".join(image_instructions)
                    if message_text:
                        message_text = f"{image_context}\n\n{message_text}"
                    else:
                        message_text = image_context
                    logger.info(f"Added {len(image_paths)} image attachment(s) to message context")

            if not message_text:
                logger.debug("Empty message, skipping")
                return

            # Extract Choom name from message first (to get the cleaned message)
            choom_name, cleaned_message = MessageParser.extract_choom_name(message_text)
            logger.info(f"Parsed message - choom_name: {choom_name}, cleaned: '{cleaned_message[:100] if cleaned_message else ''}'")

            # Check for task commands - use cleaned_message to handle "Genesis, remind me..."
            # This intercepts reminders and calendar commands even when addressed to a Choom
            task_response = self._handle_task_command(cleaned_message)
            logger.debug(f"Task command check (cleaned): {task_response is not None}")
            if task_response:
                # Use the Choom name for attribution if specified, otherwise "Tasks"
                self._send_response(source, task_response, choom_name or "Tasks")
                return

            # Also check the full message in case there's no Choom prefix
            if not task_response:
                task_response = self._handle_task_command(message_text)
                if task_response:
                    self._send_response(source, task_response, "Tasks")
                    return

            # Check if message to Choom contains a task request
            # This lets users say "Genesis, add milk to groceries" naturally
            task_in_message = self._extract_task_from_message(message_text)
            if task_in_message:
                list_name, item = task_in_message
                if self.google:
                    result = self.google.add_task_to_list_name(list_name, item)
                    if result:
                        logger.info(f"Added '{item}' to {list_name} from conversation")

            # Use active Choom if none specified in message
            if not choom_name:
                choom_name = self._active_choom or config.DEFAULT_CHOOM_NAME
                logger.info(f"No Choom name in message, using active Choom: {choom_name}")
            else:
                # User explicitly addressed a Choom - make it the active one
                if choom_name != self._active_choom:
                    logger.info(f"Switching active Choom: {self._active_choom} -> {choom_name}")
                    self._active_choom = choom_name
                else:
                    logger.info(f"Choom name extracted: {choom_name} (already active)")

            logger.info(f"Routing to Choom: {choom_name} | Message: '{cleaned_message[:80]}'")

            # Verify Choom exists before sending
            target_choom = self.choom.get_choom_by_name(choom_name)
            if target_choom:
                logger.info(f"Resolved Choom: id={target_choom.id}, name={target_choom.name}")
            else:
                logger.warning(f"Choom '{choom_name}' not found in loaded chooms: {list(self.choom.chooms.keys())}")

            # Get response from Choom
            try:
                # Record user activity so heartbeats defer while we're active
                self.choom.record_user_activity(choom_name)
                response = self.choom.send_message(choom_name, cleaned_message)

                # Log response details for debugging
                logger.info(f"Choom response - content length: {len(response.content)}, images: {len(response.images)}, tool_calls: {len(response.tool_calls)}")
                if not response.content:
                    logger.warning(f"Empty response content from {choom_name}")
                    if response.tool_results:
                        logger.info(f"Tool results received: {response.tool_results}")

                # Log image details before sending
                if response.images:
                    for i, img in enumerate(response.images):
                        url = img.get('url') or ''
                        logger.info(f"Image {i} for Signal: url_len={len(url)}, has_data_prefix={url[:20] if url else '(empty)'}, id={img.get('id')}")
                else:
                    logger.info(f"No images in response to send via Signal")

                self._send_response(source, response.content, choom_name, response.images)
            except ValueError as e:
                # Choom not found
                available = list(self.choom.chooms.keys())
                self._send_response(
                    source,
                    f"Choom '{choom_name}' not found. Available: {', '.join(available)}",
                    None
                )
            except Exception as e:
                logger.error(f"Error getting Choom response: {e}")
                self._send_response(source, f"Sorry, I encountered an error: {str(e)}", choom_name)

        except Exception as e:
            logger.error(f"Error processing message: {e}", exc_info=True)

    def _handle_voice_note(self, attachment: dict) -> Optional[str]:
        """
        Process a voice note attachment

        Args:
            attachment: Attachment info dict

        Returns:
            Transcribed text or None
        """
        try:
            attachment_id = attachment.get('id')
            if not attachment_id:
                return None

            # Download attachment
            audio_path = f"{config.TEMP_AUDIO_PATH}/voice_{datetime.now().strftime('%Y%m%d_%H%M%S')}.ogg"
            downloaded = self.signal.download_attachment(attachment_id, audio_path)

            if not downloaded:
                logger.error("Failed to download voice note")
                return None

            # Transcribe
            text = self.stt.transcribe(audio_path)

            # Clean up
            try:
                os.remove(audio_path)
            except:
                pass

            return text

        except Exception as e:
            logger.error(f"Error handling voice note: {e}")
            return None

    def _handle_image_attachments(self, attachments: list) -> list:
        """
        Process image attachments from a Signal message.
        Downloads each image and saves to workspace uploads/ folder.

        Args:
            attachments: List of attachment info dicts from MessageParser

        Returns:
            List of workspace-relative paths (e.g. "uploads/photo_123.jpg")
        """
        from paths import WORKSPACE_ROOT
        UPLOADS_DIR = 'uploads'
        IMAGE_TYPES = {'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'}
        MIME_TO_EXT = {
            'image/png': '.png',
            'image/jpeg': '.jpg',
            'image/gif': '.gif',
            'image/webp': '.webp',
            'image/bmp': '.bmp',
        }

        uploads_path = os.path.join(WORKSPACE_ROOT, UPLOADS_DIR)
        os.makedirs(uploads_path, exist_ok=True)

        saved_paths = []
        for att in attachments:
            content_type = att.get('content_type', '')
            if content_type not in IMAGE_TYPES:
                logger.debug(f"Skipping non-image attachment: {content_type}")
                continue

            attachment_id = att.get('id')
            if not attachment_id:
                logger.warning("Image attachment has no ID, skipping")
                continue

            ext = MIME_TO_EXT.get(content_type, '.png')
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            filename = f"signal_{timestamp}_{attachment_id[:8]}{ext}"
            output_path = os.path.join(uploads_path, filename)

            downloaded = self.signal.download_attachment(attachment_id, output_path)
            if downloaded:
                relative_path = f"{UPLOADS_DIR}/{filename}"
                saved_paths.append(relative_path)
                logger.info(f"Image attachment saved: {relative_path} ({att.get('size', 0)} bytes)")
            else:
                logger.error(f"Failed to download image attachment: {attachment_id}")

        return saved_paths

    def _handle_task_command(self, message: str) -> Optional[str]:
        """
        Handle Google Tasks commands

        Supported commands:
        - "add to <list>: <item>" - Add item to a list
        - "show <list>" or "<list> list" - Show items in a list
        - "my lists" or "task lists" - Show all lists
        - "calendar" or "events" - Show upcoming events

        Returns:
            Response string or None if not a task command
        """
        if not self.google:
            return None

        # Normalize smart quotes and other Unicode variants from Signal
        message = message.replace('\u2018', "'").replace('\u2019', "'")  # smart single quotes
        message = message.replace('\u201c', '"').replace('\u201d', '"')  # smart double quotes
        message = message.replace('\u2026', '...')  # ellipsis
        message_lower = message.lower().strip()

        try:
            # Show all task lists
            if message_lower in ['my lists', 'task lists', 'lists', 'show lists']:
                lists = self.google.get_task_lists()
                if lists:
                    list_names = [tl['title'] for tl in lists]
                    return f"Your task lists:\n" + "\n".join(f"- {name}" for name in list_names)
                return "No task lists found."

            # Show calendar events
            if message_lower in ['calendar', 'events', 'my calendar', 'upcoming', 'whats on my calendar', "what's on my calendar"]:
                events = self.google.get_upcoming_events(max_results=5, days_ahead=3)
                if events:
                    event_lines = []
                    for e in events:
                        start = e['start']
                        # Parse the date for display
                        if 'T' in start:
                            dt = datetime.fromisoformat(start.replace('Z', '+00:00'))
                            start_str = dt.strftime("%a %m/%d %I:%M %p")
                        else:
                            start_str = start
                        event_lines.append(f"- {e['summary']} ({start_str})")
                    return "Upcoming events:\n" + "\n".join(event_lines)
                return "No upcoming events in the next 3 days."

            # Calendar this week
            if 'calendar this week' in message_lower or 'week' in message_lower and 'calendar' in message_lower:
                events = self.google.get_upcoming_events(max_results=10, days_ahead=7)
                if events:
                    event_lines = []
                    for e in events:
                        start = e['start']
                        if 'T' in start:
                            dt = datetime.fromisoformat(start.replace('Z', '+00:00'))
                            start_str = dt.strftime("%a %m/%d %I:%M %p")
                        else:
                            start_str = start
                        event_lines.append(f"- {e['summary']} ({start_str})")
                    return "This week's events:\n" + "\n".join(event_lines)
                return "No events scheduled this week."

            # Generic "next meeting" / "upcoming meetings" → show upcoming events (not search for word "meeting")
            generic_meeting_patterns = [
                r'(?:when\s+is\s+)?(?:my\s+)?next\s+meeting',
                r'upcoming\s+meeting',
                r'(?:do\s+i\s+have\s+)?(?:any\s+)?meetings?\s+(?:coming\s+up|this\s+month|scheduled)',
                r'(?:what|when)\s+(?:are|is)\s+my\s+(?:next\s+)?meetings?',
            ]
            if any(re.search(p, message_lower) for p in generic_meeting_patterns):
                events = self.google.get_upcoming_events(max_results=10, days_ahead=60)
                if events:
                    event_lines = []
                    for e in events:
                        start = e['start']
                        if 'T' in start:
                            dt = datetime.fromisoformat(start.replace('Z', '+00:00'))
                            start_str = dt.strftime("%a %m/%d %I:%M %p")
                        else:
                            start_str = start
                        event_lines.append(f"- {e['summary']} ({start_str})")
                    return f"Upcoming events (next 60 days):\n" + "\n".join(event_lines)
                return "No upcoming events in the next 60 days."

            # Birthday-specific patterns → search all events for "birthday" keyword
            birthday_patterns = [
                r"(?:who(?:'?s|se)\s+)?birthday\s+(?:is\s+)?(?:up\s+)?next",
                r"next\s+birthday",
                r"upcoming\s+birthday",
                r"(?:look\s+up|find|search\s+for|check)\s+(?:the\s+)?birthdays?",
                r"(?:any|when\s+(?:are|is))\s+(?:the\s+)?(?:next\s+)?birthdays?",
                r"birthdays?\s+(?:coming\s+up|this\s+month|this\s+year)",
            ]
            if any(re.search(p, message_lower) for p in birthday_patterns):
                events = self.google.get_upcoming_events(max_results=100, days_ahead=365)
                birthday_events = []
                for e in events:
                    name_lower = e['summary'].lower()
                    if 'birthday' in name_lower or 'bday' in name_lower:
                        birthday_events.append(e)
                if birthday_events:
                    event_lines = []
                    for e in birthday_events:
                        start = e['start']
                        if 'T' in start:
                            dt = datetime.fromisoformat(start.replace('Z', '+00:00'))
                            start_str = dt.strftime("%A, %B %d")
                        else:
                            dt = datetime.strptime(start, '%Y-%m-%d')
                            start_str = dt.strftime("%A, %B %d")
                        event_lines.append(f"- {e['summary']}: {start_str}")
                    return f"Found {len(birthday_events)} upcoming birthday(s):\n" + "\n".join(event_lines)
                return "No birthdays found in the calendar for the next year."

            # Search for specific event: "when is X" or "check calendar for X" or "when is X's birthday"
            search_patterns = [
                r"when\s+is\s+(.+?)(?:'s)?\s*(?:birthday|bday|party|appointment|event)?(?:\?)?$",
                r"(?:check|search)\s+(?:the\s+)?calendar\s+(?:for|and\s+(?:tell|find)\s+(?:me\s+)?(?:when)?)\s+(.+?)(?:\?)?$",
                r"(?:find|look\s+for)\s+(.+?)\s+(?:on|in)\s+(?:the\s+)?calendar",
            ]

            for pattern in search_patterns:
                search_match = re.search(pattern, message_lower)
                if search_match:
                    search_term = search_match.group(1).strip()
                    # Remove common words that aren't helpful for searching
                    search_term = re.sub(r"\b(the|a|an|is|on|for|my|calendar)\b", "", search_term).strip()
                    logger.info(f"Calendar search for: '{search_term}'")

                    # Extend search range for birthdays/anniversaries to full year
                    if any(word in message_lower for word in ['birthday', 'bday', 'anniversary', 'annual']):
                        days_ahead = 365
                    else:
                        days_ahead = 60

                    # Search upcoming events
                    events = self.google.get_upcoming_events(max_results=100, days_ahead=days_ahead)
                    matching = []

                    # Split search into words for flexible matching
                    search_words = [w.lower().strip("'s") for w in search_term.split() if len(w) > 2]

                    # First pass: try full search term as substring
                    if search_term:
                        for e in events:
                            if search_term.lower() in e['summary'].lower():
                                matching.append(e)

                    # Second pass: if no full-term matches, try individual words
                    # Require ALL words to match (not just any one)
                    if not matching and search_words:
                        for e in events:
                            event_name = e['summary'].lower()
                            all_words_match = True
                            for word in search_words:
                                # Direct substring match
                                if word in event_name:
                                    continue
                                # Prefix match: first 4+ chars must match an event word
                                event_words = event_name.replace("'s", "").split()
                                word_matched = False
                                for ew in event_words:
                                    if len(word) >= 4 and len(ew) >= 4 and word[:4] == ew[:4]:
                                        word_matched = True
                                        break
                                if not word_matched:
                                    all_words_match = False
                                    break
                            if all_words_match:
                                matching.append(e)

                    # Remove duplicates while preserving order
                    seen = set()
                    unique_matching = []
                    for e in matching:
                        if e['id'] not in seen:
                            seen.add(e['id'])
                            unique_matching.append(e)
                    matching = unique_matching

                    if matching:
                        event_lines = []
                        for e in matching:
                            start = e['start']
                            if 'T' in start:
                                dt = datetime.fromisoformat(start.replace('Z', '+00:00'))
                                start_str = dt.strftime("%A, %B %d at %I:%M %p")
                            else:
                                # All-day event
                                dt = datetime.strptime(start, '%Y-%m-%d')
                                start_str = dt.strftime("%A, %B %d")
                            event_lines.append(f"- {e['summary']}: {start_str}")
                        return f"Found {len(matching)} event(s) matching '{search_term}':\n" + "\n".join(event_lines)
                    return f"No events found matching '{search_term}' in the next 60 days."

            # "This weekend" / "next weekend" queries
            weekend_match = re.search(r'(?:this|next)\s+weekend', message_lower)
            if weekend_match and not any(w in message_lower for w in ['weather', 'forecast', 'temperature', 'rain', 'snow', 'wind']):
                today = datetime.now()
                # Find Saturday
                days_until_sat = (5 - today.weekday()) % 7
                if days_until_sat == 0 and today.weekday() != 5:
                    days_until_sat = 7
                if 'next' in message_lower and today.weekday() < 5:
                    days_until_sat += 7
                saturday = today + timedelta(days=days_until_sat)
                sunday = saturday + timedelta(days=1)

                events = self.google.get_upcoming_events(max_results=20, days_ahead=days_until_sat + 2)
                weekend_events = []
                for e in events:
                    start = e['start']
                    if 'T' in start:
                        event_dt = datetime.fromisoformat(start.replace('Z', '+00:00'))
                        if event_dt.date() in (saturday.date(), sunday.date()):
                            weekend_events.append(e)
                    else:
                        event_date = datetime.strptime(start, '%Y-%m-%d').date()
                        if event_date in (saturday.date(), sunday.date()):
                            weekend_events.append(e)

                if weekend_events:
                    event_lines = []
                    for e in weekend_events:
                        start = e['start']
                        if 'T' in start:
                            dt = datetime.fromisoformat(start.replace('Z', '+00:00'))
                            start_str = dt.strftime("%A %I:%M %p")
                        else:
                            dt = datetime.strptime(start, '%Y-%m-%d')
                            start_str = dt.strftime("%A (all day)")
                        event_lines.append(f"- {e['summary']} ({start_str})")
                    return f"Weekend events ({saturday.strftime('%b %d')}-{sunday.strftime('%b %d')}):\n" + "\n".join(event_lines)
                return f"Nothing on the calendar for the weekend ({saturday.strftime('%b %d')}-{sunday.strftime('%b %d')})."

            # "Do I have anything on [day]" / "What's happening [day]" queries
            day_names = {'monday': 0, 'tuesday': 1, 'wednesday': 2, 'thursday': 3, 'friday': 4, 'saturday': 5, 'sunday': 6}
            specific_day_match = re.search(r'(?:do i have anything|what.?s (?:on|happening)|schedule for|anything on)\s+(?:next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)', message_lower)
            if specific_day_match and not any(w in message_lower for w in ['weather', 'forecast', 'temperature', 'rain', 'snow', 'wind']):
                target_day = day_names[specific_day_match.group(1)]
                today = datetime.now()
                days_ahead = (target_day - today.weekday()) % 7
                if days_ahead == 0:
                    days_ahead = 7  # Next week
                if 'next' in message_lower:
                    days_ahead += 7
                target_date = today + timedelta(days=days_ahead)

                events = self.google.get_upcoming_events(max_results=20, days_ahead=days_ahead + 1)
                day_events = []
                for e in events:
                    start = e['start']
                    if 'T' in start:
                        event_dt = datetime.fromisoformat(start.replace('Z', '+00:00'))
                        if event_dt.date() == target_date.date():
                            day_events.append(e)
                    else:
                        if start == target_date.strftime('%Y-%m-%d'):
                            day_events.append(e)

                if day_events:
                    event_lines = []
                    for e in day_events:
                        start = e['start']
                        if 'T' in start:
                            dt = datetime.fromisoformat(start.replace('Z', '+00:00'))
                            start_str = dt.strftime("%I:%M %p")
                        else:
                            start_str = "All day"
                        event_lines.append(f"- {e['summary']} ({start_str})")
                    return f"Events for {target_date.strftime('%A, %B %d')}:\n" + "\n".join(event_lines)
                return f"Nothing on the calendar for {target_date.strftime('%A, %B %d')}."

            # Tomorrow's events - but NOT weather/forecast questions
            is_tomorrow_calendar = 'tomorrow' in message_lower and not any(
                w in message_lower for w in ['weather', 'forecast', 'temperature', 'rain', 'snow', 'wind', 'cold', 'hot', 'warm', 'humid']
            )
            if is_tomorrow_calendar:
                tomorrow = datetime.now() + timedelta(days=1)
                events = self.google.get_upcoming_events(max_results=10, days_ahead=2)
                # Filter to only tomorrow's events
                tomorrow_events = []
                for e in events:
                    start = e['start']
                    if 'T' in start:
                        event_dt = datetime.fromisoformat(start.replace('Z', '+00:00'))
                        if event_dt.date() == tomorrow.date():
                            tomorrow_events.append(e)
                    else:
                        # All-day event - check date string
                        if start == tomorrow.strftime('%Y-%m-%d'):
                            tomorrow_events.append(e)

                if tomorrow_events:
                    event_lines = []
                    for e in tomorrow_events:
                        start = e['start']
                        if 'T' in start:
                            dt = datetime.fromisoformat(start.replace('Z', '+00:00'))
                            start_str = dt.strftime("%I:%M %p")
                        else:
                            start_str = "All day"
                        event_lines.append(f"- {e['summary']} ({start_str})")
                    return "Tomorrow's events:\n" + "\n".join(event_lines)
                return "Nothing on the calendar for tomorrow."

            # Today's events - exact matches
            today_exact = ['today', "today's calendar", 'whats today', "what's today", 'events today', 'calendar today', "check the calendar", "check my calendar", 'meetings today', 'any meetings today', 'any meetings', 'meetings', "what's happening today", 'whats happening today', 'schedule today', 'schedule for today', "today's schedule"]
            # Today's events - pattern matches
            today_patterns = [
                'whats on.*calendar', "what's on.*calendar", 'check.*calendar',
                r'(?:any|check|do i have).*meeting',
                r'meeting.*today',
                r'what.*meeting.*today',
                r'check about.*meeting',
                r'(?:any|what).*(?:event|appointment).*today',
                r'do i have anything.*today',
                r"what's (?:on|happening|going on).*today",
                r'(?:any|what).*on (?:the |my )?schedule',
                r'anything (?:on|going on).*today',
            ]

            is_today_query = message_lower in today_exact or any(re.search(p, message_lower) for p in today_patterns)
            # Exclude "this week", "tomorrow", and weather queries
            if 'week' in message_lower or 'tomorrow' in message_lower:
                is_today_query = False
            if any(w in message_lower for w in ['weather', 'forecast', 'temperature', 'rain', 'snow', 'wind']):
                is_today_query = False

            if is_today_query:
                events = self.google.get_todays_events()
                if events:
                    event_lines = []
                    for e in events:
                        start = e['start']
                        if 'T' in start:
                            dt = datetime.fromisoformat(start.replace('Z', '+00:00'))
                            start_str = dt.strftime("%I:%M %p")
                        else:
                            start_str = "All day"
                        event_lines.append(f"- {e['summary']} ({start_str})")
                    return "Today's events:\n" + "\n".join(event_lines)
                return "Nothing on the calendar today."

            # Remind me command: "remind me in 30 minutes to check the oven"
            # Also handles: "remind me to check the oven in 30 minutes"
            # First, convert word numbers to digits
            word_to_num = {
                'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5',
                'six': '6', 'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10',
                'fifteen': '15', 'twenty': '20', 'thirty': '30', 'forty-five': '45',
                'a': '1', 'an': '1'
            }
            normalized_msg = message_lower
            for word, num in word_to_num.items():
                normalized_msg = re.sub(rf'\b{word}\b', num, normalized_msg)

            # Pattern 1: "remind me in X minutes to Y"
            remind_match = re.match(r'remind\s+me\s+in\s+(\d+)\s+(minute|minutes|hour|hours|min|mins|hr|hrs)\s+(?:to\s+)?(.+)', normalized_msg)

            # Pattern 2: "remind me to Y in X minutes" (reversed order)
            if not remind_match:
                remind_match_rev = re.match(r'remind\s+me\s+(?:to\s+)?(.+?)\s+in\s+(\d+)\s+(minute|minutes|hour|hours|min|mins|hr|hrs)\.?$', normalized_msg)
                if remind_match_rev:
                    # Reorder the groups to match Pattern 1's format
                    class FakeMatch:
                        def group(self, n):
                            if n == 1: return remind_match_rev.group(2)  # amount
                            if n == 2: return remind_match_rev.group(3)  # unit
                            if n == 3: return remind_match_rev.group(1)  # reminder text
                    remind_match = FakeMatch()

            logger.debug(f"Remind match check: normalized='{normalized_msg[:80]}', match={remind_match is not None}")
            if remind_match:
                amount = int(remind_match.group(1))
                unit = remind_match.group(2)
                reminder_text = remind_match.group(3).strip()

                # Calculate reminder time
                if unit in ['hour', 'hours', 'hr', 'hrs']:
                    delta = timedelta(hours=amount)
                    time_str = f"{amount} hour{'s' if amount > 1 else ''}"
                else:
                    delta = timedelta(minutes=amount)
                    time_str = f"{amount} minute{'s' if amount > 1 else ''}"

                remind_time = datetime.now() + delta

                # Import scheduler and add reminder
                from scheduler import get_scheduler
                from task_config import add_reminder, remove_reminder
                scheduler = get_scheduler()

                task_id = f"reminder_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

                def send_reminder(tid=task_id, txt=reminder_text):
                    scheduler.send_message_to_owner(
                        f"Reminder: {txt}",
                        include_audio=True,
                        choom_name=config.DEFAULT_CHOOM_NAME
                    )
                    remove_reminder(tid)

                scheduler.add_one_time_task(task_id, send_reminder, remind_time)
                add_reminder(task_id, reminder_text, remind_time.isoformat())

                return f"Got it! I'll remind you in {time_str}: {reminder_text}"

            # Remind me at specific time: "remind me at 3pm to call mom"
            remind_at_match = re.match(r'remind\s+me\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(?:to\s+)?(.+)', normalized_msg)
            if remind_at_match:
                hour = int(remind_at_match.group(1))
                minute = int(remind_at_match.group(2) or 0)
                ampm = remind_at_match.group(3)
                reminder_text = remind_at_match.group(4).strip()

                # Convert to 24-hour format
                if ampm == 'pm' and hour < 12:
                    hour += 12
                elif ampm == 'am' and hour == 12:
                    hour = 0

                # Set reminder time for today or tomorrow
                now = datetime.now()
                remind_time = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
                if remind_time <= now:
                    remind_time += timedelta(days=1)  # Tomorrow if time has passed

                from scheduler import get_scheduler
                from task_config import add_reminder, remove_reminder
                scheduler = get_scheduler()

                task_id = f"reminder_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

                def send_reminder(tid=task_id, txt=reminder_text):
                    scheduler.send_message_to_owner(
                        f"Reminder: {txt}",
                        include_audio=True,
                        choom_name=config.DEFAULT_CHOOM_NAME
                    )
                    remove_reminder(tid)

                scheduler.add_one_time_task(task_id, send_reminder, remind_time)
                add_reminder(task_id, reminder_text, remind_time.isoformat())

                time_str = remind_time.strftime("%I:%M %p")
                return f"Got it! I'll remind you at {time_str}: {reminder_text}"

            # Add to list: "add to groceries: milk" or "add milk to groceries" or "add milk to the groceries list"
            add_match = re.match(r'add\s+to\s+(?:the\s+)?(\w+)(?:\s+list)?:\s*(.+)', message_lower)
            if not add_match:
                add_match = re.match(r'add\s+(.+?)\s+to\s+(?:the\s+)?(\w+)(?:\s+list)?$', message_lower)
                if add_match:
                    # Swap groups - item first, list second
                    item = add_match.group(1).strip()
                    list_name = add_match.group(2).strip()
                else:
                    add_match = None
            else:
                list_name = add_match.group(1).strip()
                item = add_match.group(2).strip()

            if add_match:
                list_name = self._resolve_list_name(list_name)
                result = self.google.add_task_to_list_name(list_name, item)
                if result:
                    return f"Added '{item}' to {list_name}"
                return f"Couldn't add to '{list_name}'. Check if the list exists."

            # Remove from list: "remove butter from groceries" or "delete milk from the groceries list"
            remove_match = re.match(r'(?:remove|delete|take off)\s+(.+?)\s+(?:from|off)\s+(?:the\s+)?(\w+)(?:\s+list)?$', message_lower)
            if remove_match:
                item_to_remove = remove_match.group(1).strip()
                list_name = remove_match.group(2).strip()
                list_name = self._resolve_list_name(list_name)
                tasks = self.google.get_tasks_by_list_name(list_name)
                if tasks:
                    # Find task by title (case-insensitive)
                    for t in tasks:
                        if t['title'].lower() == item_to_remove.lower() and t.get('status') != 'completed':
                            # Get the list ID for deletion
                            task_lists = self.google.get_task_lists()
                            for tl in task_lists:
                                if tl['title'].lower() == list_name.lower():
                                    if self.google.delete_task(tl['id'], t['id']):
                                        return f"Removed '{item_to_remove}' from {list_name}"
                                    else:
                                        return f"Failed to remove '{item_to_remove}' from {list_name}"
                    return f"'{item_to_remove}' not found in {list_name}"
                return f"No items in {list_name} or list not found"

            # Show list: "show groceries" or "groceries list" or "what's on groceries" or "what's in my groceries list"
            show_match = re.match(r"(?:show|whats (?:on|in)|what's (?:on|in)|what (?:is|was) (?:on|in))\s+(?:my\s+)?(?:the\s+)?(\w+)(?:\s+list)?", message_lower)
            if not show_match:
                show_match = re.match(r"(\w+)\s+list", message_lower)
            if not show_match:
                # "what do i have on my groceries list"
                show_match = re.search(r"(?:on|in)\s+(?:my\s+)?(?:the\s+)?(\w+)\s+list", message_lower)

            if show_match:
                list_name = show_match.group(1).strip()
                # Skip if it's a known command word
                if list_name not in ['task', 'my', 'the']:
                    list_name = self._resolve_list_name(list_name)
                    tasks = self.google.get_tasks_by_list_name(list_name)
                    if tasks:
                        task_lines = [f"- {t['title']}" for t in tasks if t.get('status') != 'completed']
                        if task_lines:
                            return f"{list_name.capitalize()} list:\n" + "\n".join(task_lines)
                        return f"No pending items in {list_name}"
                    # Check if list exists
                    lists = self.google.get_task_lists()
                    list_names = [tl['title'].lower() for tl in lists]
                    if list_name.lower() not in list_names:
                        return f"List '{list_name}' not found. Say 'my lists' to see available lists."
                    return f"No items in {list_name}"

        except Exception as e:
            logger.error(f"Task command error: {e}")
            return f"Error handling task command: {str(e)}"

        return None  # Not a task command

    # Common list name aliases
    LIST_ALIASES = {
        'grocery': 'groceries',
        'groceries': 'groceries',
        'shopping': 'groceries',
        'hardware': 'hardware store',
        'todo': 'to do',
    }

    def _resolve_list_name(self, name: str) -> str:
        """Resolve list name aliases (grocery → groceries, etc.)"""
        return self.LIST_ALIASES.get(name.lower(), name)

    def _extract_task_from_message(self, message: str) -> Optional[tuple]:
        """
        Extract task addition request from natural conversation

        Patterns detected:
        - "add milk to groceries"
        - "add milk to the grocery list"
        - "put eggs on the groceries list"
        - "remember to buy bread" (adds to groceries by default)

        Returns:
            Tuple of (list_name, item) or None
        """
        message_lower = message.lower()

        # Common list name mappings
        list_aliases = {
            'grocery': 'groceries',
            'groceries': 'groceries',
            'shopping': 'groceries',
            'to buy': 'to buy',
            'tobuy': 'to buy',
            'hardware': 'hardware store',
            'todo': 'to do',
            'to do': 'to do',
        }

        # Pattern: "add X to Y" or "add X to the Y list"
        add_pattern = re.search(r'add\s+(.+?)\s+to\s+(?:the\s+)?(\w+)(?:\s+list)?', message_lower)
        if add_pattern:
            item = add_pattern.group(1).strip()
            list_name = add_pattern.group(2).strip()
            list_name = list_aliases.get(list_name, list_name)
            return (list_name, item)

        # Pattern: "put X on Y" or "put X on the Y list"
        put_pattern = re.search(r'put\s+(.+?)\s+on\s+(?:the\s+)?(\w+)(?:\s+list)?', message_lower)
        if put_pattern:
            item = put_pattern.group(1).strip()
            list_name = put_pattern.group(2).strip()
            list_name = list_aliases.get(list_name, list_name)
            return (list_name, item)

        # Pattern: "remember to buy X" - default to groceries
        remember_pattern = re.search(r'remember\s+to\s+(?:buy|get|pick up)\s+(.+)', message_lower)
        if remember_pattern:
            item = remember_pattern.group(1).strip()
            return ('groceries', item)

        return None

    def _send_response(self, recipient: str, message: str, choom_name: Optional[str], images: list = None):
        """
        Send a response back via Signal

        Args:
            recipient: Phone number to send to
            message: Text response
            choom_name: Name of Choom (for attribution)
            images: List of generated images to send
        """
        try:
            # Stop typing indicator
            self.signal.send_typing_indicator(recipient, stop=True)

            attachments = []

            # Get the Choom's voice_id if available
            voice_id = "sophie"  # default
            if choom_name:
                choom = self.choom.get_choom_by_name(choom_name)
                if choom and choom.voice_id:
                    voice_id = choom.voice_id
                    logger.debug(f"Using voice '{voice_id}' for {choom_name}")

            # Generate audio response
            import re
            audio_path = None
            if message:
                # Strip think tags first (LLM reasoning blocks)
                tts_text = re.sub(r'<think>.*?</think>', '', message, flags=re.DOTALL)

                # Strip agentic "working" lines — only speak the final delivery
                # Multi-iteration responses are joined with \n\n. Working lines contain
                # tool narration like "Now let me...", "I'll create...", "Let me check..."
                # Split into paragraphs and filter out working narration
                working_patterns = re.compile(
                    r'^(Now let me|Let me|I\'ll |I\'m going to|I will |I need to|'
                    r'First,? (?:let me|I\'ll)|Next,? (?:let me|I\'ll)|'
                    r'(?:Now |)(?:creating|checking|searching|looking|reading|writing|uploading|downloading|updating|fetching|generating)|'
                    r'(?:I\'ve |I have )(?:created|updated|written|uploaded|added|set up))',
                    re.IGNORECASE
                )
                paragraphs = tts_text.split('\n\n')
                # Keep paragraphs that don't start with working patterns
                spoken_paragraphs = [p for p in paragraphs if p.strip() and not working_patterns.match(p.strip())]
                # If everything was filtered, fall back to just the last paragraph
                if not spoken_paragraphs and paragraphs:
                    spoken_paragraphs = [paragraphs[-1]]
                tts_text = '\n\n'.join(spoken_paragraphs)

                # Strip markdown links for TTS (keep link text, remove URLs)
                tts_text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', tts_text)
                # Strip URLs that appear bare in text
                tts_text = re.sub(r'https?://\S+', '', tts_text)
                # Also strip other markdown
                tts_text = re.sub(r'[*_~`#]+', '', tts_text)
                # Strip emojis
                tts_text = re.sub(r'[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF\U0001F1E0-\U0001F1FF\U00002600-\U000026FF\U00002700-\U000027BF\U0000FE00-\U0000FE0F\U0001F900-\U0001F9FF\U0001FA00-\U0001FA6F\U0001FA70-\U0001FAFF\U0000200D\U000020E3\U000E0020-\U000E007F]+', '', tts_text)
                # Clean up extra whitespace
                tts_text = re.sub(r'\s+', ' ', tts_text).strip()

                if tts_text:  # Only generate if there's actual text after stripping
                    audio_path = f"{config.TEMP_AUDIO_PATH}/response_{datetime.now().strftime('%Y%m%d_%H%M%S')}.wav"
                    logger.info(f"Generating TTS audio ({len(tts_text)} chars) with voice '{voice_id}'")
                    if self.tts.synthesize(tts_text, voice=voice_id, output_path=audio_path):
                        attachments.append(audio_path)
                        logger.info(f"Audio generated: {audio_path}")
                    else:
                        logger.warning("TTS synthesis failed")
                        audio_path = None

            # Handle generated images
            if images:
                import base64
                logger.info(f"Processing {len(images)} images for Signal delivery")
                for i, img in enumerate(images):
                    img_url = img.get('url') or ''
                    img_id = img.get('id')
                    logger.info(f"Image {i}: url_len={len(img_url)}, id={img_id}, starts_with_data={img_url[:30] if img_url else '(empty)'}")

                    # Fallback: if url is empty but we have an id, fetch from API
                    if not img_url and img_id:
                        logger.info(f"Image {i}: URL empty, fetching from API by id={img_id}")
                        try:
                            img_response = self.choom._make_request("GET", f"/api/images/{img_id}")
                            img_data = img_response.json()
                            img_url = img_data.get('imageUrl', '')
                            logger.info(f"Image {i}: fetched from API, url_len={len(img_url)}")
                        except Exception as fetch_err:
                            logger.error(f"Image {i}: failed to fetch from API: {fetch_err}")

                    if img_url and img_url.startswith('data:image'):
                        # Base64 image - save to file
                        base64_data = img_url.split(',')[1] if ',' in img_url else img_url
                        img_path = f"{config.TEMP_IMAGE_PATH}/image_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{i}.png"

                        decoded = base64.b64decode(base64_data)
                        with open(img_path, 'wb') as f:
                            f.write(decoded)

                        attachments.append(img_path)
                        logger.info(f"Image saved: {img_path} ({len(decoded)} bytes)")
                    elif img_url:
                        logger.warning(f"Image {i}: unexpected URL format (not data:image): {img_url[:80]}")
                    else:
                        logger.warning(f"Image {i}: empty URL even after fallback fetch")

            # Strip think tags from message text too
            clean_message = re.sub(r'<think>.*?</think>', '', message, flags=re.DOTALL)
            clean_message = clean_message.strip()

            # Format message with Choom attribution
            if choom_name:
                formatted_message = f"[{choom_name}]\n\n{clean_message}"
            else:
                formatted_message = clean_message

            # Separate audio and image attachments - signal-cli handles them better as separate messages
            audio_attachments = [audio_path] if audio_path else []
            image_attachments = [a for a in attachments if a != audio_path]

            logger.info(f"Sending response: audio_attachments={len(audio_attachments)}, image_attachments={len(image_attachments)}")

            # Send text + audio first
            self.signal.send_message(
                recipient,
                formatted_message,
                attachments=audio_attachments if audio_attachments else None
            )

            # Send each image as a separate message with a small delay
            for img_path in image_attachments:
                time.sleep(1)  # 1s delay between messages for signal-cli
                logger.info(f"Sending image attachment separately: {img_path}")
                self.signal.send_message(
                    recipient,
                    "",  # Empty message - just the image
                    attachments=[img_path]
                )

            # Clean up temp files
            all_attachments = audio_attachments + image_attachments
            for attachment in all_attachments:
                try:
                    os.remove(attachment)
                except:
                    pass

            logger.info(f"Sent response to {recipient} (text+audio: 1 msg, images: {len(image_attachments)} msgs)")

        except Exception as e:
            logger.error(f"Error sending response: {e}", exc_info=True)


def main():
    """Main entry point"""
    import fcntl

    # Use a lock file to prevent multiple instances
    lock_file = '/tmp/signal-bridge.lock'
    lock_fd = open(lock_file, 'w')
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        logger.error("Another instance of signal-bridge is already running!")
        sys.exit(1)

    # Write PID to lock file
    lock_fd.write(str(os.getpid()))
    lock_fd.flush()

    bridge = SignalBridge()

    # Handle shutdown signals
    def shutdown(signum, frame):
        logger.info("Shutdown signal received")
        bridge.stop()
        lock_fd.close()
        sys.exit(0)

    sig.signal(sig.SIGINT, shutdown)
    sig.signal(sig.SIGTERM, shutdown)

    # Start the bridge
    try:
        bridge.start()
    except KeyboardInterrupt:
        bridge.stop()


if __name__ == "__main__":
    main()
