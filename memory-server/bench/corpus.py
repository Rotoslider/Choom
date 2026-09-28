"""
What a Choom could know at a moment in time, as searchable items.

Every item carries its source, speaker and UTC time so a benchmark can ask
"what was true about X at time T" with nothing written after T visible:

  memory — her long-term memories (title + content)
  chat   — her private chats with Donny (both sides), not wake-ups
  room   — group rooms she is a member of (everyone's lines)
  wake   — her own wake-up / briefing output (where stale beliefs live)

Read-only: both databases are opened with mode=ro.
"""
import os
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path

APP_DB = Path(__file__).resolve().parents[2] / "nextjs-app" / "prisma" / "dev.db"
MEMORY_DB = Path(os.path.expanduser(
    "~/Library/Application Support/Choom/ai_Choom_memory/memory_db/memories.db"))
LOCAL = timezone(timedelta(hours=-6))  # MDT — display only

CHOOMS = {
    "Genesis": {"choom_id": "cml8frtm300001149xgozcbh3", "companion_id": "cmkkmsg0b0000w12g5fjkumzk"},
    "Aloy": {"choom_id": "cmlyeo9e60022dpz6dng26zv5", "companion_id": "cmlyeo9e60022dpz6dng2yyy5"},
    "Eve": {"choom_id": "cmmilix9z0000yna6gtaxvdgn", "companion_id": "cmmilix9z0000yna6gtaxvdgn"},
}

CHUNK_CHARS = 1000
_IMG = re.compile(r'\[User attached image: [^\]]*\] Please analyze this image using the analyze_image tool with image_path="[^"]*"\.\s*')
_ROOM_IMG = re.compile(r'_\[image shared to the room by the owner[^\]]*\]_')


@dataclass
class Item:
    id: str
    source: str   # memory | chat | room | wake
    ts: float     # UTC epoch seconds
    speaker: str
    text: str     # what gets embedded / matched / shown

    @property
    def when(self) -> str:
        return datetime.fromtimestamp(self.ts, LOCAL).strftime("%a %b %-d %-I:%M %p")


def _ro(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def _mem_ts(s: str) -> float:
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _chunks(text: str):
    """Paragraph-aligned pieces of at most CHUNK_CHARS (a long reply is several items)."""
    text = text.strip()
    if len(text) <= CHUNK_CHARS * 1.2:
        return [text]
    out, cur = [], ""
    for para in re.split(r"\n\s*\n", text):
        while len(para) > CHUNK_CHARS:
            if cur:
                out.append(cur); cur = ""
            out.append(para[:CHUNK_CHARS]); para = para[CHUNK_CHARS:]
        if len(cur) + len(para) + 2 > CHUNK_CHARS and cur:
            out.append(cur); cur = para
        else:
            cur = f"{cur}\n\n{para}" if cur else para
    if cur:
        out.append(cur)
    return out


def load(choom: str, include=("memory", "chat", "room", "wake")) -> list:
    """Everything this Choom has, oldest first. Filter by .ts for an as-of view."""
    ids = CHOOMS[choom]
    items = []
    if "memory" in include:
        with _ro(MEMORY_DB) as db:
            for mid, title, content, ts in db.execute(
                    "SELECT id, title, content, timestamp FROM memories WHERE companion_id = ?",
                    (ids["companion_id"],)):
                items.append(Item(mid, "memory", _mem_ts(ts), choom, f"{title}\n{content}"))
    with _ro(APP_DB) as db:
        if "chat" in include or "wake" in include:
            for mid, ms, role, content, title in db.execute(
                    """SELECT m.id, m.createdAt, m.role, m.content, c.title FROM Message m
                       JOIN Chat c ON c.id = m.chatId WHERE c.choomId = ? AND m.role IN ('user','assistant')""",
                    (ids["choom_id"],)):
                title = title or ""
                wake = title.startswith("[Autonomous]") or title.startswith("Briefing")
                if title.startswith("[Delegation]") or not (content or "").strip():
                    continue
                if wake:
                    if "wake" not in include or role != "assistant":
                        continue  # the user rows of a wake-up chat are scheduler prompts
                    source, speaker = "wake", choom
                else:
                    if "chat" not in include:
                        continue
                    source, speaker = "chat", ("Donny" if role == "user" else choom)
                text = _IMG.sub("[photo] ", content)
                for i, piece in enumerate(_chunks(text)):
                    where = "wake-up" if wake else "private chat"
                    items.append(Item(f"{mid}#{i}", source, ms / 1000, speaker,
                                      f"[{where} · {speaker}] {piece}"))
        if "room" in include:
            for mid, ms, author, content, room in db.execute(
                    """SELECT g.id, g.createdAt, g.authorName, g.content, r.title FROM GroupMessage g
                       JOIN GroupRoom r ON r.id = g.roomId
                       WHERE g.roomId IN (SELECT roomId FROM GroupParticipant WHERE choomId = ?)""",
                    (ids["choom_id"],)):
                if not (content or "").strip():
                    continue
                text = _ROOM_IMG.sub("[photo]", content)
                for i, piece in enumerate(_chunks(text)):
                    items.append(Item(f"{mid}#{i}", "room", ms / 1000, author or "Donny",
                                      f"[room {room} · {author or 'Donny'}] {piece}"))
    items.sort(key=lambda it: it.ts)
    return items


def as_of(items: list, t: float) -> list:
    return [it for it in items if it.ts < t]
