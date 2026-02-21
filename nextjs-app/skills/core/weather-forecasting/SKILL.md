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

## Important
- Home location: configured in Settings (coordinates pre-configured)
- Small towns may not be recognized — use nearest larger city
- Units: imperial (Fahrenheit)
