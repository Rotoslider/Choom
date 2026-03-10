'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Clock, Brain, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { Memory } from '@/lib/types';

const TYPE_COLORS: Record<string, string> = {
  conversation: 'text-blue-400',
  fact: 'text-green-400',
  preference: 'text-purple-400',
  event: 'text-amber-400',
  task: 'text-cyan-400',
  ephemeral: 'text-gray-400',
};

function formatRelativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function CommandPalette() {
  const router = useRouter();
  const settings = useAppStore((state) => state.settings);
  const memoryEndpoint = settings?.memory?.endpoint || 'http://localhost:8100';

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Memory[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Global keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        // Don't intercept if user is in a contenteditable or specific input
        const target = e.target as HTMLElement;
        if (target.getAttribute('contenteditable') === 'true') return;
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setQuery('');
      setResults([]);
      setSelectedIndex(0);
    }
  }, [open]);

  // Debounced search
  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      // Show recent memories when no query
      setLoading(true);
      try {
        const res = await fetch('/api/memories?action=recent&limit=8', {
          headers: { 'x-memory-endpoint': memoryEndpoint },
        });
        if (res.ok) {
          const data = await res.json();
          setResults(data.data || []);
        }
      } catch { /* ignore */ }
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/memories', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-memory-endpoint': memoryEndpoint,
        },
        body: JSON.stringify({ action: 'search', query: q, limit: 10 }),
      });
      if (res.ok) {
        const data = await res.json();
        setResults(data.data || []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [memoryEndpoint]);

  useEffect(() => {
    if (!open) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(query), 200);
    return () => clearTimeout(debounceRef.current);
  }, [query, open, doSearch]);

  const handleSelect = (memory: Memory) => {
    setOpen(false);
    router.push(`/memories?id=${memory.id}`);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      handleSelect(results[selectedIndex]);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />

      {/* Panel */}
      <div className="absolute top-[15%] left-1/2 -translate-x-1/2 w-full max-w-xl animate-in fade-in zoom-in-95 duration-150">
        <div className="bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
          {/* Search input */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
            <Search className="h-5 w-5 text-muted-foreground flex-shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
              onKeyDown={handleKeyDown}
              placeholder="Search memories..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd className="hidden sm:inline-flex text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5">
              ESC
            </kbd>
            <button onClick={() => setOpen(false)} className="sm:hidden text-muted-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Results */}
          <div className="max-h-[400px] overflow-y-auto">
            {loading && results.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Searching...
              </div>
            ) : results.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
                <Brain className="h-8 w-8 opacity-30" />
                {query ? 'No memories found' : 'Type to search your memories'}
              </div>
            ) : (
              <div className="py-1">
                {!query && (
                  <div className="px-4 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Recent Memories
                  </div>
                )}
                {results.map((memory, i) => (
                  <button
                    key={memory.id}
                    onClick={() => handleSelect(memory)}
                    onMouseEnter={() => setSelectedIndex(i)}
                    className={cn(
                      'w-full text-left px-4 py-2.5 flex items-start gap-3 transition-colors',
                      i === selectedIndex ? 'bg-primary/10' : 'hover:bg-muted/50'
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-medium truncate">{memory.title}</span>
                        <span className={cn('text-[10px] font-medium', TYPE_COLORS[memory.memory_type])}>
                          {memory.memory_type}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{memory.content}</p>
                    </div>
                    <span className="text-[10px] text-muted-foreground flex items-center gap-1 flex-shrink-0 mt-0.5">
                      <Clock className="h-3 w-3" />
                      {formatRelativeTime(memory.timestamp)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-border px-4 py-2 flex items-center justify-between text-[10px] text-muted-foreground">
            <div className="flex items-center gap-3">
              <span><kbd className="border border-border rounded px-1 py-0.5 mr-0.5">&#8593;&#8595;</kbd> navigate</span>
              <span><kbd className="border border-border rounded px-1 py-0.5 mr-0.5">&#9166;</kbd> open</span>
            </div>
            <span>{results.length} result{results.length !== 1 ? 's' : ''}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
