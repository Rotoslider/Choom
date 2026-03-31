"""
Nightly Doctor — Automated Diagnostic Analyzer

Reads execution trace JSON files from data/traces/, computes daily aggregates,
detects anomalies, and generates a diagnostic report for Signal notification.
"""

import json
import os
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Any, Optional

logger = logging.getLogger(__name__)

# Traces directory (relative to nextjs-app/)
TRACES_DIR = Path(__file__).parent.parent.parent / "data" / "traces"


def load_traces(date_str: Optional[str] = None, lookback_days: int = 1) -> List[Dict[str, Any]]:
    """Load trace files for a date range. Defaults to the last 24 hours."""
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
                    traces.append(trace)
            except (json.JSONDecodeError, IOError) as e:
                logger.warning(f"Failed to read trace {f}: {e}")

    return traces


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

        # Per-tool stats
        for tc in t.get("toolCalls", []):
            tool = tc.get("tool", "unknown")
            if tool not in tool_stats:
                tool_stats[tool] = {"calls": 0, "successes": 0, "failures": 0}
            tool_stats[tool]["calls"] += 1
            if tc.get("success"):
                tool_stats[tool]["successes"] += 1
            else:
                tool_stats[tool]["failures"] += 1
                ec = tc.get("errorClass", "other")
                if ec:
                    error_classes[ec] = error_classes.get(ec, 0) + 1

        # Broken tools
        for bt in t.get("brokenTools", []):
            broken_tools_seen[bt] = broken_tools_seen.get(bt, 0) + 1

        # Per-choom stats
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
        "anomalies": anomalies,
    }

    return report


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
    """Main entry point: load traces, analyze, format report."""
    traces = load_traces(lookback_days=lookback_days)
    report = analyze_traces(traces)
    formatted = format_report(report)

    # Also save the raw report as JSON for historical analysis
    report_dir = TRACES_DIR / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    report_file = report_dir / f"report-{datetime.now().strftime('%Y-%m-%d')}.json"
    try:
        with open(report_file, "w") as f:
            json.dump(report, f, indent=2, default=str)
    except IOError as e:
        logger.warning(f"Failed to save report JSON: {e}")

    return formatted


if __name__ == "__main__":
    # Run standalone for testing
    logging.basicConfig(level=logging.INFO)
    report = run_diagnostics(lookback_days=1)
    print(report)
