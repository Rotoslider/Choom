'use client';

import React, { useState } from 'react';
import { Home, Plug, RefreshCw, Check, X, Eye, EyeOff, ChevronDown, ChevronRight } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useAppStore } from '@/lib/store';

interface EntityInfo {
  entity_id: string;
  friendly_name: string;
  state: string;
  domain: string;
}

export function HomeAssistantSettings() {
  const { settings, updateHomeAssistantSettings } = useAppStore();
  const ha = settings.homeAssistant;

  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [entities, setEntities] = useState<EntityInfo[] | null>(null);
  const [loadingEntities, setLoadingEntities] = useState(false);
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set());
  const [entitySearch, setEntitySearch] = useState('');

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const params = new URLSearchParams({
        action: 'test',
        baseUrl: ha.baseUrl,
        accessToken: ha.accessToken,
      });
      const resp = await fetch(`/api/homeassistant?${params}`);
      const data = await resp.json();

      if (data.success) {
        setTestResult({
          success: true,
          message: `${data.message}${data.version ? ` (v${data.version})` : ''}`,
        });
      } else {
        setTestResult({ success: false, message: data.error || 'Connection failed' });
      }
    } catch (error) {
      setTestResult({
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      });
    } finally {
      setTesting(false);
    }
  };

  const browseEntities = async () => {
    setLoadingEntities(true);
    setEntities(null);
    try {
      const params = new URLSearchParams({
        action: 'entities',
        baseUrl: ha.baseUrl,
        accessToken: ha.accessToken,
      });
      if (ha.entityFilter) params.set('entityFilter', ha.entityFilter);
      const resp = await fetch(`/api/homeassistant?${params}`);
      const data = await resp.json();

      if (data.success) {
        const list: EntityInfo[] = data.entities;
        list.sort((a: EntityInfo, b: EntityInfo) => a.domain.localeCompare(b.domain) || a.friendly_name.localeCompare(b.friendly_name));
        setEntities(list);
      } else {
        setEntities([]);
        setTestResult({ success: false, message: data.error || 'Failed to fetch entities' });
      }
    } catch (error) {
      setEntities([]);
      setTestResult({
        success: false,
        message: `Failed to fetch entities: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    } finally {
      setLoadingEntities(false);
    }
  };

  const toggleDomain = (domain: string) => {
    setExpandedDomains(prev => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  };

  // Filter + group entities by domain
  const filteredEntities = entities
    ? (entitySearch
        ? entities.filter(e => {
            const q = entitySearch.toLowerCase();
            return e.entity_id.toLowerCase().includes(q) || e.friendly_name.toLowerCase().includes(q);
          })
        : entities)
    : null;

  const entityGroups = filteredEntities
    ? filteredEntities.reduce<Record<string, EntityInfo[]>>((acc, e) => {
        if (!acc[e.domain]) acc[e.domain] = [];
        acc[e.domain].push(e);
        return acc;
      }, {})
    : null;

  return (
    <div className="space-y-6">
      {/* Connection */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Plug className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Connection</h3>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">Base URL</label>
            <Input
              value={ha.baseUrl}
              onChange={(e) => updateHomeAssistantSettings({ baseUrl: e.target.value })}
              placeholder="http://your-ha-host:8123"
              className="mt-1"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground">Long-Lived Access Token</label>
            <div className="flex gap-2 mt-1">
              <Input
                type={showToken ? 'text' : 'password'}
                value={ha.accessToken}
                onChange={(e) => updateHomeAssistantSettings({ accessToken: e.target.value })}
                placeholder="eyJ..."
                className="flex-1"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => setShowToken(!showToken)}
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Generate at: HA Profile &rarr; Long-Lived Access Tokens
            </p>
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={testConnection}
              disabled={testing || !ha.baseUrl || !ha.accessToken}
            >
              {testing ? (
                <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Plug className="h-3.5 w-3.5 mr-1.5" />
              )}
              Test Connection
            </Button>
          </div>

          {testResult && (
            <div
              className={`flex items-center gap-2 text-sm p-2 rounded ${
                testResult.success
                  ? 'bg-green-500/10 text-green-400'
                  : 'bg-red-500/10 text-red-400'
              }`}
            >
              {testResult.success ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
              {testResult.message}
            </div>
          )}
        </div>
      </div>

      {/* Entity Filter */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Entity Filter</h3>
        <div>
          <label className="text-xs text-muted-foreground">Domain Prefixes (comma-separated)</label>
          <Input
            value={ha.entityFilter || ''}
            onChange={(e) => updateHomeAssistantSettings({ entityFilter: e.target.value })}
            placeholder="sensor., light., switch., climate., binary_sensor."
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Limits which entities are exposed to tools. Leave empty for all.
          </p>
        </div>
      </div>

      {/* System Prompt Injection */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">System Prompt Injection</h3>
          <Switch
            checked={ha.injectIntoPrompt}
            onCheckedChange={(checked) => updateHomeAssistantSettings({ injectIntoPrompt: checked })}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          When enabled, selected sensor values are automatically included in every conversation for ambient awareness.
        </p>
        {ha.injectIntoPrompt && (
          <div>
            <label className="text-xs text-muted-foreground">Entity IDs (comma-separated)</label>
            <Textarea
              value={ha.promptEntities || ''}
              onChange={(e) => updateHomeAssistantSettings({ promptEntities: e.target.value })}
              placeholder="sensor.bathroom_temperature, sensor.outdoor_temperature, binary_sensor.front_door"
              className="mt-1 font-mono text-xs"
              rows={3}
            />
          </div>
        )}
      </div>

      {/* Cache */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Cache</h3>
        <div className="flex items-center gap-3">
          <label className="text-xs text-muted-foreground whitespace-nowrap">TTL (seconds)</label>
          <Input
            type="number"
            value={ha.cacheSeconds}
            onChange={(e) => updateHomeAssistantSettings({ cacheSeconds: parseInt(e.target.value) || 30 })}
            className="w-24"
            min={5}
            max={300}
          />
        </div>
      </div>

      {/* Entity Browser */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Entity Browser</h3>
          <Button
            variant="outline"
            size="sm"
            onClick={browseEntities}
            disabled={loadingEntities || !ha.baseUrl || !ha.accessToken}
          >
            {loadingEntities ? (
              <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Home className="h-3.5 w-3.5 mr-1.5" />
            )}
            Browse Entities
          </Button>
        </div>

        {entities && entities.length > 0 && (
          <Input
            value={entitySearch}
            onChange={(e) => setEntitySearch(e.target.value)}
            placeholder="Search entities..."
            className="text-xs"
          />
        )}

        {entityGroups && (
          <div className="border rounded-lg divide-y max-h-96 overflow-y-auto">
            {Object.entries(entityGroups).sort(([a], [b]) => a.localeCompare(b)).map(([domain, domainEntities]) => (
              <div key={domain}>
                <button
                  onClick={() => toggleDomain(domain)}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 text-left"
                >
                  {expandedDomains.has(domain) ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  <span className="text-xs font-medium">{domain}</span>
                  <span className="text-xs text-muted-foreground">({domainEntities.length})</span>
                </button>
                {expandedDomains.has(domain) && (
                  <div className="px-3 pb-2 space-y-1">
                    {domainEntities.map(e => (
                      <div
                        key={e.entity_id}
                        className="flex items-center justify-between text-xs px-2 py-1 rounded hover:bg-muted/30 cursor-pointer"
                        onClick={() => {
                          navigator.clipboard.writeText(e.entity_id);
                        }}
                        title="Click to copy entity ID"
                      >
                        <div>
                          <span className="text-foreground">{e.friendly_name}</span>
                          <span className="text-muted-foreground ml-2 font-mono">{e.entity_id}</span>
                        </div>
                        <span className={`font-mono ${
                          e.state === 'on' ? 'text-green-400' :
                          e.state === 'off' ? 'text-muted-foreground' :
                          e.state === 'unavailable' ? 'text-red-400' :
                          'text-foreground'
                        }`}>
                          {e.state}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {entities && entities.length === 0 && (
          <p className="text-xs text-muted-foreground">No entities found. Check your connection settings.</p>
        )}
      </div>
    </div>
  );
}
