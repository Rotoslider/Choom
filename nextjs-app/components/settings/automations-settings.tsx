'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { AutomationList } from './automation-list';
import { AutomationBuilder } from './automation-builder';

interface Automation {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: {
    type: 'cron' | 'interval';
    cron?: string;
    hour?: number;
    minute?: number;
    daysOfWeek?: number[];
    intervalMinutes?: number;
  };
  choomName: string;
  respectQuiet: boolean;
  notifyOnComplete: boolean;
  steps: Array<{
    id: string;
    skillName: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }>;
  conditions?: Array<{
    id: string;
    type: 'weather' | 'time_range' | 'day_of_week' | 'calendar' | 'no_condition';
    field?: string;
    op?: string;
    value?: number;
    after?: string;
    before?: string;
    days?: number[];
    has_events?: boolean;
    keyword?: string;
  }>;
  conditionLogic?: 'all' | 'any';
  cooldown?: { minutes: number };
  lastRun?: string;
  lastResult?: 'success' | 'partial' | 'failed';
  lastConditionMet?: string;
}

export function AutomationsSettings() {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingAutomation, setEditingAutomation] = useState<Automation | null>(null);
  const [triggeringId, setTriggeringId] = useState<string | null>(null);

  const fetchAutomations = useCallback(async () => {
    try {
      const res = await fetch('/api/automations');
      if (res.ok) {
        const data = await res.json();
        setAutomations(data.automations || []);
      }
    } catch (err) {
      console.error('Failed to fetch automations:', err);
    }
  }, []);

  useEffect(() => {
    fetchAutomations();
  }, [fetchAutomations]);

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await fetch('/api/automations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enabled }),
      });
      setAutomations(prev => prev.map(a => a.id === id ? { ...a, enabled } : a));
    } catch (err) {
      console.error('Failed to toggle automation:', err);
    }
  };

  const handleRunNow = async (id: string) => {
    setTriggeringId(id);
    try {
      await fetch('/api/automations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'trigger', automationId: id }),
      });
    } catch (err) {
      console.error('Failed to trigger automation:', err);
    } finally {
      setTimeout(() => setTriggeringId(null), 2000);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/automations?id=${id}`, { method: 'DELETE' });
      setAutomations(prev => prev.filter(a => a.id !== id));
    } catch (err) {
      console.error('Failed to delete automation:', err);
    }
  };

  const handleCreate = () => {
    setEditingAutomation(null);
    setBuilderOpen(true);
  };

  const handleEdit = (automation: Automation) => {
    setEditingAutomation(automation);
    setBuilderOpen(true);
  };

  const handleSaved = () => {
    setBuilderOpen(false);
    setEditingAutomation(null);
    fetchAutomations();
  };

  return (
    <>
      <AutomationList
        automations={automations}
        onToggle={handleToggle}
        onRunNow={handleRunNow}
        onCreate={handleCreate}
        onEdit={handleEdit}
        onDelete={handleDelete}
        triggeringId={triggeringId}
      />
      <AutomationBuilder
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        editingAutomation={editingAutomation}
        onSave={async (automation) => {
          try {
            if (editingAutomation) {
              await fetch('/api/automations', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...automation, id: editingAutomation.id }),
              });
            } else {
              await fetch('/api/automations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(automation),
              });
            }
            handleSaved();
          } catch (err) {
            console.error('Failed to save automation:', err);
          }
        }}
      />
    </>
  );
}
