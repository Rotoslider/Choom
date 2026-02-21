'use client';

import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  CheckCircle2,
  XCircle,
  SkipForward,
  RotateCcw,
  ListChecks,
  AlertCircle,
} from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

export interface PlanStepProgress {
  id: string;
  description: string;
  toolName: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'rolled_back';
  result?: string;
  statusDescription?: string;
}

export interface PlanProgress {
  goal: string;
  steps: PlanStepProgress[];
  isActive: boolean;
  summary?: string;
  succeeded?: number;
  failed?: number;
  total?: number;
}

// ============================================================================
// Component
// ============================================================================

interface PlanDisplayProps {
  plan: PlanProgress;
}

export function PlanDisplay({ plan }: PlanDisplayProps) {
  const [expanded, setExpanded] = useState(true);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());

  const completedCount = plan.steps.filter(s => s.status === 'completed').length;
  const totalCount = plan.steps.length;

  const toggleStep = (stepId: string) => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(stepId)) {
        next.delete(stepId);
      } else {
        next.add(stepId);
      }
      return next;
    });
  };

  const getStatusIcon = (status: PlanStepProgress['status']) => {
    switch (status) {
      case 'pending':
        return <div className="w-3 h-3 rounded-full border border-muted-foreground/40 flex-shrink-0" />;
      case 'running':
        return <Loader2 className="w-3.5 h-3.5 animate-spin text-primary flex-shrink-0" />;
      case 'completed':
        return <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />;
      case 'failed':
        return <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />;
      case 'skipped':
        return <SkipForward className="w-3.5 h-3.5 text-yellow-500 flex-shrink-0" />;
      case 'rolled_back':
        return <RotateCcw className="w-3.5 h-3.5 text-orange-500 flex-shrink-0" />;
    }
  };

  const getStatusColor = (status: PlanStepProgress['status']) => {
    switch (status) {
      case 'pending': return 'text-muted-foreground/60';
      case 'running': return 'text-primary';
      case 'completed': return 'text-green-500';
      case 'failed': return 'text-red-500';
      case 'skipped': return 'text-yellow-500';
      case 'rolled_back': return 'text-orange-500';
    }
  };

  // Progress bar percentage
  const progressPct = totalCount > 0
    ? Math.round((plan.steps.filter(s => s.status !== 'pending' && s.status !== 'running').length / totalCount) * 100)
    : 0;

  return (
    <div className="my-2 border border-border rounded-lg bg-card/50 text-xs overflow-hidden">
      {/* Header */}
      <button
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 min-w-0">
          {plan.isActive ? (
            <ListChecks className="w-4 h-4 text-primary flex-shrink-0" />
          ) : plan.summary?.includes('abort') ? (
            <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
          )}
          <span className="font-medium truncate">{plan.goal}</span>
          <span className="text-muted-foreground/60 flex-shrink-0">
            ({completedCount}/{totalCount})
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {plan.isActive && (
            <div className="w-16 h-1 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          )}
          {expanded ? (
            <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Step list */}
      {expanded && (
        <div className="border-t border-border">
          {plan.steps.map((step, i) => (
            <div key={step.id} className="border-b border-border/50 last:border-b-0">
              {/* Step row */}
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted/20 transition-colors text-left"
                onClick={() => step.result && toggleStep(step.id)}
              >
                {getStatusIcon(step.status)}
                <span className="text-muted-foreground/50 w-4 text-right flex-shrink-0">
                  {i + 1}.
                </span>
                <span className={`truncate ${step.status === 'pending' ? 'text-muted-foreground/60' : 'text-foreground'}`}>
                  {step.description}
                </span>
                <span className="text-muted-foreground/40 ml-auto flex-shrink-0 text-[10px]">
                  {step.toolName}
                </span>
                {step.statusDescription && (
                  <span className={`text-[10px] ml-1 flex-shrink-0 ${getStatusColor(step.status)}`}>
                    {step.statusDescription}
                  </span>
                )}
              </button>

              {/* Expanded result */}
              {expandedSteps.has(step.id) && step.result && (
                <div className="px-3 pb-1.5 pl-10">
                  <pre className="text-[10px] text-muted-foreground/70 whitespace-pre-wrap break-all bg-muted/20 rounded p-1.5 max-h-24 overflow-auto">
                    {step.result}
                  </pre>
                </div>
              )}
            </div>
          ))}

          {/* Summary footer */}
          {plan.summary && !plan.isActive && (
            <div className="px-3 py-1.5 bg-muted/20 text-muted-foreground">
              {plan.summary}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
