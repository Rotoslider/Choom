'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  Blocks,
  Plus,
  RefreshCw,
  Search,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SkillCatalog, type SkillInfo } from '@/components/skills/skill-catalog';
import { SkillDetailPanel } from '@/components/skills/skill-detail-panel';
import { SkillCreator } from '@/components/skills/skill-creator';
import { cn } from '@/lib/utils';

type FilterType = 'all' | 'core' | 'custom' | 'external';

export default function SkillsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [editSkillName, setEditSkillName] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Handle ?edit= query parameter
  useEffect(() => {
    const editParam = searchParams.get('edit');
    if (editParam) {
      setEditSkillName(editParam);
      setCreatorOpen(true);
      // Clear the query param from URL without navigation
      router.replace('/skills', { scroll: false });
    }
  }, [searchParams, router]);
  const [filterType, setFilterType] = useState<FilterType>('all');

  const fetchSkills = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/skills');
      if (res.ok) {
        const data = await res.json();
        setSkills(Array.isArray(data) ? data : data.skills || []);
      }
    } catch (err) {
      console.error('Failed to fetch skills:', err);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const handleReload = async () => {
    setReloading(true);
    try {
      await fetch('/api/skills/reload', { method: 'POST' });
      await fetchSkills();
    } catch (err) {
      console.error('Failed to reload skills:', err);
    } finally {
      setReloading(false);
    }
  };

  const handleToggle = async (name: string, enabled: boolean) => {
    // Optimistic update
    setSkills((prev) =>
      prev.map((s) => (s.name === name ? { ...s, enabled } : s))
    );

    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        // Revert on failure
        setSkills((prev) =>
          prev.map((s) => (s.name === name ? { ...s, enabled: !enabled } : s))
        );
      }
    } catch {
      // Revert on error
      setSkills((prev) =>
        prev.map((s) => (s.name === name ? { ...s, enabled: !enabled } : s))
      );
    }
  };

  const handleSelect = (name: string) => {
    setSelectedSkill((prev) => (prev === name ? null : name));
  };

  const handleDetailClose = () => {
    setSelectedSkill(null);
  };

  const handleCreated = () => {
    fetchSkills();
  };

  // Filter and search
  const filteredSkills = skills.filter((skill) => {
    if (filterType !== 'all' && skill.type !== filterType) return false;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      return (
        skill.name.toLowerCase().includes(query) ||
        skill.description.toLowerCase().includes(query) ||
        skill.tools.some((t) => t.toLowerCase().includes(query))
      );
    }
    return true;
  });

  // Stats
  const coreCount = skills.filter((s) => s.type === 'core').length;
  const customCount = skills.filter((s) => s.type === 'custom').length;
  const externalCount = skills.filter((s) => s.type === 'external').length;
  const enabledCount = skills.filter((s) => s.enabled).length;
  const totalTools = skills.reduce((sum, s) => sum + s.toolCount, 0);

  const filterButtons: { id: FilterType; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: skills.length },
    { id: 'core', label: 'Core', count: coreCount },
    { id: 'custom', label: 'Custom', count: customCount },
    { id: 'external', label: 'External', count: externalCount },
  ];

  return (
    <div className="min-h-screen bg-background flex">
      {/* Main content area */}
      <div className={cn('flex-1 flex flex-col min-h-screen', selectedSkill && 'lg:mr-[420px]')}>
        {/* Header */}
        <header className="border-b border-border bg-card px-6 py-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push('/')}
                className="-ml-2"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <div>
                <h1 className="text-lg font-semibold flex items-center gap-2">
                  <Blocks className="h-5 w-5" />
                  Skills
                </h1>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {enabledCount} of {skills.length} skills enabled / {totalTools} total tools
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleReload}
                disabled={reloading}
              >
                <RefreshCw className={cn('h-4 w-4', reloading && 'animate-spin')} />
              </Button>
              <Button size="sm" onClick={() => setCreatorOpen(true)}>
                <Plus className="h-4 w-4 mr-1" />
                Create Skill
              </Button>
            </div>
          </div>

          {/* Search + filter bar */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search skills or tools..."
                className="pl-9 h-8 text-sm"
              />
            </div>

            <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
              {filterButtons.map((fb) => (
                <button
                  key={fb.id}
                  onClick={() => setFilterType(fb.id)}
                  className={cn(
                    'px-2.5 py-1 text-xs font-medium rounded-md transition-colors',
                    filterType === fb.id
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  )}
                >
                  {fb.label}
                  <span className="ml-1 opacity-60">{fb.count}</span>
                </button>
              ))}
            </div>
          </div>
        </header>

        {/* Skills grid */}
        <ScrollArea className="flex-1">
          <div className="p-6">
            {loading ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin mr-2" />
                Loading skills...
              </div>
            ) : (
              <SkillCatalog
                skills={filteredSkills}
                selectedSkill={selectedSkill}
                onSelect={handleSelect}
                onToggle={handleToggle}
              />
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Detail panel (right side) */}
      {selectedSkill && (
        <aside className="fixed right-0 top-0 bottom-0 w-[420px] border-l border-border bg-card z-10 hidden lg:flex flex-col">
          <SkillDetailPanel
            skillName={selectedSkill}
            onClose={handleDetailClose}
          />
        </aside>
      )}

      {/* Detail panel (overlay on small screens) */}
      {selectedSkill && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={handleDetailClose}
          />
          <aside className="absolute right-0 top-0 bottom-0 w-full max-w-md bg-card border-l border-border flex flex-col animate-in slide-in-from-right">
            <SkillDetailPanel
              skillName={selectedSkill}
              onClose={handleDetailClose}
            />
          </aside>
        </div>
      )}

      {/* Creator dialog */}
      <SkillCreator
        open={creatorOpen}
        onOpenChange={(v) => { setCreatorOpen(v); if (!v) setEditSkillName(null); }}
        onCreated={handleCreated}
        editSkillName={editSkillName}
      />
    </div>
  );
}
