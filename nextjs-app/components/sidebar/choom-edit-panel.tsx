'use client';

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { RefreshCw, Info, Save, X, Plus, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import type { Choom, LoraConfig, ImageModeSettings, ImageSize, ImageAspect, LLMProviderConfig } from '@/lib/types';
import { IMAGE_SIZES, IMAGE_ASPECTS, computeImageDimensions } from '@/lib/types';
import { Switch } from '@/components/ui/switch';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';

interface ChoomEditPanelProps {
  choom: Choom | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (choom: Partial<Choom>) => Promise<void>;
}

interface ModelOption {
  id: string;
  name: string;
}

interface VoiceOption {
  id: string;
  name: string;
}

interface CheckpointOption {
  id: string;
  name: string;
  type: 'pony' | 'flux' | 'other';
}

interface LoraOption {
  id: string;
  name: string;
  path: string;
  category: 'pony' | 'flux' | 'other';
}

interface SamplerOption {
  id: string;
  name: string;
}

interface SchedulerOption {
  id: string;
  name: string;
}

// Default empty mode settings
const emptyModeSettings: ImageModeSettings = {
  checkpoint: undefined,
  checkpointType: undefined,
  loras: [],
  negativePrompt: undefined,
  promptPrefix: undefined,
  promptSuffix: undefined,
  sampler: undefined,
  scheduler: undefined,
  steps: undefined,
  cfgScale: undefined,
  distilledCfg: undefined,
  width: undefined,
  height: undefined,
};

// IMPORTANT: This component is defined OUTSIDE ChoomEditPanel to prevent
// re-mounting on every parent state change (which causes input focus loss)
interface ImageModeSettingsEditorProps {
  mode: 'general' | 'selfPortrait';
  settings: ImageModeSettings & { characterPrompt?: string };
  onSettingsChange: (updates: Partial<ImageModeSettings & { characterPrompt?: string }>) => void;
  checkpoints: CheckpointOption[];
  availableLoras: LoraOption[];
  samplers: SamplerOption[];
  schedulers: SchedulerOption[];
}

function ImageModeSettingsEditor({
  mode,
  settings: modeSettings,
  onSettingsChange,
  checkpoints,
  availableLoras,
  samplers,
  schedulers,
}: ImageModeSettingsEditorProps) {
  const currentCheckpointType = useMemo(() => {
    const cp = checkpoints.find(c => c.id === modeSettings.checkpoint);
    return cp?.type || 'other';
  }, [modeSettings.checkpoint, checkpoints]);

  const filteredLoras = useMemo(() => {
    if (currentCheckpointType === 'other') return availableLoras;
    return availableLoras.filter(l => l.category === currentCheckpointType || l.category === 'other');
  }, [currentCheckpointType, availableLoras]);

  const addLora = useCallback(() => {
    onSettingsChange({
      loras: [...(modeSettings.loras || []), { name: '', weight: 1.0 }]
    });
  }, [modeSettings.loras, onSettingsChange]);

  const updateLora = useCallback((index: number, updates: Partial<LoraConfig>) => {
    onSettingsChange({
      loras: (modeSettings.loras || []).map((l, i) => i === index ? { ...l, ...updates } : l)
    });
  }, [modeSettings.loras, onSettingsChange]);

  const removeLora = useCallback((index: number) => {
    onSettingsChange({
      loras: (modeSettings.loras || []).filter((_, i) => i !== index)
    });
  }, [modeSettings.loras, onSettingsChange]);

  return (
    <div className="space-y-4">
      {/* Character Prompt - only for self-portrait */}
      {mode === 'selfPortrait' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">Character Description</label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">
                  Base prompt describing what this Choom looks like. This will be prepended to all self-portrait generations.
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
          <Textarea
            value={modeSettings.characterPrompt || ''}
            onChange={(e) => onSettingsChange({ characterPrompt: e.target.value })}
            placeholder="e.g., anime girl with long purple hair, blue eyes, detailed face..."
            rows={3}
            className="hover:border-primary/50 transition-colors resize-none"
          />
        </div>
      )}

      {/* Checkpoint */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">Checkpoint</label>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent>
              <p>SD checkpoint to use for {mode === 'selfPortrait' ? 'self-portraits' : 'general images'}</p>
            </TooltipContent>
          </Tooltip>
        </div>
        {checkpoints.length > 0 ? (
          <Select
            value={modeSettings.checkpoint || '__default__'}
            onValueChange={(v) => onSettingsChange({ checkpoint: v === '__default__' ? undefined : v })}
          >
            <SelectTrigger className="hover:border-primary/50 transition-colors">
              <SelectValue placeholder="Use default checkpoint" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">Use default checkpoint</SelectItem>
              {['pony', 'flux', 'other'].map((type) => {
                const typeCheckpoints = checkpoints.filter(cp => cp.type === type);
                if (typeCheckpoints.length === 0) return null;
                return (
                  <React.Fragment key={type}>
                    <SelectItem value={`__header_${type}__`} disabled className="font-semibold uppercase text-xs text-muted-foreground">
                      {type} ({typeCheckpoints.length})
                    </SelectItem>
                    {typeCheckpoints.map((cp) => (
                      <SelectItem key={cp.id} value={cp.id}>
                        <span className="flex items-center gap-2">
                          {cp.name}
                          <span className={cn(
                            'px-1 py-0.5 text-[10px] rounded',
                            cp.type === 'pony' ? 'bg-pink-500/10 text-pink-500' :
                            cp.type === 'flux' ? 'bg-blue-500/10 text-blue-500' :
                            'bg-muted text-muted-foreground'
                          )}>
                            {cp.type}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </React.Fragment>
                );
              })}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={modeSettings.checkpoint || ''}
            onChange={(e) => onSettingsChange({ checkpoint: e.target.value || undefined })}
            placeholder="Leave empty to use default"
            className="hover:border-primary/50 transition-colors"
          />
        )}
      </div>

      {/* LoRAs */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">LoRAs</label>
            {currentCheckpointType !== 'other' && (
              <span className={cn(
                'px-2 py-0.5 text-xs rounded-full',
                currentCheckpointType === 'pony' ? 'bg-pink-500/10 text-pink-500' : 'bg-blue-500/10 text-blue-500'
              )}>
                {filteredLoras.length} {currentCheckpointType} LoRAs
              </span>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={addLora}>
            <Plus className="h-4 w-4 mr-1" />
            Add
          </Button>
        </div>
        {(modeSettings.loras || []).map((lora, index) => (
          <div key={index} className="flex items-center gap-2">
            {filteredLoras.length > 0 ? (
              <Select
                value={lora.name || ''}
                onValueChange={(v) => updateLora(index, { name: v })}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Select LoRA" />
                </SelectTrigger>
                <SelectContent>
                  {filteredLoras.map((l) => (
                    <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={lora.name}
                onChange={(e) => updateLora(index, { name: e.target.value })}
                placeholder="LoRA name"
                className="flex-1"
              />
            )}
            <div className="flex items-center gap-2 w-32">
              <Slider
                value={[lora.weight]}
                onValueChange={([v]) => updateLora(index, { weight: v })}
                min={0}
                max={2}
                step={0.1}
                className="flex-1"
              />
              <span className="text-xs w-8">{lora.weight}</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => removeLora(index)}>
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        ))}
      </div>

      {/* Prompt Prefix/Suffix */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">Prompt Prefix</label>
          <Input
            value={modeSettings.promptPrefix || ''}
            onChange={(e) => onSettingsChange({ promptPrefix: e.target.value || undefined })}
            placeholder="Added before prompt"
            className="hover:border-primary/50 transition-colors"
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">Prompt Suffix</label>
          <Input
            value={modeSettings.promptSuffix || ''}
            onChange={(e) => onSettingsChange({ promptSuffix: e.target.value || undefined })}
            placeholder="Added after prompt"
            className="hover:border-primary/50 transition-colors"
          />
        </div>
      </div>

      {/* Negative Prompt */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Negative Prompt</label>
        <Textarea
          value={modeSettings.negativePrompt || ''}
          onChange={(e) => onSettingsChange({ negativePrompt: e.target.value || undefined })}
          placeholder="e.g., blurry, low quality, deformed..."
          rows={2}
          className="hover:border-primary/50 transition-colors resize-none"
        />
      </div>

      <Separator />

      {/* Generation Parameters */}
      <div className="space-y-4">
        <h4 className="text-sm font-medium">Generation Parameters</h4>

        {/* Sampler & Scheduler */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Sampler</label>
            {samplers.length > 0 ? (
              <Select
                value={modeSettings.sampler || '__default__'}
                onValueChange={(v) => onSettingsChange({ sampler: v === '__default__' ? undefined : v })}
              >
                <SelectTrigger><SelectValue placeholder="Default" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">Default</SelectItem>
                  {samplers.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={modeSettings.sampler || ''}
                onChange={(e) => onSettingsChange({ sampler: e.target.value || undefined })}
                placeholder="e.g., Euler a"
              />
            )}
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Scheduler</label>
            {schedulers.length > 0 ? (
              <Select
                value={modeSettings.scheduler || '__default__'}
                onValueChange={(v) => onSettingsChange({ scheduler: v === '__default__' ? undefined : v })}
              >
                <SelectTrigger><SelectValue placeholder="Default" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">Default</SelectItem>
                  {schedulers.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={modeSettings.scheduler || ''}
                onChange={(e) => onSettingsChange({ scheduler: e.target.value || undefined })}
                placeholder="e.g., Normal"
              />
            )}
          </div>
        </div>

        {/* Steps & CFG */}
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Steps</label>
            <Input
              type="number"
              value={modeSettings.steps ?? ''}
              onChange={(e) => onSettingsChange({ steps: e.target.value ? parseInt(e.target.value) : undefined })}
              placeholder="Default"
              min={1}
              max={150}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">CFG Scale</label>
            <Input
              type="number"
              value={modeSettings.cfgScale ?? ''}
              onChange={(e) => onSettingsChange({ cfgScale: e.target.value ? parseFloat(e.target.value) : undefined })}
              placeholder="Default"
              min={1}
              max={30}
              step={0.5}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Distilled CFG</label>
            <Input
              type="number"
              value={modeSettings.distilledCfg ?? ''}
              onChange={(e) => onSettingsChange({ distilledCfg: e.target.value ? parseFloat(e.target.value) : undefined })}
              placeholder="Default"
              min={1}
              max={10}
              step={0.5}
            />
          </div>
        </div>

        {/* Size & Aspect Presets */}
        <Separator />
        <h4 className="text-sm font-medium">Size & Aspect Presets</h4>
        <p className="text-xs text-muted-foreground">
          Use presets for automatic dimension calculation, or override with manual Width/Height below.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Default Size</label>
            <Select
              value={modeSettings.size || '__default__'}
              onValueChange={(v) => onSettingsChange({ size: v === '__default__' ? undefined : v as ImageSize })}
            >
              <SelectTrigger><SelectValue placeholder="Default" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">Default</SelectItem>
                {(Object.entries(IMAGE_SIZES) as [ImageSize, number][]).map(([key, px]) => (
                  <SelectItem key={key} value={key}>{key} ({px}px)</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Default Aspect</label>
            <Select
              value={modeSettings.aspect || '__default__'}
              onValueChange={(v) => onSettingsChange({ aspect: v === '__default__' ? undefined : v as ImageAspect })}
            >
              <SelectTrigger><SelectValue placeholder="Default" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">Default</SelectItem>
                {(Object.entries(IMAGE_ASPECTS) as [ImageAspect, { label: string }][]).map(([key, { label }]) => {
                  if (mode === 'selfPortrait' && !['portrait', 'portrait-tall', 'square'].includes(key)) return null;
                  return <SelectItem key={key} value={key}>{label}</SelectItem>;
                })}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Preview computed dimensions */}
        {modeSettings.size && modeSettings.aspect && (
          <p className="text-xs text-muted-foreground">
            Computed: {computeImageDimensions(modeSettings.size, modeSettings.aspect).width} x {computeImageDimensions(modeSettings.size, modeSettings.aspect).height}px
          </p>
        )}

        {/* Upscale & Choom Decides */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <label className="text-sm font-medium">2x Upscaling</label>
            <p className="text-xs text-muted-foreground">
              Upscale images 2x using Lanczos after generation
            </p>
          </div>
          <Switch
            checked={modeSettings.upscale || false}
            onCheckedChange={(checked) => onSettingsChange({ upscale: checked || undefined })}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <label className="text-sm font-medium">Choom Decides Size</label>
            <p className="text-xs text-muted-foreground">
              Let the LLM pick size and aspect for each image
            </p>
          </div>
          <Switch
            checked={modeSettings.choomDecides || false}
            onCheckedChange={(checked) => onSettingsChange({ choomDecides: checked || undefined })}
          />
        </div>

        <Separator />

        {/* Manual Width & Height Override */}
        <h4 className="text-sm font-medium">Manual Dimensions Override</h4>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Width</label>
            <Select
              value={modeSettings.width ? String(modeSettings.width) : '__default__'}
              onValueChange={(v) => onSettingsChange({ width: v === '__default__' ? undefined : parseInt(v) })}
            >
              <SelectTrigger><SelectValue placeholder="Default" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">Default</SelectItem>
                {[512, 768, 896, 1024, 1152, 1280, 1344].map(w => (
                  <SelectItem key={w} value={String(w)}>{w}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Height</label>
            <Select
              value={modeSettings.height ? String(modeSettings.height) : '__default__'}
              onValueChange={(v) => onSettingsChange({ height: v === '__default__' ? undefined : parseInt(v) })}
            >
              <SelectTrigger><SelectValue placeholder="Default" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">Default</SelectItem>
                {[512, 768, 896, 1024, 1152, 1280, 1344].map(h => (
                  <SelectItem key={h} value={String(h)}>{h}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChoomEditPanel({ choom, open, onOpenChange, onSave }: ChoomEditPanelProps) {
  // Get settings for endpoints
  const { settings } = useAppStore();

  // Basic info
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [companionId, setCompanionId] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [llmModel, setLlmModel] = useState('');
  const [llmEndpoint, setLlmEndpoint] = useState('');
  const [llmProviderId, setLlmProviderId] = useState('');

  // Image settings - now with two modes
  const [generalSettings, setGeneralSettings] = useState<ImageModeSettings>({ ...emptyModeSettings });
  const [selfPortraitSettings, setSelfPortraitSettings] = useState<ImageModeSettings & { characterPrompt?: string }>({ ...emptyModeSettings });

  // Current image tab
  const [imageTab, setImageTab] = useState<'general' | 'selfPortrait'>('general');

  // Dropdown options
  const [models, setModels] = useState<ModelOption[]>([]);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointOption[]>([]);
  const [availableLoras, setAvailableLoras] = useState<LoraOption[]>([]);
  const [samplers, setSamplers] = useState<SamplerOption[]>([]);
  const [schedulers, setSchedulers] = useState<SchedulerOption[]>([]);
  const [isLoadingOptions, setIsLoadingOptions] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Load initial data when choom changes
  useEffect(() => {
    if (choom) {
      setName(choom.name || '');
      setDescription(choom.description || '');
      setSystemPrompt(choom.systemPrompt || '');
      setAvatarUrl(choom.avatarUrl || '');
      setCompanionId(choom.companionId || '');
      setVoiceId(choom.voiceId || '');
      setLlmModel(choom.llmModel || '');
      setLlmEndpoint(choom.llmEndpoint || '');
      setLlmProviderId(choom.llmProviderId || '');

      // Parse image settings
      const imgSettings = choom.imageSettings;
      if (imgSettings) {
        setGeneralSettings(imgSettings.general || { ...emptyModeSettings });
        setSelfPortraitSettings(imgSettings.selfPortrait || { ...emptyModeSettings });
      } else {
        setGeneralSettings({ ...emptyModeSettings });
        setSelfPortraitSettings({ ...emptyModeSettings });
      }
    }
  }, [choom]);

  // Fetch local models from the actual LM Studio endpoint.
  // Accepts an optional override so callers can pass the correct endpoint
  // immediately after a state change (React batches setState, so reading
  // `llmEndpoint` inside the same event handler would return the OLD value).
  const fetchLocalModels = async (endpointOverride?: string) => {
    try {
      const ep = endpointOverride || llmEndpoint || settings.llm.endpoint;
      const res = await fetch(`/api/services/models?endpoint=${encodeURIComponent(ep)}`);
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
      console.error('Failed to fetch local models:', error);
    }
  };

  // Fetch options from services
  const fetchOptions = async () => {
    setIsLoadingOptions(true);
    try {
      const ttsEndpointParam = encodeURIComponent(settings.tts.endpoint);
      const imageGenEndpointParam = encodeURIComponent(settings.imageGen.endpoint);

      const [modelsRes, voicesRes, checkpointsRes] = await Promise.allSettled([
        fetchLocalModels(settings.llm.endpoint),
        fetch(`/api/services/voices?endpoint=${ttsEndpointParam}`),
        fetch(`/api/services/checkpoints?endpoint=${imageGenEndpointParam}`),
      ]);

      if (voicesRes.status === 'fulfilled' && voicesRes.value.ok) {
        const data = await voicesRes.value.json();
        setVoices(data.voices || []);
      }

      if (checkpointsRes.status === 'fulfilled' && checkpointsRes.value.ok) {
        const data = await checkpointsRes.value.json();
        setCheckpoints(data.checkpoints || []);
        setAvailableLoras(data.loras || []);
        setSamplers(data.samplers || []);
        setSchedulers(data.schedulers || []);
      }
    } catch (error) {
      console.error('Failed to fetch options:', error);
    } finally {
      setIsLoadingOptions(false);
    }
  };

  useEffect(() => {
    if (open) {
      fetchOptions();
    }
  }, [open]);

  const handleSave = async () => {
    if (!choom) return;

    setIsSaving(true);
    try {
      // Clean up empty settings
      const cleanSettings = (s: ImageModeSettings) => {
        const result: ImageModeSettings = {};
        if (s.checkpoint) result.checkpoint = s.checkpoint;
        if (s.checkpointType) result.checkpointType = s.checkpointType;
        if (s.loras && s.loras.length > 0) result.loras = s.loras;
        if (s.negativePrompt) result.negativePrompt = s.negativePrompt;
        if (s.promptPrefix) result.promptPrefix = s.promptPrefix;
        if (s.promptSuffix) result.promptSuffix = s.promptSuffix;
        if (s.sampler) result.sampler = s.sampler;
        if (s.scheduler) result.scheduler = s.scheduler;
        if (s.steps !== undefined && s.steps !== null) result.steps = s.steps;
        if (s.cfgScale !== undefined && s.cfgScale !== null) result.cfgScale = s.cfgScale;
        if (s.distilledCfg !== undefined && s.distilledCfg !== null) result.distilledCfg = s.distilledCfg;
        if (s.width !== undefined && s.width !== null) result.width = s.width;
        if (s.height !== undefined && s.height !== null) result.height = s.height;
        if (s.size) result.size = s.size;
        if (s.aspect) result.aspect = s.aspect;
        if (s.upscale) result.upscale = s.upscale;
        if (s.choomDecides) result.choomDecides = s.choomDecides;
        return Object.keys(result).length > 0 ? result : undefined;
      };

      const cleanedGeneral = cleanSettings(generalSettings);
      const cleanedSelfPortrait = cleanSettings(selfPortraitSettings);
      const selfPortraitWithCharacter = cleanedSelfPortrait
        ? { ...cleanedSelfPortrait, characterPrompt: selfPortraitSettings.characterPrompt || undefined }
        : selfPortraitSettings.characterPrompt
          ? { characterPrompt: selfPortraitSettings.characterPrompt }
          : undefined;

      await onSave({
        id: choom.id,
        name,
        description: description || null,
        systemPrompt,
        avatarUrl: avatarUrl || null,
        companionId: companionId || null,
        voiceId: voiceId || null,
        llmModel: llmModel || null,
        llmEndpoint: llmEndpoint || null,
        llmProviderId: llmProviderId || null,
        imageSettings: (cleanedGeneral || selfPortraitWithCharacter) ? {
          general: cleanedGeneral,
          selfPortrait: selfPortraitWithCharacter,
        } : null,
      });
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to save choom:', error);
    } finally {
      setIsSaving(false);
    }
  };

  // Memoized callbacks for image settings updates
  const handleGeneralSettingsChange = useCallback((updates: Partial<ImageModeSettings & { characterPrompt?: string }>) => {
    setGeneralSettings(prev => ({ ...prev, ...updates }));
  }, []);

  const handleSelfPortraitSettingsChange = useCallback((updates: Partial<ImageModeSettings & { characterPrompt?: string }>) => {
    setSelfPortraitSettings(prev => ({ ...prev, ...updates }));
  }, []);

  if (!choom) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] p-0">
        <DialogHeader className="p-6 pb-0">
          <DialogTitle className="flex items-center justify-between">
            <span>Edit Choom: {choom.name}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchOptions}
              disabled={isLoadingOptions}
              className="h-8"
            >
              <RefreshCw className={cn('h-4 w-4', isLoadingOptions && 'animate-spin')} />
              <span className="ml-2 text-xs">Refresh</span>
            </Button>
          </DialogTitle>
          <DialogDescription>
            Configure personality, voice, model, and image generation settings.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="basic" className="w-full">
          <TabsList className="w-full justify-start px-6 bg-transparent border-b rounded-none">
            <TabsTrigger value="basic">Basic</TabsTrigger>
            <TabsTrigger value="prompt">Prompt</TabsTrigger>
            <TabsTrigger value="voice-model">Voice/Model</TabsTrigger>
            <TabsTrigger value="image">Images</TabsTrigger>
          </TabsList>

          <ScrollArea className="h-[55vh]">
            <div className="p-6">
              {/* Basic Info Tab */}
              <TabsContent value="basic" className="mt-0 space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Name</label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Enter name" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Description</label>
                  <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe this Choom..." rows={3} />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <label className="text-sm font-medium">Avatar</label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="max-w-xs">Enter a URL, browse for a file, or drag and drop an image. The image will be stored in the app. Recommended: PNG or JPG, 256x256 pixels or larger.</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      value={avatarUrl}
                      onChange={(e) => setAvatarUrl(e.target.value)}
                      placeholder="URL or drop image here"
                      className="flex-1"
                    />
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      id="avatar-file-input"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          const reader = new FileReader();
                          reader.onload = (ev) => {
                            if (ev.target?.result) {
                              setAvatarUrl(ev.target.result as string);
                            }
                          };
                          reader.readAsDataURL(file);
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => document.getElementById('avatar-file-input')?.click()}
                    >
                      Browse
                    </Button>
                  </div>
                  <div
                    className={cn(
                      "mt-2 border-2 border-dashed rounded-lg p-4 text-center transition-colors",
                      "hover:border-primary/50 cursor-pointer",
                      avatarUrl ? "border-transparent" : "border-border"
                    )}
                    onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-primary'); }}
                    onDragLeave={(e) => { e.currentTarget.classList.remove('border-primary'); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.currentTarget.classList.remove('border-primary');
                      const file = e.dataTransfer.files[0];
                      if (file && file.type.startsWith('image/')) {
                        const reader = new FileReader();
                        reader.onload = (ev) => {
                          if (ev.target?.result) {
                            setAvatarUrl(ev.target.result as string);
                          }
                        };
                        reader.readAsDataURL(file);
                      }
                    }}
                    onClick={() => !avatarUrl && document.getElementById('avatar-file-input')?.click()}
                  >
                    {avatarUrl ? (
                      <div className="relative w-20 h-20 mx-auto rounded-lg overflow-hidden bg-muted">
                        <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          className="absolute -top-1 -right-1 h-6 w-6 p-0 rounded-full"
                          onClick={(e) => { e.stopPropagation(); setAvatarUrl(''); }}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">Drop image here or click to browse</p>
                    )}
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <label className="text-sm font-medium">Memory ID</label>
                    <Tooltip>
                      <TooltipTrigger asChild><Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" /></TooltipTrigger>
                      <TooltipContent><p>Custom ID for this Choom&apos;s memories</p></TooltipContent>
                    </Tooltip>
                  </div>
                  <Input value={companionId} onChange={(e) => setCompanionId(e.target.value)} placeholder="Leave empty to use Choom ID" className="font-mono text-sm" />
                  <p className="text-xs text-muted-foreground">Current: {companionId || choom?.id || 'Not set'}</p>
                </div>
              </TabsContent>

              {/* System Prompt Tab */}
              <TabsContent value="prompt" className="mt-0 space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">System Prompt</label>
                  <Textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="You are a helpful AI assistant..." rows={20} className="font-mono text-sm" />
                  <p className="text-xs text-muted-foreground">{systemPrompt.length} characters</p>
                </div>
              </TabsContent>

              {/* Voice & Model Tab */}
              <TabsContent value="voice-model" className="mt-0 space-y-6">
                <div>
                  <h4 className="text-sm font-medium mb-4">Voice</h4>
                  {voices.length > 0 ? (
                    <Select value={voiceId || '__default__'} onValueChange={(v) => setVoiceId(v === '__default__' ? '' : v)}>
                      <SelectTrigger><SelectValue placeholder="Use default voice" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__default__">Use default voice</SelectItem>
                        {voices.map((voice) => <SelectItem key={voice.id} value={voice.id}>{voice.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input value={voiceId} onChange={(e) => setVoiceId(e.target.value)} placeholder="Leave empty to use default" />
                  )}
                </div>
                <Separator />
                <div className="space-y-4">
                  <h4 className="text-sm font-medium">LLM Provider</h4>
                  <Select
                    value={llmProviderId || '_local'}
                    onValueChange={(v) => {
                      if (v === '_local') {
                        setLlmProviderId('');
                        setLlmEndpoint('');
                        setLlmModel('');
                        // Pass the local endpoint directly — state hasn't updated yet
                        fetchLocalModels(settings.llm.endpoint);
                      } else {
                        const provider = (settings.providers || []).find((p: LLMProviderConfig) => p.id === v);
                        setLlmProviderId(v);
                        setLlmEndpoint(provider?.endpoint || '');
                        setLlmModel(provider?.models?.[0] || '');
                      }
                    }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_local">Local (LM Studio / Ollama)</SelectItem>
                      {(settings.providers || []).map((p: LLMProviderConfig) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                          <span className="ml-2 text-xs text-muted-foreground">({p.type})</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">Model</label>
                    {(() => {
                      const selectedProvider = (settings.providers || []).find((p: LLMProviderConfig) => p.id === llmProviderId);
                      if (selectedProvider && selectedProvider.models.length > 0) {
                        // Provider model dropdown
                        return (
                          <Select value={llmModel || '_default'} onValueChange={(v) => setLlmModel(v === '_default' ? '' : v)}>
                            <SelectTrigger><SelectValue placeholder="Select model" /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="_default">Default ({selectedProvider.models[0]})</SelectItem>
                              {selectedProvider.models.map((m: string) => (
                                <SelectItem key={m} value={m}>{m}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        );
                      }
                      // Local models dropdown or text input
                      return models.length > 0 ? (
                        <Select value={llmModel || '__default__'} onValueChange={(v) => setLlmModel(v === '__default__' ? '' : v)}>
                          <SelectTrigger><SelectValue placeholder="Use default model" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__default__">Use default model</SelectItem>
                            {models.map((model) => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input value={llmModel} onChange={(e) => setLlmModel(e.target.value)} placeholder="Leave empty to use default" />
                      );
                    })()}
                  </div>

                  {/* Show endpoint (read-only for providers, editable for local) */}
                  {llmProviderId ? (
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Endpoint</label>
                      <Input value={llmEndpoint} disabled className="text-sm text-muted-foreground" />
                      <p className="text-xs text-muted-foreground">Set by provider — edit in Settings &gt; Providers</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Endpoint Override</label>
                      <Input value={llmEndpoint} onChange={(e) => setLlmEndpoint(e.target.value)} placeholder="Leave empty to use default" />
                    </div>
                  )}
                </div>
              </TabsContent>

              {/* Image Settings Tab - with sub-tabs for General and Self-Portrait */}
              <TabsContent value="image" className="mt-0">
                <Tabs value={imageTab} onValueChange={(v) => setImageTab(v as 'general' | 'selfPortrait')}>
                  <TabsList className="w-full mb-4">
                    <TabsTrigger value="general" className="flex-1">General Images</TabsTrigger>
                    <TabsTrigger value="selfPortrait" className="flex-1">Self-Portraits</TabsTrigger>
                  </TabsList>

                  <TabsContent value="general" className="mt-0">
                    <p className="text-xs text-muted-foreground mb-4">
                      Settings for general image generation (landscapes, objects, etc.)
                    </p>
                    <ImageModeSettingsEditor
                      mode="general"
                      settings={generalSettings}
                      onSettingsChange={handleGeneralSettingsChange}
                      checkpoints={checkpoints}
                      availableLoras={availableLoras}
                      samplers={samplers}
                      schedulers={schedulers}
                    />
                  </TabsContent>

                  <TabsContent value="selfPortrait" className="mt-0">
                    <p className="text-xs text-muted-foreground mb-4">
                      Settings for self-portrait generation (images of this Choom)
                    </p>
                    <ImageModeSettingsEditor
                      mode="selfPortrait"
                      settings={selfPortraitSettings}
                      onSettingsChange={handleSelfPortraitSettingsChange}
                      checkpoints={checkpoints}
                      availableLoras={availableLoras}
                      samplers={samplers}
                      schedulers={schedulers}
                    />
                  </TabsContent>
                </Tabs>
              </TabsContent>
            </div>
          </ScrollArea>
        </Tabs>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <X className="h-4 w-4 mr-2" />
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            <Save className="h-4 w-4 mr-2" />
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
