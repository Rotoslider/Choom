/**
 * API keys never ride in a request URL: next dev writes every request URL to
 * data/logs/choom-dev.log, and the settings model menus (GET ?apiKey=) and the
 * Weather "Test" button put the OpenRouter, Anthropic, NVIDIA and OpenWeather
 * keys there in plain text (found Nov 4 2026).
 */
const weatherSettingsSeen: { apiKey: string }[] = [];
jest.mock('@/lib/weather-service', () => ({
  clearWeatherCache: jest.fn(),
  WeatherService: class {
    constructor(settings: { apiKey: string }) {
      weatherSettingsSeen.push(settings);
    }
    async getWeather() {
      return { temperature: 61 };
    }
    formatWeatherForPrompt() {
      return '61°F';
    }
  },
}));

import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { requestModelList } from '@/lib/model-list-request';
import { GET as modelsGET, POST as modelsPOST } from '@/app/api/services/models/route';
import { GET as weatherGET, POST as weatherPOST } from '@/app/api/weather/route';

const realFetch = global.fetch;
let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  weatherSettingsSeen.length = 0;
});
afterAll(() => {
  global.fetch = realFetch;
});

const json = (data: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => data }) as Response;

test('the model menus post the key in the body, not the URL', async () => {
  fetchMock.mockResolvedValue(json({ models: [] }));
  await requestModelList('https://openrouter.ai/api/v1', 'sk-or-v1-secret');
  await requestModelList('http://nuc:1234/v1');
  const [[url, init], [, keyless]] = fetchMock.mock.calls;
  expect(url).toBe('/api/services/models');
  expect(init.method).toBe('POST');
  expect(JSON.parse(init.body)).toEqual({ endpoint: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-v1-secret' });
  expect(JSON.parse(keyless.body)).toEqual({ endpoint: 'http://nuc:1234/v1' });
});

test('POST lists Anthropic models with the key as x-api-key', async () => {
  fetchMock.mockResolvedValue(json({ data: [{ id: 'claude-opus-5-5' }] }));
  const res = await modelsPOST(
    new NextRequest('http://localhost/api/services/models', {
      method: 'POST',
      body: JSON.stringify({ endpoint: 'https://api.anthropic.com', apiKey: 'sk-ant-usr-secret' }),
    }),
  );
  expect(await res.json()).toEqual({ models: [{ id: 'claude-opus-5-5', name: 'claude-opus-5-5' }], loadedAvailable: false });
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('https://api.anthropic.com/v1/models?limit=100');
  expect(init.headers['x-api-key']).toBe('sk-ant-usr-secret');
});

test('POST sends an OpenAI-style key as a Bearer token', async () => {
  fetchMock.mockResolvedValue(json({ data: [{ id: 'deepseek/deepseek-v4' }] }));
  await modelsPOST(
    new NextRequest('http://localhost/api/services/models', {
      method: 'POST',
      body: JSON.stringify({ endpoint: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-v1-secret' }),
    }),
  );
  const call = fetchMock.mock.calls.find(([u]) => u === 'https://openrouter.ai/api/v1/models');
  expect(call![1].headers.Authorization).toBe('Bearer sk-or-v1-secret');
});

test('GET reads no key from the URL', async () => {
  fetchMock.mockResolvedValue(json({ data: [] }));
  await modelsGET(new NextRequest('http://localhost/api/services/models?endpoint=http%3A%2F%2Fnuc%3A1234%2Fv1&apiKey=from-url'));
  for (const [, init] of fetchMock.mock.calls) {
    expect(JSON.stringify(init.headers)).not.toContain('from-url');
  }
});

test('Weather "Test" posts its key; GET ignores one in the URL', async () => {
  const res = await weatherPOST(
    new NextRequest('http://localhost/api/weather', {
      method: 'POST',
      body: JSON.stringify({ action: 'test', apiKey: 'ow-secret', units: 'imperial', useCoordinates: 'true' }),
    }),
  );
  expect((await res.json()).success).toBe(true);
  expect(weatherSettingsSeen[0].apiKey).toBe('ow-secret');

  await weatherGET(new NextRequest('http://localhost/api/weather?apiKey=from-url'));
  expect(weatherSettingsSeen.map((s) => s.apiKey)).not.toContain('from-url');
});

test('no app code puts apiKey into an /api/ URL again', () => {
  const root = path.join(__dirname, '..');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) {
        const src = readFileSync(p, 'utf-8');
        if (/params\.set\(\s*['"]apiKey['"]/.test(src) || /[`'"]\/api\/[^`'"]*[?&]apiKey=/.test(src)) {
          offenders.push(path.relative(root, p));
        }
      }
    }
  };
  for (const dir of ['app', 'components', 'lib']) walk(path.join(root, dir));
  expect(offenders).toEqual([]);
});
