import type { WeatherSettings, WeatherData, ForecastEntry, ForecastData } from './types';

// Cache for weather data
const weatherCache: Map<string, { data: WeatherData; expiresAt: number }> = new Map();

// Cache for forecast data
const forecastCache: Map<string, { data: ForecastData; expiresAt: number }> = new Map();

export class WeatherService {
  private settings: WeatherSettings;

  constructor(settings: WeatherSettings) {
    this.settings = settings;
  }

  async getWeather(location?: string): Promise<WeatherData> {
    const loc = location || this.settings.location;

    // Allow coordinate-based lookup without a location string
    const hasCoordinates = this.settings.useCoordinates && this.settings.latitude && this.settings.longitude;
    if (!loc && !hasCoordinates) {
      throw new Error('No location specified');
    }

    // Check cache - use explicit location if passed, coordinates if configured, else default location
    const cacheKey = location
      ? `loc:${location}-${this.settings.units}`
      : hasCoordinates
        ? `${this.settings.latitude},${this.settings.longitude}-${this.settings.units}`
        : `${loc}-${this.settings.units}`;
    const cached = weatherCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    // Fetch fresh data
    // Pass the ORIGINAL location parameter (not computed loc) so that
    // fetchOpenWeatherMap/fetchWeatherAPI can prefer coordinates when
    // no explicit location was requested by the caller
    let data: WeatherData;

    if (this.settings.provider === 'openweathermap') {
      data = await this.fetchOpenWeatherMap(location);
    } else {
      data = await this.fetchWeatherAPI(location);
    }

    // Cache the result
    weatherCache.set(cacheKey, {
      data,
      expiresAt: Date.now() + this.settings.cacheMinutes * 60 * 1000,
    });

    return data;
  }

  private async fetchOpenWeatherMap(location?: string): Promise<WeatherData> {
    if (!this.settings.apiKey) {
      throw new Error('OpenWeatherMap API key not configured');
    }

    const units = this.settings.units === 'metric' ? 'metric' : 'imperial';

    // If a specific location was passed, use it; otherwise use configured coordinates
    let url: string;
    if (location) {
      url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&units=${units}&appid=${this.settings.apiKey}`;
    } else if (this.settings.useCoordinates && this.settings.latitude && this.settings.longitude) {
      url = `https://api.openweathermap.org/data/2.5/weather?lat=${this.settings.latitude}&lon=${this.settings.longitude}&units=${units}&appid=${this.settings.apiKey}`;
    } else if (this.settings.location) {
      url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(this.settings.location)}&units=${units}&appid=${this.settings.apiKey}`;
    } else {
      throw new Error('No location or coordinates specified for weather lookup');
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Weather API error: ${response.status}`);
    }

    const data = await response.json();

    // Convert wind direction degrees to compass direction
    const windDirection = this.degreesToCompass(data.wind?.deg || 0);

    return {
      location: data.name,
      temperature: data.main.temp,
      feelsLike: data.main.feels_like,
      humidity: data.main.humidity,
      description: data.weather?.[0]?.description || 'Unknown',
      icon: data.weather?.[0]?.icon || '',
      windSpeed: data.wind?.speed || 0,
      windDirection,
      visibility: (data.visibility || 0) / 1000, // Convert to km
      pressure: data.main.pressure,
      sunrise: new Date(data.sys.sunrise * 1000).toLocaleTimeString(),
      sunset: new Date(data.sys.sunset * 1000).toLocaleTimeString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private async fetchWeatherAPI(location?: string): Promise<WeatherData> {
    if (!this.settings.apiKey) {
      throw new Error('WeatherAPI key not configured');
    }

    // WeatherAPI accepts coordinates as "lat,lon" format
    let query: string;
    if (this.settings.useCoordinates && this.settings.latitude && this.settings.longitude) {
      query = `${this.settings.latitude},${this.settings.longitude}`;
    } else if (location) {
      query = location;
    } else {
      throw new Error('No location or coordinates specified for weather lookup');
    }

    const url = `https://api.weatherapi.com/v1/current.json?key=${this.settings.apiKey}&q=${encodeURIComponent(query)}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Weather API error: ${response.status}`);
    }

    const data = await response.json();
    const current = data.current;
    const loc = data.location;

    const isMetric = this.settings.units === 'metric';

    return {
      location: loc.name,
      temperature: isMetric ? current.temp_c : current.temp_f,
      feelsLike: isMetric ? current.feelslike_c : current.feelslike_f,
      humidity: current.humidity,
      description: current.condition.text,
      icon: current.condition.icon,
      windSpeed: isMetric ? current.wind_kph : current.wind_mph,
      windDirection: current.wind_dir,
      visibility: isMetric ? current.vis_km : current.vis_miles,
      pressure: current.pressure_mb,
      sunrise: '', // WeatherAPI requires astronomy endpoint for this
      sunset: '',
      updatedAt: new Date().toISOString(),
    };
  }

  private degreesToCompass(degrees: number): string {
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const index = Math.round(degrees / 22.5) % 16;
    return directions[index];
  }

  formatWeatherForPrompt(weather: WeatherData): string {
    const tempUnit = this.settings.units === 'metric' ? '°C' : '°F';
    const speedUnit = this.settings.units === 'metric' ? 'km/h' : 'mph';

    return `Current weather in ${weather.location}:
- ${weather.description}
- Temperature: ${weather.temperature}${tempUnit} (feels like ${weather.feelsLike}${tempUnit})
- Humidity: ${weather.humidity}%
- Wind: ${weather.windSpeed} ${speedUnit} ${weather.windDirection}
- Visibility: ${weather.visibility} ${this.settings.units === 'metric' ? 'km' : 'miles'}`;
  }

  async getForecast(location?: string, days: number = 5): Promise<ForecastData> {
    const loc = location || this.settings.location;
    const hasCoordinates = this.settings.useCoordinates && this.settings.latitude && this.settings.longitude;
    if (!loc && !hasCoordinates) {
      throw new Error('No location specified');
    }

    const cacheKey = `forecast:${location ? `loc:${location}` : hasCoordinates ? `${this.settings.latitude},${this.settings.longitude}` : loc}-${this.settings.units}-${days}`;
    const cached = forecastCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    if (this.settings.provider !== 'openweathermap') {
      throw new Error('Forecast is only supported with OpenWeatherMap provider');
    }

    if (!this.settings.apiKey) {
      throw new Error('OpenWeatherMap API key not configured');
    }

    const units = this.settings.units === 'metric' ? 'metric' : 'imperial';
    let url: string;
    if (location) {
      url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(location)}&units=${units}&appid=${this.settings.apiKey}`;
    } else if (hasCoordinates) {
      url = `https://api.openweathermap.org/data/2.5/forecast?lat=${this.settings.latitude}&lon=${this.settings.longitude}&units=${units}&appid=${this.settings.apiKey}`;
    } else {
      url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(loc!)}&units=${units}&appid=${this.settings.apiKey}`;
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Forecast API error: ${response.status}`);
    }

    const data = await response.json();
    const maxEntries = days * 8; // 8 entries per day (3-hour intervals)

    const entries: ForecastEntry[] = (data.list || []).slice(0, maxEntries).map((item: Record<string, unknown>) => {
      const main = item.main as Record<string, number>;
      const weather = (item.weather as Array<Record<string, string>>)?.[0] || {};
      const wind = item.wind as Record<string, number>;
      const rain = item.rain as Record<string, number> | undefined;
      const snow = item.snow as Record<string, number> | undefined;

      return {
        datetime: item.dt_txt as string,
        temperature: main.temp,
        feelsLike: main.feels_like,
        humidity: main.humidity,
        description: weather.description || 'Unknown',
        icon: weather.icon || '',
        pop: (item.pop as number) || 0,
        windSpeed: wind?.speed || 0,
        windDirection: this.degreesToCompass(wind?.deg || 0),
        rain: rain?.['3h'],
        snow: snow?.['3h'],
      };
    });

    const forecastData: ForecastData = {
      location: data.city?.name || loc || 'Unknown',
      entries,
      updatedAt: new Date().toISOString(),
    };

    forecastCache.set(cacheKey, {
      data: forecastData,
      expiresAt: Date.now() + this.settings.cacheMinutes * 60 * 1000,
    });

    return forecastData;
  }

  formatForecastForPrompt(forecast: ForecastData): string {
    const tempUnit = this.settings.units === 'metric' ? '°C' : '°F';
    const speedUnit = this.settings.units === 'metric' ? 'km/h' : 'mph';

    // Group entries by day
    const byDay = new Map<string, ForecastEntry[]>();
    for (const entry of forecast.entries) {
      const date = entry.datetime.split(' ')[0];
      if (!byDay.has(date)) byDay.set(date, []);
      byDay.get(date)!.push(entry);
    }

    const lines: string[] = [`Weather forecast for ${forecast.location}:`];

    for (const [date, entries] of byDay) {
      const dayDate = new Date(date + 'T12:00:00');
      const dayName = dayDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      const temps = entries.map(e => e.temperature);
      const high = Math.round(Math.max(...temps));
      const low = Math.round(Math.min(...temps));
      const maxPop = Math.round(Math.max(...entries.map(e => e.pop)) * 100);
      const maxWind = Math.round(Math.max(...entries.map(e => e.windSpeed)));
      // Most common description
      const descCounts = new Map<string, number>();
      for (const e of entries) {
        descCounts.set(e.description, (descCounts.get(e.description) || 0) + 1);
      }
      const mainDesc = [...descCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'Unknown';

      let line = `\n${dayName}: ${mainDesc}, High ${high}${tempUnit} / Low ${low}${tempUnit}`;
      if (maxPop > 10) line += `, ${maxPop}% chance of precipitation`;
      if (maxWind > 0) line += `, Wind up to ${maxWind} ${speedUnit}`;

      const totalRain = entries.reduce((sum, e) => sum + (e.rain || 0), 0);
      const totalSnow = entries.reduce((sum, e) => sum + (e.snow || 0), 0);
      if (totalRain > 0) line += `, Rain: ${totalRain.toFixed(1)}mm`;
      if (totalSnow > 0) line += `, Snow: ${totalSnow.toFixed(1)}mm`;

      lines.push(line);
    }

    return lines.join('');
  }
}

// Clear weather cache
export function clearWeatherCache(): void {
  weatherCache.clear();
}
