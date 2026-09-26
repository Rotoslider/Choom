import { NextRequest, NextResponse } from 'next/server';
import { loadPlaces, savePlaces } from '@/lib/weather-places';
import { WUNDERGROUND_API_KEY, parsePwsObservation } from '@/lib/weather-service';
import { distanceAndBearing, homePlace } from '@/lib/pws-roundup';

// Settings → Weather → Weather Stations.
//   GET                      → { places, wuKeySet }
//   GET ?lookup=KNMRODEO32   → one station's location/elevation/current reading
//   GET ?near=31.9,-109.2    → reporting stations near a point, with elevations
//   PUT { places }           → replace data/weather-places.json

interface StationInfo {
  stationId: string;
  wuArea?: string;
  lat?: number;
  lon?: number;
  elevationFt?: number;
  temperature?: number;
  observedAt?: string;
  distanceMi?: number;
  bearing?: string;
  reporting: boolean;
}

async function lookup(id: string): Promise<StationInfo> {
  const stationId = id.trim().toUpperCase();
  try {
    const r = await fetch(`https://api.weather.com/v2/pws/observations/current?stationId=${encodeURIComponent(stationId)}&format=json&units=e&apiKey=${WUNDERGROUND_API_KEY}`, { signal: AbortSignal.timeout(10000) });
    const obs = r.ok && r.status !== 204 ? parsePwsObservation(await r.json(), false) : null;
    if (!obs) return { stationId, reporting: false };
    return { stationId, wuArea: obs.neighborhood, lat: obs.lat, lon: obs.lon, elevationFt: obs.elevationFt, temperature: obs.temperature, observedAt: obs.observedAt, reporting: true };
  } catch {
    return { stationId, reporting: false };
  }
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const lookupId = sp.get('lookup');
  const near = sp.get('near');

  if ((lookupId || near) && !WUNDERGROUND_API_KEY) {
    return NextResponse.json({ error: 'WUNDERGROUND_API_KEY is not set in .env' }, { status: 400 });
  }

  if (lookupId) {
    const info = await lookup(lookupId);
    return NextResponse.json(info, { status: info.reporting ? 200 : 404 });
  }

  if (near) {
    const [lat, lon] = near.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return NextResponse.json({ error: 'near must be "lat,lon"' }, { status: 400 });
    try {
      const r = await fetch(`https://api.weather.com/v3/location/near?geocode=${lat},${lon}&product=pws&format=json&apiKey=${WUNDERGROUND_API_KEY}`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return NextResponse.json({ error: `Weather Underground answered ${r.status}` }, { status: 502 });
      const ids: string[] = ((await r.json())?.location?.stationId || []).slice(0, 12);
      const stations = await Promise.all(ids.map(lookup));
      for (const s of stations) {
        if (s.lat !== undefined && s.lon !== undefined) {
          const d = distanceAndBearing({ lat, lon }, { lat: s.lat, lon: s.lon });
          s.distanceMi = d.miles;
          s.bearing = d.bearing;
        }
      }
      return NextResponse.json({ stations });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }

  const places = loadPlaces();
  const home = homePlace(places);
  return NextResponse.json({ places, home: home ? { lat: home.lat, lon: home.lon, elevationFt: home.elevationFt } : null, wuKeySet: !!WUNDERGROUND_API_KEY });
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    if (!Array.isArray(body?.places)) return NextResponse.json({ error: 'places must be an array' }, { status: 400 });
    const saved = savePlaces(body.places);
    return NextResponse.json({ places: saved });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
