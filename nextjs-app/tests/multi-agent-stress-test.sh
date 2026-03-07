#!/bin/bash
# Multi-Agent Stress Test for Choom System
# Tests: Planning, Delegation, Code Execution, Verification, Reporting
# Aloy (orchestrator) → Genesis (research) + Anya (coding)
#
# Usage: bash tests/multi-agent-stress-test.sh [test_number]

set -euo pipefail

API="http://localhost:3000/api"
ALOY_ID="cmlyeo9e60022dpz6dng26zv5"
GENESIS_ID="cml8frtm300001149xgozcbh3"
ANYA_ID="cmlybalq2007tejr2rb49jhxl"

LOG_DIR="/tmp/choom-stress-test"
mkdir -p "$LOG_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${CYAN}[$(date +%H:%M:%S)]${NC} $1"; }
pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

# Create a fresh chat for a Choom
create_chat() {
  local choom_id="$1"
  local title="$2"
  local chat_id
  chat_id=$(curl -s -X POST "$API/chats" \
    -H "Content-Type: application/json" \
    -d "{\"choomId\": \"$choom_id\", \"title\": \"$title\"}" | jq -r '.id // .chatId // empty')

  if [ -z "$chat_id" ]; then
    # Fallback: create via prisma directly
    chat_id=$(sqlite3 /home/nuc1/projects/Choom/nextjs-app/prisma/dev.db "
      INSERT INTO Chat (id, choomId, title, createdAt, updatedAt)
      VALUES ('test_$(date +%s)_${RANDOM}', '$choom_id', '$title', datetime('now'), datetime('now'));
      SELECT id FROM Chat WHERE choomId='$choom_id' ORDER BY createdAt DESC LIMIT 1;
    ")
  fi
  echo "$chat_id"
}

# Send message and capture SSE response
send_message() {
  local choom_id="$1"
  local chat_id="$2"
  local message="$3"
  local log_file="$4"
  local timeout="${5:-300}"

  log "Sending to $(sqlite3 /home/nuc1/projects/Choom/nextjs-app/prisma/dev.db "SELECT name FROM Choom WHERE id='$choom_id';"): ${message:0:80}..."

  # Build settings with LM Studio endpoint
  local settings='{"llm":{"endpoint":"http://192.168.1.145:1234/v1","temperature":0.7,"maxTokens":4096,"contextLength":131072}}'

  local payload
  payload=$(jq -n \
    --arg cid "$choom_id" \
    --arg chatid "$chat_id" \
    --arg msg "$message" \
    --argjson settings "$settings" \
    '{choomId: $cid, chatId: $chatid, message: $msg, settings: $settings}')

  # Stream SSE response, capture content
  curl -s -N --max-time "$timeout" \
    -X POST "$API/chat" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null | tee "$log_file" | while IFS= read -r line; do
      # Parse SSE data lines
      if [[ "$line" == data:* ]]; then
        local data="${line#data:}"
        # Extract content tokens for live display
        local content
        content=$(echo "$data" | jq -r '.content // empty' 2>/dev/null)
        if [ -n "$content" ]; then
          printf "%s" "$content"
        fi
        # Show tool calls
        local tool_name
        tool_name=$(echo "$data" | jq -r '.tool_call.name // empty' 2>/dev/null)
        if [ -n "$tool_name" ]; then
          echo -e "\n${YELLOW}  → tool: $tool_name${NC}"
        fi
        # Show tool results
        local tool_result
        tool_result=$(echo "$data" | jq -r 'if .tool_result then "tool_result: \(.tool_result.name)" else empty end' 2>/dev/null)
        if [ -n "$tool_result" ]; then
          echo -e "${GREEN}  ← $tool_result${NC}"
        fi
        # Show delegation events
        local delegation
        delegation=$(echo "$data" | jq -r '.delegation_started // empty' 2>/dev/null)
        if [ -n "$delegation" ]; then
          echo -e "\n${CYAN}  ⇒ DELEGATING: $delegation${NC}"
        fi
        local delegation_done
        delegation_done=$(echo "$data" | jq -r '.delegation_completed // empty' 2>/dev/null)
        if [ -n "$delegation_done" ]; then
          echo -e "${GREEN}  ⇐ DELEGATION COMPLETE${NC}"
        fi
      fi
    done
  echo ""
}

# Extract final response text from SSE log
extract_response() {
  local log_file="$1"
  grep '^data:' "$log_file" | sed 's/^data://' | jq -r '.content // empty' 2>/dev/null | tr -d '\n'
}

# Check if response contains expected patterns
check_response() {
  local log_file="$1"
  local pattern="$2"
  local description="$3"

  if grep -qi "$pattern" "$log_file" 2>/dev/null; then
    pass "$description"
    return 0
  else
    fail "$description"
    return 1
  fi
}

# Check if tool was called in the SSE stream
check_tool_called() {
  local log_file="$1"
  local tool_name="$2"

  if grep -q "\"name\":\"$tool_name\"" "$log_file" 2>/dev/null || \
     grep -q "\"$tool_name\"" "$log_file" 2>/dev/null; then
    pass "Tool called: $tool_name"
    return 0
  else
    fail "Tool NOT called: $tool_name"
    return 1
  fi
}

# ============================================================================
# TEST 1: Basic Tool Usage (single Choom, no delegation)
# ============================================================================
test_1_basic_tools() {
  log "═══════════════════════════════════════════════════════"
  log "TEST 1: Basic Tool Usage (Aloy - single agent)"
  log "═══════════════════════════════════════════════════════"

  local chat_id
  chat_id=$(create_chat "$ALOY_ID" "Stress Test 1: Basic Tools")
  log "Chat ID: $chat_id"

  # Use unique project name to avoid collisions with previous runs
  local proj_name="stress-test-basics-$(date +%s)"
  send_message "$ALOY_ID" "$chat_id" \
    "Create a workspace project called '$proj_name'. Then write a file called 'hello.py' in it with a Python script that prints the first 10 Fibonacci numbers. Then execute that Python script and tell me the output." \
    "$LOG_DIR/test1.log" 180

  echo ""
  log "--- Test 1 Results ---"
  local score=0
  check_tool_called "$LOG_DIR/test1.log" "workspace_create_project" && ((score++)) || true
  check_tool_called "$LOG_DIR/test1.log" "workspace_write_file" && ((score++)) || true
  check_tool_called "$LOG_DIR/test1.log" "execute_code" && ((score++)) || true

  # Check response mentions Fibonacci numbers
  check_response "$LOG_DIR/test1.log" "fibonacci\|1.*1.*2.*3.*5.*8\|13.*21.*34.*55" "Response contains Fibonacci output" && ((score++)) || true

  log "Test 1 Score: $score/4"
  echo ""
  return $((4 - score))
}

# ============================================================================
# TEST 2: Delegation (Aloy → Genesis for research)
# ============================================================================
test_2_delegation() {
  log "═══════════════════════════════════════════════════════"
  log "TEST 2: Delegation (Aloy → Genesis)"
  log "═══════════════════════════════════════════════════════"

  local chat_id
  chat_id=$(create_chat "$ALOY_ID" "Stress Test 2: Delegation")
  log "Chat ID: $chat_id"

  send_message "$ALOY_ID" "$chat_id" \
    "Delegate to Genesis: Ask Genesis to search the web for 'what is the current population of Tokyo Japan 2025' and report back with the answer. Use the delegate_to_choom tool." \
    "$LOG_DIR/test2.log" 240

  echo ""
  log "--- Test 2 Results ---"
  local score=0
  check_tool_called "$LOG_DIR/test2.log" "delegate_to_choom" && ((score++)) || true
  check_response "$LOG_DIR/test2.log" "delegation_started\|delegation_completed\|Genesis" "Delegation events present" && ((score++)) || true
  check_response "$LOG_DIR/test2.log" "million\|population\|Tokyo\|14\|13\|37\|38" "Response contains population data" && ((score++)) || true

  log "Test 2 Score: $score/3"
  echo ""
  return $((3 - score))
}

# ============================================================================
# TEST 3: Plan Mode (create + execute a multi-step plan)
# ============================================================================
test_3_plan_mode() {
  log "═══════════════════════════════════════════════════════"
  log "TEST 3: Plan Mode (create_plan + execute_plan)"
  log "═══════════════════════════════════════════════════════"

  local chat_id
  chat_id=$(create_chat "$ALOY_ID" "Stress Test 3: Plan Mode")
  log "Chat ID: $chat_id"

  local proj_name="plan-test-$(date +%s)"
  send_message "$ALOY_ID" "$chat_id" \
    "I need you to create a plan and execute it. The plan should:
Step 1: Create a workspace project called '$proj_name'
Step 2: Write a Python file 'calculator.py' that defines add, subtract, multiply, divide functions
Step 3: Write a test file 'test_calculator.py' that tests all 4 functions with assertions
Step 4: Execute the test file to verify it passes

Use create_plan to define these steps, then use execute_plan to run the plan." \
    "$LOG_DIR/test3.log" 300

  echo ""
  log "--- Test 3 Results ---"
  local score=0
  # Plan can be created via Path 1 (auto-detect, shows plan_created event) or Path 2 (LLM calls create_plan tool)
  check_response "$LOG_DIR/test3.log" "create_plan\|plan_created\|plan_id" "Plan was created (Path 1 or Path 2)" && ((score++)) || true
  # Execution shows either execute_plan tool call or plan_step_update events
  check_response "$LOG_DIR/test3.log" "execute_plan\|plan_step_update\|steps.*completed" "Plan was executed" && ((score++)) || true
  check_response "$LOG_DIR/test3.log" "calculator\|add\|subtract\|multiply\|divide" "Calculator functions created" && ((score++)) || true
  check_response "$LOG_DIR/test3.log" "pass\|success\|complet\|all.*test" "Tests passed or plan completed" && ((score++)) || true

  log "Test 3 Score: $score/4"
  echo ""
  return $((4 - score))
}

# ============================================================================
# TEST 4: Multi-Agent Collaboration (the big one)
# ============================================================================
test_4_multi_agent() {
  log "═══════════════════════════════════════════════════════"
  log "TEST 4: Multi-Agent Collaboration"
  log "  Aloy orchestrates, Genesis researches, Anya codes"
  log "═══════════════════════════════════════════════════════"

  local chat_id
  chat_id=$(create_chat "$ALOY_ID" "Stress Test 4: Multi-Agent")
  log "Chat ID: $chat_id"

  send_message "$ALOY_ID" "$chat_id" \
    "I need a team effort. Create a plan to build a 'weather-dashboard' project:

1. Delegate to Genesis: search the web for 'OpenWeatherMap API free tier endpoints' and summarize the available endpoints and rate limits.

2. Delegate to Anya: Create a workspace project called 'weather-dash-$(date +%s)'. Then write a Python file 'weather_api.py' that contains:
   - A WeatherAPI class with methods: get_current(city), get_forecast(city, days)
   - Each method should return a dict with mock data (temperature, humidity, description)
   - Include proper docstrings and type hints

3. After Anya finishes, delegate to Anya again: Write a 'test_weather.py' file in the same project that tests the WeatherAPI class, then execute it to verify it passes.

4. After all steps complete, write a summary report as 'README.md' in the project.

Use create_plan with delegate steps for Genesis and Anya, then execute_plan." \
    "$LOG_DIR/test4.log" 480

  echo ""
  log "--- Test 4 Results ---"
  local score=0
  check_tool_called "$LOG_DIR/test4.log" "create_plan" && ((score++)) || true
  check_tool_called "$LOG_DIR/test4.log" "execute_plan" && ((score++)) || true
  # Delegation happens inside plan executor — check for delegation SSE events
  check_response "$LOG_DIR/test4.log" "delegation_started\|delegate_to_choom\|delegate.*Genesis\|delegate.*Anya" "Delegation occurred" && ((score++)) || true
  check_response "$LOG_DIR/test4.log" "Genesis\|genesis" "Genesis was involved" && ((score++)) || true
  check_response "$LOG_DIR/test4.log" "Anya\|anya" "Anya was involved" && ((score++)) || true
  check_response "$LOG_DIR/test4.log" "weather\|Weather\|API" "Weather-related content in response" && ((score++)) || true
  check_response "$LOG_DIR/test4.log" "complet\|success\|pass\|done\|finished" "Task completed successfully" && ((score++)) || true

  log "Test 4 Score: $score/7"
  echo ""
  return $((7 - score))
}

# ============================================================================
# TEST 5: Error Recovery (deliberate failure handling)
# ============================================================================
test_5_error_recovery() {
  log "═══════════════════════════════════════════════════════"
  log "TEST 5: Error Recovery & Resilience"
  log "═══════════════════════════════════════════════════════"

  local chat_id
  chat_id=$(create_chat "$ALOY_ID" "Stress Test 5: Error Recovery")
  log "Chat ID: $chat_id"

  local proj_name="error-test-$(date +%s)"
  send_message "$ALOY_ID" "$chat_id" \
    "Create a project called '$proj_name'. Write a Python file 'buggy.py' with this intentionally buggy code:

def divide(a, b):
    return a / b

result = divide(10, 0)
print(result)

Execute it. It will fail with a ZeroDivisionError. Then fix the bug by adding error handling, write the fixed version, and execute it again to show it works." \
    "$LOG_DIR/test5.log" 240

  echo ""
  log "--- Test 5 Results ---"
  local score=0
  check_tool_called "$LOG_DIR/test5.log" "workspace_create_project" && ((score++)) || true
  check_tool_called "$LOG_DIR/test5.log" "workspace_write_file" && ((score++)) || true
  check_tool_called "$LOG_DIR/test5.log" "execute_code" && ((score++)) || true
  check_response "$LOG_DIR/test5.log" "ZeroDivision\|division.*zero\|error" "Detected the error" && ((score++)) || true
  check_response "$LOG_DIR/test5.log" "fix\|handle\|try\|except\|recover" "Attempted to fix" && ((score++)) || true

  log "Test 5 Score: $score/5"
  echo ""
  return $((5 - score))
}

# ============================================================================
# MAIN
# ============================================================================

main() {
  log "╔═══════════════════════════════════════════════════════╗"
  log "║     CHOOM MULTI-AGENT STRESS TEST SUITE              ║"
  log "║     $(date)                         ║"
  log "╚═══════════════════════════════════════════════════════╝"
  echo ""

  # Check API is up
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/chat" -H "Content-Type: application/json" -d '{}' 2>/dev/null)
  if [ "$status" = "000" ]; then
    fail "API not reachable at $API/chat"
    exit 1
  fi
  pass "API reachable (status: $status)"

  # Check LM Studio
  local models
  models=$(curl -s http://192.168.1.145:1234/v1/models 2>/dev/null | jq -r '.data[].id' 2>/dev/null | head -5)
  if [ -z "$models" ]; then
    fail "LM Studio not reachable"
    exit 1
  fi
  pass "LM Studio models: $(echo $models | tr '\n' ', ')"
  echo ""

  local total_failures=0
  local test_num="${1:-all}"

  if [ "$test_num" = "all" ] || [ "$test_num" = "1" ]; then
    test_1_basic_tools || total_failures=$((total_failures + $?))
  fi

  if [ "$test_num" = "all" ] || [ "$test_num" = "2" ]; then
    test_2_delegation || total_failures=$((total_failures + $?))
  fi

  if [ "$test_num" = "all" ] || [ "$test_num" = "3" ]; then
    test_3_plan_mode || total_failures=$((total_failures + $?))
  fi

  if [ "$test_num" = "all" ] || [ "$test_num" = "4" ]; then
    test_4_multi_agent || total_failures=$((total_failures + $?))
  fi

  if [ "$test_num" = "all" ] || [ "$test_num" = "5" ]; then
    test_5_error_recovery || total_failures=$((total_failures + $?))
  fi

  echo ""
  log "═══════════════════════════════════════════════════════"
  if [ "$total_failures" -eq 0 ]; then
    pass "ALL TESTS PASSED!"
  else
    fail "$total_failures total check(s) failed"
  fi
  log "Logs saved to: $LOG_DIR/"
  log "═══════════════════════════════════════════════════════"
}

main "$@"
