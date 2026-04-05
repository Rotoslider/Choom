'use client';

import React, { useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { Video, Monitor, MonitorOff, User } from 'lucide-react';
import type { AvatarMode } from '@/lib/types';

interface ChoomAvatarRow {
  id: string;
  name: string;
  avatarUrl: string | null;
  avatarMode: AvatarMode | null;
}

export function AvatarSettingsPanel() {
  const { services, chooms, updateChoom } = useAppStore();
  const [saving, setSaving] = useState<string | null>(null);
  const avatarServiceUp = services.avatar === 'connected';

  // Get all Chooms with their avatar settings
  const choomRows: ChoomAvatarRow[] = chooms.map((c) => ({
    id: c.id,
    name: c.name,
    avatarUrl: c.avatarUrl,
    avatarMode: (c.avatarMode as AvatarMode) || 'off',
  }));

  const anyEnabled = choomRows.some((c) => c.avatarMode !== 'off' && c.avatarMode !== null);

  const handleModeChange = async (choomId: string, mode: AvatarMode) => {
    setSaving(choomId);
    try {
      const res = await fetch(`/api/chooms/${choomId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatarMode: mode }),
      });
      if (res.ok) {
        updateChoom(choomId, { avatarMode: mode });

        // Auto-manage service: start if any Choom needs it, stop if none do
        const updatedChooms = chooms.map(c => c.id === choomId ? { ...c, avatarMode: mode } : c);
        const anyNeedService = updatedChooms.some(c => c.avatarMode && c.avatarMode !== 'off');

        if (anyNeedService && !avatarServiceUp) {
          // Start service
          fetch('/api/avatar/service', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'start' }),
          }).catch(() => {});
        } else if (!anyNeedService && avatarServiceUp) {
          // Stop service + desktop
          fetch('/api/avatar/service', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'stop' }),
          }).catch(() => {});
        }

        // Desktop avatar window management
        const choomName = chooms.find(c => c.id === choomId)?.name;
        if (mode === 'desktop' && choomName) {
          // Launch desktop avatar for this Choom (after service starts)
          setTimeout(() => {
            fetch('/api/avatar/service', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'start-desktop', choomName }),
            }).catch(() => {});
          }, anyNeedService && !avatarServiceUp ? 8000 : 500); // wait for service if starting
        } else {
          // Stop desktop avatar if switching away from desktop mode
          const anyDesktop = updatedChooms.some(c => c.avatarMode === 'desktop');
          if (!anyDesktop) {
            fetch('/api/avatar/service', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'stop-desktop' }),
            }).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.error('Failed to update avatar mode:', e);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Video className="h-4 w-4 text-primary" />
          Live Avatar Settings
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          Configure avatar animation mode for each Choom. Uses LivePortrait for real-time
          head motion, blinks, and lip sync from TTS audio.
        </p>
      </div>

      {/* Service status */}
      <div className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-muted/50">
        <div className={`w-2 h-2 rounded-full ${
          !anyEnabled ? 'bg-muted-foreground/50' :
          avatarServiceUp ? 'bg-green-500' : 'bg-yellow-500 animate-pulse'
        }`} />
        <span className={
          !anyEnabled ? 'text-muted-foreground' :
          avatarServiceUp ? 'text-green-500' : 'text-yellow-500'
        }>
          {!anyEnabled ? 'Standby — no Chooms have avatar enabled' :
           avatarServiceUp ? 'Avatar service running' : 'Avatar service starting...'}
        </span>
      </div>

      {/* Per-Choom toggles */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Per-Choom Avatar Mode
        </label>

        {choomRows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No Chooms created yet</p>
        ) : (
          <div className="space-y-1.5">
            {choomRows.map((choom) => (
              <div
                key={choom.id}
                className="flex items-center gap-3 px-3 py-2 rounded-lg border border-border bg-card/50"
              >
                {/* Avatar thumbnail */}
                <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center overflow-hidden flex-shrink-0">
                  {choom.avatarUrl ? (
                    <img src={choom.avatarUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <User className="w-4 h-4 text-muted-foreground" />
                  )}
                </div>

                {/* Name */}
                <span className="text-sm font-medium flex-1 min-w-0 truncate">
                  {choom.name}
                </span>

                {/* Mode selector */}
                <div className="flex items-center gap-0.5 bg-muted/50 rounded-lg p-0.5">
                  <ModeButton
                    label="Off"
                    icon={<MonitorOff className="w-3 h-3" />}
                    active={choom.avatarMode === 'off' || !choom.avatarMode}
                    disabled={saving === choom.id}
                    onClick={() => handleModeChange(choom.id, 'off')}
                  />
                  <ModeButton
                    label="Live"
                    icon={<Video className="w-3 h-3" />}
                    active={choom.avatarMode === 'live'}
                    disabled={saving === choom.id || !choom.avatarUrl}
                    onClick={() => handleModeChange(choom.id, 'live')}
                    title={!choom.avatarUrl ? 'Upload a photo first' : 'Animate in Live tab'}
                  />
                  <ModeButton
                    label="Desktop"
                    icon={<Monitor className="w-3 h-3" />}
                    active={choom.avatarMode === 'desktop'}
                    disabled={saving === choom.id || !choom.avatarUrl}
                    onClick={() => handleModeChange(choom.id, 'desktop')}
                    title={!choom.avatarUrl ? 'Upload a photo first' : 'Floating desktop avatar'}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="rounded-lg bg-muted/50 p-3 space-y-1.5">
        <p className="text-xs font-medium">Mode descriptions</p>
        <ul className="text-[11px] text-muted-foreground space-y-1">
          <li><strong>Off</strong> — No avatar animation. Normal chat only.</li>
          <li><strong>Live Tab</strong> — Animated avatar in the Live tab. Only active when viewing the Live tab.</li>
          <li><strong>Desktop</strong> — Floating avatar window on your desktop. Animates while chatting in any tab.</li>
        </ul>
      </div>
    </div>
  );
}

function ModeButton({
  label, icon, active, disabled, onClick, title,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title || label}
      className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all ${
        active
          ? 'bg-card text-foreground shadow-sm'
          : disabled
            ? 'text-muted-foreground/30 cursor-not-allowed'
            : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
