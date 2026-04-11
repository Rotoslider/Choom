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


def load_traces(date_str: Optional[str] = None, lookback_days: int = 1) -> List[Dict[str, Any]]:
    """Load trace files for a date range. Defaults to the last 24 hours.

    Each returned trace has `_trace_file` attached (relative to TRACES_DIR) so
    downstream analysis can surface drill-in pointers in the report.
    """
    traces = []

    if date_str:
        dates = [date_str]
    else:
        # Load today and yesterday (traces may span midnight)
        dates = []
        for i in range(lookback_days):
            d = datetime.now() - timedelta(days=i)
            dates.append(d.strftime("%Y-%m-%d"))

    for ds in dates:
        day_dir = TRACES_DIR / ds
        if not day_dir.exists():
            continue
        for f in day_dir.glob("chat-*.json"):
            try:
                with open(f, "r") as fp:
                    trace = json.load(fp)
                    # Attach relative path so reports can point to specific traces
                    try:
                        trace["_trace_file"] = str(f.relative_to(TRACES_DIR))
                    except ValueError:
                        trace["_trace_file"] = str(f)
                    traces.append(trace)
            except (json.JSONDecodeError, IOError) as e:
                logger.warning(f"Failed to read trace {f}: {e}")

    return traces


def load_historical_reports(lookback_days: int = 7, exclude_today: bool = True) -> List[Dict[str, Any]]:
    """Load previously-generated report JSONs for week-over-week trending.

    Skips today's report by default so the baseline isn't contaminated with
    the current day's numbers. Returns newest-first.
    """
    if not REPORTS_DIR.exists():
        return []

    today_str = datetime.now().strftime("%Y-%m-%d")
    reports = []
    # Walk back N days looking for report-YYYY-MM-DD.json
    for i in range(1, lookback_days + 2):  # +2 for slight buffer
        d = datetime.now() - timedelta(days=i)
        ds = d.strftime("%Y-%m-%d")
        if exclude_today and ds == today_str:
            continue
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
    token_totals = []
    response_lengths = []

    # Per-tool tracking
    tool_stats: Dict[str, Dict[str, int]] = {}  # tool_name -> {calls, successes, failures}
    error_classes: Dict[str, int] = {}  # error_class -> count
    broken_tools_seen: Dict[str, int] = {}  # tool_name -> times broken

    # Per-choom tracking
    choom_stats: Dict[str, Dict[str, Any]] = {}  # choom_name -> metrics

    # --- Smarter-doctor additions ---
    # Detailed failed-call records for root-cause grouping
    # key: (tool, normalized_error) -> { count, sample_error, chooms, trace_files }
    failure_signatures: Dict[Tuple[str, str], Dict[str, Any]] = {}

    # Per-Choom × per-tool failure matrix
    # choom_tool_stats[choom][tool] = { calls, failures }
    choom_tool_stats: Dict[str, Dict[str, Dict[str, int]]] = defaultdict(
        lambda: defaultdict(lambda: {"calls": 0, "failures": 0})
    )

    # Worst-trace tracking (kept as tuples of (metric_value, trace_ref))
    worst_by_iterations: Optional[Tuple[int, Dict[str, Any]]] = None
    worst_by_duration: Optional[Tuple[int, Dict[str, Any]]] = None
    worst_by_failures: Optional[Tuple[int, Dict[str, Any]]] = None

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
        token_totals.append(t.get("totalTokens", 0))
        response_lengths.append(t.get("responseLength", 0))

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
        choom_stats[cn]["failures"] += tc_fail
        choom_stats[cn]["total_iterations"] += iterations
        choom_stats[cn]["nudges"] += t.get("nudgeCount", 0)
        if status == "error":
            choom_stats[cn]["errors"] += 1

        # Per-tool stats
        for tc in t.get("toolCalls", []):
            tool = tc.get("tool", "unknown")
            if tool not in tool_stats:
                tool_stats[tool] = {"calls": 0, "successes": 0, "failures": 0}
            tool_stats[tool]["calls"] += 1
            # Per-choom × per-tool tracking
            choom_tool_stats[cn][tool]["calls"] += 1

            if tc.get("success"):
                tool_stats[tool]["successes"] += 1
            else:
                tool_stats[tool]["failures"] += 1
                choom_tool_stats[cn][tool]["failures"] += 1
                ec = tc.get("errorClass", "other")
                if ec:
                    error_classes[ec] = error_classes.get(ec, 0) + 1

                # Record failure signature for root-cause drill-in
                err_raw = tc.get("error") or ""
                err_norm = _normalize_error(err_raw)
                sig_key = (tool, err_norm[:180])
                if sig_key not in failure_signatures:
                    failure_signatures[sig_key] = {
                        "count": 0,
                        "sample_error": err_raw[:200],
                        "chooms": set(),
                        "error_class": ec,
                        "trace_files": [],
                    }
                sig = failure_signatures[sig_key]
                sig["count"] += 1
                sig["chooms"].add(cn)
                if len(sig["trace_files"]) < 3:
                    tf = t.get("_trace_file")
                    if tf and tf not in sig["trace_files"]:
                        sig["trace_files"].append(tf)

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
            "failures": tc_fail,
            "status": status,
        }
        if worst_by_iterations is None or iterations > worst_by_iterations[0]:
            worst_by_iterations = (iterations, trace_ref)
        if worst_by_duration is None or duration > worst_by_duration[0]:
            worst_by_duration = (duration, trace_ref)
        if worst_by_failures is None or tc_fail > worst_by_failures[0]:
            worst_by_failures = (tc_fail, trace_ref)

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

    # Find problematic tools (>30% failure rate with at least 3 calls)
    problem_tools = []
    for tool, stats in tool_stats.items():
        if stats["calls"] >= 3 and stats["failures"] / stats["calls"] > 0.3:
            rate = stats["failures"] / stats["calls"] * 100
            problem_tools.append(
                f"{tool}: {rate:.0f}% failure ({stats['failures']}/{stats['calls']})"
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

    # Frequent fallbacks
    if fallback_count > 0:
        fb_rate = fallback_count / total * 100
        anomalies.append(f"Fallback activated {fallback_count} times ({fb_rate:.0f}%) -- primary model may be unreliable")

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
            "chooms": sorted(sig["chooms"]),
            "error_class": sig.get("error_class"),
            "sample_error": sig["sample_error"],
            "trace_files": sig["trace_files"],
        })

    # Per-Choom × per-tool hot spots: single (choom, tool) pairs with >30% failure
    # rate and at least 3 calls. These would otherwise hide in the global aggregate.
    choom_tool_hotspots: List[Dict[str, Any]] = []
    for cn, tools_map in choom_tool_stats.items():
        for tool, stats in tools_map.items():
            if stats["calls"] >= 3 and stats["failures"] / stats["calls"] > 0.30:
                rate = stats["failures"] / stats["calls"] * 100
                choom_tool_hotspots.append({
                    "choom": cn,
                    "tool": tool,
                    "calls": stats["calls"],
                    "failures": stats["failures"],
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
        "tool_calls": {
            "total": sum(tool_call_counts),
            "avg_per_request": round(avg(tool_call_counts), 1),
            "success_rate": round(avg(tool_success_rates) * 100, 1) if tool_success_rates else 100,
        },
        "tokens": {
            "avg_total": round(avg(token_totals)),
            "total": sum(token_totals),
        },
        "behavior": {
            "nudges_total": sum(nudge_counts),
            "nudge_avg": round(avg(nudge_counts), 2),
            "fallback_count": fallback_count,
            "compaction_count": compaction_count,
            "force_tool_count": force_tool_count,
            "plan_mode_count": plan_mode_count,
        },
        "error_classes": error_classes,
        "problem_tools": problem_tools,
        "broken_tools": broken_tools_seen,
        "choom_stats": choom_stats,
        # New smarter-doctor fields (additive — old consumers ignore them)
        "top_failures": top_failures,
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
    metrics = [
        (["tool_calls", "success_rate"], "tool success rate", "lower", 5),
        (["iterations", "avg"], "avg iterations", "higher", 25),
        (["behavior", "fallback_count"], "fallback count", "higher", 50),
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
        return "Nightly Doctor: No traces found for today. System may be idle or trace logging not active."

    lines = [f"Nightly Doctor Report ({datetime.now().strftime('%Y-%m-%d')})"]
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

    # Tools
    tc = report["tool_calls"]
    lines.append(f"\nTools: {tc['total']} calls ({tc['avg_per_request']}/req), {tc['success_rate']}% success")

    # Behavior
    beh = report["behavior"]
    behavior_parts = []
    if beh["nudges_total"] > 0:
        behavior_parts.append(f"{beh['nudges_total']} nudges")
    if beh["fallback_count"] > 0:
        behavior_parts.append(f"{beh['fallback_count']} fallbacks")
    if beh["compaction_count"] > 0:
        behavior_parts.append(f"{beh['compaction_count']} compactions")
    if beh["plan_mode_count"] > 0:
        behavior_parts.append(f"{beh['plan_mode_count']} plan mode")
    if behavior_parts:
        lines.append(f"  Behavior: {', '.join(behavior_parts)}")

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
            lines.append(
                f"  [{tf['count']}x] {tf['tool']} ({chooms_str}): {err_preview}"
            )

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
            lines.append(
                f"  longest ({w['duration_ms']/1000:.0f}s): {w['choom']}/{w['source']} → {w['file']}"
            )
        if "by_failures" in worst:
            w = worst["by_failures"]
            lines.append(
                f"  most fails ({w['failures']}): {w['choom']}/{w['source']} → {w['file']}"
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


def run_diagnostics(lookback_days: int = 1) -> str:
    """Main entry point: load traces, analyze, add WoW trends, format report."""
    traces = load_traces(lookback_days=lookback_days)
    report = analyze_traces(traces)

    # Attach 7-day trend comparison (if historical reports exist)
    try:
        history = load_historical_reports(lookback_days=7, exclude_today=True)
        report["trends"] = compute_trends(report, history)
    except Exception as e:
        logger.warning(f"Failed to compute trends: {e}")
        report["trends"] = {"has_baseline": False, "drift_notes": []}

    formatted = format_report(report)

    # Also save the raw report as JSON for historical analysis
    report_dir = TRACES_DIR / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    report_file = report_dir / f"report-{datetime.now().strftime('%Y-%m-%d')}.json"
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
