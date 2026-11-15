'use client';

/**
 * Restart Choom (sidebar): restarts the app and its memory server on the Mac, after asking (Donny,
 * Nov 15 2026). The question says what's under way (GET /api/turns): "Restart now" cuts it off, "Restart
 * when quiet" waits for it and for anything due. The restart itself runs in the restart agent
 * (lib/app-restart.ts); the dialog follows its log, and the page reloads once the server is back.
 */
import React, { useEffect, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type Turn = { who: string; kind: string; seconds: number };
type Status = { running: boolean; requested: 'now' | 'quiet' | null; log: string[]; serverStarted: number };
type Phase = 'loading' | 'ask' | 'waiting' | 'down' | 'back' | 'failed';

const DOING: Record<string, string> = {
  chat: 'answering',
  heartbeat: 'on a wake-up',
  delegation: 'on a task for another Choom',
  group: 'in a group chat',
  room: 'in a room',
};
const took = (s: number) => (s < 60 ? `${s} s` : `${Math.round(s / 60)} min`);
// The log's lines without their date ("2026-11-15 13:02:05   waiting: ..." -> "13:02 waiting: ...").
const logLine = (l: string) => l.replace(/^\d{4}-\d\d-\d\d (\d\d:\d\d):\d\d\s+/, '$1  ');

export function RestartChoom() {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('loading');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [asked, setAsked] = useState<'now' | 'quiet' | null>(null);
  const before = useRef<number | null>(null); // the server's start time before the restart
  const sentAt = useRef(0);
  const [oldHead, setOldHead] = useState<string | null>(null); // the log's newest restart before this one: not shown

  // Opened: what's under way, and whether a restart already is (asked from another tab, say).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      try {
        const [t, s] = await Promise.all([
          fetch('/api/turns', { cache: 'no-store' }).then((r) => r.json()),
          fetch('/api/restart', { cache: 'no-store' }).then((r) => r.json()),
        ]);
        if (!alive) return;
        setTurns(t.turns || []);
        setStatus(s);
        before.current = s.serverStarted;
        sentAt.current = Date.now();
        setOldHead(null);
        if (s.running) setAsked(s.requested ?? (s.log.some((l: string) => /waiting:/.test(l)) ? 'quiet' : 'now'));
        setPhase(s.running ? 'waiting' : 'ask');
      } catch {
        if (alive) setPhase('ask');
      }
    })();
    return () => {
      alive = false;
    };
  }, [open]);

  // On its way: follow the restart's log until the server has gone and come back (a new start time).
  useEffect(() => {
    if (!open || (phase !== 'waiting' && phase !== 'down')) return;
    const timer = setInterval(async () => {
      try {
        const r = await fetch('/api/restart', { cache: 'no-store' });
        if (!r.ok) throw new Error(String(r.status));
        const s: Status = await r.json();
        setStatus(s);
        if (before.current && s.serverStarted - before.current > 3000) {
          setPhase('back');
          setTimeout(() => window.location.reload(), 1500);
        } else if (!s.running && !s.requested && Date.now() - sentAt.current > 10_000) {
          setPhase('failed'); // the agent ended without restarting (no quiet moment, say): its log says why
        }
      } catch {
        setPhase('down');
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [open, phase]);

  const restart = async (mode: 'now' | 'quiet') => {
    setError('');
    try {
      const r = await fetch('/api/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
      sentAt.current = Date.now();
      if (phase !== 'waiting') setOldHead(status?.log?.[0] ?? null);
      setAsked(mode);
      setPhase('waiting');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const busyNow = turns.length > 0;
  const all = status?.log ?? [];
  const lines = oldHead && all[0] === oldHead ? [] : all;
  // Waiting for a quiet moment until its log says the restart has begun.
  const stillWaiting = asked === 'quiet' && !lines.some((l) => /quiet: restarting|restarting now as asked|asked in the app to restart now|isn.t answering/.test(l));

  return (
    <>
      <Button
        variant="ghost"
        onClick={() => {
          setPhase('loading');
          setError('');
          setOpen(true);
        }}
        className="w-full justify-start gap-2 mb-1"
        title="Restart the Choom app and its memory server on the Mac (asks first)"
      >
        <RotateCw className="h-4 w-4" />
        Restart Choom
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {phase === 'back' ? 'Choom is back' : phase === 'waiting' || phase === 'down' ? 'Restarting Choom' : phase === 'failed' ? 'Choom didn’t restart' : 'Restart Choom?'}
            </DialogTitle>
            <DialogDescription>
              {phase === 'ask' || phase === 'loading'
                ? 'This restarts the Choom app and its memory server on the Mac. It takes about 10 to 20 seconds; Signal, the glass and open chats reconnect by themselves, and this page reloads when it’s back.'
                : phase === 'waiting'
                  ? stillWaiting
                    ? 'Waiting for a quiet moment, then restarting. You can close this; it carries on.'
                    : 'Restarting now…'
                  : phase === 'down'
                    ? 'The app is down while it restarts. This page reloads as soon as it answers again.'
                    : phase === 'back'
                      ? 'Reloading this page…'
                      : 'The restart ended without restarting the app. Its log says why.'}
            </DialogDescription>
          </DialogHeader>

          {phase === 'ask' && (
            <div className="text-sm">
              {busyNow ? (
                <>
                  <p className="mb-1">Under way right now:</p>
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {turns.map((t, i) => (
                      <li key={i}>
                        {t.who} {DOING[t.kind] || t.kind} ({took(t.seconds)})
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-muted-foreground">
                    <b className="text-foreground">Restart now</b> cuts {turns.length === 1 ? 'that' : 'them'} off.{' '}
                    <b className="text-foreground">Restart when quiet</b> waits until nothing is under way or due (up to 40 minutes).
                  </p>
                </>
              ) : (
                <p className="text-muted-foreground">
                  Nothing is under way right now. <b className="text-foreground">Restart when quiet</b> also waits for a followup or task
                  due in the next 15 minutes.
                </p>
              )}
            </div>
          )}

          {phase !== 'ask' && phase !== 'loading' && lines.length > 0 && (
            <pre className="max-h-48 overflow-auto rounded-md bg-muted/50 p-3 text-xs whitespace-pre-wrap">
              {lines.map(logLine).join('\n')}
            </pre>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          <DialogFooter className="gap-2">
            {phase === 'ask' || phase === 'loading' ? (
              <>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button variant="secondary" disabled={phase === 'loading'} onClick={() => restart('quiet')}>
                  Restart when quiet
                </Button>
                <Button variant="destructive" disabled={phase === 'loading'} onClick={() => restart('now')}>
                  Restart now
                </Button>
              </>
            ) : phase === 'waiting' && stillWaiting ? (
              <>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Close
                </Button>
                <Button variant="destructive" onClick={() => restart('now')}>
                  Restart now instead
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setOpen(false)}>
                Close
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
