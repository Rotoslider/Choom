'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Brain,
  Volume2,
  ImageIcon,
  Database,
  Search,
  Cloud,
  Calendar,
  Heart,
  Palette,
  Eye,
  FolderOpen,
  Server,
  Music,
  Workflow,
  Home,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { LLMSettings } from '@/components/settings/llm-settings';
import { AudioSettings } from '@/components/settings/audio-settings';
import { ImageSettings } from '@/components/settings/image-settings';
import { MemorySettingsPanel } from '@/components/settings/memory-settings';
import { SearchSettings } from '@/components/settings/search-settings';
import { WeatherSettings } from '@/components/settings/weather-settings';
import { AppearanceSettings } from '@/components/settings/appearance-settings';
import { CronSettings } from '@/components/settings/cron-settings';
import { HeartbeatSettings } from '@/components/settings/heartbeat-settings';
import { RemindersSettings } from '@/components/settings/reminders-settings';
import { VisionSettings } from '@/components/settings/vision-settings';
import { ProjectsSettings } from '@/components/settings/projects-settings';
import { ProvidersSettings } from '@/components/settings/providers-settings';
import { YTDownloaderSettings } from '@/components/settings/yt-downloader-settings';
import { AutomationsSettings } from '@/components/settings/automations-settings';
import { HomeAssistantSettings } from '@/components/settings/homeassistant-settings';
import { cn } from '@/lib/utils';

type Section =
  | 'llm'
  | 'audio'
  | 'image'
  | 'memory'
  | 'search'
  | 'weather'
  | 'cron'
  | 'heartbeat'
  | 'reminders'
  | 'vision'
  | 'projects'
  | 'providers'
  | 'yt-downloader'
  | 'automations'
  | 'home-assistant'
  | 'appearance';

const sections: { id: Section; label: string; icon: React.ReactNode }[] = [
  { id: 'llm', label: 'LLM', icon: <Brain className="h-4 w-4" /> },
  { id: 'audio', label: 'Audio', icon: <Volume2 className="h-4 w-4" /> },
  { id: 'image', label: 'Image', icon: <ImageIcon className="h-4 w-4" /> },
  { id: 'memory', label: 'Memory', icon: <Database className="h-4 w-4" /> },
  { id: 'search', label: 'Search', icon: <Search className="h-4 w-4" /> },
  { id: 'weather', label: 'Weather', icon: <Cloud className="h-4 w-4" /> },
  { id: 'cron', label: 'Cron Jobs', icon: <Calendar className="h-4 w-4" /> },
  { id: 'heartbeat', label: 'Heartbeats', icon: <Heart className="h-4 w-4" /> },
  { id: 'reminders', label: 'Reminders', icon: <Calendar className="h-4 w-4" /> },
  { id: 'vision', label: 'Optic', icon: <Eye className="h-4 w-4" /> },
  { id: 'projects', label: 'Projects', icon: <FolderOpen className="h-4 w-4" /> },
  { id: 'providers', label: 'Providers', icon: <Server className="h-4 w-4" /> },
  { id: 'yt-downloader', label: 'YouTube DL', icon: <Music className="h-4 w-4" /> },
  { id: 'automations', label: 'Automations', icon: <Workflow className="h-4 w-4" /> },
  { id: 'home-assistant', label: 'Smart Home', icon: <Home className="h-4 w-4" /> },
  { id: 'appearance', label: 'Theme', icon: <Palette className="h-4 w-4" /> },
];

export default function SettingsPage() {
  const router = useRouter();
  const [activeSection, setActiveSection] = useState<Section>('llm');

  return (
    <div className="min-h-screen bg-background flex">
      {/* Left navigation sidebar */}
      <aside className="w-56 border-r border-border bg-card flex flex-col flex-shrink-0">
        <div className="p-4 border-b border-border">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push('/')}
            className="gap-2 -ml-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <h1 className="text-lg font-semibold mt-2">Settings</h1>
        </div>

        <nav className="flex-1 py-2">
          {sections.map((section) => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={cn(
                'w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors',
                activeSection === section.id
                  ? 'bg-primary/10 text-primary font-medium border-r-2 border-primary'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              )}
            >
              {section.icon}
              {section.label}
            </button>
          ))}
        </nav>

        <Separator />
        <div className="p-4 text-xs text-muted-foreground">
          Settings are saved automatically
        </div>
      </aside>

      {/* Main content area */}
      <main className="flex-1 min-h-screen">
        <ScrollArea className="h-screen">
          <div className="max-w-3xl mx-auto p-8">
            {activeSection === 'llm' && <LLMSettings />}
            {activeSection === 'audio' && <AudioSettings />}
            {activeSection === 'image' && <ImageSettings />}
            {activeSection === 'memory' && <MemorySettingsPanel />}
            {activeSection === 'search' && <SearchSettings />}
            {activeSection === 'weather' && <WeatherSettings />}
            {activeSection === 'cron' && <CronSettings />}
            {activeSection === 'heartbeat' && <HeartbeatSettings />}
            {activeSection === 'reminders' && <RemindersSettings />}
            {activeSection === 'vision' && <VisionSettings />}
            {activeSection === 'projects' && <ProjectsSettings />}
            {activeSection === 'providers' && <ProvidersSettings />}
            {activeSection === 'yt-downloader' && <YTDownloaderSettings />}
            {activeSection === 'automations' && <AutomationsSettings />}
            {activeSection === 'home-assistant' && <HomeAssistantSettings />}
            {activeSection === 'appearance' && <AppearanceSettings />}
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}
