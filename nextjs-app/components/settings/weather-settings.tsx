'use client';

import React, { useState } from 'react';
import { Cloud, MapPin, Thermometer, RefreshCw, Check, X, Navigation } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppStore } from '@/lib/store';
import type { WeatherData } from '@/lib/types';

export function WeatherSettings() {
  const { settings, updateWeatherSettings } = useAppStore();
  const [testResult, setTestResult] = useState<{
    success: boolean;
    data?: WeatherData;
    error?: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  const testWeather = async () => {
    setTesting(true);
    setTestResult(null);

    try {
      const params = new URLSearchParams({
        apiKey: settings.weather.apiKey,
        provider: settings.weather.provider,
        location: settings.weather.location,
        units: settings.weather.units,
        useCoordinates: settings.weather.useCoordinates ? 'true' : 'false',
      });

      if (settings.weather.latitude) {
        params.set('latitude', settings.weather.latitude.toString());
      }
      if (settings.weather.longitude) {
        params.set('longitude', settings.weather.longitude.toString());
      }

      const response = await fetch(`/api/weather?${params}`);
      const data = await response.json();

      if (data.success) {
        setTestResult({ success: true, data: data.weather });
      } else {
        setTestResult({ success: false, error: data.error });
      }
    } catch (error) {
      setTestResult({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to test weather',
      });
    } finally {
      setTesting(false);
    }
  };

  const clearCache = async () => {
    try {
      await fetch('/api/weather', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear_cache' }),
      });
      setTestResult(null);
    } catch (error) {
      console.error('Failed to clear cache:', error);
    }
  };

  return (
    <div className="space-y-6">
      {/* API Configuration */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Cloud className="h-4 w-4" />
          Weather API Configuration
        </h3>

        <div className="space-y-3">
          <div className="space-y-2">
            <label htmlFor="weather-provider">Provider</label>
            <Select
              value={settings.weather.provider}
              onValueChange={(value: 'openweathermap' | 'weatherapi') =>
                updateWeatherSettings({ provider: value })
              }
            >
              <SelectTrigger id="weather-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openweathermap">OpenWeatherMap</SelectItem>
                <SelectItem value="weatherapi">WeatherAPI</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label htmlFor="weather-api-key">API Key</label>
            <Input
              id="weather-api-key"
              type="password"
              value={settings.weather.apiKey}
              onChange={(e) => updateWeatherSettings({ apiKey: e.target.value })}
              placeholder="Enter your API key"
            />
            <p className="text-xs text-muted-foreground">
              Get a free API key from{' '}
              <a
                href="https://openweathermap.org/api"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                OpenWeatherMap
              </a>
            </p>
          </div>
        </div>
      </div>

      {/* Location */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <MapPin className="h-4 w-4" />
          Location
        </h3>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <label htmlFor="use-coordinates" className="text-sm">Use GPS Coordinates</label>
            <p className="text-xs text-muted-foreground">
              More accurate for small towns and traveling
            </p>
          </div>
          <Switch
            id="use-coordinates"
            checked={settings.weather.useCoordinates || false}
            onCheckedChange={(checked) => updateWeatherSettings({ useCoordinates: checked })}
          />
        </div>

        {settings.weather.useCoordinates ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label htmlFor="weather-latitude">Latitude</label>
                <Input
                  id="weather-latitude"
                  type="number"
                  step="0.000001"
                  value={settings.weather.latitude || ''}
                  onChange={(e) => updateWeatherSettings({ latitude: parseFloat(e.target.value) || undefined })}
                  placeholder="e.g., 40.7128"
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="weather-longitude">Longitude</label>
                <Input
                  id="weather-longitude"
                  type="number"
                  step="0.000001"
                  value={settings.weather.longitude || ''}
                  onChange={(e) => updateWeatherSettings({ longitude: parseFloat(e.target.value) || undefined })}
                  placeholder="e.g., -74.0060"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Navigation className="h-3 w-3" />
              Perfect for GPS-based location when traveling
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <label htmlFor="weather-location">City Name</label>
            <Input
              id="weather-location"
              value={settings.weather.location}
              onChange={(e) => updateWeatherSettings({ location: e.target.value })}
              placeholder="e.g., Phoenix, AZ or Denver, CO"
            />
            <p className="text-xs text-muted-foreground">
              Use a major city name - small towns may not be recognized
            </p>
          </div>
        )}
      </div>

      {/* Units */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Thermometer className="h-4 w-4" />
          Units
        </h3>

        <div className="space-y-2">
          <label htmlFor="weather-units">Temperature Units</label>
          <Select
            value={settings.weather.units}
            onValueChange={(value: 'metric' | 'imperial') =>
              updateWeatherSettings({ units: value })
            }
          >
            <SelectTrigger id="weather-units">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="imperial">Fahrenheit (°F)</SelectItem>
              <SelectItem value="metric">Celsius (°C)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Cache */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <RefreshCw className="h-4 w-4" />
          Cache Settings
        </h3>

        <div className="space-y-2">
          <label htmlFor="weather-cache">Cache Duration (minutes)</label>
          <Input
            id="weather-cache"
            type="number"
            min={1}
            max={120}
            value={settings.weather.cacheMinutes}
            onChange={(e) =>
              updateWeatherSettings({ cacheMinutes: parseInt(e.target.value) || 30 })
            }
          />
          <p className="text-xs text-muted-foreground">
            Weather data is cached to reduce API calls
          </p>
        </div>
      </div>

      {/* Test Connection */}
      <div className="space-y-4 pt-4 border-t">
        <div className="flex gap-2">
          <Button
            onClick={testWeather}
            disabled={testing || !settings.weather.apiKey}
            className="flex-1"
          >
            {testing ? (
              <>
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                Testing...
              </>
            ) : (
              <>
                <Cloud className="h-4 w-4 mr-2" />
                Test Weather
              </>
            )}
          </Button>
          <Button variant="outline" onClick={clearCache}>
            Clear Cache
          </Button>
        </div>

        {testResult && (
          <div
            className={`p-4 rounded-lg ${
              testResult.success
                ? 'bg-green-500/10 border border-green-500/20'
                : 'bg-red-500/10 border border-red-500/20'
            }`}
          >
            {testResult.success && testResult.data ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-green-500">
                  <Check className="h-4 w-4" />
                  <span className="font-medium">Weather fetched successfully</span>
                </div>
                <div className="text-sm space-y-1">
                  <p>
                    <strong>Location:</strong> {testResult.data.location}
                  </p>
                  <p>
                    <strong>Conditions:</strong> {testResult.data.description}
                  </p>
                  <p>
                    <strong>Temperature:</strong> {testResult.data.temperature}
                    {settings.weather.units === 'imperial' ? '°F' : '°C'} (feels like{' '}
                    {testResult.data.feelsLike}
                    {settings.weather.units === 'imperial' ? '°F' : '°C'})
                  </p>
                  <p>
                    <strong>Wind:</strong> {testResult.data.windSpeed}{' '}
                    {settings.weather.units === 'imperial' ? 'mph' : 'km/h'}{' '}
                    {testResult.data.windDirection}
                  </p>
                  <p>
                    <strong>Humidity:</strong> {testResult.data.humidity}%
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-red-500">
                <X className="h-4 w-4" />
                <span>{testResult.error}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
