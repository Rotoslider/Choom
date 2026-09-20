/**
 * printer-monitor — a read-only window onto the Qidi 3D printer through its
 * Moonraker API (Klipper). Built 2026-09-20 from the girls' own spec: "the
 * skill is never allowed to issue a POST, or any command that changes state".
 *
 * That rule is structural here, not a promise: the only network call in this
 * file is `moonrakerGet`, which hard-codes method GET and refuses any path
 * outside ALLOWED_PATHS. There is no code path that could send G-code, restart
 * firmware, or touch a setting.
 *
 * Endpoints verified against the printer (host "mkspi", QIDIStudio slicer):
 *   /server/info, /printer/info, /printer/objects/query?<obj>&<obj>…,
 *   /server/history/list, /server/files/list, /server/files/metadata,
 *   /server/webcams/list, /server/job_queue/status, and the webcam snapshot.
 * Two paths the girls guessed are WRONG on Moonraker and were the source of
 * Aloy's 404s: `/printer/queue/status` does not exist (it is
 * /server/job_queue/status) and `?targets=a,b` returns nulls (objects are
 * passed as bare query keys: `?print_stats&extruder`).
 */
import { BaseSkillHandler, type SkillHandlerContext } from '@/lib/skill-handler';
import { WorkspaceService } from '@/lib/workspace-service';
import { WORKSPACE_ROOT } from '@/lib/config';
import prisma from '@/lib/db';
import type { ToolCall, ToolResult } from '@/lib/types';

const TOOL_NAMES = new Set(['printer_status', 'printer_job_history', 'printer_files', 'printer_camera_snapshot']);

export const PRINTER_URL = (process.env.MOONRAKER_URL || 'http://192.168.1.139').replace(/\/+$/, '');
const TIMEOUT_MS = 8000;

/** Every path this skill may ever request. Anything else is refused before a socket opens. */
export const ALLOWED_PATHS: RegExp[] = [
  /^\/server\/info$/,
  /^\/printer\/info$/,
  /^\/printer\/objects\/list$/,
  /^\/printer\/objects\/query\?[\w%&.=-]*$/,
  /^\/server\/history\/list(\?[\w&=]*)?$/,
  /^\/server\/files\/list(\?[\w&=]*)?$/,
  /^\/server\/files\/metadata\?filename=[^\s]*$/,
  /^\/server\/webcams\/list$/,
  /^\/server\/job_queue\/status$/,
  /^\/webcam\d*\/\?action=snapshot$/,
];

export function isAllowedPath(p: string): boolean {
  return ALLOWED_PATHS.some(re => re.test(p));
}

class PrinterUnreachable extends Error {}

/**
 * The ONLY network call in this skill. GET, fixed timeout, allowlisted path,
 * one retry on a transient failure (the printer's little board drops the odd
 * request). Never leaks "ECONNREFUSED" into an error — the chat loop reads
 * that token as a configuration error and disables the tool for the turn.
 */
export async function moonrakerGet(path: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (!isAllowedPath(path)) {
    throw new Error(`printer-monitor refused "${path}": not on the read-only allowlist. This skill can only look at the printer.`);
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(`${PRINTER_URL}${path}`, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status >= 500 && attempt === 0) { lastErr = new Error(`HTTP ${res.status}`); await new Promise(r => setTimeout(r, 1000)); continue; }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
    }
  }
  const why = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new PrinterUnreachable(`The printer at ${PRINTER_URL} did not answer (${why.replace(/ECONNREFUSED|ECONNRESET/g, 'connection dropped')}). It may be powered off, asleep, or off the network — the Home Assistant power reading will tell you which.`);
}

async function getJson<T = unknown>(path: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  const res = await moonrakerGet(path, fetchImpl);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Printer API ${res.status} for ${path.split('?')[0]}${body ? `: ${body.slice(0, 160).replace(/\s+/g, ' ')}` : ''}`);
  }
  const data = await res.json() as { result?: T; error?: { message?: string } };
  if (data.error) throw new Error(`Printer API error: ${data.error.message || 'unknown'}`);
  return data.result as T;
}

// ---------------------------------------------------------------------------
// Formatting helpers (pure — unit-tested)
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const r1 = (v: number) => Math.round(v * 10) / 10;

export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

const localTime = (epoch: number) => new Date(epoch * 1000).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const cleanName = (f: string) => f.replace(/^\.cache\//, '');

export interface StatusInputs {
  status: Obj;                 // /printer/objects/query result.status
  serverInfo?: Obj | null;     // /server/info result
  metadata?: Obj | null;       // /server/files/metadata result for the current file
}

/** Build the structured status + human summary from raw Moonraker objects. */
export function buildStatus(inp: StatusInputs) {
  const st = inp.status;
  const ps = (st.print_stats || {}) as Obj;
  const info = (ps.info || {}) as Obj;
  const vsd = (st.virtual_sdcard || {}) as Obj;
  const disp = (st.display_status || {}) as Obj;
  const ext = (st.extruder || {}) as Obj;
  const bed = (st.heater_bed || {}) as Obj;
  const chamber = (st['heater_generic chamber'] || null) as Obj | null;
  const chamberSensor = (st['temperature_sensor Chamber_Thermal_Protection_Sensor'] || null) as Obj | null;
  const mcuTemp = (st['temperature_sensor GD32'] || null) as Obj | null;
  const th = (st.toolhead || {}) as Obj;
  const hooks = (st.webhooks || {}) as Obj;
  const fila = (st['filament_switch_sensor fila'] || null) as Obj | null;
  const width = (st.hall_filament_width_sensor || null) as Obj | null;
  const fans: Record<string, number> = {};
  for (const [k, v] of Object.entries(st)) {
    if (/^(fan|fan_generic |chamber_fan |heater_fan |controller_fan )/.test(k) && v && typeof v === 'object' && 'speed' in (v as Obj)) {
      fans[k.replace(/^\w+ /, '')] = Math.round(num((v as Obj).speed) * 100);
    }
  }

  const state = String(ps.state || 'unknown');
  const filename = String(ps.filename || '');
  const printing = state === 'printing' || state === 'paused';
  const progress = num(disp.progress, num(vsd.progress));
  const pct = Math.round(progress * 100);
  const printDuration = num(ps.print_duration);
  const curLayer = num(info.current_layer, -1); const totLayer = num(info.total_layer, -1);
  const meta = inp.metadata || null;
  const estTotal = meta ? num(meta.estimated_time) : 0;
  let remaining: number | null = null; let remainingBasis = '';
  if (printing) {
    if (estTotal > 0) { remaining = Math.max(0, estTotal - printDuration); remainingBasis = 'slicer estimate'; }
    else if (progress > 0.02) { remaining = printDuration * (1 / progress - 1); remainingBasis = 'file progress'; }
  }
  const filamentUsedMm = num(ps.filament_used);
  const filamentTotalMm = meta ? num(meta.filament_total) : 0;
  const filamentWeightG = meta ? num(meta.filament_weight_total) : 0;
  const usedG = filamentTotalMm > 0 && filamentWeightG > 0 ? r1(filamentUsedMm / filamentTotalMm * filamentWeightG) : null;
  const pos = Array.isArray(th.position) ? (th.position as number[]) : [];
  const zNow = pos.length >= 3 ? r1(num(pos[2])) : null;
  const objectHeight = meta ? num(meta.object_height) : 0;

  const warnings = Array.isArray(inp.serverInfo?.warnings) ? (inp.serverInfo!.warnings as string[]) : [];
  const failed = inp.serverInfo?.failed_components && typeof inp.serverInfo.failed_components === 'object'
    ? Object.keys(inp.serverInfo.failed_components as Obj) : [];
  const klipperState = String(hooks.state || inp.serverInfo?.klippy_state || 'unknown');

  const structured = {
    state, message: String(ps.message || ''),
    file: filename ? cleanName(filename) : null,
    progress_percent: pct,
    layer: curLayer >= 0 && totLayer > 0 ? { current: curLayer, total: totLayer } : null,
    time_printing_s: Math.round(printDuration),
    time_remaining_s: remaining !== null ? Math.round(remaining) : null,
    time_remaining_basis: remainingBasis || null,
    slicer_estimate_s: estTotal || null,
    temperatures: {
      extruder: { actual: r1(num(ext.temperature)), target: r1(num(ext.target)), power_percent: Math.round(num(ext.power) * 100) },
      bed: { actual: r1(num(bed.temperature)), target: r1(num(bed.target)), power_percent: Math.round(num(bed.power) * 100) },
      ...(chamber && { chamber: { actual: r1(num(chamber.temperature)), target: r1(num(chamber.target)), power_percent: Math.round(num(chamber.power) * 100) } }),
      ...(chamberSensor && { chamber_sensor: r1(num(chamberSensor.temperature)) }),
      ...(mcuTemp && { mainboard: r1(num(mcuTemp.temperature)) }),
    },
    fans_percent: fans,
    filament: {
      detected: fila ? Boolean(fila.filament_detected) : null,
      width_mm: width && width.is_active ? r1(num(width.Diameter)) : null,
      used_m: r1(filamentUsedMm / 1000),
      used_g: usedG,
      type: meta ? String(meta.filament_type || '') || null : null,
      name: meta ? String(meta.filament_name || '') || null : null,
    },
    z_height_mm: zNow,
    object_height_mm: objectHeight || null,
    homed_axes: String(th.homed_axes || ''),
    klipper_state: klipperState,
    klipper_message: String(hooks.state_message || ''),
    warnings, failed_components: failed,
  };

  // Human summary — what any of them needs to answer "how's she doing?"
  const lines: string[] = [];
  const stateWord: Record<string, string> = { printing: 'PRINTING', paused: 'PAUSED', complete: 'FINISHED', cancelled: 'CANCELLED', error: 'ERROR', standby: 'idle' };
  lines.push(`Printer: ${stateWord[state] || state}${structured.file ? ` — ${structured.file}` : ''}${structured.message ? ` (${structured.message})` : ''}`);
  if (printing || state === 'complete') {
    let p = `Progress: ${pct}%`;
    if (structured.layer) p += `, layer ${structured.layer.current} of ${structured.layer.total}`;
    // Only while printing: after a job the head parks high (Z 200 on a 43 mm
    // part), and QIDIStudio's object_height is not the part height either.
    if (printing && zNow !== null) p += `, Z ${zNow} mm`;
    lines.push(p);
    let t = `Time: ${fmtDuration(printDuration)} printed`;
    if (remaining !== null) t += `, about ${fmtDuration(remaining)} left (${remainingBasis})`;
    else if (estTotal) t += ` of ~${fmtDuration(estTotal)} estimated`;
    lines.push(t);
  }
  const T = structured.temperatures;
  let temps = `Temps: extruder ${T.extruder.actual}°C` + (T.extruder.target ? `/${T.extruder.target}°C (${T.extruder.power_percent}% power)` : ' (heater off)');
  temps += `, bed ${T.bed.actual}°C` + (T.bed.target ? `/${T.bed.target}°C` : ' (off)');
  if (T.chamber) temps += `, chamber ${T.chamber.actual}°C` + (T.chamber.target ? `/${T.chamber.target}°C` : ' (heater off)');
  lines.push(temps);
  const fanBits = Object.entries(fans).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}%`);
  if (fanBits.length) lines.push(`Fans: ${fanBits.join(', ')}`);
  let fil = `Filament: ${structured.filament.detected === null ? 'sensor n/a' : structured.filament.detected ? 'loaded' : 'NOT DETECTED — runout?'}`;
  if (structured.filament.type) fil += `, ${structured.filament.type}`;
  if (filamentUsedMm > 0) fil += `, ${structured.filament.used_m} m used${usedG !== null ? ` (~${usedG} g)` : ''}`;
  lines.push(fil);
  lines.push(`Klipper: ${klipperState}${structured.klipper_message && structured.klipper_message !== 'Printer is ready' ? ` — ${structured.klipper_message}` : ''}${warnings.length ? `; warnings: ${warnings.join(' | ')}` : ''}${failed.length ? `; failed components: ${failed.join(', ')}` : ''}`);
  return { ...structured, formatted: lines.join('\n') };
}

export function buildHistory(jobs: Obj[]) {
  return jobs.map(j => {
    const start = num(j.start_time); const end = num(j.end_time);
    const meta = (j.metadata || {}) as Obj;
    return {
      job_id: String(j.job_id || ''),
      file: cleanName(String(j.filename || '')),
      status: String(j.status || ''),
      started: start ? localTime(start) : null,
      ended: end ? localTime(end) : null,
      print_time: fmtDuration(num(j.print_duration)),
      total_time: fmtDuration(num(j.total_duration)),
      filament_m: r1(num(j.filament_used) / 1000),
      filament_type: String(meta.filament_type || '') || null,
      estimated: num(meta.estimated_time) ? fmtDuration(num(meta.estimated_time)) : null,
    };
  });
}

// ---------------------------------------------------------------------------

const STATUS_OBJECTS = [
  'print_stats', 'virtual_sdcard', 'display_status', 'extruder', 'heater_bed', 'toolhead', 'webhooks', 'idle_timeout',
  'heater_generic chamber', 'temperature_sensor Chamber_Thermal_Protection_Sensor', 'temperature_sensor GD32',
  'filament_switch_sensor fila', 'hall_filament_width_sensor',
  'fan', 'fan_generic cooling_fan', 'fan_generic auxiliary_cooling_fan', 'chamber_fan chamber_fan', 'heater_fan hotend_fan',
];

export default class PrinterMonitorHandler extends BaseSkillHandler {
  constructor(private readonly fetchImpl: typeof fetch = fetch) { super(); }

  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      switch (toolCall.name) {
        case 'printer_status': return await this.status(toolCall);
        case 'printer_job_history': return await this.history(toolCall);
        case 'printer_files': return await this.files(toolCall);
        case 'printer_camera_snapshot': return await this.snapshot(toolCall, ctx);
        default: return this.error(toolCall, `Unknown printer tool: ${toolCall.name}`);
      }
    } catch (err) {
      return this.error(toolCall, err instanceof Error ? err.message : String(err));
    }
  }

  private async status(toolCall: ToolCall): Promise<ToolResult> {
    const q = STATUS_OBJECTS.map(o => encodeURIComponent(o).replace(/%20/g, '%20')).join('&');
    const [statusRes, serverInfo] = await Promise.all([
      getJson<{ status: Obj }>(`/printer/objects/query?${q}`, this.fetchImpl),
      getJson<Obj>('/server/info', this.fetchImpl).catch(() => null),
    ]);
    const status = statusRes.status || {};
    const filename = String(((status.print_stats || {}) as Obj).filename || '');
    let metadata: Obj | null = null;
    if (filename) {
      metadata = await getJson<Obj>(`/server/files/metadata?filename=${encodeURIComponent(filename)}`, this.fetchImpl).catch(() => null);
    }
    const built = buildStatus({ status, serverInfo, metadata });
    return this.success(toolCall, { success: true, printer: PRINTER_URL, ...built, message: built.formatted });
  }

  private async history(toolCall: ToolCall): Promise<ToolResult> {
    const limit = Math.min(25, Math.max(1, Math.round(Number(toolCall.arguments.limit) || 5)));
    const r = await getJson<{ count: number; jobs: Obj[] }>(`/server/history/list?limit=${limit}&order=desc`, this.fetchImpl);
    const jobs = buildHistory(r.jobs || []);
    const summary = jobs.length
      ? jobs.map(j => `${j.started || '?'}: ${j.file} — ${j.status}, ${j.print_time}${j.filament_m ? `, ${j.filament_m} m filament` : ''}`).join('\n')
      : 'No print history yet.';
    return this.success(toolCall, { success: true, count: jobs.length, jobs, message: summary });
  }

  private async files(toolCall: ToolCall): Promise<ToolResult> {
    const filename = typeof toolCall.arguments.filename === 'string' ? toolCall.arguments.filename.trim() : '';
    if (filename) {
      const m = await getJson<Obj>(`/server/files/metadata?filename=${encodeURIComponent(filename)}`, this.fetchImpl);
      const est = num(m.estimated_time);
      const info = {
        file: cleanName(filename), slicer: `${m.slicer || '?'} ${m.slicer_version || ''}`.trim(),
        estimated_time: est ? fmtDuration(est) : null, layer_height_mm: num(m.layer_height) || null,
        object_height_mm: num(m.object_height) || null,
        layers: num(m.layer_count) || null,
        filament: { type: String(m.filament_type || '') || null, name: String(m.filament_name || '') || null, length_m: r1(num(m.filament_total) / 1000), weight_g: r1(num(m.filament_weight_total)) },
        first_layer: { extruder_c: num(m.first_layer_extr_temp) || null, bed_c: num(m.first_layer_bed_temp) || null },
        nozzle_mm: num(m.nozzle_diameter) || null,
        size_mb: r1(num(m.size) / 1048576),
      };
      return this.success(toolCall, { success: true, ...info, message: `${info.file}: ~${info.estimated_time || '?'}${info.layers ? `, ${info.layers} layers` : ''}, ${info.object_height_mm ?? '?'} mm tall, ${info.filament.type || 'filament'} ${info.filament.length_m} m (${info.filament.weight_g} g)` });
    }
    const limit = Math.min(100, Math.max(1, Math.round(Number(toolCall.arguments.limit) || 20)));
    const list = await getJson<Obj[]>('/server/files/list?root=gcodes', this.fetchImpl);
    const files = (list || [])
      .filter(f => !String(f.path || '').startsWith('.plr/'))
      .sort((a, b) => num(b.modified) - num(a.modified))
      .slice(0, limit)
      .map(f => ({ path: String(f.path || ''), name: cleanName(String(f.path || '')), size_mb: r1(num(f.size) / 1048576), modified: localTime(num(f.modified)) }));
    return this.success(toolCall, { success: true, count: files.length, files, message: files.length ? files.map(f => `${f.modified}: ${f.name} (${f.size_mb} MB)`).join('\n') : 'No G-code files on the printer.' });
  }

  private async snapshot(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const cams = await getJson<{ webcams: Obj[] }>('/server/webcams/list', this.fetchImpl);
    const cam = (cams.webcams || []).find(c => c.enabled !== false) || null;
    const snapPath = cam && typeof cam.snapshot_url === 'string' && cam.snapshot_url.startsWith('/') ? cam.snapshot_url : '/webcam/?action=snapshot';
    const res = await moonrakerGet(snapPath, this.fetchImpl);
    if (!res.ok) return this.error(toolCall, `The printer camera answered ${res.status} — it may be disabled while idle. Try again during a print.`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) return this.error(toolCall, 'The printer camera returned an empty frame. Try again in a few seconds.');

    const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'America/Denver' }).replace(' ', '_').replace(/:/g, '');
    let savePath = typeof toolCall.arguments.save_path === 'string' && toolCall.arguments.save_path.trim()
      ? toolCall.arguments.save_path.trim() : `printer/snapshots/${stamp}.jpg`;
    if (!/\.(jpg|jpeg)$/i.test(savePath)) savePath = savePath.replace(/\/$/, '') + '.jpg';
    const { sessionFileCount } = ctx;
    if (sessionFileCount && sessionFileCount.created >= sessionFileCount.maxAllowed) {
      return this.error(toolCall, `Session file limit reached (${sessionFileCount.maxAllowed}). Cannot save more files.`);
    }
    const ws = new WorkspaceService(WORKSPACE_ROOT, 10 * 1024, ['.jpg', '.jpeg']);
    await ws.writeFileBuffer(savePath, buf, ['.jpg', '.jpeg']);
    if (sessionFileCount) sessionFileCount.created++;
    ctx.send?.({ type: 'file_created', path: savePath });

    let imageId: string | undefined;
    try {
      const dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
      const saved = await prisma.generatedImage.create({
        data: { choomId: ctx.choomId, prompt: 'Printer camera snapshot', imageUrl: dataUrl, settings: JSON.stringify({ source: 'printer_camera_snapshot', path: savePath }) },
      });
      imageId = saved.id;
      ctx.send?.({ type: 'image_generated', imageUrl: dataUrl, imageId: saved.id, prompt: 'Printer camera snapshot' });
    } catch (e) {
      console.warn('   ⚠️ Printer snapshot saved to disk but DB/UI display failed:', e instanceof Error ? e.message : e);
    }
    console.log(`   🖨️  Printer snapshot → ${savePath} (${(buf.length / 1024).toFixed(1)}KB)`);
    return this.success(toolCall, {
      success: true, file_path: savePath, size_kb: Math.round(buf.length / 1024), ...(imageId && { image_id: imageId }),
      message: `Saved a frame from the printer camera to ${savePath}. Use analyze_image with that path to look at the print.`,
    });
  }
}
