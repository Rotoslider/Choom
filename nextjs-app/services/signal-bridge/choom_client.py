"""
Choom API Client
Handles communication with the Choom Next.js API
"""
import os
import requests
import json
import logging
import base64
import time
from typing import Optional, Dict, Any, List, Generator
from dataclasses import dataclass

import config

logger = logging.getLogger(__name__)


@dataclass
class ChoomInfo:
    """Information about a Choom"""
    id: str
    name: str
    description: Optional[str]
    voice_id: Optional[str]
    companion_id: Optional[str]
    llm_model: Optional[str] = None
    llm_endpoint: Optional[str] = None
    image_settings: Optional[Dict[str, Any]] = None


@dataclass
class ChatResponse:
    """Response from Choom chat"""
    content: str
    tool_calls: List[Dict[str, Any]]
    tool_results: List[Dict[str, Any]]
    images: List[Dict[str, Any]]
    chat_id: str


class ChoomClient:
    """Client for interacting with Choom API"""

    def __init__(self, base_url: str = None):
        self.base_url = base_url or config.CHOOM_API_URL
        self.session = requests.Session()
        self.chooms: Dict[str, ChoomInfo] = {}
        self.chats: Dict[str, str] = {}  # choom_id -> active chat_id
        self._chooms_fetched_at: float = 0  # timestamp of last fetch
        self._chooms_ttl: float = 60  # refresh chooms every 60 seconds
        self._last_user_activity: Dict[str, float] = {}  # choom_name (lower) -> timestamp

    def record_user_activity(self, choom_name: str):
        """Record that the user sent a message to this Choom"""
        self._last_user_activity[choom_name.lower()] = time.time()

    def is_user_active(self, choom_name: str, window_seconds: float = 120) -> bool:
        """Check if user was recently active with this Choom (default: 2 min window)"""
        last = self._last_user_activity.get(choom_name.lower(), 0)
        return (time.time() - last) < window_seconds

    def _make_request(self, method: str, endpoint: str, **kwargs) -> requests.Response:
        """Make an API request"""
        url = f"{self.base_url}{endpoint}"
        logger.debug(f"{method} {url}")

        try:
            response = self.session.request(method, url, **kwargs)
            response.raise_for_status()
            return response
        except requests.RequestException as e:
            logger.error(f"API request failed: {e}")
            raise

    def fetch_chooms(self) -> List[ChoomInfo]:
        """Fetch all available Chooms"""
        response = self._make_request("GET", "/api/chooms")
        data = response.json()

        self.chooms = {}
        # API returns array directly, not wrapped in "chooms" key
        choom_list = data if isinstance(data, list) else data.get("chooms", [])
        for choom_data in choom_list:
            choom = ChoomInfo(
                id=choom_data["id"],
                name=choom_data["name"],
                description=choom_data.get("description"),
                voice_id=choom_data.get("voiceId"),
                companion_id=choom_data.get("companionId"),
                llm_model=choom_data.get("llmModel"),
                llm_endpoint=choom_data.get("llmEndpoint"),
                image_settings=choom_data.get("imageSettings"),
            )
            self.chooms[choom.name.lower()] = choom
            logger.info(f"Loaded Choom: {choom.name} ({choom.id}) llmModel={choom.llm_model} llmEndpoint={choom.llm_endpoint}")

        self._chooms_fetched_at = time.time()
        return list(self.chooms.values())

    def _ensure_chooms_fresh(self):
        """Refresh chooms if stale (older than TTL)"""
        if not self.chooms or (time.time() - self._chooms_fetched_at) > self._chooms_ttl:
            try:
                self.fetch_chooms()
            except Exception as e:
                logger.warning(f"Failed to refresh chooms: {e}")
                # Continue with stale data if refresh fails

    def get_choom_by_name(self, name: str) -> Optional[ChoomInfo]:
        """Get a Choom by name (case-insensitive). Auto-refreshes if stale."""
        self._ensure_chooms_fresh()
        return self.chooms.get(name.lower())

    def get_choom_by_id(self, choom_id: str) -> Optional[ChoomInfo]:
        """Get a Choom by ID. Auto-refreshes if stale."""
        self._ensure_chooms_fresh()
        for choom in self.chooms.values():
            if choom.id == choom_id:
                return choom
        return None

    def get_or_create_chat(self, choom_id: str) -> str:
        """Get existing chat or create a new one for Signal conversations"""
        # Check if we have an active chat for this Choom
        if choom_id in self.chats:
            # Verify chat still exists
            try:
                response = self._make_request("GET", f"/api/chats/{self.chats[choom_id]}")
                return self.chats[choom_id]
            except:
                # Chat doesn't exist anymore, create new one
                pass

        # Create a new chat for Signal
        response = self._make_request(
            "POST",
            "/api/chats",
            json={
                "choomId": choom_id,
                "title": "Signal Conversation"
            }
        )
        data = response.json()
        # API returns chat object directly, not wrapped
        chat_id = data.get("id") or data.get("chat", {}).get("id")
        self.chats[choom_id] = chat_id

        logger.info(f"Created new chat {chat_id} for Choom {choom_id}")
        return chat_id

    def send_message(self, choom_name: str, message: str, settings: Optional[Dict] = None, fresh_chat: bool = False) -> ChatResponse:
        """
        Send a message to a Choom and get the response

        Args:
            choom_name: Name of the Choom to talk to
            message: User's message
            settings: Optional settings override
            fresh_chat: If True, always create a new chat (useful for briefings to avoid stale context)

        Returns:
            ChatResponse with the Choom's response
        """
        # Get Choom
        choom = self.get_choom_by_name(choom_name)
        if not choom:
            raise ValueError(f"Choom '{choom_name}' not found")

        # Get or create chat
        if fresh_chat:
            # Create a fresh chat to avoid stale conversation context
            from datetime import datetime as dt
            title = f"Briefing {dt.now().strftime('%Y-%m-%d')}"
            response = self._make_request(
                "POST",
                "/api/chats",
                json={"choomId": choom.id, "title": title}
            )
            data = response.json()
            chat_id = data.get("id") or data.get("chat", {}).get("id")
            logger.info(f"Created fresh chat {chat_id} for {choom_name}: {title}")
        else:
            chat_id = self.get_or_create_chat(choom.id)

        # Load shared settings from bridge-config.json (synced from web GUI)
        from task_config import load_config as load_bridge_config
        bridge_cfg = load_bridge_config()

        # Build settings from bridge config, falling back to hardcoded defaults
        weather_cfg = bridge_cfg.get("weather", {})
        search_cfg = bridge_cfg.get("search", {})
        image_cfg = bridge_cfg.get("imageGen", {})

        default_settings = {
            "llm": {
                "endpoint": config.LLM_ENDPOINT,
                "temperature": 0.7,
                "maxTokens": 4096,
            },
            "memory": {
                "endpoint": config.MEMORY_ENDPOINT,
            },
            "weather": {
                "apiKey": weather_cfg.get("apiKey", config.OPENWEATHER_API_KEY),
                "provider": weather_cfg.get("provider", "openweathermap"),
                "location": weather_cfg.get("location", os.getenv("DEFAULT_WEATHER_LOCATION", "")),
                "latitude": weather_cfg.get("latitude", float(os.getenv("DEFAULT_WEATHER_LAT", "0"))),
                "longitude": weather_cfg.get("longitude", float(os.getenv("DEFAULT_WEATHER_LON", "0"))),
                "useCoordinates": weather_cfg.get("useCoordinates", True),
                "units": weather_cfg.get("units", "imperial"),
                "cacheMinutes": weather_cfg.get("cacheMinutes", 30),
            },
            "search": {
                "provider": search_cfg.get("provider", "brave" if config.BRAVE_API_KEY else "searxng"),
                "braveApiKey": search_cfg.get("braveApiKey", config.BRAVE_API_KEY),
                "searxngEndpoint": search_cfg.get("searxngEndpoint", os.getenv("SEARXNG_ENDPOINT", "")),
                "maxResults": search_cfg.get("maxResults", 5),
            },
        }

        # Apply imageGen settings from bridge config if present
        if image_cfg:
            default_settings["imageGen"] = image_cfg

        # Apply vision settings from bridge config if present
        vision_cfg = bridge_cfg.get("vision", {})
        if vision_cfg:
            default_settings["vision"] = vision_cfg
        else:
            # Fallback to same LLM endpoint with sensible defaults
            default_settings["vision"] = {
                "endpoint": config.LLM_ENDPOINT.replace("/v1", ""),
                "model": "vision-model",
                "maxTokens": 1024,
                "temperature": 0.3,
            }

        # Apply Home Assistant settings from bridge config if present
        ha_cfg = bridge_cfg.get("homeAssistant", {})
        if ha_cfg and ha_cfg.get("baseUrl") and ha_cfg.get("accessToken"):
            default_settings["homeAssistant"] = ha_cfg

        # Pass providers so chat route can resolve per-Choom/project provider API keys
        providers_cfg = bridge_cfg.get("providers", [])
        if providers_cfg:
            default_settings["providers"] = providers_cfg

        # Merge with any provided settings
        if settings:
            for key, value in settings.items():
                if key in default_settings and isinstance(value, dict):
                    default_settings[key].update(value)
                else:
                    default_settings[key] = value

        # Apply Choom-specific overrides (these take priority over everything)
        if choom.llm_model:
            default_settings["llm"]["model"] = choom.llm_model
        if choom.llm_endpoint:
            default_settings["llm"]["endpoint"] = choom.llm_endpoint
        if choom.image_settings:
            img_settings = choom.image_settings if isinstance(choom.image_settings, dict) else {}
            default_settings["imageGen"] = {**default_settings.get("imageGen", {}), **img_settings}

        logger.info(f"Sending to {choom_name} with LLM model={default_settings['llm'].get('model', 'default')}, endpoint={default_settings['llm'].get('endpoint', 'default')}")

        # Send message to chat API
        payload = {
            "choomId": choom.id,
            "chatId": chat_id,
            "message": message,
            "settings": default_settings,
        }

        # Use streaming endpoint
        response = self._make_request(
            "POST",
            "/api/chat",
            json=payload,
            stream=True
        )

        # Parse SSE response (use larger chunk_size for efficiency with large image payloads)
        content = ""
        tool_calls = []
        tool_results = []
        images = []

        for line in response.iter_lines(chunk_size=8192):
            if line:
                line = line.decode('utf-8')
                if line.startswith('data: '):
                    try:
                        data = json.loads(line[6:])
                        event_type = data.get('type')

                        if event_type == 'content':
                            content += data.get('content', '')
                        elif event_type == 'tool_call':
                            tool_calls.append(data.get('toolCall', {}))
                            logger.info(f"Tool call: {data.get('toolCall', {}).get('name', 'unknown')}")
                        elif event_type == 'tool_result':
                            tool_results.append(data.get('toolResult', {}))
                        elif event_type == 'image_generated':
                            img_url = data.get('imageUrl')
                            img_id = data.get('imageId')
                            img_prompt = data.get('prompt')
                            url_preview = f"{img_url[:60]}..." if img_url and len(img_url) > 60 else img_url
                            logger.info(f"Image generated: id={img_id}, url_len={len(img_url) if img_url else 0}, url_start={url_preview}")
                            images.append({
                                'url': img_url,
                                'id': img_id,
                                'prompt': img_prompt,
                            })
                        elif event_type == 'done':
                            break
                        elif event_type == 'error':
                            logger.error(f"Chat error: {data.get('error')}")
                            raise Exception(data.get('error', 'Unknown error'))
                    except json.JSONDecodeError as e:
                        logger.warning(f"JSON decode error in SSE: {e} (line_len={len(line)})")

        logger.info(f"Chat complete - content: {len(content)} chars, tool_calls: {len(tool_calls)}, tool_results: {len(tool_results)}, images: {len(images)}")

        return ChatResponse(
            content=content,
            tool_calls=tool_calls,
            tool_results=tool_results,
            images=images,
            chat_id=chat_id,
        )

    def get_weather(self, location: Optional[str] = None) -> Dict[str, Any]:
        """Get current weather"""
        params = {}
        if location:
            params['location'] = location

        response = self._make_request("GET", "/api/weather", params=params)
        return response.json()

    def search_web(self, query: str, max_results: int = 5) -> Dict[str, Any]:
        """Perform web search"""
        response = self._make_request(
            "GET",
            "/api/search",
            params={"query": query, "maxResults": max_results}
        )
        return response.json()

    def check_health(self) -> Dict[str, Any]:
        """Check health of all services using actual configured endpoints"""
        try:
            response = self._make_request("POST", "/api/health", json={
                "endpoints": {
                    "llm": config.LLM_ENDPOINT,
                    "memory": config.MEMORY_ENDPOINT,
                    "tts": config.TTS_ENDPOINT,
                    "stt": config.STT_ENDPOINT,
                    "imageGen": "http://localhost:7860",
                }
            })
            return response.json()
        except Exception as e:
            logger.error(f"Health check failed: {e}")
            return {"error": str(e), "services": {}}


class TTSClient:
    """Client for Text-to-Speech service"""

    def __init__(self, endpoint: str = None):
        self.endpoint = endpoint or config.TTS_ENDPOINT

    def synthesize(self, text: str, voice: str = "sophie", output_path: str = None) -> Optional[str]:
        """
        Convert text to speech

        Args:
            text: Text to synthesize
            voice: Voice ID to use
            output_path: Path to save audio file

        Returns:
            Path to audio file or None on failure
        """
        try:
            response = requests.post(
                f"{self.endpoint}/v1/audio/speech",
                json={
                    "input": text,
                    "voice": voice
                },
                timeout=60
            )

            if response.status_code == 200:
                # Check if we got audio data (WAV starts with RIFF)
                if response.content[:4] == b'RIFF':
                    if output_path:
                        with open(output_path, 'wb') as f:
                            f.write(response.content)
                        return output_path
                    else:
                        # Return base64 encoded audio
                        return base64.b64encode(response.content).decode()
                else:
                    logger.error(f"TTS returned non-audio content")
                    return None

            logger.error(f"TTS failed: {response.status_code}")
            return None

        except Exception as e:
            logger.error(f"TTS error: {e}")
            return None


class STTClient:
    """Client for Speech-to-Text service"""

    def __init__(self, endpoint: str = None):
        self.endpoint = endpoint or config.STT_ENDPOINT

    def transcribe(self, audio_path: str) -> Optional[str]:
        """
        Transcribe audio file to text

        Args:
            audio_path: Path to audio file

        Returns:
            Transcribed text or None on failure
        """
        try:
            with open(audio_path, 'rb') as f:
                files = {'file': (os.path.basename(audio_path), f, 'audio/ogg')}
                response = requests.post(
                    f"{self.endpoint}/v1/audio/transcriptions",
                    files=files,
                    timeout=60
                )

            if response.status_code == 200:
                data = response.json()
                return data.get('text', '')

            logger.error(f"STT failed: {response.status_code}")
            return None

        except Exception as e:
            logger.error(f"STT error: {e}")
            return None


# Singleton instances
_choom_client: Optional[ChoomClient] = None
_tts_client: Optional[TTSClient] = None
_stt_client: Optional[STTClient] = None


def get_choom_client() -> ChoomClient:
    global _choom_client
    if _choom_client is None:
        _choom_client = ChoomClient()
    return _choom_client


def get_tts_client() -> TTSClient:
    global _tts_client
    if _tts_client is None:
        _tts_client = TTSClient()
    return _tts_client


def get_stt_client() -> STTClient:
    global _stt_client
    if _stt_client is None:
        _stt_client = STTClient()
    return _stt_client
