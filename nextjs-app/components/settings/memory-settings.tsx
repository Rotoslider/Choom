'use client';

import React, { useState, useEffect } from 'react';
import { Database, RefreshCw, Archive, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { useAppStore } from '@/lib/store';
import type { MemoryStats } from '@/lib/types';

export function MemorySettingsPanel() {
  const { settings, updateMemorySettings } = useAppStore();
  const memory = settings.memory;

  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [actionStatus, setActionStatus] = useState<string | null>(null);

  const fetchStats = async () => {
    try {
      const response = await fetch(`${memory.endpoint}/memory/stats`);
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.data?.[0]) {
          setStats(data.data[0]);
        }
      }
    } catch (error) {
      console.error('Failed to fetch memory stats:', error);
    }
  };

  useEffect(() => {
    fetchStats();
  }, [memory.endpoint]);

  const handleBackup = async () => {
    setIsLoading(true);
    setActionStatus(null);
    try {
      const response = await fetch(`${memory.endpoint}/memory/backup`, {
        method: 'POST',
      });
      if (response.ok) {
        setActionStatus('Backup created successfully');
      } else {
        setActionStatus('Backup failed');
      }
    } catch (error) {
      setActionStatus('Backup failed: ' + (error as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRebuildVectors = async () => {
    setIsLoading(true);
    setActionStatus(null);
    try {
      const response = await fetch(`${memory.endpoint}/memory/rebuild_vectors`, {
        method: 'POST',
      });
      if (response.ok) {
        setActionStatus('Vector index rebuilt successfully');
        fetchStats();
      } else {
        setActionStatus('Rebuild failed');
      }
    } catch (error) {
      setActionStatus('Rebuild failed: ' + (error as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium mb-4">Memory System</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Configure the persistent memory server and view statistics
        </p>
      </div>

      {/* Endpoint */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Memory Server Endpoint</label>
        <Input
          value={memory.endpoint}
          onChange={(e) => updateMemorySettings({ endpoint: e.target.value })}
          placeholder="http://localhost:8100"
        />
      </div>

      {/* Auto-recall */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Auto-recall memories</label>
          <p className="text-xs text-muted-foreground">
            Automatically search relevant memories for context
          </p>
        </div>
        <Switch
          checked={memory.autoRecall}
          onCheckedChange={(checked) =>
            updateMemorySettings({ autoRecall: checked })
          }
        />
      </div>

      {/* Recall Limit */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">Recall Limit</label>
          <span className="text-sm text-muted-foreground">
            {memory.recallLimit}
          </span>
        </div>
        <Slider
          value={[memory.recallLimit]}
          onValueChange={([v]) => updateMemorySettings({ recallLimit: v })}
          min={1}
          max={20}
          step={1}
        />
        <p className="text-xs text-muted-foreground">
          Maximum memories to include in context
        </p>
      </div>

      {/* Statistics */}
      {stats && (
        <div className="p-4 rounded-lg bg-muted/50 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium flex items-center gap-2">
              <Database className="h-4 w-4" />
              Memory Statistics
            </h4>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchStats}
              className="h-7 w-7 p-0"
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-muted-foreground">Total memories:</span>
              <span className="ml-2 font-medium">{stats.total_memories}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Memory types:</span>
              <span className="ml-2 font-medium">{stats.memory_types}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Avg importance:</span>
              <span className="ml-2 font-medium">{stats.avg_importance}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Storage:</span>
              <span className="ml-2 font-medium">{stats.storage_size_mb} MB</span>
            </div>
          </div>

          {stats.type_breakdown && (
            <div className="pt-2 border-t border-border">
              <span className="text-xs text-muted-foreground">By type:</span>
              <div className="flex flex-wrap gap-2 mt-1">
                {Object.entries(stats.type_breakdown).map(([type, count]) => (
                  <span
                    key={type}
                    className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary"
                  >
                    {type}: {count}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Maintenance Actions */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium">Maintenance</h4>

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleBackup}
            disabled={isLoading}
            className="gap-1"
          >
            <Archive className="h-4 w-4" />
            Create Backup
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRebuildVectors}
            disabled={isLoading}
            className="gap-1"
          >
            <RefreshCw className="h-4 w-4" />
            Rebuild Vectors
          </Button>
        </div>

        {actionStatus && (
          <p
            className={`text-xs ${actionStatus.includes('failed') ? 'text-red-400' : 'text-green-400'}`}
          >
            {actionStatus}
          </p>
        )}
      </div>
    </div>
  );
}
