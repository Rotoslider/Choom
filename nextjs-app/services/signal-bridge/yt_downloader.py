"""
YouTube Music Downloader
Downloads music from configured YouTube channels as high-quality MP3s
with full ID3 tags and embedded album art.
"""
import json
import logging
import os
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

from paths import WORKSPACE_ROOT
PROJECT_NAME = "YouTube_Music"
PROJECT_DIR = os.path.join(WORKSPACE_ROOT, PROJECT_NAME)

# Extra flat-listing entries to fetch beyond (skipped ids + max_videos), so a
# cluster of gated/unavailable uploads can't starve a run of downloadable tracks.
LISTING_HEADROOM = 30

YT_DLP_BIN = "/usr/bin/yt-dlp"
YT_DLP_COOKIES = os.path.join(os.path.dirname(__file__), "youtube-cookies.txt")
YT_DLP_EXTRA_ARGS = [
    "--js-runtimes", "node",
    "--remote-components", "ejs:github",
    # YouTube broke android_vr/tv media delivery on 2026-08-13/14 (HTTP 403:
    # Forbidden on googlevideo URLs missing a PO token). The web_embedded player
    # client still serves media URLs without a token; android_vr/tv/web/web_safari
    # either 403, hit DRM, or return formats without URLs.
    "--extractor-args", "youtube:player_client=web_embedded",
    *(["--cookies", YT_DLP_COOKIES] if os.path.exists(YT_DLP_COOKIES) else []),
]


def _normalize_unicode_text(text: str) -> str:
    """Convert fancy Unicode characters (bold, italic, etc.) to plain ASCII equivalents."""
    import unicodedata
    result = []
    for ch in text:
        # Try NFKD decomposition first — maps bold/italic/script variants to base chars
        decomposed = unicodedata.normalize("NFKD", ch)
        # Keep only non-combining characters
        cleaned = "".join(c for c in decomposed if not unicodedata.combining(c))
        result.append(cleaned if cleaned else ch)
    return "".join(result)


def _sanitize_filename(name: str) -> str:
    """Sanitize a string for use as a filename/directory name."""
    # Normalize fancy Unicode (bold, italic, etc.) to plain ASCII
    name = _normalize_unicode_text(name)
    # Remove or replace problematic characters
    name = re.sub(r'[<>:"/\\|?*]', '_', name)
    name = re.sub(r'\s+', ' ', name).strip()
    name = name.strip('.')
    return name or "Unknown"


def _clean_title(title: str) -> str:
    """Clean a video title: normalize Unicode and strip everything after ' // '."""
    title = _normalize_unicode_text(title)
    # Strip genre/tag lists after " // "
    if " // " in title:
        title = title.split(" // ", 1)[0].strip()
    return title


# Substrings that identify a permanently-inaccessible members-only / paid-tier
# video. These are NOT transient auth failures — retrying them wastes backoff,
# and counting them toward the channel abort threshold (or re-reporting them
# every run) just spams errors. We detect them and skip permanently instead.
_MEMBERS_ONLY_MARKERS = (
    "members-only",
    "members on level",
    "join this channel to get access",
    "available to this channel's members",
)


def _is_members_only_error(stderr: str) -> bool:
    """True if a yt-dlp error indicates members-only / paid-tier gated content."""
    low = (stderr or "").lower()
    return any(marker in low for marker in _MEMBERS_ONLY_MARKERS)


class YouTubeDownloader:
    """Downloads music from YouTube channels as tagged MP3s."""

    def __init__(self):
        self.project_dir = PROJECT_DIR

    def ensure_project(self):
        """Create the YouTube_Music workspace project if it doesn't exist."""
        os.makedirs(self.project_dir, exist_ok=True)

        meta_path = os.path.join(self.project_dir, ".choom-project.json")
        if not os.path.exists(meta_path):
            meta = {
                "name": "YouTube Music",
                "description": "Auto-downloaded music from YouTube channels",
                "created": datetime.now().isoformat(),
                "lastModified": datetime.now().isoformat(),
                "tags": ["music", "youtube", "auto-download"],
            }
            with open(meta_path, "w") as f:
                json.dump(meta, f, indent=2)
            logger.info(f"Created YouTube_Music project at {self.project_dir}")

    def get_channel_dir(self, channel_name: str) -> str:
        """Return (and create) a sanitized subfolder for a channel."""
        safe_name = _sanitize_filename(channel_name)
        channel_dir = os.path.join(self.project_dir, safe_name)
        os.makedirs(channel_dir, exist_ok=True)
        return channel_dir

    # ------------------------------------------------------------------
    # Per-channel download history
    # ------------------------------------------------------------------

    def load_history(self, channel_dir: str) -> Dict[str, Any]:
        """Load download history for a channel directory."""
        hist_path = os.path.join(channel_dir, "download_history.json")
        if os.path.exists(hist_path):
            try:
                with open(hist_path, "r") as f:
                    return json.load(f)
            except Exception as e:
                logger.warning(f"Corrupt history at {hist_path}: {e}")
        return {"downloaded_ids": [], "members_only_ids": [], "unavailable_ids": [], "last_check": None, "total_downloaded": 0}

    def save_history(self, channel_dir: str, data: Dict[str, Any]):
        """Persist download history for a channel directory."""
        hist_path = os.path.join(channel_dir, "download_history.json")
        with open(hist_path, "w") as f:
            json.dump(data, f, indent=2)

    # ------------------------------------------------------------------
    # yt-dlp wrappers
    # ------------------------------------------------------------------

    def list_channel_videos(self, url: str, max_videos: int = 10) -> List[Dict[str, str]]:
        """List recent videos from a channel/playlist URL.
        Returns list of {id, title}.
        """
        cmd = [
            YT_DLP_BIN,
            *YT_DLP_EXTRA_ARGS,
            "--flat-playlist",
            "--playlist-end", str(max_videos),
            "--print", "%(id)s|%(title)s",
            "--no-warnings",
            url,
        ]
        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=120
            )
            if result.returncode != 0:
                logger.error(f"yt-dlp list failed for {url}: {result.stderr[:500]}")
                return []

            videos = []
            for line in result.stdout.strip().split("\n"):
                line = line.strip()
                if "|" not in line:
                    continue
                vid_id, title = line.split("|", 1)
                videos.append({"id": vid_id.strip(), "title": title.strip()})
            return videos

        except subprocess.TimeoutExpired:
            logger.error(f"yt-dlp list timed out for {url}")
            return []
        except Exception as e:
            logger.error(f"yt-dlp list error for {url}: {e}")
            return []

    def get_video_metadata(self, video_id: str, retries: int = 2) -> Tuple[Optional[Dict[str, Any]], str]:
        """Fetch full metadata for a video via yt-dlp --dump-json.
        Retries with exponential backoff to handle transient YouTube blocks.

        Returns (metadata, error_kind):
          - (dict, "")            on success
          - (None, "members_only") for gated content — do NOT retry or count as
            a failure; it will never succeed with the current cookies
          - (None, "failed")       for a transient/auth failure (retries exhausted)
        """
        cmd = [
            YT_DLP_BIN,
            *YT_DLP_EXTRA_ARGS,
            "--dump-json",
            "--format", "bestaudio*/bestaudio/best",
            "--no-warnings",
            f"https://www.youtube.com/watch?v={video_id}",
        ]
        last_err = ""
        for attempt in range(1 + retries):
            try:
                if attempt > 0:
                    delay = 5 * (2 ** (attempt - 1))  # 5s, 10s
                    logger.info(f"  Retry {attempt}/{retries} for {video_id} metadata (waiting {delay}s)")
                    time.sleep(delay)
                result = subprocess.run(
                    cmd, capture_output=True, text=True, timeout=60
                )
                if result.returncode != 0:
                    last_err = result.stderr[:300]
                    # Members-only content will never succeed — bail immediately
                    # instead of burning retry backoff on it.
                    if _is_members_only_error(result.stderr):
                        logger.info(f"  Skipping members-only video {video_id}")
                        return None, "members_only"
                    logger.warning(f"yt-dlp metadata attempt {attempt + 1} failed for {video_id}: {last_err}")
                    continue
                return json.loads(result.stdout), ""
            except Exception as e:
                last_err = str(e)
                logger.warning(f"yt-dlp metadata attempt {attempt + 1} error for {video_id}: {e}")
        logger.error(f"yt-dlp metadata failed after {1 + retries} attempts for {video_id}: {last_err}")
        return None, "failed"

    def download_as_mp3(self, video_id: str, output_dir: str) -> Optional[str]:
        """Download a video as high-quality MP3 with thumbnail.
        Returns the path to the MP3 file, or None on failure.
        """
        output_template = os.path.join(output_dir, "%(title)s.%(ext)s")
        cmd = [
            YT_DLP_BIN,
            *YT_DLP_EXTRA_ARGS,
            "--format", "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio",
            "-x",
            "--audio-format", "mp3",
            "--audio-quality", "0",
            "--write-thumbnail",
            "--convert-thumbnails", "jpg",
            "--embed-metadata",
            "--output", output_template,
            "--no-warnings",
            f"https://www.youtube.com/watch?v={video_id}",
        ]
        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=600
            )
            if result.returncode != 0:
                logger.error(f"yt-dlp download failed for {video_id}: {result.stderr[:500]}")
                return None

            # Find the resulting MP3 file
            # yt-dlp prints the destination path; also scan directory
            for line in result.stdout.split("\n"):
                if "[ExtractAudio] Destination:" in line:
                    mp3_path = line.split("Destination:", 1)[1].strip()
                    if os.path.exists(mp3_path):
                        return mp3_path

            # Fallback: find the most recently created .mp3 in output_dir
            mp3_files = sorted(
                Path(output_dir).glob("*.mp3"),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            if mp3_files:
                return str(mp3_files[0])

            logger.error(f"No MP3 file found after downloading {video_id}")
            return None

        except subprocess.TimeoutExpired:
            logger.error(f"yt-dlp download timed out for {video_id}")
            return None
        except Exception as e:
            logger.error(f"yt-dlp download error for {video_id}: {e}")
            return None

    # ------------------------------------------------------------------
    # ID3 tagging via mutagen
    # ------------------------------------------------------------------

    def apply_id3_tags(self, mp3_path: str, metadata: Dict[str, Any]):
        """Apply ID3 tags to an MP3 file using metadata from yt-dlp."""
        try:
            from mutagen.mp3 import MP3
            from mutagen.id3 import (
                ID3, TIT2, TPE1, TALB, TCON, TDRC, APIC, COMM, ID3NoHeaderError
            )

            # Load or create ID3 tags — use ID3=None to skip header parsing
            # on files without an existing ID3 header (avoids ID3NoHeaderError)
            try:
                audio = MP3(mp3_path)
                if audio.tags is None:
                    audio.add_tags()
            except ID3NoHeaderError:
                audio = MP3(mp3_path, ID3=None)
                audio.add_tags()

            tags = audio.tags

            # Title — clean fancy Unicode and strip genre suffixes
            title = metadata.get("title", "") or metadata.get("track", "")
            if title:
                title = _clean_title(title)
                tags.add(TIT2(encoding=3, text=[title]))

            # Artist
            artist = (
                metadata.get("artist")
                or metadata.get("creator")
                or metadata.get("uploader")
                or metadata.get("channel")
                or ""
            )
            if artist:
                artist = _normalize_unicode_text(artist)
                tags.add(TPE1(encoding=3, text=[artist]))

            # Album — use album if available, otherwise channel name
            album = metadata.get("album") or metadata.get("channel") or ""
            if album:
                album = _normalize_unicode_text(album)
                tags.add(TALB(encoding=3, text=[album]))

            # Genre
            genre = metadata.get("genre") or ""
            if genre:
                tags.add(TCON(encoding=3, text=[genre]))

            # Year
            upload_date = metadata.get("upload_date", "")  # YYYYMMDD
            if upload_date and len(upload_date) >= 4:
                tags.add(TDRC(encoding=3, text=[upload_date[:4]]))

            # Comment — YouTube URL
            video_id = metadata.get("id", "")
            if video_id:
                url = f"https://www.youtube.com/watch?v={video_id}"
                tags.add(COMM(encoding=3, lang="eng", desc="Source", text=[url]))

            # Embedded album art — look for .jpg thumbnail next to the MP3
            mp3_base = os.path.splitext(mp3_path)[0]
            thumb_candidates = [
                f"{mp3_base}.jpg",
                f"{mp3_base}.webp",
                f"{mp3_base}.png",
            ]
            for thumb_path in thumb_candidates:
                if os.path.exists(thumb_path):
                    try:
                        with open(thumb_path, "rb") as img_file:
                            img_data = img_file.read()
                        mime = "image/jpeg" if thumb_path.endswith(".jpg") else "image/png"
                        tags.add(APIC(
                            encoding=3,
                            mime=mime,
                            type=3,  # Cover (front)
                            desc="Cover",
                            data=img_data,
                        ))
                        # Remove the thumbnail file after embedding
                        os.remove(thumb_path)
                        logger.debug(f"Embedded album art from {thumb_path}")
                    except Exception as e:
                        logger.warning(f"Failed to embed thumbnail {thumb_path}: {e}")
                    break

            audio.save()
            logger.info(f"Applied ID3 tags to {os.path.basename(mp3_path)}")

        except ImportError:
            logger.error("mutagen not installed — cannot apply ID3 tags")
        except Exception as e:
            logger.error(f"Failed to apply ID3 tags to {mp3_path}: {e}")

    # ------------------------------------------------------------------
    # Channel processing orchestration
    # ------------------------------------------------------------------

    def process_channel(
        self, channel_config: Dict[str, Any], max_videos: int = 3
    ) -> Dict[str, Any]:
        """Process a single channel: list, filter, download, tag.
        Returns {channel_name, downloaded[], errors[], skipped}.
        """
        name = channel_config.get("name", "Unknown")
        url = channel_config.get("url", "")
        result = {"channel_name": name, "downloaded": [], "errors": [], "members_only": [], "unavailable": [], "skipped": 0}

        if not url:
            result["errors"].append("No URL configured")
            return result

        logger.info(f"Processing channel: {name} ({url})")

        channel_dir = self.get_channel_dir(name)
        history = self.load_history(channel_dir)
        known_ids = set(history.get("downloaded_ids", []))
        members_only_ids = set(history.get("members_only_ids", []))
        unavailable_ids = set(history.get("unavailable_ids", []))
        # Videos we already have, are permanently gated, or are undownloadable
        # (e.g. 24/7 livestreams) — skip them so the listing window can reach
        # still-downloadable tracks further down.
        skip_ids = known_ids | members_only_ids | unavailable_ids

        # List recent videos. We want up to max_videos *downloadable* tracks, but
        # recent uploads may be gated/unavailable, so pull well past everything we
        # already skip plus generous headroom — otherwise a cluster of members-only
        # uploads starves the run (e.g. a 9-video window with 5 gated yields 1). The
        # download loop still stops at max_videos, and skipped ids are filtered
        # cheaply (no probe/delay), so over-fetching the flat listing is inexpensive.
        listing_depth = len(skip_ids) + max_videos + LISTING_HEADROOM
        videos = self.list_channel_videos(url, max_videos=listing_depth)
        if not videos:
            logger.warning(f"No videos found for channel: {name}")
            result["errors"].append("No videos found or listing failed")
            return result

        downloaded_count = 0
        consecutive_meta_failures = 0
        videos_processed = 0
        for video in videos:
            vid_id = video["id"]

            if vid_id in skip_ids:
                result["skipped"] += 1
                continue

            if downloaded_count >= max_videos:
                break

            # Delay between videos to avoid YouTube rate-limiting
            if videos_processed > 0:
                time.sleep(3)
            videos_processed += 1

            logger.info(f"  Downloading: {video['title']} ({vid_id})")

            # Get full metadata
            meta, err_kind = self.get_video_metadata(vid_id)
            if not meta:
                if err_kind == "members_only":
                    # Permanently gated — record it once so future runs skip it
                    # silently (no re-notify), and do NOT let it count toward the
                    # auth-failure abort threshold or reset it (it's orthogonal).
                    result["members_only"].append(video["title"])
                    members_only_ids.add(vid_id)
                    skip_ids.add(vid_id)
                    history["members_only_ids"] = sorted(members_only_ids)
                    self.save_history(channel_dir, history)
                    continue
                result["errors"].append(f"Metadata failed: {video['title']}")
                consecutive_meta_failures += 1
                # Abort channel if 3+ consecutive metadata failures (likely auth/bot issue)
                if consecutive_meta_failures >= 3:
                    logger.warning(f"  Aborting channel {name}: {consecutive_meta_failures} consecutive metadata failures (likely YouTube auth issue)")
                    result["errors"].append(f"Aborted after {consecutive_meta_failures} consecutive metadata failures")
                    break
                continue
            consecutive_meta_failures = 0  # Reset on success

            # 24/7 livestreams have no finite audio stream — attempting a
            # download burns the 600s timeout and errors every run. Record
            # once, skip forever (same pattern as members-only gating).
            if meta.get("is_live"):
                logger.info(f"  Skipping live video {vid_id}")
                result["unavailable"].append(video["title"])
                unavailable_ids.add(vid_id)
                skip_ids.add(vid_id)
                history["unavailable_ids"] = sorted(unavailable_ids)
                self.save_history(channel_dir, history)
                continue

            # Download as MP3
            mp3_path = self.download_as_mp3(vid_id, channel_dir)
            if not mp3_path:
                result["errors"].append(f"Download failed: {video['title']}")
                continue

            # Apply ID3 tags
            self.apply_id3_tags(mp3_path, meta)

            # Rename file to cleaned title
            clean = _clean_title(meta.get("title", ""))
            if clean:
                clean_base = _sanitize_filename(clean)
                clean_filename = clean_base + ".mp3"
                clean_path = os.path.join(os.path.dirname(mp3_path), clean_filename)
                # If a file with this name already exists, append the video ID
                if os.path.exists(clean_path) and clean_path != mp3_path:
                    clean_filename = f"{clean_base} [{vid_id}].mp3"
                    clean_path = os.path.join(os.path.dirname(mp3_path), clean_filename)
                if clean_path != mp3_path:
                    try:
                        os.rename(mp3_path, clean_path)
                        mp3_path = clean_path
                        logger.debug(f"Renamed to {clean_filename}")
                    except OSError as e:
                        logger.warning(f"Failed to rename {mp3_path}: {e}")

            # Update history
            history["downloaded_ids"].append(vid_id)
            history["total_downloaded"] = history.get("total_downloaded", 0) + 1
            history["last_check"] = datetime.now().isoformat()
            self.save_history(channel_dir, history)
            known_ids.add(vid_id)
            skip_ids.add(vid_id)

            result["downloaded"].append(video["title"])
            downloaded_count += 1

            # Rate-limit delay between downloads
            time.sleep(2)

        # Update last_check even if nothing new
        history["last_check"] = datetime.now().isoformat()
        self.save_history(channel_dir, history)

        logger.info(
            f"Channel {name}: {len(result['downloaded'])} downloaded, "
            f"{result['skipped']} skipped, {len(result['errors'])} errors, "
            f"{len(result['unavailable'])} unavailable"
        )
        return result

    def run_all(
        self, channels: List[Dict[str, Any]], max_per_channel: int = 3
    ) -> List[Dict[str, Any]]:
        """Process all enabled channels sequentially."""
        self.ensure_project()
        results = []
        for ch in channels:
            if not ch.get("enabled", True):
                continue
            result = self.process_channel(ch, max_videos=max_per_channel)
            results.append(result)
        return results

    @staticmethod
    def format_summary(results: List[Dict[str, Any]]) -> str:
        """Format results into a human-readable summary for Signal notification."""
        if not results:
            return "YouTube Music: No channels to process."

        total_downloaded = 0
        total_errors = 0
        lines = ["YouTube Music Download Summary\n"]

        for r in results:
            name = r["channel_name"]
            dl = r["downloaded"]
            errs = r["errors"]
            gated = r.get("members_only", [])
            unavail = r.get("unavailable", [])
            total_downloaded += len(dl)
            total_errors += len(errs)

            if dl:
                lines.append(f"{name}: {len(dl)} new")
                for title in dl:
                    lines.append(f"  - {title}")
                if gated or unavail:
                    notes = []
                    if gated:
                        notes.append(f"{len(gated)} members-only")
                    if unavail:
                        notes.append(f"{len(unavail)} live")
                    lines.append(f"  ({', '.join(notes)}, skipped)")
            elif errs:
                lines.append(f"{name}: {len(errs)} error(s)")
                for err in errs:
                    lines.append(f"  ! {err}")
            elif gated or unavail:
                notes = []
                if gated:
                    notes.append(f"{len(gated)} members-only")
                if unavail:
                    notes.append(f"{len(unavail)} live")
                lines.append(f"{name}: {', '.join(notes)} (skipped)")
                for title in gated + unavail:
                    lines.append(f"  ~ {title}")
            else:
                lines.append(f"{name}: Up to date")

        if total_downloaded == 0 and total_errors == 0:
            return "YouTube Music: All channels up to date, no new downloads."

        lines.append(f"\nTotal: {total_downloaded} downloaded, {total_errors} error(s)")
        return "\n".join(lines)
