"""
Conversation index — ForgeRAG's retrieval recipe over what a Choom has lived.

The recall benchmark (memory-server/bench) showed a Choom's own conversations
matter more than any embedding model: with private chats and rooms indexed
next to her memories, a short topic lookup returned the CURRENT truth 88% of
the time against 67% for memory-only search, and 92% vs 40% for a natural
question — with no loss on stable facts.

Sources (all derived: rebuildable from the app DB and memories.db):
  memory — her long-term memories, scoped by companion_id
  chat   — her private chats with Donny, archived ones included. NOT wake-ups,
           briefings, delegations or [group scratch] chats: wake-up output
           carries the stale beliefs ("canvas still due") and indexing it cut
           "newest is right" by 8-11 points on the benchmark.
  room   — every line of every room she is or was a member of, archived rooms
           included. Private chats never surface on a room turn.

Search: BGE-M3 dense top-50 + SQLite FTS5 BM25 top-50, fused by reciprocal
rank, reranked by bge-reranker-v2-m3, then tilted toward recent items with a
14-day half-life — measured best of 3/7/14/30 days; old stable facts still
come back (18/20 vs 15/20 today).

Storage: <data folder>/conversation_index/index.db — chunks, an FTS5 table
kept in step by triggers, and float32 vectors. The vectors are also held in
memory for dense search (~4 KB per chunk).

Ingest: a daemon thread tails the app DB (read-only) and memories.db every
POLL_SECONDS and runs a full reconcile (edits, deletions) every
RECONCILE_SECONDS. Nothing here writes to either source database.
"""
import contextlib
import hashlib
import logging
import math
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Sequence

import numpy as np

logger = logging.getLogger("conversation_index")

EMBED_MODEL = "BAAI/bge-m3"
RERANK_MODEL = "BAAI/bge-reranker-v2-m3"
POLL_SECONDS = 30
RECONCILE_SECONDS = 15 * 60
CHUNK_CHARS = 1000
POOL = 50
HALF_LIFE_DAYS = 14.0
LOCAL = timezone(timedelta(hours=-6))  # display only (MDT)

DEFAULT_APP_DB = Path(__file__).resolve().parents[2] / "nextjs-app" / "prisma" / "dev.db"

# Chats that are not conversation: scheduler/delegator prompts and their
# outputs, and the empty per-turn scratch chats group rooms create.
_SKIP_CHAT_PREFIXES = ("[Autonomous]", "Briefing", "[Delegation]", "[group scratch]")
_IMG = re.compile(r'\[User attached image: [^\]]*\] Please analyze this image using the analyze_image tool with image_path="[^"]*"\.\s*')
_ROOM_IMG = re.compile(r'_\[image shared to the room by the owner[^\]]*\]_')
_WORD = re.compile(r"[A-Za-z0-9]+")
_FTS_STOP = {"the", "and", "for", "has", "had", "did", "was", "are", "with", "about", "any",
             "his", "her", "our", "you", "a", "an", "of", "to", "in", "on", "is", "it", "at", "be"}

EmbedFn = Callable[[Sequence[str]], np.ndarray]
RerankFn = Callable[[str, Sequence[str]], np.ndarray]


def chunk_text(text: str, limit: int = CHUNK_CHARS) -> List[str]:
    """Paragraph-aligned pieces of at most ~limit chars (a long reply is several)."""
    text = text.strip()
    if len(text) <= limit * 1.2:
        return [text] if text else []
    out, cur = [], ""
    for para in re.split(r"\n\s*\n", text):
        while len(para) > limit:
            if cur:
                out.append(cur)
                cur = ""
            out.append(para[:limit])
            para = para[limit:]
        if cur and len(cur) + len(para) + 2 > limit:
            out.append(cur)
            cur = para
        else:
            cur = f"{cur}\n\n{para}" if cur else para
    if cur:
        out.append(cur)
    return out


def _hash(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8", "ignore")).hexdigest()


def _clean(s: str) -> str:
    # Lone UTF-16 surrogates (a JS cut through an emoji) break tokenizers.
    return s.encode("utf-8", "ignore").decode("utf-8")


def _mem_ts(s: str) -> float:
    try:
        dt = datetime.fromisoformat(s)
    except (TypeError, ValueError):
        return 0.0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def fts_query(query: str) -> str:
    """Free text → an FTS5 OR-query of quoted words (no syntax can leak through)."""
    words = [w.lower() for w in _WORD.findall(query) if len(w) >= 2 and w.lower() not in _FTS_STOP]
    return " OR ".join(f'"{w}"' for w in dict.fromkeys(words))


def _load(cls, name: str, **kw):
    """The cached copy first (no network at startup, like the memory store's
    MiniLM); download only when it has never been fetched (~2.3 GB each)."""
    import contextlib
    import io
    with contextlib.redirect_stderr(io.StringIO()):
        try:
            return cls(name, local_files_only=True, **kw)
        except Exception:
            return cls(name, **kw)


def rrf(*rankings: Sequence[int], k: int = 60) -> List[int]:
    score: Dict[int, float] = {}
    for ranking in rankings:
        for pos, rid in enumerate(ranking):
            score[rid] = score.get(rid, 0.0) + 1.0 / (k + pos + 1)
    return sorted(score, key=lambda r: -score[r])


class ConversationIndex:
    def __init__(
        self,
        data_folder: Path,
        app_db: Optional[Path] = None,
        memory_db: Optional[Path] = None,
        embed_fn: Optional[EmbedFn] = None,
        rerank_fn: Optional[RerankFn] = None,
        dim: Optional[int] = None,
    ):
        self.folder = Path(data_folder) / "conversation_index"
        self.folder.mkdir(parents=True, exist_ok=True)
        self.path = self.folder / "index.db"
        self.app_db = Path(app_db or os.environ.get("CHOOM_APP_DB") or DEFAULT_APP_DB)
        self.memory_db = Path(memory_db or Path(data_folder) / "memory_db" / "memories.db")
        self._embed_fn = embed_fn
        self._rerank_fn = rerank_fn
        self._dim = dim
        self._lock = threading.RLock()
        # One model call at a time: the ingest thread and a search request
        # would otherwise run the same models on the GPU concurrently.
        self._model_lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._init_schema()
        self._load_matrix()
        self._rooms_cache: Dict[str, tuple] = {}
        self._companions: Dict[str, str] = {}
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.status = {"state": "idle", "last_ingest": None, "last_reconcile": None, "error": None}

    # ------------------------------------------------------------------ schema

    def _init_schema(self):
        with self._lock:
            self._db.executescript("""
                CREATE TABLE IF NOT EXISTS chunks (
                    rid INTEGER PRIMARY KEY,
                    id TEXT UNIQUE NOT NULL,      -- source:ref#n
                    source TEXT NOT NULL,         -- memory | chat | room
                    owner TEXT NOT NULL,          -- companion_id | choom_id | room_id
                    ref TEXT NOT NULL,            -- memory / message id
                    speaker TEXT NOT NULL,
                    ts REAL NOT NULL,             -- UTC epoch seconds
                    text TEXT NOT NULL,
                    ref_hash TEXT NOT NULL,       -- hash of the whole source row
                    vec BLOB
                );
                CREATE INDEX IF NOT EXISTS chunks_ref ON chunks(source, ref);
                CREATE INDEX IF NOT EXISTS chunks_owner ON chunks(source, owner);
                CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                    text, content='chunks', content_rowid='rid',
                    tokenize='porter unicode61 remove_diacritics 2');
                CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
                    INSERT INTO chunks_fts(rowid, text) VALUES (new.rid, new.text);
                END;
                CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
                    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rid, old.text);
                END;
                CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
            """)
            self._db.commit()

    def _get_state(self, key: str, default: str = "") -> str:
        with self._lock:
            row = self._db.execute("SELECT value FROM state WHERE key = ?", (key,)).fetchone()
        return row[0] if row else default

    def _set_state(self, key: str, value) -> None:
        self._db.execute("INSERT OR REPLACE INTO state(key, value) VALUES (?, ?)", (key, str(value)))

    # ------------------------------------------------------------------ vectors in memory

    def _load_matrix(self):
        with self._lock:
            rows = self._db.execute(
                "SELECT rid, source, owner, ts, vec FROM chunks WHERE vec IS NOT NULL ORDER BY rid").fetchall()
            self._rid = np.array([r[0] for r in rows], dtype=np.int64)
            self._src = np.array([r[1] for r in rows], dtype=object)
            self._own = np.array([r[2] for r in rows], dtype=object)
            self._ts = np.array([r[3] for r in rows], dtype=np.float64)
            if rows:
                self._vec = np.stack([np.frombuffer(r[4], dtype=np.float32) for r in rows])
                self._dim = self._vec.shape[1]
            else:
                self._vec = np.zeros((0, self._dim or 1), dtype=np.float32)

    def _append_matrix(self, entries: List[tuple]):
        """entries: (rid, source, owner, ts, vec)."""
        if not entries:
            return
        with self._lock:
            vecs = np.stack([e[4] for e in entries]).astype(np.float32)
            if self._vec.shape[0] == 0:
                self._vec = vecs
            else:
                self._vec = np.vstack([self._vec, vecs])
            self._rid = np.concatenate([self._rid, [e[0] for e in entries]])
            self._src = np.concatenate([self._src, np.array([e[1] for e in entries], dtype=object)])
            self._own = np.concatenate([self._own, np.array([e[2] for e in entries], dtype=object)])
            self._ts = np.concatenate([self._ts, [e[3] for e in entries]])

    def _drop_matrix(self, rids: Iterable[int]):
        drop = set(rids)
        if not drop:
            return
        with self._lock:
            keep = ~np.isin(self._rid, np.fromiter(drop, dtype=np.int64))
            self._rid, self._src, self._own, self._ts = self._rid[keep], self._src[keep], self._own[keep], self._ts[keep]
            self._vec = self._vec[keep]

    # ------------------------------------------------------------------ models

    def _embed(self, texts: Sequence[str]) -> np.ndarray:
        with self._model_lock:
            return self._embed_locked(texts)

    def _embed_locked(self, texts: Sequence[str]) -> np.ndarray:
        if self._embed_fn is None:
            from sentence_transformers import SentenceTransformer
            import torch
            device = "mps" if torch.backends.mps.is_available() else "cpu"
            model = _load(SentenceTransformer, EMBED_MODEL, device=device)
            model.max_seq_length = 1024
            self._embed_fn = lambda xs: model.encode(list(xs), batch_size=32, normalize_embeddings=True,
                                                     show_progress_bar=False)
            logger.info("Conversation index: loaded %s on %s", EMBED_MODEL, device)
        return np.asarray(self._embed_fn([_clean(t) for t in texts]), dtype=np.float32)

    def _rerank(self, query: str, texts: Sequence[str]) -> np.ndarray:
        with self._model_lock:
            return self._rerank_locked(query, texts)

    def _rerank_locked(self, query: str, texts: Sequence[str]) -> np.ndarray:
        if self._rerank_fn is None:
            import torch
            from sentence_transformers import CrossEncoder
            device = "mps" if torch.backends.mps.is_available() else "cpu"
            model = _load(CrossEncoder, RERANK_MODEL, device=device, max_length=512,
                          activation_fn=torch.nn.Identity())
            # Raw logits: the recency tilt adds ln(0.5)·age/half-life to them.
            self._rerank_fn = lambda q, xs: model.predict([(q, x[:2000]) for x in xs], batch_size=16,
                                                          show_progress_bar=False)
            logger.info("Conversation index: loaded %s on %s", RERANK_MODEL, device)
        return np.asarray(self._rerank_fn(_clean(query), [_clean(t) for t in texts]), dtype=np.float64)

    # ------------------------------------------------------------------ sources

    def _app(self):
        return contextlib.closing(sqlite3.connect(f"file:{self.app_db}?mode=ro", uri=True, timeout=30))

    def _mem(self):
        return contextlib.closing(sqlite3.connect(f"file:{self.memory_db}?mode=ro", uri=True, timeout=30))

    @staticmethod
    def _chat_rows(db: sqlite3.Connection, since_ms: Optional[int] = None):
        """(ref, owner, speaker, ts, text) for private-chat messages."""
        sql = """SELECT m.id, c.choomId, m.role, m.createdAt, m.content, c.title, ch.name
                 FROM Message m JOIN Chat c ON c.id = m.chatId JOIN Choom ch ON ch.id = c.choomId
                 WHERE m.role IN ('user', 'assistant')"""
        args: tuple = ()
        if since_ms is not None:
            sql += " AND m.createdAt >= ?"
            args = (since_ms,)
        for ref, owner, role, ms, content, title, name in db.execute(sql, args):
            title = title or ""
            if title.startswith(_SKIP_CHAT_PREFIXES) or not (content or "").strip():
                continue
            if content.startswith("[You are waking"):
                continue
            speaker = "Donny" if role == "user" else name
            yield ref, owner, speaker, ms / 1000.0, _IMG.sub("[photo] ", content), "private chat"

    @staticmethod
    def _room_rows(db: sqlite3.Connection, since_ms: Optional[int] = None):
        sql = """SELECT g.id, g.roomId, g.authorName, g.createdAt, g.content, r.title
                 FROM GroupMessage g JOIN GroupRoom r ON r.id = g.roomId"""
        args: tuple = ()
        if since_ms is not None:
            sql += " WHERE g.createdAt >= ?"
            args = (since_ms,)
        for ref, room, author, ms, content, title in db.execute(sql, args):
            if not (content or "").strip():
                continue
            yield ref, room, author or "Donny", ms / 1000.0, _ROOM_IMG.sub("[photo]", content), f"room {title or 'Untitled room'}"

    @staticmethod
    def _memory_rows(db: sqlite3.Connection, after_rowid: Optional[int] = None):
        sql = "SELECT rowid, id, companion_id, title, content, timestamp FROM memories"
        args: tuple = ()
        if after_rowid is not None:
            sql += " WHERE rowid > ?"
            args = (after_rowid,)
        for rowid, ref, owner, title, content, ts in db.execute(sql, args):
            yield rowid, ref, owner or "default", "memory", _mem_ts(ts), f"{title}\n{content}"

    # ------------------------------------------------------------------ writes

    def _upsert_many(self, rows: Iterable[tuple], batch: int = 64) -> int:
        """(Re)index source rows (source, ref, owner, speaker, ts, body, where);
        unchanged rows are skipped. Embeds in batches and commits per batch,
        so search works while a backfill runs. Returns rows written."""
        pending: List[tuple] = []
        written = 0

        def flush():
            nonlocal written
            if not pending:
                return
            texts = [t for p in pending for t in p[-1]]
            vecs = self._embed(texts) if texts else np.zeros((0, 1), dtype=np.float32)
            at = 0
            with self._lock:
                for source, ref, owner, speaker, ts, ref_hash, old, pieces in pending:
                    if old:
                        self._db.executemany("DELETE FROM chunks WHERE rid = ?", [(r,) for r in old])
                        self._drop_matrix(old)
                    added = []
                    for i, text in enumerate(pieces):
                        vec = vecs[at]
                        at += 1
                        cur = self._db.execute(
                            "INSERT INTO chunks(id, source, owner, ref, speaker, ts, text, ref_hash, vec) VALUES (?,?,?,?,?,?,?,?,?)",
                            (f"{source}:{ref}#{i}", source, owner, ref, speaker, ts, text, ref_hash,
                             vec.astype(np.float32).tobytes()))
                        added.append((cur.lastrowid, source, owner, ts, vec))
                    self._append_matrix(added)
                self._db.commit()
            written += len(pending)
            pending.clear()

        for source, ref, owner, speaker, ts, body, where in rows:
            ref_hash = _hash(f"{owner}\0{speaker}\0{ts}\0{body}")
            with self._lock:
                old = self._db.execute("SELECT rid, ref_hash FROM chunks WHERE source = ? AND ref = ?",
                                       (source, ref)).fetchall()
            if old and all(h == ref_hash for _, h in old):
                continue
            # Memories stay whole (the benchmark embedded them whole; median
            # 857 chars); conversation lines are chunked and labelled.
            pieces = [body.strip()] if source == "memory" else [f"[{where} · {speaker}] {p}" for p in chunk_text(body)]
            pending.append((source, ref, owner, speaker, ts, ref_hash, [r for r, _ in old], pieces))
            if sum(len(p[-1]) for p in pending) >= batch:
                flush()
        flush()
        return written

    def _delete_refs(self, source: str, refs: Iterable[str]) -> int:
        n = 0
        with self._lock:
            for ref in refs:
                rows = self._db.execute("SELECT rid FROM chunks WHERE source = ? AND ref = ?", (source, ref)).fetchall()
                if rows:
                    self._db.executemany("DELETE FROM chunks WHERE rid = ?", rows)
                    self._drop_matrix([r for (r,) in rows])
                    n += 1
        return n

    # ------------------------------------------------------------------ ingest

    def ingest_once(self) -> Dict[str, int]:
        """New rows since the last pass (with a 5-minute overlap; unchanged rows are skipped)."""
        counts = {"chat": 0, "room": 0, "memory": 0}
        overlap_ms = 5 * 60 * 1000
        with self._app() as app:
            for kind, rows_fn in (("chat", self._chat_rows), ("room", self._room_rows)):
                mark = int(self._get_state(f"{kind}_ms", "0") or 0)
                rows = list(rows_fn(app, max(0, mark - overlap_ms)))
                newest = max([mark] + [int(r[3] * 1000) for r in rows])
                counts[kind] += self._upsert_many((kind, *r) for r in rows)
                with self._lock:
                    self._set_state(f"{kind}_ms", newest)
                    self._db.commit()
        if self.memory_db.is_file():
            with self._mem() as mem:
                mark = int(self._get_state("memory_rowid", "0") or 0)
                rows = list(self._memory_rows(mem, mark))
                newest = max([mark] + [r[0] for r in rows])
                counts["memory"] += self._upsert_many(("memory", *r[1:], "memory") for r in rows)
                with self._lock:
                    self._set_state("memory_rowid", newest)
                    self._db.commit()
        self.status["last_ingest"] = datetime.now(timezone.utc).isoformat()
        return counts

    def reconcile(self) -> Dict[str, int]:
        """Full pass: re-index edited rows, drop rows whose source is gone."""
        counts = {"updated": 0, "deleted": 0}
        live: Dict[str, set] = {"chat": set(), "room": set(), "memory": set()}
        with self._app() as app:
            for kind, rows_fn in (("chat", self._chat_rows), ("room", self._room_rows)):
                rows = list(rows_fn(app))
                live[kind].update(r[0] for r in rows)
                counts["updated"] += self._upsert_many((kind, *r) for r in rows)
        if self.memory_db.is_file():
            with self._mem() as mem:
                rows = list(self._memory_rows(mem))
                live["memory"].update(r[1] for r in rows)
                counts["updated"] += self._upsert_many(("memory", *r[1:], "memory") for r in rows)
        for kind, refs in live.items():
            with self._lock:
                indexed = {r for (r,) in self._db.execute("SELECT DISTINCT ref FROM chunks WHERE source = ?", (kind,))}
            counts["deleted"] += self._delete_refs(kind, indexed - refs)
        with self._lock:
            self._db.commit()
        self.status["last_reconcile"] = datetime.now(timezone.utc).isoformat()
        return counts

    def start(self):
        """Background ingest: a full reconcile first (that is the backfill), then tail."""
        if self._thread and self._thread.is_alive():
            return

        def loop():
            last_reconcile = 0.0
            while not self._stop.is_set():
                try:
                    if time.time() - last_reconcile >= RECONCILE_SECONDS:
                        self.status["state"] = "reconciling"
                        c = self.reconcile()
                        last_reconcile = time.time()
                        if c["updated"] or c["deleted"]:
                            logger.info("Conversation index reconcile: %s", c)
                    self.status["state"] = "ingesting"
                    c = self.ingest_once()
                    if any(c.values()):
                        logger.info("Conversation index ingest: %s", c)
                    self.status["state"] = "idle"
                    self.status["error"] = None
                except Exception as e:  # never take the memory server down
                    self.status["state"] = "error"
                    self.status["error"] = str(e)
                    logger.exception("Conversation index pass failed")
                self._stop.wait(POLL_SECONDS)

        self._thread = threading.Thread(target=loop, name="conversation-index", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=10)
        with self._lock:
            self._db.close()

    # ------------------------------------------------------------------ search

    def _rooms_of(self, choom_id: str) -> List[str]:
        """Rooms she is or was a member of (archived rooms included). Cached 60 s."""
        hit = self._rooms_cache.get(choom_id)
        if hit and time.time() - hit[0] < 60:
            return hit[1]
        with self._app() as app:
            rooms = [r for (r,) in app.execute("SELECT roomId FROM GroupParticipant WHERE choomId = ?", (choom_id,))]
        self._rooms_cache[choom_id] = (time.time(), rooms)
        return rooms

    def companion_of(self, choom_id: str) -> Optional[str]:
        if choom_id not in self._companions:
            with self._app() as app:
                row = app.execute("SELECT companionId FROM Choom WHERE id = ?", (choom_id,)).fetchone()
            self._companions[choom_id] = (row[0] if row and row[0] else choom_id)
        return self._companions[choom_id]

    def search(
        self,
        query: str,
        choom_id: str,
        companion_id: Optional[str] = None,
        *,
        room_turn: bool = False,
        as_of: Optional[float] = None,
        sources: Optional[Iterable[str]] = None,
        k: int = 5,
        pool: int = POOL,
        half_life_days: float = HALF_LIFE_DAYS,
    ) -> List[dict]:
        """Top k items this Choom may see. room_turn=True never returns private chats."""
        query = (query or "").strip()
        if not query:
            return []
        companion_id = companion_id or self.companion_of(choom_id)
        wanted = set(sources or ("memory", "chat", "room"))
        if room_turn:
            wanted.discard("chat")
        rooms = self._rooms_of(choom_id) if "room" in wanted else []
        now = as_of if as_of is not None else time.time()

        # Scope: SQL for BM25, a numpy mask for dense — the same three rules.
        clauses, args = [], []
        if "memory" in wanted:
            clauses.append("(c.source = 'memory' AND c.owner = ?)")
            args.append(companion_id)
        if "chat" in wanted:
            clauses.append("(c.source = 'chat' AND c.owner = ?)")
            args.append(choom_id)
        if rooms:
            clauses.append(f"(c.source = 'room' AND c.owner IN ({','.join('?' * len(rooms))}))")
            args.extend(rooms)
        if not clauses:
            return []
        scope_sql = "(" + " OR ".join(clauses) + ")"

        with self._lock:
            src, own, ts, rid, vec = self._src, self._own, self._ts, self._rid, self._vec
        mask = np.zeros(len(rid), dtype=bool)
        if "memory" in wanted:
            mask |= (src == "memory") & (own == companion_id)
        if "chat" in wanted:
            mask |= (src == "chat") & (own == choom_id)
        if rooms:
            mask |= (src == "room") & np.isin(own, rooms)
        mask &= ts < now
        dense_rank: List[int] = []
        if mask.any():
            qv = self._embed([query])[0]
            idx = np.nonzero(mask)[0]
            sims = vec[idx] @ qv
            top = idx[np.argsort(-sims)[:pool]]
            dense_rank = [int(r) for r in rid[top]]

        bm25_rank: List[int] = []
        match = fts_query(query)
        if match:
            with self._lock:
                bm25_rank = [r for (r,) in self._db.execute(
                    f"""SELECT c.rid FROM chunks_fts JOIN chunks c ON c.rid = chunks_fts.rowid
                        WHERE chunks_fts MATCH ? AND {scope_sql} AND c.ts < ?
                        ORDER BY bm25(chunks_fts) LIMIT ?""",
                    (match, *args, now, pool)).fetchall()]

        fused = rrf(dense_rank, bm25_rank)[:pool]
        if not fused:
            return []
        with self._lock:
            rows = {r[0]: r for r in self._db.execute(
                f"SELECT rid, source, owner, ref, speaker, ts, text FROM chunks WHERE rid IN ({','.join('?' * len(fused))})",
                fused).fetchall()}
        fused = [r for r in fused if r in rows]
        scores = self._rerank(query, [rows[r][6] for r in fused])
        age_days = np.array([(now - rows[r][5]) / 86400.0 for r in fused])
        final = scores + math.log(0.5) * age_days / half_life_days
        order = np.argsort(-final)[:k]
        out = []
        for j in order:
            r = rows[fused[j]]
            out.append({
                "id": r[3], "source": r[1], "speaker": r[4], "ts": r[5],
                "when": datetime.fromtimestamp(r[5], LOCAL).strftime("%Y-%m-%d %H:%M"),
                "text": r[6], "relevance": round(float(scores[j]), 3), "score": round(float(final[j]), 3),
            })
        return out

    def stats(self) -> dict:
        with self._lock:
            by = dict(self._db.execute("SELECT source, COUNT(*) FROM chunks GROUP BY source").fetchall())
            refs = dict(self._db.execute("SELECT source, COUNT(DISTINCT ref) FROM chunks GROUP BY source").fetchall())
        return {"chunks": by, "rows": refs, "vectors": int(len(self._rid)), **self.status,
                "app_db": str(self.app_db), "index": str(self.path)}
