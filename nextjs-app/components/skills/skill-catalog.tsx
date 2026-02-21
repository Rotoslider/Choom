'use client';

import React from 'react';
import { Blocks, Wrench } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export interface SkillInfo {
  name: string;
  description: string;
  version: string;
  author: string;
  type: 'core' | 'custom' | 'external';
  enabled: boolean;
  toolCount: number;
  tools: string[];
}

const typeBadgeColors: Record<string, string> = {
  core: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  custom: 'bg-green-500/20 text-green-400 border-green-500/30',
  external: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
};

interface SkillCatalogProps {
  skills: SkillInfo[];
  selectedSkill: string | null;
  onSelect: (name: string) => void;
  onToggle: (name: string, enabled: boolean) => void;
}

export function SkillCatalog({ skills, selectedSkill, onSelect, onToggle }: SkillCatalogProps) {
  if (skills.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Blocks className="h-10 w-10 mx-auto mb-3 opacity-40" />
        <p className="text-sm">No skills found.</p>
        <p className="text-xs mt-1">Create a custom skill or install an external one.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
      {skills.map((skill) => (
        <div
          key={skill.name}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(skill.name)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(skill.name); } }}
          className={cn(
            'text-left rounded-lg border bg-card p-4 transition-all duration-150 hover:bg-muted/50 cursor-pointer',
            selectedSkill === skill.name
              ? 'border-primary ring-1 ring-primary/30'
              : 'border-border hover:border-muted-foreground/30'
          )}
        >
          {/* Top row: name + type badge */}
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <Blocks className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <span className="font-medium text-sm truncate">{skill.name}</span>
            </div>
            <Badge
              variant="outline"
              className={cn('text-[10px] px-1.5 py-0 flex-shrink-0', typeBadgeColors[skill.type])}
            >
              {skill.type}
            </Badge>
          </div>

          {/* Description */}
          <p className="text-xs text-muted-foreground line-clamp-2 mb-3 min-h-[2rem]">
            {skill.description || 'No description'}
          </p>

          {/* Bottom row: tool count + toggle */}
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Wrench className="h-3 w-3" />
              {skill.toolCount} tool{skill.toolCount !== 1 ? 's' : ''}
            </span>
            <div
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              <Switch
                checked={skill.enabled}
                onCheckedChange={(checked) => onToggle(skill.name, checked)}
                aria-label={`Toggle ${skill.name}`}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
