'use client';

import React, { useEffect, useState } from 'react';
import { RefreshCw, Info } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
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

interface VoiceOption {
  id: string;
  name: string;
}

export function AudioSettings() {
  const { settings, updateTTSSettings, updateSTTSettings } = useAppStore();
  const tts = settings.tts;
  const stt = settings.stt;

  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [isLoadingVoices, setIsLoadingVoices] = useState(false);

  const fetchVoices = async () => {
    setIsLoadingVoices(true);
    try {
      // Use the configured endpoint from settings
      const endpoint = encodeURIComponent(tts.endpoint);
      const res = await fetch(`/api/services/voices?endpoint=${endpoint}`);
      if (res.ok) {
        const data = await res.json();
        setVoices(data.voices || []);
      }
    } catch (error) {
      console.error('Failed to fetch voices:', error);
    } finally {
      setIsLoadingVoices(false);
    }
  };

  useEffect(() => {
    fetchVoices();
  }, [tts.endpoint]);

  return (
    <div className="space-y-8">
      {/* TTS Settings */}
      <div>
        <h3 className="text-sm font-medium mb-4">Text-to-Speech (TTS)</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Configure the Chatterbox TTS server for voice output
        </p>

        <div className="space-y-4">
          {/* TTS Endpoint */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">TTS Endpoint</label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p className="max-w-xs">URL of your Chatterbox TTS server</p>
                </TooltipContent>
              </Tooltip>
            </div>
            <Input
              value={tts.endpoint}
              onChange={(e) => updateTTSSettings({ endpoint: e.target.value })}
              placeholder="http://localhost:8004"
              className="hover:border-primary/50 focus:border-primary transition-colors"
            />
          </div>

          {/* Default Voice - Dynamic Dropdown */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium">Default Voice</label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="max-w-xs">Voice to use for TTS. Refresh to load available voices from the server.</p>
                  </TooltipContent>
                </Tooltip>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={fetchVoices}
                disabled={isLoadingVoices}
                className="h-8 px-2"
              >
                <RefreshCw className={cn('h-4 w-4', isLoadingVoices && 'animate-spin')} />
              </Button>
            </div>
            {voices.length > 0 ? (
              <Select
                value={tts.defaultVoice}
                onValueChange={(v) => updateTTSSettings({ defaultVoice: v })}
              >
                <SelectTrigger className="hover:border-primary/50 transition-colors">
                  <SelectValue placeholder="Select a voice" />
                </SelectTrigger>
                <SelectContent>
                  {voices.map((voice) => (
                    <SelectItem key={voice.id} value={voice.id}>
                      {voice.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={tts.defaultVoice}
                onChange={(e) => updateTTSSettings({ defaultVoice: e.target.value })}
                placeholder="Enter voice ID or refresh to load"
                className="hover:border-primary/50 focus:border-primary transition-colors"
              />
            )}
          </div>

          {/* Auto-play */}
          <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors">
            <div>
              <label className="text-sm font-medium">Auto-play responses</label>
              <p className="text-xs text-muted-foreground">
                Automatically speak AI responses
              </p>
            </div>
            <Switch
              checked={tts.autoPlay}
              onCheckedChange={(checked) => updateTTSSettings({ autoPlay: checked })}
            />
          </div>

          {/* Speed */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium">Speech Speed</label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="max-w-xs">Playback speed multiplier. 1.0 = normal speed</p>
                  </TooltipContent>
                </Tooltip>
              </div>
              <span className="text-sm text-muted-foreground">{tts.speed}x</span>
            </div>
            <Slider
              value={[tts.speed]}
              onValueChange={([v]) => updateTTSSettings({ speed: v })}
              min={0.5}
              max={2}
              step={0.1}
              className="hover:cursor-pointer"
            />
          </div>
        </div>
      </div>

      {/* STT Settings */}
      <div>
        <h3 className="text-sm font-medium mb-4">Speech-to-Text (STT)</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Configure the Wyoming Whisper server for voice input
        </p>

        <div className="space-y-4">
          {/* STT Endpoint */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">STT Endpoint</label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p className="max-w-xs">URL of your Wyoming Whisper STT server</p>
                </TooltipContent>
              </Tooltip>
            </div>
            <Input
              value={stt.endpoint}
              onChange={(e) => updateSTTSettings({ endpoint: e.target.value })}
              placeholder="http://localhost:5000"
              className="hover:border-primary/50 focus:border-primary transition-colors"
            />
          </div>

          {/* Language */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">Language</label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p className="max-w-xs">Primary language for speech recognition</p>
                </TooltipContent>
              </Tooltip>
            </div>
            <Select
              value={stt.language}
              onValueChange={(v) => updateSTTSettings({ language: v })}
            >
              <SelectTrigger className="hover:border-primary/50 transition-colors">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="es">Spanish</SelectItem>
                <SelectItem value="fr">French</SelectItem>
                <SelectItem value="de">German</SelectItem>
                <SelectItem value="ja">Japanese</SelectItem>
                <SelectItem value="zh">Chinese</SelectItem>
                <SelectItem value="ko">Korean</SelectItem>
                <SelectItem value="pt">Portuguese</SelectItem>
                <SelectItem value="ru">Russian</SelectItem>
                <SelectItem value="it">Italian</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Input Mode */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">Input Mode</label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p className="max-w-xs">How to trigger voice recording</p>
                </TooltipContent>
              </Tooltip>
            </div>
            <Select
              value={stt.inputMode}
              onValueChange={(v) =>
                updateSTTSettings({ inputMode: v as typeof stt.inputMode })
              }
            >
              <SelectTrigger className="hover:border-primary/50 transition-colors">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="push-to-talk">Push to Talk</SelectItem>
                <SelectItem value="toggle">Toggle Recording</SelectItem>
                <SelectItem value="vad">Voice Activity Detection</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Push-to-talk: Hold button while speaking. Toggle: Click to start/stop.
              VAD: Automatic detection.
            </p>
          </div>

          {/* VAD Sensitivity */}
          {stt.inputMode === 'vad' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium">VAD Sensitivity</label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="max-w-xs">How sensitive the voice detection is. Higher = more sensitive.</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <span className="text-sm text-muted-foreground">
                  {Math.round(stt.vadSensitivity * 100)}%
                </span>
              </div>
              <Slider
                value={[stt.vadSensitivity]}
                onValueChange={([v]) => updateSTTSettings({ vadSensitivity: v })}
                min={0.1}
                max={0.9}
                step={0.1}
                className="hover:cursor-pointer"
              />
              <p className="text-xs text-muted-foreground">
                Higher values = more sensitive (may pick up background noise)
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
