# Signal Bridge for Choom

Connect your Chooms to Signal for remote access via your phone.

## Features

- **Two-way messaging** - Text messages in both directions
- **Voice messages** - Send voice notes, get voice responses
- **Image generation** - Request images, receive them in Signal
- **Multiple Chooms** - Address by name
- **Scheduled tasks** - Morning briefings, weather checks, aurora alerts
- **System monitoring** - Health checks and alerts
- **Google Calendar** - Check today, tomorrow, this week, or search events
- **Google Tasks** - View lists, add items, manage tasks
- **Reminders** - Set one-time reminders via natural language
- **Fuzzy search** - Calendar searches are spelling-tolerant

## Architecture

```
Phone (Signal) → signal-cli daemon (JSON-RPC/Unix socket) → Signal Bridge → Choom API → LLM/STT/TTS/Memory
```

### Services

The bridge runs as three systemd services:

| Service | Purpose |
|---------|---------|
| `signal-cli-daemon` | signal-cli in daemon mode, listens on Unix socket at `/run/user/1000/signal-cli/socket` |
| `signal-bridge` | Python bridge — routes messages between signal-cli and the Choom API |
| `ngrok` | HTTPS tunnel for external webhook access |

## Setup Instructions

### Step 1: Install Dependencies

```bash
cd services/signal-bridge
chmod +x setup.sh
./setup.sh
```

This installs:
- Java 25 (required by signal-cli ≥ 0.14.x; older versions used Java 21)
- signal-cli
- Python dependencies
- Creates necessary directories

### Step 2: Link signal-cli to Your Phone

Since you're using your existing phone number, we'll **link** signal-cli as a secondary device:

```bash
signal-cli link -n "Choom Server"
```

This will output a URI like `sgnl://linkdevice?uuid=...`.

**To scan this on your phone:**
1. Open Signal on your phone
2. Go to Settings → Linked Devices
3. Tap "Link New Device"
4. You'll need to convert the URI to a QR code

**Generate QR code:**
```bash
# Install qrencode
sudo apt install qrencode

# Generate and display QR code
signal-cli link -n "Choom Server" | head -1 | qrencode -t ANSIUTF8
```

Scan the QR code with your phone's Signal app.

### Step 3: Verify signal-cli Works

```bash
# Test receiving messages (send yourself a message first)
signal-cli -a +1YOUR_NUMBER receive

# Test sending a message to yourself
signal-cli -a +1YOUR_NUMBER send -m "Test from Choom server" +1YOUR_NUMBER
```

### Step 4: Configure the Bridge

Edit the `.env` file:

```bash
nano .env
```

Key settings:
```
# Choom's phone number (sends messages FROM this number)
SIGNAL_PHONE_NUMBER=+1CHOOM_NUMBER

# Your phone number (receives messages TO this number)
OWNER_PHONE_NUMBER=+1YOUR_NUMBER

DEFAULT_CHOOM_NAME=MyChoom
```

### Step 5: Set Up Google Calendar & Tasks (Optional)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable the **Google Tasks API** and **Google Calendar API**
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
5. Choose "Desktop app" as the application type
6. Download the credentials JSON file
7. Save it as `google_auth/credentials.json`

First run will open a browser for OAuth consent. Token is saved for future use.

### Step 6: Configure Ngrok

1. **Login to ngrok** (if not already):
   ```bash
   ngrok config add-authtoken YOUR_AUTH_TOKEN
   ```

2. **Set up your domain** (you already have one):
   ```bash
   ngrok http 3000 --domain=your-subdomain.ngrok-free.app
   ```

3. **Add webhook verification** (optional but recommended):
   - Go to ngrok dashboard → Your domain → Settings
   - Enable "Webhook Verification"
   - Copy the secret and add to `.env`:
     ```
     NGROK_WEBHOOK_SECRET=your_secret_here
     ```

### Step 7: Start the Services

**Manual start (for testing):**
```bash
# Terminal 1: Start ngrok
ngrok http 3000 --domain=your-subdomain.ngrok-free.app

# Terminal 2: Start the bridge
cd services/signal-bridge
source venv/bin/activate
python bridge.py
```

**As systemd services (for production):**
```bash
chmod +x install-services.sh
./install-services.sh

sudo systemctl start ngrok
sudo systemctl start signal-bridge
```

## Usage

### Talking to Chooms

Address a Choom by name:
```
MyChoom: What's the weather like?
AnotherChoom, tell me a joke
@MyChoom search for SpaceX news
```

Or just send a message (goes to default Choom):
```
What's the weather like?
```

### Voice Messages

Send a voice note from Signal - it will be transcribed and sent to your Choom. The response will include both text and an audio file you can play.

### Image Generation

```
MyChoom: Generate a picture of a sunset over the desert
```

The image will be sent as an attachment in Signal.

### Reminders

Set reminders using natural language:
```
remind me in 30 minutes to check the oven
remind me to call mom in 2 hours
remind me at 3pm to pick up groceries
```

Both word orders work, and word numbers (one, two, five) are understood.

### Google Calendar

Check your calendar:
```
what's on my calendar today
what's on the calendar tomorrow
calendar this week
when is Aaron's birthday
```

Calendar searches are fuzzy - slight misspellings still work, and birthday searches look a full year ahead.

### Google Tasks

Manage your task lists:
```
my lists                    # Show all task lists
show groceries              # Show items in a list
add milk to groceries       # Add an item
add to groceries: bread     # Alternative syntax
```

### Scheduled Tasks

The following tasks run automatically:

| Task | Time | Description |
|------|------|-------------|
| Morning Briefing | 7:00 AM | Weather, system status, reminders |
| Weather Check | 7:00, 12:00, 18:00 | Current conditions |
| Aurora Forecast | 12:00, 18:00 | Aurora visibility check |
| System Health | Every 30 min | Service status (alerts on issues) |

## Security

### Your Setup

- Only 2 Signal contacts, no spam history
- Single user (you)
- Personal phone number

### Recommendations

1. **Webhook Verification** (enabled by default)
   - Ngrok signs all webhook requests
   - Bridge verifies signatures before processing
   - Prevents unauthorized requests

2. **Owner Phone Check**
   - Bridge only responds to messages from your number
   - Other numbers are logged and ignored

3. **No External Exposure**
   - Services run locally (STT, TTS, Memory, LLM)
   - Only the Next.js API is exposed via ngrok
   - ngrok URL is not publicly advertised

### Optional Additional Security

If you want extra protection:

1. **IP Allowlist** (ngrok paid feature)
2. **Rate Limiting** - Add to bridge if needed
3. **Message Logging** - All messages are logged for audit

## Updating signal-cli

Keeping signal-cli current matters: Signal occasionally makes **server-side
protocol changes** that older clients can't handle. In June 2026, for example,
the server stopped sending the legacy `serverGuid` field on sealed-sender
envelopes, and signal-cli 0.14.1 threw `getServerGuid(...) must not be null`
on **every** incoming message — silently dropping all of them (outbound still
worked, so nothing looked broken). Upgrading to 0.14.5 fixed it. See
[Troubleshooting](#inbound-messages-silently-stop-getserverguid--protocol-drift)
below.

### Automatic update check (notify-only)

The bridge checks GitHub once a day (09:00 local, via the scheduler task
`signal_cli_update_check`) and compares the installed version against the
latest release. **It never upgrades on its own** — when a newer version
exists it just sends you a Signal message like:

```
[System]

signal-cli 0.14.6 is available (you have 0.14.5).

Not auto-applied — review first:
• Release notes: https://github.com/AsamK/signal-cli/releases/tag/v0.14.6
• Issues: https://github.com/AsamK/signal-cli/issues

When ready, on the NUC run:
  sudo .../services/signal-bridge/upgrade-signal-cli.sh 0.14.6

It backs up the current install and auto-rolls-back if the daemon fails to
come up. The old version stays in /opt for instant rollback.
```

This is deliberate — you read the release notes and issues page first (in case
of new bugs/regressions), then apply on your own schedule.

- **Notify once per version**: state is kept in `signal_cli_update_state.json`
  so you aren't pinged daily for the same release.
- **Disable it**: set the `signal_cli_update_check` task to disabled in the task
  config (it defaults to enabled).
- Activating after a code change requires a bridge restart
  (`sudo systemctl restart signal-bridge`) so the new scheduler code loads.

### Recommended: `upgrade-signal-cli.sh`

The one-command apply step. It does the whole manual procedure below
automatically, with verification and **automatic rollback**:

```bash
# Upgrade to a specific version (what the notification suggests)
sudo ./upgrade-signal-cli.sh 0.14.6

# Or omit the version to take the latest GitHub release
sudo ./upgrade-signal-cli.sh
```

What it does:
1. Resolves the target version (arg, or latest from GitHub) and the currently
   installed version (from the systemd `ExecStart` path). Exits early if already
   current.
2. Downloads the JVM distribution tarball and extracts it to `/opt`
   (skips the download if that version dir already exists).
3. Backs up the service file, repoints `ExecStart` to the new version,
   `daemon-reload`, and restarts `signal-cli-daemon`.
4. Verifies the daemon came up (`is-active` + `Started JSON-RPC server` in the
   journal). **If it doesn't, it restores the backed-up service file and
   restarts the old version** — so a bad upgrade self-heals.

The bridge auto-reconnects to the restarted daemon within a few seconds. After
it reports success, send a test message and watch
`journalctl -u signal-cli-daemon -f`.

> Note: the script does **not** back up your account data (it's a binary-only
> swap that leaves `~/.local/share/signal-cli` untouched). For a major version
> bump where you want extra safety, take the account backup from the manual
> procedure first.

### Manual procedure (step-by-step)

The script above is preferred, but here's the equivalent by hand:

```bash
# 1. Back up account data (do this FIRST)
cp -r ~/.local/share/signal-cli ~/.local/share/signal-cli.bak

# 2. Stop services
systemctl stop signal-bridge signal-cli-daemon

# 3. Download and install latest version
VERSION=$(curl -Ls -o /dev/null -w %{url_effective} https://github.com/AsamK/signal-cli/releases/latest | sed -e 's/^.*\/v//')
echo "Installing signal-cli v${VERSION}"
curl -L -O https://github.com/AsamK/signal-cli/releases/download/v"${VERSION}"/signal-cli-"${VERSION}".tar.gz
sudo tar xf signal-cli-"${VERSION}".tar.gz -C /opt
sudo ln -sf /opt/signal-cli-"${VERSION}"/bin/signal-cli /usr/local/bin/

# 4. Update the systemd service to point to the new version
# Replace the old version path with the new one
sudo sed -i "s|/opt/signal-cli-[0-9.]*/|/opt/signal-cli-${VERSION}/|g" /etc/systemd/system/signal-cli-daemon.service
sudo systemctl daemon-reload

# 5. Start daemon and verify logs
systemctl start signal-cli-daemon
journalctl -u signal-cli-daemon -f
# Watch for errors — Ctrl-C when it looks stable

# 6. Start the bridge
systemctl start signal-bridge

# 7. Clean up
rm signal-cli-"${VERSION}".tar.gz
```

### Java Version Gotcha

signal-cli is a Java application. Major version bumps may require a newer Java runtime:

| signal-cli | Required Java |
|------------|---------------|
| 0.13.x | Java 21 (`openjdk-21-jre-headless`) |
| 0.14.x | Java 25 (`openjdk-25-jre-headless`) |

If you see this error after upgrading:
```
UnsupportedClassVersionError: org/asamk/signal/Main has been compiled by a more recent version of the Java Runtime
```

Install the required Java version:
```bash
sudo apt install openjdk-25-jre-headless
```

### Rollback

If the new version breaks something:
```bash
systemctl stop signal-bridge signal-cli-daemon

# Restore the old version path in the service file (e.g. back to 0.13.24)
sudo sed -i 's|/opt/signal-cli-NEW_VERSION/|/opt/signal-cli-OLD_VERSION/|g' /etc/systemd/system/signal-cli-daemon.service
sudo systemctl daemon-reload

# Restore account data if needed
cp -r ~/.local/share/signal-cli.bak ~/.local/share/signal-cli

systemctl start signal-cli-daemon signal-bridge
```

The old install remains untouched at `/opt/signal-cli-OLD_VERSION/` — rollback is just changing one path.

### Profile Name

signal-cli 0.14+ warns if no profile name is set. Set one via the daemon socket (no restart needed):

```bash
signal-cli --output=json jsonRpc <<< '{"jsonrpc":"2.0","id":1,"method":"updateProfile","params":{"givenName":"Choom"}}'
```

Or stop the daemon and set it directly:
```bash
systemctl stop signal-cli-daemon
signal-cli -a +1YOUR_NUMBER updateProfile --given-name "Choom"
systemctl start signal-cli-daemon
```

## Account Keepalive

Signal marks accounts as inactive after ~30 days without server-side activity, showing an "Open Signal on your phone or your account will be deleted" warning.

### How It Works

The bridge runs an automatic keepalive task every 6 hours that calls `updateAccount` via the daemon's JSON-RPC socket. This refreshes pre-keys and account attributes on Signal's servers, resetting the inactivity timer.

**Important:** The correct JSON-RPC method is `updateAccount`, NOT `sendSyncRequest`. `sendSyncRequest` is a device-to-device sync message that does not register as account activity with Signal's servers. Only `updateAccount` (or actually sending/receiving messages) resets the inactivity timer.

### Verify Keepalive Is Running

Check the bridge logs for keepalive activity:
```bash
journalctl -u signal-bridge | grep -i keepalive
```

You should see entries like:
```
Signal account keepalive OK — inactivity timer reset
```

### Manual Keepalive

If you need to trigger it immediately:
```bash
signal-cli --output=json jsonRpc <<< '{"jsonrpc":"2.0","id":1,"method":"updateAccount"}'
```

Or via raw socket (when another client is connected):
```python
import socket, json
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect('/run/user/1000/signal-cli/socket')
sock.settimeout(15)
sock.sendall((json.dumps({"jsonrpc":"2.0","id":1,"method":"updateAccount"}) + "\n").encode())
print(sock.makefile('r').readline())
sock.close()
```

### Reference

- [signal-cli issue #1728](https://github.com/AsamK/signal-cli/issues/1728) — original discussion of the inactivity warning
- Signal expires accounts after ~30 days idle, warns at ~7-day intervals
- Daemon mode maintains a WebSocket to Signal servers but this alone may not prevent the warning

## Troubleshooting

### signal-cli Issues

```bash
# Check if linked
signal-cli -a +1YOUR_NUMBER listAccounts

# Check for pending messages
signal-cli -a +1YOUR_NUMBER receive -t 5

# Re-link if needed
signal-cli link -n "Choom Server"
```

### Inbound messages silently stop (`getServerGuid` / protocol drift)

**Symptom:** Messages you send show as delivered on your phone, but nothing
reaches the Chooms — and `data/logs/bridge.log` shows **no errors** (it's all
scheduler noise). Outbound (heartbeats, scheduled messages) keeps working.

**Why it's sneaky:** Sends and receives use different code paths, so the bridge
looks alive. And signal-cli's own decode errors go to the **systemd journal,
not bridge.log**. The receive path is the `signal-cli-daemon` / `signal-bridge`
**system services** — restarting Next.js (`pnpm dev`) or your phone does nothing
for it.

**Diagnose** — look in the daemon journal, not bridge.log:
```bash
journalctl -u signal-cli-daemon -n 50 --no-pager | grep -E "Envelope|Exception|getServerGuid"
```
If you see incoming envelopes paired with `Exception: getServerGuid(...) must
not be null (NullPointerException)`, signal-cli is receiving messages but
crashing while decoding them (a Signal server-side protocol change your version
can't handle). Confirm zero are getting through:
```bash
# Inbound that actually reached the bridge (should be > 0 when healthy):
grep -c "Received message from" data/logs/bridge.log
```

**Fix:** upgrade signal-cli (see [Updating signal-cli](#updating-signal-cli)).
The daily update check exists precisely to surface the fixed release quickly.

### Bridge Not Responding

```bash
# Check service status
sudo systemctl status signal-bridge

# View logs
journalctl -u signal-bridge -f

# Check Choom API is running
curl http://localhost:3000/api/health
```

### Ngrok Issues

```bash
# Check tunnel status
curl http://127.0.0.1:4040/api/tunnels

# View ngrok logs
journalctl -u ngrok -f
```

## Files

```
signal-bridge/
├── bridge.py           # Main service
├── signal_handler.py   # Signal CLI wrapper
├── choom_client.py     # Choom API client
├── scheduler.py        # Scheduled tasks
├── google_client.py    # Google Tasks/Calendar API client
├── config.py           # Configuration
├── requirements.txt    # Python dependencies
├── setup.sh           # Initial setup script
├── .env               # Environment config
├── google_auth/        # Google OAuth credentials
│   ├── credentials.json
│   └── token.json
├── systemd/
│   ├── signal-cli-daemon.service
│   ├── signal-bridge.service
│   └── ngrok.service
└── install-services.sh
```

## Extending

### Add New Scheduled Tasks

Edit `scheduler.py` and add to `_setup_default_tasks()`:

```python
self.add_cron_task(
    "my_task",
    self._my_task_function,
    hour=14,
    minute=30
)
```

### Add New Chooms

Just create them in the Choom web UI - the bridge will auto-discover them.

### Future Integrations

- Camera monitoring (Reolink)
- Home automation
- Custom webhooks
