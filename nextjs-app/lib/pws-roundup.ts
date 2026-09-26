/**
 * Area roundup across several Weather Underground personal weather stations —
 * "who got rain last night", "how windy is it around the valley". The user
 * keeps tabs on a handful of stations near home (the `watch` places in
 * data/weather-places.json); a Choom can also pass any station ids, e.g. the
 * one nearest a campsite for the length of a trip.
 *
 * Per station: the current reading plus /v2/pws/observations/hourly/7day,
 * from which rain over the last 24 h / today / 7 days, the last rain and
 * today's peak gust are derived. Imperial units throughout (°F, mph, in).
 */
import { WUNDERGROUND_API_KEY, parsePwsObservation, type PwsObservation } from '@/lib/weather-service';
import { loadPlaces, type NamedPlace } from '@/lib/weather-places';

export interface HourlyObs {
  epoch: number;
  obsTimeLocal: string; // "2026-09-23 18:59:00" — station local time
  precipTotal: number;  // running total for that local day
  windgustHigh: number;
}

export interface RainStats {
  last24h: number;
  today: number;
  last7d: number;
  lastRainLocal?: string; // local time of the most recent hour with rain
  peakGustToday: number;
}

export interface StationRoundup {
  stationId: string;
  name: string;
  /** WU's area name (the post-office town — "San Simon" spans valley to crest). */
  wuArea?: string;
  elevationFt?: number;
  distanceMi?: number;
  bearing?: string;
  current?: PwsObservation;
  rain?: RainStats;
  error?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const dateOf = (local: string) => local.slice(0, 10);
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function distanceAndBearing(from: { lat: number; lon: number }, to: { lat: number; lon: number }): { miles: number; bearing: string } {
  const rad = Math.PI / 180;
  const dLat = (to.lat - from.lat) * rad;
  const dLon = (to.lon - from.lon) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(from.lat * rad) * Math.cos(to.lat * rad) * Math.sin(dLon / 2) ** 2;
  const miles = 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const y = Math.sin(dLon) * Math.cos(to.lat * rad);
  const x = Math.cos(from.lat * rad) * Math.sin(to.lat * rad) - Math.sin(from.lat * rad) * Math.cos(to.lat * rad) * Math.cos(dLon);
  const deg = (Math.atan2(y, x) / rad + 360) % 360;
  return { miles: Math.round(miles * 10) / 10, bearing: COMPASS[Math.round(deg / 22.5) % 16] };
}

/**
 * Rain and gust stats from hourly records. precipTotal is a running total
 * that resets at local midnight, so each hour's rain is its rise over the
 * previous hour of the same day (or the whole value for a day's first hour).
 * `current` extends the last hourly record up to the latest reading.
 */
export function computeRainStats(hourly: HourlyObs[], current: { precipTotal: number; windGust: number; observedAt: string } | undefined, nowEpoch: number): RainStats {
  const obs = [...hourly].sort((a, b) => a.epoch - b.epoch);
  let last24h = 0, last7d = 0;
  let lastRainLocal: string | undefined;
  for (let i = 0; i < obs.length; i++) {
    const prev = obs[i - 1];
    const inc = prev && dateOf(prev.obsTimeLocal) === dateOf(obs[i].obsTimeLocal)
      ? Math.max(0, obs[i].precipTotal - prev.precipTotal)
      : Math.max(0, obs[i].precipTotal);
    if (inc > 0) lastRainLocal = obs[i].obsTimeLocal;
    last7d += inc;
    if (obs[i].epoch > nowEpoch - 24 * 3600) last24h += inc;
  }
  const lastHour = obs[obs.length - 1];
  const today = current ? current.precipTotal : (lastHour ? lastHour.precipTotal : 0);
  if (current && lastHour && dateOf(lastHour.obsTimeLocal) === dateOf(current.observedAt)) {
    const tail = Math.max(0, current.precipTotal - lastHour.precipTotal);
    if (tail > 0) { last24h += tail; last7d += tail; lastRainLocal = current.observedAt; }
  } else if (current && current.precipTotal > 0 && (!lastHour || dateOf(lastHour.obsTimeLocal) !== dateOf(current.observedAt))) {
    last24h += current.precipTotal; last7d += current.precipTotal; lastRainLocal = current.observedAt;
  }
  const todayDate = current ? dateOf(current.observedAt) : (lastHour ? dateOf(lastHour.obsTimeLocal) : '');
  const peakGustToday = Math.max(
    current?.windGust ?? 0,
    ...obs.filter(o => dateOf(o.obsTimeLocal) === todayDate).map(o => o.windgustHigh || 0),
  );
  return { last24h: round2(last24h), today: round2(today), last7d: round2(last7d), ...(lastRainLocal && { lastRainLocal }), peakGustToday };
}

export function parseHourly(json: unknown): HourlyObs[] {
  const list = (json as { observations?: Array<Record<string, unknown>> })?.observations || [];
  return list.map(o => {
    const u = (o.imperial || {}) as Record<string, number>;
    return { epoch: Number(o.epoch), obsTimeLocal: String(o.obsTimeLocal || ''), precipTotal: Number(u.precipTotal ?? 0), windgustHigh: Number(u.windgustHigh ?? 0) };
  }).filter(o => Number.isFinite(o.epoch) && o.obsTimeLocal);
}

const cache = new Map<string, { data: StationRoundup; expiresAt: number }>();
const CACHE_MS = 10 * 60 * 1000;

async function wuJson(url: string): Promise<unknown | null> {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok || r.status === 204) return null;
  return r.json();
}

export function homePlace(places: NamedPlace[] = loadPlaces()): NamedPlace | undefined {
  return places.find(p => p.aliases.some(a => a.toLowerCase() === 'home'));
}

/** Current reading + derived rain/gust stats for each station, in the order given. Never throws. */
export async function fetchStationRoundup(stationIds: string[], places: NamedPlace[] = loadPlaces()): Promise<StationRoundup[]> {
  const home = homePlace(places);
  const ids = [...new Set(stationIds.map(s => s.trim().toUpperCase()).filter(Boolean))];
  return Promise.all(ids.map(async (id): Promise<StationRoundup> => {
    const known = places.find(p => p.pwsStationId?.toUpperCase() === id);
    const hit = cache.get(id);
    if (hit && hit.expiresAt > Date.now()) return hit.data;
    const base: StationRoundup = { stationId: id, name: known?.name || id };
    if (!WUNDERGROUND_API_KEY) return { ...base, error: 'WUNDERGROUND_API_KEY is not set' };
    try {
      const q = `stationId=${encodeURIComponent(id)}&format=json&units=e&apiKey=${WUNDERGROUND_API_KEY}`;
      const [curJson, hourlyJson] = await Promise.all([
        wuJson(`https://api.weather.com/v2/pws/observations/current?${q}`),
        wuJson(`https://api.weather.com/v2/pws/observations/hourly/7day?${q}`).catch(() => null),
      ]);
      const current = curJson ? parsePwsObservation(curJson, false) : null;
      if (!current) return { ...base, error: 'not found or not reporting' };
      const lat = current.lat ?? known?.lat;
      const lon = current.lon ?? known?.lon;
      const where = home && lat !== undefined && lon !== undefined && home.pwsStationId?.toUpperCase() !== id
        ? distanceAndBearing(home, { lat, lon }) : undefined;
      const data: StationRoundup = {
        ...base,
        name: known?.name || (current.neighborhood ? `${current.neighborhood} area` : id),
        wuArea: current.neighborhood,
        // A saved elevation wins: some owners type meters into WU (1,288 "ft").
        elevationFt: known?.elevationFt ?? current.elevationFt,
        ...(where && { distanceMi: where.miles, bearing: where.bearing }),
        current,
        rain: computeRainStats(parseHourly(hourlyJson), current, Math.floor(Date.now() / 1000)),
      };
      cache.set(id, { data, expiresAt: Date.now() + CACHE_MS });
      return data;
    } catch (e) {
      return { ...base, error: e instanceof Error ? e.message : String(e) };
    }
  }));
}

const inch = (n: number) => `${n.toFixed(2)}"`;

export function formatRoundupForPrompt(rows: StationRoundup[], title: string): string {
  const lines = [`${title} (live Weather Underground stations, °F / mph / inches):`];
  for (const r of rows) {
    const where = [r.elevationFt !== undefined && `${Math.round(r.elevationFt).toLocaleString()} ft`, r.distanceMi !== undefined && `${r.distanceMi} mi ${r.bearing} of home`].filter(Boolean).join(', ');
    const head = `- ${r.name} (${r.stationId}${where ? `, ${where}` : ''})`;
    if (r.error || !r.current) { lines.push(`${head}: unavailable — ${r.error || 'no reading'}`); continue; }
    const c = r.current;
    const rain = r.rain;
    const rainText = rain
      ? `rain last 24h ${inch(rain.last24h)}, today ${inch(rain.today)}, 7 days ${inch(rain.last7d)}${rain.lastRainLocal ? ` (last rain ${rain.lastRainLocal.slice(5, 16)})` : ' (none in 7 days)'}`
      : `rain today ${inch(c.precipTotal)}`;
    lines.push(`${head}, read ${c.observedAt.slice(11, 16)} station time: ${c.temperature}°F, wind ${c.windSpeed} ${c.windDirection} gusting ${c.windGust}${rain ? ` (today's peak gust ${rain.peakGustToday})` : ''}, humidity ${c.humidity}%; ${rainText}${c.precipRate > 0 ? `; RAINING NOW ${c.precipRate}"/hr` : ''}`);
  }
  lines.push('Station times are each station\'s local clock (Arizona stations read an hour behind New Mexico in summer). WU area names are post-office towns — go by elevation and distance, not the name.');
  return lines.join('\n');
}
