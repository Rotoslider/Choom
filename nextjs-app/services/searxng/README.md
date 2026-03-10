# SearXNG Local Search Engine

Self-hosted SearXNG instance for Choom. Provides free, unlimited web search by aggregating results from multiple public search engines (Google, DuckDuckGo, Brave, Startpage, Wikipedia, and more). Used as a fallback when Brave Search or SerpAPI hit rate limits (429/5xx errors).

## Quick Start

```bash
cd nextjs-app/services/searxng
./setup.sh    # Clone SearXNG, create venv, install deps (~2 min)
./start.sh    # Start on http://localhost:8888
```

## Setup on a New Machine

### Prerequisites
- Python 3.10+ with pip
- Git

### Install
```bash
cd /path/to/Choom/nextjs-app/services/searxng
chmod +x setup.sh start.sh
./setup.sh
```

This will:
1. Clone the SearXNG repo into `searxng-src/`
2. Create a Python venv in `venv/`
3. Install all dependencies
4. The custom `settings.yml` is used via `SEARXNG_SETTINGS_PATH` env var at runtime

### Test
```bash
curl 'http://localhost:8888/search?q=test&format=json' | python3 -m json.tool | head -20
```

### Configure in Choom
1. **Settings > Search > Fallback Providers** — set SearXNG endpoint to `http://localhost:8888`
2. Or set in `.env`: `SEARXNG_ENDPOINT=http://localhost:8888`

## Run as systemd Service (Auto-Start on Boot)

```bash
sudo cp searxng.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now searxng
```

Check status:
```bash
sudo systemctl status searxng
journalctl -u searxng -f
```

## Maintenance

### Update SearXNG
```bash
cd searxng-src
git pull
# If running as systemd service:
sudo systemctl restart searxng
# If running manually:
# Kill the process and run ./start.sh again
```

### Update Dependencies
```bash
source venv/bin/activate
cd searxng-src
pip install -r requirements.txt
```

### View Logs
```bash
# systemd service
journalctl -u searxng --since "1 hour ago"

# Manual start
cat /tmp/searxng.log
```

## Configuration

Edit `settings.yml` to customize. Key settings:

```yaml
search:
  formats:
    - html
    - json    # REQUIRED for Choom API access

server:
  port: 8888
  bind_address: "127.0.0.1"    # localhost only
  limiter: false                # no rate limiting for local use
```

### Enabled Search Engines

The default `settings.yml` uses `use_default_settings: true` which loads all stock engines, then overrides server/search settings. Active engines include:

**General Web**: Google, DuckDuckGo, Brave, Startpage, Bing, Mojeek, Qwant
**Tech**: GitHub, StackOverflow, npm, PyPI, Arch Linux Wiki
**Science**: arXiv, Google Scholar, Semantic Scholar, PubMed
**News**: Google News, Bing News, DuckDuckGo News
**Knowledge**: Wikipedia, Wikidata, Currency Converter
**Media**: YouTube, Google Images, Bing Images
**Shopping**: eBay, Amazon
**Maps**: OpenStreetMap

To enable/disable specific engines or add new ones, edit `settings.yml`. See the full engine list at: https://docs.searxng.org/user/configured_engines.html

### Change Port
Edit `settings.yml` and update `server.port`, then update the endpoint in Choom Settings.

## How It Works in Choom

SearXNG serves as the last-resort fallback in the search cascade:

```
Primary (Brave/SerpAPI) → Secondary fallback → SearXNG (local, unlimited)
```

When the primary search provider returns a 429 (rate limit) or 5xx error, Choom automatically tries the next provider in the chain. Since SearXNG is self-hosted, it never rate-limits you.

The Chooms don't need to know about the fallback — it's handled transparently at the `WebSearchService` layer. The search results format is normalized across all three providers.

## Resource Usage

- **RAM**: ~50-100MB (Python Flask app, no indexing)
- **CPU**: Negligible (just proxies queries to upstream engines)
- **Disk**: ~200MB (venv + source)
- **Network**: Only the search queries themselves — no crawling or indexing

## Troubleshooting

**"Address already in use"**: Another process is on port 8888. Find it with `lsof -i :8888` and kill it, or change the port in `settings.yml`.

**403 from upstream engines**: Some engines may temporarily block requests. SearXNG handles this gracefully — it will use other engines. Check which engines responded in the JSON `engines` field of results.

**No JSON results**: Make sure `settings.yml` has `json` in the `search.formats` list.

**"Invalid settings.yml"**: The settings file must follow SearXNG's schema. Use `use_default_settings: true` and only override specific fields.

## Files

```
services/searxng/
  settings.yml        Custom config (JSON API enabled, localhost only)
  setup.sh            One-time install script
  start.sh            Manual start script
  searxng.service     systemd unit file
  README.md           This file
  venv/               Python virtual environment (gitignored)
  searxng-src/        SearXNG source clone (gitignored)
```
