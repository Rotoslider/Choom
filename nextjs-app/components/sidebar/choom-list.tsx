'use client';

import React from 'react';
import { Plus, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AvatarDisplay } from '@/components/common/avatar-display';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { Choom } from '@/lib/types';

interface ChoomListProps {
  chooms: Choom[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreateNew: () => void;
  onEdit?: (choom: Choom) => void;
}

export function ChoomList({
  chooms,
  selectedId,
  onSelect,
  onCreateNew,
  onEdit,
}: ChoomListProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Chooms
        </h3>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onCreateNew}
              className="h-7 w-7 hover:bg-primary/10 hover:text-primary"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Create new Choom</TooltipContent>
        </Tooltip>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {chooms.length === 0 ? (
            <div className="px-3 py-6 text-center">
              <p className="text-sm text-muted-foreground mb-3">
                No Chooms yet
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={onCreateNew}
                className="gap-1"
              >
                <Plus className="h-4 w-4" />
                Create your first Choom
              </Button>
            </div>
          ) : (
            chooms.map((choom) => (
              <div
                key={choom.id}
                className={cn(
                  'group relative w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200',
                  'hover:bg-muted/50',
                  selectedId === choom.id &&
                    'bg-primary/10 border border-primary/30 shadow-glow-sm'
                )}
              >
                <button
                  onClick={() => onSelect(choom.id)}
                  className="flex items-center gap-3 flex-1 min-w-0 text-left"
                >
                  <AvatarDisplay
                    name={choom.name}
                    avatarUrl={choom.avatarUrl}
                    size="sm"
                    showGlow={selectedId === choom.id}
                  />
                  <div className="flex-1 min-w-0">
                    <p
                      className={cn(
                        'text-sm font-medium truncate',
                        selectedId === choom.id && 'text-primary'
                      )}
                    >
                      {choom.name}
                    </p>
                    {choom.description && (
                      <p className="text-xs text-muted-foreground line-clamp-2" title={choom.description}>
                        {choom.description}
                      </p>
                    )}
                  </div>
                </button>

                {/* Edit button - visible on hover or when selected */}
                {onEdit && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEdit(choom);
                        }}
                        className={cn(
                          'h-7 w-7 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity',
                          'hover:bg-primary/10 hover:text-primary',
                          selectedId === choom.id && 'opacity-100'
                        )}
                      >
                        <Settings2 className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Edit Choom settings</TooltipContent>
                  </Tooltip>
                )}
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
