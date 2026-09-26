import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import { WeatherService, looksLikePwsStationId, WUNDERGROUND_API_KEY } from '@/lib/weather-service';
import { resolveNamedPlace, loadPlaces } from '@/lib/weather-places';
import { fetchStationRoundup, formatRoundupForPrompt } from '@/lib/pws-roundup';
import type { WeatherSettings, ToolCall, ToolResult } from '@/lib/types';

const vaguePatterns = /^(here|home|rodeo|rodeo,?\s*nm|my (location|area|place|city)|nearby|near me|close by|local|current|this area|around here)$/i;

function resolveLocation(rawLocation: string | undefined): string | undefined {
  return rawLocation?.trim() && !vaguePatterns.test(rawLocation.trim())
    ? rawLocation.trim()
    : undefined;
}

function hasDefaultLocation(settings: WeatherSettings | undefined): boolean {
  return Boolean(settings && ((settings.latitude && settings.longitude) || settings.location));
}

// A named place ("camp"), a bare Weather Underground station id, or — when no
// location / "here" / "home" was given — the "home" named place if one exists
// (the user's own station). null → plain OpenWeather by city/default.
async function resolvePlace(rawLocation: string | undefined, service: WeatherService) {
  const named = resolveNamedPlace(rawLocation);
  if (named) return named;
  if (looksLikePwsStationId(rawLocation)) {
    const station = await service.lookupStation(rawLocation!);
    if (station) return station;
    throw new Error(WUNDERGROUND_API_KEY
      ? `Weather Underground station "${rawLocation!.trim()}" not found or not reporting right now. Check the id, or ask for a town name instead.`
      : 'Weather Underground station ids need WUNDERGROUND_API_KEY, which is not set. Ask for a town name instead.');
  }
  if (!resolveLocation(rawLocation)) return resolveNamedPlace('home');
  return null;
}

const TOOL_NAMES = new Set(['get_weather', 'get_weather_forecast']);

export default class WeatherForecastingHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'get_weather':
        return this.handleGetWeather(toolCall, ctx);
      case 'get_weather_forecast':
        return this.handleGetWeatherForecast(toolCall, ctx);
      default:
        return this.error(toolCall, `Unknown weather tool: ${toolCall.name}`);
    }
  }

  // stations="local" → the user's watch list; otherwise comma-separated ids.
  private async handleStationRoundup(toolCall: ToolCall, stationsArg: string): Promise<ToolResult> {
    const wantLocal = /^\s*(local|watch(ed)?|my stations|watch ?list|area|valley|nearby)\s*$/i.test(stationsArg);
    const places = loadPlaces();
    const ids = wantLocal
      ? places.filter(p => p.watch && p.pwsStationId).map(p => p.pwsStationId!)
      : stationsArg.split(/[\s,;]+/).filter(Boolean);
    if (ids.length === 0) {
      return this.error(toolCall, wantLocal
        ? 'No local stations are on the watch list yet — the user adds them in Settings → Weather → Weather Stations. Pass station ids instead, e.g. stations="KNMRODEO32".'
        : 'stations needs "local" or one or more Weather Underground station ids (e.g. "KNMRODEO32, KAZSANSI41").');
    }
    const rows = await fetchStationRoundup(ids.slice(0, 15), places);
    const title = wantLocal ? 'Local stations around home' : `Stations ${ids.slice(0, 15).join(', ')}`;
    return this.success(toolCall, { success: true, stations: rows, formatted: formatRoundupForPrompt(rows, title) });
  }

  private async handleGetWeather(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const stationsArg = toolCall.arguments.stations;
    if (typeof stationsArg === 'string' && stationsArg.trim()) return this.handleStationRoundup(toolCall, stationsArg);
    if (Array.isArray(stationsArg) && stationsArg.length) return this.handleStationRoundup(toolCall, stationsArg.join(','));
    try {
      const rawLocation = toolCall.arguments.location as string | undefined;
      const weatherService = new WeatherService(ctx.weatherSettings);
      const place = await resolvePlace(rawLocation, weatherService);
      if (place) {
        const weather = await weatherService.getWeatherAt(place);
        return this.success(toolCall, {
          success: true,
          weather,
          formatted: weatherService.formatStationForPrompt(weather),
          place: { name: place.name, lat: place.lat, lon: place.lon, elevation_ft: place.elevationFt, station: place.pwsStationId },
          ...(place.note && { note: place.note }),
        });
      }
      const location = resolveLocation(rawLocation);
      let weather;
      let note: string | undefined;
      try {
        weather = await weatherService.getWeather(location);
      } catch (e) {
        // "Chiricahua Mountains, AZ" is home, but OpenWeather has no such
        // place (404, doctor 2026-09-19). When the user asked about HERE in
        // words the geocoder can't parse, the configured default is the
        // right answer — return it and say so instead of failing the turn.
        if (!location || !hasDefaultLocation(ctx.weatherSettings) || !/\b404\b/.test(e instanceof Error ? e.message : String(e))) throw e;
        weather = await weatherService.getWeather(undefined);
        note = `"${location}" is not a place OpenWeather recognizes, so this is the weather for the configured home location instead. If you meant somewhere else, pass "City,ST,US" or latitude/longitude.`;
      }
      const formatted = weatherService.formatWeatherForPrompt(weather);

      return this.success(toolCall, { success: true, weather, formatted, ...(note && { note }) });
    } catch (weatherError) {
      return this.error(toolCall, `Weather fetch failed: ${weatherError instanceof Error ? weatherError.message : 'Unknown error'}`);
    }
  }

  private async handleGetWeatherForecast(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const rawLocation = toolCall.arguments.location as string | undefined;
      const days = Math.min(5, Math.max(1, (toolCall.arguments.days as number) || 5));
      const weatherService = new WeatherService(ctx.weatherSettings);
      const place = await resolvePlace(rawLocation, weatherService);
      if (place) {
        const forecast = await weatherService.getForecastAt(place, days);
        return this.success(toolCall, {
          success: true,
          forecast,
          formatted: weatherService.formatOutlookForPrompt(forecast),
          place: { name: place.name, lat: place.lat, lon: place.lon, elevation_ft: place.elevationFt },
          ...(place.note && { note: place.note }),
        });
      }
      const location = resolveLocation(rawLocation);
      const forecast = await weatherService.getForecast(location, days);
      const formatted = weatherService.formatForecastForPrompt(forecast);

      return this.success(toolCall, { success: true, forecast, formatted });
    } catch (forecastError) {
      return this.error(toolCall, `Forecast fetch failed: ${forecastError instanceof Error ? forecastError.message : 'Unknown error'}`);
    }
  }
}
