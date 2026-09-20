/**
 * Named weather places — "camp" / "Chiricahua Mountains" must resolve to the
 * Rustler Park coordinates (8,900 ft), never to Portal/Rodeo at the valley
 * floor. Plus the Weather Underground parsers on captured payloads.
 */
import { resolveNamedPlace, DEFAULT_PLACES } from '../lib/weather-places';
import { parsePwsObservation, parseWuDailyForecast } from '../lib/weather-service';

describe('resolveNamedPlace', () => {
  const rustler = DEFAULT_PLACES[0];
  it.each([
    'camp', 'the camp', 'weather at camp', 'Chiricahua Mountains, AZ', 'the Chiricahuas', 'Rustler Park this weekend',
    'up the mountain', 'chiricahua-mountains', 'Onion Saddle',
  ])('resolves %p to Rustler Park', (q) => {
    expect(resolveNamedPlace(q, DEFAULT_PLACES)).toBe(rustler);
  });

  it.each(['Denver, CO', 'Portal, AZ', 'Rodeo, NM', 'Campbell, CA', 'campground bakersfield', '', undefined])(
    'leaves %p alone', (q) => {
      expect(resolveNamedPlace(q as string | undefined, DEFAULT_PLACES)).toBeNull();
    });
});

describe('parsePwsObservation', () => {
  // Captured from api.weather.com for KAZSANSI50, 2026-09-20 07:15 local.
  const payload = { observations: [{ stationID: 'KAZSANSI50', obsTimeUtc: '2026-09-20T14:15:00Z', obsTimeLocal: '2026-09-20 07:15:00', neighborhood: 'San Simon', lon: -109.277923, lat: 31.902756, uv: 0.2, winddir: 267, humidity: 68,
    imperial: { temp: 55, heatIndex: 55, dewpt: 44, windChill: 55, windSpeed: 1, windGust: 3, pressure: 30.33, precipRate: 0.0, precipTotal: 0.0, elev: 8963 } }] };

  it('maps the imperial block and compass direction', () => {
    const o = parsePwsObservation(payload, false)!;
    expect(o.stationId).toBe('KAZSANSI50');
    expect(o.temperature).toBe(55);
    expect(o.dewPoint).toBe(44);
    expect(o.windDirection).toBe('W');
    expect(o.windGust).toBe(3);
    expect(o.elevationFt).toBe(8963);
    expect(o.observedAt).toBe('2026-09-20 07:15:00');
  });

  it('returns null for an empty or malformed payload', () => {
    expect(parsePwsObservation({ observations: [] }, false)).toBeNull();
    expect(parsePwsObservation(null, false)).toBeNull();
    expect(parsePwsObservation(payload, true)).toBeNull(); // no metric block in this payload
  });
});

describe('parseWuDailyForecast', () => {
  const payload = {
    dayOfWeek: ['Sunday', 'Monday', 'Tuesday'],
    calendarDayTemperatureMax: [77, 77, 68],
    calendarDayTemperatureMin: [49, 54, 54],
    narrative: ['Sunny. Highs in the upper 70s.', 'Partly cloudy with a stray storm.', 'Showers.'],
    daypart: [{ precipChance: [5, 3, 20, 30, 60, 40] }],
  };
  it('produces one outlook per day with the higher day/night precip chance', () => {
    const o = parseWuDailyForecast(payload, 2);
    expect(o).toHaveLength(2);
    expect(o[0]).toEqual({ day: 'Sunday', high: 77, low: 49, narrative: 'Sunny. Highs in the upper 70s.', precipChance: 5 });
    expect(o[1].precipChance).toBe(30);
  });
  it('is empty for garbage', () => {
    expect(parseWuDailyForecast({}, 5)).toEqual([]);
    expect(parseWuDailyForecast(null, 5)).toEqual([]);
  });
});
