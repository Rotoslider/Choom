---
name: weather-forecasting
description: Gets current weather conditions and 5-day forecasts. Use when asking about temperature, rain, wind, humidity, or future weather.
version: 1.0.0
author: system
tools:
  - get_weather
  - get_weather_forecast
dependencies: []
---

# Weather Forecasting

## When to Use
- Current weather → `get_weather` (no location param for home area)
- Future weather ("tomorrow", "this week") → `get_weather_forecast`
- Different city → pass location param (e.g., "Denver, CO")
- Vague/local references ("here", "near me") → call with NO location param

## Named places (exact coordinates, not a geocoder guess)
- **Camp / Chiricahua Mountains / Rustler Park** → `get_weather(location="camp")` or `get_weather_forecast(location="Chiricahua Mountains")`. Resolves to Rustler Park at ~8,900 ft — 4,000 ft above home and often 20°F cooler. Live readings come from the Rustler Park station when it is configured.
- Never answer a camp/mountain question with Portal, AZ or Rodeo, NM weather — they are at the bottom of the mountain.
- **Home** (no location, "home", "the house", "Rodeo") → the user's own station, KNMRODEO33.
- Places and stations are edited in Settings → Weather → Weather Stations (stored in `data/weather-places.json`).

## Around the area — `get_weather(stations="local")`
- "Did it rain last night?", "who got rain?", "how windy is it around the valley?" → `stations="local"`: the user's watched stations with rain over the last 24h / today / 7 days, current wind + today's peak gust, distance and direction from home.
- A specific station the user names, e.g. one near a campsite for the length of a trip → `get_weather(stations="KAZSANSI34")` (comma-separate several). It does not need to be on the list. To keep an eye on it, schedule a follow-up that calls this again.
- Weather Underground area names are post-office towns ("San Simon" runs from the valley floor to the 9,000 ft crest) — judge a station by its elevation and distance, not its name.

## Important
- Home location: configured in Settings (coordinates pre-configured)
- Small towns may not be recognized — use nearest larger city
- Units: imperial (Fahrenheit)
