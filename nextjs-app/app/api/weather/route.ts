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

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;

    // Build settings from query params or use defaults
    const latParam = searchParams.get('latitude');
    const lonParam = searchParams.get('longitude');
    const useCoords = searchParams.get('useCoordinates') === 'true';

    const settings: WeatherSettings = {
      apiKey: searchParams.get('apiKey') || defaultWeatherSettings.apiKey,
      provider: (searchParams.get('provider') as 'openweathermap' | 'weatherapi') || defaultWeatherSettings.provider,
      location: searchParams.get('location') || defaultWeatherSettings.location,
      latitude: latParam ? parseFloat(latParam) : defaultWeatherSettings.latitude,
      longitude: lonParam ? parseFloat(lonParam) : defaultWeatherSettings.longitude,
      useCoordinates: useCoords || defaultWeatherSettings.useCoordinates,
      units: (searchParams.get('units') as 'metric' | 'imperial') || defaultWeatherSettings.units,
      cacheMinutes: parseInt(searchParams.get('cacheMinutes') || '30') || defaultWeatherSettings.cacheMinutes,
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

    return NextResponse.json({
      success: true,
      weather,
      formatted,
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
