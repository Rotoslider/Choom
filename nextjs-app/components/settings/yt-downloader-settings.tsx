'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Music, Plus, Trash2, ExternalLink, Play, RefreshCw } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface Channel {
  id: string;
  url: string;
  name: string;
  enabled: boolean;
}

interface YTDownloaderConfig {
  max_videos_per_channel: number;
  channels: Channel[];
}

interface BridgeConfig {
  yt_downloader?: YTDownloaderConfig;
  [key: string]: unknown;
}

function extractChannelName(url: string): string {
  // Extract @Name from YouTube URL patterns
  const match = url.match(/@([A-Za-z0-9_-]+)/);
  if (match) return match[1];
  // Fallback: extract last path segment
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  } catch {
    // ignore
  }
  return 'Unknown Channel';
}

export function YTDownloaderSettings() {
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newName, setNewName] = useState('');
  const [triggering, setTriggering] = useState(false);

  useEffect(() => {
    fetch('/api/bridge-config')
      .then((r) => r.json())
      .then(setConfig)
      .catch(console.error);
  }, []);

  const ytConfig = config?.yt_downloader || { max_videos_per_channel: 3, channels: [] };

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
        console.error('Failed to save config:', err);
      } finally {
        setSaving(false);
      }
    },
    []
  );

  const addChannel = useCallback(() => {
    if (!config || !newUrl.trim()) return;
    const name = newName.trim() || extractChannelName(newUrl.trim());
    const channel: Channel = {
      id: `yt_ch_${Date.now()}`,
      url: newUrl.trim(),
      name,
      enabled: true,
    };
    const updated = {
      ...config,
      yt_downloader: {
        ...ytConfig,
        channels: [...ytConfig.channels, channel],
      },
    };
    setNewUrl('');
    setNewName('');
    saveConfig(updated);
  }, [config, ytConfig, newUrl, newName, saveConfig]);

  const removeChannel = useCallback(
    (id: string) => {
      if (!config) return;
      const updated = {
        ...config,
        yt_downloader: {
          ...ytConfig,
          channels: ytConfig.channels.filter((c) => c.id !== id),
        },
      };
      saveConfig(updated);
    },
    [config, ytConfig, saveConfig]
  );

  const toggleChannel = useCallback(
    (id: string) => {
      if (!config) return;
      const updated = {
        ...config,
        yt_downloader: {
          ...ytConfig,
          channels: ytConfig.channels.map((c) =>
            c.id === id ? { ...c, enabled: !c.enabled } : c
          ),
        },
      };
      saveConfig(updated);
    },
    [config, ytConfig, saveConfig]
  );

  const updateMaxVideos = useCallback(
    (val: number) => {
      if (!config) return;
      const updated = {
        ...config,
        yt_downloader: {
          ...ytConfig,
          max_videos_per_channel: Math.max(1, Math.min(50, val)),
        },
      };
      saveConfig(updated);
    },
    [config, ytConfig, saveConfig]
  );

  const runNow = useCallback(async () => {
    setTriggering(true);
    try {
      const res = await fetch('/api/trigger-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: 'yt_download', taskType: 'cron' }),
      });
      const data = await res.json();
      if (data.success) {
        setTimeout(() => setTriggering(false), 3000);
      } else {
        setTriggering(false);
      }
    } catch {
      setTriggering(false);
    }
  }, []);

  if (!config) {
    return <div className="text-sm text-muted-foreground">Loading config...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium mb-2 flex items-center gap-2">
          <Music className="h-5 w-5" />
          YouTube Music Downloader
        </h3>
        <p className="text-sm text-muted-foreground mb-4">
          Automatically download music from YouTube channels as high-quality MP3s with
          ID3 tags and album art. Schedule time is set in the Cron Jobs tab.
          {saving && <span className="ml-2 text-xs text-primary">Saving...</span>}
        </p>
      </div>

      {/* Max videos per channel */}
      <div className="flex items-center gap-4">
        <label className="text-sm font-medium">Max videos per channel per run:</label>
        <Input
          type="number"
          min={1}
          max={50}
          value={ytConfig.max_videos_per_channel}
          onChange={(e) => updateMaxVideos(parseInt(e.target.value) || 3)}
          className="w-20"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={runNow}
          disabled={triggering || ytConfig.channels.length === 0}
          className="gap-2"
        >
          {triggering ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          Run Now
        </Button>
      </div>

      {/* Channel list */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium">Channels</h4>

        {ytConfig.channels.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center border rounded-lg border-dashed">
            No channels configured. Add one below.
          </p>
        ) : (
          ytConfig.channels.map((ch) => (
            <div
              key={ch.id}
              className="flex items-center gap-3 p-3 rounded-lg border bg-card"
            >
              <Switch
                checked={ch.enabled}
                onCheckedChange={() => toggleChannel(ch.id)}
              />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm truncate">{ch.name}</div>
                <div className="text-xs text-muted-foreground truncate">{ch.url}</div>
              </div>
              <a
                href={ch.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive hover:text-destructive"
                onClick={() => removeChannel(ch.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))
        )}
      </div>

      {/* Add channel form */}
      <div className="space-y-3 p-4 rounded-lg border border-dashed">
        <h4 className="text-sm font-medium">Add Channel</h4>
        <div className="flex gap-2">
          <Input
            placeholder="https://www.youtube.com/@ChannelName"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            className="flex-1"
            onKeyDown={(e) => e.key === 'Enter' && addChannel()}
          />
          <Input
            placeholder="Display name (optional)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-48"
            onKeyDown={(e) => e.key === 'Enter' && addChannel()}
          />
          <Button onClick={addChannel} disabled={!newUrl.trim()} className="gap-2">
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Paste a YouTube channel URL. The display name is auto-extracted from the @handle if not provided.
        </p>
      </div>

      {/* Info box */}
      <div className="p-4 rounded-lg bg-muted/50 text-sm space-y-1">
        <p className="font-medium">How it works</p>
        <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
          <li>Downloads are saved to <code className="text-xs">~/choom-projects/YouTube_Music/ChannelName/</code></li>
          <li>Each channel has its own download history to avoid re-downloading</li>
          <li>MP3s include ID3 tags: artist, title, album, year, genre, and embedded album art</li>
          <li>A Signal notification is sent when new downloads complete or errors occur</li>
          <li>2-second delay between downloads to avoid rate limiting</li>
        </ul>
      </div>
    </div>
  );
}
