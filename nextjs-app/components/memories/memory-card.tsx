'use client';

import React from 'react';
import { Clock, Star, Tag } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Memory } from '@/lib/types';

const TYPE_COLORS: Record<string, string> = {
  conversation: 'bg-blue-500/15 text-blue-400',
  fact: 'bg-green-500/15 text-green-400',
  preference: 'bg-purple-500/15 text-purple-400',
  event: 'bg-amber-500/15 text-amber-400',
  task: 'bg-cyan-500/15 text-cyan-400',
  ephemeral: 'bg-gray-500/15 text-gray-400',
};

function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

interface MemoryCardProps {
  memory: Memory;
  selected?: boolean;
  onClick: () => void;
}

export function MemoryCard({ memory, selected, onClick }: MemoryCardProps) {
  const tags = Array.isArray(memory.tags)
    ? memory.tags
    : typeof memory.tags === 'string'
      ? (memory.tags as string).split(',').map((t: string) => t.trim()).filter(Boolean)
      : [];

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left p-4 rounded-lg border transition-all',
        'hover:border-primary/30 hover:bg-muted/30',
        selected
          ? 'border-primary/50 bg-primary/5 ring-1 ring-primary/20'
          : 'border-border bg-card'
      )}
    >
      {/* Header: type badge + time */}
      <div className="flex items-center justify-between mb-2">
        <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded', TYPE_COLORS[memory.memory_type] || TYPE_COLORS.ephemeral)}>
          {memory.memory_type}
        </span>
        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {formatRelativeTime(memory.timestamp)}
        </span>
      </div>

      {/* Title */}
      <h3 className="text-sm font-medium truncate mb-1">{memory.title}</h3>

      {/* Content preview */}
      <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
        {memory.content}
      </p>

      {/* Footer: tags + importance */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 flex-1 min-w-0 overflow-hidden">
          {tags.length > 0 && (
            <>
              <Tag className="h-3 w-3 text-muted-foreground flex-shrink-0" />
              <span className="text-[10px] text-muted-foreground truncate">
                {tags.slice(0, 3).join(', ')}
                {tags.length > 3 && ` +${tags.length - 3}`}
              </span>
            </>
          )}
        </div>
        {memory.importance > 0 && (
          <div className="flex items-center gap-0.5 flex-shrink-0 ml-2">
            <Star className={cn('h-3 w-3', memory.importance >= 7 ? 'text-amber-400 fill-amber-400' : 'text-muted-foreground')} />
            <span className="text-[10px] text-muted-foreground">{memory.importance}</span>
          </div>
        )}
      </div>

      {/* Relevance score if from search */}
      {memory.relevance_score !== undefined && memory.relevance_score > 0 && (
        <div className="mt-2 h-1 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-primary/60 rounded-full"
            style={{ width: `${Math.min(memory.relevance_score * 100, 100)}%` }}
          />
        </div>
      )}
    </button>
  );
}
