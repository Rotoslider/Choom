'use client';

import React, { useEffect, useState } from 'react';
import {
  Activity,
  RefreshCw,
  Server,
  Mic,
  Speaker,
  Image,
  Brain,
  Cloud,
  Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatusIndicator } from '@/components/common/status-indicator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { ServiceHealth } from '@/lib/types';

interface ServiceInfo {
  name: string;
  key: keyof ServiceHealth;
  icon: React.ElementType;
  description: string;
  defaultPort: string;
}

const services: ServiceInfo[] = [
  {
    name: 'LLM (LMStudio)',
    key: 'llm',
    icon: Brain,
    description: 'Language model for chat responses',
    defaultPort: '1234',
  },
  {
    name: 'Memory Server',
    key: 'memory',
    icon: Server,
    description: 'Persistent memory storage',
    defaultPort: '8100',
  },
  {
    name: 'TTS (Chatterbox)',
    key: 'tts',
    icon: Speaker,
    description: 'Text-to-speech synthesis',
    defaultPort: '8004',
  },
  {
    name: 'STT (Whisper)',
    key: 'stt',
    icon: Mic,
    description: 'Speech-to-text recognition',
    defaultPort: '5000',
  },
  {
    name: 'Image Gen (Forge)',
    key: 'imageGen',
    icon: Image,
    description: 'Stable Diffusion image generation',
    defaultPort: '7860',
  },
];

interface HealthDashboardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HealthDashboard({ open, onOpenChange }: HealthDashboardProps) {
  const { services: serviceStatus, settings, updateServiceHealth, setAllServicesChecking } =
    useAppStore();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [details, setDetails] = useState<Record<string, unknown>>({});

  const refreshHealth = async () => {
    setIsRefreshing(true);
    setAllServicesChecking();

    try {
      // Use POST with configured endpoints from settings
      const response = await fetch('/api/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoints: {
            llm: settings.llm.endpoint,
            memory: settings.memory.endpoint,
            tts: settings.tts.endpoint,
            stt: settings.stt.endpoint,
            imageGen: settings.imageGen.endpoint,
          },
        }),
      });
      if (response.ok) {
        const data = await response.json();
        setDetails(data.services);

        const serviceKeys: (keyof ServiceHealth)[] = ['llm', 'memory', 'tts', 'stt', 'imageGen', 'weather', 'search'];
        serviceKeys.forEach((service) => {
          const info = data.services[service] as { status: string } | undefined;
          const status = info?.status === 'connected' ? 'connected' : 'disconnected';
          updateServiceHealth(service, status);
        });
      }
    } catch (error) {
      console.error('Health check failed:', error);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    if (open) {
      refreshHealth();
    }
  }, [open]);

  const connectedCount = Object.values(serviceStatus).filter(
    (s) => s === 'connected'
  ).length;
  const totalCount = Object.keys(serviceStatus).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            Service Health
          </DialogTitle>
          <DialogDescription>
            Monitor the connection status of external services.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Summary */}
          <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  'w-3 h-3 rounded-full',
                  connectedCount === totalCount
                    ? 'bg-green-500'
                    : connectedCount > 0
                      ? 'bg-yellow-500'
                      : 'bg-red-500'
                )}
              />
              <span className="text-sm font-medium">
                {connectedCount}/{totalCount} services connected
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={refreshHealth}
              disabled={isRefreshing}
            >
              <RefreshCw
                className={cn('h-4 w-4', isRefreshing && 'animate-spin')}
              />
            </Button>
          </div>

          {/* Service list */}
          <ScrollArea className="h-[300px]">
            <div className="space-y-2">
              {services.map((service) => {
                const status = serviceStatus[service.key];
                const detail = details[service.key] as
                  | { latency?: number; error?: string }
                  | undefined;
                const Icon = service.icon;

                return (
                  <div
                    key={service.key}
                    className={cn(
                      'p-3 rounded-lg border transition-colors',
                      status === 'connected'
                        ? 'border-green-500/30 bg-green-500/5'
                        : status === 'checking'
                          ? 'border-yellow-500/30 bg-yellow-500/5'
                          : 'border-red-500/30 bg-red-500/5'
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={cn(
                          'p-2 rounded-lg',
                          status === 'connected'
                            ? 'bg-green-500/10 text-green-500'
                            : status === 'checking'
                              ? 'bg-yellow-500/10 text-yellow-500'
                              : 'bg-red-500/10 text-red-500'
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">
                            {service.name}
                          </span>
                          <StatusIndicator status={status} size="sm" />
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {service.description}
                        </p>
                        <p className="text-xs text-muted-foreground/70 mt-0.5">
                          Default port: {service.defaultPort}
                        </p>
                        {detail?.latency && (
                          <p className="text-xs text-green-500 mt-1">
                            Latency: {detail.latency}ms
                          </p>
                        )}
                        {detail?.error && (
                          <p className="text-xs text-red-400 mt-1 truncate">
                            Error: {detail.error}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>

          {/* Tips */}
          <div className="text-xs text-muted-foreground p-2 rounded-lg bg-muted/30">
            <p className="font-medium mb-1">Connection Tips:</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>Make sure services are running on their default ports</li>
              <li>Check firewall settings if services are on remote machines</li>
              <li>The app will gracefully degrade if services are unavailable</li>
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
