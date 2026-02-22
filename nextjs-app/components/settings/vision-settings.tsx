'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Eye, RefreshCw, Check, X, ChevronDown, ChevronRight, Plus, RotateCcw, Pencil, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppStore } from '@/lib/store';
import type { LLMProviderConfig, VisionModelProfile } from '@/lib/types';
import { getEffectiveVisionProfiles } from '@/lib/model-profiles';

export function VisionSettings() {
  const { settings, updateVisionSettings, updateVisionProfiles } = useAppStore();
  const providers = settings.providers || [];
  const userVisionProfiles = settings.visionProfiles || [];

  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message?: string;
    error?: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Partial<VisionModelProfile>>({});
  const [showNewProfile, setShowNewProfile] = useState(false);
  const [newProfileId, setNewProfileId] = useState('');

  const effectiveProfiles = getEffectiveVisionProfiles(userVisionProfiles);

  // Resolve the active vision endpoint (provider endpoint if provider selected, else local)
  const getActiveVisionEndpoint = () => {
    if (settings.vision.visionProviderId) {
      const provider = providers.find((p: LLMProviderConfig) => p.id === settings.vision.visionProviderId);
      if (provider) return provider.endpoint.replace(/\/v1\/?$/, '');
    }
    return settings.vision.endpoint;
  };

  // Resolve API key for the current vision provider
  const getVisionApiKey = () => {
    const providerId = settings.vision.visionProviderId;
    if (providerId) {
      const provider = providers.find((p: LLMProviderConfig) => p.id === providerId);
      return provider?.apiKey || settings.vision.apiKey;
    }
    return settings.vision.apiKey;
  };

  const fetchModels = async () => {
    setLoadingModels(true);
    try {
      const activeEndpoint = getActiveVisionEndpoint();
      const params = new URLSearchParams({ endpoint: activeEndpoint + '/v1' });
      const apiKey = getVisionApiKey();
      if (apiKey) params.set('apiKey', apiKey);
      const response = await fetch(`/api/services/models?${params}`);
      const data = await response.json();
      if (data.models) {
        const ids: string[] = data.models.map((m: { id: string }) => m.id);
        setModels([...new Set(ids)]);
      }
    } catch (error) {
      console.error('Failed to fetch vision models:', error);
    } finally {
      setLoadingModels(false);
    }
  };

  useEffect(() => {
    fetchModels();
  }, [settings.vision.endpoint, settings.vision.visionProviderId]);

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);

    try {
      // Proxy through our API to handle auth headers for cloud providers
      const activeEndpoint = getActiveVisionEndpoint();
      const params = new URLSearchParams({ endpoint: activeEndpoint + '/v1' });
      const apiKey = getVisionApiKey();
      if (apiKey) params.set('apiKey', apiKey);
      const response = await fetch(`/api/services/models?${params}`);
      if (response.ok) {
        const data = await response.json();
        const modelCount = data.models?.length || 0;
        setTestResult({
          success: true,
          message: `Connected! ${modelCount} model(s) available.`,
        });
      } else {
        setTestResult({
          success: false,
          error: `Server responded with ${response.status}: ${response.statusText}`,
        });
      }
    } catch (error) {
      setTestResult({
        success: false,
        error: error instanceof Error ? error.message : 'Connection failed',
      });
    } finally {
      setTesting(false);
    }
  };

  const saveProfile = useCallback((profile: VisionModelProfile) => {
    const updated = [...userVisionProfiles];
    const idx = updated.findIndex(p => p.modelId === profile.modelId);
    if (idx >= 0) {
      updated[idx] = { ...profile, builtIn: undefined };
    } else {
      updated.push({ ...profile, builtIn: undefined });
    }
    updateVisionProfiles(updated);
    setEditingProfileId(null);
    setEditDraft({});
  }, [userVisionProfiles, updateVisionProfiles]);

  const resetProfile = useCallback((modelId: string) => {
    const updated = userVisionProfiles.filter(p => p.modelId !== modelId);
    updateVisionProfiles(updated);
  }, [userVisionProfiles, updateVisionProfiles]);

  const deleteProfile = useCallback((modelId: string) => {
    const updated = userVisionProfiles.filter(p => p.modelId !== modelId);
    updateVisionProfiles(updated);
  }, [userVisionProfiles, updateVisionProfiles]);

  const startEdit = (profile: VisionModelProfile) => {
    setEditingProfileId(profile.modelId);
    setEditDraft({ ...profile });
  };

  const createNewProfile = () => {
    if (!newProfileId.trim()) return;
    const profile: VisionModelProfile = {
      modelId: newProfileId.trim(),
      label: newProfileId.trim().split('/').pop() || newProfileId.trim(),
      maxTokens: 1024,
      temperature: 0.3,
      maxImageDimension: 768,
      maxImageSizeBytes: 10 * 1024 * 1024,
      supportedFormats: ['png', 'jpeg'],
    };
    saveProfile(profile);
    setNewProfileId('');
    setShowNewProfile(false);
    startEdit(profile);
  };

  return (
    <div className="space-y-6">
      {/* Endpoint */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Eye className="h-4 w-4" />
          Vision (Optic) Configuration
        </h3>
        <p className="text-xs text-muted-foreground">
          Configure a vision-capable LLM for image analysis. Uses the OpenAI-compatible vision API format.
        </p>

        <div className="space-y-3">
          {/* Provider */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Provider</label>
            <Select
              value={settings.vision.visionProviderId || '_local'}
              onValueChange={(v) => {
                if (v === '_local') {
                  // Clear provider — endpoint stays as user's local endpoint
                  updateVisionSettings({ visionProviderId: undefined, apiKey: undefined });
                } else {
                  const provider = providers.find((p: LLMProviderConfig) => p.id === v);
                  if (provider) {
                    // Only set provider and model — do NOT overwrite endpoint
                    updateVisionSettings({
                      visionProviderId: v,
                      model: provider.models[0] || settings.vision.model,
                    });
                  }
                }
              }}
            >
              <SelectTrigger>
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
            {!settings.vision.visionProviderId && providers.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Add providers in Settings &gt; Providers to use cloud vision models
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="vision-endpoint">Endpoint</label>
            {settings.vision.visionProviderId ? (
              <>
                <Input
                  id="vision-endpoint"
                  value={providers.find((p: LLMProviderConfig) => p.id === settings.vision.visionProviderId)?.endpoint?.replace(/\/v1\/?$/, '') || settings.vision.endpoint}
                  disabled
                  className="text-muted-foreground"
                />
                <p className="text-xs text-muted-foreground">
                  Set by provider — edit in Settings &gt; Providers
                </p>
              </>
            ) : (
              <>
                <Input
                  id="vision-endpoint"
                  value={settings.vision.endpoint}
                  onChange={(e) => updateVisionSettings({ endpoint: e.target.value })}
                  placeholder="http://your-llm-host:1234"
                />
                <p className="text-xs text-muted-foreground">
                  Base URL of the vision-capable LLM server (without /v1)
                </p>
              </>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="vision-model">Model</label>
            <div className="flex gap-2">
              {(() => {
                const selectedProvider = providers.find((p: LLMProviderConfig) => p.id === settings.vision.visionProviderId);
                if (selectedProvider && selectedProvider.models.length > 0) {
                  return (
                    <Select
                      value={settings.vision.model}
                      onValueChange={(value) => updateVisionSettings({ model: value })}
                    >
                      <SelectTrigger id="vision-model" className="flex-1">
                        <SelectValue placeholder="Select a model" />
                      </SelectTrigger>
                      <SelectContent>
                        {selectedProvider.models.map((m: string) => (
                          <SelectItem key={m} value={m}>{m}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  );
                }
                return (
                  <>
                    <Select
                      value={settings.vision.model}
                      onValueChange={(value) => updateVisionSettings({ model: value })}
                    >
                      <SelectTrigger id="vision-model" className="flex-1">
                        <SelectValue placeholder="Select a model" />
                      </SelectTrigger>
                      <SelectContent>
                        {models.length > 0 ? (
                          models.map((model) => (
                            <SelectItem key={model} value={model}>
                              {model}
                            </SelectItem>
                          ))
                        ) : (
                          <SelectItem value={settings.vision.model}>
                            {settings.vision.model}
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={fetchModels}
                      disabled={loadingModels}
                    >
                      <RefreshCw className={`h-4 w-4 ${loadingModels ? 'animate-spin' : ''}`} />
                    </Button>
                  </>
                );
              })()}
            </div>
            <p className="text-xs text-muted-foreground">
              Must be a vision-capable model (e.g. llava, internvl, qwen-vl)
            </p>
          </div>
        </div>
      </div>

      {/* Generation Parameters */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium">Parameters</h3>

        <div className="space-y-3">
          <div className="space-y-2">
            <div className="flex justify-between">
              <label htmlFor="vision-max-tokens">Max Tokens</label>
              <span className="text-xs text-muted-foreground">{settings.vision.maxTokens}</span>
            </div>
            <Slider
              id="vision-max-tokens"
              min={128}
              max={4096}
              step={128}
              value={[settings.vision.maxTokens]}
              onValueChange={([value]) => updateVisionSettings({ maxTokens: value })}
            />
          </div>

          <div className="space-y-2">
            <div className="flex justify-between">
              <label htmlFor="vision-temperature">Temperature</label>
              <span className="text-xs text-muted-foreground">{settings.vision.temperature.toFixed(2)}</span>
            </div>
            <Slider
              id="vision-temperature"
              min={0}
              max={1}
              step={0.05}
              value={[settings.vision.temperature]}
              onValueChange={([value]) => updateVisionSettings({ temperature: value })}
            />
            <p className="text-xs text-muted-foreground">
              Lower = more focused analysis, higher = more creative descriptions
            </p>
          </div>
        </div>
      </div>

      {/* Test Connection */}
      <div className="space-y-4 pt-4 border-t">
        <Button
          onClick={testConnection}
          disabled={testing || !settings.vision.endpoint}
          className="w-full"
        >
          {testing ? (
            <>
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              Testing...
            </>
          ) : (
            <>
              <Eye className="h-4 w-4 mr-2" />
              Test Connection
            </>
          )}
        </Button>

        {testResult && (
          <div
            className={`p-4 rounded-lg ${
              testResult.success
                ? 'bg-green-500/10 border border-green-500/20'
                : 'bg-red-500/10 border border-red-500/20'
            }`}
          >
            {testResult.success ? (
              <div className="flex items-center gap-2 text-green-500">
                <Check className="h-4 w-4" />
                <span className="font-medium">{testResult.message}</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-red-500">
                <X className="h-4 w-4" />
                <span>{testResult.error}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ================================================================ */}
      {/* Vision Model Capabilities Section */}
      {/* ================================================================ */}
      <div className="border-t pt-4">
        <button
          onClick={() => setCapabilitiesOpen(!capabilitiesOpen)}
          className="flex items-center gap-2 w-full text-left"
        >
          {capabilitiesOpen ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <h3 className="text-sm font-medium">Vision Model Capabilities</h3>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            {effectiveProfiles.length}
          </Badge>
        </button>
        <p className="text-xs text-muted-foreground mt-1 ml-6">
          Per-model image processing settings. Controls max image dimensions, size limits, and supported formats.
        </p>

        {capabilitiesOpen && (
          <div className="mt-4 space-y-3">
            {/* New Profile */}
            <div className="flex gap-2">
              {showNewProfile ? (
                <>
                  <Input
                    value={newProfileId}
                    onChange={(e) => setNewProfileId(e.target.value)}
                    placeholder="model-id (e.g. gpt-4o)"
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
              <div key={profile.modelId} className="border rounded-lg p-3 space-y-2">
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
                          saveProfile({ ...profile, ...editDraft } as VisionModelProfile);
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
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => resetProfile(profile.modelId)}>
                            <RotateCcw className="h-3 w-3" />
                          </Button>
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
                  <VisionProfileEditor draft={editDraft} setDraft={setEditDraft} />
                ) : (
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {profile.maxImageDimension !== undefined && <span>maxDim={profile.maxImageDimension}px</span>}
                    {profile.maxImageSizeBytes !== undefined && <span>maxSize={Math.round(profile.maxImageSizeBytes / 1024 / 1024)}MB</span>}
                    {profile.maxTokens !== undefined && <span>maxTokens={profile.maxTokens}</span>}
                    {profile.temperature !== undefined && <span>temp={profile.temperature}</span>}
                    {profile.supportedFormats && <span>formats={profile.supportedFormats.join(',')}</span>}
                    {profile.outputFormat && <span>output={profile.outputFormat}</span>}
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
// Vision Profile Inline Editor
// ============================================================================

function VisionProfileEditor({
  draft,
  setDraft,
}: {
  draft: Partial<VisionModelProfile>;
  setDraft: React.Dispatch<React.SetStateAction<Partial<VisionModelProfile>>>;
}) {
  const formatOptions = ['png', 'jpeg', 'webp', 'gif', 'bmp'];

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

      {/* Max Image Dimension */}
      <div className="space-y-1">
        <div className="flex justify-between">
          <label className="text-xs font-medium">Max Image Dimension</label>
          <span className="text-xs text-muted-foreground">{draft.maxImageDimension ?? 768}px</span>
        </div>
        <Slider
          value={[draft.maxImageDimension ?? 768]}
          onValueChange={([v]) => setDraft(d => ({ ...d, maxImageDimension: v }))}
          min={256} max={4096} step={64}
          className="hover:cursor-pointer"
        />
        <p className="text-[10px] text-muted-foreground">Images will be resized to fit within this dimension</p>
      </div>

      {/* Max Image Size */}
      <div className="space-y-1">
        <div className="flex justify-between">
          <label className="text-xs font-medium">Max Image Size (MB)</label>
          <span className="text-xs text-muted-foreground">{Math.round((draft.maxImageSizeBytes ?? 10 * 1024 * 1024) / 1024 / 1024)}MB</span>
        </div>
        <Slider
          value={[Math.round((draft.maxImageSizeBytes ?? 10 * 1024 * 1024) / 1024 / 1024)]}
          onValueChange={([v]) => setDraft(d => ({ ...d, maxImageSizeBytes: v * 1024 * 1024 }))}
          min={1} max={50} step={1}
          className="hover:cursor-pointer"
        />
      </div>

      {/* Max Tokens */}
      <div className="space-y-1">
        <div className="flex justify-between">
          <label className="text-xs font-medium">Max Tokens</label>
          <span className="text-xs text-muted-foreground">{draft.maxTokens ?? 1024}</span>
        </div>
        <Slider
          value={[draft.maxTokens ?? 1024]}
          onValueChange={([v]) => setDraft(d => ({ ...d, maxTokens: v }))}
          min={128} max={4096} step={128}
          className="hover:cursor-pointer"
        />
      </div>

      {/* Temperature */}
      <div className="space-y-1">
        <div className="flex justify-between">
          <label className="text-xs font-medium">Temperature</label>
          <span className="text-xs text-muted-foreground">{(draft.temperature ?? 0.3).toFixed(2)}</span>
        </div>
        <Slider
          value={[draft.temperature ?? 0.3]}
          onValueChange={([v]) => setDraft(d => ({ ...d, temperature: v }))}
          min={0} max={1} step={0.05}
          className="hover:cursor-pointer"
        />
      </div>

      {/* Supported Formats */}
      <div className="space-y-1">
        <label className="text-xs font-medium">Supported Formats</label>
        <div className="flex flex-wrap gap-1.5">
          {formatOptions.map(fmt => {
            const active = (draft.supportedFormats || []).includes(fmt);
            return (
              <button
                key={fmt}
                className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                  active
                    ? 'bg-primary/10 border-primary/30 text-primary'
                    : 'border-border text-muted-foreground hover:border-primary/20'
                }`}
                onClick={() => {
                  const current = draft.supportedFormats || [];
                  setDraft(d => ({
                    ...d,
                    supportedFormats: active
                      ? current.filter(f => f !== fmt)
                      : [...current, fmt],
                  }));
                }}
              >
                {fmt}
              </button>
            );
          })}
        </div>
      </div>

      {/* Output Format */}
      <div className="space-y-1">
        <label className="text-xs font-medium">Output Format</label>
        <Select
          value={draft.outputFormat || '_auto'}
          onValueChange={(v) => setDraft(d => ({ ...d, outputFormat: v === '_auto' ? undefined : v }))}
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_auto">Auto (keep original)</SelectItem>
            <SelectItem value="png">PNG</SelectItem>
            <SelectItem value="jpeg">JPEG</SelectItem>
            <SelectItem value="webp">WebP</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-[10px] text-muted-foreground">Convert images to this format before sending to the model</p>
      </div>
    </div>
  );
}
