#!/usr/bin/env python3
"""
Test script for Signal Bridge components
Run this after setup to verify everything works
"""
import sys
import os

# Add current directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
load_dotenv()

import config

def test_signal_cli():
    """Test signal-cli is installed and configured"""
    print("\n=== Testing signal-cli ===")

    import subprocess

    # Check version
    try:
        result = subprocess.run(
            [config.SIGNAL_CLI_PATH, "--version"],
            capture_output=True,
            text=True
        )
        print(f"✓ signal-cli version: {result.stdout.strip()}")
    except FileNotFoundError:
        print(f"✗ signal-cli not found at {config.SIGNAL_CLI_PATH}")
        return False

    # Check if account is linked
    try:
        result = subprocess.run(
            [config.SIGNAL_CLI_PATH, "-a", config.SIGNAL_PHONE_NUMBER, "listAccounts"],
            capture_output=True,
            text=True
        )
        if config.SIGNAL_PHONE_NUMBER in result.stdout:
            print(f"✓ Account {config.SIGNAL_PHONE_NUMBER} is registered")
        else:
            print(f"✗ Account {config.SIGNAL_PHONE_NUMBER} not found")
            print(f"  Run: signal-cli link -n 'Choom Server'")
            return False
    except Exception as e:
        print(f"✗ Error checking accounts: {e}")
        return False

    return True


def test_choom_api():
    """Test Choom API is accessible"""
    print("\n=== Testing Choom API ===")

    import requests

    try:
        # Test health endpoint
        response = requests.post(f"{config.CHOOM_API_URL}/api/health", timeout=10)
        if response.ok:
            print(f"✓ Choom API health check passed")
            data = response.json()
            services = data.get('services', {})
            for name, info in services.items():
                status = info.get('status', 'unknown') if isinstance(info, dict) else info
                icon = "✓" if status == 'connected' else "✗"
                print(f"  {icon} {name}: {status}")
        else:
            print(f"✗ Choom API returned {response.status_code}")
            return False
    except requests.ConnectionError:
        print(f"✗ Cannot connect to Choom API at {config.CHOOM_API_URL}")
        print("  Make sure the Next.js server is running")
        return False
    except Exception as e:
        print(f"✗ Error: {e}")
        return False

    # Test Chooms endpoint
    try:
        response = requests.get(f"{config.CHOOM_API_URL}/api/chooms", timeout=10)
        if response.ok:
            data = response.json()
            chooms = data.get('chooms', [])
            print(f"✓ Found {len(chooms)} Chooms:")
            for choom in chooms:
                print(f"  - {choom['name']} ({choom['id'][:8]}...)")
        else:
            print(f"✗ Chooms endpoint returned {response.status_code}")
    except Exception as e:
        print(f"✗ Error fetching Chooms: {e}")

    return True


def test_tts():
    """Test TTS service"""
    print("\n=== Testing TTS Service ===")

    import requests

    try:
        # Check if TTS is available
        response = requests.get(f"{config.TTS_ENDPOINT}/v1/voices", timeout=10)
        if response.ok:
            print(f"✓ TTS service is available")
            try:
                voices = response.json()
                print(f"  Found {len(voices)} voices")
            except:
                pass
        else:
            print(f"✗ TTS service returned {response.status_code}")
            return False
    except requests.ConnectionError:
        print(f"✗ Cannot connect to TTS at {config.TTS_ENDPOINT}")
        return False
    except Exception as e:
        print(f"✗ Error: {e}")
        return False

    return True


def test_stt():
    """Test STT service"""
    print("\n=== Testing STT Service ===")

    import requests

    try:
        # Simple health check - just try to connect
        response = requests.get(f"{config.STT_ENDPOINT}/", timeout=10)
        print(f"✓ STT service is available (status: {response.status_code})")
    except requests.ConnectionError:
        print(f"✗ Cannot connect to STT at {config.STT_ENDPOINT}")
        return False
    except Exception as e:
        print(f"? STT check inconclusive: {e}")

    return True


def test_message_parsing():
    """Test message parsing for Choom names"""
    print("\n=== Testing Message Parsing ===")

    from signal_handler import MessageParser

    test_cases = [
        ("Genesis: What's the weather?", ("Genesis", "What's the weather?")),
        ("Lissa, tell me a joke", ("Lissa", "tell me a joke")),
        ("@Genesis hello", ("Genesis", "hello")),
        ("hello there", (None, "hello there")),
        ("GENESIS: test", ("Genesis", "test")),
    ]

    all_passed = True
    for message, expected in test_cases:
        result = MessageParser.extract_choom_name(message)
        if result == expected:
            print(f"✓ '{message}' → {result}")
        else:
            print(f"✗ '{message}' → {result} (expected {expected})")
            all_passed = False

    return all_passed


def main():
    print("=" * 50)
    print("Signal Bridge Test Suite")
    print("=" * 50)

    results = {
        "Message Parsing": test_message_parsing(),
        "Choom API": test_choom_api(),
        "TTS Service": test_tts(),
        "STT Service": test_stt(),
        "signal-cli": test_signal_cli(),
    }

    print("\n" + "=" * 50)
    print("Summary")
    print("=" * 50)

    all_passed = True
    for name, passed in results.items():
        icon = "✓" if passed else "✗"
        print(f"{icon} {name}")
        if not passed:
            all_passed = False

    if all_passed:
        print("\n✓ All tests passed! You can start the bridge:")
        print("  python bridge.py")
    else:
        print("\n✗ Some tests failed. Please fix the issues above.")

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
