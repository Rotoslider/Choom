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
Phone (Signal) → Ngrok → Signal Bridge → Choom API → LLM/STT/TTS/Memory
```

## Setup Instructions

### Step 1: Install Dependencies

```bash
cd services/signal-bridge
chmod +x setup.sh
./setup.sh
```

This installs:
- Java 21 (required by signal-cli)
- signal-cli v0.13.2
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
