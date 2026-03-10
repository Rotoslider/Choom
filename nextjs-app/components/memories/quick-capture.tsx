'use client';

import React, { useState } from 'react';
import { Plus, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { MemoryType } from '@/lib/types';

const MEMORY_TYPES: MemoryType[] = ['fact', 'preference', 'event', 'task', 'conversation', 'ephemeral'];

interface QuickCaptureProps {
  memoryEndpoint: string;
  companionId?: string;
  onCaptured: () => void;
}

export function QuickCapture({ memoryEndpoint, companionId, onCaptured }: QuickCaptureProps) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [memoryType, setMemoryType] = useState<MemoryType>('fact');
  const [importance, setImportance] = useState(5);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!content.trim()) return;
    setSaving(true);
    try {
      const autoTitle = title.trim() || content.slice(0, 60).replace(/[^\w\s'-]/g, '').trim();
      const res = await fetch('/api/memories', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-memory-endpoint': memoryEndpoint,
        },
        body: JSON.stringify({
          action: 'remember',
          title: autoTitle,
          content: content.trim(),
          tags: tags.trim(),
          importance,
          memory_type: memoryType,
          companion_id: companionId,
        }),
      });
      if (res.ok) {
        setContent('');
        setTitle('');
        setTags('');
        setImportance(5);
        setExpanded(false);
        onCaptured();
      }
    } catch (err) {
      console.error('Failed to save memory:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleSave();
    }
  };

  return (
    <div className="border-b border-border bg-card/50 px-6 py-3">
      <div className="flex items-center gap-2">
        <Plus className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        <Input
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => !expanded && content && setExpanded(true)}
          placeholder="Quick capture — type a thought, link, or idea..."
          className="h-8 text-sm border-none bg-transparent shadow-none focus-visible:ring-0 px-0"
        />
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        <Button size="sm" onClick={handleSave} disabled={!content.trim() || saving} className="h-7 text-xs">
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
        </Button>
      </div>

      {expanded && (
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div>
            <label className="text-[10px] text-muted-foreground mb-0.5 block">Title (optional)</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-7 text-xs" placeholder="Auto-generated" />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground mb-0.5 block">Type</label>
            <select
              value={memoryType}
              onChange={(e) => setMemoryType(e.target.value as MemoryType)}
              className="w-full h-7 text-xs rounded-md bg-muted border border-border px-2"
            >
              {MEMORY_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground mb-0.5 block">Tags</label>
            <Input value={tags} onChange={(e) => setTags(e.target.value)} className="h-7 text-xs" placeholder="comma, separated" />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground mb-0.5 block">Importance ({importance})</label>
            <input
              type="range"
              min={1}
              max={10}
              value={importance}
              onChange={(e) => setImportance(parseInt(e.target.value))}
              className={cn('w-full mt-1')}
            />
          </div>
        </div>
      )}
    </div>
  );
}
