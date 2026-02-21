'use client';

import React, { useState, useEffect } from 'react';
import { Eye, RefreshCw, Check, X } from 'lucide-react';
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
import { useAppStore } from '@/lib/store';

export function VisionSettings() {
  const { settings, updateVisionSettings } = useAppStore();
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message?: string;
    error?: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  const fetchModels = async () => {
    setLoadingModels(true);
    try {
      const response = await fetch(`/api/services/models?endpoint=${encodeURIComponent(settings.vision.endpoint + '/v1')}`);
      const data = await response.json();
      if (data.models) {
        setModels(data.models.map((m: { id: string }) => m.id));
      }
    } catch (error) {
      console.error('Failed to fetch vision models:', error);
    } finally {
      setLoadingModels(false);
    }
  };

  useEffect(() => {
    if (settings.vision.endpoint) {
      fetchModels();
    }
  }, [settings.vision.endpoint]);

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);

    try {
      const response = await fetch(`${settings.vision.endpoint}/v1/models`);
      if (response.ok) {
        const data = await response.json();
        const modelCount = data.data?.length || 0;
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
          <div className="space-y-2">
            <label htmlFor="vision-endpoint">Endpoint</label>
            <Input
              id="vision-endpoint"
              value={settings.vision.endpoint}
              onChange={(e) => updateVisionSettings({ endpoint: e.target.value })}
              placeholder="http://your-llm-host:1234"
            />
            <p className="text-xs text-muted-foreground">
              Base URL of the vision-capable LLM server (without /v1)
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="vision-model">Model</label>
            <div className="flex gap-2">
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
    </div>
  );
}
