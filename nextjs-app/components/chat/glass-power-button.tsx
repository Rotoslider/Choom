'use client';

/**
 * The Glass button beside Mute: switches the Looking Glass picture off to save power (the NUC's GPU
 * stops drawing the Chooms; their voices still play) and on again. The state lives on the server
 * (lib/glass-power.ts), so every browser shows the same and it stays off until pressed again.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Monitor, MonitorOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type PowerState = { off: boolean; glass: 'on' | 'off' | null };

export function GlassPowerButton() {
  const [state, setState] = useState<PowerState | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/hologram/power', { cache: 'no-store' });
      if (res.ok) setState(await res.json());
    } catch {
      // the app is restarting; the next poll catches up
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const toggle = async () => {
    if (!state || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/hologram/power', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ off: !state.off }),
      });
      if (res.ok) setState(await res.json());
    } catch {
      // nothing changed; the button keeps showing the last known state
    } finally {
      setBusy(false);
      // The glass confirms in its next heartbeat (every 10 s).
      setTimeout(() => void refresh(), 11_000);
    }
  };

  const off = state?.off === true;
  const tip = !state
    ? 'Glass picture'
    : off
      ? state.glass === 'off'
        ? 'Glass picture is off, saving power (voices still play). Click to turn it on.'
        : state.glass === 'on'
          ? 'Turning the glass picture off…'
          : 'Glass picture set to off (the glass isn’t running). Click to turn it on.'
      : state.glass === 'off'
        ? 'Turning the glass picture on…'
        : 'Turn the glass picture off to save power (voices still play)';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggle}
          disabled={!state || busy}
          aria-label={off ? 'Turn the glass picture on' : 'Turn the glass picture off'}
          className={cn(
            'text-muted-foreground hover:text-foreground',
            off && 'text-amber-400 hover:text-amber-300'
          )}
        >
          {off ? <MonitorOff className="h-5 w-5" /> : <Monitor className="h-5 w-5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
