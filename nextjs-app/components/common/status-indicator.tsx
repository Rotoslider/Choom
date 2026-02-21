'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import type { ServiceStatus } from '@/lib/types';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface StatusIndicatorProps {
  status: ServiceStatus;
  label?: string;
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeClasses = {
  sm: 'w-2 h-2',
  md: 'w-2.5 h-2.5',
  lg: 'w-3 h-3',
};

const statusColors = {
  connected: 'bg-green-500',
  disconnected: 'bg-red-500',
  checking: 'bg-yellow-500 animate-pulse',
};

const statusLabels = {
  connected: 'Connected',
  disconnected: 'Disconnected',
  checking: 'Checking...',
};

export function StatusIndicator({
  status,
  label,
  showLabel = false,
  size = 'md',
  className,
}: StatusIndicatorProps) {
  const indicator = (
    <div className={cn('flex items-center gap-1.5', className)}>
      <div className={cn('rounded-full', sizeClasses[size], statusColors[status])} />
      {showLabel && (
        <span className="text-xs text-muted-foreground">
          {label || statusLabels[status]}
        </span>
      )}
    </div>
  );

  if (!showLabel && label) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{indicator}</TooltipTrigger>
          <TooltipContent>
            <p>
              {label}: {statusLabels[status]}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return indicator;
}
