'use client';

import React from 'react';
import { FileText } from 'lucide-react';

interface FileReferenceProps {
  path: string;
  action?: 'created' | 'read' | 'deleted';
}

export function FileReference({ path, action = 'created' }: FileReferenceProps) {
  const actionLabel = action === 'created' ? 'Created' : action === 'read' ? 'Read' : 'Deleted';

  return (
    <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50 border border-border text-xs text-muted-foreground my-1">
      <FileText className="w-3 h-3 flex-shrink-0" />
      <span className="font-medium">{actionLabel}:</span>
      <span className="truncate max-w-[200px]">{path}</span>
    </div>
  );
}
