'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { RefreshCw, Info } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
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
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Separator } from '@/components/ui/separator';
import { ReferenceLibrarySettings } from './reference-library-settings';
import type { CheckpointType, ImageEngine } from '@/lib/types';

// What the H3 Image server is doing, in words (GET /api/services/h3image).
function h3StatusWords(h: { ok?: boolean; state?: string; error?: string } | null): string {
  if (!h) return 'checking...';
  if (!h.ok) return h.error || 'not answering';
  return ({
    ready: 'loaded, ready for pictures',
    busy: 'making a picture',
    loading: 'loading the model (about 2 minutes)',
    released: 'stepped aside for a Glass Studio render; loads again when it ends',
    off: 'not loaded (loads with the first picture, about 2 minutes)',
  } as Record<string, string>)[h.state || ''] || h.state || 'unknown';
}

interface CheckpointOption {
  id: string;
  name: string;
  type: CheckpointType;
}

interface SamplerOption {
  id: string;
  name: string;
}

interface SchedulerOption {
  id: string;
  name: string;
}

export function ImageSettings() {
  const { settings, updateImageGenSettings } = useAppStore();
  const imageGen = settings.imageGen;

  const [checkpoints, setCheckpoints] = useState<CheckpointOption[]>([]);
  const [samplers, setSamplers] = useState<SamplerOption[]>([]);
  const [schedulers, setSchedulers] = useState<SchedulerOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const engine: ImageEngine = imageGen.engine || 'forge';
  const [h3Status, setH3Status] = useState<{ ok?: boolean; state?: string; error?: string; endpoint?: string } | null>(null);
  useEffect(() => {
    if (engine !== 'h3image') return;
    let stop = false;
    const look = () => fetch('/api/services/h3image').then((r) => r.json()).then((h) => { if (!stop) setH3Status(h); }).catch(() => {});
    look();
    const timer = setInterval(look, 5000);
    return () => { stop = true; clearInterval(timer); };
  }, [engine]);
  const h3Placeholder = useMemo(() => {
    try { const u = new URL(imageGen.endpoint || 'http://localhost:7860'); u.port = '7870'; return u.origin; } catch { return 'http://localhost:7870'; }
  }, [imageGen.endpoint]);

  // Detect current checkpoint type for Flux-specific options
  const currentCheckpointType = useMemo(() => {
    const cp = checkpoints.find(c => c.id === imageGen.defaultCheckpoint);
    return cp?.type || 'other';
  }, [checkpoints, imageGen.defaultCheckpoint]);

  const fetchOptions = async () => {
    setIsLoading(true);
    try {
      // Use endpoint from settings
      const endpoint = encodeURIComponent(imageGen.endpoint);
      const res = await fetch(`/api/services/checkpoints?endpoint=${endpoint}`);
      if (res.ok) {
        const data = await res.json();
        setCheckpoints(data.checkpoints || []);
        setSamplers(data.samplers || []);
        setSchedulers(data.schedulers || []);
      }
    } catch (error) {
      console.error('Failed to fetch image gen options:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchOptions();
  }, [imageGen.endpoint]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium mb-1">Image Generation</h3>
          <p className="text-xs text-muted-foreground">
            Which model makes the Chooms' pictures, and its settings
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={fetchOptions}
          disabled={isLoading}
          className="h-8 px-2"
        >
          <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
          <span className="ml-2 text-xs">Refresh</span>
        </Button>
      </div>

      {/* Image engine: Forge (Klein) or MiniMax H3 Image on the NUC */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">Image engine</label>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs">Which model makes the Chooms' pictures. Switching keeps both engines' settings, so you can switch back at any time.</p>
            </TooltipContent>
          </Tooltip>
        </div>
        <Select value={engine} onValueChange={(v) => updateImageGenSettings({ engine: v as ImageEngine })}>
          <SelectTrigger className="hover:border-primary/50 transition-colors">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="forge">Forge: Flux.2 Klein (each Choom's own settings)</SelectItem>
            <SelectItem value="h3image">MiniMax H3 Image (on the NUC)</SelectItem>
          </SelectContent>
        </Select>
        {engine === 'h3image' && (
          <div className="rounded-md border border-border/60 p-3 space-y-2 text-xs text-muted-foreground">
            <p>
              H3 Image has one fixed recipe (6 steps, no CFG, no LoRAs). The checkpoint, steps, sampler, scheduler,
              LoRA and hires-fix settings here and in each Choom apply to Klein only, and are kept for switching back.
              Size, aspect and reference pictures apply to both. A picture asked for during a Glass Studio clip render
              waits for the clip it's on (a few minutes).
            </p>
            <div className="flex items-center gap-2">
              <span className="shrink-0">Server</span>
              <Input
                value={imageGen.h3Endpoint || ''}
                onChange={(e) => updateImageGenSettings({ h3Endpoint: e.target.value })}
                placeholder={`${h3Status?.endpoint || h3Placeholder} (default; type here only to use another)`}
                className="h-7 text-xs"
              />
            </div>
            <p>Using {h3Status?.endpoint || h3Placeholder}: the H3 Image server on the NUC. Status: {h3StatusWords(h3Status)}</p>
            <p>Each Choom can also have her own engine (her settings &gt; Image), which wins over this one.</p>
          </div>
        )}
      </div>

      {/* Endpoint */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">Forge Endpoint</label>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs">URL of your Stable Diffusion Forge WebUI API</p>
            </TooltipContent>
          </Tooltip>
        </div>
        <Input
          value={imageGen.endpoint}
          onChange={(e) => updateImageGenSettings({ endpoint: e.target.value })}
          placeholder="http://localhost:7860"
          className="hover:border-primary/50 focus:border-primary transition-colors"
        />
      </div>

      {/* Default Checkpoint - Dynamic Dropdown */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">Default Checkpoint</label>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs">The SD model checkpoint to use for generation</p>
            </TooltipContent>
          </Tooltip>
        </div>
        {checkpoints.length > 0 ? (
          <Select
            value={imageGen.defaultCheckpoint || '__server_default__'}
            onValueChange={(v) => updateImageGenSettings({ defaultCheckpoint: v === '__server_default__' ? '' : v })}
          >
            <SelectTrigger className="hover:border-primary/50 transition-colors">
              <SelectValue placeholder="Select a checkpoint" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__server_default__">Use server default</SelectItem>
              {checkpoints.map((cp) => (
                <SelectItem key={cp.id} value={cp.id}>
                  {cp.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={imageGen.defaultCheckpoint}
            onChange={(e) => updateImageGenSettings({ defaultCheckpoint: e.target.value })}
            placeholder="Leave empty for server default"
            className="hover:border-primary/50 focus:border-primary transition-colors"
          />
        )}
      </div>

      {/* Sampler - Dynamic or Static */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">Default Sampler</label>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs">Sampling algorithm for image generation</p>
            </TooltipContent>
          </Tooltip>
        </div>
        <Select
          value={imageGen.defaultSampler}
          onValueChange={(v) => updateImageGenSettings({ defaultSampler: v })}
        >
          <SelectTrigger className="hover:border-primary/50 transition-colors">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {samplers.length > 0 ? (
              samplers.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))
            ) : (
              <>
                <SelectItem value="Euler a">Euler a</SelectItem>
                <SelectItem value="Euler">Euler</SelectItem>
                <SelectItem value="DPM++ 2M">DPM++ 2M</SelectItem>
                <SelectItem value="DPM++ 2M Karras">DPM++ 2M Karras</SelectItem>
                <SelectItem value="DPM++ SDE">DPM++ SDE</SelectItem>
                <SelectItem value="DPM++ SDE Karras">DPM++ SDE Karras</SelectItem>
                <SelectItem value="DDIM">DDIM</SelectItem>
                <SelectItem value="UniPC">UniPC</SelectItem>
              </>
            )}
          </SelectContent>
        </Select>
      </div>

      {/* Steps */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">Default Steps</label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">Number of denoising steps. More = better quality but slower.</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <span className="text-sm text-muted-foreground">
            {imageGen.defaultSteps}
          </span>
        </div>
        <Slider
          value={[imageGen.defaultSteps]}
          onValueChange={([v]) => updateImageGenSettings({ defaultSteps: v })}
          min={10}
          max={50}
          step={5}
          className="hover:cursor-pointer"
        />
      </div>

      {/* CFG Scale */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">CFG Scale</label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">How closely to follow the prompt. 7-12 is usually good.</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <span className="text-sm text-muted-foreground">
            {imageGen.defaultCfgScale}
          </span>
        </div>
        <Slider
          value={[imageGen.defaultCfgScale]}
          onValueChange={([v]) => updateImageGenSettings({ defaultCfgScale: v })}
          min={1}
          max={20}
          step={0.5}
          className="hover:cursor-pointer"
        />
      </div>

      {/* Distilled CFG (for Flux models) */}
      {currentCheckpointType === 'flux' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">Distilled CFG</label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p className="max-w-xs">Guidance scale for Flux distilled models. 3-4 is typical.</p>
                </TooltipContent>
              </Tooltip>
            </div>
            <span className="text-sm text-muted-foreground">
              {imageGen.defaultDistilledCfg}
            </span>
          </div>
          <Slider
            value={[imageGen.defaultDistilledCfg]}
            onValueChange={([v]) => updateImageGenSettings({ defaultDistilledCfg: v })}
            min={1}
            max={10}
            step={0.5}
            className="hover:cursor-pointer"
          />
        </div>
      )}

      {/* Default Negative Prompt */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">Default Negative Prompt</label>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs">Elements to avoid in generated images</p>
            </TooltipContent>
          </Tooltip>
        </div>
        <Input
          value={imageGen.defaultNegativePrompt}
          onChange={(e) => updateImageGenSettings({ defaultNegativePrompt: e.target.value })}
          placeholder="e.g., blurry, low quality, distorted"
          className="hover:border-primary/50 focus:border-primary transition-colors"
        />
      </div>

      {/* Default Size + Aspect */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">Default Size</label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">Controls the longest dimension of the image</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <Select
            value={String(imageGen.defaultWidth)}
            onValueChange={(v) => {
              const w = parseInt(v);
              updateImageGenSettings({ defaultWidth: w, defaultHeight: w });
            }}
          >
            <SelectTrigger className="hover:border-primary/50 transition-colors">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="768">Small (768px)</SelectItem>
              <SelectItem value="1024">Medium (1024px)</SelectItem>
              <SelectItem value="1536">Large (1536px)</SelectItem>
              <SelectItem value="1856">X-Large (1856px)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">Default Aspect</label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">Aspect ratio for generated images. Self-portrait defaults to Portrait.</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <Select
            value="square"
            onValueChange={() => {
              // Aspect is now handled per-Choom in mode settings
            }}
          >
            <SelectTrigger className="hover:border-primary/50 transition-colors">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="portrait">Portrait (3:4)</SelectItem>
              <SelectItem value="portrait-tall">Portrait Tall (9:16)</SelectItem>
              <SelectItem value="square">Square (1:1)</SelectItem>
              <SelectItem value="landscape">Landscape (16:9)</SelectItem>
              <SelectItem value="wide">Wide (21:9)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Default Scheduler */}
      {schedulers.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">Default Scheduler</label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">Noise scheduler for the diffusion process (Flux models use this)</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <Select
            value={imageGen.defaultScheduler || '__auto__'}
            onValueChange={(v) => updateImageGenSettings({ defaultScheduler: v === '__auto__' ? '' : v })}
          >
            <SelectTrigger className="hover:border-primary/50 transition-colors">
              <SelectValue placeholder="Auto (use sampler default)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__auto__">Auto (use sampler default)</SelectItem>
              {schedulers.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Note about LoRAs */}
      <p className="text-xs text-muted-foreground p-3 rounded-lg bg-muted/30">
        LoRAs and per-Choom reference images are configured per-Choom in the Choom settings panel
        (click edit on a Choom).
      </p>

      <Separator />

      <ReferenceLibrarySettings />
    </div>
  );
}
