# Google OAuth Setup Guide

Complete guide for setting up Google OAuth2 for Choom's Google integrations (Calendar, Tasks, Sheets, Docs, Drive, Gmail, Contacts, YouTube).

## Prerequisites

- A Google account
- A GitHub repository with GitHub Pages enabled (for OAuth consent screen branding)

## Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click the project dropdown (top-left) > **New Project**
3. Name it (e.g. "Choom") and click **Create**
4. Select the new project from the dropdown

## Step 2: Enable APIs

Go to **APIs & Services** > **Library** and enable each of these:

- Google Calendar API
- Google Tasks API
- Google Sheets API
- Google Docs API
- Google Drive API
- Gmail API
- People API (for Contacts)
- YouTube Data API v3

## Step 3: Configure OAuth Consent Screen

Go to **APIs & Services** > **OAuth consent screen**:

1. **User Type**: Select **External** (only option without Google Workspace)
2. **App name**: `Choom`
3. **User support email**: Your email
4. **App logo**: Upload any 120x120px PNG (a colored square with a letter works)
5. **App domain**:
   - **Application home page**: `https://YOUR-GITHUB-USERNAME.github.io/Choom/`
   - **Privacy policy URL**: `https://YOUR-GITHUB-USERNAME.github.io/Choom/privacy.html`
6. **Authorized domains**: `YOUR-GITHUB-USERNAME.github.io`
7. **Developer contact email**: Your email
8. Click **Save and Continue**

### GitHub Pages Setup (required for consent screen)

Your GitHub repo needs a Pages site for the homepage/privacy URLs:

1. In your Choom GitHub repo, create `docs/index.html`:
   ```html
   <!DOCTYPE html>
   <html><head><title>Choom</title></head>
   <body><h1>Choom</h1><p>A self-hosted AI companion framework.</p>
   <p><a href="https://github.com/YOUR-USERNAME/Choom">GitHub</a></p>
   <p><a href="https://YOUR-USERNAME.github.io/Choom/privacy.html">Privacy Policy</a></p></body></html>
   ```

2. Create `docs/privacy.html`:
   ```html
   <!DOCTYPE html>
   <html><head><title>Choom - Privacy Policy</title></head>
   <body><h1>Privacy Policy</h1><p>Choom is a self-hosted application. All data stays on your local machine. No data is collected, shared, or transmitted to third parties.</p></body></html>
   ```

3. Go to GitHub repo **Settings** > **Pages**
4. Under **Build and deployment**, set Source to **Deploy from a branch**
5. Select branch `main`, folder `/docs`, click **Save**
6. Wait a minute, then verify `https://YOUR-USERNAME.github.io/Choom/` loads in a browser

### Domain Verification (required for consent screen)

Google requires you to prove you own the homepage domain:

1. Go to [Google Search Console](https://search.google.com/search-console)
2. Click **Add property**
3. Choose **URL prefix**, enter `https://YOUR-USERNAME.github.io/Choom/`
4. Select **HTML file** verification method
5. Download the `googleXXXXXXXXXXXX.html` file
6. Upload it to your `docs/` folder in the repo (via GitHub web UI or local git push)
7. Wait for GitHub Pages to deploy (~1 minute)
8. Go back to Search Console and click **Verify**
9. Should say "Ownership verified"

### Scopes

On the **Scopes** step of the consent screen, click **Add or Remove Scopes** and add:

| Scope | Purpose |
|-------|---------|
| `google.com/auth/calendar` | Calendar read/write |
| `google.com/auth/calendar.events.readonly` | Calendar event reading |
| `google.com/auth/tasks` | Tasks read/write |
| `google.com/auth/tasks.readonly` | Tasks reading |
| `google.com/auth/spreadsheets` | Sheets read/write |
| `google.com/auth/documents` | Docs read/write |
| `google.com/auth/drive` | Drive read/write |
| `google.com/auth/gmail.modify` | Gmail read/send/draft |
| `google.com/auth/contacts.readonly` | Contacts reading |
| `google.com/auth/youtube.readonly` | YouTube reading |

Click **Save and Continue**.

### Test Users

Add your Google email as a test user. Click **Save and Continue**.

## Step 4: Publish the App

**Important**: Apps in "Testing" mode expire refresh tokens after 7 days. You must publish to production.

1. Go to **APIs & Services** > **OAuth consent screen**
2. Find **Publishing status: Testing**
3. Click **Publish App** and confirm
4. Status should change to **In production**

> You do NOT need to submit for Google verification. The "app requires verification" message is informational — it just means users will see an "unverified app" warning during authorization. Since you're the only user, this doesn't matter.

## Step 5: Create OAuth Credentials

1. Go to **APIs & Services** > **Credentials**
2. Click **Create Credentials** > **OAuth client ID**
3. Application type: **Desktop app**
4. Name: `Choom` (or anything)
5. Click **Create**
6. Click **Download JSON**
7. Save as `services/signal-bridge/google_auth/credentials.json`

Make sure **Authorized redirect URIs** only contains `http://localhost` (should be default for Desktop apps).

## Step 6: Authorize

```bash
cd services/signal-bridge
python3 -c "from google_client import GoogleClient; GoogleClient()"
```

A browser window opens. Sign in with your Google account.

You'll see **"Google hasn't verified this app"** — click:
1. **Advanced**
2. **Go to Choom (unsafe)**
3. Check all the permission boxes
4. Click **Continue**

Token is saved at `services/signal-bridge/google_auth/token.json`.

## Step 7: Restart Signal Bridge

```bash
sudo systemctl restart signal-bridge.service
```

## Re-Authorization

If the token ever stops working (rare after publishing to production):

```bash
rm services/signal-bridge/google_auth/token.json
cd services/signal-bridge
python3 -c "from google_client import GoogleClient; GoogleClient()"
sudo systemctl restart signal-bridge.service
```

## Security Notes

- `credentials.json` and `token.json` are local files — never commit them to git
- The OAuth app is "External" but not discoverable — no one can find it
- To authorize, someone would need your `client_id`, `client_secret`, AND physical access (localhost redirect)
- OAuth only grants access to the authorizing user's own Google account
- The "unverified app" warning is cosmetic — it doesn't affect security or functionality

## File Locations

| File | Path | Purpose |
|------|------|---------|
| Credentials | `services/signal-bridge/google_auth/credentials.json` | OAuth client ID + secret |
| Token | `services/signal-bridge/google_auth/token.json` | Access + refresh token (auto-refreshes) |
| Google client | `services/signal-bridge/google_client.py` | Python API client |

## Troubleshooting

**"Token has been expired or revoked"**
- Delete `token.json` and re-authorize (see Re-Authorization above)
- If this happens repeatedly (every 7 days), your app is still in "Testing" mode — publish it to production (Step 4)

**"invalid_grant" on re-auth**
- Clear browser cookies for accounts.google.com, then try again
- Or use an incognito window for the authorization flow

**Scopes changed / new API added**
- Delete `token.json` and re-authorize to pick up new scopes
- The authorization screen will show the updated permission list

**"Access Not Configured" or "API not enabled"**
- Go back to Step 2 and enable the missing API in Google Cloud Console
