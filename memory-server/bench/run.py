"""
Score retrieval designs on the recall benchmark (cases.json).

For every probe (a Choom, a moment T, a query) each system returns its top K
items from what existed before T, judged per cases_lib.judge:

  found   — any TRUTH item in the top K
  current — the newest judged item in the top K is TRUTH (she reads "newest
            wins", so this is what decides whether a wake-up acts on stale news)
  misled  — top K holds STALE items and no TRUTH

Run: ../venv/bin/python run.py [--systems a,b] [--k 5]
Embeddings are cached in bench/.cache (safe to delete).
"""
import argparse
import hashlib
import math
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

import cases_lib
import corpus

CACHE = Path(__file__).with_name(".cache")
DAY = 86400.0

# ---------------------------------------------------------------- models

_models = {}


def _device():
    import torch
    return "mps" if torch.backends.mps.is_available() else "cpu"


def embedder(name):
    if name not in _models:
        import contextlib, io
        from sentence_transformers import SentenceTransformer
        with contextlib.redirect_stderr(io.StringIO()):
            m = SentenceTransformer(name, device=_device())
        if "bge-m3" in name:
            m.max_seq_length = 1024
        _models[name] = m
    return _models[name]


def reranker(name):
    if name not in _models:
        import contextlib, io
        from sentence_transformers import CrossEncoder
        with contextlib.redirect_stderr(io.StringIO()):
            import torch
            # Raw logits, not sigmoid: the time-aware modes weigh relevance
            # against age on one scale.
            _models[name] = CrossEncoder(name, device=_device(), max_length=512,
                                         activation_fn=torch.nn.Identity())
    return _models[name]


def embed_items(name, items, timings):
    """Normalized embeddings for items, cached per (model, item id, text)."""
    CACHE.mkdir(exist_ok=True)
    tag = re.sub(r"\W", "_", name)
    path = CACHE / f"{tag}.npz"
    store = dict(np.load(path, allow_pickle=True)) if path.exists() else {}
    keys = [hashlib.sha1(f"{it.id}\0{it.text}".encode()).hexdigest() for it in items]
    missing = [(k, it) for k, it in zip(keys, items) if k not in store]
    if missing:
        t = time.time()
        vecs = embedder(name).encode([it.text for _, it in missing], batch_size=32,
                                     normalize_embeddings=True, show_progress_bar=False)
        timings[f"embed {name}"] = (len(missing), time.time() - t)
        for (k, _), v in zip(missing, vecs):
            store[k] = v
        np.savez(path, **store)
    return np.stack([store[k] for k in keys])


# ---------------------------------------------------------------- BM25

_TOK = re.compile(r"[a-z0-9]+(?:'[a-z]+)?")


def tokenize(s):
    return _TOK.findall(s.lower())


class BM25:
    def __init__(self, texts, k1=1.5, b=0.75):
        self.docs = [Counter(tokenize(t)) for t in texts]
        self.len = np.array([sum(d.values()) for d in self.docs], dtype=float)
        self.avg = self.len.mean() if len(self.len) else 1.0
        df = Counter(w for d in self.docs for w in d)
        n = len(self.docs)
        self.idf = {w: math.log(1 + (n - f + 0.5) / (f + 0.5)) for w, f in df.items()}
        self.k1, self.b = k1, b

    def scores(self, query):
        q = [w for w in tokenize(query) if w in self.idf]
        out = np.zeros(len(self.docs))
        for i, d in enumerate(self.docs):
            s = 0.0
            for w in q:
                tf = d.get(w)
                if tf:
                    s += self.idf[w] * tf * (self.k1 + 1) / (tf + self.k1 * (1 - self.b + self.b * self.len[i] / self.avg))
            out[i] = s
        return out


# ---------------------------------------------------------------- systems

STOP = {"the", "and", "for", "has", "had", "did", "was", "are", "with", "about", "any", "his", "her", "our", "you"}


def current_system(ctx, q, cand, k):
    """The live memory server (2026-09-28): MiniLM over memories, adaptive
    threshold, plus the newest 2 exact-word matches for 1-3 word queries."""
    idx = [i for i in cand if ctx.items[i].source == "memory"]
    if not idx:
        return []
    qv = embedder("sentence-transformers/all-MiniLM-L6-v2").encode([q], normalize_embeddings=True)[0]
    sims = ctx.emb["minilm"][idx] @ qv
    order = np.argsort(-sims)[:k]
    top = sims[order[0]]
    thr = max(0.15, max(0.12, min(0.35, top - 0.08)))
    sel = [idx[j] for j in order if sims[j] >= thr] or ([idx[order[0]]] if top >= 0.08 else [])
    words = [w for w in re.findall(r"[a-z0-9']+", q.lower()) if len(w) >= 3 and w not in STOP]
    if 1 <= len(words) <= 3:
        have = set(sel)
        kw = [i for i in sorted(idx, key=lambda i: -ctx.items[i].ts)
              if all(w in ctx.items[i].text.lower() for w in words) and i not in have][:2]
        sel += kw
    return sel


def dense(ctx, model_key, q, idx, n):
    name = {"minilm": "sentence-transformers/all-MiniLM-L6-v2", "bgem3": "BAAI/bge-m3",
            "bgebase": "BAAI/bge-base-en-v1.5"}[model_key]
    qv = embedder(name).encode([q], normalize_embeddings=True)[0]
    sims = ctx.emb[model_key][idx] @ qv
    order = np.argsort(-sims)[:n]
    return [idx[j] for j in order], sims


def bm25_rank(ctx, q, idx, n):
    s = ctx.bm25.scores(q)[idx]
    order = np.argsort(-s)[:n]
    return [idx[j] for j in order if s[j] > 0]


def rrf(*rankings, k=60):
    score = defaultdict(float)
    for r in rankings:
        for pos, i in enumerate(r):
            score[i] += 1.0 / (k + pos + 1)
    return sorted(score, key=lambda i: -score[i])


def make_system(sources, model="bgem3", use_bm25=True, rerank=None, time_mode=None, pool=50, donny_bonus=0.0, split=False):
    base = None

    def run(ctx, q, cand, k):
        if split:
            # Multi-topic text (a wake-up note): search each sentence on its
            # own, keep each one's best 2, then order by the same scoring.
            parts = [x.strip() for x in re.split(r"(?<=[.!?])\s+|\s+—\s+|:\s+(?=[A-Z])|\n+", q) if len(x.strip()) >= 12]
            if len(parts) > 1:
                picked = []
                for part in parts[:6]:
                    for i in base(ctx, part, cand, 2):
                        if i not in picked:
                            picked.append(i)
                # final order: most recent-weighted relevance to the WHOLE note
                return base(ctx, q, picked, k) if picked else []
        return base(ctx, q, cand, k)

    def single(ctx, q, cand, k):
        idx = [i for i in cand if ctx.items[i].source in sources]
        if not idx:
            return []
        dense_rank, _ = dense(ctx, model, q, idx, pool)
        ranked = rrf(dense_rank, bm25_rank(ctx, q, idx, pool)) if use_bm25 else dense_rank
        ranked = ranked[:pool]
        scores = None
        if rerank:
            cache = ctx.rr_cache.setdefault((rerank, q), {})
            todo = [i for i in ranked if i not in cache]
            if todo:
                t = time.time()
                got = reranker(rerank).predict([(q, ctx.items[i].text[:2000]) for i in todo],
                                               batch_size=16, show_progress_bar=False)
                ctx.rr_time.append((len(todo), time.time() - t))
                cache.update(zip(todo, got))
            scores = np.array([cache[i] for i in ranked])
            if donny_bonus:
                # Donny's own words about his own world outrank a sister's
                # retelling (the sisters kept saying "Rustler Park" after he
                # moved camp to Long Park).
                scores = scores + np.array([donny_bonus if ctx.items[i].speaker == "Donny" else 0.0 for i in ranked])
            order = np.argsort(-scores)
            ranked = [ranked[j] for j in order]
            scores = scores[order]
        if time_mode is None:
            return ranked[:k]
        now = ctx.now
        if time_mode == "newest-of-relevant":
            # Keep what the reranker calls relevant (within a margin of the
            # best), then prefer the newest of those.
            if scores is None:
                rel = ranked[:15]
            else:
                best = scores[0]
                rel = [i for i, s in zip(ranked, scores) if s >= best - 3.0][:15]
            keep = rel[:2]  # the two most relevant always stay
            rest = sorted([i for i in rel if i not in keep], key=lambda i: -ctx.items[i].ts)
            return (keep + rest)[:k]
        if time_mode.startswith("decay"):
            tau = float(time_mode.split(":")[1])
            base = scores if scores is not None else -np.arange(len(ranked), dtype=float)
            age = np.array([(now - ctx.items[i].ts) / DAY for i in ranked])
            final = base + (np.log(0.5) * age / tau if tau > 0 else 0)
            order = np.argsort(-final)
            return [ranked[j] for j in order][:k]
        raise ValueError(time_mode)
    base = single
    return run


MEM = {"memory"}
ALL = {"memory", "chat", "room"}
ALLW = ALL | {"wake"}
RR = "BAAI/bge-reranker-v2-m3"
SYSTEMS = {
    "current": current_system,
    "minilm-all": make_system(ALL, model="minilm", use_bm25=False),
    "bm25-mem": None,  # filled below
    "bgem3-mem": make_system(MEM, use_bm25=False),
    "hybrid-mem": make_system(MEM),
    "hybrid-rr-mem": make_system(MEM, rerank=RR),
    "hybrid-all": make_system(ALL),
    "hybrid-rr-all": make_system(ALL, rerank=RR),
    "hybrid-rr-all+wake": make_system(ALLW, rerank=RR),
    "hybrid-rr-all+newest": make_system(ALL, rerank=RR, time_mode="newest-of-relevant"),
    "hybrid-rr-all+decay7": make_system(ALL, rerank=RR, time_mode="decay:7"),
    "hybrid-rr-all+decay30": make_system(ALL, rerank=RR, time_mode="decay:30"),
    "bgebase-hybrid-all": make_system(ALL, model="bgebase"),
}
for tau in (3, 7, 14, 30):
    for bonus in (0, 1, 2):
        SYSTEMS[f"rr-all-d{tau}-b{bonus}"] = make_system(ALL, rerank=RR, time_mode=f"decay:{tau}", donny_bonus=bonus)
for bonus in (1, 2):
    SYSTEMS[f"rr-all-b{bonus}"] = make_system(ALL, rerank=RR, donny_bonus=bonus)
SYSTEMS["rr-all-d14-split"] = make_system(ALL, rerank=RR, time_mode="decay:14", split=True)
SYSTEMS["rrbase-all-d14"] = make_system(ALL, rerank="BAAI/bge-reranker-base", time_mode="decay:14")
SYSTEMS["rr-all-d7-b1-pool20"] = make_system(ALL, rerank=RR, time_mode="decay:7", donny_bonus=1, pool=20)
SYSTEMS["bgebase-rr-all-d7-b1"] = make_system(ALL, model="bgebase", rerank=RR, time_mode="decay:7", donny_bonus=1)


def _bm25_mem(ctx, q, cand, k):
    idx = [i for i in cand if ctx.items[i].source == "memory"]
    return bm25_rank(ctx, q, idx, k)


SYSTEMS["bm25-mem"] = _bm25_mem


# ---------------------------------------------------------------- run

class Ctx:
    pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--systems", default=",".join(SYSTEMS))
    ap.add_argument("--k", type=int, default=5)
    ap.add_argument("--show", default="", help="system name: print misses for it")
    args = ap.parse_args()
    systems = args.systems.split(",")
    cases = cases_lib.load_cases()
    probes = list(cases_lib.probes(cases))
    need_models = {"minilm"} | {"bgem3" for s in systems if s not in ("current", "minilm-all", "bm25-mem") and "bgebase" not in s} \
        | {"bgebase" for s in systems if "bgebase" in s}
    timings = {}
    ctxs = {}
    for choom in sorted({p["choom"] for _, p, _ in probes}):
        c = Ctx()
        c.items = corpus.load(choom)
        c.emb = {}
        for key in need_models:
            name = {"minilm": "sentence-transformers/all-MiniLM-L6-v2", "bgem3": "BAAI/bge-m3", "bgebase": "BAAI/bge-base-en-v1.5"}[key]
            c.emb[key] = embed_items(name, c.items, timings)
        c.bm25 = BM25([it.text for it in c.items])
        c.rr_time = []
        c.rr_cache = {}
        ctxs[choom] = c
    for k, (n, secs) in timings.items():
        print(f"[{k}: {n} items in {secs:.0f}s = {n / max(secs, 1e-9):.0f}/s]", file=sys.stderr)

    results = defaultdict(lambda: defaultdict(Counter))  # system -> qtype -> counter
    misses = []
    qtimes = defaultdict(list)
    for case, p, t in probes:
        ctx = ctxs[p["choom"]]
        ctx.now = t
        cand = [i for i, it in enumerate(ctx.items) if it.ts < t]
        qs = {"short": case["short"], "question": case["question"]}
        if p.get("note"):
            qs["note"] = p["note"]
        for sname in systems:
            for qtype, q in qs.items():
                t0 = time.time()
                top = SYSTEMS[sname](ctx, q, cand, args.k)
                qtimes[sname].append(time.time() - t0)
                verdicts = [(ctx.items[i], cases_lib.judge(case, ctx.items[i].text)) for i in top]
                judged = [(it, v) for it, v in verdicts if v]
                found = any(v == "truth" for _, v in judged)
                newest = max(judged, key=lambda x: x[0].ts)[1] if judged else ""
                r = results[sname][qtype]
                r["n"] += 1
                r[f"n_{case['kind']}"] += 1
                r["found"] += found
                r[f"found_{case['kind']}"] += found
                r["current"] += newest == "truth"
                r[f"current_{case['kind']}"] += newest == "truth"
                r["misled"] += (not found) and any(v == "stale" for _, v in judged)
                if sname == args.show and newest != "truth":
                    misses.append((case["id"], p["choom"], qtype, q[:60], [(it.source, it.when, v) for it, v in verdicts]))

    pairs = sum(n for c in ctxs.values() for n, _ in c.rr_time)
    secs = sum(t for c in ctxs.values() for _, t in c.rr_time)
    if pairs:
        print(f"[rerank: {pairs} pairs in {secs:.0f}s = {pairs / secs:.0f} pairs/s -> ~{50 / (pairs / secs) * 1000:.0f} ms per 50-candidate query]", file=sys.stderr)
    qts = ["short", "question", "note"]
    print(f"\nK={args.k} · {len(probes)} probes ({sum(1 for c, _, _ in probes if c['kind'] == 'changed')} changed, "
          f"{sum(1 for c, _, _ in probes if c['kind'] == 'stable')} stable)\n")
    head = f"{'system':24}" + "".join(f"{qt + ' found/current/misled':>36}" for qt in qts) + f"{'ms/query':>10}"
    print(head)
    for sname in systems:
        row = f"{sname:24}"
        for qt in qts:
            r = results[sname][qt]
            if not r["n"]:
                row += f"{'-':>36}"
                continue
            row += f"{r['found'] / r['n'] * 100:>18.0f}%{r['current'] / r['n'] * 100:>8.0f}%{r['misled']:>9}"
        row += f"{np.median(qtimes[sname]) * 1000:>10.0f}"
        print(row)
    print("\nchanged-only 'current' (the stale-news number):")
    for sname in systems:
        cells = []
        for qt in qts:
            r = results[sname][qt]
            if r["n_changed"]:
                cells.append(f"{qt} {r['current_changed']}/{r['n_changed']}")
        print(f"  {sname:24} " + "   ".join(cells))
    print("stable-only 'found':")
    for sname in systems:
        cells = []
        for qt in qts:
            r = results[sname][qt]
            if r["n_stable"]:
                cells.append(f"{qt} {r['found_stable']}/{r['n_stable']}")
        print(f"  {sname:24} " + "   ".join(cells))
    for m in misses:
        print("MISS", m)


if __name__ == "__main__":
    main()
