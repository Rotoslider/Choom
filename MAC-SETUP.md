# Running Choom on macOS (Apple Silicon)

Choom was built on Ubuntu and every service assumption in the repo reflects
that: systemd units, `journalctl`, `/run/user/$UID` sockets, `apt`. None of
those exist on macOS. This document is the macOS counterpart to the Linux
instructions in [README.md](README.md#getting-started) — it covers what is
genuinely different, not the parts that are the same.

Verified on macOS 15 (Darwin 24.6.0), Apple Silicon (M3 Ultra).

---

## What is different from Linux

| Concern | Linux | macOS |
|---|---|---|
| Service manager | systemd (`systemctl`, `--user` units) | launchd (`launchctl`, user agents in `~/Library/LaunchAgents`) |
| Service logs | journal (`journalctl -u …`) | plain files under `nextjs-app/data/logs/` |
| Package manager | `apt` | Homebrew |
| Homebrew prefix | n/a | `/opt/homebrew` on Apple Silicon (**not** `/usr/local`) |
| signal-cli location | `/usr/local/bin/signal-cli` (tarball + symlink) | `/opt/homebrew/bin/signal-cli` (`brew install signal-cli`) |
| signal-cli socket | `/run/user/$UID/signal-cli/socket` | no `/run/user` — use `/tmp/signal-cli-socket` |
| Memory data folder | `~/Documents/ai_Choom_memory` | `~/Library/Application Support/Choom/ai_Choom_memory` (see [TCC](#the-documents-trap-tcc)) |
| Default `python3` | distro Python | whatever Homebrew last linked — **pin it**, see [Python](#python-version-matters) |

The code now handles all of these at runtime, so you do not have to patch
anything by hand. `config.py` finds signal-cli on `$PATH`, `paths.py` derives
the app root from its own location, `memory-server/run.sh` picks a non-TCC data
folder on Darwin, and `/api/server-log` reads a log file instead of the journal.

---

## 1. Prerequisites

```bash
# Core
brew install node pnpm python@3.12 openjdk ffmpeg

# Signal bridge (optional but almost certainly what you want)
brew install signal-cli

# Optional feature dependencies
brew install yt-dlp poppler   # YouTube downloads; PDF text extraction
brew install ngrok            # external webhook access
```

`openjdk` is required by signal-cli. `ffmpeg` is required for voice-note
transcoding in the bridge.

### Python version matters

The Signal bridge depends on `pydub`, which imports the `audioop` module.
**`audioop` was removed from the Python standard library in 3.13.** If you build
the bridge venv with Python 3.13 or newer, every import of `pydub` dies with:

```
ModuleNotFoundError: No module named 'pyaudioop'
```

Homebrew's `python3` may well be 3.14. Build the bridge venv against 3.12
explicitly (the setup below does this). The memory server is fine on 3.11+.

---

## 2. Clone and install

```bash
git clone <your-fork> ~/Projects/Choom
cd ~/Projects/Choom/nextjs-app

pnpm install
cp .env.example .env      # edit — see step 3
pnpm db:push              # create/sync prisma/dev.db
pnpm db:seed              # optional example Choom

npx playwright install chromium   # for scrape_page_content
```

Memory server:

```bash
cd ../memory-server
./setup.sh                # builds venv/, installs chromadb + sentence-transformers
```

Signal bridge — note the explicit 3.12:

```bash
cd ../nextjs-app/services/signal-bridge
/opt/homebrew/bin/python3.12 -m venv --copies venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt
cp .env.example .env       # edit — see step 3
```

> `--copies` is not optional. A symlinked venv puts `bin/python -> /opt/homebrew/...`
> inside the Next.js project tree; Turbopack walks that tree resolving the skill
> registry and `next build` fails with *"Symlink services/*/venv/bin/python is
> invalid, it points out of the filesystem root"*.

---

## 3. Configuration

### `nextjs-app/.env`

Point each endpoint at wherever that service actually runs. A split setup — the
Mac running Choom, an older Linux box still running the GPU services — is a
perfectly good arrangement and the one this repo was migrated into:

```bash
LLM_ENDPOINT=http://localhost:1234/v1       # LM Studio on the Mac
MEMORY_ENDPOINT=http://localhost:8100       # memory server on the Mac
TTS_ENDPOINT=http://192.168.1.23:8004       # still on the Linux box
STT_ENDPOINT=http://192.168.1.23:5000       # still on the Linux box
IMAGE_GEN_ENDPOINT=http://192.168.1.23:7860 # Forge needs CUDA — stays on Linux
```

There is no CUDA on Apple Silicon. Stable Diffusion Forge, faster-whisper and
the Chatterbox TTS stack all assume NVIDIA; leaving them on the Linux host is
much less work than porting them, and Choom does not care that they are remote.

### `nextjs-app/services/signal-bridge/.env`

Two settings have Linux-shaped defaults you must override:

```bash
SIGNAL_CLI_PATH=/opt/homebrew/bin/signal-cli   # not /usr/local/bin
SIGNAL_SOCKET_PATH=/tmp/signal-cli-socket      # no /run/user on macOS
```

Remember the bridge's `TTS_ENDPOINT` / `STT_ENDPOINT` are separate from the
Next.js app's — set both to the Linux box if that is where they run.

---

## 4. Migrating your Signal account

**This is the step that cannot be automated, and the one most likely to block
you.** signal-cli stores a registered account's identity keys and session state
under `~/.local/share/signal-cli`. The Choom's phone number is registered to
*one* device installation at a time — you have to move that state, not
re-create it.

On the Linux box:

```bash
sudo systemctl stop signal-bridge signal-cli-daemon
tar czf signal-cli-state.tgz -C ~ .local/share/signal-cli
```

On the Mac:

```bash
tar xzf signal-cli-state.tgz -C ~
signal-cli listAccounts      # should now list your Choom's number
```

Verify the *Choom's* sending number appears — not just your own. If
`listAccounts` shows only your personal number, the bridge will never send
anything, because `SIGNAL_PHONE_NUMBER` in the bridge `.env` is the number it
sends *from*.

Do not run the daemon on both machines against the same account. Signal will
see the second one as a hijacked session and messages will silently stop.

If you would rather start fresh instead of migrating, register or link a number
on the Mac directly:

```bash
signal-cli link -n "Choom Mac"          # link as a secondary device (QR code)
# or
signal-cli -a +1XXXXXXXXXX register     # dedicated number
```

---

## 5. Migrating your memories

The Ubuntu host keeps the long-term memory store in `~/Documents/ai_Choom_memory`.
On macOS it belongs in `~/Library/Application Support/Choom/ai_Choom_memory`
(see [TCC](#the-documents-trap-tcc)).

On the Linux box:

```bash
systemctl --user stop choom-dev          # stop writes first
tar czf choom-memory.tgz -C ~/Documents ai_Choom_memory
```

On the Mac — **stop the dev agent first**:

```bash
launchctl bootout gui/$(id -u)/com.choom.dev     # memory server holds the DBs open
mkdir -p ~/Library/Application\ Support/Choom
tar xzf choom-memory.tgz -C ~/Library/Application\ Support/Choom
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.choom.dev.plist
```

> **Copy with the server stopped, or you will lose the copy.** The memory
> server keeps `memories.db` and `chroma_db/chroma.sqlite3` open in WAL mode.
> Copying over a *running* server leaves the collection directories intact but
> lets the live server overwrite both SQLite files moments later — the folder
> looks the right size on disk while `/memory/stats` reports
> `total_memories: 0`. The tell is an mtime on those two files matching when
> the server last started rather than when you copied.
>
> If it happens, the store is recoverable: `memory_backups/` inside the same
> folder holds complete dated snapshots (`memories.db` + `chroma.sqlite3` +
> a JSON export). Stop the server, copy both files out of the newest snapshot
> into `memory_db/`, and restart.

Verify the restore before moving on:

```bash
curl -s localhost:8100/memory/stats | python3 -m json.tool
```

Also copy the app database and bridge config, which are not in git:

```bash
# from the Linux box
nextjs-app/prisma/dev.db                         # Chooms, chats, settings
nextjs-app/services/signal-bridge/bridge-config.json
nextjs-app/services/signal-bridge/google_auth/   # OAuth credentials + token
```

An expired `google_auth/token.json` is fine — it refreshes itself on first use
as long as `refresh_token` is present.

---

## 6. Running the services

Install the launchd agents (the counterpart of `install-services.sh`):

```bash
cd ~/Projects/Choom/launchd
./install-launchd.sh                # dev server, Signal services, SearXNG
./install-launchd.sh --dev-only     # just Next.js + memory server
./install-launchd.sh --with-ngrok   # also the ngrok tunnel
./install-launchd.sh --no-searxng   # skip the local SearXNG instance
```

This writes `~/Library/LaunchAgents/com.choom.*.plist` and loads them. They are
**user agents**, so no `sudo` — the dev server, memory server and signal-cli all
need your login user's `HOME`, keychain and Homebrew tree. They start
automatically at login.

The installer skips the Signal agents (with an explanation) if signal-cli has no
account registered for `SIGNAL_PHONE_NUMBER` yet, so it is safe to run before
step 4.

Open <http://localhost:3000>.

### Why run under launchd at all?

The same reason as systemd on Linux: **Settings → Logs → Agent Console reads the
dev server's console output back out of the service's log.** A plain
`pnpm dev` in a terminal works for hacking, but the Agent Console goes stale and
"refresh" appears to do nothing.

On macOS the agent redirects stdout to
`nextjs-app/data/logs/choom-dev.log`, and `scripts/log-filter.js` stamps each
line with an ISO timestamp (`CHOOM_LOG_TIMESTAMPS=1`) because launchd has no
journal to supply one. `/api/server-log` reads that file. Set `CHOOM_DEV_LOG` to
point it somewhere else.

### Command cheat sheet

| Task | Linux (systemd) | macOS (launchd) |
|---|---|---|
| Restart dev server | `systemctl --user restart choom-dev` | `launchctl kickstart -k gui/$(id -u)/com.choom.dev` |
| Is it running? | `systemctl --user status choom-dev` | `launchctl print gui/$(id -u)/com.choom.dev` |
| Tail the console | `journalctl --user -u choom-dev -f` | `tail -f nextjs-app/data/logs/choom-dev.log` |
| Stop it | `systemctl --user stop choom-dev` | `launchctl bootout gui/$(id -u)/com.choom.dev` |
| Restart the bridge | `sudo systemctl restart signal-bridge` | `launchctl kickstart -k gui/$(id -u)/com.choom.signal-bridge` |
| Bridge logs | `journalctl -u signal-bridge -f` | `tail -f nextjs-app/data/logs/signal-bridge.log` |
| Restart SearXNG | `sudo systemctl restart searxng` | `launchctl kickstart -k gui/$(id -u)/com.choom.searxng` |
| Survive logout | `loginctl enable-linger $USER` | user agents already do; see [sleep](#the-mac-goes-to-sleep) |

`services/signal-bridge/servicectl.sh` wraps both, so `pnpm signal:logs`,
`pnpm signal:restart` and `pnpm services:check` work unchanged on either OS:

```bash
./services/signal-bridge/servicectl.sh {start|stop|restart|status|logs|is-active} [service]
```

Health check across everything:

```bash
pnpm services:check
```

---

## Troubleshooting

### The `~/Documents` trap (TCC)

**Symptom:** the memory server logs `Waiting for application startup` and then
hangs forever. Nothing binds port 8100. The process is alive but idle, and
`sample <pid>` shows the main thread blocked in `__open`.

**Cause:** macOS TCC ("Privacy & Security → Files and Folders") gates
`~/Documents`, `~/Desktop` and `~/Downloads`. When a process without permission
opens a path under one of them, macOS blocks the `open()` syscall until the user
answers a consent dialog. A launchd agent has no session to show that dialog in,
so the syscall never returns. It works fine from your terminal because your
terminal already has the grant — which makes this look like "it works when I run
it by hand but not as a service".

**Fix:** already handled — `memory-server/run.sh` defaults to
`~/Library/Application Support/Choom/ai_Choom_memory` on Darwin, which is not
TCC-gated. If you insist on `~/Documents`, grant Full Disk Access to the agent's
binary in System Settings, or set `CHOOM_MEMORY_DATA_DIR` explicitly.

This applies to any Choom feature that writes under those three folders,
including `WORKSPACE_ROOT`. Keep the workspace at `~/choom-projects` (the
default) rather than `~/Documents/choom-projects`.

### `ModuleNotFoundError: No module named 'pyaudioop'`

The bridge venv is on Python 3.13+. See [Python version matters](#python-version-matters).
Rebuild it:

```bash
cd nextjs-app/services/signal-bridge
rm -rf venv && /opt/homebrew/bin/python3.12 -m venv --copies venv
./venv/bin/pip install -r requirements.txt
```

### `ModuleNotFoundError: No module named 'google'`

The Google API packages were historically installed by hand on the original
host and were missing from `requirements.txt`. They are listed now —
`./venv/bin/pip install -r requirements.txt` fixes it.

### Agent Console is empty or says it cannot read the log

The dev server is not running under launchd (or `data/logs/choom-dev.log` does
not exist yet). Run `./launchd/install-launchd.sh --dev-only`, or set
`CHOOM_DEV_LOG` to whatever file you are capturing output to.

### `Bootstrap failed: 5: Input/output error`

launchd's way of saying the agent is already loaded, or its plist is missing or
malformed. Check with `plutil -lint ~/Library/LaunchAgents/com.choom.dev.plist`,
then `launchctl bootout gui/$(id -u)/com.choom.dev` before bootstrapping again.
`launchctl kickstart -k` is the right command for a plain restart.

### signal-cli hangs or fails to open its socket

`/run/user/$UID` does not exist on macOS. Make sure `SIGNAL_SOCKET_PATH` in the
bridge `.env` is a real writable path such as `/tmp/signal-cli-socket`, and that
the same value is baked into `com.choom.signal-cli-daemon.plist` (the installer
reads it from `.env`, so re-run `install-launchd.sh` after changing it).

### The Mac goes to sleep

launchd agents stop when the machine sleeps, so Signal messages and scheduled
heartbeats stop with them. For an always-on Choom, either disable sleep in
System Settings → Lock Screen / Energy, or run `sudo caffeinate -dims` — the
macOS equivalent of the always-on server the Linux box was.

### SearXNG

Run `services/searxng/setup.sh` before `install-launchd.sh`, or the installer
skips SearXNG and tells you so. The setup script picks Python 3.12/3.11 rather
than whatever `python3` is — SearXNG's native wheels (lxml, curl_cffi, msgspec)
lag new CPython releases. Override with `$PYTHON_BIN`.

It binds **127.0.0.1:8888**, so it is reachable only from this Mac — browse it
at <http://localhost:8888>. A remote host cannot reach it, and that is
intentional: it is an unauthenticated search proxy. Checking port 8888 from
*another* machine will always look closed even when it is running perfectly.

Choom uses it as the unlimited fallback behind Brave (`provider` defaults to
`brave`), so set `SEARXNG_ENDPOINT=http://localhost:8888` in `nextjs-app/.env`.

Two failure modes worth knowing:

- **`KeyError: 'engines'` at startup.** Something replaced
  `searxng-src/searx/settings.yml` — SearXNG's packaged defaults — with our
  overlay, leaving `use_default_settings: keep_only:` nothing to merge against.
  Restore the packaged file; the overlay is passed via `$SEARXNG_SETTINGS_PATH`,
  never symlinked over the defaults.
- **`ModuleNotFoundError: No module named 'msgspec'` during install.** SearXNG's
  `setup.py` imports its own package at build time, so `pip install -e` on a
  clean venv cannot even compute requirements. Install `requirements.txt` first,
  then `pip install --no-build-isolation -e`. setup.sh does this.

### Settings look blank after moving a service to another host

Not lost — unresolvable. Dropdowns are populated from whatever the service
currently reports, so a stored value that no longer appears in that list renders
as empty. This has bitten three times during the migration:

- **LLM model** — the Nuc's config named a model this LM Studio does not serve.
- **Image checkpoints** — Forge builds a checkpoint's `title` from its path
  relative to the models directory, so `Flux/flux_dev.safetensors [2eda627c8a]`
  and `flux_dev.safetensors [2eda627c8a]` are the same file in two layouts.
- **Voices** — each TTS server hosts its own set.

Check whether the saved value still exists in the list it is chosen from before
concluding a restore failed. For checkpoints the trailing `[hash]` survives any
folder reshuffle, so remapping is mechanical:

```bash
launchctl bootout gui/$(id -u)/com.choom.dev      # dev.db must not be open
node scripts/remap-checkpoints.mjs --endpoint http://<new-forge-host>:7860
node scripts/remap-checkpoints.mjs --endpoint http://<new-forge-host>:7860 --write
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.choom.dev.plist
```

### Anything referencing `/home/nuc1`

Fixed — `paths.py` now exports `APP_ROOT`, derived from its own location, and
`scheduler.py` uses it for the backup routines. Override with `$CHOOM_APP_ROOT`
if you run the bridge from outside the repo.
