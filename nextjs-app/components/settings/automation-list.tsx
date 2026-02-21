'use client';

import React from 'react';
import {
  Workflow,
  Play,
  RefreshCw,
  Pencil,
  Trash2,
  Plus,
  Clock,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Filter,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';

// ============================================================================
// Types
// ============================================================================

interface AutomationStep {
  id: string;
  skillName: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

interface AutomationSchedule {
  type: 'cron' | 'interval';
  cron?: string;
  hour?: number;
  minute?: number;
  daysOfWeek?: number[];
  intervalMinutes?: number;
}

interface AutomationCondition {
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
}

export interface Automation {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: AutomationSchedule;
  choomName: string;
  respectQuiet: boolean;
  notifyOnComplete: boolean;
  steps: AutomationStep[];
  conditions?: AutomationCondition[];
  conditionLogic?: 'all' | 'any';
  cooldown?: { minutes: number };
  lastRun?: string;
  lastResult?: 'success' | 'partial' | 'failed';
  lastConditionMet?: string;
}

interface AutomationListProps {
  automations: Automation[];
  onToggle: (id: string, enabled: boolean) => void;
  onRunNow: (id: string) => void;
  onCreate: () => void;
  onEdit: (automation: Automation) => void;
  onDelete: (id: string) => void;
  triggeringId?: string | null;
}

// ============================================================================
// Helpers
// ============================================================================

const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function describeSchedule(schedule: AutomationSchedule): string {
  if (schedule.type === 'interval') {
    const mins = schedule.intervalMinutes || 60;
    if (mins >= 60) {
      const hours = Math.floor(mins / 60);
      const remaining = mins % 60;
      return remaining > 0
        ? `Every ${hours}h ${remaining}m`
        : `Every ${hours}h`;
    }
    return `Every ${mins}m`;
  }

  // Cron-type schedule
  const hour = schedule.hour ?? 0;
  const minute = schedule.minute ?? 0;
  const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const days = schedule.daysOfWeek;

  if (!days || days.length === 0 || days.length === 7) {
    return `Daily at ${timeStr}`;
  }

  // Check for weekdays/weekends
  const weekdays = [1, 2, 3, 4, 5];
  const weekends = [0, 6];
  const sortedDays = [...days].sort((a, b) => a - b);

  if (sortedDays.length === 5 && weekdays.every((d) => sortedDays.includes(d))) {
    return `Weekdays at ${timeStr}`;
  }
  if (sortedDays.length === 2 && weekends.every((d) => sortedDays.includes(d))) {
    return `Weekends at ${timeStr}`;
  }

  const dayNames = sortedDays.map((d) => DAY_NAMES_SHORT[d]).join(', ');
  return `${dayNames} at ${timeStr}`;
}

function formatLastRun(iso: string): string {
  try {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  } catch {
    return 'Unknown';
  }
}

function describeConditions(conditions?: AutomationCondition[], logic?: 'all' | 'any'): string | null {
  if (!conditions || conditions.length === 0) return null;

  const parts = conditions.map((c) => {
    switch (c.type) {
      case 'weather':
        return `${c.field || 'temp'} ${c.op || '<'} ${c.value ?? 0}`;
      case 'time_range':
        return `${c.after || '00:00'}-${c.before || '23:59'}`;
      case 'day_of_week': {
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        return (c.days || []).map((d) => dayNames[d]).join(',') || 'any day';
      }
      case 'calendar':
        return c.keyword ? `cal:"${c.keyword}"` : c.has_events !== false ? 'has events' : 'no events';
      default:
        return c.type;
    }
  });

  const joiner = logic === 'any' ? ' OR ' : ' AND ';
  return parts.join(joiner);
}

function getResultBadge(result: 'success' | 'partial' | 'failed') {
  switch (result) {
    case 'success':
      return (
        <Badge className="bg-green-500/20 text-green-400 border-green-500/30 hover:bg-green-500/20">
          <CheckCircle2 className="h-3 w-3 mr-1" />
          Success
        </Badge>
      );
    case 'partial':
      return (
        <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/20">
          <AlertTriangle className="h-3 w-3 mr-1" />
          Partial
        </Badge>
      );
    case 'failed':
      return (
        <Badge variant="destructive" className="bg-red-500/20 text-red-400 border-red-500/30 hover:bg-red-500/20">
          <XCircle className="h-3 w-3 mr-1" />
          Failed
        </Badge>
      );
  }
}

// ============================================================================
// Component
// ============================================================================

export function AutomationList({
  automations,
  onToggle,
  onRunNow,
  onCreate,
  onEdit,
  onDelete,
  triggeringId,
}: AutomationListProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium flex items-center gap-2">
            <Workflow className="h-5 w-5" />
            Automations
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            Scheduled task chains that run skills in sequence. Each automation executes one or more tools on a schedule.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onCreate}>
          <Plus className="h-4 w-4 mr-1" />
          Create Automation
        </Button>
      </div>

      {automations.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm border border-dashed rounded-lg">
          <Workflow className="h-8 w-8 mx-auto mb-3 opacity-50" />
          <p>No automations configured yet.</p>
          <p className="mt-1">Click &quot;Create Automation&quot; to build your first task chain.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {automations.map((automation) => (
            <div
              key={automation.id}
              className="rounded-lg border bg-card hover:bg-accent/30 transition-colors"
            >
              <div className="p-4">
                {/* Top row: name, badges, actions */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="font-medium truncate">{automation.name}</h4>
                      <Badge variant="outline" className="text-xs shrink-0">
                        {automation.steps.length} step{automation.steps.length !== 1 ? 's' : ''}
                      </Badge>
                      {automation.conditions && automation.conditions.length > 0 && (
                        <Badge variant="outline" className="text-xs shrink-0 gap-1">
                          <Filter className="h-3 w-3" />
                          {automation.conditions.length} condition{automation.conditions.length !== 1 ? 's' : ''}
                        </Badge>
                      )}
                      {automation.lastResult && getResultBadge(automation.lastResult)}
                    </div>
                    {automation.description && (
                      <p className="text-sm text-muted-foreground mt-1 line-clamp-1">
                        {automation.description}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => onRunNow(automation.id)}
                      disabled={triggeringId === automation.id}
                      title="Run Now"
                    >
                      {triggeringId === automation.id ? (
                        <RefreshCw className="h-4 w-4 animate-spin text-primary" />
                      ) : (
                        <Play className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => onEdit(automation)}
                      title="Edit"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:bg-destructive/10"
                      onClick={() => onDelete(automation.id)}
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    <Switch
                      checked={automation.enabled}
                      onCheckedChange={(checked) => onToggle(automation.id, checked)}
                    />
                  </div>
                </div>

                {/* Bottom row: schedule, choom, last run */}
                <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground flex-wrap">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {describeSchedule(automation.schedule)}
                  </span>
                  <span className="flex items-center gap-1">
                    Target: <span className="text-foreground font-medium">{automation.choomName}</span>
                  </span>
                  {automation.conditions && automation.conditions.length > 0 && (
                    <span className="flex items-center gap-1 text-muted-foreground/80">
                      <Filter className="h-3 w-3" />
                      {describeConditions(automation.conditions, automation.conditionLogic)}
                      {automation.cooldown && automation.cooldown.minutes > 0 && (
                        <span className="ml-1">(cd: {automation.cooldown.minutes}m)</span>
                      )}
                    </span>
                  )}
                  {automation.respectQuiet && (
                    <span className="text-muted-foreground/60">Quiet hours</span>
                  )}
                  {automation.notifyOnComplete && (
                    <span className="text-muted-foreground/60">Notify</span>
                  )}
                  {automation.lastRun && (
                    <span className="ml-auto">
                      Last run: {formatLastRun(automation.lastRun)}
                    </span>
                  )}
                </div>

                {/* Step summary */}
                <div className="flex items-center gap-1 mt-2 overflow-x-auto">
                  {automation.steps.map((step, i) => (
                    <React.Fragment key={step.id}>
                      {i > 0 && (
                        <span className="text-muted-foreground/40 text-xs mx-0.5">&rarr;</span>
                      )}
                      <span className="text-xs bg-muted/60 px-2 py-0.5 rounded whitespace-nowrap">
                        {step.toolName}
                      </span>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
