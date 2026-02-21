---
name: code-execution
description: Executes Python and Node.js code in sandboxed project workspaces. Supports virtual environments, package installation, and shell commands.
version: 1.0.0
author: system
tools:
  - execute_code
  - create_venv
  - install_package
  - run_command
dependencies: []
---

# Code Execution (Sandbox)

## When to Use
- Run Python/Node.js code → `execute_code`
- Initialize project → `create_venv` (do this BEFORE installing packages)
- Install packages → `install_package`
- Shell commands → `run_command`

## Important
- Timeout: default 30s, max 120s
- Python venvs auto-activated if present
- Output truncated at 50KB per stream
- Always create venv/project before installing packages
