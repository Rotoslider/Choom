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
- More places can be added in `data/weather-places.json` (name, aliases, lat, lon, optional station).

## Important
- Home location: configured in Settings (coordinates pre-configured)
- Small towns may not be recognized — use nearest larger city
- Units: imperial (Fahrenheit)
