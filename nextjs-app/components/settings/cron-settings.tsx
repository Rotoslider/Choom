'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Clock, Calendar, Sun, Zap, Music, ChevronDown, ChevronRight, Info, Play, RefreshCw } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface TaskConfig {
  enabled: boolean;
  time?: string;
  interval_minutes?: number;
}

interface BridgeConfig {
  tasks: Record<string, TaskConfig>;
  heartbeat: {
    quiet_start: string;
    quiet_end: string;
  };
}

const TASK_META: Record<string, { name: string; description: string; details: string; choom: string; icon: React.ReactNode }> = {
  morning_briefing: {
    name: 'Morning Briefing',
    description: 'Comprehensive daily briefing via Signal',
    details: 'Fetches real weather data, calendar events, and pending reminders. Sends them to the assigned Choom which generates a natural spoken briefing. Includes system health status. Uses a fresh chat to avoid stale context.',
    choom: 'Default Choom',
    icon: <Sun className="h-4 w-4 text-yellow-500" />,
  },
  'weather_check_07:00': {
    name: 'Weather Check (Morning)',
    description: 'Log-only weather check',
    details: 'Fetches current weather conditions and logs them. Does NOT send a Signal message currently. Useful for tracking weather patterns in the activity log.',
    choom: 'System (no Choom)',
    icon: <Clock className="h-4 w-4 text-blue-500" />,
  },
  'weather_check_12:00': {
    name: 'Weather Check (Noon)',
    description: 'Log-only weather check',
    details: 'Fetches current weather conditions and logs them. Does NOT send a Signal message currently.',
    choom: 'System (no Choom)',
    icon: <Clock className="h-4 w-4 text-blue-500" />,
  },
  'weather_check_18:00': {
    name: 'Weather Check (Evening)',
    description: 'Log-only weather check',
    details: 'Fetches current weather conditions and logs them. Does NOT send a Signal message currently.',
    choom: 'System (no Choom)',
    icon: <Clock className="h-4 w-4 text-blue-500" />,
  },
  'aurora_check_12:00': {
    name: 'Aurora Forecast (Noon)',
    description: 'Downloads NOAA aurora images and sends via Signal',
    details: 'Downloads the northern hemisphere aurora forecast and Kp index images from NOAA SWPC. Sends both images via Signal with a summary. Includes TTS audio narration.',
    choom: 'Default Choom',
    icon: <Zap className="h-4 w-4 text-purple-500" />,
  },
  'aurora_check_18:00': {
    name: 'Aurora Forecast (Evening)',
    description: 'Downloads NOAA aurora images and sends via Signal',
    details: 'Downloads the northern hemisphere aurora forecast and Kp index images from NOAA SWPC. Sends both images via Signal with a summary. Includes TTS audio narration.',
    choom: 'Default Choom',
    icon: <Zap className="h-4 w-4 text-purple-500" />,
  },
  yt_download: {
    name: 'YouTube Music Download',
    description: 'Downloads new music from configured YouTube channels',
    details: 'Checks each configured YouTube channel for new videos, downloads them as high-quality MP3s with full ID3 tags (artist, title, album, year) and embedded album art. Per-channel download history prevents re-downloading. Configure channels in the YouTube DL settings tab.',
    choom: 'System (no Choom)',
    icon: <Music className="h-4 w-4 text-red-500" />,
  },
  db_backup: {
    name: 'Database Backup',
    description: 'Backs up dev.db and memories.db to Google Drive',
    details: 'Uploads date-stamped copies of the Prisma database (dev.db) and long-term memory database (memories.db) to a "Choom Backup" folder in Google Drive. Creates the folder if it doesn\'t exist.',
    choom: 'System (no Choom)',
    icon: <Calendar className="h-4 w-4 text-green-500" />,
  },
};

export function CronSettings() {
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/bridge-config')
      .then((r) => r.json())
      .then(setConfig)
      .catch(console.error);
  }, []);

  const saveConfig = useCallback(
    async (updated: BridgeConfig) => {
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
    },
    []
  );

  const toggleTask = useCallback(
    (taskId: string) => {
      if (!config) return;
      const updated = {
        ...config,
        tasks: {
          ...config.tasks,
          [taskId]: {
            ...config.tasks[taskId],
            enabled: !config.tasks[taskId]?.enabled,
          },
        },
      };
      setConfig(updated);
      saveConfig(updated);
    },
    [config, saveConfig]
  );

  const updateTaskTimeLocal = useCallback(
    (taskId: string, time: string) => {
      if (!config) return;
      // Update local state only (no save yet)
      setConfig({
        ...config,
        tasks: {
          ...config.tasks,
          [taskId]: {
            ...config.tasks[taskId],
            time,
          },
        },
      });
    },
    [config]
  );

  const commitTaskTime = useCallback(
    (taskId: string) => {
      if (!config) return;
      // Save on blur — only if time is valid
      const time = config.tasks[taskId]?.time;
      if (time && /^\d{2}:\d{2}$/.test(time)) {
        saveConfig(config);
      }
    },
    [config, saveConfig]
  );

  const [triggering, setTriggering] = useState<string | null>(null);

  const triggerTask = useCallback(async (taskId: string) => {
    setTriggering(taskId);
    try {
      const res = await fetch('/api/trigger-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, taskType: 'cron' }),
      });
      const data = await res.json();
      if (data.success) {
        // Brief visual feedback then clear
        setTimeout(() => setTriggering(null), 2000);
      } else {
        setTriggering(null);
      }
    } catch {
      setTriggering(null);
    }
  }, []);

  if (!config) {
    return <div className="text-sm text-muted-foreground">Loading config...</div>;
  }

  // Sort tasks: cron jobs only (exclude system_health)
  const cronTasks = Object.entries(config.tasks).filter(([id]) => id !== 'system_health');

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-medium mb-2 flex items-center gap-2">
          <Calendar className="h-5 w-5" />
          Cron Jobs
        </h3>
        <p className="text-sm text-muted-foreground mb-4">
          Scheduled tasks that run automatically. Toggle to enable/disable, click the time to edit. Click the chevron for details.
          {saving && <span className="ml-2 text-xs text-primary">Saving...</span>}
        </p>
      </div>

      <div className="space-y-3">
        {cronTasks.map(([taskId, taskConfig]) => {
          const meta = TASK_META[taskId] || {
            name: taskId,
            description: '',
            details: '',
            choom: 'Unknown',
            icon: <Clock className="h-4 w-4 text-muted-foreground" />,
          };
          const isExpanded = expandedTask === taskId;

          return (
            <div key={taskId} className="rounded-lg border bg-card">
              <div className="flex items-center justify-between p-4 hover:bg-accent/50 transition-colors">
                <div className="flex items-center gap-3 flex-1">
                  <button
                    className="text-muted-foreground hover:text-foreground flex-shrink-0"
                    onClick={() => setExpandedTask(isExpanded ? null : taskId)}
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </button>
                  {meta.icon}
                  <div className="flex-1">
                    <h4 className="font-medium">{meta.name}</h4>
                    <p className="text-sm text-muted-foreground">{meta.description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {'time' in taskConfig && (
                    <Input
                      type="time"
                      value={taskConfig.time || ''}
                      onChange={(e) => updateTaskTimeLocal(taskId, e.target.value)}
                      onBlur={() => commitTaskTime(taskId)}
                      className="w-28 text-sm"
                      disabled={!taskConfig.enabled}
                    />
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => triggerTask(taskId)}
                    disabled={triggering === taskId}
                    title="Run Now"
                  >
                    {triggering === taskId ? (
                      <RefreshCw className="h-4 w-4 animate-spin text-primary" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                  </Button>
                  <Switch
                    checked={taskConfig.enabled}
                    onCheckedChange={() => toggleTask(taskId)}
                  />
                </div>
              </div>

              {/* Expandable detail panel */}
              {isExpanded && meta.details && (
                <div className="px-4 pb-4 pt-0 border-t border-border/50">
                  <div className="mt-3 space-y-2 text-sm">
                    <div className="flex items-start gap-2">
                      <Info className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                      <p className="text-muted-foreground">{meta.details}</p>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground/70">
                      <span className="font-medium">Assigned Choom:</span>
                      <span>{meta.choom}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-6">
        <h3 className="text-lg font-medium mb-2 flex items-center gap-2">
          Quick Commands
        </h3>
        <p className="text-sm text-muted-foreground mb-3">
          Use these commands via Signal to manage tasks:
        </p>
        <div className="grid gap-2 text-sm">
          <div className="p-3 rounded bg-muted/50 font-mono">remind me in 30 minutes to check the oven</div>
          <div className="p-3 rounded bg-muted/50 font-mono">remind me at 3pm to call mom</div>
          <div className="p-3 rounded bg-muted/50 font-mono">calendar this week</div>
          <div className="p-3 rounded bg-muted/50 font-mono">add to groceries: milk</div>
          <div className="p-3 rounded bg-muted/50 font-mono">show groceries</div>
        </div>
      </div>
    </div>
  );
}
