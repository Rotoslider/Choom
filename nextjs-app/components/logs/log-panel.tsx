'use client';

import React, { useState, useEffect } from 'react';
import {
  X,
  Trash2,
  Filter,
  ChevronDown,
  ChevronRight,
  Search,
  Clock,
  Cpu,
  Volume2,
  Mic,
  Image as ImageIcon,
  Brain,
  Bot,
  Settings,
  AlertCircle,
  CheckCircle,
  Info,
  AlertTriangle,
  Copy,
  Check,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useLogStore, useFilteredLogs } from '@/lib/log-store';
import type { LogEntry, LogCategory, LogLevel } from '@/lib/types';

const categoryIcons: Record<LogCategory, React.ReactNode> = {
  llm: <Cpu className="h-4 w-4" />,
  tts: <Volume2 className="h-4 w-4" />,
  stt: <Mic className="h-4 w-4" />,
  image: <ImageIcon className="h-4 w-4" />,
  memory: <Brain className="h-4 w-4" />,
  agent: <Bot className="h-4 w-4" />,
  system: <Settings className="h-4 w-4" />,
};

const categoryColors: Record<LogCategory, string> = {
  llm: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  tts: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  stt: 'bg-green-500/20 text-green-400 border-green-500/30',
  image: 'bg-pink-500/20 text-pink-400 border-pink-500/30',
  memory: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  agent: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  system: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
};

const levelIcons: Record<LogLevel, React.ReactNode> = {
  info: <Info className="h-3.5 w-3.5 text-blue-400" />,
  success: <CheckCircle className="h-3.5 w-3.5 text-green-400" />,
  warning: <AlertTriangle className="h-3.5 w-3.5 text-yellow-400" />,
  error: <AlertCircle className="h-3.5 w-3.5 text-red-400" />,
};

const levelColors: Record<LogLevel, string> = {
  info: 'border-l-blue-400',
  success: 'border-l-green-400',
  warning: 'border-l-yellow-400',
  error: 'border-l-red-400',
};

// Helper to render detail value nicely
function DetailValue({ label, value }: { label: string; value: unknown }) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = () => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Skip rendering certain metadata fields
  if (['textLength', 'charCount', 'bytes'].includes(label)) {
    return null;
  }

  const isLongText = typeof value === 'string' && value.length > 100;
  const displayValue = typeof value === 'string' ? value : JSON.stringify(value, null, 2);

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-muted-foreground uppercase">{label}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={copyToClipboard}
        >
          {copied ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <div
        className={cn(
          'p-3 bg-muted/50 rounded text-sm whitespace-pre-wrap break-words font-mono',
          isLongText && 'max-h-64 overflow-y-auto'
        )}
      >
        {displayValue}
      </div>
    </div>
  );
}

interface LogEntryItemProps {
  entry: LogEntry;
}

function LogEntryItem({ entry }: LogEntryItemProps) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = entry.details != null && typeof entry.details === 'object' && Object.keys(entry.details).length > 0;

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  };

  // Get the important text fields to display prominently
  const getTextFields = () => {
    if (!entry.details) return [];
    const textKeys = ['userMessage', 'fullResponse', 'fullText', 'fullPrompt', 'result', 'arguments'];
    return textKeys
      .filter((key) => key in entry.details!)
      .map((key) => ({ key, value: entry.details![key] }));
  };

  const textFields = getTextFields();
  const otherDetails = entry.details
    ? Object.fromEntries(
        Object.entries(entry.details).filter(
          ([key]) => !['userMessage', 'fullResponse', 'fullText', 'fullPrompt', 'result', 'arguments', 'textLength', 'charCount', 'bytes'].includes(key)
        )
      )
    : {};
  const hasOtherDetails = Object.keys(otherDetails).length > 0;

  return (
    <div
      className={cn(
        'border-l-2 pl-3 py-2 hover:bg-muted/30 transition-colors',
        levelColors[entry.level]
      )}
    >
      <div className="flex items-start gap-2">
        {/* Expand button if has details */}
        {hasDetails ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-0.5 text-muted-foreground hover:text-foreground flex-shrink-0"
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        ) : (
          <div className="w-4 flex-shrink-0" />
        )}

        {/* Level icon */}
        <div className="mt-0.5 flex-shrink-0">{levelIcons[entry.level]}</div>

        {/* Content */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Category badge */}
            <Badge
              variant="outline"
              className={cn('text-xs px-1.5 py-0 h-5 flex-shrink-0', categoryColors[entry.category])}
            >
              <span className="mr-1">{categoryIcons[entry.category]}</span>
              {entry.category.toUpperCase()}
            </Badge>

            {/* Title */}
            <span className="font-medium text-sm">{entry.title}</span>

            {/* Duration if present */}
            {entry.duration && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {(entry.duration / 1000).toFixed(2)}s
              </span>
            )}
          </div>

          {/* Message */}
          <p className="text-sm text-muted-foreground mt-0.5 break-words">
            {entry.message}
          </p>

          {/* Expanded details */}
          {expanded && hasDetails && (
            <div className="mt-3 space-y-3">
              {/* Text fields shown prominently */}
              {textFields.map(({ key, value }) => (
                <DetailValue key={key} label={key} value={value} />
              ))}

              {/* Other details as JSON */}
              {hasOtherDetails && (
                <div className="mt-2">
                  <span className="text-xs font-medium text-muted-foreground uppercase block mb-1">
                    Other Details
                  </span>
                  <pre className="p-3 bg-muted/50 rounded text-xs whitespace-pre-wrap break-words font-mono">
                    {JSON.stringify(otherDetails, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Timestamp */}
        <span className="text-xs text-muted-foreground whitespace-nowrap flex-shrink-0">
          {formatTime(entry.timestamp)}
        </span>
      </div>
    </div>
  );
}

interface LogPanelProps {
  onClose: () => void;
}

export function LogPanel({ onClose }: LogPanelProps) {
  const { filter, setFilter, clearLogs, resetFilter } = useLogStore();
  const filteredLogs = useFilteredLogs();
  const [showFilters, setShowFilters] = useState(false);

  // Prevent body scroll when panel is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  const categories: LogCategory[] = ['llm', 'tts', 'stt', 'image', 'memory', 'agent', 'system'];
  const levels: LogLevel[] = ['info', 'success', 'warning', 'error'];

  const toggleCategory = (category: LogCategory) => {
    const current = filter.categories;
    if (current.includes(category)) {
      setFilter({ categories: current.filter((c) => c !== category) });
    } else {
      setFilter({ categories: [...current, category] });
    }
  };

  const toggleLevel = (level: LogLevel) => {
    const current = filter.levels;
    if (current.includes(level)) {
      setFilter({ levels: current.filter((l) => l !== level) });
    } else {
      setFilter({ levels: [...current, level] });
    }
  };

  const hasActiveFilters =
    filter.categories.length > 0 || filter.levels.length > 0 || filter.search.length > 0;

  // Handle click on backdrop to close
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div
        className="fixed inset-y-0 right-0 w-full max-w-2xl bg-card border-l border-border shadow-xl flex flex-col"
        style={{ overscrollBehavior: 'contain' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold">Activity Log</h2>
            <Badge variant="secondary" className="text-xs">
              {filteredLogs.length} entries
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowFilters(!showFilters)}
              className={cn(hasActiveFilters && 'text-primary')}
            >
              <Filter className="h-4 w-4 mr-1" />
              Filter
            </Button>
            <Button variant="ghost" size="sm" onClick={clearLogs}>
              <Trash2 className="h-4 w-4 mr-1" />
              Clear
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {/* Filters */}
        {showFilters && (
          <div className="px-4 py-3 border-b border-border space-y-3 bg-muted/30 flex-shrink-0">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search logs..."
                value={filter.search}
                onChange={(e) => setFilter({ search: e.target.value })}
                className="pl-9"
              />
            </div>

            {/* Category filters */}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Categories
              </label>
              <div className="flex flex-wrap gap-1.5">
                {categories.map((category) => (
                  <button
                    key={category}
                    onClick={() => toggleCategory(category)}
                    className={cn(
                      'px-2 py-1 rounded text-xs font-medium border transition-colors flex items-center gap-1',
                      filter.categories.includes(category)
                        ? categoryColors[category]
                        : 'border-border text-muted-foreground hover:border-muted-foreground'
                    )}
                  >
                    {categoryIcons[category]}
                    {category.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {/* Level filters */}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Levels
              </label>
              <div className="flex flex-wrap gap-1.5">
                {levels.map((level) => (
                  <button
                    key={level}
                    onClick={() => toggleLevel(level)}
                    className={cn(
                      'px-2 py-1 rounded text-xs font-medium border transition-colors flex items-center gap-1',
                      filter.levels.includes(level)
                        ? 'border-primary bg-primary/20 text-primary'
                        : 'border-border text-muted-foreground hover:border-muted-foreground'
                    )}
                  >
                    {levelIcons[level]}
                    {level}
                  </button>
                ))}
              </div>
            </div>

            {/* Reset filters */}
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={resetFilter} className="text-xs">
                Reset filters
              </Button>
            )}
          </div>
        )}

        {/* Log entries - scrollable area */}
        <div
          className="flex-1 overflow-y-auto"
          style={{ overscrollBehavior: 'contain' }}
        >
          <div className="divide-y divide-border/50">
            {filteredLogs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Info className="h-8 w-8 mb-2" />
                <p className="text-sm">No log entries yet</p>
                <p className="text-xs">Activity will appear here as you use the app</p>
              </div>
            ) : (
              filteredLogs.map((entry) => <LogEntryItem key={entry.id} entry={entry} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
