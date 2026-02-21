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
}

// In-memory cache
const stateCache: Map<string, { data: HAEntity; expiresAt: number }> = new Map();
const allStatesCache: { data: HAEntity[]; expiresAt: number } | null = { data: [], expiresAt: 0 };
let allStatesCacheRef = allStatesCache;

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
      throw new Error(`HA API ${resp.status}: ${text || resp.statusText}`);
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

    // Filter by area (check attributes.area or friendly_name containing area)
    if (area) {
      const areaLower = area.toLowerCase();
      entities = entities.filter(e => {
        const attrs = e.attributes;
        const friendlyName = String(attrs.friendly_name || '').toLowerCase();
        const entityArea = String(attrs.area || '').toLowerCase();
        return entityArea.includes(areaLower) || friendlyName.includes(areaLower);
      });
    }

    return entities;
  }

  /**
   * Call a HA service — POST /api/services/{domain}/{service}
   */
  async callService(
    domain: string,
    service: string,
    entityId: string,
    serviceData?: Record<string, unknown>
  ): Promise<HAEntity[]> {
    const body: Record<string, unknown> = {
      entity_id: entityId,
      ...serviceData,
    };

    const result = await this.apiFetch<HAEntity[]>(
      `/api/services/${domain}/${service}`,
      { method: 'POST', body: JSON.stringify(body) }
    );

    // Invalidate cache for affected entity
    stateCache.delete(entityId);
    allStatesCacheRef = { data: [], expiresAt: 0 };

    return result;
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
      throw new Error(`No history data for ${entityId}`);
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
      // Non-numeric entity (e.g. binary_sensor, switch)
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
