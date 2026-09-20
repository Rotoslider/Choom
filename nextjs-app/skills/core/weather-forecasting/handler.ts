import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import { WeatherService } from '@/lib/weather-service';
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

  private async handleGetWeather(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const rawLocation = toolCall.arguments.location as string | undefined;
      const location = resolveLocation(rawLocation);
      const weatherService = new WeatherService(ctx.weatherSettings);
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
      const location = resolveLocation(rawLocation);
      const days = Math.min(5, Math.max(1, (toolCall.arguments.days as number) || 5));
      const weatherService = new WeatherService(ctx.weatherSettings);
      const forecast = await weatherService.getForecast(location, days);
      const formatted = weatherService.formatForecastForPrompt(forecast);

      return this.success(toolCall, { success: true, forecast, formatted });
    } catch (forecastError) {
      return this.error(toolCall, `Forecast fetch failed: ${forecastError instanceof Error ? forecastError.message : 'Unknown error'}`);
    }
  }
}
