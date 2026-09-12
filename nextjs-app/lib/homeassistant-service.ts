// Home Assistant REST API Service
// Provides typed access to HA states, services, and history

export interface HomeAssistantSettings {
  baseUrl: string;           // e.g. "http://your-ha-host:8123"
  accessToken: string;       // Long-lived access token
  entityFilter?: string;     // Comma-separated domain prefixes (e.g. "sensor.,light.,switch.")
  injectIntoPrompt: boolean; // Auto-inject sensor summary into system prompt
  promptEntities?: string;   // Comma-separated entity IDs for prompt injection
  cacheSeconds: number;      // Cache TTL (default 30)
}

export interface HAEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface HAHistorySummary {
  entity_id: string;
  friendly_name: string;
  min: number | null;
  max: number | null;
  avg: number | null;
  trend: 'rising' | 'falling' | 'stable' | 'unknown';
  samples: number;
  unit: string;
  first: string;
  last: string;
  changes?: Array<{ time: string; state: string }>;
}

// In-memory cache
const stateCache: Map<string, { data: HAEntity; expiresAt: number }> = new Map();
const allStatesCache: { data: HAEntity[]; expiresAt: number } | null = { data: [], expiresAt: 0 };
let allStatesCacheRef = allStatesCache;
let servicesCatalogCache: { data: Record<string, Record<string, unknown>>; expiresAt: number } | null = null;

export class HomeAssistantService {
  private settings: HomeAssistantSettings;
  private cacheTTL: number;

  constructor(settings: HomeAssistantSettings) {
    this.settings = settings;
    this.cacheTTL = (settings.cacheSeconds || 30) * 1000;
  }

  private get baseUrl(): string {
    return this.settings.baseUrl.replace(/\/+$/, '');
  }

  private async apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
    if (!this.settings.accessToken) {
      throw new Error('Home Assistant access token not configured');
    }

    const url = `${this.baseUrl}${path}`;
    const resp = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.settings.accessToken}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      // HA sometimes returns a JSON body with a message field, sometimes bare text,
      // sometimes just the HTTP status line. Prefer the JSON message when available
      // so callers see "Entity not found" instead of "400: Bad Request".
      let detail = text || resp.statusText;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && 'message' in parsed) {
          detail = String((parsed as { message: unknown }).message);
        }
      } catch { /* not JSON, keep raw */ }
      throw new Error(`HA API ${resp.status}: ${detail}`);
    }

    return resp.json() as Promise<T>;
  }

  /**
   * Test connection to Home Assistant — GET /api/
   */
  async testConnection(): Promise<{ message: string; version?: string }> {
    const result = await this.apiFetch<{ message: string }>('/api/');
    // HA returns {"message": "API running."} and version via /api/config
    try {
      const config = await this.apiFetch<{ version: string }>('/api/config');
      return { message: result.message, version: config.version };
    } catch {
      return result;
    }
  }

  /**
   * Get a single entity's state — GET /api/states/{entity_id}
   */
  async getState(entityId: string): Promise<HAEntity> {
    const cached = stateCache.get(entityId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const entity = await this.apiFetch<HAEntity>(`/api/states/${entityId}`);
    stateCache.set(entityId, { data: entity, expiresAt: Date.now() + this.cacheTTL });
    return entity;
  }

  /**
   * List all entity states, optionally filtered by domain or area name.
   */
  async listStates(domain?: string, area?: string): Promise<HAEntity[]> {
    let entities: HAEntity[];

    // Use cache for all-states calls
    if (allStatesCacheRef && allStatesCacheRef.expiresAt > Date.now()) {
      entities = allStatesCacheRef.data;
    } else {
      entities = await this.apiFetch<HAEntity[]>('/api/states');
      allStatesCacheRef = { data: entities, expiresAt: Date.now() + this.cacheTTL };
    }

    // Apply entity filter from settings
    if (this.settings.entityFilter) {
      const prefixes = this.settings.entityFilter.split(',').map(p => p.trim()).filter(Boolean);
      if (prefixes.length > 0) {
        entities = entities.filter(e =>
          prefixes.some(p => e.entity_id.startsWith(p))
        );
      }
    }

    // Filter by domain if specified
    if (domain) {
      const domainPrefix = domain.endsWith('.') ? domain : domain + '.';
      entities = entities.filter(e => e.entity_id.startsWith(domainPrefix));
    }

    // Filter by area. Prefer HA's area registry (via template helper area_entities())
    // which respects device→area inheritance. Fall back to friendly-name substring
    // matching if the area isn't in the registry or the template call fails.
    if (area) {
      const registryIds = await this.resolveAreaEntities(area);
      if (registryIds && registryIds.length > 0) {
        const idSet = new Set(registryIds);
        entities = entities.filter(e => idSet.has(e.entity_id));
      } else {
        const areaLower = area.toLowerCase();
        entities = entities.filter(e => {
          const attrs = e.attributes;
          const friendlyName = String(attrs.friendly_name || '').toLowerCase();
          const entityArea = String(attrs.area || '').toLowerCase();
          return entityArea.includes(areaLower) || friendlyName.includes(areaLower);
        });
      }
    }

    return entities;
  }

  /**
   * Call a HA service — POST /api/services/{domain}/{service}
   *
   * HA's REST service endpoint takes a FLAT body (not the WebSocket {target, data}
   * shape). target.entity_id / area_id / device_id all go at the top level alongside
   * the service data fields. Examples:
   *   {"entity_id": "light.kitchen", "brightness": 128}
   *   {"area_id": "kitchen"}
   *   {"entity_id": "select.tower_ptz_preset", "option": "Driveway"}
   *
   * Accepts either an explicit entityId parameter or a target object (or both);
   * flattens everything onto a single body so callers can pass whichever form the
   * model produced.
   */
  async callService(
    domain: string,
    service: string,
    entityId?: string,
    serviceData?: Record<string, unknown>,
    target?: { entity_id?: string | string[]; area_id?: string | string[]; device_id?: string | string[] }
  ): Promise<HAEntity[]> {
    const body: Record<string, unknown> = {};

    // Flatten target → top-level. REST API understands area_id / device_id at top level
    // (same as the WebSocket target form, just not wrapped).
    if (target) {
      if (target.entity_id !== undefined) body.entity_id = target.entity_id;
      if (target.area_id !== undefined) body.area_id = target.area_id;
      if (target.device_id !== undefined) body.device_id = target.device_id;
    }
    // Explicit entityId param overrides any target.entity_id.
    if (entityId) body.entity_id = entityId;
    // Merge service data fields last so they override any same-name target keys
    // (shouldn't happen, but defensive).
    if (serviceData) Object.assign(body, serviceData);

    const result = await this.apiFetch<HAEntity[]>(
      `/api/services/${domain}/${service}`,
      { method: 'POST', body: JSON.stringify(body) }
    );

    // Invalidate cache.
    if (entityId) stateCache.delete(entityId);
    if (typeof body.entity_id === 'string') stateCache.delete(body.entity_id);
    allStatesCacheRef = { data: [], expiresAt: 0 };

    return result;
  }

  /**
   * Look up whether a given domain.service exists. Uses a short-lived per-process
   * cache of the services catalog. Returns the list of real services in that
   * domain if the requested one doesn't exist, or null if the domain itself is
   * unknown. Returns `true` if the service exists.
   */
  async verifyServiceExists(domain: string, service: string): Promise<true | { siblings: string[] } | null> {
    try {
      const catalog = await this.listServicesCached();
      const svcMap = catalog[domain];
      if (!svcMap) return null;
      if (svcMap[service]) return true;
      return { siblings: Object.keys(svcMap) };
    } catch {
      // On network error, don't block the call — let HA respond authoritatively.
      return true;
    }
  }

  private async listServicesCached(): Promise<Record<string, Record<string, unknown>>> {
    const now = Date.now();
    const cacheTTL = 60_000;
    if (servicesCatalogCache && servicesCatalogCache.expiresAt > now) {
      return servicesCatalogCache.data;
    }
    const data = await this.listServices();
    servicesCatalogCache = { data, expiresAt: now + cacheTTL };
    return data;
  }

  /**
   * List all available services on this HA instance — GET /api/services
   * Returns the service catalog grouped by domain. Useful for discovering real
   * service names before calling (Chooms often hallucinate service names like
   * `camera.available_ptz_presets` that don't exist).
   */
  async listServices(domain?: string): Promise<Record<string, Record<string, unknown>>> {
    const data = await this.apiFetch<Array<{ domain: string; services: Record<string, unknown> }>>('/api/services');
    const grouped: Record<string, Record<string, unknown>> = {};
    for (const entry of data) {
      if (domain && entry.domain !== domain) continue;
      grouped[entry.domain] = entry.services;
    }
    return grouped;
  }

  /**
   * Fire a custom event — POST /api/events/{event_type}
   * Useful for triggering automations that listen on `event:` triggers.
   */
  async fireEvent(eventType: string, eventData?: Record<string, unknown>): Promise<{ message: string }> {
    return this.apiFetch<{ message: string }>(
      `/api/events/${eventType}`,
      {
        method: 'POST',
        body: JSON.stringify(eventData || {}),
      }
    );
  }

  /**
   * Render a Jinja2 template against live HA state — POST /api/template
   * HA exposes helpers like area_entities('kitchen'), is_state('...'), states.*, etc.
   * Returns the rendered string (always a string from HA; caller parses JSON if needed).
   */
  async renderTemplate(template: string, variables?: Record<string, unknown>): Promise<string> {
    if (!this.settings.accessToken) {
      throw new Error('Home Assistant access token not configured');
    }
    const url = `${this.baseUrl}/api/template`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.settings.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ template, ...(variables && { variables }) }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HA template ${resp.status}: ${text || resp.statusText}`);
    }
    return resp.text();
  }

  /**
   * Resolve an area name (case-insensitive) to the list of entity_ids assigned to it
   * in HA's area registry (includes entities whose device is in that area). Uses the
   * template endpoint so it works with long-lived access tokens over REST.
   *
   * Returns null if the template fails (area doesn't exist or rendering error) —
   * caller can fall back to friendly-name matching.
   */
  async resolveAreaEntities(areaName: string): Promise<string[] | null> {
    const safeName = areaName.replace(/'/g, "\\'");
    const tmpl = `{{ area_entities('${safeName}') | list | tojson }}`;
    try {
      const rendered = await this.renderTemplate(tmpl);
      const parsed = JSON.parse(rendered);
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      return parsed.filter((s): s is string => typeof s === 'string');
    } catch {
      return null;
    }
  }

  /**
   * Get history for an entity — GET /api/history/period/{start}
   * Returns a summarized view (min/max/avg/trend) instead of raw data points.
   */
  async getHistory(entityId: string, hours: number = 24): Promise<HAHistorySummary> {
    const start = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const data = await this.apiFetch<HAEntity[][]>(
      `/api/history/period/${start}?filter_entity_id=${entityId}&minimal_response&no_attributes`
    );

    if (!data || data.length === 0 || data[0].length === 0) {
      // Return empty summary instead of throwing — "no data" is informational,
      // not a failure. Throwing caused brokenTools blocking after 2 entities
      // had no history, preventing queries for remaining entities.
      return {
        entity_id: entityId,
        friendly_name: entityId,
        min: null,
        max: null,
        avg: null,
        trend: 'unknown' as const,
        samples: 0,
        unit: '',
        first: 'no data',
        last: 'no data',
      };
    }

    const entries = data[0];
    const entity = entries[0];
    const friendlyName = String(entity.attributes?.friendly_name || entityId);

    // Extract numeric values
    const numericValues: number[] = [];
    for (const e of entries) {
      const v = parseFloat(e.state);
      if (!isNaN(v) && e.state !== 'unavailable' && e.state !== 'unknown') {
        numericValues.push(v);
      }
    }

    if (numericValues.length === 0) {
      // Non-numeric entity (e.g. binary_sensor, switch, geocoded_location)
      // Include individual state changes so the LLM can see the full timeline
      const changes: Array<{ time: string; state: string }> = [];
      let prevState = '';
      for (const e of entries) {
        if (e.state !== 'unavailable' && e.state !== 'unknown' && e.state !== prevState) {
          changes.push({ time: e.last_changed || e.last_updated, state: e.state });
          prevState = e.state;
        }
      }
      return {
        entity_id: entityId,
        friendly_name: friendlyName,
        min: null,
        max: null,
        avg: null,
        trend: 'unknown',
        samples: entries.length,
        unit: '',
        first: entries[0].state,
        last: entries[entries.length - 1].state,
        changes: changes.slice(-100),
      };
    }

    const min = Math.min(...numericValues);
    const max = Math.max(...numericValues);
    const avg = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;

    // Determine trend from last ~25% of readings
    let trend: 'rising' | 'falling' | 'stable' | 'unknown' = 'stable';
    if (numericValues.length >= 4) {
      const quarterIdx = Math.floor(numericValues.length * 0.75);
      const recentAvg = numericValues.slice(quarterIdx).reduce((a, b) => a + b, 0) / (numericValues.length - quarterIdx);
      const earlyAvg = numericValues.slice(0, quarterIdx).reduce((a, b) => a + b, 0) / quarterIdx;
      const diff = recentAvg - earlyAvg;
      const range = max - min || 1;
      if (diff / range > 0.1) trend = 'rising';
      else if (diff / range < -0.1) trend = 'falling';
    }

    // Try to get the unit from the full entity state
    let unit = '';
    try {
      const fullEntity = await this.getState(entityId);
      unit = String(fullEntity.attributes.unit_of_measurement || '');
    } catch { /* ignore */ }

    return {
      entity_id: entityId,
      friendly_name: friendlyName,
      min: Math.round(min * 10) / 10,
      max: Math.round(max * 10) / 10,
      avg: Math.round(avg * 10) / 10,
      trend,
      samples: numericValues.length,
      unit,
      first: String(numericValues[0]),
      last: String(numericValues[numericValues.length - 1]),
    };
  }

  async getLogbook(entityId: string, hours: number = 24): Promise<Array<{ when: string; state: string; message: string }>> {
    const start = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const end = new Date().toISOString();
    const data = await this.apiFetch<Array<{ when: string; state?: string; message?: string; entity_id?: string }>>(
      `/api/logbook/${start}?entity=${entityId}&end_time=${end}`
    );
    if (!data || data.length === 0) return [];
    return data
      .filter(e => e.entity_id === entityId)
      .map(e => ({
        when: e.when,
        state: e.state || '',
        message: e.message || '',
      }));
  }

  /**
   * Get a home status snapshot grouped by domain.
   */
  async getHomeSummary(includeOff: boolean = false): Promise<Record<string, Array<{ id: string; name: string; state: string; unit?: string; extras?: string }>>> {
    const entities = await this.listStates();
    const groups: Record<string, Array<{ id: string; name: string; state: string; unit?: string; extras?: string }>> = {};

    for (const e of entities) {
      // Skip unavailable/unknown
      if (e.state === 'unavailable' || e.state === 'unknown') continue;

      // Skip "off" entities unless includeOff
      if (!includeOff && e.state === 'off') continue;

      const domain = e.entity_id.split('.')[0];
      const friendlyName = String(e.attributes.friendly_name || e.entity_id);
      const unit = String(e.attributes.unit_of_measurement || '');

      // Build extras for specific domains
      let extras = '';
      if (domain === 'light' && e.state === 'on' && e.attributes.brightness) {
        const pct = Math.round((Number(e.attributes.brightness) / 255) * 100);
        extras = `brightness: ${pct}%`;
      }
      if (domain === 'climate') {
        const temp = e.attributes.temperature;
        const mode = e.attributes.hvac_action || e.attributes.hvac_mode;
        if (temp) extras = `target: ${temp}°`;
        if (mode) extras += (extras ? ', ' : '') + `mode: ${mode}`;
      }

      if (!groups[domain]) groups[domain] = [];
      groups[domain].push({
        id: e.entity_id,
        name: friendlyName,
        state: unit ? `${e.state} ${unit}` : e.state,
        ...(unit && { unit }),
        ...(extras && { extras }),
      });
    }

    return groups;
  }

  /**
   * Compact "glance at the house" (Phase 1, 2026-09-12). The full summary of
   * this homestead is ~1,000 entities / 51k chars and was the largest tool
   * result in the system, called on almost every grounding turn. This returns
   * what a person glancing around would notice — who's home, what's on, what's
   * open or wrong, low batteries, climate, and the key power / solar / battery /
   * temperature readings — in a few thousand chars. Everything else is one
   * `focus`, `domain` or `detail` call away (see the ha_get_home_status tool).
   */
  async getCompactHomeStatus(): Promise<Record<string, unknown>> {
    const entities = await this.listStates();
    const live = entities.filter(e => e.state !== 'unavailable' && e.state !== 'unknown');
    const name = (e: HAEntity) => String(e.attributes.friendly_name || e.entity_id);
    const domainOf = (e: HAEntity) => e.entity_id.split('.')[0];
    const cls = (e: HAEntity) => String(e.attributes.device_class || '');
    const unit = (e: HAEntity) => String(e.attributes.unit_of_measurement || '');
    const reading = (e: HAEntity) => {
      const u = unit(e);
      const v = Number(e.state);
      const val = Number.isFinite(v) ? String(Math.round(v * 10) / 10) : e.state;
      return `${name(e)}: ${val}${u ? ' ' + u : ''}`;
    };
    // Prefer the readings a person actually asks about; cap each block so a
    // house with 60 per-plug power meters still reads in one glance.
    const pick = (list: HAEntity[], prefer: RegExp, cap: number) => {
      const preferred = list.filter(e => prefer.test(name(e)) || prefer.test(e.entity_id));
      const rest = list.filter(e => !preferred.includes(e));
      return [...preferred, ...rest].slice(0, cap);
    };

    const people = live.filter(e => domainOf(e) === 'person').map(e => `${name(e)}: ${e.state}`);
    const lightsOn = live.filter(e => domainOf(e) === 'light' && e.state === 'on').map(e => {
      const b = Number(e.attributes.brightness);
      return Number.isFinite(b) && b > 0 ? `${name(e)} (${Math.round((b / 255) * 100)}%)` : name(e);
    });
    const switchesOn = live.filter(e => domainOf(e) === 'switch' && e.state === 'on').map(name);
    const ALERT_CLASSES = new Set(['motion', 'occupancy', 'door', 'window', 'opening', 'garage_door', 'problem', 'smoke', 'gas', 'carbon_monoxide', 'moisture', 'safety', 'tamper', 'vibration', 'sound']);
    const alerts = live
      .filter(e => domainOf(e) === 'binary_sensor' && e.state === 'on' && ALERT_CLASSES.has(cls(e)))
      .map(e => `${name(e)}: ${cls(e) === 'problem' ? 'problem' : cls(e) === 'motion' || cls(e) === 'occupancy' ? 'motion' : 'open'}`);
    const locks = live.filter(e => domainOf(e) === 'lock').map(e => `${name(e)}: ${e.state}`);
    const alarms = live.filter(e => domainOf(e) === 'alarm_control_panel').map(e => `${name(e)}: ${e.state}`);
    const climate = live.filter(e => domainOf(e) === 'climate').map(e => {
      const t = e.attributes.temperature; const cur = e.attributes.current_temperature;
      const mode = e.attributes.hvac_action || e.attributes.hvac_mode || e.state;
      return `${name(e)}: ${mode}${cur !== undefined ? `, now ${cur}°` : ''}${t !== undefined ? `, target ${t}°` : ''}`;
    });
    const lowBattery = live.filter(e => {
      if (domainOf(e) === 'binary_sensor') return cls(e) === 'battery' && e.state === 'on';
      if (domainOf(e) !== 'sensor' || cls(e) !== 'battery') return false;
      const v = Number(e.state); return Number.isFinite(v) && v < 20;
    }).map(reading);
    const offline = live.filter(e => domainOf(e) === 'binary_sensor' && cls(e) === 'connectivity' && e.state === 'off').map(name);
    const updates = live.filter(e => domainOf(e) === 'update' && e.state === 'on').map(name);
    const cameras = live.filter(e => domainOf(e) === 'camera').map(name);

    const sensors = live.filter(e => domainOf(e) === 'sensor');
    const ENERGY_WORDS = /solar|pv|inverter|battery|soc|grid|load|consum|house|home|total|charge|generat/i;
    const energy = pick(
      sensors.filter(e => ['power', 'energy', 'battery', 'current', 'voltage'].includes(cls(e)) && Number.isFinite(Number(e.state))),
      ENERGY_WORDS, 12,
    ).map(reading);
    const ENV_WORDS = /outdoor|outside|indoor|inside|living|bedroom|kitchen|office|shop|garage|greenhouse|barn|coop|porch|basement|attic/i;
    const environment = pick(
      sensors.filter(e => ['temperature', 'humidity'].includes(cls(e)) && Number.isFinite(Number(e.state))),
      ENV_WORDS, 12,
    ).map(reading);

    const domainCounts: Record<string, number> = {};
    for (const e of live) domainCounts[domainOf(e)] = (domainCounts[domainOf(e)] || 0) + 1;

    const parts = [
      `${live.length} live entities`,
      people.length ? `${people.length} people tracked` : '',
      `${lightsOn.length} lights on`,
      `${switchesOn.length} switches on`,
      alerts.length ? `${alerts.length} open/motion/problem` : 'nothing open, no motion, no problems',
      lowBattery.length ? `${lowBattery.length} low batteries` : '',
      offline.length ? `${offline.length} devices offline` : '',
      updates.length ? `${updates.length} updates available` : '',
    ].filter(Boolean);

    const cap = <T>(list: T[], n: number) => list.length > n
      ? { shown: list.slice(0, n), more: list.length - n }
      : list;

    return {
      summary: parts.join('; '),
      ...(people.length && { people }),
      ...(alerts.length && { alerts }),
      ...(locks.length && { locks }),
      ...(alarms.length && { alarms }),
      ...(lightsOn.length && { lights_on: cap(lightsOn, 15) }),
      ...(switchesOn.length && { switches_on: cap(switchesOn, 15) }),
      ...(climate.length && { climate }),
      ...(energy.length && { energy }),
      ...(environment.length && { environment }),
      ...(lowBattery.length && { low_batteries: lowBattery }),
      ...(offline.length && { offline_devices: cap(offline, 10) }),
      ...(updates.length && { updates_available: cap(updates, 8) }),
      ...(cameras.length && { cameras }),
      domains: domainCounts,
      hint: 'This is the compact glance. For more: focus="<keyword>" (e.g. "solar", "garage") lists every matching entity, domain="sensor" lists one domain, detail=true is the full dump.',
    };
  }

  /**
   * Format a concise sensor summary for system prompt injection (~200 token budget).
   * Only includes entities listed in promptEntities setting.
   */
  async formatSummaryForPrompt(): Promise<string> {
    if (!this.settings.promptEntities) return '';

    const entityIds = this.settings.promptEntities.split(',').map(id => id.trim()).filter(Boolean);
    if (entityIds.length === 0) return '';

    const lines: string[] = ['## HOME ENVIRONMENT'];

    for (const entityId of entityIds) {
      try {
        const entity = await this.getState(entityId);
        if (entity.state === 'unavailable' || entity.state === 'unknown') continue;

        const name = String(entity.attributes.friendly_name || entityId);
        const unit = String(entity.attributes.unit_of_measurement || '');
        const stateStr = unit ? `${entity.state}${unit}` : entity.state;

        lines.push(`- ${name} (${entityId}): ${stateStr}`);
      } catch {
        // Skip entities that fail to load
      }
    }

    // Only return if we have at least one entity
    return lines.length > 1 ? lines.join('\n') : '';
  }

  /**
   * Clear all caches.
   */
  clearCache(): void {
    stateCache.clear();
    allStatesCacheRef = { data: [], expiresAt: 0 };
  }
}
