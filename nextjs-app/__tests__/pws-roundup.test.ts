/**
 * Area roundup math: rain per hour is the rise of a running total that resets
 * at local midnight, so "last 24h" spans two days' totals.
 */
import { computeRainStats, distanceAndBearing, parseHourly, type HourlyObs } from '../lib/pws-roundup';

const h = (local: string, precipTotal: number, windgustHigh = 5): HourlyObs => ({
  epoch: Math.floor(new Date(local.replace(' ', 'T') + 'Z').getTime() / 1000),
  obsTimeLocal: local, precipTotal, windgustHigh,
});

describe('computeRainStats', () => {
  // Rain 7-9 PM yesterday (0.10 + 0.25), 0.05 at 2 AM today, a week-old 0.15.
  const hourly = [
    h('2026-09-20 15:59:00', 0.15),
    h('2026-09-20 16:59:00', 0.15),
    h('2026-09-25 18:59:00', 0.00),
    h('2026-09-25 19:59:00', 0.10),
    h('2026-09-25 20:59:00', 0.35, 22),
    h('2026-09-25 23:59:00', 0.35),
    h('2026-09-26 00:59:00', 0.00, 9),
    h('2026-09-26 01:59:00', 0.05, 14),
    h('2026-09-26 02:59:00', 0.05, 11),
  ];
  const now = h('2026-09-26 03:30:00', 0).epoch;

  it('adds yesterday evening and after-midnight rain into the last 24h', () => {
    const r = computeRainStats(hourly, { precipTotal: 0.05, windGust: 6, observedAt: '2026-09-26 03:25:00' }, now);
    expect(r.last24h).toBe(0.4);
    expect(r.today).toBe(0.05);
    expect(r.last7d).toBe(0.55);
    expect(r.lastRainLocal).toBe('2026-09-26 01:59:00');
    expect(r.peakGustToday).toBe(14); // yesterday's 22 is not today's
  });

  it('counts rain since the last hourly record from the current reading', () => {
    const r = computeRainStats(hourly, { precipTotal: 0.12, windGust: 6, observedAt: '2026-09-26 03:25:00' }, now);
    expect(r.last24h).toBe(0.47);
    expect(r.today).toBe(0.12);
    expect(r.lastRainLocal).toBe('2026-09-26 03:25:00');
  });

  it('is all zeros with no rain', () => {
    const r = computeRainStats([h('2026-09-26 01:59:00', 0)], { precipTotal: 0, windGust: 3, observedAt: '2026-09-26 02:10:00' }, now);
    expect(r).toEqual({ last24h: 0, today: 0, last7d: 0, peakGustToday: 5 });
  });
});

describe('parseHourly', () => {
  it('reads the imperial block', () => {
    const rows = parseHourly({ observations: [{ epoch: 1790000000, obsTimeLocal: '2026-09-21 10:59:00', imperial: { precipTotal: 0.2, windgustHigh: 30 } }] });
    expect(rows).toEqual([{ epoch: 1790000000, obsTimeLocal: '2026-09-21 10:59:00', precipTotal: 0.2, windgustHigh: 30 }]);
  });
});

describe('distanceAndBearing', () => {
  it('home → Rodeo airport station is ~2.3 mi SSW', () => {
    const d = distanceAndBearing({ lat: 31.979, lon: -109.028 }, { lat: 31.948106, lon: -109.043811 });
    expect(d.miles).toBeCloseTo(2.3, 0);
    expect(d.bearing).toBe('SSW');
  });
});
