'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Info, ChevronDown, ChevronRight, Plus, RotateCcw, Pencil, Trash2, Check, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { useLiveModels } from '@/lib/hooks/use-live-models';
import type { LLMProviderConfig, LLMModelProfile } from '@/lib/types';
import {
  getEffectiveLLMProfiles,
  getBuiltInLLMProfile,
  findLLMProfile,
} from '@/lib/model-profiles';

interface ModelOption {
  id: string;
  name: string;
  loaded?: boolean;
}

export function LLMSettings() {
  const { settings, updateLLMSettings, updateModelProfiles } = useAppStore();
  const llm = settings.llm;
  const providers = settings.providers || [];
  const userProfiles = settings.modelProfiles || [];

  const [models, setModels] = useState<ModelOption[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Partial<LLMModelProfile>>({});
  const [newProfileId, setNewProfileId] = useState('');
  const [showNewProfile, setShowNewProfile] = useState(false);
  const [profilePromptModel, setProfilePromptModel] = useState<string | null>(null);
  const [prevModel, setPrevModel] = useState(llm.model);

  // Resolve the actual endpoint to use for fetching models
  const getActiveEndpoint = () => {
    if (llm.llmProviderId) {
      const provider = providers.find((p: LLMProviderConfig) => p.id === llm.llmProviderId);
      return provider?.endpoint || llm.endpoint;
    }
    return llm.endpoint;
  };

  const fetchModels = async () => {
    setIsLoadingModels(true);
    try {
      const activeEndpoint = getActiveEndpoint();
      const params = new URLSearchParams({ endpoint: activeEndpoint });
      if (llm.llmProviderId) {
        const provider = providers.find((p: LLMProviderConfig) => p.id === llm.llmProviderId);
        if (provider?.apiKey) params.set('apiKey', provider.apiKey);
      }
      const res = await fetch(`/api/services/models?${params}`);
      if (res.ok) {
        const data = await res.json();
        const seen = new Set<string>();
        setModels((data.models || []).filter((m: ModelOption) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        }));
      }
    } catch (error) {
      console.error('Failed to fetch models:', error);
    } finally {
      setIsLoadingModels(false);
    }
  };

  useEffect(() => {
    fetchModels();
  }, [llm.endpoint, llm.llmProviderId]);

  // Live models for the simple-tasks picker (separate from the primary picker so its provider can differ).
  const simpleTasksLive = useLiveModels({
    providerId: llm.simpleTasksProviderId && llm.simpleTasksProviderId !== '_local' ? llm.simpleTasksProviderId : undefined,
    providers,
    localEndpoint: !llm.simpleTasksProviderId || llm.simpleTasksProviderId === '_local' ? llm.endpoint : undefined,
    enabled: !!llm.simpleTasksEnabled,
  });

  // Detect model changes and prompt to load profile
  useEffect(() => {
    if (llm.model !== prevModel && prevModel) {
      const profile = findLLMProfile(llm.model, userProfiles);
      if (profile) {
        setProfilePromptModel(llm.model);
      } else {
        setProfilePromptModel(null);
      }
    }
    setPrevModel(llm.model);
  }, [llm.model]);

  const effectiveProfiles = getEffectiveLLMProfiles(userProfiles);

  const applyProfileToGlobal = useCallback((modelId: string) => {
    const profile = findLLMProfile(modelId, userProfiles);
    if (!profile) return;
    const updates: Partial<typeof llm> = {};
    if (profile.temperature !== undefined) updates.temperature = profile.temperature;
    if (profile.topP !== undefined) updates.topP = profile.topP;
    if (profile.maxTokens !== undefined) updates.maxTokens = profile.maxTokens;
    if (profile.contextLength !== undefined) updates.contextLength = profile.contextLength;
    if (profile.frequencyPenalty !== undefined) updates.frequencyPenalty = profile.frequencyPenalty;
    if (profile.presencePenalty !== undefined) updates.presencePenalty = profile.presencePenalty;
    updateLLMSettings(updates);
    setProfilePromptModel(null);
  }, [userProfiles, updateLLMSettings]);

  const saveProfile = useCallback((profile: LLMModelProfile) => {
    const updated = [...userProfiles];
    const idx = updated.findIndex(p => p.modelId === profile.modelId);
    if (idx >= 0) {
      updated[idx] = { ...profile, builtIn: undefined };
    } else {
      updated.push({ ...profile, builtIn: undefined });
    }
    updateModelProfiles(updated);
    setEditingProfileId(null);
    setEditDraft({});
  }, [userProfiles, updateModelProfiles]);

  const resetProfile = useCallback((modelId: string) => {
    // Remove user override so built-in defaults apply
    const updated = userProfiles.filter(p => p.modelId !== modelId);
    updateModelProfiles(updated);
  }, [userProfiles, updateModelProfiles]);

  const deleteProfile = useCallback((modelId: string) => {
    const updated = userProfiles.filter(p => p.modelId !== modelId);
    updateModelProfiles(updated);
  }, [userProfiles, updateModelProfiles]);

  const startEdit = (profile: LLMModelProfile) => {
    setEditingProfileId(profile.modelId);
    setEditDraft({ ...profile });
  };

  const createNewProfile = () => {
    if (!newProfileId.trim()) return;
    const profile: LLMModelProfile = {
      modelId: newProfileId.trim(),
      label: newProfileId.trim().split('/').pop() || newProfileId.trim(),
      temperature: 0.7,
      topP: 0.95,
      maxTokens: 4096,
      contextLength: 131072,
      frequencyPenalty: 0,
      presencePenalty: 0,
    };
    saveProfile(profile);
    setNewProfileId('');
    setShowNewProfile(false);
    startEdit(profile);
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium mb-4">LLM Configuration</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Configure the default LLM provider. Individual Chooms can override this in their settings.
        </p>
      </div>

      {/* Provider */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Provider</label>
        <Select
          value={llm.llmProviderId || '_local'}
          onValueChange={(v) => {
            if (v === '_local') {
              // Only clear provider — endpoint stays as the user's local endpoint
              updateLLMSettings({ llmProviderId: undefined, model: '' });
            } else {
              const provider = providers.find((p: LLMProviderConfig) => p.id === v);
              if (provider) {
                // Only set provider and model — do NOT overwrite endpoint (it's the local endpoint)
                updateLLMSettings({
                  llmProviderId: v,
                  model: provider.models[0] || '',
                });
              }
            }
          }}
        >
          <SelectTrigger className="hover:border-primary/50 transition-colors">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_local">Local (LM Studio / Ollama)</SelectItem>
            {providers.map((p: LLMProviderConfig) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!llm.llmProviderId && providers.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Add providers in Settings &gt; Providers to use cloud LLMs
          </p>
        )}
      </div>

      {/* Endpoint */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">API Endpoint</label>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs">OpenAI-compatible API endpoint. For LMStudio use http://localhost:1234/v1</p>
            </TooltipContent>
          </Tooltip>
        </div>
        {llm.llmProviderId ? (
          <>
            <Input value={providers.find((p: LLMProviderConfig) => p.id === llm.llmProviderId)?.endpoint || llm.endpoint} disabled className="text-muted-foreground" />
            <p className="text-xs text-muted-foreground">Set by provider — edit in Settings &gt; Providers</p>
          </>
        ) : (
          <Input
            value={llm.endpoint}
            onChange={(e) => updateLLMSettings({ endpoint: e.target.value })}
            placeholder="http://localhost:1234/v1"
            className="hover:border-primary/50 focus:border-primary transition-colors"
          />
        )}
      </div>

      {/* Model - Dynamic Dropdown */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">Model</label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">Select the LLM model to use. Refresh to load available models from the server.</p>
              </TooltipContent>
            </Tooltip>
          </div>
          {!llm.llmProviderId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchModels}
              disabled={isLoadingModels}
              className="h-8 px-2"
            >
              <RefreshCw className={cn('h-4 w-4', isLoadingModels && 'animate-spin')} />
            </Button>
          )}
        </div>
        {(() => {
          // Always prefer the live-fetched `models` (from the provider's actual endpoint).
          // Fall back to the persisted `provider.models` cache only if the live fetch returned nothing.
          const selectedProvider = providers.find((p: LLMProviderConfig) => p.id === llm.llmProviderId);
          const liveOptions: ModelOption[] = models.length > 0
            ? models
            : (selectedProvider?.models || []).map((m: string) => ({ id: m, name: m }));
          const stale = !!llm.model && liveOptions.length > 0 && !liveOptions.some((m) => m.id === llm.model);
          return liveOptions.length > 0 ? (
            <>
            <Select
              value={llm.model}
              onValueChange={(v) => updateLLMSettings({ model: v })}
            >
              <SelectTrigger className="hover:border-primary/50 transition-colors">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {liveOptions.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    <span className="flex items-center gap-2">
                      {model.loaded && <span className="inline-block h-2 w-2 rounded-full bg-green-500" title="Loaded in LM Studio" />}
                      {model.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {stale && (
              <p className="text-xs text-amber-600 dark:text-amber-500 mt-1">
                ⚠ Saved model <code className="font-mono">{llm.model}</code> is not in this endpoint&apos;s current list. Pick one above.
              </p>
            )}
            </>
          ) : (
            <Input
              value={llm.model}
              onChange={(e) => updateLLMSettings({ model: e.target.value })}
              placeholder="Enter model name or refresh to load"
              className="hover:border-primary/50 focus:border-primary transition-colors"
            />
          );
        })()}

        {/* "Load profile defaults?" prompt */}
        {profilePromptModel && (
          <div className="flex items-center gap-2 p-2 rounded-md bg-primary/5 border border-primary/20">
            <span className="text-xs text-muted-foreground flex-1">
              Profile found for this model. Load defaults?
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => applyProfileToGlobal(profilePromptModel)}
            >
              Load profile defaults
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => setProfilePromptModel(null)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        )}
      </div>

      {/* Context Length */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">Context Length</label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">Maximum context window size. Higher values allow longer conversations but use more memory.</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <Input
            type="number"
            value={llm.contextLength || 131072}
            onChange={(e) => updateLLMSettings({ contextLength: parseInt(e.target.value) || 131072 })}
            className="w-28 h-8 text-sm"
            min={1024}
            max={262144}
            step={1024}
          />
        </div>
        <Slider
          value={[llm.contextLength || 131072]}
          onValueChange={([v]) => updateLLMSettings({ contextLength: v })}
          min={1024}
          max={262144}
          step={1024}
          className="hover:cursor-pointer"
        />
        <p className="text-xs text-muted-foreground">
          Typical values: 8K, 32K, 128K, 200K depending on model
        </p>
      </div>

      {/* Temperature */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">Temperature</label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">Controls randomness. 0 = deterministic, 2 = very creative</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <span className="text-sm text-muted-foreground">{llm.temperature}</span>
        </div>
        <Slider
          value={[llm.temperature]}
          onValueChange={([v]) => updateLLMSettings({ temperature: v })}
          min={0}
          max={2}
          step={0.1}
          className="hover:cursor-pointer"
        />
      </div>

      {/* Max Tokens */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">Max Response Tokens</label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">Maximum length of the AI&apos;s response in tokens</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <span className="text-sm text-muted-foreground">{llm.maxTokens}</span>
        </div>
        <Slider
          value={[llm.maxTokens]}
          onValueChange={([v]) => updateLLMSettings({ maxTokens: v })}
          min={256}
          max={16384}
          step={256}
          className="hover:cursor-pointer"
        />
      </div>

      {/* Top P */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">Top P</label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">Nucleus sampling. Consider tokens with top_p cumulative probability.</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <span className="text-sm text-muted-foreground">{llm.topP}</span>
        </div>
        <Slider
          value={[llm.topP]}
          onValueChange={([v]) => updateLLMSettings({ topP: v })}
          min={0}
          max={1}
          step={0.05}
          className="hover:cursor-pointer"
        />
      </div>

      {/* Frequency Penalty */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">Frequency Penalty</label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">Reduces repetition of frequent tokens</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <span className="text-sm text-muted-foreground">{llm.frequencyPenalty}</span>
        </div>
        <Slider
          value={[llm.frequencyPenalty]}
          onValueChange={([v]) => updateLLMSettings({ frequencyPenalty: v })}
          min={0}
          max={2}
          step={0.1}
          className="hover:cursor-pointer"
        />
      </div>

      {/* Presence Penalty */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">Presence Penalty</label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">Encourages talking about new topics</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <span className="text-sm text-muted-foreground">{llm.presencePenalty}</span>
        </div>
        <Slider
          value={[llm.presencePenalty]}
          onValueChange={([v]) => updateLLMSettings({ presencePenalty: v })}
          min={0}
          max={2}
          step={0.1}
          className="hover:cursor-pointer"
        />
      </div>

      {/* ================================================================ */}
      {/* Simple Tasks Model Section */}
      {/* ================================================================ */}
      <div className="border-t pt-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">Simple Tasks Model</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Use a fast/cheap model for routine tool calls — reminders, habits, calendar, weather, tasks, memory.
              Complex requests (research, coding, image gen) still use the primary model.
            </p>
          </div>
          <Switch
            checked={llm.simpleTasksEnabled || false}
            onCheckedChange={(checked) => updateLLMSettings({ simpleTasksEnabled: checked })}
          />
        </div>

        {llm.simpleTasksEnabled && (
          <div className="space-y-2 ml-1">
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground w-16">Provider</label>
              <select
                value={llm.simpleTasksProviderId || '_local'}
                onChange={(e) => {
                  const pid = e.target.value;
                  // Clear the saved model on provider switch — the live hook will refetch and user picks fresh.
                  updateLLMSettings({
                    simpleTasksProviderId: pid === '_local' ? undefined : pid,
                    simpleTasksModel: '',
                  });
                }}
                className="bg-muted border border-border rounded px-2 py-1 text-sm flex-1"
              >
                <option value="_local">Local (LM Studio)</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground w-16">Model</label>
              {(() => {
                const options = simpleTasksLive.models.map((m) => m.id);
                const saved = llm.simpleTasksModel || '';
                const stale = !!saved && options.length > 0 && !options.includes(saved);
                return (
                  <select
                    value={stale ? '' : saved}
                    onChange={(e) => updateLLMSettings({ simpleTasksModel: e.target.value })}
                    className="bg-muted border border-border rounded px-2 py-1 text-sm flex-1"
                  >
                    <option value="">{stale ? `⚠ Saved: ${saved} (not available — pick one)` : '(not set)'}</option>
                    {options.map((m) => (
                      <option key={m} value={m}>{m.split('/').pop()}</option>
                    ))}
                  </select>
                );
              })()}
            </div>
            <p className="text-[10px] text-muted-foreground ml-[4.5rem]">
              Routes: reminders, habits, calendar, weather, tasks, memory, notifications
            </p>
          </div>
        )}
      </div>

      {/* ================================================================ */}
      {/* Model Profiles Section */}
      {/* ================================================================ */}
      <div className="border-t pt-4">
        <button
          onClick={() => setProfilesOpen(!profilesOpen)}
          className="flex items-center gap-2 w-full text-left"
        >
          {profilesOpen ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <h3 className="text-sm font-medium">Model Profiles</h3>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            {effectiveProfiles.length}
          </Badge>
        </button>
        <p className="text-xs text-muted-foreground mt-1 ml-6">
          Per-model parameter defaults. Applied automatically when a Choom or project uses a different model.
        </p>

        {profilesOpen && (
          <div className="mt-4 space-y-3">
            {/* New Profile button */}
            <div className="flex gap-2">
              {showNewProfile ? (
                <>
                  <Input
                    value={newProfileId}
                    onChange={(e) => setNewProfileId(e.target.value)}
                    placeholder="model-id (e.g. vendor/model-name)"
                    className="flex-1 h-8 text-sm"
                    onKeyDown={(e) => { if (e.key === 'Enter') createNewProfile(); }}
                  />
                  <Button size="sm" className="h-8" onClick={createNewProfile} disabled={!newProfileId.trim()}>
                    <Check className="h-3 w-3 mr-1" /> Add
                  </Button>
                  <Button variant="ghost" size="sm" className="h-8" onClick={() => { setShowNewProfile(false); setNewProfileId(''); }}>
                    <X className="h-3 w-3" />
                  </Button>
                </>
              ) : (
                <Button variant="outline" size="sm" className="h-8" onClick={() => setShowNewProfile(true)}>
                  <Plus className="h-3 w-3 mr-1" /> New Profile
                </Button>
              )}
            </div>

            {/* Profile Cards */}
            {effectiveProfiles.map((profile) => (
              <div
                key={profile.modelId}
                className="border rounded-lg p-3 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium truncate">{profile.label || profile.modelId}</span>
                    {profile.builtIn && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">built-in</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {editingProfileId === profile.modelId ? (
                      <>
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => {
                          saveProfile({ ...profile, ...editDraft } as LLMModelProfile);
                        }}>
                          <Check className="h-3 w-3 text-green-500" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => {
                          setEditingProfileId(null);
                          setEditDraft({});
                        }}>
                          <X className="h-3 w-3" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => startEdit(profile)}>
                          <Pencil className="h-3 w-3" />
                        </Button>
                        {profile.builtIn ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => resetProfile(profile.modelId)}>
                                <RotateCcw className="h-3 w-3" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Reset to built-in defaults</TooltipContent>
                          </Tooltip>
                        ) : (
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" onClick={() => deleteProfile(profile.modelId)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                <p className="text-xs text-muted-foreground font-mono truncate">{profile.modelId}</p>

                {editingProfileId === profile.modelId ? (
                  /* Inline Editor */
                  <ProfileEditor draft={editDraft} setDraft={setEditDraft} />
                ) : (
                  /* Summary line */
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {profile.temperature !== undefined && <span>temp={profile.temperature}</span>}
                    {profile.topP !== undefined && <span>topP={profile.topP}</span>}
                    {profile.maxTokens !== undefined && <span>maxTokens={profile.maxTokens.toLocaleString()}</span>}
                    {profile.contextLength !== undefined && <span>ctx={profile.contextLength.toLocaleString()}</span>}
                    {profile.topK !== undefined && <span>topK={profile.topK}</span>}
                    {profile.repetitionPenalty !== undefined && <span>repPen={profile.repetitionPenalty}</span>}
                    {profile.enableThinking !== undefined && <span>thinking={profile.enableThinking ? 'on' : 'off'}</span>}
                    {profile.frequencyPenalty !== undefined && profile.frequencyPenalty > 0 && <span>freqPen={profile.frequencyPenalty}</span>}
                    {profile.presencePenalty !== undefined && profile.presencePenalty > 0 && <span>presPen={profile.presencePenalty}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Profile Inline Editor
// ============================================================================

function ProfileEditor({
  draft,
  setDraft,
}: {
  draft: Partial<LLMModelProfile>;
  setDraft: React.Dispatch<React.SetStateAction<Partial<LLMModelProfile>>>;
}) {
  return (
    <div className="space-y-3 pt-2 border-t">
      {/* Label */}
      <div className="space-y-1">
        <label className="text-xs font-medium">Label</label>
        <Input
          value={draft.label || ''}
          onChange={(e) => setDraft(d => ({ ...d, label: e.target.value }))}
          className="h-7 text-xs"
          placeholder="Display name"
        />
      </div>

      {/* Temperature */}
      <div className="space-y-1">
        <div className="flex justify-between">
          <label className="text-xs font-medium">Temperature</label>
          <span className="text-xs text-muted-foreground">{draft.temperature ?? 0.7}</span>
        </div>
        <Slider
          value={[draft.temperature ?? 0.7]}
          onValueChange={([v]) => setDraft(d => ({ ...d, temperature: v }))}
          min={0} max={2} step={0.1}
          className="hover:cursor-pointer"
        />
      </div>

      {/* Top P */}
      <div className="space-y-1">
        <div className="flex justify-between">
          <label className="text-xs font-medium">Top P</label>
          <span className="text-xs text-muted-foreground">{draft.topP ?? 0.95}</span>
        </div>
        <Slider
          value={[draft.topP ?? 0.95]}
          onValueChange={([v]) => setDraft(d => ({ ...d, topP: v }))}
          min={0} max={1} step={0.05}
          className="hover:cursor-pointer"
        />
      </div>

      {/* Max Tokens */}
      <div className="space-y-1">
        <div className="flex justify-between">
          <label className="text-xs font-medium">Max Tokens</label>
          <span className="text-xs text-muted-foreground">{(draft.maxTokens ?? 4096).toLocaleString()}</span>
        </div>
        <Slider
          value={[draft.maxTokens ?? 4096]}
          onValueChange={([v]) => setDraft(d => ({ ...d, maxTokens: v }))}
          min={256} max={16384} step={256}
          className="hover:cursor-pointer"
        />
      </div>

      {/* Context Length */}
      <div className="space-y-1">
        <div className="flex justify-between">
          <label className="text-xs font-medium">Context Length</label>
          <span className="text-xs text-muted-foreground">{(draft.contextLength ?? 131072).toLocaleString()}</span>
        </div>
        <Slider
          value={[draft.contextLength ?? 131072]}
          onValueChange={([v]) => setDraft(d => ({ ...d, contextLength: v }))}
          min={1024} max={262144} step={1024}
          className="hover:cursor-pointer"
        />
      </div>

      {/* Frequency Penalty */}
      <div className="space-y-1">
        <div className="flex justify-between">
          <label className="text-xs font-medium">Frequency Penalty</label>
          <span className="text-xs text-muted-foreground">{draft.frequencyPenalty ?? 0}</span>
        </div>
        <Slider
          value={[draft.frequencyPenalty ?? 0]}
          onValueChange={([v]) => setDraft(d => ({ ...d, frequencyPenalty: v }))}
          min={0} max={2} step={0.1}
          className="hover:cursor-pointer"
        />
      </div>

      {/* Presence Penalty */}
      <div className="space-y-1">
        <div className="flex justify-between">
          <label className="text-xs font-medium">Presence Penalty</label>
          <span className="text-xs text-muted-foreground">{draft.presencePenalty ?? 0}</span>
        </div>
        <Slider
          value={[draft.presencePenalty ?? 0]}
          onValueChange={([v]) => setDraft(d => ({ ...d, presencePenalty: v }))}
          min={0} max={2} step={0.1}
          className="hover:cursor-pointer"
        />
      </div>

      {/* Extended params separator */}
      <div className="pt-1">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Extended (Provider-Specific)</p>
      </div>

      {/* Top K */}
      <div className="space-y-1">
        <div className="flex justify-between">
          <label className="text-xs font-medium">Top K</label>
          <span className="text-xs text-muted-foreground">{draft.topK ?? 'off'}</span>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={draft.topK !== undefined}
            onCheckedChange={(checked) => setDraft(d => ({ ...d, topK: checked ? 20 : undefined }))}
          />
          {draft.topK !== undefined && (
            <Slider
              value={[draft.topK]}
              onValueChange={([v]) => setDraft(d => ({ ...d, topK: v }))}
              min={1} max={100} step={1}
              className="flex-1 hover:cursor-pointer"
            />
          )}
        </div>
      </div>

      {/* Repetition Penalty */}
      <div className="space-y-1">
        <div className="flex justify-between">
          <label className="text-xs font-medium">Repetition Penalty</label>
          <span className="text-xs text-muted-foreground">{draft.repetitionPenalty ?? 'off'}</span>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={draft.repetitionPenalty !== undefined}
            onCheckedChange={(checked) => setDraft(d => ({ ...d, repetitionPenalty: checked ? 1.05 : undefined }))}
          />
          {draft.repetitionPenalty !== undefined && (
            <Slider
              value={[draft.repetitionPenalty]}
              onValueChange={([v]) => setDraft(d => ({ ...d, repetitionPenalty: v }))}
              min={1.0} max={2.0} step={0.05}
              className="flex-1 hover:cursor-pointer"
            />
          )}
        </div>
      </div>

      {/* Enable Thinking */}
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium">Enable Thinking</label>
        <Switch
          checked={draft.enableThinking === true}
          onCheckedChange={(checked) => setDraft(d => ({ ...d, enableThinking: checked ? true : undefined }))}
        />
      </div>
    </div>
  );
}
