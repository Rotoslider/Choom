'use client';

import { useAppStore } from '@/lib/store';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { ShieldAlert } from 'lucide-react';

// Friendly labels for the server-owned config slices.
const LABELS: Record<string, string> = {
  llm: 'LLM (model / endpoint / routing)',
  tts: 'Text-to-Speech',
  stt: 'Speech-to-Text',
  imageGen: 'Image generation',
  memory: 'Memory',
  vision: 'Vision',
  weather: 'Weather',
  search: 'Web search',
  homeAssistant: 'Home Assistant',
  providers: 'LLM providers',
  visionProfiles: 'Vision profiles',
  modelProfiles: 'Model profiles',
  ownerName: 'Owner name',
  ownerLocation: 'Owner location',
};

// Shows ONLY when you're connected off-site (ngrok) and a settings change would
// alter the server. The server rejects remote writes without confirmation, so
// nothing changes until you click "Yes, update server".
export function ServerSyncGuard() {
  const pending = useAppStore((s) => s.pendingServerSync);
  const confirmServerSync = useAppStore((s) => s.confirmServerSync);
  const discardServerSync = useAppStore((s) => s.discardServerSync);

  const open = !!pending;
  const changes = pending?.changes ?? [];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) discardServerSync(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-400" />
            Change server settings?
          </DialogTitle>
          <DialogDescription>
            You&apos;re connected from off-site. This will change the home server&apos;s
            configuration for <strong>every</strong> device and the Chooms. Nothing
            changes unless you confirm.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground mb-2">About to change on the server:</p>
          <ul className="space-y-1 text-sm">
            {changes.map((c) => (
              <li key={c} className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                {LABELS[c] || c}
              </li>
            ))}
          </ul>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => discardServerSync()}>
            Cancel
          </Button>
          <Button onClick={() => confirmServerSync()}>
            Yes, update server
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
