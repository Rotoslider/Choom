/**
 * Test: Weather API key consistency
 * Verifies that /api/weather and /api/chat both have the same fallback API key
 */
import { readFileSync } from 'fs';
import path from 'path';

describe('Weather API Key Fallback', () => {
  const weatherRoutePath = path.join(__dirname, '..', 'app', 'api', 'weather', 'route.ts');
  const chatRoutePath = path.join(__dirname, '..', 'app', 'api', 'chat', 'route.ts');

  let weatherRouteContent: string;
  let chatRouteContent: string;

  beforeAll(() => {
    weatherRouteContent = readFileSync(weatherRoutePath, 'utf-8');
    chatRouteContent = readFileSync(chatRoutePath, 'utf-8');
  });

  test('/api/weather has a non-empty fallback API key', () => {
    // Match the pattern: apiKey: process.env.OPENWEATHER_API_KEY || 'something'
    const match = weatherRouteContent.match(/apiKey:\s*process\.env\.OPENWEATHER_API_KEY\s*\|\|\s*'([^']*)'/);
    expect(match).not.toBeNull();
    expect(match![1]).not.toBe('');
    expect(match![1].length).toBeGreaterThan(10); // Should be a real API key
  });

  test('/api/chat has a non-empty fallback API key', () => {
    const match = chatRouteContent.match(/apiKey:\s*process\.env\.OPENWEATHER_API_KEY\s*\|\|\s*'([^']*)'/);
    expect(match).not.toBeNull();
    expect(match![1]).not.toBe('');
    expect(match![1].length).toBeGreaterThan(10);
  });

  test('both endpoints use the same fallback API key', () => {
    const weatherMatch = weatherRouteContent.match(/apiKey:\s*process\.env\.OPENWEATHER_API_KEY\s*\|\|\s*'([^']*)'/);
    const chatMatch = chatRouteContent.match(/apiKey:\s*process\.env\.OPENWEATHER_API_KEY\s*\|\|\s*'([^']*)'/);
    expect(weatherMatch![1]).toBe(chatMatch![1]);
  });
});
