"""
Signal CLI Handler
JSON-RPC client for signal-cli daemon mode (Unix socket)
"""
import json
import os
import socket
import logging
import threading
import time
import queue
from typing import Optional, List, Dict, Any
from pathlib import Path

import config

logger = logging.getLogger(__name__)


class SignalHandler:
    """Handles interaction with signal-cli daemon via JSON-RPC over Unix socket"""

    def __init__(self):
        self.socket_path = config.SIGNAL_SOCKET_PATH
        self.config_path = config.SIGNAL_CONFIG_PATH
        self.account = config.SIGNAL_PHONE_NUMBER
        self.connect_timeout = config.SIGNAL_DAEMON_CONNECT_TIMEOUT
        self.reconnect_interval = config.SIGNAL_DAEMON_RECONNECT_INTERVAL

        # Socket and threading state
        self._sock: Optional[socket.socket] = None
        self._sock_file = None  # Buffered file wrapper for readline
        self._connected = False
        self._write_lock = threading.Lock()
        self._request_id = 0
        self._pending_requests: Dict[int, threading.Event] = {}
        self._responses: Dict[int, dict] = {}
        self._message_queue: queue.Queue = queue.Queue()
        self._reader_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

        # Ensure temp directories exist
        Path(config.TEMP_AUDIO_PATH).mkdir(parents=True, exist_ok=True)
        Path(config.TEMP_IMAGE_PATH).mkdir(parents=True, exist_ok=True)

    @property
    def connected(self) -> bool:
        return self._connected

    def connect(self) -> bool:
        """
        Connect to the signal-cli daemon socket.
        Retries until connect_timeout is reached.

        Returns:
            True if connected, False if timed out
        """
        deadline = time.monotonic() + self.connect_timeout
        attempt = 0

        while time.monotonic() < deadline:
            attempt += 1
            try:
                sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                sock.connect(self.socket_path)
                self._sock = sock
                # Create a buffered file for line-based reading
                self._sock_file = sock.makefile('r', encoding='utf-8')
                self._connected = True
                self._stop_event.clear()

                # Start reader thread
                self._reader_thread = threading.Thread(
                    target=self._reader_loop, daemon=True, name="signal-rpc-reader"
                )
                self._reader_thread.start()

                logger.info(f"Connected to signal-cli daemon at {self.socket_path}")
                return True

            except (ConnectionRefusedError, FileNotFoundError, OSError) as e:
                if attempt == 1:
                    logger.info(f"Waiting for signal-cli daemon ({e})...")
                time.sleep(self.reconnect_interval)

        logger.error(f"Failed to connect to signal-cli daemon after {self.connect_timeout}s")
        return False

    def disconnect(self):
        """Disconnect from the daemon socket"""
        self._stop_event.set()
        self._connected = False

        if self._sock_file:
            try:
                self._sock_file.close()
            except Exception:
                pass
            self._sock_file = None

        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None

        # Wake up any pending requests
        for event in self._pending_requests.values():
            event.set()
        self._pending_requests.clear()
        self._responses.clear()

        if self._reader_thread and self._reader_thread.is_alive():
            self._reader_thread.join(timeout=3)

        logger.info("Disconnected from signal-cli daemon")

    def reconnect(self) -> bool:
        """Disconnect and reconnect to the daemon"""
        logger.info("Reconnecting to signal-cli daemon...")
        self.disconnect()
        time.sleep(1)
        return self.connect()

    def _reader_loop(self):
        """
        Background thread: continuously reads JSON lines from the socket.
        Dispatches responses (with id) to pending requests,
        and notifications (method="receive") to the message queue.
        """
        logger.debug("Reader thread started")
        while not self._stop_event.is_set():
            try:
                line = self._sock_file.readline()
                if not line:
                    # Socket closed
                    logger.warning("Socket closed by daemon")
                    self._connected = False
                    break

                line = line.strip()
                if not line:
                    continue

                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    logger.warning(f"Invalid JSON from daemon: {line[:200]}")
                    continue

                # Check if this is a response to a request (has "id" field)
                if "id" in data and data["id"] in self._pending_requests:
                    req_id = data["id"]
                    self._responses[req_id] = data
                    self._pending_requests[req_id].set()

                # Check if this is a notification (incoming message)
                elif data.get("method") == "receive":
                    params = data.get("params", {})
                    self._message_queue.put(params)
                    logger.debug(f"Queued incoming message notification")

                else:
                    logger.debug(f"Unhandled daemon message: {json.dumps(data)[:200]}")

            except Exception as e:
                if not self._stop_event.is_set():
                    logger.error(f"Reader thread error: {e}")
                    self._connected = False
                break

        logger.debug("Reader thread exiting")

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    def _send_request(self, method: str, params: Optional[dict] = None, timeout: float = 60) -> dict:
        """
        Send a JSON-RPC request and wait for the response.

        Args:
            method: JSON-RPC method name (e.g. "send", "sendTyping")
            params: Method parameters
            timeout: Max seconds to wait for response

        Returns:
            The JSON-RPC response dict

        Raises:
            ConnectionError: If not connected
            TimeoutError: If response not received in time
            RuntimeError: If the RPC returned an error
        """
        if not self._connected:
            raise ConnectionError("Not connected to signal-cli daemon")

        req_id = self._next_id()
        request = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
        }
        if params:
            request["params"] = params

        # Register pending request
        event = threading.Event()
        self._pending_requests[req_id] = event

        # Send (thread-safe)
        payload = json.dumps(request) + "\n"
        with self._write_lock:
            try:
                self._sock.sendall(payload.encode('utf-8'))
            except (BrokenPipeError, OSError) as e:
                self._pending_requests.pop(req_id, None)
                self._connected = False
                raise ConnectionError(f"Failed to send to daemon: {e}")

        logger.debug(f"Sent RPC #{req_id}: {method}")

        # Wait for response
        if not event.wait(timeout=timeout):
            self._pending_requests.pop(req_id, None)
            raise TimeoutError(f"RPC #{req_id} ({method}) timed out after {timeout}s")

        self._pending_requests.pop(req_id, None)
        response = self._responses.pop(req_id, {})

        # Check for RPC error
        if "error" in response:
            err = response["error"]
            raise RuntimeError(f"signal-cli RPC error: {err.get('message', err)}")

        return response

    def send_message(self, recipient: str, message: str, attachments: Optional[List[str]] = None) -> bool:
        """
        Send a text message to a recipient

        Args:
            recipient: Phone number (e.g., +1XXXXXXXXXX)
            message: Text message to send
            attachments: Optional list of file paths to attach

        Returns:
            True if successful, False otherwise
        """
        params = {
            "recipient": [recipient],
            "message": message,
        }

        if attachments:
            valid = [a for a in attachments if os.path.exists(a)]
            if valid:
                params["attachment"] = valid
            for a in attachments:
                if not os.path.exists(a):
                    logger.warning(f"Attachment not found: {a}")

        try:
            self._send_request("send", params)
            logger.info(f"Message sent to {recipient}")
            return True
        except Exception as e:
            logger.error(f"Failed to send message: {e}")
            return False

    def send_reaction(self, recipient: str, target_timestamp: int, emoji: str) -> bool:
        """Send a reaction to a message"""
        params = {
            "recipient": [recipient],
            "emoji": emoji,
            "targetAuthor": self.account,
            "targetTimestamp": target_timestamp,
        }

        try:
            self._send_request("sendReaction", params)
            return True
        except Exception as e:
            logger.error(f"Failed to send reaction: {e}")
            return False

    def send_typing_indicator(self, recipient: str, stop: bool = False) -> bool:
        """Send typing indicator"""
        params = {
            "recipient": [recipient],
        }
        if stop:
            params["stop"] = True

        try:
            self._send_request("sendTyping", params, timeout=10)
            return True
        except Exception as e:
            logger.error(f"Failed to send typing indicator: {e}")
            return False

    def receive_messages(self) -> List[Dict[str, Any]]:
        """
        Receive pending messages (non-blocking drain of notification queue).

        Returns:
            List of message dictionaries (same envelope format as subprocess mode)
        """
        messages = []
        while True:
            try:
                msg = self._message_queue.get_nowait()
                messages.append(msg)
            except queue.Empty:
                break
        return messages

    def download_attachment(self, attachment_id: str, output_path: str) -> Optional[str]:
        """
        Download an attachment from a received message.
        Attachments are already downloaded by the daemon to the config path.
        """
        attachment_dir = os.path.join(self.config_path, "attachments")
        attachment_file = os.path.join(attachment_dir, attachment_id)

        if os.path.exists(attachment_file):
            import shutil
            shutil.copy(attachment_file, output_path)
            return output_path

        logger.warning(f"Attachment not found: {attachment_id}")
        return None

    def get_contacts(self) -> List[Dict[str, Any]]:
        """Get list of contacts"""
        try:
            response = self._send_request("listContacts")
            return response.get("result", [])
        except Exception as e:
            logger.error(f"Failed to get contacts: {e}")
            return []

    def is_registered(self) -> bool:
        """Check if the account is registered (daemon is running = registered)"""
        return self._connected


class MessageParser:
    """Parse incoming Signal messages"""

    @staticmethod
    def parse_envelope(envelope: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Parse a signal-cli message envelope

        Returns a normalized message dict or None if not a user message
        """
        data = None
        source = envelope.get("source") or envelope.get("sourceNumber")

        # Check for regular data message
        if "dataMessage" in envelope:
            data = envelope["dataMessage"]
        # Check for sync message (when messaging yourself / Note to Self)
        elif "syncMessage" in envelope:
            sync = envelope["syncMessage"]
            if "sentMessage" in sync:
                data = sync["sentMessage"]
                # For sync messages, the source is yourself
                source = envelope.get("source") or envelope.get("sourceNumber")

        if not data or not source:
            return None

        # Skip if no actual message content
        message_text = data.get("message", "")
        if not message_text and not data.get("attachments"):
            return None

        parsed = {
            "source": source,
            "timestamp": data.get("timestamp", 0),
            "message": message_text,
            "attachments": [],
            "is_voice_note": False,
            "quote": None,
        }

        # Parse attachments
        for attachment in data.get("attachments", []):
            att_info = {
                "id": attachment.get("id"),
                "content_type": attachment.get("contentType", ""),
                "filename": attachment.get("filename"),
                "size": attachment.get("size", 0),
            }

            # Check if it's a voice note
            if attachment.get("voiceNote") or "audio" in att_info["content_type"]:
                parsed["is_voice_note"] = True

            parsed["attachments"].append(att_info)

        # Parse quote (reply)
        if "quote" in data:
            parsed["quote"] = {
                "id": data["quote"].get("id"),
                "author": data["quote"].get("author"),
                "text": data["quote"].get("text"),
            }

        return parsed

    # Common transcription variants for each Choom name
    # Maps variant -> canonical name
    CHOOM_NAME_VARIANTS = {
        "genesis": "Genesis",
        "lissa": "Lissa",
        "aloy": "Aloy",
        "anya": "Anya",
        "optic": "Optic",
        # Common voice transcription variants
        "lisa": "Lissa",
        "lysa": "Lissa",
        "lesa": "Lissa",
        "leesa": "Lissa",
        "elissa": "Lissa",
        "alyssa": "Lissa",
        "alloy": "Aloy",
        "eloy": "Aloy",
        "aloi": "Aloy",
        "ahoy": "Aloy",
        "ania": "Anya",
        "oniya": "Anya",
        "optek": "Optic",
        "optik": "Optic",
        "optics": "Optic",
    }

    @staticmethod
    def _match_choom_name(name: str) -> Optional[str]:
        """Match a potential name against known Chooms and transcription variants"""
        normalized = name.lower().strip().rstrip(",:.!?")
        return MessageParser.CHOOM_NAME_VARIANTS.get(normalized)

    # Words to skip when scanning for Choom names (common greetings/fillers)
    SKIP_WORDS = {
        'hey', 'hi', 'hello', 'yo', 'oh', 'ok', 'okay', 'so',
        'well', 'um', 'uh', 'like', 'please', 'dear', 'hiya',
    }

    @staticmethod
    def extract_choom_name(message: str) -> tuple[Optional[str], str]:
        """
        Extract Choom name from message if specified.
        Supports fuzzy matching for voice transcription variants.

        Formats supported:
        - "Genesis: hello" -> ("Genesis", "hello")
        - "genesis, what's up" -> ("Genesis", "what's up")
        - "@Lissa how are you" -> ("Lissa", "how are you")
        - "Lisa, what time is it" -> ("Lissa", "what time is it")  (transcription variant)
        - "Hey Lissa what are you doing" -> ("Lissa", "what are you doing")
        - "hello" -> (None, "hello")

        Returns:
            Tuple of (choom_name or None, cleaned message)
        """
        message = message.strip()

        # Pattern 1: "Name: message" or "Name, message"
        for separator in [":", ","]:
            if separator in message:
                parts = message.split(separator, 1)
                potential_name = parts[0].strip()
                matched = MessageParser._match_choom_name(potential_name)

                if matched:
                    cleaned_message = parts[1].strip()
                    return (matched, cleaned_message)

        # Pattern 2: "@Name message"
        if message.startswith("@"):
            parts = message[1:].split(None, 1)
            if parts:
                matched = MessageParser._match_choom_name(parts[0])
                if matched:
                    cleaned_message = parts[1] if len(parts) > 1 else ""
                    return (matched, cleaned_message)

        # Pattern 3: Scan first 5 words for a Choom name (skipping common filler words)
        # This handles "Hey Lissa what are you doing" and "Lissa what are you doing"
        words = message.split()
        for i, word in enumerate(words[:5]):
            clean_word = word.strip(",:.!?")
            matched = MessageParser._match_choom_name(clean_word)
            if matched:
                # Everything after the matched name is the cleaned message
                remaining = ' '.join(words[i + 1:]).strip()
                return (matched, remaining)
            # Stop scanning if we hit a non-filler word that isn't a Choom name
            if clean_word.lower() not in MessageParser.SKIP_WORDS:
                break

        return (None, message)


# Singleton instance
_signal_handler: Optional[SignalHandler] = None


def get_signal_handler() -> SignalHandler:
    """Get or create the SignalHandler singleton"""
    global _signal_handler
    if _signal_handler is None:
        _signal_handler = SignalHandler()
    return _signal_handler
