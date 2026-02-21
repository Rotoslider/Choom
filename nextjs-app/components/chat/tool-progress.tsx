'use client';

import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import type { ToolCall } from '@/lib/types';

interface ToolStep {
  toolCall: ToolCall;
  result?: unknown;
  status: 'running' | 'success' | 'error';
}

interface ToolProgressProps {
  iteration: number;
  maxIterations: number;
  steps: ToolStep[];
  isActive: boolean;
}

export function ToolProgress({ iteration, maxIterations, steps, isActive }: ToolProgressProps) {
  const [expanded, setExpanded] = useState(true);

  if (steps.length === 0 && !isActive) return null;

  return (
    <div className="my-2 border border-border rounded-lg bg-card/50 text-xs overflow-hidden">
      {/* Header */}
      <button
        className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          {isActive ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
          ) : (
            <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
          )}
          <span className="text-muted-foreground font-medium">
            {isActive ? `Agent Step ${iteration}/${maxIterations}` : `Completed in ${iteration} step${iteration > 1 ? 's' : ''}`}
          </span>
          <span className="text-muted-foreground/60">
            ({steps.length} tool call{steps.length !== 1 ? 's' : ''})
          </span>
        </div>
        {expanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
        )}
      </button>

      {/* Step list */}
      {expanded && steps.length > 0 && (
        <div className="border-t border-border px-3 py-1.5 space-y-1">
          {steps.map((step, i) => (
            <div key={`${step.toolCall.id}-${i}`} className="flex items-center gap-2">
              {step.status === 'running' ? (
                <Loader2 className="w-3 h-3 animate-spin text-primary flex-shrink-0" />
              ) : step.status === 'success' ? (
                <CheckCircle2 className="w-3 h-3 text-green-500 flex-shrink-0" />
              ) : (
                <XCircle className="w-3 h-3 text-red-500 flex-shrink-0" />
              )}
              <span className="text-muted-foreground truncate">
                {step.toolCall.name}
                {step.toolCall.arguments && Object.keys(step.toolCall.arguments).length > 0 && (
                  <span className="text-muted-foreground/50 ml-1">
                    ({Object.entries(step.toolCall.arguments)
                      .filter(([, v]) => v !== undefined && v !== null)
                      .map(([k, v]) => `${k}: ${String(v).slice(0, 30)}`)
                      .join(', ')})
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
