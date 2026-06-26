#!/usr/bin/env bash
# One-time setup for the secret-scanning pre-commit hook.
#   1. installs gitleaks (pinned) to ~/.local/bin if it's missing
#   2. points git at the repo's tracked hooks via core.hooksPath
#
# Run once after cloning:  bash .githooks/install.sh
# (core.hooksPath is a LOCAL git setting, so each clone runs this once.)
set -euo pipefail

VER=8.30.1
repo_root="$(git rev-parse --show-toplevel)"

if ! command -v gitleaks >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/gitleaks" ]; then
  mkdir -p "$HOME/.local/bin"
  case "$(uname -m)" in
    x86_64)        arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l)        arch=armv7 ;;
    *)             arch="$(uname -m)" ;;
  esac
  url="https://github.com/gitleaks/gitleaks/releases/download/v${VER}/gitleaks_${VER}_linux_${arch}.tar.gz"
  echo "Installing gitleaks ${VER} (${arch}) → ~/.local/bin …"
  curl -fsSL "$url" | tar -xz -C "$HOME/.local/bin" gitleaks
  chmod +x "$HOME/.local/bin/gitleaks"
fi

git -C "$repo_root" config core.hooksPath .githooks
echo "✓ Secret-scanning pre-commit hook enabled."
echo "  gitleaks:       $(command -v gitleaks || echo "$HOME/.local/bin/gitleaks")"
echo "  core.hooksPath: $(git -C "$repo_root" config core.hooksPath)"
