'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Users, Trash2, Loader2, Smartphone, Square, Minus, Play, Download, Archive, X, MoreVertical, Pencil, ScrollText, Menu, Crown } from 'lucide-react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { LogPanel } from '@/components/logs/log-panel';
import { useLogStore } from '@/lib/log-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { AvatarDisplay } from '@/components/common/avatar-display';
import { InputArea, type ImageAttachment } from '@/components/chat/input-area';
import { useAppStore } from '@/lib/store';
import { RoomTTSQueue } from '@/lib/room-tts-queue';
import { cn, isSentenceEnd, formatDayTime } from '@/lib/utils';
import type { Choom } from '@/lib/types';

interface Participant {
  id: string;
  choomId: string;
  order: number;
  active: boolean;
  choom: Choom;
}
interface Room {
  id: string;
  title: string | null;
  autoRounds: number;
  projectFolder: string | null;
  participants: Participant[];
  updatedAt: string;
  _count?: { messages: number };
}
interface RoomMessage {
  id: string;
  role: string;
  authorChoomId: string | null;
  authorName: string;
  content: string;
  imageUrl: string | null;
  createdAt: string;
}

// Strip a leading "Name:" / "[Name]:" label the model sometimes parrots at the
// very start of its reply. The final saved text is cleaned server-side, but the
// live stream + TTS read raw tokens — without this the audio speaks the name.
function stripLeadingName(s: string, names: string[]): string {
  let out = s.replace(/^\s+/, '');
  const alt = names.filter(Boolean).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const bracket = /^\[[^\]\n]{1,40}\]\s*[:：]\s*/;
  const bare = alt ? new RegExp(`^(?:${alt})\\s*[:：]\\s*`, 'i') : null;
  for (let i = 0; i < 3; i++) {
    if (bracket.test(out)) { out = out.replace(bracket, '').replace(/^\s+/, ''); continue; }
    if (bare && bare.test(out)) { out = out.replace(bare, '').replace(/^\s+/, ''); continue; }
    break;
  }
  return out;
}

// A streamed sentence that STARTS with a "[Name]:" label is a reproduced
// transcript line (a weak model echoing the room back), not the speaker's own
// prose — never speak it. The server strips these from the saved/Signal text, but
// the live TTS reads raw tokens, so without this the audio speaks the whole room.
function isEchoedTranscriptLine(s: string): boolean {
  return /^\s*\[[^\]\n]{1,40}\]\s*[:：]/.test(s);
}

export default function RoomsPage() {
  const router = useRouter();
  const { settings, ui } = useAppStore();
  const [running, setRunning] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const runningRef = useRef(false);

  const [chooms, setChooms] = useState<Choom[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [currentRoomId, setCurrentRoomId] = useState<string | null>(null);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [managingMembers, setManagingMembers] = useState(false);
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [editRoomTitle, setEditRoomTitle] = useState('');
  const [roomLogsOpen, setRoomLogsOpen] = useState(false);
  // On phones the room list is an overlay (toggled via the header menu button);
  // on md+ it's a static column that's always visible.
  const [roomListOpen, setRoomListOpen] = useState(false);
  const [signalRoomId, setSignalRoomId] = useState<string | null>(null);
  // Per-speaker live state during a turn
  const [activeSpeaker, setActiveSpeaker] = useState<{ name: string; choomId: string; status: string } | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [passNotes, setPassNotes] = useState<string[]>([]);

  const ttsRef = useRef<RoomTTSQueue | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);
  const lastTimestampRef = useRef<string | null>(null);
  // Per-speaker streaming-TTS buffer + the voice to synthesize it with. Lets
  // audio start sentence-by-sentence (like 1:1) instead of waiting for the whole
  // message — while RoomTTSQueue still serializes so voices never overlap.
  const ttsBufRef = useRef('');
  const ttsVoiceRef = useRef<string | null>(null);
  // Every sentence already sent to TTS this speaker turn (normalized). The live
  // stream is raw, un-deduped tokens — a looping model repeats a line several
  // times (often non-adjacently), and adjacent-only dedup let it be SPOKEN 3×
  // even though the saved text is paragraph-deduped server-side. Tracking the
  // full set kills non-adjacent repeats too.
  const ttsSpokenRef = useRef<Set<string>>(new Set());
  const streamRawRef = useRef(''); // raw accumulation for the live display
  const firstChunkRef = useRef(true); // first TTS chunk of a speaker may carry a "Name:" label
  const choomsRef = useRef<Choom[]>([]);
  useEffect(() => { choomsRef.current = chooms; }, [chooms]);

  const currentRoom = rooms.find(r => r.id === currentRoomId) || null;

  // Init TTS queue once settings are available
  useEffect(() => {
    ttsRef.current = new RoomTTSQueue(settings.tts, (isSpeaking) => setSpeaking(isSpeaking));
    return () => ttsRef.current?.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { ttsRef.current?.setMuted(ui.isMuted); }, [ui.isMuted]);

  // Load chooms + rooms on mount
  useEffect(() => {
    (async () => {
      try {
        const [cRes, rRes, bRes] = await Promise.all([
          fetch('/api/chooms'), fetch('/api/group-chats'), fetch('/api/bridge-config'),
        ]);
        if (cRes.ok) setChooms(await cRes.json());
        if (rRes.ok) {
          const rs = await rRes.json();
          setRooms(rs);
          if (rs.length && !currentRoomId) setCurrentRoomId(rs[0].id);
        }
        if (bRes.ok) {
          const cfg = await bRes.json();
          setSignalRoomId(cfg.defaultGroupRoomId || null);
        }
      } catch (e) { console.error('Load failed', e); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMessages = useCallback(async (roomId: string) => {
    try {
      const res = await fetch(`/api/group-chats/${roomId}/messages`);
      if (res.ok) {
        const msgs: RoomMessage[] = await res.json();
        setMessages(msgs);
        lastTimestampRef.current = msgs.length ? msgs[msgs.length - 1].createdAt : null;
      }
    } catch (e) { console.error('Load messages failed', e); }
  }, []);

  // Load messages when room changes
  useEffect(() => {
    if (currentRoomId) loadMessages(currentRoomId);
    else setMessages([]);
  }, [currentRoomId, loadMessages]);

  // Point the activity-log store at the CURRENT ROOM. This does two things:
  // (1) any STT/TTS the user triggers here is tagged with the room id, not the
  // stale 1:1 chat id that was leaking group speech into the main chat's log;
  // (2) loads this room's activity (group turns are server-tagged with the room
  // id) so the room's Activity Log panel can show it.
  useEffect(() => {
    const { setContext, loadLogs, clearView } = useLogStore.getState();
    if (currentRoomId) {
      setContext(null, currentRoomId);
      loadLogs(undefined, currentRoomId);
    } else {
      setContext(null, null);
      // No room selected: clear the VIEW only — never delete persisted logs.
      clearView();
    }
    return () => { useLogStore.getState().setContext(null, null); };
  }, [currentRoomId]);

  // Poll for cross-device (Signal) updates while idle in a room
  useEffect(() => {
    if (!currentRoomId) return;
    const interval = setInterval(async () => {
      if (runningRef.current) return; // don't poll mid-turn
      try {
        const since = lastTimestampRef.current ? `?since=${encodeURIComponent(lastTimestampRef.current)}` : '';
        const res = await fetch(`/api/group-chats/${currentRoomId}/messages${since}`);
        if (res.ok) {
          const newMsgs: RoomMessage[] = await res.json();
          if (newMsgs.length) {
            setMessages(prev => {
              const seen = new Set(prev.map(m => m.id));
              const merged = [...prev, ...newMsgs.filter(m => !seen.has(m.id))];
              return merged;
            });
            // Speak background-arrived Choom messages — a room-followup re-entry, a
            // Signal "group:" turn, or another device's turn. The live SSE path only
            // speaks turns YOU trigger here; without this, background room activity
            // appears on screen silently. These are fetched with `since=` so they're
            // genuinely new (lastTimestampRef advances during live turns) → no
            // double-speak. RoomTTSQueue serializes per voice and honors mute.
            const names = [...choomsRef.current.map(c => c.name), 'Donny', 'You'];
            // Only SPEAK genuinely-live turns. A message older than this window is
            // backlog (you opened a room whose conversation already happened) — it's
            // still shown on screen, but speaking it would dump stale audio at you,
            // which is the "Aloy's intro played at the end" confusion. The per-turn
            // ceiling is 300s, so 6 min covers a slow-but-live turn without replaying
            // history.
            const SPEAK_FRESHNESS_MS = 6 * 60 * 1000;
            for (const m of newMsgs) {
              if (m.role !== 'assistant' || !m.authorChoomId || !m.content?.trim()) continue;
              const age = Date.now() - new Date(m.createdAt).getTime();
              if (age > SPEAK_FRESHNESS_MS) continue; // stale backlog — display only, don't speak
              const clean = stripLeadingName(
                m.content.replace(/\n*_?\[image shared to the room[\s\S]*?\]_?/gi, '').trim(),
                names,
              );
              if (clean) {
                const voice = choomsRef.current.find(c => c.id === m.authorChoomId)?.voiceId || null;
                ttsRef.current?.enqueue(clean, voice);
              }
            }
            lastTimestampRef.current = newMsgs[newMsgs.length - 1].createdAt;
          }
        }
      } catch { /* ignore poll errors */ }
    }, 4000); // fast poll → background room audio stays close to real-time, not 12s batches
    return () => clearInterval(interval);
  }, [currentRoomId]);

  // Auto-scroll
  useEffect(() => { scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streamingText, activeSpeaker]);

  const settingsPayload = useCallback(() => ({
    llm: settings.llm, memory: settings.memory, imageGen: settings.imageGen,
    weather: settings.weather, search: settings.search, vision: settings.vision,
    homeAssistant: settings.homeAssistant, providers: settings.providers,
    modelProfiles: settings.modelProfiles, visionProfiles: settings.visionProfiles,
  }), [settings]);

  // Shared SSE consumer for both a new message and "keep going".
  const consumeStream = useCallback(async (reqBody: Record<string, unknown>) => {
    runningRef.current = true;
    setRunning(true);
    setStreamingText('');
    setActiveSpeaker(null);
    setPassNotes([]);
    ttsRef.current?.stop();
    ttsBufRef.current = '';
    ttsVoiceRef.current = null;

    abortRef.current = new AbortController();
    try {
      const res = await fetch('/api/group-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: currentRoomId, settings: settingsPayload(), ...reqBody }),
        signal: abortRef.current.signal,
      });
      if (!res.ok || !res.body) throw new Error('Group chat request failed');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let data: Record<string, unknown>;
          try { data = JSON.parse(line.slice(6)); } catch { continue; }
          switch (data.type) {
            case 'speaker_start':
              // Anti-echo retry: drop the parrot's already-queued/playing audio so
              // only the corrected response is spoken.
              if (data.retry) ttsRef.current?.stop();
              setActiveSpeaker({ name: data.speakerName as string, choomId: data.speakerChoomId as string, status: data.retry ? 'rephrasing…' : 'thinking…' });
              setStreamingText('');
              ttsBufRef.current = '';
              ttsSpokenRef.current.clear();
              streamRawRef.current = '';
              firstChunkRef.current = true;
              ttsVoiceRef.current = choomsRef.current.find(c => c.id === data.speakerChoomId)?.voiceId || null;
              break;
            case 'speaker_content': {
              const tok = (data.content as string) || '';
              const names = [...choomsRef.current.map(c => c.name), 'Donny', 'You'];
              // Live display: strip a leading "Name:" label from the raw accumulation.
              streamRawRef.current += tok;
              setStreamingText(stripLeadingName(streamRawRef.current, names));
              // Stream TTS sentence-by-sentence so audio starts sooner. Content
              // is already think/tool-call filtered server-side. Skip a sentence
              // identical to the previous one (weak models sometimes loop and
              // repeat a line several times — don't speak it 3×).
              ttsBufRef.current += tok;
              if (isSentenceEnd(ttsBufRef.current.trim())) {
                // First chunk of a speaker may start with a parroted "Name:" label —
                // strip it so the audio doesn't speak the name (final text already is).
                let sentence = ttsBufRef.current.trim();
                if (firstChunkRef.current) { sentence = stripLeadingName(sentence, names); firstChunkRef.current = false; }
                const key = sentence.toLowerCase().replace(/\s+/g, ' ').trim();
                if (sentence && !isEchoedTranscriptLine(sentence) && !ttsSpokenRef.current.has(key)) {
                  ttsSpokenRef.current.add(key);
                  ttsRef.current?.enqueue(sentence, ttsVoiceRef.current);
                }
                ttsBufRef.current = '';
              }
              break;
            }
            case 'speaker_tool_call':
              setActiveSpeaker(s => s ? { ...s, status: `using ${data.name as string}…` } : s);
              break;
            case 'speaker_done': {
              // Flush any trailing partial sentence for this speaker (deduped,
              // and leading-name-stripped if this is the only/first chunk).
              let tail = ttsBufRef.current.trim();
              if (firstChunkRef.current) { tail = stripLeadingName(tail, [...choomsRef.current.map(c => c.name), 'Donny', 'You']); firstChunkRef.current = false; }
              const tailKey = tail.toLowerCase().replace(/\s+/g, ' ').trim();
              if (tail && !isEchoedTranscriptLine(tail) && !ttsSpokenRef.current.has(tailKey)) {
                ttsSpokenRef.current.add(tailKey);
                ttsRef.current?.enqueue(tail, ttsVoiceRef.current);
              }
              ttsBufRef.current = '';
              const doneMsg: RoomMessage = {
                id: data.messageId as string, role: 'assistant',
                authorChoomId: data.speakerChoomId as string, authorName: data.speakerName as string,
                content: data.content as string, imageUrl: (data.imageUrl as string) || null,
                createdAt: new Date().toISOString(),
              };
              setMessages(prev => [...prev, doneMsg]);
              lastTimestampRef.current = doneMsg.createdAt;
              setStreamingText('');
              setActiveSpeaker(null);
              break;
            }
            case 'passed':
              setPassNotes(prev => [...prev, data.speakerName as string]);
              setActiveSpeaker(null);
              setStreamingText('');
              ttsBufRef.current = '';
              break;
            case 'speaker_error':
              setActiveSpeaker(null);
              setStreamingText('');
              console.warn('Speaker error:', data.error);
              break;
            case 'done':
              setActiveSpeaker(null);
              break;
            case 'error':
              console.error('Room error:', data.error);
              break;
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') console.error('Group stream failed', e);
    } finally {
      runningRef.current = false;
      setRunning(false);
      setActiveSpeaker(null);
      setStreamingText('');
      if (currentRoomId) loadMessages(currentRoomId);
    }
  }, [currentRoomId, settingsPayload, loadMessages]);

  const handleSend = useCallback(async (text: string, attachment?: ImageAttachment) => {
    if (!currentRoomId || (!text.trim() && !attachment)) return;
    // Jump in: interrupt any running sequence, then start fresh with this message.
    if (runningRef.current) {
      abortRef.current?.abort();
      ttsRef.current?.stop();
      await new Promise(r => setTimeout(r, 50));
    }
    let messageContent = text.trim();
    if (attachment?.workspacePath) {
      // Canonical room-image note: extractImagePaths() in the orchestrator only
      // matches `analyze_image image_path="…"`, and stripImageNotes() only hides
      // notes starting with "[image shared to the room". The old "[System: …]"
      // wording matched NEITHER — so the upload never reached groupRecentImages and
      // the Chooms only pretended to see it. Use the format the rest of the pipeline
      // recognizes so the path is surfaced to every speaker as a real shared image.
      messageContent += `\n\n_[image shared to the room by the owner — saved at \`${attachment.workspacePath}\`. View it with analyze_image image_path="${attachment.workspacePath}".]_`;
    }
    setMessages(prev => [...prev, {
      id: `tmp-${Date.now()}`, role: 'user', authorChoomId: null,
      authorName: 'You', content: text.trim(), imageUrl: null, createdAt: new Date().toISOString(),
    }]);
    await consumeStream({ message: messageContent });
  }, [currentRoomId, consumeStream]);

  const handleKeepGoing = useCallback(async () => {
    if (!currentRoomId || runningRef.current) return;
    await consumeStream({ continue: true, rounds: currentRoom?.autoRounds || 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRoomId, consumeStream, currentRoom?.autoRounds]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    ttsRef.current?.stop();
    runningRef.current = false;
    setRunning(false);
  }, []);

  const handleSetAutoRounds = useCallback(async (roomId: string, value: number) => {
    const v = Math.max(0, Math.min(50, value));
    setRooms(prev => prev.map(r => r.id === roomId ? { ...r, autoRounds: v } : r));
    await fetch(`/api/group-chats/${roomId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoRounds: v }),
    });
  }, []);

  const handleSetSignalRoom = useCallback(async (id: string) => {
    await fetch('/api/bridge-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultGroupRoomId: id }),
    });
    setSignalRoomId(id);
  }, []);

  const startRenameRoom = useCallback((id: string, current: string) => {
    setEditingRoomId(id);
    setEditRoomTitle(current);
  }, []);

  const saveRenameRoom = useCallback(async (id: string) => {
    const name = editRoomTitle.trim();
    setEditingRoomId(null);
    if (!name) return;
    setRooms(prev => prev.map(r => r.id === id ? { ...r, title: name } : r));
    await fetch(`/api/group-chats/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: name }),
    });
  }, [editRoomTitle]);

  const handleDeleteRoom = useCallback(async (id: string) => {
    if (!confirm('Delete this room and its transcript?')) return;
    await fetch(`/api/group-chats/${id}`, { method: 'DELETE' });
    setRooms(prev => prev.filter(r => r.id !== id));
    if (currentRoomId === id) setCurrentRoomId(null);
  }, [currentRoomId]);

  // Archive: hide the room from the list but KEEP its history on disk (unlike delete).
  const handleArchiveRoom = useCallback(async (id: string) => {
    if (!confirm('Archive this room? It will be hidden from the list, but the conversation history is kept and you can restore it later.')) return;
    await fetch(`/api/group-chats/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    setRooms(prev => prev.filter(r => r.id !== id));
    if (currentRoomId === id) setCurrentRoomId(null);
  }, [currentRoomId]);

  // Remove a Choom from a room (owner action). The Choom's past messages stay in
  // the history and they can be invited back later. A room must keep ≥1 member.
  const handleRemoveParticipant = useCallback(async (roomId: string, choomId: string, name: string) => {
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;
    const remaining = room.participants.filter(p => p.active && p.choomId !== choomId);
    if (remaining.length === 0) { alert('A room needs at least one member — delete or archive it instead.'); return; }
    if (!confirm(`Remove ${name} from this room? Their messages stay in the history and they can be invited back.`)) return;
    setRooms(prev => prev.map(r => r.id === roomId ? { ...r, participants: remaining } : r));
    await fetch(`/api/group-chats/${roomId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participants: remaining.map((p, i) => ({ choomId: p.choomId, order: i, active: true })) }),
    });
  }, [rooms]);

  // Promote a Choom to room leader. "Leader" isn't a stored field — it's just the
  // first participant by `order` (the host/first-responder seat that takes the
  // room-creator model and speaks first each round). So promoting = moving that
  // Choom to order 0 and re-indexing the rest, then PUTting the new participant set
  // (the orchestrator reads orderBy: order asc on every run). The per-Choom
  // groupChatModel applies to NON-leaders, which is why setting it on the leader
  // had no effect — moving the leader seat is how you change that.
  const handleMakeLeader = useCallback(async (roomId: string, choomId: string, name: string) => {
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;
    const active = room.participants.filter(p => p.active);
    if (active[0]?.choomId === choomId) return; // already the leader
    if (!confirm(`Make ${name} the room leader? They'll speak first each round and take the room-creator model seat (their own per-room model override no longer applies as leader).`)) return;
    const reordered = [
      ...active.filter(p => p.choomId === choomId),
      ...active.filter(p => p.choomId !== choomId),
    ].map((p, i) => ({ ...p, order: i }));
    setRooms(prev => prev.map(r => r.id === roomId ? { ...r, participants: reordered } : r));
    await fetch(`/api/group-chats/${roomId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participants: reordered.map((p, i) => ({ choomId: p.choomId, order: i, active: true })) }),
    });
  }, [rooms]);

  return (
    <div className="flex h-screen bg-background">
      {/* Mobile backdrop for the room-list overlay */}
      {roomListOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setRoomListOpen(false)}
          aria-hidden="true"
        />
      )}
      {/* Room list column — static on md+, slide-in overlay on phones */}
      <aside
        className={cn(
          'w-[280px] border-r border-border flex flex-col bg-card',
          'fixed inset-y-0 left-0 z-40 transition-transform duration-300 md:static md:z-auto md:translate-x-0',
          roomListOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        )}
      >
        <div className="flex items-center justify-between px-4 py-4 border-b border-border">
          <Button variant="ghost" size="icon" onClick={() => router.push('/')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <span className="font-semibold flex items-center gap-2"><Users className="h-4 w-4" /> Rooms</span>
          <Button variant="ghost" size="icon" onClick={() => setCreateOpen(true)}>
            <Plus className="h-5 w-5" />
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {rooms.length === 0 && (
              <p className="text-sm text-muted-foreground p-4 text-center">No rooms yet. Click + to create one.</p>
            )}
            {rooms.map(room => {
              const roomName = room.title || room.participants.map(p => p.choom.name).join(', ');
              return (
              <div
                key={room.id}
                className={cn(
                  // grid [1fr_auto]: the content column flexes/truncates, the kebab
                  // lives in the `auto` column so it can NEVER be pushed off-screen
                  // by a long room name (the bug from the 1:1 sidebar, relearned).
                  'group grid grid-cols-[1fr_auto] items-start gap-1 px-3 py-2 rounded-lg cursor-pointer hover:bg-muted/50',
                  currentRoomId === room.id && 'bg-primary/10 border border-primary/30'
                )}
                onClick={() => { if (editingRoomId !== room.id) { setCurrentRoomId(room.id); setRoomListOpen(false); } }}
              >
                <div className="min-w-0 overflow-hidden">
                  {/* Row 1: avatars (up to 6 on one line) */}
                  <div className="flex -space-x-2 mb-1">
                    {room.participants.slice(0, 6).map(p => (
                      <AvatarDisplay key={p.id} name={p.choom.name} avatarUrl={p.choom.avatarUrl} size="sm" />
                    ))}
                    {room.participants.length > 6 && (
                      <span className="flex items-center justify-center h-6 w-6 rounded-full bg-muted text-[10px] font-medium ring-2 ring-background">
                        +{room.participants.length - 6}
                      </span>
                    )}
                  </div>
                  {/* Row 2: room name (inline-editable) */}
                  {editingRoomId === room.id ? (
                    <Input
                      value={editRoomTitle}
                      onChange={(e) => setEditRoomTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveRenameRoom(room.id);
                        if (e.key === 'Escape') setEditingRoomId(null);
                      }}
                      onBlur={() => saveRenameRoom(room.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="h-6 text-sm px-1"
                      autoFocus
                    />
                  ) : (
                    <p className="text-sm font-medium truncate" title={roomName}>{roomName}</p>
                  )}
                  {/* Row 3: counts */}
                  <p className="text-xs text-muted-foreground truncate">
                    {room.participants.length} chooms
                    {room._count ? ` · ${room._count.messages} msgs` : ''}
                    {room._count && room._count.messages > 300 ? ' ⚠️' : ''}
                  </p>
                </div>
                {/* Room actions — kebab in the un-squeezable auto column. */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground"
                      onClick={(e) => e.stopPropagation()} title="Room actions">
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    <DropdownMenuItem onClick={(e) => { e.stopPropagation(); startRenameRoom(room.id, roomName); }}>
                      <Pencil className="h-4 w-4 mr-2" /> Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleArchiveRoom(room.id); }}>
                      <Archive className="h-4 w-4 mr-2" /> Archive
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={(e) => { e.stopPropagation(); handleDeleteRoom(room.id); }}>
                      <Trash2 className="h-4 w-4 mr-2" /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              );
            })}
          </div>
        </ScrollArea>
      </aside>

      {/* Room view */}
      <main className="flex-1 flex flex-col min-w-0">
        {currentRoom ? (
          <>
            <div className="px-3 sm:px-6 py-3 border-b border-border flex items-center gap-2 sm:gap-3 flex-wrap">
              <Button variant="ghost" size="icon" className="h-8 w-8 md:hidden shrink-0"
                onClick={() => setRoomListOpen(true)} title="Rooms">
                <Menu className="h-5 w-5" />
              </Button>
              <div className="flex -space-x-2">
                {currentRoom.participants.filter(p => p.active).map(p => (
                  <AvatarDisplay key={p.id} name={p.choom.name} avatarUrl={p.choom.avatarUrl} size="sm" />
                ))}
              </div>
              <div className="flex-1">
                <p className="font-semibold">{currentRoom.title || currentRoom.participants.filter(p => p.active).map(p => p.choom.name).join(', ')}</p>
                <p className="text-xs text-muted-foreground">
                  Turn order: {currentRoom.participants.filter(p => p.active).map(p => p.choom.name).join(' → ')}
                </p>
              </div>
              {/* Auto-rounds stepper — adjustable on the fly (applies to next turn) */}
              <div className="flex items-center gap-1 text-xs text-muted-foreground" title="How many extra rounds the Chooms talk among themselves before pausing for you (0–50). Applies to your next message or Keep going.">
                <span className="hidden sm:inline">auto-rounds</span>
                <Button variant="ghost" size="icon" className="h-7 w-7"
                  onClick={() => handleSetAutoRounds(currentRoom.id, currentRoom.autoRounds - 1)}
                  disabled={currentRoom.autoRounds <= 0}>
                  <Minus className="h-3 w-3" />
                </Button>
                <span className="w-6 text-center font-medium text-foreground">{currentRoom.autoRounds}</span>
                <Button variant="ghost" size="icon" className="h-7 w-7"
                  onClick={() => handleSetAutoRounds(currentRoom.id, currentRoom.autoRounds + 1)}
                  disabled={currentRoom.autoRounds >= 50}>
                  <Plus className="h-3 w-3" />
                </Button>
              </div>
              <Button variant="outline" size="sm" className="gap-2"
                onClick={handleKeepGoing} disabled={running}
                title="Let the Chooms take another round (or auto-rounds) among themselves without a new message from you">
                <Play className="h-4 w-4" /> Keep going
              </Button>
              <Button
                variant={signalRoomId === currentRoom.id ? 'default' : 'ghost'}
                size="sm"
                className="gap-2"
                onClick={() => handleSetSignalRoom(currentRoom.id)}
                title={signalRoomId === currentRoom.id
                  ? 'This room receives "group:" messages from Signal'
                  : 'Make this the room that Signal "group:" messages go to'}
              >
                <Smartphone className="h-4 w-4" />
                {signalRoomId === currentRoom.id ? 'Signal room' : 'Set as Signal room'}
              </Button>
              <Button variant={managingMembers ? 'default' : 'ghost'} size="icon" className="h-8 w-8"
                onClick={() => setManagingMembers(v => !v)}
                title="Manage members — remove a Choom from this room (they keep their history and can be invited back)">
                <Users className="h-4 w-4" />
              </Button>
              <Button variant={roomLogsOpen ? 'default' : 'ghost'} size="icon" className="h-8 w-8"
                onClick={() => { if (currentRoomId) useLogStore.getState().loadLogs(undefined, currentRoomId); setRoomLogsOpen(v => !v); }}
                title="Activity log — tool calls, TTS/STT and responses for this room">
                <ScrollText className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8"
                onClick={() => handleArchiveRoom(currentRoom.id)}
                title="Archive this room (hide it but keep the history)">
                <Archive className="h-4 w-4" />
              </Button>
            </div>

            {managingMembers && (
              <div className="px-6 py-2 border-b border-border bg-muted/30 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground mr-1">Members — 👑 leader speaks first; click 👑 to promote, ✕ to remove:</span>
                {currentRoom.participants.filter(p => p.active).map((p, idx) => {
                  const isLeader = idx === 0;
                  return (
                    <span key={p.id} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                      isLeader ? 'border-primary/50 bg-primary/10' : 'border-border bg-background')}>
                      {isLeader
                        ? <Crown className="h-3 w-3 text-primary" />
                        : (
                          <button
                            onClick={() => handleMakeLeader(currentRoom.id, p.choomId, p.choom.name)}
                            title={`Make ${p.choom.name} the room leader`}
                            className="text-muted-foreground hover:text-primary">
                            <Crown className="h-3 w-3" />
                          </button>
                        )}
                      {p.choom.name}
                      <button
                        onClick={() => handleRemoveParticipant(currentRoom.id, p.choomId, p.choom.name)}
                        title={`Remove ${p.choom.name}`}
                        className="text-muted-foreground hover:text-destructive">
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}

            <ScrollArea className="flex-1">
              <div className="max-w-3xl mx-auto px-3 sm:px-6 py-4 space-y-4">
                {messages.map(m => (
                  <RoomBubble key={m.id} msg={m} chooms={chooms} />
                ))}
                {/* Live streaming bubble for the active speaker */}
                {activeSpeaker && (
                  <div className="flex gap-3">
                    <AvatarDisplay name={activeSpeaker.name}
                      avatarUrl={chooms.find(c => c.id === activeSpeaker.choomId)?.avatarUrl} size="sm" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-primary mb-1 flex items-center gap-2">
                        {activeSpeaker.name}
                        <span className="text-xs text-muted-foreground font-normal flex items-center gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" /> {activeSpeaker.status}
                        </span>
                      </p>
                      {streamingText && <p className="text-sm whitespace-pre-wrap">{streamingText}</p>}
                    </div>
                  </div>
                )}
                {/* Who stayed quiet this turn (so "only one replied" is never a mystery) */}
                {passNotes.length > 0 && (
                  <p className="text-center text-xs text-muted-foreground/70 italic">
                    {passNotes.join(', ')} {passNotes.length === 1 ? 'had' : 'had'} nothing to add this round
                  </p>
                )}
                {/* Stop the running sequence AND/OR the audio (which can lag the
                    text by minutes). You can also just type to jump in. */}
                {(running || speaking) && (
                  <div className="flex justify-center">
                    <Button variant="outline" size="sm" className="gap-2" onClick={handleStop}>
                      <Square className="h-3 w-3" /> {running ? 'Stop' : 'Stop audio'}
                    </Button>
                  </div>
                )}
                <div ref={scrollEndRef} />
              </div>
            </ScrollArea>

            <InputArea
              onSend={handleSend}
              onStop={handleStop}
              disabled={!currentRoomId}
              placeholder={running
                ? 'Jump in anytime — type to interrupt and take the floor…'
                : 'Message the room… (@name to address one, otherwise everyone responds in turn)'}
            />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground p-6">
            <div className="text-center">
              <Users className="h-12 w-12 mx-auto mb-3 opacity-40" />
              <p>Select a room or create one to start a group chat.</p>
              <Button variant="outline" size="sm" className="mt-4 gap-2 md:hidden"
                onClick={() => setRoomListOpen(true)}>
                <Menu className="h-4 w-4" /> Browse rooms
              </Button>
            </div>
          </div>
        )}
      </main>

      <CreateRoomDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        chooms={chooms}
        onCreated={(room) => { setRooms(prev => [room, ...prev]); setCurrentRoomId(room.id); }}
      />

      {/* Activity log for the current room (tool calls, TTS/STT, responses) —
          reuses the 1:1 LogPanel, which reads the store context we point at the
          room above. */}
      {roomLogsOpen && currentRoom && <LogPanel onClose={() => setRoomLogsOpen(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function RoomBubble({ msg, chooms }: { msg: RoomMessage; chooms: Choom[] }) {
  const isUser = msg.authorChoomId === null;
  const choom = msg.authorChoomId ? chooms.find(c => c.id === msg.authorChoomId) : null;
  return (
    <div className={cn('flex gap-3', isUser && 'flex-row-reverse')}>
      <AvatarDisplay name={msg.authorName} avatarUrl={choom?.avatarUrl} size="sm" />
      <div className={cn('flex-1 min-w-0', isUser && 'flex flex-col items-end')}>
        <p className={cn('text-sm font-medium mb-1', isUser ? 'text-muted-foreground' : 'text-primary')}>
          {msg.authorName}
          <span className="ml-2 text-xs font-normal text-muted-foreground">{formatDayTime(msg.createdAt)}</span>
        </p>
        <div className={cn(
          'rounded-2xl px-4 py-2 inline-block max-w-full',
          isUser ? 'bg-primary/15' : 'bg-muted/50'
        )}>
          <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
          {msg.imageUrl && (
            <a
              href={msg.imageUrl}
              download={`${msg.authorName}-${msg.id}.png`}
              target="_blank"
              rel="noopener noreferrer"
              className="group/img relative mt-2 inline-block"
              title="Click to open / download"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- data/URL images, unknown dims */}
              <img src={msg.imageUrl} alt="generated" className="rounded-lg max-w-xs" />
              <span className="absolute bottom-2 right-2 bg-black/60 text-white rounded-full p-1.5 opacity-0 group-hover/img:opacity-100 transition-opacity">
                <Download className="h-4 w-4" />
              </span>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function CreateRoomDialog({ open, onOpenChange, chooms, onCreated }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  chooms: Choom[];
  onCreated: (room: Room) => void;
}) {
  const [title, setTitle] = useState('');
  const [autoRounds, setAutoRounds] = useState(0);
  const [selected, setSelected] = useState<string[]>([]); // ordered choomIds
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) { setTitle(''); setAutoRounds(0); setSelected([]); }
  }, [open]);

  const toggle = (id: string) => {
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const create = async () => {
    if (selected.length < 1) return;
    setSaving(true);
    try {
      const res = await fetch('/api/group-chats', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim() || null, autoRounds, participants: selected }),
      });
      if (res.ok) { onCreated(await res.json()); onOpenChange(false); }
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Group Room</DialogTitle>
          <DialogDescription>Pick the Chooms (click in speaking order) and how many rounds they may talk among themselves.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm text-muted-foreground">Title (optional)</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Backpack design crew" />
          </div>
          <div>
            <label className="text-sm text-muted-foreground">Participants — click in speaking order</label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {chooms.map(c => {
                const idx = selected.indexOf(c.id);
                const isSel = idx >= 0;
                return (
                  <button key={c.id} onClick={() => toggle(c.id)}
                    className={cn('flex items-center gap-2 px-3 py-2 rounded-lg border text-left',
                      isSel ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/50')}>
                    <AvatarDisplay name={c.name} avatarUrl={c.avatarUrl} size="sm" />
                    <span className="text-sm flex-1 truncate">{c.name}</span>
                    {isSel && <span className="text-xs font-bold text-primary">{idx + 1}</span>}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="text-sm text-muted-foreground">
              Auto-rounds (Chooms riff off each other before pausing for you): {autoRounds}
              <span className="text-xs"> — 0 for normal turn-based; adjustable later</span>
            </label>
            <input type="range" min={0} max={50} value={autoRounds}
              onChange={(e) => setAutoRounds(Number(e.target.value))} className="w-full mt-1" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={create} disabled={selected.length < 1 || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create Room'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
