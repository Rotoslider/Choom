'use client';

import React from 'react';
import { useAppStore } from '@/lib/store';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Video } from 'lucide-react';

export function AvatarSettingsPanel() {
  const { settings, updateAvatarSettings, services } = useAppStore();
  const { avatar } = settings;
  const avatarServiceUp = services.avatar === 'connected';

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Video className="h-4 w-4 text-primary" />
          Live Avatar
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          Real-time face animation powered by LivePortrait. Requires the avatar service to be running.
        </p>
      </div>

      {/* Enable/Disable toggle */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Enable Live Avatar</label>
          <p className="text-xs text-muted-foreground">
            When disabled, the Live tab is hidden and the avatar service is not checked
          </p>
        </div>
        <Switch
          checked={avatar.enabled}
          onCheckedChange={(enabled) => updateAvatarSettings({ enabled })}
        />
      </div>

      {/* Service endpoint */}
      {avatar.enabled && (
        <div className="space-y-2">
          <label className="text-sm font-medium">Avatar Service Endpoint</label>
          <Input
            value={avatar.endpoint}
            onChange={(e) => updateAvatarSettings({ endpoint: e.target.value })}
            placeholder="http://127.0.0.1:8020"
            className="font-mono text-sm"
          />
          <div className="flex items-center gap-2 text-xs">
            <div
              className={`w-2 h-2 rounded-full ${
                avatarServiceUp ? 'bg-green-500' : 'bg-red-500'
              }`}
            />
            <span className={avatarServiceUp ? 'text-green-500' : 'text-red-500'}>
              {avatarServiceUp ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Start the service: <code className="text-[10px] bg-muted px-1 py-0.5 rounded">cd services/avatar-service && ./start.sh</code>
          </p>
        </div>
      )}

      {/* Info */}
      {avatar.enabled && (
        <div className="rounded-lg bg-muted/50 p-3 space-y-1.5">
          <p className="text-xs font-medium">How it works</p>
          <ul className="text-[11px] text-muted-foreground space-y-1 list-disc pl-3">
            <li>Uses the Choom&apos;s avatar photo — no additional setup needed</li>
            <li>Head motion and blinks generated from mathematical coefficients at 40fps</li>
            <li>Lip sync driven by TTS audio amplitude in real-time</li>
            <li>Full image compositing — face animated within the original photo</li>
            <li>Only active when the Live tab is open — no background processing</li>
          </ul>
        </div>
      )}
    </div>
  );
}
