---
name: code-execution
description: Executes Python and Node.js code in sandboxed project workspaces, plus permission-gated remote SSH commands.
version: 1.1.0
author: system
tools:
  - execute_code
  - create_venv
  - install_package
  - run_command
  - run_ssh_command
dependencies: []
---

# Code Execution (Sandbox)

## When to Use
- Run Python/Node.js code → `execute_code`
- Initialize project → `create_venv` (do this BEFORE installing packages)
- Install packages → `install_package`
- Shell commands → `run_command`
- Remote SSH command → `run_ssh_command` (only when Remote SSH is enabled for this Choom)

## Important
- Timeout: default 30s, max 120s
- Python venvs auto-activated if present
- Output truncated at 50KB per stream
- Always create venv/project before installing packages
- Remote SSH uses existing non-interactive OpenSSH keys and known hosts; never request passwords or bypass host verification
