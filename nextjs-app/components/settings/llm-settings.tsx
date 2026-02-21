'use client';

import React, { useEffect, useState } from 'react';
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

interface ModelOption {
  id: string;
  name: string;
}

export function LLMSettings() {
  const { settings, updateLLMSettings } = useAppStore();
  const llm = settings.llm;

  const [models, setModels] = useState<ModelOption[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);

  const fetchModels = async () => {
    setIsLoadingModels(true);
    try {
      // Use the configured endpoint from settings
      const endpoint = encodeURIComponent(llm.endpoint);
      const res = await fetch(`/api/services/models?endpoint=${endpoint}`);
      if (res.ok) {
        const data = await res.json();
        setModels(data.models || []);
      }
    } catch (error) {
      console.error('Failed to fetch models:', error);
    } finally {
      setIsLoadingModels(false);
    }
  };

  useEffect(() => {
    fetchModels();
  }, [llm.endpoint]);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium mb-4">LLM Configuration</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Configure the connection to your local LLM server (LMStudio, Ollama, etc.)
        </p>
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
        <Input
          value={llm.endpoint}
          onChange={(e) => updateLLMSettings({ endpoint: e.target.value })}
          placeholder="http://localhost:1234/v1"
          className="hover:border-primary/50 focus:border-primary transition-colors"
        />
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
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchModels}
            disabled={isLoadingModels}
            className="h-8 px-2"
          >
            <RefreshCw className={cn('h-4 w-4', isLoadingModels && 'animate-spin')} />
          </Button>
        </div>
        {models.length > 0 ? (
          <Select
            value={llm.model}
            onValueChange={(v) => updateLLMSettings({ model: v })}
          >
            <SelectTrigger className="hover:border-primary/50 transition-colors">
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              {models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={llm.model}
            onChange={(e) => updateLLMSettings({ model: e.target.value })}
            placeholder="Enter model name or refresh to load"
            className="hover:border-primary/50 focus:border-primary transition-colors"
          />
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
    </div>
  );
}
