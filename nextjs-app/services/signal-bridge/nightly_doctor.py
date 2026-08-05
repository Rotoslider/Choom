"""
Nightly Doctor — Automated Diagnostic Analyzer

Reads execution trace JSON files from data/traces/, computes daily aggregates,
detects anomalies, and generates a diagnostic report for Signal notification.
"""

import json
import os
import re
import logging
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Any, Optional, Tuple

logger = logging.getLogger(__name__)

# Traces directory (relative to nextjs-app/)
TRACES_DIR = Path(__file__).parent.parent.parent / "data" / "traces"
REPORTS_DIR = TRACES_DIR / "reports"


def _local_date_of(ts: Optional[str]) -> Optional[str]:
    """Convert an ISO-8601 UTC trace timestamp to the server's LOCAL calendar
    date (YYYY-MM-DD). Trace timestamps are written as UTC (e.g.
    2026-06-14T17:07:24.705Z) but reports describe local days."""
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.astimezone().strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        return None


def load_traces(date_str: Optional[str] = None, lookback_days: int = 1) -> List[Dict[str, Any]]:
    """Load trace files for one or more LOCAL calendar days. Defaults to today.

    Trace files are bucketed on disk by the UTC date of their timestamp, but we
    report on LOCAL days. With a -6/-7h offset (America/Denver) a single local
    day's traces straddle two UTC dirs — so we scan a padded ±1-day window of
    day-dirs and then keep only the traces whose LOCAL date matches a target.
    This stops the report from being shifted ~6h and dropping the current
    evening's activity into "tomorrow's" dir.

    Each returned trace has `_trace_file` attached (relative to TRACES_DIR) so
    downstream analysis can surface drill-in pointers in the report.
    """
    traces: List[Dict[str, Any]] = []

    # Target LOCAL dates we actually want in the report.
    if date_str:
        target_dates = {date_str}
    else:
        target_dates = {
            (datetime.now() - timedelta(days=i)).strftime("%Y-%m-%d")
            for i in range(lookback_days)
        }

    # Pad ±1 day so UTC-bucketed files for a target local day are all scanned.
    scan_dates = set()
    for ds in target_dates:
        try:
            base = datetime.strptime(ds, "%Y-%m-%d")
        except ValueError:
            continue
        for off in (-1, 0, 1):
            scan_dates.add((base + timedelta(days=off)).strftime("%Y-%m-%d"))

    seen_ids = set()
    for ds in sorted(scan_dates):
        day_dir = TRACES_DIR / ds
        if not day_dir.exists():
            continue
        for f in day_dir.glob("chat-*.json"):
            try:
                with open(f, "r") as fp:
                    trace = json.load(fp)
            except (json.JSONDecodeError, IOError) as e:
                logger.warning(f"Failed to read trace {f}: {e}")
                continue
            # Keep only traces whose LOCAL date is one we're reporting on.
            local_date = _local_date_of(trace.get("timestamp"))
            if local_date is not None and local_date not in target_dates:
                continue
            # De-dupe in case the padded window picked a file up twice.
            tid = trace.get("traceId")
            if tid:
                if tid in seen_ids:
                    continue
                seen_ids.add(tid)
            # Attach relative path so reports can point to specific traces
            try:
                trace["_trace_file"] = str(f.relative_to(TRACES_DIR))
            except ValueError:
                trace["_trace_file"] = str(f)
            traces.append(trace)

    return traces


def load_historical_reports(lookback_days: int = 7, anchor_date: Optional[str] = None) -> List[Dict[str, Any]]:
    """Load previously-generated report JSONs for week-over-week trending.

    Walks BACKWARD from `anchor_date` (the day being reported on) and excludes
    the anchor itself, so the baseline is the days BEFORE it and is never
    contaminated by the report we're about to (re)write. Returns newest-first.
    """
    if not REPORTS_DIR.exists():
        return []

    try:
        anchor = datetime.strptime(anchor_date, "%Y-%m-%d") if anchor_date else datetime.now()
    except (ValueError, TypeError):
        anchor = datetime.now()
    reports = []
    # Walk back N days looking for report-YYYY-MM-DD.json (i starts at 1 → skips
    # the anchor day itself).
    for i in range(1, lookback_days + 2):  # +2 for slight buffer
        d = anchor - timedelta(days=i)
        ds = d.strftime("%Y-%m-%d")
        report_file = REPORTS_DIR / f"report-{ds}.json"
        if not report_file.exists():
            continue
        try:
            with open(report_file, "r") as fp:
                r = json.load(fp)
                r["_date"] = ds
                reports.append(r)
        except (json.JSONDecodeError, IOError) as e:
            logger.warning(f"Failed to read report {report_file}: {e}")
        if len(reports) >= lookback_days:
            break

    return reports


# ── Error-class refinement (mirrors lib/tool-error-classification.ts) ────────
#
# New traces carry fine-grained errorClass labels from the TS classifier, but
# the historical corpus only has the coarse set — ~58% of all failures used to
# aggregate as an unactionable "other" (C-09), and contract-gate blocks were
# counted as tool failures (C-37). Refine here from the error text so reports
# over OLD traces are just as sharp as reports over new ones.

BLOCKED_REISSUE_RE = re.compile(
    r"has been disabled for this request|\[This exact call already failed"
    r"|^STOP\. You have already called", re.I)
CONTRACT_BLOCK_RE = re.compile(r"^Blocked: ", re.I)
AUTH_RE = re.compile(
    r"\b40[13]\b|unauthorized|forbidden|api key|invalid.*(?:token|credential)"
    r"|insufficient authentication|authentication (?:failed|required)", re.I)
RATE_LIMIT_RE = re.compile(
    r"\b429\b|rate.?limit|too many requests|quota exceeded|resource.?exhausted", re.I)
TIMEOUT_RE = re.compile(
    r"\btim(?:ed|e)[ -]?out\b|ETIMEDOUT|aborted due to timeout|deadline exceeded", re.I)
NETWORK_RE = re.compile(
    r"fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up"
    r"|could not connect|connection (?:refused|reset|closed|error)|network error"
    r"|\bterminated\b", re.I)
UPSTREAM_5XX_RE = re.compile(
    r"\b50[0-4]\b|internal server error|bad gateway|service unavailable"
    r"|gateway time.?out", re.I)
UPSTREAM_4XX_RE = re.compile(r"\b4\d\d\b")
TEMPLATE_RE = re.compile(
    r"system message must be at the beginning|raise_exception"
    r"|conversation roles must alternate|only user and assistant roles"
    r"|chat.?template|jinja", re.I)

# Classes the TS classifier emits that need no refinement when present.
_FINE_CLASSES = {
    "config", "auth", "param", "gpu_busy", "no_data", "permission_block",
    "rate_limit", "timeout", "network", "upstream_4xx", "upstream_5xx",
    "template", "blocked_reissue",
}


def refine_error_class(tc: Dict[str, Any]) -> str:
    """Fine-grained class for a FAILED tool call, old traces included.

    Trusts fine-grained labels written by new traces; for coarse/missing ones
    ("other", "path", absent) re-derives from the error text with the same
    patterns as the TS classifier. "path" needs a second look because old
    traces lumped contract-gate permission blocks into it.
    """
    ec = tc.get("errorClass")
    err = tc.get("error") or ""
    if ec in _FINE_CLASSES:
        return ec
    # Synthetic loop refusals (disabled tool / repeat-call stop / cached
    # failure). `blocked` is set on the pre-flight recording path; the text
    # patterns catch traces from before that flag carried an errorClass.
    if tc.get("blocked") or BLOCKED_REISSUE_RE.search(err):
        return "blocked_reissue"
    if CONTRACT_BLOCK_RE.search(err):
        return "permission_block"
    if ec == "path":
        return "path"
    if AUTH_RE.search(err):
        return "auth"
    if RATE_LIMIT_RE.search(err):
        return "rate_limit"
    if TEMPLATE_RE.search(err):
        return "template"
    if TIMEOUT_RE.search(err):
        return "timeout"
    # Status codes BEFORE transport patterns: "Weather fetch failed: Weather
    # API error: 404" contains "fetch failed" as wrapper prose — the upstream
    # status is the actual cause. Bare "fetch failed" stays network.
    if UPSTREAM_5XX_RE.search(err):
        return "upstream_5xx"
    if UPSTREAM_4XX_RE.search(err):
        return "upstream_4xx"
    if NETWORK_RE.search(err):
        return "network"
    return ec or "other"


def _normalize_error(error_msg: str) -> str:
    """Strip volatile bits (paths, IDs, timestamps) from an error message so
    that the same underlying issue clusters together across traces."""
    if not error_msg:
        return ""
    s = error_msg[:300]
    # Strip absolute paths — collapse to basename or <path>
    s = re.sub(r"'/[^']+?/([^'/]+)'", r"'<path>/\1'", s)
    s = re.sub(r"/home/\S+", "<path>", s)
    # Strip long hex/IDs
    s = re.sub(r"\b[a-f0-9]{16,}\b", "<id>", s)
    # Strip ISO timestamps
    s = re.sub(r"\d{4}-\d{2}-\d{2}T[\d:.]+Z?", "<timestamp>", s)
    # Strip standalone numbers longer than 4 digits (ports, sizes, etc.)
    s = re.sub(r"\b\d{5,}\b", "<n>", s)
    return s.strip()


# Error classes where the error itself is part of a designed discovery
# round-trip: the message lists what actually exists (files, entities,
# folders, valid params) and the model is EXPECTED to retry with a corrected
# value. A failure in one of these classes only signals a problem when the
# model never recovered within the same request — otherwise it is the
# discovery pattern working exactly as built (same spirit as C-37's
# contract-block exclusion, one layer up).
RECOVERABLE_CLASSES = {"path", "stale_ref", "param", "no_data", "gpu_busy"}

# Guidance markers: an error that tells the model what exists / what to do
# instead is a signpost; one without them is a blank wall. Kept deliberately
# broad — these phrases are how every guided error in this codebase is
# written (dir listings, entity lists, "Use X instead", either-or params).
_GUIDANCE_RE = re.compile(
    r"Use\s+\S+|Available|instead|Did you mean|closest existing|here'?s what|"
    r"actually in it|that exist|don'?t guess|Your rooms|valid|options|"
    r"Provide|Retry the call|Real \w+ entities|Folders|call \w+ to see",
    re.IGNORECASE,
)


def _is_blank_wall(error_msg: str) -> bool:
    """True when a failed call's error text gives the model nothing to work
    with: no cause it can act on, no alternatives, no listing. These are the
    errors that make a model retry blindly or give up confused."""
    if not error_msg:
        return True
    if len(error_msg) >= 200:
        # Long errors near-always carry context (listings, tracebacks the
        # model can read, upstream bodies). Don't flag them.
        return False
    return not _GUIDANCE_RE.search(error_msg)


def analyze_traces(traces: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Compute aggregate metrics and detect anomalies from traces."""
    if not traces:
        return {"total_requests": 0, "anomalies": [], "summary": "No traces found."}

    total = len(traces)
    sources = {"chat": 0, "delegation": 0, "heartbeat": 0}
    statuses = {"complete": 0, "max_iterations": 0, "error": 0, "stream_closed": 0}

    # Accumulators
    iterations_list = []
    durations_list = []
    tool_call_counts = []
    tool_success_rates = []
    nudge_counts = []
    nudge_type_counts: Dict[str, int] = defaultdict(int)
    token_totals = []
    response_lengths = []
    stuck_requests = 0  # requests with 4+ consecutive tool failures

    # Per-tool tracking. "failures" counts REAL failures only: contract-gate
    # permission blocks (intended protection working, C-37) and re-issues of
    # already-disabled tools (model behavior, not tool health) are tracked in
    # their own buckets and excluded from every failure-rate metric.
    # tool -> {calls, successes, failures, contract_blocks, reissues,
    #          recoverable, recovered, hard} where failures = recoverable + hard
    # and "recovered" counts recoverable failures answered by a LATER
    # successful call of the same tool in the same trace (discovery worked).
    tool_stats: Dict[str, Dict[str, int]] = {}
    error_classes: Dict[str, int] = {}  # error_class -> count (ALL failed calls, fine-grained)
    broken_tools_seen: Dict[str, int] = {}  # tool_name -> times broken
    contract_blocks_total = 0
    reissues_total = 0

    # Per-choom tracking
    choom_stats: Dict[str, Dict[str, Any]] = {}  # choom_name -> metrics

    # --- Smarter-doctor additions ---
    # Detailed failed-call records for root-cause grouping
    # key: (tool, normalized_error) -> { count, sample_error, chooms, trace_files }
    failure_signatures: Dict[Tuple[str, str], Dict[str, Any]] = {}

    # Per-Choom × per-tool failure matrix
    # choom_tool_stats[choom][tool] = { calls, failures, excluded }
    # ("excluded" = contract blocks + reissues, removed from rate denominators)
    choom_tool_stats: Dict[str, Dict[str, Dict[str, int]]] = defaultdict(
        lambda: defaultdict(lambda: {"calls": 0, "failures": 0, "excluded": 0})
    )

    # Worst-trace tracking (kept as tuples of (metric_value, trace_ref))
    worst_by_iterations: Optional[Tuple[int, Dict[str, Any]]] = None
    worst_by_duration: Optional[Tuple[int, Dict[str, Any]]] = None
    worst_by_failures: Optional[Tuple[int, Dict[str, Any]]] = None
    worst_by_prompt: Optional[Tuple[int, Dict[str, Any]]] = None
    worst_by_llm_call: Optional[Tuple[int, Dict[str, Any]]] = None

    # Phase-timing rollup (C-11) over traces that carry the new fields.
    # "A 2-iteration request should not take 17 minutes" — this says where the
    # minutes actually go: LLM prefill/decode vs tool execution vs prep vs
    # unaccounted overhead.
    phase_totals = {"llm_ms": 0, "prefill_ms": 0, "tool_ms": 0,
                    "prep_ms": 0, "duration_ms": 0, "covered": 0}

    fallback_count = 0
    compaction_count = 0
    force_tool_count = 0
    plan_mode_count = 0

    for t in traces:
        source = t.get("source", "chat")
        sources[source] = sources.get(source, 0) + 1

        status = t.get("status", "complete")
        statuses[status] = statuses.get(status, 0) + 1

        iterations = t.get("iterations", 0)
        iterations_list.append(iterations)

        duration = t.get("durationMs", 0)
        durations_list.append(duration)

        tc_count = t.get("toolCallCount", 0)
        tool_call_counts.append(tc_count)

        tc_success = t.get("toolSuccessCount", 0)
        tc_fail = t.get("toolFailureCount", 0)
        if tc_count > 0:
            tool_success_rates.append(tc_success / tc_count)

        nudge_counts.append(t.get("nudgeCount", 0))
        for nt in t.get("nudgeTypes", []) or []:
            nudge_type_counts[nt] += 1
        token_totals.append(t.get("totalTokens", 0))
        response_lengths.append(t.get("responseLength", 0))
        if t.get("consecutiveFailuresMax", 0) >= 4:
            stuck_requests += 1

        if t.get("fallbackActivated"):
            fallback_count += 1
        if t.get("compactionTriggered"):
            compaction_count += 1
        if t.get("forceToolCallUsed"):
            force_tool_count += 1
        if t.get("planMode"):
            plan_mode_count += 1

        # Per-choom setup (done before tool loop so we can update matrix in-place)
        cn = t.get("choomName", "Unknown")
        if cn not in choom_stats:
            choom_stats[cn] = {"requests": 0, "tool_calls": 0, "failures": 0,
                               "total_iterations": 0, "nudges": 0, "errors": 0}
        choom_stats[cn]["requests"] += 1
        choom_stats[cn]["tool_calls"] += tc_count
        choom_stats[cn]["total_iterations"] += iterations
        choom_stats[cn]["nudges"] += t.get("nudgeCount", 0)
        if status == "error":
            choom_stats[cn]["errors"] += 1

        # Per-tool stats
        real_failures_this_trace = 0
        trace_calls = t.get("toolCalls", [])
        for idx, tc in enumerate(trace_calls):
            tool = tc.get("tool", "unknown")
            if tool not in tool_stats:
                tool_stats[tool] = {"calls": 0, "successes": 0, "failures": 0,
                                    "contract_blocks": 0, "reissues": 0,
                                    "recoverable": 0, "recovered": 0, "hard": 0}
            tool_stats[tool]["calls"] += 1
            # Per-choom × per-tool tracking
            choom_tool_stats[cn][tool]["calls"] += 1

            if tc.get("success"):
                tool_stats[tool]["successes"] += 1
                continue

            ec = refine_error_class(tc)
            error_classes[ec] = error_classes.get(ec, 0) + 1

            # Contract-gate blocks are the safety contract WORKING (C-37) and
            # disabled-tool reissues are the model re-calling a tool the loop
            # already refused — neither says anything about the tool's health,
            # so neither may inflate failure rates, problem_tools, or hotspots.
            if ec == "permission_block":
                tool_stats[tool]["contract_blocks"] += 1
                choom_tool_stats[cn][tool]["excluded"] += 1
                contract_blocks_total += 1
                continue
            if ec == "blocked_reissue":
                tool_stats[tool]["reissues"] += 1
                choom_tool_stats[cn][tool]["excluded"] += 1
                reissues_total += 1
                continue

            tool_stats[tool]["failures"] += 1
            choom_tool_stats[cn][tool]["failures"] += 1
            real_failures_this_trace += 1

            # Discovery round-trip accounting: a recoverable-class failure
            # answered by a later SUCCESSFUL call of the same tool in this
            # trace is the discovery pattern working — count it as recovered
            # so it stops reading as tool breakage. What remains (hard classes
            # + unrecovered recoverables) are the actual dead ends.
            # Recovery is computed for EVERY failed call (visibility in the
            # signature list), but only recoverable-class recoveries reduce
            # the dead-end metric — a hard-class fail-then-succeed (flapping
            # network, transient 500) still deserves attention.
            recovered = any(
                c2.get("success") and c2.get("tool") == tool
                for c2 in trace_calls[idx + 1:]
            )
            if ec in RECOVERABLE_CLASSES:
                tool_stats[tool]["recoverable"] += 1
                if recovered:
                    tool_stats[tool]["recovered"] += 1
            else:
                tool_stats[tool]["hard"] += 1
            if not (recovered and ec in RECOVERABLE_CLASSES):
                choom_tool_stats[cn][tool]["dead_ends"] = (
                    choom_tool_stats[cn][tool].get("dead_ends", 0) + 1
                )

            # Record failure signature for root-cause drill-in
            err_raw = tc.get("error") or ""
            err_norm = _normalize_error(err_raw)
            sig_key = (tool, err_norm[:180])
            if sig_key not in failure_signatures:
                failure_signatures[sig_key] = {
                    "count": 0,
                    "recovered": 0,
                    "sample_error": err_raw[:200],
                    "chooms": set(),
                    "error_class": ec,
                    # Blank wall = error text with no actionable guidance
                    # (no listing, no alternative, no cause). Judged on the
                    # first occurrence's full text.
                    "blank_wall": _is_blank_wall(err_raw),
                    "trace_files": [],
                }
            sig = failure_signatures[sig_key]
            sig["count"] += 1
            if recovered:
                sig["recovered"] += 1
            sig["chooms"].add(cn)
            if len(sig["trace_files"]) < 3:
                tf = t.get("_trace_file")
                if tf and tf not in sig["trace_files"]:
                    sig["trace_files"].append(tf)

        # Per-Choom failures: real failures only (NOT the trace's raw
        # toolFailureCount, which still counts blocks and reissues).
        choom_stats[cn]["failures"] += real_failures_this_trace

        # Broken tools
        for bt in t.get("brokenTools", []):
            broken_tools_seen[bt] = broken_tools_seen.get(bt, 0) + 1

        # Worst-trace tracking for drill-in pointers
        trace_ref = {
            "file": t.get("_trace_file", ""),
            "choom": cn,
            "source": source,
            "iterations": iterations,
            "duration_ms": duration,
            "failures": real_failures_this_trace,
            "status": status,
        }
        # Phase breakdown (attached BEFORE the worst-of comparisons below so
        # every drill-in pointer carries it). Only new traces have llmMs.
        llm_ms = t.get("llmMs", 0) or 0
        if llm_ms > 0:
            tool_ms = t.get("toolExecMs", 0) or 0
            prep_ms = t.get("prepMs", 0) or 0
            prefill_ms = t.get("llmPrefillMs", 0) or 0
            trace_ref["phases"] = {
                "llm_s": round(llm_ms / 1000, 1),
                "prefill_s": round(prefill_ms / 1000, 1),
                "tools_s": round(tool_ms / 1000, 1),
                "prep_s": round(prep_ms / 1000, 1),
                "other_s": round(max(0, duration - llm_ms - tool_ms - prep_ms) / 1000, 1),
            }
            phase_totals["llm_ms"] += llm_ms
            phase_totals["prefill_ms"] += prefill_ms
            phase_totals["tool_ms"] += tool_ms
            phase_totals["prep_ms"] += prep_ms
            phase_totals["duration_ms"] += duration
            phase_totals["covered"] += 1
            mlc = t.get("maxLlmCallMs", 0) or 0
            if mlc > 0 and (worst_by_llm_call is None or mlc > worst_by_llm_call[0]):
                worst_by_llm_call = (mlc, {**trace_ref, "max_llm_call_ms": mlc})
        if worst_by_iterations is None or iterations > worst_by_iterations[0]:
            worst_by_iterations = (iterations, trace_ref)
        if worst_by_duration is None or duration > worst_by_duration[0]:
            worst_by_duration = (duration, trace_ref)
        if worst_by_failures is None or real_failures_this_trace > worst_by_failures[0]:
            worst_by_failures = (real_failures_this_trace, trace_ref)
        # Largest single LLM call of the day (C-53): maxPromptTokens is the
        # biggest per-call prompt, unlike promptTokens which SUMS every call in
        # the turn and reads misleadingly like one giant prompt.
        mpt = t.get("maxPromptTokens", 0) or 0
        if mpt > 0 and (worst_by_prompt is None or mpt > worst_by_prompt[0]):
            worst_by_prompt = (mpt, {**trace_ref, "max_prompt_tokens": mpt})

    # Compute aggregates
    def avg(lst):
        return sum(lst) / len(lst) if lst else 0

    def median(lst):
        if not lst:
            return 0
        s = sorted(lst)
        n = len(s)
        return s[n // 2] if n % 2 == 1 else (s[n // 2 - 1] + s[n // 2]) / 2

    def p95(lst):
        if not lst:
            return 0
        s = sorted(lst)
        idx = int(len(s) * 0.95)
        return s[min(idx, len(s) - 1)]

    # Global, calls-weighted tool success rate. Averaging per-request ratios
    # (the old approach) lets a 1-call request count as much as a 50-call one,
    # which badly skews the headline number. Weight by actual call volume.
    # Contract blocks and reissues are neither success nor failure — they come
    # out of the denominator so the rate measures real attempts only.
    total_tool_calls = sum(s["calls"] for s in tool_stats.values())
    total_excluded = sum(
        s["contract_blocks"] + s["reissues"] for s in tool_stats.values()
    )
    total_tool_successes = sum(s["successes"] for s in tool_stats.values())
    counted_calls = total_tool_calls - total_excluded
    global_success_rate = (
        round(total_tool_successes / counted_calls * 100, 1)
        if counted_calls else 100
    )

    # Find problematic tools (>30% DEAD-END rate with at least 3 real
    # attempts). Two exclusion layers now:
    #   C-37: contract blocks + disabled reissues never count (protection /
    #         model behavior, not tool health).
    #   This pass: recoverable-class failures the model RECOVERED from in the
    #         same trace don't count either — "File not found + here's the
    #         listing → correct retry succeeds" is the designed discovery
    #         round-trip, and counting it had workspace_read_file reading as
    #         a problem tool on any file-exploration-heavy day.
    problem_tools = []
    recoverable_total = 0
    recovered_total = 0
    hard_total = 0
    for tool, stats in tool_stats.items():
        attempts = stats["calls"] - stats["contract_blocks"] - stats["reissues"]
        dead_ends = stats["hard"] + (stats["recoverable"] - stats["recovered"])
        recoverable_total += stats["recoverable"]
        recovered_total += stats["recovered"]
        hard_total += stats["hard"]
        if attempts >= 3 and dead_ends / attempts > 0.3:
            rate = dead_ends / attempts * 100
            problem_tools.append(
                f"{tool}: {rate:.0f}% dead-end failure ({dead_ends}/{attempts})"
            )

    # Detect anomalies
    anomalies = []

    # High error rate
    error_rate = statuses.get("error", 0) / total * 100
    if error_rate > 10:
        anomalies.append(f"High error rate: {error_rate:.0f}% of requests errored ({statuses['error']}/{total})")

    # High max_iterations rate
    max_iter_rate = statuses.get("max_iterations", 0) / total * 100
    if max_iter_rate > 15:
        anomalies.append(f"Hitting max iterations: {max_iter_rate:.0f}% of requests ({statuses['max_iterations']}/{total})")

    # Excessive nudging
    avg_nudges = avg(nudge_counts)
    if avg_nudges > 1.5:
        anomalies.append(f"High nudge rate: avg {avg_nudges:.1f} nudges/request (models narrating instead of acting)")

    # Frequent fallbacks. Only flag when the RATE is high — a handful of
    # fallbacks across hundreds of requests is normal (and same-model local
    # retries now count here too), so `> 0` was pure noise.
    fallback_rate = fallback_count / total * 100 if total else 0
    if fallback_rate > 15:
        anomalies.append(
            f"High fallback rate: {fallback_rate:.0f}% of requests fell back "
            f"({fallback_count}/{total}) -- primary model/endpoint may be flaky"
        )

    # Problem tools
    for pt in problem_tools:
        anomalies.append(f"Tool reliability: {pt}")

    # Broken tools appearing repeatedly
    for bt, count in broken_tools_seen.items():
        if count >= 3:
            anomalies.append(f"Tool '{bt}' was blocked in {count} requests -- likely misconfigured")

    # High average iterations (may indicate model confusion or task complexity)
    avg_iters = avg(iterations_list)
    if avg_iters > 8:
        anomalies.append(f"High avg iterations: {avg_iters:.1f} (model may be struggling)")

    # Requests that got stuck retrying the same failing tool (4+ in a row).
    if stuck_requests > 0:
        stuck_rate = stuck_requests / total * 100
        if stuck_rate > 5:
            anomalies.append(
                f"Stuck requests: {stuck_requests} ({stuck_rate:.0f}%) hit 4+ "
                f"consecutive tool failures (model looping on a broken call)"
            )

    # --- Smarter-doctor derived views ---

    # Top failure signatures: group by (tool, normalized error), rank by count
    top_failures: List[Dict[str, Any]] = []
    sorted_failures = sorted(
        failure_signatures.items(), key=lambda x: -x[1]["count"]
    )
    for (tool, _err_norm), sig in sorted_failures[:10]:
        top_failures.append({
            "tool": tool,
            "count": sig["count"],
            "recovered": sig.get("recovered", 0),
            "chooms": sorted(sig["chooms"]),
            "error_class": sig.get("error_class"),
            "blank_wall": sig.get("blank_wall", False),
            "sample_error": sig["sample_error"],
            "trace_files": sig["trace_files"],
        })

    # Blank walls: failure signatures whose error text gives the model no
    # guidance (no listing, no alternative, no actionable cause). These are
    # the errors that leave a Choom retrying blindly — each one is a concrete
    # error-message improvement to make at the tool's source.
    blank_walls: List[Dict[str, Any]] = []
    for (tool, _err_norm), sig in sorted_failures:
        if not sig.get("blank_wall"):
            continue
        blank_walls.append({
            "tool": tool,
            "count": sig["count"],
            "error_class": sig.get("error_class"),
            "sample_error": sig["sample_error"],
            "trace_files": sig["trace_files"],
        })
        if sig["count"] >= 3:
            anomalies.append(
                f"Opaque error (blank wall): {tool} failed {sig['count']}x with "
                f"no guidance in the message — models can't self-correct from "
                f"\"{sig['sample_error'][:90]}\". Improve the error text at the source."
            )

    # Per-Choom × per-tool hot spots: single (choom, tool) pairs with >30%
    # DEAD-END rate and at least 3 calls. Recovered discovery round-trips are
    # excluded here too — a Choom exploring the workspace by name-guessing is
    # not a hotspot as long as her retries land.
    choom_tool_hotspots: List[Dict[str, Any]] = []
    for cn, tools_map in choom_tool_stats.items():
        for tool, stats in tools_map.items():
            attempts = stats["calls"] - stats.get("excluded", 0)
            dead_ends = stats.get("dead_ends", 0)
            if attempts >= 3 and dead_ends / attempts > 0.30:
                rate = dead_ends / attempts * 100
                choom_tool_hotspots.append({
                    "choom": cn,
                    "tool": tool,
                    "calls": attempts,
                    "failures": dead_ends,
                    "failure_rate": round(rate, 1),
                })
    choom_tool_hotspots.sort(key=lambda x: -x["failure_rate"])

    # Promote hotspots into anomalies when a single Choom is clearly the source.
    # This surfaces cases like "Lissa workspace_write_file 100%" that global
    # aggregates dilute when other Chooms use the same tool successfully.
    for hs in choom_tool_hotspots[:5]:
        anomalies.append(
            f"Choom-specific issue: {hs['choom']} → {hs['tool']} "
            f"{hs['failure_rate']:.0f}% failure ({hs['failures']}/{hs['calls']})"
        )

    # Worst traces — drill-in pointers for the single worst requests of the day
    worst_traces: Dict[str, Any] = {}
    if worst_by_iterations:
        worst_traces["by_iterations"] = worst_by_iterations[1]
    if worst_by_duration:
        worst_traces["by_duration"] = worst_by_duration[1]
    if worst_by_failures and worst_by_failures[0] > 0:
        worst_traces["by_failures"] = worst_by_failures[1]
    if worst_by_prompt:
        worst_traces["by_prompt_tokens"] = worst_by_prompt[1]
    if worst_by_llm_call:
        worst_traces["by_llm_call"] = worst_by_llm_call[1]

    # Latency anomalies (C-11) — only meaningful once traces carry phases.
    if worst_by_llm_call and worst_by_llm_call[0] > 300_000:
        w = worst_by_llm_call[1]
        anomalies.append(
            f"Slow LLM call: a single call took {worst_by_llm_call[0] / 1000:.0f}s "
            f"({w['choom']}/{w['source']}) — model wait, not a hang"
        )
    if worst_by_duration and worst_by_duration[1].get("phases"):
        ph = worst_by_duration[1]["phases"]
        dur_s = worst_by_duration[0] / 1000
        if dur_s > 120 and ph["other_s"] > dur_s * 0.5:
            anomalies.append(
                f"Unaccounted time: {ph['other_s']:.0f}s of the {dur_s:.0f}s worst trace "
                f"is outside LLM/tools/prep — possible hang between phases"
            )

    # Build report
    report = {
        "total_requests": total,
        "sources": sources,
        "statuses": statuses,
        "iterations": {
            "avg": round(avg(iterations_list), 1),
            "median": round(median(iterations_list), 1),
            "p95": round(p95(iterations_list), 1),
            "max": max(iterations_list) if iterations_list else 0,
        },
        "duration_ms": {
            "avg": round(avg(durations_list)),
            "median": round(median(durations_list)),
            "p95": round(p95(durations_list)),
            "max": max(durations_list) if durations_list else 0,
        },
        # Where the wall-clock went, across traces that carry phase timing
        # (C-11). other_ms = streaming/dedup/persistence overhead + anything
        # unaccounted.
        "phase_totals": {
            **phase_totals,
            "other_ms": max(0, phase_totals["duration_ms"] - phase_totals["llm_ms"]
                            - phase_totals["tool_ms"] - phase_totals["prep_ms"]),
        } if phase_totals["covered"] else None,
        "tool_calls": {
            "total": sum(tool_call_counts),
            "avg_per_request": round(avg(tool_call_counts), 1),
            "success_rate": global_success_rate,
            # Discovery-round-trip accounting: recoverable-class failures,
            # how many the model recovered from in-trace, and the residual
            # dead ends (hard failures + unrecovered recoverables) that the
            # problem_tools/hotspot metrics now key off.
            "recoverable_failures": recoverable_total,
            "recovered_in_trace": recovered_total,
            "hard_failures": hard_total,
            "dead_ends": hard_total + (recoverable_total - recovered_total),
        },
        # Contract-gate blocks reported on their own (C-37): intended
        # protection, excluded from every failure metric above.
        "contract_blocks": {
            "total": contract_blocks_total,
            "by_tool": {
                tool: s["contract_blocks"]
                for tool, s in sorted(
                    tool_stats.items(), key=lambda x: -x[1]["contract_blocks"]
                )
                if s["contract_blocks"] > 0
            },
        },
        "tokens": {
            "avg_total": round(avg(token_totals)),
            "total": sum(token_totals),
            # Largest single-call prompt of the day (0 = only pre-C-53 traces)
            "max_single_prompt": worst_by_prompt[0] if worst_by_prompt else 0,
        },
        "behavior": {
            "nudges_total": sum(nudge_counts),
            "nudge_avg": round(avg(nudge_counts), 2),
            "nudge_types": dict(sorted(nudge_type_counts.items(), key=lambda x: -x[1])),
            "fallback_count": fallback_count,
            "fallback_rate": round(fallback_rate, 1),
            "compaction_count": compaction_count,
            "force_tool_count": force_tool_count,
            "plan_mode_count": plan_mode_count,
            "stuck_requests": stuck_requests,
            # Times the model re-called a tool the loop had already disabled
            # (or repeated an exact failed call) — a model-behavior signal.
            "disabled_reissues": reissues_total,
        },
        "error_classes": error_classes,
        "problem_tools": problem_tools,
        "broken_tools": broken_tools_seen,
        "choom_stats": choom_stats,
        # New smarter-doctor fields (additive — old consumers ignore them)
        "top_failures": top_failures,
        "blank_walls": blank_walls,
        "choom_tool_hotspots": choom_tool_hotspots,
        "worst_traces": worst_traces,
        "anomalies": anomalies,
    }

    return report


def compute_trends(today: Dict[str, Any], history: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Compare today's report to a 7-day historical baseline and flag drift.

    A metric is flagged if it drifted >=20% in a "bad" direction (higher error
    rate, lower success rate, higher fallback count, etc.) and the baseline
    had enough data to be meaningful.
    """
    if not history:
        return {"has_baseline": False, "drift_notes": []}

    def avg_of(reports: List[Dict[str, Any]], path: List[str], default: float = 0.0) -> float:
        vals = []
        for r in reports:
            node: Any = r
            try:
                for key in path:
                    node = node[key]
                vals.append(float(node))
            except (KeyError, TypeError, ValueError):
                continue
        return sum(vals) / len(vals) if vals else default

    def today_of(path: List[str], default: float = 0.0) -> float:
        node: Any = today
        try:
            for key in path:
                node = node[key]
            return float(node)
        except (KeyError, TypeError, ValueError):
            return default

    # Metrics to track: path, label, "bad direction" (higher=bad / lower=bad), min_delta_pct
    # Fallback is tracked as a RATE, not a raw count — otherwise a high-traffic
    # day looks "worse" than a quiet one purely on volume. (Older reports that
    # predate fallback_rate fall back to 0 via avg_of's default and are skipped.)
    metrics = [
        (["tool_calls", "success_rate"], "tool success rate", "lower", 5),
        (["iterations", "avg"], "avg iterations", "higher", 25),
        (["behavior", "fallback_rate"], "fallback rate", "higher", 50),
        (["behavior", "nudge_avg"], "nudge rate", "higher", 50),
    ]

    drift_notes: List[str] = []
    baseline_summary: Dict[str, Any] = {"days_in_baseline": len(history)}

    for path, label, bad_dir, min_delta_pct in metrics:
        baseline = avg_of(history, path)
        today_val = today_of(path)
        if baseline == 0 and today_val == 0:
            continue
        # Compute percent change vs baseline (or vs today if baseline is 0)
        denom = baseline if baseline > 0 else max(today_val, 1)
        delta_pct = ((today_val - baseline) / denom) * 100
        baseline_summary[label] = {
            "today": round(today_val, 2),
            "baseline_7d": round(baseline, 2),
            "delta_pct": round(delta_pct, 1),
        }
        if bad_dir == "higher" and delta_pct >= min_delta_pct:
            drift_notes.append(
                f"{label} ↑ {delta_pct:+.0f}% vs 7d baseline "
                f"({baseline:.1f} → {today_val:.1f})"
            )
        elif bad_dir == "lower" and delta_pct <= -min_delta_pct:
            drift_notes.append(
                f"{label} ↓ {delta_pct:+.0f}% vs 7d baseline "
                f"({baseline:.1f}% → {today_val:.1f}%)"
            )

    # Per-tool failure-rate drift: compare today's problem_tools against any
    # present in the baseline reports. Surface tools that newly crossed the
    # 30% threshold (regressions) or dropped off (recoveries).
    baseline_problem_tools: Dict[str, int] = defaultdict(int)
    for r in history:
        for pt in r.get("problem_tools", []) or []:
            # Format: "tool_name: X% failure (n/m)"
            tool_name = pt.split(":")[0].strip()
            baseline_problem_tools[tool_name] += 1
    today_problem_tools = {
        pt.split(":")[0].strip() for pt in today.get("problem_tools", []) or []
    }
    regressions = [
        t for t in today_problem_tools if baseline_problem_tools.get(t, 0) == 0
    ]
    recoveries = [
        t for t, cnt in baseline_problem_tools.items()
        if cnt >= 2 and t not in today_problem_tools
    ]
    if regressions:
        drift_notes.append(
            f"NEW problem tools (not in 7d baseline): {', '.join(regressions)}"
        )
    if recoveries:
        drift_notes.append(
            f"Recovered tools (were flaky, now clean): {', '.join(recoveries)}"
        )

    return {
        "has_baseline": True,
        "days_in_baseline": len(history),
        "metrics": baseline_summary,
        "drift_notes": drift_notes,
        "new_problem_tools": regressions,
        "recovered_tools": recoveries,
    }


def format_report(report: Dict[str, Any]) -> str:
    """Format the analysis report as a human-readable string for Signal."""
    total = report["total_requests"]
    if total == 0:
        return f"Nightly Doctor: No traces found for {report.get('date') or 'the reported day'}. System may be idle or trace logging not active."

    lines = [f"Nightly Doctor Report ({report.get('date') or datetime.now().strftime('%Y-%m-%d')})"]
    lines.append(f"{'=' * 40}")

    # Overview
    s = report["statuses"]
    lines.append(f"\nRequests: {total} total")
    src = report["sources"]
    src_parts = [f"{v} {k}" for k, v in src.items() if v > 0]
    lines.append(f"  Sources: {', '.join(src_parts)}")
    lines.append(f"  Complete: {s.get('complete', 0)} | Errors: {s.get('error', 0)} | Max iter: {s.get('max_iterations', 0)}")

    # Performance
    iters = report["iterations"]
    dur = report["duration_ms"]
    lines.append(f"\nPerformance:")
    lines.append(f"  Iterations: avg {iters['avg']}, median {iters['median']}, p95 {iters['p95']}, max {iters['max']}")
    lines.append(f"  Duration: avg {dur['avg']/1000:.1f}s, median {dur['median']/1000:.1f}s, p95 {dur['p95']/1000:.1f}s, max {dur['max']/1000:.1f}s")

    # Phase split (C-11): where the wall-clock went, over traces that carry it
    pt = report.get("phase_totals")
    if pt and pt.get("duration_ms"):
        total = pt["duration_ms"]
        pct = lambda v: f"{v / total * 100:.0f}%"
        prefill_share = (f" (prefill {pt['prefill_ms'] / pt['llm_ms'] * 100:.0f}% of it)"
                         if pt["llm_ms"] else "")
        lines.append(
            f"  Time split ({pt['covered']} req): LLM {pct(pt['llm_ms'])}{prefill_share}, "
            f"tools {pct(pt['tool_ms'])}, prep {pct(pt['prep_ms'])}, other {pct(pt['other_ms'])}"
        )

    # Tools
    tc = report["tool_calls"]
    lines.append(f"\nTools: {tc['total']} calls ({tc['avg_per_request']}/req), {tc['success_rate']}% success")
    # Discovery accounting: failures the model recovered from in the same
    # request are the lookup-by-error pattern working, not breakage. What the
    # doctor now treats as signal is the dead-end residue.
    if tc.get("recoverable_failures") or tc.get("hard_failures"):
        lines.append(
            f"  Failures: {tc.get('recoverable_failures', 0)} recoverable "
            f"({tc.get('recovered_in_trace', 0)} recovered in-request), "
            f"{tc.get('hard_failures', 0)} hard → {tc.get('dead_ends', 0)} dead ends"
        )

    # Contract-gate blocks: named separately so protection working never reads
    # as tool breakage (they are excluded from the failure rates above).
    cb = report.get("contract_blocks", {})
    if cb.get("total"):
        by_tool = cb.get("by_tool", {})
        top = ", ".join(f"{t}: {n}" for t, n in list(by_tool.items())[:3])
        lines.append(f"  Contract-gate blocks: {cb['total']} (intended protection, not failures) — {top}")

    # Behavior
    beh = report["behavior"]
    behavior_parts = []
    if beh["nudges_total"] > 0:
        behavior_parts.append(f"{beh['nudges_total']} nudges")
    if beh["fallback_count"] > 0:
        behavior_parts.append(f"{beh['fallback_count']} fallbacks ({beh.get('fallback_rate', 0):.0f}%)")
    if beh["compaction_count"] > 0:
        behavior_parts.append(f"{beh['compaction_count']} compactions")
    if beh["plan_mode_count"] > 0:
        behavior_parts.append(f"{beh['plan_mode_count']} plan mode")
    if beh.get("stuck_requests", 0) > 0:
        behavior_parts.append(f"{beh['stuck_requests']} stuck")
    if beh.get("disabled_reissues", 0) > 0:
        behavior_parts.append(f"{beh['disabled_reissues']} disabled-tool reissues")
    if behavior_parts:
        lines.append(f"  Behavior: {', '.join(behavior_parts)}")
    # Nudge-type breakdown — explains WHY models needed nudging.
    nudge_types = beh.get("nudge_types", {})
    if nudge_types:
        nt_parts = [f"{k}: {v}" for k, v in nudge_types.items()]
        lines.append(f"  Nudge types: {', '.join(nt_parts)}")

    # Error breakdown
    ec = report.get("error_classes", {})
    if ec:
        ec_parts = [f"{k}: {v}" for k, v in sorted(ec.items(), key=lambda x: -x[1])]
        lines.append(f"\nError classes: {', '.join(ec_parts)}")

    # Per-choom summary (top 5 by requests)
    choom_stats = report.get("choom_stats", {})
    if choom_stats:
        lines.append(f"\nPer-Choom:")
        sorted_chooms = sorted(choom_stats.items(), key=lambda x: -x[1]["requests"])
        for name, cs in sorted_chooms[:5]:
            avg_iter = cs["total_iterations"] / cs["requests"] if cs["requests"] > 0 else 0
            parts = [f"{cs['requests']} req"]
            parts.append(f"{cs['tool_calls']} tools")
            if cs["failures"] > 0:
                parts.append(f"{cs['failures']} fails")
            parts.append(f"avg {avg_iter:.1f} iter")
            if cs["nudges"] > 0:
                parts.append(f"{cs['nudges']} nudges")
            if cs["errors"] > 0:
                parts.append(f"{cs['errors']} errors")
            lines.append(f"  {name}: {', '.join(parts)}")

    # Choom × tool hotspots (single-Choom problems invisible in aggregates)
    hotspots = report.get("choom_tool_hotspots", [])
    if hotspots:
        lines.append(f"\nChoom × tool hotspots (>30% failure):")
        for hs in hotspots[:5]:
            lines.append(
                f"  {hs['choom']} → {hs['tool']}: "
                f"{hs['failure_rate']:.0f}% ({hs['failures']}/{hs['calls']})"
            )

    # Top failure signatures — actual error messages grouped by root cause
    top_failures = report.get("top_failures", [])
    if top_failures:
        lines.append(f"\nTop failure signatures:")
        for tf in top_failures[:5]:
            chooms_str = ",".join(tf["chooms"][:3])
            if len(tf["chooms"]) > 3:
                chooms_str += f"+{len(tf['chooms']) - 3}"
            err_preview = (tf.get("sample_error") or "").replace("\n", " ")[:120]
            rec = tf.get("recovered", 0)
            rec_str = f", {rec}/{tf['count']} recovered" if rec else ""
            lines.append(
                f"  [{tf['count']}x{rec_str}] {tf['tool']} ({chooms_str}): {err_preview}"
            )

    # Blank walls — errors that tell the model nothing actionable
    blank_walls = report.get("blank_walls", [])
    if blank_walls:
        lines.append(f"\nBlank-wall errors (no guidance in the message — fix at source):")
        for bw in blank_walls[:5]:
            err_preview = (bw.get("sample_error") or "").replace("\n", " ")[:110]
            lines.append(f"  [{bw['count']}x] {bw['tool']}: {err_preview}")

    # Worst traces — drill-in pointers
    worst = report.get("worst_traces", {})
    if worst:
        lines.append(f"\nWorst traces (open these to drill in):")
        if "by_iterations" in worst:
            w = worst["by_iterations"]
            lines.append(
                f"  most iters ({w['iterations']}): {w['choom']}/{w['source']} → {w['file']}"
            )
        if "by_duration" in worst:
            w = worst["by_duration"]
            ph = w.get("phases")
            ph_str = (f" [llm {ph['llm_s']:.0f}s (prefill {ph['prefill_s']:.0f}s), tools {ph['tools_s']:.0f}s,"
                      f" prep {ph['prep_s']:.0f}s, other {ph['other_s']:.0f}s]") if ph else ""
            lines.append(
                f"  longest ({w['duration_ms']/1000:.0f}s){ph_str}: {w['choom']}/{w['source']} → {w['file']}"
            )
        if "by_failures" in worst:
            w = worst["by_failures"]
            lines.append(
                f"  most fails ({w['failures']}): {w['choom']}/{w['source']} → {w['file']}"
            )
        if "by_prompt_tokens" in worst:
            w = worst["by_prompt_tokens"]
            lines.append(
                f"  biggest single prompt ({w['max_prompt_tokens']:,} tok): {w['choom']}/{w['source']} → {w['file']}"
            )
        if "by_llm_call" in worst:
            w = worst["by_llm_call"]
            lines.append(
                f"  slowest single LLM call ({w['max_llm_call_ms']/1000:.0f}s): {w['choom']}/{w['source']} → {w['file']}"
            )

    # Week-over-week trends (present when run_diagnostics attaches baseline)
    trends = report.get("trends")
    if trends and trends.get("has_baseline"):
        drift = trends.get("drift_notes", [])
        if drift:
            lines.append(f"\n7-day trend drift (today vs {trends.get('days_in_baseline')}-day avg):")
            for d in drift:
                lines.append(f"  {d}")

    # Anomalies (the most important part)
    anomalies = report.get("anomalies", [])
    if anomalies:
        lines.append(f"\n{'!' * 40}")
        lines.append("ANOMALIES DETECTED:")
        for a in anomalies:
            lines.append(f"  - {a}")
    else:
        lines.append(f"\nAll systems nominal. No anomalies detected.")

    return "\n".join(lines)


def run_diagnostics(lookback_days: int = 1, report_date: Optional[str] = None) -> str:
    """Main entry point: load traces, analyze, add WoW trends, format report.

    Reports on a single COMPLETED local day. The doctor runs in the early morning
    to review the day that just ended, so when no explicit `report_date` is given
    we review YESTERDAY before noon (when "today" has barely any traces yet) and
    TODAY later in the day (so a 22:00 schedule still reviews the day's activity).
    The report is named for the day it COVERS, not the day it runs.
    """
    if report_date is None:
        now = datetime.now()
        base = now - timedelta(days=1) if now.hour < 12 else now
        report_date = base.strftime("%Y-%m-%d")

    traces = load_traces(date_str=report_date)
    report = analyze_traces(traces)
    report["date"] = report_date  # the day this report COVERS (for header + naming)

    # Attach 7-day trend comparison (if historical reports exist)
    try:
        history = load_historical_reports(lookback_days=7, anchor_date=report_date)
        report["trends"] = compute_trends(report, history)
    except Exception as e:
        logger.warning(f"Failed to compute trends: {e}")
        report["trends"] = {"has_baseline": False, "drift_notes": []}

    formatted = format_report(report)

    # Stamp the formatted Signal text + generation time INTO the JSON so the
    # GUI report viewer can render historical reports without re-running the
    # Python formatter.
    report["formatted_text"] = formatted
    report["generated_at"] = datetime.now().isoformat()

    # Also save the raw report as JSON for historical analysis
    report_dir = TRACES_DIR / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    report_file = report_dir / f"report-{report_date}.json"
    try:
        with open(report_file, "w") as f:
            # default=str handles sets, datetimes, etc. that may slip through
            json.dump(report, f, indent=2, default=_json_default)
    except IOError as e:
        logger.warning(f"Failed to save report JSON: {e}")

    return formatted


def _json_default(obj: Any) -> Any:
    """JSON fallback serializer: converts sets to sorted lists, stringifies the rest."""
    if isinstance(obj, set):
        return sorted(obj)
    return str(obj)


if __name__ == "__main__":
    # Run standalone for testing
    logging.basicConfig(level=logging.INFO)
    report = run_diagnostics(lookback_days=1)
    print(report)
