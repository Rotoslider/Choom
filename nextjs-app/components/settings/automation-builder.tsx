'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Plus,
  Trash2,
  Loader2,
  Zap,
  GripVertical,
  AlertCircle,
  Wand2,
  Filter,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

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
  type: 'weather' | 'time_range' | 'day_of_week' | 'calendar' | 'home_assistant' | 'no_condition';
  // Weather fields
  field?: string;
  op?: string;
  value?: number;
  // Time range fields
  after?: string;
  before?: string;
  // Day of week fields
  days?: number[];
  // Calendar fields
  has_events?: boolean;
  keyword?: string;
  // Home Assistant fields
  entity_id?: string;
  ha_value?: string;
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

interface SkillToolInfo {
  name: string;
  description: string;
}

interface SkillInfo {
  name: string;
  description: string;
  enabled?: boolean;
  tools: SkillToolInfo[];
}

interface ChoomOption {
  id: string;
  name: string;
}

interface ToolParamDef {
  type: string;
  description: string;
  enum?: string[];
  default?: unknown;
}

interface ToolDetailedInfo {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, ToolParamDef>;
    required?: string[];
  };
}

interface AutomationBuilderProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (automation: Partial<Automation>) => Promise<void>;
  editingAutomation?: Automation | null;
}

// ============================================================================
// Day of week helpers
// ============================================================================

const DAYS_OF_WEEK = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

// ============================================================================
// Component
// ============================================================================

export function AutomationBuilder({
  open,
  onOpenChange,
  onSave,
  editingAutomation,
}: AutomationBuilderProps) {
  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scheduleType, setScheduleType] = useState<'cron' | 'interval'>('cron');
  const [hour, setHour] = useState(7);
  const [minute, setMinute] = useState(0);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([]);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [choomName, setChoomName] = useState('Choom');
  const [respectQuiet, setRespectQuiet] = useState(true);
  const [notifyOnComplete, setNotifyOnComplete] = useState(true);
  const [steps, setSteps] = useState<AutomationStep[]>([
    { id: `step_${Date.now()}`, skillName: '', toolName: '', arguments: {} },
  ]);
  const [conditions, setConditions] = useState<AutomationCondition[]>([]);
  const [conditionLogic, setConditionLogic] = useState<'all' | 'any'>('all');
  const [cooldownMinutes, setCooldownMinutes] = useState(0);

  // Data fetching state
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [chooms, setChooms] = useState<ChoomOption[]>([]);
  const [skillToolDetails, setSkillToolDetails] = useState<Record<string, ToolDetailedInfo[]>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ========================================================================
  // Fetch skills and chooms on mount
  // ========================================================================

  useEffect(() => {
    if (!open) return;

    // Fetch skills
    fetch('/api/skills')
      .then((r) => r.json())
      .then((data) => {
        if (data.success && Array.isArray(data.skills)) {
          setSkills(data.skills);

          // Build a tool details map keyed by skill name
          // The skills API returns tools with name/description
          // For parameter details, we need the full tool definitions
          const detailMap: Record<string, ToolDetailedInfo[]> = {};
          for (const skill of data.skills) {
            detailMap[skill.name] = (skill.tools || []).map((t: SkillToolInfo) => ({
              name: t.name,
              description: t.description,
              parameters: { type: 'object', properties: {}, required: [] },
            }));
          }
          setSkillToolDetails(detailMap);
        }
      })
      .catch(console.error);

    // Fetch chooms
    fetch('/api/chooms')
      .then((r) => r.json())
      .then((data) => {
        const list = Array.isArray(data) ? data : data.chooms || [];
        setChooms(list.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })));
      })
      .catch(console.error);
  }, [open]);

  // ========================================================================
  // Populate form when editing
  // ========================================================================

  useEffect(() => {
    if (editingAutomation && open) {
      setName(editingAutomation.name);
      setDescription(editingAutomation.description);
      setScheduleType(editingAutomation.schedule.type);
      setHour(editingAutomation.schedule.hour ?? 7);
      setMinute(editingAutomation.schedule.minute ?? 0);
      setDaysOfWeek(editingAutomation.schedule.daysOfWeek ?? []);
      setIntervalMinutes(editingAutomation.schedule.intervalMinutes ?? 60);
      setChoomName(editingAutomation.choomName);
      setRespectQuiet(editingAutomation.respectQuiet);
      setNotifyOnComplete(editingAutomation.notifyOnComplete);
      setSteps(
        editingAutomation.steps.length > 0
          ? editingAutomation.steps
          : [{ id: `step_${Date.now()}`, skillName: '', toolName: '', arguments: {} }]
      );
      setConditions(editingAutomation.conditions || []);
      setConditionLogic(editingAutomation.conditionLogic || 'all');
      setCooldownMinutes(editingAutomation.cooldown?.minutes || 0);
    } else if (!editingAutomation && open) {
      // Reset form for creating new
      setName('');
      setDescription('');
      setScheduleType('cron');
      setHour(7);
      setMinute(0);
      setDaysOfWeek([]);
      setIntervalMinutes(60);
      setChoomName('Genesis');
      setRespectQuiet(true);
      setNotifyOnComplete(true);
      setSteps([{ id: `step_${Date.now()}`, skillName: '', toolName: '', arguments: {} }]);
      setConditions([]);
      setConditionLogic('all');
      setCooldownMinutes(0);
      setError(null);
    }
  }, [editingAutomation, open]);

  // ========================================================================
  // Step management
  // ========================================================================

  const addStep = useCallback(() => {
    setSteps((prev) => [
      ...prev,
      { id: `step_${Date.now()}`, skillName: '', toolName: '', arguments: {} },
    ]);
  }, []);

  const removeStep = useCallback((index: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const updateStepSkill = useCallback(
    (index: number, skillName: string) => {
      setSteps((prev) => {
        const updated = [...prev];
        updated[index] = { ...updated[index], skillName, toolName: '', arguments: {} };
        return updated;
      });
    },
    []
  );

  const updateStepTool = useCallback((index: number, toolName: string) => {
    setSteps((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], toolName, arguments: {} };
      return updated;
    });
  }, []);

  const updateStepArg = useCallback(
    (index: number, key: string, value: unknown) => {
      setSteps((prev) => {
        const updated = [...prev];
        updated[index] = {
          ...updated[index],
          arguments: { ...updated[index].arguments, [key]: value },
        };
        return updated;
      });
    },
    []
  );

  const removeStepArg = useCallback((index: number, key: string) => {
    setSteps((prev) => {
      const updated = [...prev];
      const args = { ...updated[index].arguments };
      delete args[key];
      updated[index] = { ...updated[index], arguments: args };
      return updated;
    });
  }, []);

  // ========================================================================
  // Day toggle
  // ========================================================================

  const toggleDay = useCallback((day: number) => {
    setDaysOfWeek((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  }, []);

  // ========================================================================
  // Get tools for a selected skill
  // ========================================================================

  const getToolsForSkill = useCallback(
    (skillName: string): SkillToolInfo[] => {
      const skill = skills.find((s) => s.name === skillName);
      return skill?.tools || [];
    },
    [skills]
  );

  // ========================================================================
  // Get parameter definitions for a tool
  // ========================================================================

  const getToolParams = useCallback(
    (skillName: string, toolName: string): Record<string, ToolParamDef> => {
      const detail = skillToolDetails[skillName]?.find((t) => t.name === toolName);
      return detail?.parameters?.properties || {};
    },
    [skillToolDetails]
  );

  const getToolRequired = useCallback(
    (skillName: string, toolName: string): string[] => {
      const detail = skillToolDetails[skillName]?.find((t) => t.name === toolName);
      return detail?.parameters?.required || [];
    },
    [skillToolDetails]
  );

  // ========================================================================
  // Validation
  // ========================================================================

  const isValid = useMemo(() => {
    if (!name.trim()) return false;
    if (steps.length === 0) return false;
    // At least the first step must have skill + tool
    if (!steps[0].skillName || !steps[0].toolName) return false;
    // All steps with skill selected must also have tool selected
    for (const step of steps) {
      if (step.skillName && !step.toolName) return false;
    }
    if (scheduleType === 'interval' && (!intervalMinutes || intervalMinutes < 1)) return false;
    return true;
  }, [name, steps, scheduleType, intervalMinutes]);

  // ========================================================================
  // Save handler
  // ========================================================================

  const handleSave = useCallback(async () => {
    if (!isValid) return;
    setSaving(true);
    setError(null);

    try {
      // Filter out empty steps
      const validSteps = steps.filter((s) => s.skillName && s.toolName);

      const automationData: Partial<Automation> = {
        ...(editingAutomation ? { id: editingAutomation.id } : {}),
        name: name.trim(),
        description: description.trim(),
        schedule: {
          type: scheduleType,
          ...(scheduleType === 'cron'
            ? { hour, minute, daysOfWeek }
            : { intervalMinutes }),
        },
        choomName,
        respectQuiet,
        notifyOnComplete,
        steps: validSteps,
        conditions: conditions.length > 0 ? conditions : undefined,
        conditionLogic: conditions.length > 1 ? conditionLogic : undefined,
        cooldown: cooldownMinutes > 0 ? { minutes: cooldownMinutes } : undefined,
      };

      await onSave(automationData);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save automation');
    } finally {
      setSaving(false);
    }
  }, [
    isValid,
    steps,
    name,
    description,
    scheduleType,
    hour,
    minute,
    daysOfWeek,
    intervalMinutes,
    choomName,
    respectQuiet,
    notifyOnComplete,
    conditions,
    conditionLogic,
    cooldownMinutes,
    editingAutomation,
    onSave,
    onOpenChange,
  ]);

  // ========================================================================
  // Test Run handler
  // ========================================================================

  const handleTestRun = useCallback(async () => {
    if (!editingAutomation) return;
    setTesting(true);
    try {
      const res = await fetch('/api/automations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'trigger',
          automationId: editingAutomation.id,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Test run failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test run failed');
    } finally {
      setTimeout(() => setTesting(false), 2000);
    }
  }, [editingAutomation]);

  // ========================================================================
  // Render
  // ========================================================================

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-5 w-5" />
            {editingAutomation ? 'Edit Automation' : 'Create Automation'}
          </DialogTitle>
          <DialogDescription>
            Build a scheduled task chain that runs skills in sequence.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 -mx-6 px-6">
          <div className="space-y-6 pb-4">
            {/* Error */}
            {error && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}

            {/* ============================================================ */}
            {/* Name & Description */}
            {/* ============================================================ */}
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium">Name</label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Morning Weather + Calendar Summary"
                  className="mt-1"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Description</label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional description of what this automation does..."
                  className="mt-1"
                  rows={2}
                />
              </div>
            </div>

            <Separator />

            {/* ============================================================ */}
            {/* Step Chain */}
            {/* ============================================================ */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Steps</label>
                <Button variant="outline" size="sm" onClick={addStep}>
                  <Plus className="h-3 w-3 mr-1" />
                  Add Step
                </Button>
              </div>

              <div className="space-y-3">
                {steps.map((step, index) => (
                  <StepEditor
                    key={step.id}
                    step={step}
                    index={index}
                    skills={skills}
                    getToolsForSkill={getToolsForSkill}
                    getToolParams={getToolParams}
                    getToolRequired={getToolRequired}
                    onUpdateSkill={(skillName) => updateStepSkill(index, skillName)}
                    onUpdateTool={(toolName) => updateStepTool(index, toolName)}
                    onUpdateArg={(key, value) => updateStepArg(index, key, value)}
                    onRemoveArg={(key) => removeStepArg(index, key)}
                    onRemove={steps.length > 1 ? () => removeStep(index) : undefined}
                    showPrevHint={index > 0}
                  />
                ))}
              </div>
            </div>

            <Separator />

            {/* ============================================================ */}
            {/* Schedule */}
            {/* ============================================================ */}
            <div className="space-y-3">
              <label className="text-sm font-medium">Schedule</label>

              <div className="flex items-center gap-3">
                <Select
                  value={scheduleType}
                  onValueChange={(v) => setScheduleType(v as 'cron' | 'interval')}
                >
                  <SelectTrigger className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cron">Cron (Time)</SelectItem>
                    <SelectItem value="interval">Interval</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {scheduleType === 'cron' ? (
                <div className="space-y-3">
                  {/* Time picker */}
                  <div className="flex items-center gap-3">
                    <div>
                      <label className="text-xs text-muted-foreground">Hour</label>
                      <Input
                        type="number"
                        min={0}
                        max={23}
                        value={hour}
                        onChange={(e) => setHour(Math.min(23, Math.max(0, parseInt(e.target.value) || 0)))}
                        className="w-20 mt-1"
                      />
                    </div>
                    <span className="text-lg font-bold mt-5">:</span>
                    <div>
                      <label className="text-xs text-muted-foreground">Minute</label>
                      <Input
                        type="number"
                        min={0}
                        max={59}
                        value={minute}
                        onChange={(e) => setMinute(Math.min(59, Math.max(0, parseInt(e.target.value) || 0)))}
                        className="w-20 mt-1"
                      />
                    </div>
                  </div>

                  {/* Day-of-week checkboxes */}
                  <div>
                    <label className="text-xs text-muted-foreground">
                      Days of week (leave empty for daily)
                    </label>
                    <div className="flex items-center gap-1 mt-1">
                      {DAYS_OF_WEEK.map((day) => (
                        <button
                          key={day.value}
                          onClick={() => toggleDay(day.value)}
                          className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                            daysOfWeek.includes(day.value)
                              ? 'bg-primary text-primary-foreground border-primary'
                              : 'bg-background border-border text-muted-foreground hover:bg-accent'
                          }`}
                        >
                          {day.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <label className="text-sm text-muted-foreground">Every</label>
                  <Input
                    type="number"
                    min={1}
                    max={1440}
                    value={intervalMinutes}
                    onChange={(e) => setIntervalMinutes(Math.max(1, parseInt(e.target.value) || 60))}
                    className="w-24"
                  />
                  <span className="text-sm text-muted-foreground">minutes</span>
                </div>
              )}
            </div>

            <Separator />

            {/* ============================================================ */}
            {/* Conditions (optional) */}
            {/* ============================================================ */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium flex items-center gap-1.5">
                  <Filter className="h-4 w-4" />
                  Conditions
                  <span className="text-xs text-muted-foreground font-normal">(optional)</span>
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setConditions((prev) => [
                      ...prev,
                      { id: `cond_${Date.now()}`, type: 'weather' },
                    ])
                  }
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Add Condition
                </Button>
              </div>

              {conditions.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No conditions — automation will always run on schedule.
                </p>
              ) : (
                <div className="space-y-3">
                  {/* Logic toggle */}
                  {conditions.length > 1 && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">When</span>
                      <Select
                        value={conditionLogic}
                        onValueChange={(v) => setConditionLogic(v as 'all' | 'any')}
                      >
                        <SelectTrigger className="w-24 h-7 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">ALL</SelectItem>
                          <SelectItem value="any">ANY</SelectItem>
                        </SelectContent>
                      </Select>
                      <span className="text-muted-foreground">conditions match</span>
                    </div>
                  )}

                  {/* Condition editors */}
                  {conditions.map((cond, idx) => (
                    <ConditionEditor
                      key={cond.id}
                      condition={cond}
                      onChange={(updated) =>
                        setConditions((prev) =>
                          prev.map((c, i) => (i === idx ? updated : c))
                        )
                      }
                      onRemove={() =>
                        setConditions((prev) => prev.filter((_, i) => i !== idx))
                      }
                    />
                  ))}

                  {/* Cooldown */}
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-muted-foreground whitespace-nowrap">
                      Cooldown after firing:
                    </label>
                    <Input
                      type="number"
                      min={0}
                      max={1440}
                      value={cooldownMinutes}
                      onChange={(e) => setCooldownMinutes(Math.max(0, parseInt(e.target.value) || 0))}
                      className="w-20 h-7 text-xs"
                    />
                    <span className="text-xs text-muted-foreground">minutes (0 = no cooldown)</span>
                  </div>
                </div>
              )}
            </div>

            <Separator />

            {/* ============================================================ */}
            {/* Target & Options */}
            {/* ============================================================ */}
            <div className="space-y-3">
              <label className="text-sm font-medium">Target Choom</label>
              {chooms.length > 0 ? (
                <Select value={choomName} onValueChange={setChoomName}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a Choom..." />
                  </SelectTrigger>
                  <SelectContent>
                    {chooms.map((c) => (
                      <SelectItem key={c.id} value={c.name}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={choomName}
                  onChange={(e) => setChoomName(e.target.value)}
                  placeholder="Choom name"
                />
              )}

              <div className="space-y-2 mt-3">
                <div className="flex items-center gap-3">
                  <Switch checked={respectQuiet} onCheckedChange={setRespectQuiet} />
                  <span className="text-sm">Respect quiet hours</span>
                </div>
                <div className="flex items-center gap-3">
                  <Switch checked={notifyOnComplete} onCheckedChange={setNotifyOnComplete} />
                  <span className="text-sm">Send notification on complete</span>
                </div>
              </div>
            </div>
          </div>
        </ScrollArea>

        {/* ================================================================ */}
        {/* Footer */}
        {/* ================================================================ */}
        <div className="flex items-center justify-between pt-4 border-t border-border mt-2">
          <div>
            {editingAutomation && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestRun}
                disabled={testing}
              >
                {testing ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    Running...
                  </>
                ) : (
                  <>
                    <Zap className="h-4 w-4 mr-1" />
                    Test Run
                  </>
                )}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!isValid || saving}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  Saving...
                </>
              ) : editingAutomation ? (
                'Update'
              ) : (
                'Create'
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// StepEditor sub-component
// ============================================================================

interface StepEditorProps {
  step: AutomationStep;
  index: number;
  skills: SkillInfo[];
  getToolsForSkill: (skillName: string) => SkillToolInfo[];
  getToolParams: (skillName: string, toolName: string) => Record<string, ToolParamDef>;
  getToolRequired: (skillName: string, toolName: string) => string[];
  onUpdateSkill: (skillName: string) => void;
  onUpdateTool: (toolName: string) => void;
  onUpdateArg: (key: string, value: unknown) => void;
  onRemoveArg: (key: string) => void;
  onRemove?: () => void;
  showPrevHint: boolean;
}

function StepEditor({
  step,
  index,
  skills,
  getToolsForSkill,
  getToolParams,
  getToolRequired,
  onUpdateSkill,
  onUpdateTool,
  onUpdateArg,
  onRemoveArg,
  onRemove,
  showPrevHint,
}: StepEditorProps) {
  const toolsForSkill = step.skillName ? getToolsForSkill(step.skillName) : [];
  const paramDefs = step.skillName && step.toolName
    ? getToolParams(step.skillName, step.toolName)
    : {};
  const requiredParams = step.skillName && step.toolName
    ? getToolRequired(step.skillName, step.toolName)
    : [];

  // Manage custom argument key/value entries beyond known params
  const [newArgKey, setNewArgKey] = useState('');

  const addCustomArg = useCallback(() => {
    const key = newArgKey.trim();
    if (key && !(key in step.arguments)) {
      onUpdateArg(key, '');
      setNewArgKey('');
    }
  }, [newArgKey, step.arguments, onUpdateArg]);

  // All argument keys: known params + any custom args already set
  const knownParamNames = Object.keys(paramDefs);
  const customArgKeys = Object.keys(step.arguments).filter(
    (k) => !knownParamNames.includes(k)
  );

  return (
    <div className="rounded-lg border bg-card p-3 space-y-3">
      {/* Step header */}
      <div className="flex items-center gap-2">
        <GripVertical className="h-4 w-4 text-muted-foreground/40 shrink-0" />
        <span className="text-sm font-medium text-primary w-6 shrink-0">
          {index + 1}
        </span>

        {/* Skill dropdown */}
        <Select value={step.skillName || '_none'} onValueChange={(v) => onUpdateSkill(v === '_none' ? '' : v)}>
          <SelectTrigger className="flex-1 min-w-0">
            <SelectValue placeholder="Select skill..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_none" disabled>Select skill...</SelectItem>
            {skills
              .filter((s) => s.enabled !== false)
              .map((skill) => (
                <SelectItem key={skill.name} value={skill.name}>
                  {skill.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>

        {/* Tool dropdown */}
        <Select
          value={step.toolName || '_none'}
          onValueChange={(v) => onUpdateTool(v === '_none' ? '' : v)}
          disabled={!step.skillName}
        >
          <SelectTrigger className="flex-1 min-w-0">
            <SelectValue placeholder="Select tool..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_none" disabled>Select tool...</SelectItem>
            {toolsForSkill.map((tool) => (
              <SelectItem key={tool.name} value={tool.name}>
                {tool.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {onRemove && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-destructive hover:bg-destructive/10"
            onClick={onRemove}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Tool description */}
      {step.toolName && toolsForSkill.length > 0 && (
        <p className="text-xs text-muted-foreground pl-12">
          {toolsForSkill.find((t) => t.name === step.toolName)?.description}
        </p>
      )}

      {/* Parameter form */}
      {step.toolName && (
        <div className="pl-12 space-y-2">
          {/* Known parameters */}
          {knownParamNames.map((paramName) => {
            const param = paramDefs[paramName];
            const isRequired = requiredParams.includes(paramName);
            return (
              <div key={paramName}>
                <label className="text-xs text-muted-foreground">
                  {paramName}
                  {isRequired && <span className="text-destructive ml-0.5">*</span>}
                  {param.description && (
                    <span className="ml-1 opacity-60">-- {param.description}</span>
                  )}
                </label>
                <ParamInput
                  paramDef={param}
                  value={step.arguments[paramName]}
                  onChange={(v) => onUpdateArg(paramName, v)}
                  showPrevHint={showPrevHint}
                />
              </div>
            );
          })}

          {/* Custom arguments (beyond known schema) */}
          {customArgKeys.map((key) => (
            <div key={key} className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-32 shrink-0 truncate">
                {key}
              </span>
              <Input
                value={String(step.arguments[key] ?? '')}
                onChange={(e) => onUpdateArg(key, e.target.value)}
                className="flex-1 text-sm h-8"
                placeholder={showPrevHint ? '{{prev.result.field}}' : ''}
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => onRemoveArg(key)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}

          {/* Add custom argument */}
          <div className="flex items-center gap-2 pt-1">
            <Input
              value={newArgKey}
              onChange={(e) => setNewArgKey(e.target.value)}
              placeholder="Add argument..."
              className="flex-1 text-xs h-7"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addCustomArg();
                }
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={addCustomArg}
              disabled={!newArgKey.trim()}
            >
              <Plus className="h-3 w-3 mr-1" />
              Add
            </Button>
          </div>

          {/* Prev result hint */}
          {showPrevHint && (
            <p className="text-xs text-muted-foreground/60 italic">
              Reference previous step results with{' '}
              <code className="bg-muted px-1 py-0.5 rounded text-xs">
                {'{{prev.result.field}}'}
              </code>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// ConditionEditor sub-component
// ============================================================================

const CONDITION_TYPES = [
  { value: 'weather', label: 'Weather' },
  { value: 'time_range', label: 'Time Range' },
  { value: 'day_of_week', label: 'Day of Week' },
  { value: 'calendar', label: 'Calendar Events' },
  { value: 'home_assistant', label: 'Home Assistant' },
] as const;

const WEATHER_FIELDS = [
  { value: 'temperature', label: 'Temperature (F)' },
  { value: 'windSpeed', label: 'Wind Speed (mph)' },
  { value: 'humidity', label: 'Humidity (%)' },
];

const WEATHER_OPS = [
  { value: '<', label: '<' },
  { value: '>', label: '>' },
  { value: '<=', label: '<=' },
  { value: '>=', label: '>=' },
];

const COND_DAYS_OF_WEEK = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

interface ConditionEditorProps {
  condition: AutomationCondition;
  onChange: (updated: AutomationCondition) => void;
  onRemove: () => void;
}

function ConditionEditor({ condition, onChange, onRemove }: ConditionEditorProps) {
  return (
    <div className="rounded-lg border bg-card p-3 space-y-2">
      <div className="flex items-center gap-2">
        {/* Type dropdown */}
        <Select
          value={condition.type}
          onValueChange={(v) =>
            onChange({ id: condition.id, type: v as AutomationCondition['type'] })
          }
        >
          <SelectTrigger className="w-40 h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONDITION_TYPES.map((ct) => (
              <SelectItem key={ct.value} value={ct.value}>
                {ct.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex-1" />

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-destructive hover:bg-destructive/10"
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Dynamic fields based on type */}
      {condition.type === 'weather' && (
        <div className="flex items-center gap-2">
          <Select
            value={condition.field || 'temperature'}
            onValueChange={(v) => onChange({ ...condition, field: v })}
          >
            <SelectTrigger className="w-36 h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEATHER_FIELDS.map((f) => (
                <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={condition.op || '<'}
            onValueChange={(v) => onChange({ ...condition, op: v })}
          >
            <SelectTrigger className="w-16 h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEATHER_OPS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="number"
            value={condition.value ?? 32}
            onChange={(e) => onChange({ ...condition, value: parseFloat(e.target.value) || 0 })}
            className="w-20 h-7 text-xs"
            placeholder="Value"
          />
        </div>
      )}

      {condition.type === 'time_range' && (
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Between</label>
          <Input
            type="time"
            value={condition.after || '06:00'}
            onChange={(e) => onChange({ ...condition, after: e.target.value })}
            className="w-28 h-7 text-xs"
          />
          <label className="text-xs text-muted-foreground">and</label>
          <Input
            type="time"
            value={condition.before || '22:00'}
            onChange={(e) => onChange({ ...condition, before: e.target.value })}
            className="w-28 h-7 text-xs"
          />
        </div>
      )}

      {condition.type === 'day_of_week' && (
        <div className="flex items-center gap-1">
          {COND_DAYS_OF_WEEK.map((day) => (
            <button
              key={day.value}
              onClick={() => {
                const currentDays = condition.days || [];
                const newDays = currentDays.includes(day.value)
                  ? currentDays.filter((d) => d !== day.value)
                  : [...currentDays, day.value];
                onChange({ ...condition, days: newDays });
              }}
              className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                (condition.days || []).includes(day.value)
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background border-border text-muted-foreground hover:bg-accent'
              }`}
            >
              {day.label}
            </button>
          ))}
        </div>
      )}

      {condition.type === 'calendar' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Switch
              checked={condition.has_events ?? true}
              onCheckedChange={(checked) => onChange({ ...condition, has_events: checked })}
            />
            <span className="text-xs text-muted-foreground">
              {condition.has_events !== false ? 'Has events today' : 'No events today'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground whitespace-nowrap">
              Keyword filter:
            </label>
            <Input
              value={condition.keyword || ''}
              onChange={(e) => onChange({ ...condition, keyword: e.target.value })}
              className="flex-1 h-7 text-xs"
              placeholder="Optional: match event title..."
            />
          </div>
        </div>
      )}

      {condition.type === 'home_assistant' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              value={condition.entity_id || ''}
              onChange={(e) => onChange({ ...condition, entity_id: e.target.value })}
              className="flex-1 h-7 text-xs font-mono"
              placeholder="sensor.bathroom_temperature"
            />
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={condition.op || '=='}
              onValueChange={(v) => onChange({ ...condition, op: v })}
            >
              <SelectTrigger className="w-16 h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  { value: '<', label: '<' },
                  { value: '>', label: '>' },
                  { value: '<=', label: '<=' },
                  { value: '>=', label: '>=' },
                  { value: '==', label: '==' },
                  { value: '!=', label: '!=' },
                ].map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={condition.ha_value ?? ''}
              onChange={(e) => onChange({ ...condition, ha_value: e.target.value })}
              className="flex-1 h-7 text-xs"
              placeholder="Value (number or string)"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// ParamInput — renders the right input type for a parameter definition
// ============================================================================

interface ParamInputProps {
  paramDef: ToolParamDef;
  value: unknown;
  onChange: (value: unknown) => void;
  showPrevHint: boolean;
}

function ParamInput({ paramDef, value, onChange, showPrevHint }: ParamInputProps) {
  if (paramDef.enum && paramDef.enum.length > 0) {
    return (
      <Select
        value={String(value ?? '')}
        onValueChange={(v) => onChange(v)}
      >
        <SelectTrigger className="mt-1 h-8 text-sm">
          <SelectValue placeholder="Select..." />
        </SelectTrigger>
        <SelectContent>
          {paramDef.enum.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (paramDef.type === 'boolean') {
    return (
      <div className="flex items-center gap-2 mt-1">
        <Switch
          checked={value === true || value === 'true'}
          onCheckedChange={(checked) => onChange(checked)}
        />
        <span className="text-xs text-muted-foreground">
          {value === true || value === 'true' ? 'true' : 'false'}
        </span>
      </div>
    );
  }

  if (paramDef.type === 'number') {
    return (
      <Input
        type="number"
        value={value !== undefined && value !== null ? String(value) : ''}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === '' ? undefined : parseFloat(raw));
        }}
        className="mt-1 h-8 text-sm"
        placeholder={showPrevHint ? '{{prev.result.field}}' : paramDef.default !== undefined ? String(paramDef.default) : ''}
      />
    );
  }

  // Default: string or complex types
  return (
    <Input
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      className="mt-1 h-8 text-sm"
      placeholder={showPrevHint ? '{{prev.result.field}}' : paramDef.default !== undefined ? String(paramDef.default) : ''}
    />
  );
}
