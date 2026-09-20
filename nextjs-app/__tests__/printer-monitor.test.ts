/**
 * printer-monitor — read-only Moonraker skill. Payloads captured from the Qidi
 * printer (host mkspi) on 2026-09-20, right after the eMeet speaker holder
 * finished.
 */
import PrinterMonitorHandler, { buildStatus, buildHistory, fmtDuration, isAllowedPath, moonrakerGet } from '@/skills/core/printer-monitor/handler';

const IDLE_STATUS = {
  print_stats: { filename: '.cache/rack emeet speaker holder.gcode', total_duration: 9527.5, print_duration: 9435.1, filament_used: 14744.5, state: 'complete', message: '', info: { total_layer: 216, current_layer: 215 } },
  virtual_sdcard: { file_path: null, progress: 1.0, is_active: false, file_position: 8430088, file_size: 8430088 },
  display_status: { progress: 1.0, message: 'Last File: rack emeet speaker holder.gcode' },
  extruder: { temperature: 75.5, target: 0.0, power: 0.0 },
  heater_bed: { temperature: 54.75, target: 0.0, power: 0.0 },
  'heater_generic chamber': { temperature: 47.53, target: 0.0, power: 0.0 },
  'temperature_sensor GD32': { temperature: 71.5 },
  'filament_switch_sensor fila': { filament_detected: true, enabled: true },
  hall_filament_width_sensor: { Diameter: 1.48, is_active: true },
  'fan_generic cooling_fan': { speed: 0.0 },
  toolhead: { homed_axes: 'xyz', position: [0, 0, 199.99, 135241.8] },
  webhooks: { state: 'ready', state_message: 'Printer is ready' },
};
const META = { estimated_time: 9033, object_height: 150.0, layer_height: 0.2, filament_type: 'ASA', filament_name: 'QIDI ASA @Qidi X-Plus 4 0.4 nozzle', filament_total: 14742.48, filament_weight_total: 37.94 };
const SERVER_INFO = { klippy_state: 'ready', warnings: [], failed_components: {} };

describe('buildStatus', () => {
  it('summarises a finished print', () => {
    const s = buildStatus({ status: IDLE_STATUS, serverInfo: SERVER_INFO, metadata: META });
    expect(s.state).toBe('complete');
    expect(s.file).toBe('rack emeet speaker holder.gcode');
    expect(s.progress_percent).toBe(100);
    expect(s.layer).toEqual({ current: 215, total: 216 });
    expect(s.temperatures.chamber).toEqual({ actual: 47.5, target: 0, power_percent: 0 });
    expect(s.filament.used_m).toBe(14.7);
    expect(s.filament.used_g).toBe(37.9);
    expect(s.filament.type).toBe('ASA');
    expect(s.time_remaining_s).toBeNull();
    expect(s.formatted).toContain('Printer: FINISHED — rack emeet speaker holder.gcode');
    expect(s.formatted).toContain('layer 215 of 216');
    expect(s.formatted).not.toMatch(/Z \d/); // parked head height is noise after a job
    expect(s.formatted).toContain('extruder 75.5°C (heater off)');
    expect(s.formatted).toContain('Filament: loaded, ASA, 14.7 m used (~37.9 g)');
    expect(s.formatted).toContain('Klipper: ready');
  });

  it('summarises a print in progress with time left from the slicer estimate', () => {
    const status = {
      ...IDLE_STATUS,
      print_stats: { ...IDLE_STATUS.print_stats, state: 'printing', print_duration: 5200, filament_used: 8000, info: { total_layer: 216, current_layer: 119 } },
      display_status: { progress: 0.62 },
      extruder: { temperature: 255.1, target: 255, power: 0.1 },
      heater_bed: { temperature: 90.2, target: 90, power: 0.3 },
      'fan_generic cooling_fan': { speed: 0.8 },
      toolhead: { homed_axes: 'xyz', position: [12, 30, 23.8, 900] },
    };
    const s = buildStatus({ status, serverInfo: SERVER_INFO, metadata: META });
    expect(s.state).toBe('printing');
    expect(s.progress_percent).toBe(62);
    expect(s.time_remaining_s).toBe(9033 - 5200);
    expect(s.time_remaining_basis).toBe('slicer estimate');
    expect(s.fans_percent).toEqual({ cooling_fan: 80 });
    expect(s.formatted).toContain('PRINTING');
    expect(s.formatted).toContain('layer 119 of 216, Z 23.8 mm');
    expect(s.formatted).toContain('1h 26m printed, about 1h 03m left (slicer estimate)');
    expect(s.formatted).toContain('extruder 255.1°C/255°C (10% power)');
    expect(s.formatted).toContain('Fans: cooling_fan 80%');
  });

  it('flags a filament runout and Klipper trouble loudly', () => {
    const status = { ...IDLE_STATUS, print_stats: { ...IDLE_STATUS.print_stats, state: 'paused' }, 'filament_switch_sensor fila': { filament_detected: false }, webhooks: { state: 'shutdown', state_message: 'MCU shutdown: heater extruder not heating' } };
    const s = buildStatus({ status, serverInfo: { warnings: ['Some warning'], failed_components: { timelapse: 'x' } }, metadata: null });
    expect(s.formatted).toContain('NOT DETECTED — runout?');
    expect(s.formatted).toContain('Klipper: shutdown — MCU shutdown');
    expect(s.formatted).toContain('warnings: Some warning');
    expect(s.formatted).toContain('failed components: timelapse');
    expect(s.time_remaining_basis).toBe('file progress');
  });

  it('copes with a printer that lacks the Qidi-specific objects', () => {
    const s = buildStatus({ status: { print_stats: { state: 'standby' }, extruder: { temperature: 21 }, heater_bed: { temperature: 20 } }, serverInfo: null, metadata: null });
    expect(s.temperatures.chamber).toBeUndefined();
    expect(s.filament.detected).toBeNull();
    expect(s.formatted).toContain('Printer: idle');
  });
});

describe('buildHistory + fmtDuration', () => {
  it('formats jobs and durations', () => {
    const [j] = buildHistory([{ job_id: '000087', filename: '.cache/rack emeet speaker holder.gcode', status: 'completed', start_time: 1789931481, end_time: 1789941008, print_duration: 9435.1, total_duration: 9527.5, filament_used: 14744.5, metadata: { filament_type: 'ASA', estimated_time: 9033 } }]);
    expect(j.file).toBe('rack emeet speaker holder.gcode');
    expect(j.print_time).toBe('2h 37m');
    expect(j.filament_m).toBe(14.7);
    expect(j.estimated).toBe('2h 30m');
    expect(fmtDuration(59)).toBe('59s');
    expect(fmtDuration(125)).toBe('2m 05s');
  });
});

describe('read-only guard', () => {
  it('allows exactly the Moonraker read paths', () => {
    for (const p of ['/server/info', '/printer/info', '/printer/objects/query?print_stats&extruder&heater_generic%20chamber', '/server/history/list?limit=5&order=desc', '/server/files/list?root=gcodes', '/server/files/metadata?filename=.cache%2Fa%20b.gcode', '/server/webcams/list', '/server/job_queue/status', '/webcam/?action=snapshot']) {
      expect(isAllowedPath(p)).toBe(true);
    }
  });
  it('refuses everything that could change the printer', () => {
    for (const p of ['/printer/gcode/script?script=G28', '/printer/emergency_stop', '/printer/firmware_restart', '/printer/print/pause', '/printer/print/cancel', '/machine/reboot', '/server/files/upload', '/printer/queue/status', '/webcam/?action=stream', '/printer/objects/query?print_stats;rm']) {
      expect(isAllowedPath(p)).toBe(false);
    }
  });
  it('moonrakerGet only ever issues GET and refuses off-list paths before touching the network', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fake = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return new Response('{"result":{}}', { status: 200 }); }) as unknown as typeof fetch;
    await moonrakerGet('/server/info', fake);
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe('GET');
    await expect(moonrakerGet('/printer/gcode/script?script=M112', fake)).rejects.toThrow(/refused/);
    expect(calls).toHaveLength(1);
  });
  it('printer_status never leaks ECONNREFUSED and explains an unreachable printer', async () => {
    const dead = (async () => { throw new Error('fetch failed: connect ECONNREFUSED 192.168.1.139:80'); }) as unknown as typeof fetch;
    const h = new PrinterMonitorHandler(dead);
    const r = await h.execute({ id: '1', name: 'printer_status', arguments: {} }, {} as never);
    expect(r.error).toMatch(/did not answer/);
    expect(r.error).not.toMatch(/ECONNREFUSED/);
    expect(r.error).toMatch(/Home Assistant power reading/);
  });
});
