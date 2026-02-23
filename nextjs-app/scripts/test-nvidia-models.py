#!/usr/bin/env python3
"""
NVIDIA Build API Model Tester
Tests latency, availability, and tool-calling support for NVIDIA Build models.
Reads API key from bridge-config.json automatically.

Usage:
  python3 scripts/test-nvidia-models.py              # Test all models
  python3 scripts/test-nvidia-models.py --quick       # Quick check (no tool test)
  python3 scripts/test-nvidia-models.py --model NAME  # Test a specific model
  python3 scripts/test-nvidia-models.py --timeout 30  # Custom timeout (default 120s)
"""

import json
import time
import sys
import argparse
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

ENDPOINT = "https://integrate.api.nvidia.com/v1"

MODELS = [
    "nvidia/llama-3.1-nemotron-ultra-253b-v1",
    "mistralai/mistral-large-3-675b-instruct-2512",
    "deepseek-ai/deepseek-v3.2",
    "moonshotai/kimi-k2.5",
    "moonshotai/kimi-k2-instruct",
    "qwen/qwen3.5-397b-a17b",
    "qwen/qwen3-coder-480b-a35b-instruct",
    "stepfun-ai/step-3.5-flash",
    "z-ai/glm4.7",
    "z-ai/glm5",
    "meta/llama-3.1-405b-instruct",
    "mistralai/mistral-nemotron",
]

SIMPLE_PROMPT = [
    {"role": "user", "content": "What is 2+2? Reply with just the number."}
]

TOOL_PROMPT = [
    {"role": "user", "content": "What's the weather in Tokyo? Use the get_weather tool."}
]

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get current weather for a location",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {"type": "string", "description": "City name"}
                },
                "required": ["location"],
            },
        },
    }
]


def get_api_key():
    """Read NVIDIA API key from bridge-config.json"""
    config_path = Path(__file__).parent.parent / "services" / "signal-bridge" / "bridge-config.json"
    if not config_path.exists():
        print(f"Error: {config_path} not found")
        sys.exit(1)

    with open(config_path) as f:
        config = json.load(f)

    providers = config.get("providers", [])
    for p in providers:
        if "nvidia" in p.get("id", "").lower() or "nvidia" in p.get("name", "").lower():
            key = p.get("apiKey", "")
            if key and key.startswith("nvapi-"):
                return key

    print("Error: No NVIDIA provider with API key found in bridge-config.json")
    print("Add an NVIDIA provider in Settings > Providers with your API key")
    sys.exit(1)


def test_model(model, api_key, timeout=120, test_tools=True):
    """Test a single model for availability, latency, and tool support"""
    result = {
        "model": model,
        "status": "unknown",
        "latency": None,
        "response": None,
        "tools": None,
        "error": None,
    }

    # --- Basic chat test ---
    body = json.dumps({
        "model": model,
        "messages": SIMPLE_PROMPT,
        "max_tokens": 32,
        "temperature": 0.1,
        "stream": False,
    }).encode()

    req = Request(
        f"{ENDPOINT}/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    start = time.time()
    try:
        with urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
            elapsed = time.time() - start
            content = (data["choices"][0]["message"].get("content") or "").strip()
            result["status"] = "ok"
            result["latency"] = round(elapsed, 1)
            result["response"] = content[:80] if content else "(empty)"
    except HTTPError as e:
        elapsed = time.time() - start
        result["latency"] = round(elapsed, 1)
        try:
            error_body = e.read().decode()[:200]
        except Exception:
            error_body = str(e)
        if e.code == 404:
            result["status"] = "not_found"
            result["error"] = "Model not found (404)"
        elif e.code == 401:
            result["status"] = "auth_error"
            result["error"] = "Authentication failed (401)"
        elif e.code == 429:
            result["status"] = "rate_limited"
            result["error"] = "Rate limited (429)"
        elif e.code == 500 or e.code == 503:
            result["status"] = "server_error"
            result["error"] = f"Server error ({e.code})"
        else:
            result["status"] = "error"
            result["error"] = f"HTTP {e.code}: {error_body}"
    except URLError as e:
        elapsed = time.time() - start
        result["latency"] = round(elapsed, 1)
        if "timed out" in str(e).lower():
            result["status"] = "timeout"
            result["error"] = f"Timed out after {timeout}s"
        else:
            result["status"] = "error"
            result["error"] = str(e.reason)[:100]
    except TimeoutError:
        elapsed = time.time() - start
        result["latency"] = round(elapsed, 1)
        result["status"] = "timeout"
        result["error"] = f"Timed out after {timeout}s"

    # --- Tool calling test ---
    if test_tools and result["status"] == "ok":
        tool_body = json.dumps({
            "model": model,
            "messages": TOOL_PROMPT,
            "tools": TOOLS,
            "tool_choice": "auto",
            "max_tokens": 128,
            "temperature": 0.1,
            "stream": False,
        }).encode()

        tool_req = Request(
            f"{ENDPOINT}/chat/completions",
            data=tool_body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            method="POST",
        )

        try:
            with urlopen(tool_req, timeout=timeout) as resp:
                data = json.loads(resp.read())
                msg = data["choices"][0]["message"]
                if msg.get("tool_calls"):
                    tc = msg["tool_calls"][0]
                    name = tc["function"]["name"]
                    args = tc["function"].get("arguments", "")
                    result["tools"] = f"yes ({name}: {args[:50]})"
                else:
                    result["tools"] = "no (responded with text)"
        except HTTPError as e:
            try:
                err = e.read().decode()[:100]
            except Exception:
                err = str(e)
            result["tools"] = f"error ({e.code}: {err[:60]})"
        except (URLError, TimeoutError):
            result["tools"] = "timeout"

    return result


def format_status(status):
    """Color-code status for terminal output"""
    colors = {
        "ok":           "\033[92m OK \033[0m",
        "timeout":      "\033[93m TIMEOUT \033[0m",
        "not_found":    "\033[91m NOT FOUND \033[0m",
        "auth_error":   "\033[91m AUTH ERR \033[0m",
        "rate_limited": "\033[93m RATE LTD \033[0m",
        "server_error": "\033[91m SVR ERR \033[0m",
        "error":        "\033[91m ERROR \033[0m",
    }
    return colors.get(status, f" {status} ")


def main():
    parser = argparse.ArgumentParser(description="Test NVIDIA Build API models")
    parser.add_argument("--quick", action="store_true", help="Skip tool-calling test")
    parser.add_argument("--model", type=str, help="Test a specific model ID")
    parser.add_argument("--timeout", type=int, default=120, help="Timeout per request in seconds (default: 120)")
    parser.add_argument("--key", type=str, help="API key (default: read from bridge-config.json)")
    args = parser.parse_args()

    api_key = args.key or get_api_key()
    models = [args.model] if args.model else MODELS
    test_tools = not args.quick

    print(f"\n{'='*80}")
    print(f"  NVIDIA Build API Model Tester")
    print(f"  Endpoint: {ENDPOINT}")
    print(f"  Models: {len(models)}  |  Timeout: {args.timeout}s  |  Tools: {'yes' if test_tools else 'skip'}")
    print(f"  Key: {api_key[:12]}...{api_key[-4:]}")
    print(f"{'='*80}\n")

    results = []
    for i, model in enumerate(models, 1):
        short_name = model.split("/")[-1] if "/" in model else model
        print(f"  [{i}/{len(models)}] Testing {short_name}...", end="", flush=True)
        result = test_model(model, api_key, timeout=args.timeout, test_tools=test_tools)
        results.append(result)

        status_str = format_status(result["status"])
        latency_str = f"{result['latency']}s" if result["latency"] else "—"
        print(f"\r  [{i}/{len(models)}] {status_str} {latency_str:>7}  {short_name}")

        if result["error"]:
            print(f"           └─ {result['error']}")
        if result["tools"]:
            print(f"           └─ Tools: {result['tools']}")

    # --- Summary ---
    ok = [r for r in results if r["status"] == "ok"]
    failed = [r for r in results if r["status"] != "ok"]
    tools_yes = [r for r in ok if (r.get("tools") or "").startswith("yes")]
    tools_no = [r for r in ok if (r.get("tools") or "").startswith("no")]

    print(f"\n{'='*80}")
    print(f"  Summary: {len(ok)}/{len(results)} models available")
    if test_tools and ok:
        print(f"  Tool calling: {len(tools_yes)} supported, {len(tools_no)} text-only")
    if ok:
        latencies = [r["latency"] for r in ok if r["latency"]]
        if latencies:
            print(f"  Latency: {min(latencies)}s - {max(latencies)}s (avg {sum(latencies)/len(latencies):.1f}s)")
    if failed:
        print(f"\n  Failed models:")
        for r in failed:
            short = r["model"].split("/")[-1]
            print(f"    {r['status']:>12}  {short}: {r['error']}")
    print(f"{'='*80}\n")


if __name__ == "__main__":
    main()
