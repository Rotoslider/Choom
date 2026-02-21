'use client';

import React from 'react';
import { Settings, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { LLMSettings } from './llm-settings';
import { AudioSettings } from './audio-settings';
import { ImageSettings } from './image-settings';
import { MemorySettingsPanel } from './memory-settings';
import { SearchSettings } from './search-settings';
import { WeatherSettings } from './weather-settings';
import { AppearanceSettings } from './appearance-settings';
import { ScheduledSettings } from './scheduled-settings';
import { useAppStore } from '@/lib/store';

interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsPanel({ open, onOpenChange }: SettingsPanelProps) {
  const { ui, setActiveSettingsTab } = useAppStore();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-primary" />
            Settings
          </DialogTitle>
          <DialogDescription>
            Configure LLM, audio, image, memory, weather, scheduled tasks, and appearance.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={ui.activeSettingsTab}
          onValueChange={(v) => setActiveSettingsTab(v as typeof ui.activeSettingsTab)}
          className="flex-1 flex flex-col h-full"
        >
          <TabsList className="grid grid-cols-4 w-full gap-1">
            <TabsTrigger value="llm">LLM</TabsTrigger>
            <TabsTrigger value="audio">Audio</TabsTrigger>
            <TabsTrigger value="image">Image</TabsTrigger>
            <TabsTrigger value="memory">Memory</TabsTrigger>
            <TabsTrigger value="search">Search</TabsTrigger>
            <TabsTrigger value="weather">Weather</TabsTrigger>
            <TabsTrigger value="scheduled">Tasks</TabsTrigger>
            <TabsTrigger value="appearance">Theme</TabsTrigger>
          </TabsList>

          <ScrollArea className="flex-1 mt-4">
            <TabsContent value="llm" className="mt-0 space-y-4">
              <LLMSettings />
            </TabsContent>

            <TabsContent value="audio" className="mt-0 space-y-4">
              <AudioSettings />
            </TabsContent>

            <TabsContent value="image" className="mt-0 space-y-4">
              <ImageSettings />
            </TabsContent>

            <TabsContent value="memory" className="mt-0 space-y-4">
              <MemorySettingsPanel />
            </TabsContent>

            <TabsContent value="search" className="mt-0 space-y-4">
              <SearchSettings />
            </TabsContent>

            <TabsContent value="weather" className="mt-0 space-y-4">
              <WeatherSettings />
            </TabsContent>

            <TabsContent value="appearance" className="mt-0 space-y-4">
              <AppearanceSettings />
            </TabsContent>

            <TabsContent value="scheduled" className="mt-0 space-y-4">
              <ScheduledSettings />
            </TabsContent>
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
