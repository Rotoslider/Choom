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

interface CheckpointOption {
  id: string;
  name: string;
  type: 'pony' | 'flux' | 'other';
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
            Configure Stable Diffusion Forge for image generation
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
      <div className="grid grid-cols-2 gap-4">
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
        LoRAs are configured per-Choom in the Choom settings panel (click edit on a Choom).
      </p>
    </div>
  );
}
