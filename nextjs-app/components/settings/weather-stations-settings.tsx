'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Radio, Search, Plus, Trash2, Save, RefreshCw, AlertTriangle, Eye } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

// Mirrors NamedPlace in lib/weather-places.ts (the shape of data/weather-places.json).
interface Place {
  name: string;
  aliases: string[];
  lat: number;
  lon: number;
  elevationFt?: number;
  pwsStationId?: string;
  note?: string;
  watch?: boolean;
  /** UI only: the aliases box's raw text, so a typed comma isn't eaten mid-edit. */
  aliasText?: string;
}

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

const fmtFt = (n?: number) => (n === undefined ? '?' : `${Math.round(n).toLocaleString()} ft`);

// A station whose reported elevation is far below its neighbours but lands
// among them once read as meters — some owners type meters into WU
// (KNMANIMA27 said "1,288 ft" in a 4,100 ft valley).
function metersSuspect(elev: number | undefined, typical: number | undefined): number | null {
  if (elev === undefined || typical === undefined || typical - elev < 2000) return null;
  const asFeet = elev * 3.2808;
  return Math.abs(asFeet - typical) < 1500 ? Math.round(asFeet) : null;
}

export function WeatherStationsSettings() {
  const [places, setPlaces] = useState<Place[]>([]);
  const [wuKeySet, setWuKeySet] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const [addId, setAddId] = useState('');
  const [adding, setAdding] = useState(false);

  const [nearFrom, setNearFrom] = useState('0');
  const [nearCustom, setNearCustom] = useState('');
  const [nearResults, setNearResults] = useState<StationInfo[] | null>(null);
  const [searching, setSearching] = useState(false);

  const load = async () => {
    try {
      const res = await fetch('/api/weather/stations');
      const data = await res.json();
      const loaded: Place[] = data.places || [];
      setPlaces(loaded);
      const homeIdx = loaded.findIndex(p => p.aliases.includes('home'));
      if (homeIdx >= 0) setNearFrom(String(homeIdx));
      setWuKeySet(!!data.wuKeySet);
      setDirty(false);
    } catch {
      setStatus({ ok: false, text: 'Could not load weather stations' });
    }
  };
  useEffect(() => { load(); }, []);

  const update = (i: number, patch: Partial<Place>) => {
    setPlaces(prev => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));
    setDirty(true);
    setStatus(null);
  };
  const remove = (i: number) => {
    setPlaces(prev => prev.filter((_, j) => j !== i));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/weather/stations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ places }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setPlaces(data.places);
      setDirty(false);
      setStatus({ ok: true, text: 'Saved — the Chooms use it on their next weather call' });
    } catch (e) {
      setStatus({ ok: false, text: `Save failed: ${e instanceof Error ? e.message : e}` });
    } finally {
      setSaving(false);
    }
  };

  const hasStation = (id: string) => places.some(p => p.pwsStationId?.toUpperCase() === id.toUpperCase());

  const addStation = (s: StationInfo, name?: string) => {
    if (s.lat === undefined || s.lon === undefined) return;
    setPlaces(prev => [...prev, {
      name: name || `${s.wuArea || 'Station'} ${s.stationId}`,
      aliases: [],
      lat: s.lat!,
      lon: s.lon!,
      ...(s.elevationFt !== undefined && { elevationFt: s.elevationFt }),
      pwsStationId: s.stationId,
      watch: true,
    }]);
    setDirty(true);
    setStatus(null);
  };

  const addById = async () => {
    const id = addId.trim().toUpperCase();
    if (!id) return;
    if (hasStation(id)) { setStatus({ ok: false, text: `${id} is already in the list` }); return; }
    setAdding(true);
    try {
      const res = await fetch(`/api/weather/stations?lookup=${encodeURIComponent(id)}`);
      const data: StationInfo & { error?: string } = await res.json();
      if (!res.ok || !data.reporting) throw new Error(data.error || `${id} not found or not reporting`);
      addStation(data);
      setAddId('');
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setAdding(false);
    }
  };

  const nearOrigins = useMemo(() => {
    const opts: Array<{ key: string; label: string; lat: number; lon: number }> = [];
    places.forEach((p, i) => opts.push({ key: String(i), label: p.name, lat: p.lat, lon: p.lon }));
    return opts;
  }, [places]);

  const findNear = async () => {
    let lat: number | undefined, lon: number | undefined;
    if (nearFrom === 'custom') {
      [lat, lon] = nearCustom.split(',').map(s => parseFloat(s.trim()));
    } else {
      const o = nearOrigins.find(x => x.key === nearFrom);
      lat = o?.lat; lon = o?.lon;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      setStatus({ ok: false, text: 'Pick a place, or enter coordinates as "lat, lon"' });
      return;
    }
    setSearching(true);
    setNearResults(null);
    try {
      const res = await fetch(`/api/weather/stations?near=${lat},${lon}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setNearResults(data.stations || []);
    } catch (e) {
      setStatus({ ok: false, text: `Search failed: ${e instanceof Error ? e.message : e}` });
    } finally {
      setSearching(false);
    }
  };

  const nearTypicalElev = useMemo(() => {
    const e = (nearResults || []).map(s => s.elevationFt).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
    return e.length ? e[Math.floor(e.length / 2)] : undefined;
  }, [nearResults]);

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium flex items-center gap-2">
        <Radio className="h-4 w-4" />
        Weather Stations
      </h3>
      <p className="text-xs text-muted-foreground">
        Weather Underground stations the Chooms know by name. <strong>What you call it</strong> lets them match
        &ldquo;camp&rdquo; or &ldquo;the house&rdquo; to a station. <strong>Local roundup</strong> puts a station in
        the area check — &ldquo;who got rain last night?&rdquo;, &ldquo;how windy is it in the valley?&rdquo;.
        For a one-off (a station near a campsite), just give a Choom the station ID — it doesn&apos;t need to be here.
      </p>
      {!wuKeySet && (
        <p className="text-xs text-amber-500 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" /> WUNDERGROUND_API_KEY is not set in .env — station lookups won&apos;t work.
        </p>
      )}

      {/* Saved stations */}
      <div className="space-y-3">
        {places.map((p, i) => (
          <div key={i} className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Input
                value={p.name}
                onChange={e => update(i, { name: e.target.value })}
                placeholder="Name, e.g. Rodeo Airport"
                className="flex-1"
              />
              <Button variant="ghost" size="icon" onClick={() => remove(i)} title="Remove">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Station ID</label>
                <Input
                  value={p.pwsStationId || ''}
                  onChange={e => update(i, { pwsStationId: e.target.value.toUpperCase() })}
                  placeholder="e.g. KNMRODEO32 (optional)"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Elevation (ft)</label>
                <Input
                  type="number"
                  value={p.elevationFt ?? ''}
                  onChange={e => update(i, { elevationFt: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">What you call it (comma-separated)</label>
              <Input
                value={p.aliasText ?? p.aliases.join(', ')}
                onChange={e => update(i, { aliasText: e.target.value, aliases: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                placeholder="e.g. camp, rustler park — leave empty for roundup-only stations"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Note for the Chooms</label>
              <Input
                value={p.note || ''}
                onChange={e => update(i, { note: e.target.value })}
                placeholder="e.g. at the Rodeo airstrip, valley floor"
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {p.lat.toFixed(4)}, {p.lon.toFixed(4)}
              </span>
              <label className="flex items-center gap-2 text-xs">
                <Eye className="h-3 w-3" /> Local roundup
                <Switch checked={!!p.watch} onCheckedChange={v => update(i, { watch: v })} />
              </label>
            </div>
          </div>
        ))}
        {places.length === 0 && <p className="text-xs text-muted-foreground">No stations yet.</p>}
      </div>

      {/* Add by ID */}
      <div className="flex gap-2">
        <Input
          value={addId}
          onChange={e => setAddId(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addById(); }}
          placeholder="Add a station by ID, e.g. KNMRODEO31"
        />
        <Button variant="outline" onClick={addById} disabled={adding || !addId.trim()}>
          {adding ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </Button>
      </div>

      {/* Find near */}
      <div className="space-y-2 rounded-lg border p-3">
        <label className="text-xs text-muted-foreground">Find stations near…</label>
        <div className="flex gap-2">
          <select
            value={nearFrom}
            onChange={e => setNearFrom(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm flex-1 min-w-0"
          >
            {nearOrigins.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            <option value="custom">Coordinates…</option>
          </select>
          <Button variant="outline" onClick={findNear} disabled={searching}>
            {searching ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          </Button>
        </div>
        {nearFrom === 'custom' && (
          <Input value={nearCustom} onChange={e => setNearCustom(e.target.value)} placeholder="lat, lon — e.g. 31.9028, -109.2779" />
        )}
        {nearResults && (
          <div className="space-y-1 pt-1">
            <p className="text-xs text-muted-foreground">
              Area names are post-office towns (&ldquo;San Simon&rdquo; runs from the valley to the crest) — go by elevation.
            </p>
            {nearResults.map(s => {
              const meters = metersSuspect(s.elevationFt, nearTypicalElev);
              return (
                <div key={s.stationId} className="flex items-center gap-2 text-xs py-1 border-b last:border-b-0">
                  <div className="flex-1 min-w-0">
                    <div className="font-mono">{s.stationId}</div>
                    <div className="text-muted-foreground truncate">
                      {s.reporting
                        ? <>{fmtFt(s.elevationFt)} · {s.distanceMi} mi {s.bearing} · {s.wuArea} · {s.temperature}°F</>
                        : 'not reporting'}
                    </div>
                    {meters && (
                      <div className="text-amber-500 flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" /> elevation looks like meters (≈{meters.toLocaleString()} ft)
                      </div>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!s.reporting || hasStation(s.stationId)}
                    onClick={() => addStation(meters ? { ...s, elevationFt: meters } : s)}
                  >
                    {hasStation(s.stationId) ? 'Added' : 'Add'}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={!dirty || saving} className="flex-1">
          {saving ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
          Save stations
        </Button>
        {dirty && <Button variant="outline" onClick={load}>Discard</Button>}
      </div>
      {status && (
        <p className={`text-xs ${status.ok ? 'text-green-500' : 'text-red-500'}`}>{status.text}</p>
      )}
    </div>
  );
}
