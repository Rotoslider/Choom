'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Eye, Image as ImageIcon, Crop, UserCheck, RotateCcw, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// Mirrors GlassCameraState in lib/glass-camera.ts.
interface Control { value: number; min?: number; max?: number; step?: number; default?: number; options?: number[] }
interface CameraState {
  camera: string | null;
  streaming: boolean;
  face: boolean;
  looking: boolean;
  gaze: number | null;
  settings: { enabled: boolean; chooms: boolean; eye_contact: boolean; yaw_limit: number; welcome: boolean; welcome_minutes: number };
  controls: Record<string, Control> | null;
}

function SliderRow({ ctl, label, hint, disabled, onCommit }: { ctl?: Control; label: string; hint?: string; disabled?: boolean; onCommit: (v: number) => void }) {
  const [v, setV] = useState(ctl?.value ?? 0);
  useEffect(() => { if (ctl) setV(ctl.value); }, [ctl?.value]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ctl) return null;
  return (
    <div className={disabled ? 'opacity-50' : ''}>
      <div className="flex items-center justify-between">
        <label className="text-xs text-muted-foreground">{label}</label>
        <span className="text-xs tabular-nums text-muted-foreground">{v}</span>
      </div>
      <Slider
        value={[v]} min={ctl.min ?? 0} max={ctl.max ?? 255} step={ctl.step || 1} disabled={disabled}
        onValueChange={(x) => setV(x[0])}
        onValueCommit={(x) => onCommit(x[0])}
      />
      {hint && <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

function SwitchRow({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <div className={disabled ? 'opacity-50' : ''}>
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm">{label}</span>
        <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
      </div>
      {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

/**
 * Settings → Camera: the camera on top of the Looking Glass (an MX Brio run by the hologram on the
 * NUC, not Home Assistant). A live preview for positioning it, whether the Chooms may look through it,
 * its picture adjustments, and eye contact / welcome back. Everything is kept on the NUC.
 */
export function CameraSettings() {
  const [state, setState] = useState<CameraState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [marker, setMarker] = useState(true);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const busy = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/hologram/camera', { cache: 'no-store' });
      const data = await res.json();
      if (data.ok && data.state) { setState(data.state); setError(null); }
      else setError(data.error || 'The glass camera is not answering.');
    } catch {
      setError('Could not reach the glass camera.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // The preview: a fresh frame about twice a second while it's on and the tab is visible.
  useEffect(() => {
    if (!live || !state?.settings.enabled) return;
    let stop = false;
    let url: string | null = null;
    const tick = async () => {
      if (stop || busy.current || document.hidden) return;
      busy.current = true;
      try {
        const res = await fetch(`/api/hologram/camera/frame?width=960&overlay=${marker ? 1 : 0}`, { cache: 'no-store' });
        if (res.ok) {
          const next = URL.createObjectURL(await res.blob());
          if (url) URL.revokeObjectURL(url);
          url = next;
          setFrameUrl(next);
          setFrameError(null);
        } else {
          const data = await res.json().catch(() => ({}));
          setFrameError(data.error || 'No picture right now.');
        }
      } catch {
        setFrameError('No picture right now.');
      } finally {
        busy.current = false;
      }
    };
    tick();
    const frames = setInterval(tick, 500);
    const status = setInterval(load, 3000);
    return () => { stop = true; clearInterval(frames); clearInterval(status); if (url) URL.revokeObjectURL(url); };
  }, [live, marker, state?.settings.enabled, load]);

  const change = async (body: Record<string, unknown>) => {
    try {
      const res = await fetch('/api/hologram/camera', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok && data.state) { setState(data.state); setError(null); }
      else setError(data.error || 'The change did not take.');
    } catch {
      setError('Could not reach the glass camera.');
    }
  };
  const setting = (key: keyof CameraState['settings'], value: boolean | number) => {
    setState((s) => (s ? { ...s, settings: { ...s.settings, [key]: value } } : s));
    change({ [key]: value });
  };
  const control = (name: string, value: number) => {
    setState((s) => (s && s.controls ? { ...s, controls: { ...s.controls, [name]: { ...s.controls[name], value } } } : s));
    change({ controls: { [name]: value } });
  };

  const c = state?.controls ?? {};
  const s = state?.settings;
  const has = (name: string) => !!c[name];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Camera className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Glass camera</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          The camera on top of the Looking Glass. It runs on the NUC with the hologram (not Home Assistant):
          it gives the Chooms eye contact and the welcome back, and they can take a snapshot with it when you allow it.
          Pictures are never stored unless a Choom takes a snapshot.
        </p>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 p-3 text-sm">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={load} className="gap-1"><RefreshCw className="h-3.5 w-3.5" />Retry</Button>
        </div>
      )}

      {state && s && (
        <>
          {/* Preview */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">Preview</h3>
              </div>
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <label className="flex items-center gap-2">Live <Switch checked={live} onCheckedChange={setLive} /></label>
                <label className="flex items-center gap-2">Face marker <Switch checked={marker} onCheckedChange={setMarker} /></label>
              </div>
            </div>
            <div className="relative w-full overflow-hidden rounded-md border border-border bg-black aspect-video">
              {s.enabled && frameUrl && live
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={frameUrl} alt="What the glass camera sees" className="h-full w-full object-contain" />
                : <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                    {!s.enabled ? 'The camera is turned off.' : !live ? 'Preview paused.' : (frameError || 'Waiting for a picture…')}
                  </div>}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{state.camera ? `Camera: ${state.camera}` : 'No camera found'}</span>
              <span>{state.face ? 'Sees you' : 'Nobody in view'}</span>
              <span className={state.looking ? 'text-green-500' : ''}>{state.looking ? 'You are looking at the glass' : 'Not looking at the glass'}</span>
              {state.gaze !== null && <span>Gaze {state.gaze > 0 ? '+' : ''}{state.gaze}°</span>}
            </div>
            <p className="text-xs text-muted-foreground">
              For eye contact, aim it so your face sits near the middle when you look at the glass; the marker turns green when it counts you as looking.
            </p>
          </div>

          {/* The camera itself */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Camera className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Camera</h3>
            </div>
            <SwitchRow
              checked={s.enabled} onChange={(v) => setting('enabled', v)} label="Camera on"
              hint="Off lets go of the camera completely, which also turns its light off; eye contact and the welcome back stop until it's on again. The MX Brio's light has no separate switch on Linux, so this is the way to darken it (or a dot of tape over the light)."
            />
            <SwitchRow
              checked={s.chooms} onChange={(v) => setting('chooms', v)} label="Chooms can look through this camera"
              hint={'They ask for the "glass" camera with the same tool they use for the Reolink and shop cameras, take a snapshot and can analyze it. Snapshots are kept 72 hours, like their other camera snapshots.'}
            />
          </div>

          {/* Framing */}
          {(has('field_of_view') || has('zoom')) && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Crop className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">Framing</h3>
              </div>
              {has('field_of_view') && (
                <div>
                  <label className="text-xs text-muted-foreground">Field of view</label>
                  <Select value={String(c.field_of_view.value)} onValueChange={(v) => control('field_of_view', Number(v))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(c.field_of_view.options ?? [65, 78, 90]).map((d) => (
                        <SelectItem key={d} value={String(d)}>{d}°{d === 90 ? ' (widest)' : d === 65 ? ' (closest, your face bigger)' : ''}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground mt-1">A narrower view makes your face bigger in the picture, which helps eye contact from farther back.</p>
                </div>
              )}
              <SliderRow ctl={c.zoom} onCommit={(v) => control('zoom', v)} label="Zoom" hint="Digital zoom. Pan and tilt move the zoomed picture around." />
              <SliderRow ctl={c.pan} onCommit={(v) => control('pan', v)} label="Pan (left / right)" disabled={(c.zoom?.value ?? 100) <= 100} />
              <SliderRow ctl={c.tilt} onCommit={(v) => control('tilt', v)} label="Tilt (up / down)" disabled={(c.zoom?.value ?? 100) <= 100} />
            </div>
          )}

          {/* Picture */}
          {state.controls && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <ImageIcon className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">Picture</h3>
              </div>
              <SliderRow ctl={c.brightness} onCommit={(v) => control('brightness', v)} label="Brightness" />
              <SliderRow ctl={c.contrast} onCommit={(v) => control('contrast', v)} label="Contrast" />
              <SliderRow ctl={c.saturation} onCommit={(v) => control('saturation', v)} label="Color" />
              <SliderRow ctl={c.sharpness} onCommit={(v) => control('sharpness', v)} label="Sharpness" />
              {has('backlight_compensation') && (
                <SwitchRow checked={c.backlight_compensation.value === 1} onChange={(v) => control('backlight_compensation', v ? 1 : 0)}
                  label="Backlight compensation" hint="Brightens your face when a bright window is behind you." />
              )}
              {has('exposure_auto') && (
                <SwitchRow checked={c.exposure_auto.value !== 1} onChange={(v) => control('exposure_auto', v ? 3 : 1)} label="Automatic exposure" />
              )}
              <SliderRow ctl={c.exposure} onCommit={(v) => control('exposure', v)} label="Exposure" disabled={(c.exposure_auto?.value ?? 3) !== 1} />
              {has('white_balance_auto') && (
                <SwitchRow checked={c.white_balance_auto.value === 1} onChange={(v) => control('white_balance_auto', v ? 1 : 0)} label="Automatic white balance" />
              )}
              <SliderRow ctl={c.white_balance_temperature} onCommit={(v) => control('white_balance_temperature', v)} label="White balance (K)" disabled={(c.white_balance_auto?.value ?? 1) === 1} />
              {has('focus_auto') && (
                <SwitchRow checked={c.focus_auto.value === 1} onChange={(v) => control('focus_auto', v ? 1 : 0)} label="Autofocus" />
              )}
              <SliderRow ctl={c.focus} onCommit={(v) => control('focus', v)} label="Focus" disabled={(c.focus_auto?.value ?? 1) === 1} />
              {has('power_line_frequency') && (
                <div>
                  <label className="text-xs text-muted-foreground">Anti-flicker (lights)</label>
                  <Select value={String(c.power_line_frequency.value)} onValueChange={(v) => control('power_line_frequency', Number(v))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Off</SelectItem>
                      <SelectItem value="1">50 Hz</SelectItem>
                      <SelectItem value="2">60 Hz (US)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <Button variant="outline" size="sm" className="gap-1" onClick={() => change({ reset_controls: true })}>
                <RotateCcw className="h-3.5 w-3.5" /> Reset picture and framing
              </Button>
            </div>
          )}

          {/* Eye contact and welcome back */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <UserCheck className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Eye contact and welcome back</h3>
            </div>
            <SwitchRow checked={s.eye_contact} onChange={(v) => setting('eye_contact', v)} label="Eye contact"
              hint="The Choom on the glass turns to you when you look at her." disabled={!s.enabled} />
            <div className={!s.enabled || !s.eye_contact ? 'opacity-50' : ''}>
              <div className="flex items-center justify-between">
                <label className="text-xs text-muted-foreground">How wide counts as looking at the glass</label>
                <span className="text-xs tabular-nums text-muted-foreground">±{s.yaw_limit}°</span>
              </div>
              <Slider value={[s.yaw_limit]} min={2} max={20} step={1} disabled={!s.enabled || !s.eye_contact}
                onValueChange={(x) => setState((st) => (st ? { ...st, settings: { ...st.settings, yaw_limit: x[0] } } : st))}
                onValueCommit={(x) => setting('yaw_limit', x[0])} />
              <p className="text-[11px] text-muted-foreground mt-1">Measured at your desk: the glass is within about 3°, your monitors start around 9°. Wider catches glances; narrower avoids the monitors.</p>
            </div>
            <SwitchRow checked={s.welcome} onChange={(v) => setting('welcome', v)} label="Welcome back"
              hint="When you sit down after a while away, the Choom you last talked with welcomes you back." disabled={!s.enabled} />
            <div className={!s.enabled || !s.welcome ? 'opacity-50' : ''}>
              <div className="flex items-center justify-between">
                <label className="text-xs text-muted-foreground">Away at least</label>
                <span className="text-xs tabular-nums text-muted-foreground">{s.welcome_minutes} min</span>
              </div>
              <Slider value={[s.welcome_minutes]} min={5} max={120} step={5} disabled={!s.enabled || !s.welcome}
                onValueChange={(x) => setState((st) => (st ? { ...st, settings: { ...st.settings, welcome_minutes: x[0] } } : st))}
                onValueCommit={(x) => setting('welcome_minutes', x[0])} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
