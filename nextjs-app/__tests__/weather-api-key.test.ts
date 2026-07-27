/**
 * Weather configuration + query normalization.
 *
 * This file previously asserted that a real OpenWeather API key was hardcoded
 * as a string literal in route.ts. That directly contradicted the gitleaks
 * pre-commit hook added in 310ddf1, and once the key was (correctly) removed
 * the test just failed forever. Secrets belong in .env, so the test now checks
 * the thing that actually broke weather in production: the location query.
 *
 * Root cause found in the trace corpus: DEFAULT_WEATHER_LOCATION was
 * "Rodeo, NM", and OpenWeather's geocoder returns 404 "city not found" for
 * that. It needs "Rodeo,NM,US". Meanwhile the configured lat/lon for the same
 * place resolved fine, so the fix is to prefer coordinates and normalize names.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { normalizeLocationQuery } from '../lib/weather-service';

describe('Weather API key configuration', () => {
  const roots = [
    path.join(__dirname, '..', 'app', 'api', 'weather', 'route.ts'),
    path.join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'),
  ];

  test('the API key comes from the environment, never a hardcoded literal', () => {
    for (const p of roots) {
      const src = readFileSync(p, 'utf-8');
      const match = src.match(/apiKey:\s*process\.env\.OPENWEATHER_API_KEY\s*\|\|\s*'([^']*)'/);
      expect(match).not.toBeNull();
      // Fallback must be empty — a non-empty literal would be a committed secret.
      expect(match![1]).toBe('');
    }
  });

  test('OPENWEATHER_API_KEY is declared in .env.example', () => {
    const example = readFileSync(path.join(__dirname, '..', '.env.example'), 'utf-8');
    expect(example).toMatch(/^OPENWEATHER_API_KEY=/m);
  });
});

describe('normalizeLocationQuery', () => {
  test('appends US to a City, ST pair (the "Rodeo, NM" 404)', () => {
    expect(normalizeLocationQuery('Rodeo, NM')).toBe('Rodeo,NM,US');
  });

  test('handles a missing space', () => {
    expect(normalizeLocationQuery('Rodeo,NM')).toBe('Rodeo,NM,US');
  });

  test('uppercases the state code', () => {
    expect(normalizeLocationQuery('Rodeo, nm')).toBe('Rodeo,NM,US');
  });

  test('leaves an already-qualified query alone apart from spacing', () => {
    expect(normalizeLocationQuery('Tucson, AZ, US')).toBe('Tucson,AZ,US');
  });

  test('does not touch non-US queries', () => {
    expect(normalizeLocationQuery('London')).toBe('London');
    expect(normalizeLocationQuery('Paris, FR')).toBe('Paris,FR');
  });

  test('does not mistake a country code for a US state', () => {
    // "Paris, FR" must not become "Paris,FR,US"; FR is not a US state.
    expect(normalizeLocationQuery('Paris, FR')).not.toContain('US');
  });
});
