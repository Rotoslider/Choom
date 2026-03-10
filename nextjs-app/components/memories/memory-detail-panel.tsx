'use client';

import React, { useState, useEffect } from 'react';
import {
  X,
  Edit3,
  Trash2,
  Save,
  Clock,
  Star,
  Tag,
  Hash,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { Memory, MemoryType } from '@/lib/types';

const TYPE_COLORS: Record<string, string> = {
  conversation: 'bg-blue-500/15 text-blue-400',
  fact: 'bg-green-500/15 text-green-400',
  preference: 'bg-purple-500/15 text-purple-400',
  event: 'bg-amber-500/15 text-amber-400',
  task: 'bg-cyan-500/15 text-cyan-400',
  ephemeral: 'bg-gray-500/15 text-gray-400',
};

const MEMORY_TYPES: MemoryType[] = ['conversation', 'fact', 'preference', 'event', 'task', 'ephemeral'];

interface MemoryDetailPanelProps {
  memory: Memory;
  memoryEndpoint: string;
  onClose: () => void;
  onUpdated: (memory: Memory) => void;
  onDeleted: (id: string) => void;
}

export function MemoryDetailPanel({
  memory,
  memoryEndpoint,
  onClose,
  onUpdated,
  onDeleted,
}: MemoryDetailPanelProps) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  // Edit state
  const [title, setTitle] = useState(memory.title);
  const [content, setContent] = useState(memory.content);
  const [tagsStr, setTagsStr] = useState(
    Array.isArray(memory.tags) ? memory.tags.join(', ') : memory.tags || ''
  );
  const [importance, setImportance] = useState(memory.importance);
  const [memoryType, setMemoryType] = useState<MemoryType>(memory.memory_type);

  // Reset edit state when memory changes
  useEffect(() => {
    setTitle(memory.title);
    setContent(memory.content);
    setTagsStr(Array.isArray(memory.tags) ? memory.tags.join(', ') : memory.tags || '');
    setImportance(memory.importance);
    setMemoryType(memory.memory_type);
    setEditing(false);
    setConfirmDelete(false);
  }, [memory]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/memories', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-memory-endpoint': memoryEndpoint,
        },
        body: JSON.stringify({
          memory_id: memory.id,
          title,
          content,
          tags: tagsStr,
          importance,
          memory_type: memoryType,
        }),
      });
      if (res.ok) {
        const updated: Memory = {
          ...memory,
          title,
          content,
          tags: tagsStr.split(',').map((t) => t.trim()).filter(Boolean),
          importance,
          memory_type: memoryType,
        };
        onUpdated(updated);
        setEditing(false);
      }
    } catch (err) {
      console.error('Failed to update memory:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    try {
      const res = await fetch('/api/memories', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'x-memory-endpoint': memoryEndpoint,
        },
        body: JSON.stringify({ memory_id: memory.id }),
      });
      if (res.ok) {
        onDeleted(memory.id);
      }
    } catch (err) {
      console.error('Failed to delete memory:', err);
    }
  };

  const tags = Array.isArray(memory.tags)
    ? memory.tags
    : typeof memory.tags === 'string'
      ? (memory.tags as string).split(',').map((t: string) => t.trim()).filter(Boolean)
      : [];

  const timestamp = new Date(memory.timestamp);

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold truncate flex-1">Memory Detail</h2>
        <div className="flex items-center gap-1">
          {!editing && (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditing(true)}>
              <Edit3 className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {/* Type badge + timestamp */}
          <div className="flex items-center justify-between">
            {editing ? (
              <select
                value={memoryType}
                onChange={(e) => setMemoryType(e.target.value as MemoryType)}
                className="text-xs px-2 py-1 rounded bg-muted border border-border"
              >
                {MEMORY_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            ) : (
              <span className={cn('text-xs font-medium px-2 py-0.5 rounded', TYPE_COLORS[memory.memory_type])}>
                {memory.memory_type}
              </span>
            )}
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {timestamp.toLocaleDateString()} {timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>

          {/* Title */}
          {editing ? (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Title</label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} className="text-sm" />
            </div>
          ) : (
            <h3 className="text-base font-medium">{memory.title}</h3>
          )}

          {/* Content */}
          {editing ? (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Content</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="w-full min-h-[200px] p-3 rounded-md bg-muted border border-border text-sm resize-y"
              />
            </div>
          ) : (
            <div className="text-sm text-muted-foreground whitespace-pre-wrap bg-muted/30 rounded-lg p-3">
              {memory.content}
            </div>
          )}

          {/* Tags */}
          {editing ? (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Tags (comma-separated)</label>
              <Input value={tagsStr} onChange={(e) => setTagsStr(e.target.value)} className="text-sm" placeholder="tag1, tag2, tag3" />
            </div>
          ) : tags.length > 0 ? (
            <div className="flex items-center gap-1.5 flex-wrap">
              <Tag className="h-3.5 w-3.5 text-muted-foreground" />
              {tags.map((tag, i) => (
                <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                  {tag}
                </span>
              ))}
            </div>
          ) : null}

          {/* Importance */}
          {editing ? (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Importance ({importance}/10)</label>
              <input
                type="range"
                min={1}
                max={10}
                value={importance}
                onChange={(e) => setImportance(parseInt(e.target.value))}
                className="w-full"
              />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Star className={cn('h-4 w-4', importance >= 7 ? 'text-amber-400 fill-amber-400' : 'text-muted-foreground')} />
              <span className="text-sm text-muted-foreground">Importance: {importance}/10</span>
            </div>
          )}

          {/* Metadata */}
          <div className="space-y-1 text-xs text-muted-foreground border-t border-border pt-3">
            <div className="flex items-center gap-1.5">
              <Hash className="h-3 w-3" />
              <span className="font-mono">{memory.id}</span>
            </div>
            {memory.relevance_score !== undefined && (
              <div>Relevance: {(memory.relevance_score * 100).toFixed(1)}%</div>
            )}
            {memory.match_type && (
              <div>Match type: {memory.match_type}</div>
            )}
          </div>

          {/* Edit actions */}
          {editing && (
            <div className="flex items-center gap-2 pt-2">
              <Button size="sm" onClick={handleSave} disabled={saving}>
                <Save className="h-3.5 w-3.5 mr-1" />
                {saving ? 'Saving...' : 'Save'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => {
                setEditing(false);
                setTitle(memory.title);
                setContent(memory.content);
                setTagsStr(Array.isArray(memory.tags) ? memory.tags.join(', ') : memory.tags || '');
                setImportance(memory.importance);
                setMemoryType(memory.memory_type);
              }}>
                Cancel
              </Button>
            </div>
          )}

          {/* Delete */}
          <div className="border-t border-border pt-3">
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                <span className="text-xs text-destructive">Delete this memory?</span>
                <Button size="sm" variant="destructive" onClick={handleDelete}>Yes, delete</Button>
                <Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button>
              </div>
            ) : (
              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                Delete memory
              </Button>
            )}
          </div>
        </div>
      </ScrollArea>
    </>
  );
}
