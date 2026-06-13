#!/usr/bin/env bash
#
# upgrade-signal-cli.sh — manual, reversible signal-cli upgrade for the Choom bridge.
#
# The daily update check (scheduler.py:_check_signal_cli_update) only NOTIFIES;
# this script is the manual apply step you run after reviewing the release notes
# and issues page. It downloads the JVM distribution to match the existing
# install, repoints the systemd service, restarts the daemon, verifies it came
# up, and AUTO-ROLLS-BACK to the previous version if it didn't. The old install
# is left in /opt so you can also roll back by hand later.
#
# Usage:
#   sudo ./upgrade-signal-cli.sh            # upgrade to latest GitHub release
#   sudo ./upgrade-signal-cli.sh 0.14.5     # upgrade to a specific version
#
set -uo pipefail

SERVICE_FILE="/etc/systemd/system/signal-cli-daemon.service"
SERVICE_NAME="signal-cli-daemon.service"
REPO="AsamK/signal-cli"

err()  { echo "ERROR: $*" >&2; }
info() { echo ">>> $*"; }

# --- preflight --------------------------------------------------------------
if [[ "${EUID}" -ne 0 ]]; then
  err "must run as root (use: sudo $0 $*)"
  exit 1
fi
if [[ ! -f "${SERVICE_FILE}" ]]; then
  err "service file not found: ${SERVICE_FILE}"
  exit 1
fi
for bin in curl tar sed systemctl; do
  command -v "${bin}" >/dev/null 2>&1 || { err "required command missing: ${bin}"; exit 1; }
done

# --- resolve versions -------------------------------------------------------
CURRENT="$(grep -oE 'signal-cli-[0-9]+\.[0-9]+\.[0-9]+' "${SERVICE_FILE}" | head -1 | sed 's/signal-cli-//')"
[[ -z "${CURRENT}" ]] && { err "could not determine current version from ${SERVICE_FILE}"; exit 1; }

TARGET="${1:-}"
if [[ -z "${TARGET}" ]]; then
  info "Resolving latest release from GitHub..."
  TARGET="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
            | grep -oE '"tag_name":\s*"v?[0-9.]+"' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
fi
TARGET="${TARGET#v}"
[[ -z "${TARGET}" ]] && { err "could not resolve target version"; exit 1; }

info "Current: ${CURRENT}   Target: ${TARGET}"
if [[ "${CURRENT}" == "${TARGET}" ]]; then
  info "Already on ${TARGET}. Nothing to do."
  exit 0
fi

TARGET_DIR="/opt/signal-cli-${TARGET}"
BACKUP_FILE="${SERVICE_FILE}.bak.${CURRENT}"

# --- download + extract (skip if already present) ---------------------------
if [[ -x "${TARGET_DIR}/bin/signal-cli" ]]; then
  info "${TARGET_DIR} already present — skipping download."
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "${TMP}"' EXIT
  TARBALL="signal-cli-${TARGET}.tar.gz"
  URL="https://github.com/${REPO}/releases/download/v${TARGET}/${TARBALL}"
  info "Downloading ${URL}"
  if ! curl -fSL -o "${TMP}/${TARBALL}" "${URL}"; then
    err "download failed (does v${TARGET} exist?)"
    exit 1
  fi
  if ! tar tzf "${TMP}/${TARBALL}" >/dev/null 2>&1; then
    err "downloaded file is not a valid gzip tarball"
    exit 1
  fi
  info "Extracting to /opt"
  tar xzf "${TMP}/${TARBALL}" -C /opt/
  if [[ ! -x "${TARGET_DIR}/bin/signal-cli" ]]; then
    err "expected ${TARGET_DIR}/bin/signal-cli after extract — aborting"
    exit 1
  fi
fi

# --- repoint service + restart ----------------------------------------------
info "Backing up service file -> ${BACKUP_FILE}"
cp -f "${SERVICE_FILE}" "${BACKUP_FILE}"

info "Repointing ${SERVICE_NAME} to ${TARGET}"
sed -i "s#/opt/signal-cli-[0-9]\+\.[0-9]\+\.[0-9]\+/#${TARGET_DIR}/#g" "${SERVICE_FILE}"

systemctl daemon-reload
info "Restarting ${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

# --- verify (with auto-rollback) --------------------------------------------
info "Verifying daemon came up..."
ok=0
for _ in $(seq 1 15); do
  sleep 1
  if systemctl is-active --quiet "${SERVICE_NAME}" \
     && journalctl -u "${SERVICE_NAME}" --since "30 sec ago" --no-pager 2>/dev/null \
        | grep -q "Started JSON-RPC server"; then
    ok=1
    break
  fi
done

if [[ "${ok}" -eq 1 ]]; then
  info "SUCCESS: ${SERVICE_NAME} active on ${TARGET}."
  info "Old install left at /opt/signal-cli-${CURRENT} for rollback."
  info "Send a test Signal message and watch:  journalctl -u ${SERVICE_NAME} -f"
  exit 0
fi

err "daemon did NOT come up cleanly on ${TARGET} — rolling back to ${CURRENT}"
cp -f "${BACKUP_FILE}" "${SERVICE_FILE}"
systemctl daemon-reload
systemctl restart "${SERVICE_NAME}"
sleep 3
if systemctl is-active --quiet "${SERVICE_NAME}"; then
  err "rolled back to ${CURRENT} — daemon is active again. Investigate before retrying."
else
  err "ROLLBACK ALSO FAILED. Check: systemctl status ${SERVICE_NAME} ; journalctl -u ${SERVICE_NAME} -n 50"
fi
exit 1
