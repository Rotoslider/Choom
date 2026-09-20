/**
 * Named weather places — spots the user cares about that no geocoder gets
 * right. The home valley (Rodeo, NM) and the camp in the Chiricahuas are
 * 20 miles and 4,000 vertical feet apart; "Chiricahua Mountains" is not a
 * place OpenWeather knows, and the nearest town it does know (Portal, AZ) sits
 * at the canyon mouth, a mile lower than the camp. Coordinates fix that: an
 * OpenWeather lookup at Rustler Park's lat/lon read 55°F at the same moment
 * the station there read 55°F and the valley read 77°F (2026-09-20).
 *
 * Built-in defaults below; `data/weather-places.json` (same shape, an array)
 * replaces them when present so places can be added without a code change.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface NamedPlace {
  /** Label shown in the answer. */
  name: string;
  /** Lower-case phrases that mean this place. Matched as whole words/phrases. */
  aliases: string[];
  lat: number;
  lon: number;
  elevationFt?: number;
  /** Weather Underground personal weather station id for live conditions (needs WUNDERGROUND_API_KEY). */
  pwsStationId?: string;
  /** One line of context for the model (distance from camp, what the numbers mean). */
  note?: string;
}

export const DEFAULT_PLACES: NamedPlace[] = [
  {
    name: 'Rustler Park, Chiricahua Mountains, AZ',
    aliases: [
      'chiricahua', 'chiricahuas', 'chiricahua mountains', 'the chiricahua mountains', 'chiricahua mtns',
      'rustler park', 'rustler', 'camp', 'the camp', 'my camp', 'campsite', 'camping', 'camping spot', 'camp spot',
      'the mountain', 'the mountains', 'up the mountain', 'up on the mountain', 'up the road', 'onion saddle', 'barfoot',
      'chiricahua wilderness', 'chiricahua crest', 'chiricahua hike', 'hiking',
    ],
    lat: 31.9028,
    lon: -109.2779,
    elevationFt: 8963,
    pwsStationId: 'KAZSANSI50',
    note: 'The camp in the Chiricahuas is ~2 miles from the Rustler Park station at about the same elevation (~8,900 ft), 4,000 ft above home in the valley. Do NOT use Portal, AZ or Rodeo, NM for camp weather — they are a mile lower and often 20°F warmer.',
  },
];

const PLACES_FILE = path.join(process.cwd(), 'data', 'weather-places.json');
let cache: { mtimeMs: number; places: NamedPlace[] } | null = null;

/** Places from data/weather-places.json when it exists and parses, else the defaults. */
export function loadPlaces(): NamedPlace[] {
  try {
    const st = fs.statSync(PLACES_FILE);
    if (cache && cache.mtimeMs === st.mtimeMs) return cache.places;
    const parsed = JSON.parse(fs.readFileSync(PLACES_FILE, 'utf-8'));
    const places = Array.isArray(parsed) ? parsed.filter(isPlace) : [];
    cache = { mtimeMs: st.mtimeMs, places: places.length ? places : DEFAULT_PLACES };
    return cache.places;
  } catch {
    return DEFAULT_PLACES;
  }
}

function isPlace(p: unknown): p is NamedPlace {
  const o = p as Record<string, unknown>;
  return !!o && typeof o.name === 'string' && Array.isArray(o.aliases)
    && typeof o.lat === 'number' && typeof o.lon === 'number';
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Match a free-text location against the named places. Whole-phrase match on
 * any alias ("weather at camp", "Chiricahua Mountains, AZ", "rustler park
 * this weekend"); the longest alias wins so "chiricahua mountains" beats
 * "chiricahua" only in the sense of certainty — both hit the same place.
 */
export function resolveNamedPlace(query: string | undefined, places: NamedPlace[] = loadPlaces()): NamedPlace | null {
  if (!query) return null;
  const q = ` ${norm(query)} `;
  if (!q.trim()) return null;
  let best: { place: NamedPlace; len: number } | null = null;
  for (const place of places) {
    for (const alias of place.aliases) {
      const a = norm(alias);
      if (a && q.includes(` ${a} `) && (!best || a.length > best.len)) best = { place, len: a.length };
    }
  }
  return best?.place ?? null;
}
