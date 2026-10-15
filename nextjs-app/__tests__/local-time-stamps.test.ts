/** 2026-09-13: tool results hand a Choom local time, never a bare UTC ISO stamp (Eve read a 2:23 PM snapshot as "8:23"). */
import { localTimeString, localFileStamp, localizeTimestamps, localTemplateTimes } from '@/lib/time-context';
import { readFileSync } from 'fs';
import path from 'path';

describe('local time stamps', () => {
  const d = new Date('2026-09-13T20:23:00Z'); // 2:23 PM MDT
  test('localTimeString names the zone and the local hour', () => {
    const s = localTimeString(d);
    expect(s).toContain('2:23 PM');
    expect(s).toMatch(/MDT|MST|GMT-[67]/);
    expect(s).not.toContain('20:23');
  });
  test('localFileStamp is local wall-clock, not UTC', () => {
    expect(localFileStamp(d)).toBe('2026-09-13_14-23');
    expect(localFileStamp(new Date('2026-09-14T05:30:00Z'))).toBe('2026-09-13_23-30');
  });
  test('the camera snapshot uses them for its file name and captured_at', () => {
    const src = readFileSync(path.join(__dirname, '..', 'skills', 'core', 'home-assistant', 'handler.ts'), 'utf-8');
    expect(src).toContain('const stamp = localFileStamp();');
    expect(src).toContain('captured_at: localTimeString(),');
    expect(src).not.toContain("captured_at: new Date().toISOString()");
  });
});

describe('Home Assistant times reach her in local time (2026-10-10)', () => {
  // The rain gauge's last rain, read as "02:35" when it had rained at 8:35 PM.
  test('a timestamp sensor, a state change and a history are all local', () => {
    const out = localizeTimestamps({
      entity_id: 'sensor.stonedesert_last_rain',
      state: '2026-10-11T02:35:00+00:00',
      last_changed: '2026-10-11T02:35:03.832787+00:00',
      changes: [{ time: '2026-10-11T01:00:00Z', state: '0.00' }, { time: '2026-10-11T02:35:00Z', state: '0.02' }],
      samples: 4,
      ok: true,
    });
    expect(out.state).toContain('8:35 PM');
    expect(out.state).toMatch(/Oct 10/);
    expect(out.last_changed).toContain('8:35 PM');
    expect(out.changes[0].time).toContain('7:00 PM');
    expect(out.changes[1].state).toBe('0.02');
    expect(out.samples).toBe(4);
    expect(out.ok).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/T0[12]:/);
  });
  test('inside a line of text too; plain numbers, dates and zoneless times are left alone', () => {
    expect(localizeTimestamps('changed to 2026-10-11T02:35:00+00:00 after a gust')).toMatch(/^changed to Sat, Oct 10, 8:35 PM \S+ after a gust$/);
    expect(localizeTimestamps('29.97 mph')).toBe('29.97 mph');
    expect(localizeTimestamps('2026-10-10')).toBe('2026-10-10');
    expect(localizeTimestamps('2026-10-10 20:35:00')).toBe('2026-10-10 20:35:00');
    expect(localizeTimestamps(null)).toBeNull();
  });
  test('every Home Assistant tool result goes through it', () => {
    const src = readFileSync(path.join(__dirname, '..', 'skills', 'core', 'home-assistant', 'handler.ts'), 'utf-8');
    expect(src).toContain('return r.result == null ? r : { ...r, result: localizeTimestamps(r.result) };');
  });
});

describe('Home Assistant templates give change times in local time (2026-10-15)', () => {
  // Genesis: "{{ s.last_changed.strftime('%H:%M') }}" gave door sensors that changed at 10:40 as "16:40".
  test("a state's change times go through as_local", () => {
    expect(localTemplateTimes("{% for s in states.binary_sensor if 'door' in s.entity_id %}{{ s.entity_id }} = {{ s.state }} ({{ s.last_changed.strftime('%H:%M') }}){% endfor %}"))
      .toBe("{% for s in states.binary_sensor if 'door' in s.entity_id %}{{ s.entity_id }} = {{ s.state }} ({{ as_local(s.last_changed).strftime('%H:%M') }}){% endfor %}");
    expect(localTemplateTimes('{{ states.binary_sensor.kitchen1_home_east_door_window.last_changed }}'))
      .toBe('{{ as_local(states.binary_sensor.kitchen1_home_east_door_window.last_changed) }}');
    expect(localTemplateTimes("{{ states[e].last_updated.strftime('%m-%d %H:%M') }}"))
      .toBe("{{ as_local(states[e].last_updated).strftime('%m-%d %H:%M') }}");
    expect(localTemplateTimes('{{ relative_time(s.last_changed) }} | {{ as_timestamp(s.last_reported) | timestamp_local }}'))
      .toBe('{{ relative_time(as_local(s.last_changed)) }} | {{ as_timestamp(as_local(s.last_reported)) | timestamp_local }}');
  });
  test('already local, a name in quotes and other names are left alone', () => {
    for (const t of [
      '{{ as_local(states.sensor.x.last_changed) }}',
      '{{ as_local( s.last_updated ).strftime("%H:%M") }}',
      "{{ states.light | selectattr('last_changed') | list }}",
      "{{ states.light | map(attribute='last_changed') | list }}",
      "{{ states('sensor.stonedesert_last_rain') }}",
      '{{ s.last_changed_by }}',
      '{{ s.state }}',
    ]) expect(localTemplateTimes(t)).toBe(t);
  });
  test("Python's print of a zoned time is local too; one without a zone or seconds is not", () => {
    expect(localizeTimestamps('door = off (2026-10-15 16:40:12.496776+00:00)')).toMatch(/^door = off \(Thu, Oct 15, 10:40\sAM \S+\)$/);
    expect(localizeTimestamps('2026-10-14 21:55:52.496776-06:00')).toMatch(/Oct 14, 9:55\sPM/);
    expect(localizeTimestamps('2026-10-15 10:00-12:00')).toBe('2026-10-15 10:00-12:00');
    expect(localizeTimestamps('2026-10-15 16:40:12')).toBe('2026-10-15 16:40:12');
  });
  test('the template tool renders the local version, and hers if that one fails', () => {
    const src = readFileSync(path.join(__dirname, '..', 'skills', 'core', 'home-assistant', 'handler.ts'), 'utf-8');
    expect(src).toContain('const local = localTemplateTimes(template);');
    expect(src).toContain('rendered = await ha.renderTemplate(local);');
    expect(src).toContain('rendered = await ha.renderTemplate(template);');
  });
});
