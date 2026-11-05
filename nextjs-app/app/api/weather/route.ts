import { NextRequest, NextResponse } from 'next/server';
import { WeatherService, clearWeatherCache } from '@/lib/weather-service';
import type { WeatherSettings } from '@/lib/types';

// Default weather settings
const defaultWeatherSettings: WeatherSettings = {
  apiKey: process.env.OPENWEATHER_API_KEY || '',
  provider: 'openweathermap',
  location: process.env.DEFAULT_WEATHER_LOCATION || '',
  latitude: parseFloat(process.env.DEFAULT_WEATHER_LAT || '0'),
  longitude: parseFloat(process.env.DEFAULT_WEATHER_LON || '0'),
  useCoordinates: true,
  units: 'imperial',
  cacheMinutes: 30,
};

// GET /api/weather?location=…&forecast=true (the bridge, the Chooms' tools).
// It reads no key from the URL: next dev writes every request URL to
// data/logs/choom-dev.log, so the settings Test button POSTs (action 'test').
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  return weatherReply((name) => searchParams.get(name), null);
}

async function weatherReply(param: (name: string) => string | null, apiKey: string | null) {
  try {
    // Build settings from the request or use defaults
    const latParam = param('latitude');
    const lonParam = param('longitude');
    const useCoords = param('useCoordinates') === 'true';

    const settings: WeatherSettings = {
      apiKey: apiKey || defaultWeatherSettings.apiKey,
      provider: (param('provider') as 'openweathermap' | 'weatherapi') || defaultWeatherSettings.provider,
      location: param('location') || defaultWeatherSettings.location,
      latitude: latParam ? parseFloat(latParam) : defaultWeatherSettings.latitude,
      longitude: lonParam ? parseFloat(lonParam) : defaultWeatherSettings.longitude,
      useCoordinates: useCoords || defaultWeatherSettings.useCoordinates,
      units: (param('units') as 'metric' | 'imperial') || defaultWeatherSettings.units,
      cacheMinutes: parseInt(param('cacheMinutes') || '30') || defaultWeatherSettings.cacheMinutes,
    };

    if (!settings.apiKey) {
      return NextResponse.json(
        { error: 'Weather API key not configured' },
        { status: 400 }
      );
    }

    const weatherService = new WeatherService(settings);
    // Don't pass location string — let getWeather() use coordinates when configured
    const weather = await weatherService.getWeather();
    const formatted = weatherService.formatWeatherForPrompt(weather);

    // Optional forecast (?forecast=true&days=N) — used by the morning briefing so
    // the spoken update has today's high/low, not just current conditions. A
    // forecast failure must NOT drop the current weather, so it's caught separately.
    let forecast: Awaited<ReturnType<WeatherService['getForecast']>> | undefined;
    let forecastFormatted: string | undefined;
    if (param('forecast') === 'true') {
      const days = parseInt(param('days') || '2') || 2;
      try {
        forecast = await weatherService.getForecast(undefined, days);
        forecastFormatted = weatherService.formatForecastForPrompt(forecast);
      } catch (e) {
        console.error('Forecast fetch failed (current weather still returned):', e);
      }
    }

    return NextResponse.json({
      success: true,
      weather,
      formatted,
      ...(forecast ? { forecast, forecastFormatted } : {}),
    });
  } catch (error) {
    console.error('Weather API error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch weather' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (body.action === 'clear_cache') {
      clearWeatherCache();
      return NextResponse.json({ success: true, message: 'Weather cache cleared' });
    }

    if (body.action === 'test') {
      // Settings → Weather "Test": the key comes in the body, not the URL.
      const { apiKey, ...rest } = body as Record<string, unknown>;
      return weatherReply(
        (name) => (rest[name] == null ? null : String(rest[name])),
        typeof apiKey === 'string' && apiKey ? apiKey : null,
      );
    }

    return NextResponse.json(
      { error: 'Invalid action' },
      { status: 400 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
