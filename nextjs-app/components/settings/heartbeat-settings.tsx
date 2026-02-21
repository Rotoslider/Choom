'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Heart, RefreshCw, CheckCircle, XCircle, Moon, Plus, Trash2, MessageSquare, Play } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface BridgeConfig {
  tasks: Record<string, { enabled: boolean; time?: string; interval_minutes?: number }>;
  heartbeat: {
    quiet_start: string;
    quiet_end: string;
    custom_tasks?: CustomHeartbeat[];
  };
}

interface CustomHeartbeat {
  id: string;
  choom_name: string;
  interval_minutes: number;
  prompt: string;
  respect_quiet: boolean;
  enabled: boolean;
}

interface ChoomOption {
  id: string;
  name: string;
}

export function HeartbeatSettings() {
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<'connected' | 'disconnected' | 'checking'>('checking');
  const [saving, setSaving] = useState(false);
  const [chooms, setChooms] = useState<ChoomOption[]>([]);

  useEffect(() => {
    fetch('/api/bridge-config')
      .then((r) => r.json())
      .then((data) => {
        setConfig(data);
        setBridgeStatus('connected');
      })
      .catch(() => setBridgeStatus('disconnected'));

    // Fetch available Chooms for dropdown
    fetch('/api/chooms')
      .then((r) => r.json())
      .then((data) => {
        const list = Array.isArray(data) ? data : data.chooms || [];
        setChooms(list.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })));
      })
      .catch(console.error);
  }, []);

  const saveConfig = useCallback(async (updated: BridgeConfig) => {
    setSaving(true);
    try {
      const res = await fetch('/api/bridge-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      if (res.ok) {
        const saved = await res.json();
        setConfig(saved);
      }
    } catch (err) {
      console.error('Failed to save bridge config:', err);
    } finally {
      setSaving(false);
    }
  }, []);

  const toggleHealthCheck = useCallback(() => {
    if (!config) return;
    const updated = {
      ...config,
      tasks: {
        ...config.tasks,
        system_health: {
          ...config.tasks.system_health,
          enabled: !config.tasks.system_health?.enabled,
        },
      },
    };
    setConfig(updated);
    saveConfig(updated);
  }, [config, saveConfig]);

  const updateInterval = useCallback(
    (minutes: number) => {
      if (!config || minutes < 5) return;
      const updated = {
        ...config,
        tasks: {
          ...config.tasks,
          system_health: {
            ...config.tasks.system_health,
            interval_minutes: minutes,
          },
        },
      };
      setConfig(updated);
      saveConfig(updated);
    },
    [config, saveConfig]
  );

  const updateQuietPeriod = useCallback(
    (field: 'quiet_start' | 'quiet_end', value: string) => {
      if (!config) return;
      const updated = {
        ...config,
        heartbeat: {
          ...config.heartbeat,
          [field]: value,
        },
      };
      setConfig(updated);
      saveConfig(updated);
    },
    [config, saveConfig]
  );

  // Custom heartbeat helpers
  const customTasks = config?.heartbeat?.custom_tasks || [];

  const addCustomHeartbeat = useCallback(() => {
    if (!config) return;
    const defaultChoom = chooms.length > 0 ? chooms[0].name : 'Choom';
    const newTask: CustomHeartbeat = {
      id: `custom_hb_${Date.now()}`,
      choom_name: defaultChoom,
      interval_minutes: 120,
      prompt: 'Send me a selfie',
      respect_quiet: true,
      enabled: true,
    };
    const updated = {
      ...config,
      heartbeat: {
        ...config.heartbeat,
        custom_tasks: [...customTasks, newTask],
      },
    };
    setConfig(updated);
    saveConfig(updated);
  }, [config, customTasks, chooms, saveConfig]);

  const updateCustomHeartbeat = useCallback(
    (id: string, changes: Partial<CustomHeartbeat>) => {
      if (!config) return;
      const updated = {
        ...config,
        heartbeat: {
          ...config.heartbeat,
          custom_tasks: customTasks.map((t) => (t.id === id ? { ...t, ...changes } : t)),
        },
      };
      setConfig(updated);
    },
    [config, customTasks]
  );

  const saveCustomHeartbeat = useCallback(
    (id: string, changes: Partial<CustomHeartbeat>) => {
      if (!config) return;
      const updatedTasks = customTasks.map((t) => (t.id === id ? { ...t, ...changes } : t));
      const updated = {
        ...config,
        heartbeat: {
          ...config.heartbeat,
          custom_tasks: updatedTasks,
        },
      };
      setConfig(updated);
      saveConfig(updated);
    },
    [config, customTasks, saveConfig]
  );

  const deleteCustomHeartbeat = useCallback(
    (id: string) => {
      if (!config) return;
      const updated = {
        ...config,
        heartbeat: {
          ...config.heartbeat,
          custom_tasks: customTasks.filter((t) => t.id !== id),
        },
      };
      setConfig(updated);
      saveConfig(updated);
    },
    [config, customTasks, saveConfig]
  );

  const [triggering, setTriggering] = useState<string | null>(null);

  const triggerHeartbeat = useCallback(async (taskId: string) => {
    setTriggering(taskId);
    try {
      const res = await fetch('/api/trigger-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, taskType: 'heartbeat' }),
      });
      const data = await res.json();
      if (data.success) {
        setTimeout(() => setTriggering(null), 2000);
      } else {
        setTriggering(null);
      }
    } catch {
      setTriggering(null);
    }
  }, []);

  const healthTask = config?.tasks?.system_health;

  return (
    <div className="space-y-6">
      {/* Signal Bridge Status */}
      <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50">
        <div className="flex items-center gap-3">
          <Heart className="h-5 w-5 text-primary" />
          <div>
            <h3 className="font-medium">Signal Bridge</h3>
            <p className="text-sm text-muted-foreground">
              Heartbeats and health checks run via the Signal Bridge service
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {bridgeStatus === 'connected' ? (
            <>
              <CheckCircle className="h-5 w-5 text-green-500" />
              <span className="text-sm text-green-600">Connected</span>
            </>
          ) : bridgeStatus === 'disconnected' ? (
            <>
              <XCircle className="h-5 w-5 text-red-500" />
              <span className="text-sm text-red-600">Disconnected</span>
            </>
          ) : (
            <>
              <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Checking...</span>
            </>
          )}
        </div>
      </div>

      {/* System Health Check */}
      <div className="space-y-4">
        <h3 className="text-lg font-medium flex items-center gap-2">
          <RefreshCw className="h-5 w-5" />
          System Health Check
          {saving && <span className="text-xs text-primary ml-2">Saving...</span>}
        </h3>

        <div className="flex items-center justify-between p-4 rounded-lg border bg-card">
          <div className="flex items-center gap-3">
            <RefreshCw className="h-4 w-4 text-green-500" />
            <div>
              <h4 className="font-medium">Periodic Health Check</h4>
              <p className="text-sm text-muted-foreground">
                Checks all services and alerts on Signal if issues are detected
              </p>
            </div>
          </div>
          <Switch
            checked={healthTask?.enabled ?? true}
            onCheckedChange={toggleHealthCheck}
          />
        </div>

        {healthTask?.enabled && (
          <div className="flex items-center gap-4 pl-4">
            <label className="text-sm text-muted-foreground">Check every</label>
            <Input
              type="number"
              min={5}
              max={120}
              value={healthTask?.interval_minutes ?? 30}
              onChange={(e) => updateInterval(parseInt(e.target.value) || 30)}
              className="w-20"
            />
            <span className="text-sm text-muted-foreground">minutes</span>
          </div>
        )}
      </div>

      {/* Custom Heartbeats */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            Custom Heartbeats
          </h3>
          <Button variant="outline" size="sm" onClick={addCustomHeartbeat}>
            <Plus className="h-4 w-4 mr-1" />
            Add Heartbeat
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Send periodic prompts to a Choom and receive responses via Signal. Great for selfies, check-ins, or recurring tasks.
        </p>

        {customTasks.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground text-sm border border-dashed rounded-lg">
            No custom heartbeats configured. Click &quot;Add Heartbeat&quot; to create one.
          </div>
        ) : (
          <div className="space-y-3">
            {customTasks.map((task) => (
              <div key={task.id} className="p-4 rounded-lg border bg-card space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-1">
                    <select
                      value={task.choom_name}
                      onChange={(e) => saveCustomHeartbeat(task.id, { choom_name: e.target.value })}
                      className="bg-muted border border-border rounded px-2 py-1 text-sm"
                    >
                      {chooms.map((c) => (
                        <option key={c.id} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">every</span>
                      <Input
                        type="number"
                        min={5}
                        value={task.interval_minutes}
                        onChange={(e) => updateCustomHeartbeat(task.id, { interval_minutes: parseInt(e.target.value) || 60 })}
                        onBlur={() => saveCustomHeartbeat(task.id, { interval_minutes: task.interval_minutes })}
                        className="w-20 text-sm"
                      />
                      <span className="text-sm text-muted-foreground">min</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => triggerHeartbeat(task.id)}
                      disabled={triggering === task.id}
                      title="Run Now"
                    >
                      {triggering === task.id ? (
                        <RefreshCw className="h-4 w-4 animate-spin text-primary" />
                      ) : (
                        <Play className="h-4 w-4" />
                      )}
                    </Button>
                    <Switch
                      checked={task.enabled}
                      onCheckedChange={(checked) => saveCustomHeartbeat(task.id, { enabled: checked })}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:bg-destructive/10"
                      onClick={() => deleteCustomHeartbeat(task.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <Textarea
                  value={task.prompt}
                  onChange={(e) => updateCustomHeartbeat(task.id, { prompt: e.target.value })}
                  onBlur={() => saveCustomHeartbeat(task.id, { prompt: task.prompt })}
                  placeholder="What should the Choom do? e.g. 'Send me a cute selfie'"
                  className="text-sm"
                  rows={2}
                />
                <div className="flex items-center gap-2">
                  <Switch
                    checked={task.respect_quiet}
                    onCheckedChange={(checked) => saveCustomHeartbeat(task.id, { respect_quiet: checked })}
                  />
                  <span className="text-sm text-muted-foreground">Respect quiet period</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quiet Period */}
      <div className="space-y-4">
        <h3 className="text-lg font-medium flex items-center gap-2">
          <Moon className="h-5 w-5" />
          Quiet Period
        </h3>
        <p className="text-sm text-muted-foreground">
          During quiet hours, health check alerts and custom heartbeats (with &quot;Respect quiet period&quot; enabled) are suppressed.
        </p>

        <div className="flex items-center gap-4 p-4 rounded-lg border bg-card">
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium">Start</label>
            <Input
              type="time"
              value={config?.heartbeat?.quiet_start ?? '21:00'}
              onChange={(e) => updateQuietPeriod('quiet_start', e.target.value)}
              className="w-28"
            />
          </div>
          <span className="text-muted-foreground">to</span>
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium">End</label>
            <Input
              type="time"
              value={config?.heartbeat?.quiet_end ?? '06:00'}
              onChange={(e) => updateQuietPeriod('quiet_end', e.target.value)}
              className="w-28"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
