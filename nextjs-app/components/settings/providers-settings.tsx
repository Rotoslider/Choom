'use client';

import React, { useState } from 'react';
import { Plus, Trash2, Server, Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppStore } from '@/lib/store';
import type { LLMProviderConfig } from '@/lib/types';

const PRESETS: Record<string, Partial<LLMProviderConfig>> = {
  anthropic: {
    name: 'Anthropic',
    type: 'anthropic',
    endpoint: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', 'claude-opus-4-6'],
  },
  openai: {
    name: 'OpenAI',
    type: 'openai',
    endpoint: 'https://api.openai.com/v1',
    models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'o3-mini'],
  },
  nvidia: {
    name: 'NVIDIA Build',
    type: 'openai',
    endpoint: 'https://integrate.api.nvidia.com/v1',
    models: [
      'nvidia/llama-3.1-nemotron-ultra-253b-v1',
      'mistralai/mistral-large-3-675b-instruct-2512',
      'deepseek-ai/deepseek-v3.2',
      'moonshotai/kimi-k2.5',
      'moonshotai/kimi-k2-instruct',
      'qwen/qwen3.5-397b-a17b',
      'qwen/qwen3-next-80b-a3b-instruct',
      'z-ai/glm5',
      'meta/llama-3.1-405b-instruct',
      'meta/llama-3.3-70b-instruct',
    ],
  },
  custom: {
    name: 'Custom Provider',
    type: 'openai',
    endpoint: '',
    models: [],
  },
};

export function ProvidersSettings() {
  const providers = useAppStore((s) => s.settings.providers || []);
  const updateProvidersSettings = useAppStore((s) => s.updateProvidersSettings);
  const [showAddForm, setShowAddForm] = useState(false);
  const [presetType, setPresetType] = useState<string>('anthropic');
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());

  const addProvider = () => {
    const preset = PRESETS[presetType];
    const newProvider: LLMProviderConfig = {
      id: `${presetType}_${Date.now()}`,
      name: preset.name || 'New Provider',
      type: preset.type || 'openai',
      endpoint: preset.endpoint || '',
      apiKey: '',
      models: [...(preset.models || [])],
    };
    updateProvidersSettings([...providers, newProvider]);
    setShowAddForm(false);
  };

  const updateProvider = (id: string, updates: Partial<LLMProviderConfig>) => {
    updateProvidersSettings(
      providers.map(p => p.id === id ? { ...p, ...updates } : p)
    );
  };

  const removeProvider = (id: string) => {
    updateProvidersSettings(providers.filter(p => p.id !== id));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Server className="h-4 w-4" />
            LLM Providers
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Configure external LLM providers (Anthropic, OpenAI, NVIDIA Build, or custom). Assign to projects for per-project model selection.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowAddForm(!showAddForm)}>
          <Plus className="h-4 w-4 mr-1" />
          Add Provider
        </Button>
      </div>

      {/* Add Provider Form */}
      {showAddForm && (
        <div className="p-4 rounded-lg border border-border bg-card space-y-3">
          <div className="space-y-2">
            <label className="text-sm font-medium">Provider Preset</label>
            <Select value={presetType} onValueChange={setPresetType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                <SelectItem value="openai">OpenAI (GPT)</SelectItem>
                <SelectItem value="nvidia">NVIDIA Build</SelectItem>
                <SelectItem value="custom">Custom (OpenAI-compatible)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setShowAddForm(false)}>Cancel</Button>
            <Button size="sm" onClick={addProvider}>Add</Button>
          </div>
        </div>
      )}

      {/* Local Provider (always shown) */}
      <div className="p-4 rounded-lg border border-border bg-card space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-green-400" />
            <span className="font-medium text-sm">Local (LM Studio / Ollama)</span>
          </div>
          <span className="text-xs text-muted-foreground">Default — configured in LLM settings</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Uses the endpoint and model from Settings &gt; LLM. No API key needed.
        </p>
      </div>

      {/* Configured Providers */}
      {providers.map((provider) => (
        <div key={provider.id} className="p-4 rounded-lg border border-border bg-card space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-blue-400" />
              <Input
                value={provider.name}
                onChange={(e) => updateProvider(provider.id, { name: e.target.value })}
                className="h-7 w-48 text-sm font-medium"
              />
              <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                {provider.type}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:bg-destructive/10"
              onClick={() => removeProvider(provider.id)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium">Endpoint</label>
              <Input
                value={provider.endpoint}
                onChange={(e) => updateProvider(provider.id, { endpoint: e.target.value })}
                placeholder="https://api.anthropic.com"
                className="text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">API Key</label>
              <div className="relative">
                <Input
                  type={visibleKeys.has(provider.id) ? 'text' : 'password'}
                  value={provider.apiKey || ''}
                  onChange={(e) => updateProvider(provider.id, { apiKey: e.target.value })}
                  placeholder="sk-..."
                  className="text-sm pr-9"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-2 hover:bg-transparent"
                  onClick={() => setVisibleKeys(prev => {
                    const next = new Set(prev);
                    if (next.has(provider.id)) next.delete(provider.id);
                    else next.add(provider.id);
                    return next;
                  })}
                >
                  {visibleKeys.has(provider.id)
                    ? <EyeOff className="h-4 w-4 text-muted-foreground" />
                    : <Eye className="h-4 w-4 text-muted-foreground" />}
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium">API Type</label>
            <Select
              value={provider.type}
              onValueChange={(value: 'openai' | 'anthropic') =>
                updateProvider(provider.id, { type: value })
              }
            >
              <SelectTrigger className="text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI-compatible</SelectItem>
                <SelectItem value="anthropic">Anthropic Messages API</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium">Models (comma-separated)</label>
            <Input
              value={provider.models.join(', ')}
              onChange={(e) =>
                updateProvider(provider.id, {
                  models: e.target.value.split(',').map(m => m.trim()).filter(Boolean),
                })
              }
              placeholder="claude-sonnet-4-5-20250929, claude-haiku-4-5-20251001"
              className="text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Models available in project settings dropdown
            </p>
          </div>
        </div>
      ))}

      {providers.length === 0 && !showAddForm && (
        <div className="text-center py-6 text-muted-foreground text-sm">
          No external providers configured. Add one to use Anthropic, OpenAI, or other cloud LLMs per-project.
        </div>
      )}
    </div>
  );
}
