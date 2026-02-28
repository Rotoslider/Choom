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
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

from paths import WORKSPACE_ROOT
PROJECT_NAME = "YouTube_Music"
PROJECT_DIR = os.path.join(WORKSPACE_ROOT, PROJECT_NAME)

YT_DLP_BIN = "/usr/bin/yt-dlp"
YT_DLP_EXTRA_ARGS = [
    "--cookies-from-browser", "firefox",
    "--js-runtimes", "node",
    "--remote-components", "ejs:github",
]


def _sanitize_filename(name: str) -> str:
    """Sanitize a string for use as a filename/directory name."""
    # Remove or replace problematic characters
    name = re.sub(r'[<>:"/\\|?*]', '_', name)
    name = re.sub(r'\s+', ' ', name).strip()
    name = name.strip('.')
    return name or "Unknown"


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
        return {"downloaded_ids": [], "last_check": None, "total_downloaded": 0}

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

    def get_video_metadata(self, video_id: str) -> Optional[Dict[str, Any]]:
        """Fetch full metadata for a video via yt-dlp --dump-json."""
        cmd = [
            YT_DLP_BIN,
            *YT_DLP_EXTRA_ARGS,
            "--dump-json",
            "--no-warnings",
            f"https://www.youtube.com/watch?v={video_id}",
        ]
        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=60
            )
            if result.returncode != 0:
                logger.error(f"yt-dlp metadata failed for {video_id}: {result.stderr[:300]}")
                return None
            return json.loads(result.stdout)
        except Exception as e:
            logger.error(f"yt-dlp metadata error for {video_id}: {e}")
            return None

    def download_as_mp3(self, video_id: str, output_dir: str) -> Optional[str]:
        """Download a video as high-quality MP3 with thumbnail.
        Returns the path to the MP3 file, or None on failure.
        """
        output_template = os.path.join(output_dir, "%(title)s.%(ext)s")
        cmd = [
            YT_DLP_BIN,
            *YT_DLP_EXTRA_ARGS,
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
                cmd, capture_output=True, text=True, timeout=300
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

            # Load or create ID3 tags
            try:
                audio = MP3(mp3_path)
                if audio.tags is None:
                    audio.add_tags()
            except ID3NoHeaderError:
                audio = MP3(mp3_path)
                audio.add_tags()

            tags = audio.tags

            # Title
            title = metadata.get("title", "") or metadata.get("track", "")
            if title:
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
                tags.add(TPE1(encoding=3, text=[artist]))

            # Album — use album if available, otherwise channel name
            album = metadata.get("album") or metadata.get("channel") or ""
            if album:
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
        result = {"channel_name": name, "downloaded": [], "errors": [], "skipped": 0}

        if not url:
            result["errors"].append("No URL configured")
            return result

        logger.info(f"Processing channel: {name} ({url})")

        channel_dir = self.get_channel_dir(name)
        history = self.load_history(channel_dir)
        known_ids = set(history.get("downloaded_ids", []))

        # List recent videos
        videos = self.list_channel_videos(url, max_videos=max_videos + len(known_ids))
        if not videos:
            logger.warning(f"No videos found for channel: {name}")
            result["errors"].append("No videos found or listing failed")
            return result

        downloaded_count = 0
        consecutive_meta_failures = 0
        for video in videos:
            vid_id = video["id"]

            if vid_id in known_ids:
                result["skipped"] += 1
                continue

            if downloaded_count >= max_videos:
                break

            logger.info(f"  Downloading: {video['title']} ({vid_id})")

            # Get full metadata
            meta = self.get_video_metadata(vid_id)
            if not meta:
                result["errors"].append(f"Metadata failed: {video['title']}")
                consecutive_meta_failures += 1
                # Abort channel if 3+ consecutive metadata failures (likely auth/bot issue)
                if consecutive_meta_failures >= 3:
                    logger.warning(f"  Aborting channel {name}: {consecutive_meta_failures} consecutive metadata failures (likely YouTube auth issue)")
                    result["errors"].append(f"Aborted after {consecutive_meta_failures} consecutive metadata failures")
                    break
                continue
            consecutive_meta_failures = 0  # Reset on success

            # Download as MP3
            mp3_path = self.download_as_mp3(vid_id, channel_dir)
            if not mp3_path:
                result["errors"].append(f"Download failed: {video['title']}")
                continue

            # Apply ID3 tags
            self.apply_id3_tags(mp3_path, meta)

            # Update history
            history["downloaded_ids"].append(vid_id)
            history["total_downloaded"] = history.get("total_downloaded", 0) + 1
            history["last_check"] = datetime.now().isoformat()
            self.save_history(channel_dir, history)
            known_ids.add(vid_id)

            result["downloaded"].append(video["title"])
            downloaded_count += 1

            # Rate-limit delay between downloads
            time.sleep(2)

        # Update last_check even if nothing new
        history["last_check"] = datetime.now().isoformat()
        self.save_history(channel_dir, history)

        logger.info(
            f"Channel {name}: {len(result['downloaded'])} downloaded, "
            f"{result['skipped']} skipped, {len(result['errors'])} errors"
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
            total_downloaded += len(dl)
            total_errors += len(errs)

            if dl:
                lines.append(f"{name}: {len(dl)} new")
                for title in dl:
                    lines.append(f"  - {title}")
            elif errs:
                lines.append(f"{name}: {len(errs)} error(s)")
                for err in errs:
                    lines.append(f"  ! {err}")
            else:
                lines.append(f"{name}: Up to date")

        if total_downloaded == 0 and total_errors == 0:
            return "YouTube Music: All channels up to date, no new downloads."

        lines.append(f"\nTotal: {total_downloaded} downloaded, {total_errors} error(s)")
        return "\n".join(lines)
