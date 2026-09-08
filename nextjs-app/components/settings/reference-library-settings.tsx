'use client';

import React, { useCallback, useEffect, useState } from 'react';
import NextImage from 'next/image';
import { Plus, Trash2, ImagePlus, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

const CATEGORIES = ['character', 'person', 'place', 'object', 'style'] as const;
type Category = (typeof CATEGORIES)[number];

const KINDS = ['sheet', 'face', 'extra'] as const;

interface LibraryImage {
  id: string;
  file: string;
  kind: string;
  label: string | null;
  enabled: boolean;
  order: number;
}

interface LibrarySubject {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string;
  choomId: string | null;
  enabled: boolean;
  images: LibraryImage[];
}

interface ChoomOption {
  id: string;
  name: string;
}

/**
 * The shared reference library: subjects a Choom can name in an image request.
 * Every Choom can name every subject — that is what makes "Genesis with her
 * sister Eve camping" work, since Genesis needs Eve's sheet.
 */
export function ReferenceLibrarySettings() {
  const [subjects, setSubjects] = useState<LibrarySubject[]>([]);
  const [chooms, setChooms] = useState<ChoomOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState<Category>('character');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [libRes, choomRes] = await Promise.all([
        fetch('/api/reference-library'),
        fetch('/api/chooms'),
      ]);
      if (libRes.ok) setSubjects((await libRes.json()).subjects || []);
      if (choomRes.ok) {
        const data = await choomRes.json();
        const list = Array.isArray(data) ? data : data.chooms || [];
        setChooms(list.map((c: ChoomOption) => ({ id: c.id, name: c.name })));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reference library');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const createSubject = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    try {
      const res = await fetch('/api/reference-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, category: newCategory }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create reference');
      setSubjects(prev => [...prev, data.subject]);
      setNewName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create reference');
    }
  }, [newName, newCategory]);

  const patchSubject = useCallback(async (id: string, updates: Partial<LibrarySubject>) => {
    // Optimistic: these are all small text/toggle edits.
    setSubjects(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));
    await fetch(`/api/reference-library/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    }).catch(() => {});
  }, []);

  const deleteSubject = useCallback(async (id: string) => {
    setSubjects(prev => prev.filter(s => s.id !== id));
    await fetch(`/api/reference-library/${id}`, { method: 'DELETE' }).catch(() => {});
  }, []);

  const uploadImage = useCallback(async (subjectId: string, file: File, kind: string) => {
    setBusyId(subjectId);
    setError(null);
    try {
      const body = new FormData();
      body.append('file', file);
      body.append('kind', kind);
      const res = await fetch(`/api/reference-library/${subjectId}/images`, { method: 'POST', body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setSubjects(prev => prev.map(s =>
        s.id === subjectId
          ? { ...s, images: [...s.images, data.image].sort((a, b) => a.order - b.order) }
          : s
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusyId(null);
    }
  }, []);

  const deleteImage = useCallback(async (subjectId: string, imageId: string) => {
    setSubjects(prev => prev.map(s =>
      s.id === subjectId ? { ...s, images: s.images.filter(i => i.id !== imageId) } : s
    ));
    await fetch(`/api/reference-library/${subjectId}/images/${imageId}`, { method: 'DELETE' }).catch(() => {});
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">Reference Library</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Named subjects any Choom can call when generating an image — characters, people,
            places, vehicles. Naming a subject sends all of its images, sheet first.
            Needs an edit-capable checkpoint (Flux.2 Klein, Flux.1 Kontext, Qwen-Image-Edit).
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </Button>
      </div>

      {error && (
        <p className="text-xs text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3" /> {error}
        </p>
      )}

      {/* Add a subject */}
      <div className="flex items-center gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') createSubject(); }}
          placeholder="New reference name, e.g. Cabin exterior"
          className="flex-1"
        />
        <Select value={newCategory} onValueChange={(v) => setNewCategory(v as Category)}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button onClick={createSubject} disabled={!newName.trim()}>
          <Plus className="h-4 w-4 mr-1" /> Add
        </Button>
      </div>

      {subjects.length === 0 && !loading && (
        <p className="text-xs text-muted-foreground p-3 rounded-lg bg-muted/30">
          No references yet. Add one, then upload a character sheet and a face closeup for it.
        </p>
      )}

      {subjects.map((subject) => (
        <div
          key={subject.id}
          className={cn(
            'rounded-lg border p-3 space-y-3 transition-opacity',
            !subject.enabled && 'opacity-50'
          )}
        >
          <div className="flex items-start gap-2">
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <Input
                  value={subject.name}
                  onChange={(e) => patchSubject(subject.id, { name: e.target.value })}
                  className="h-8 flex-1"
                />
                <code className="text-[11px] px-2 py-1 rounded bg-muted text-muted-foreground shrink-0">
                  {subject.slug}
                </code>
              </div>
              <Textarea
                value={subject.description || ''}
                onChange={(e) => patchSubject(subject.id, { description: e.target.value })}
                placeholder="What this shows — the Choom reads this to decide when to use it"
                rows={2}
                className="text-xs resize-none"
              />
              <div className="flex items-center gap-2">
                <Select
                  value={subject.category}
                  onValueChange={(v) => patchSubject(subject.id, { category: v })}
                >
                  <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select
                  value={subject.choomId || '__none__'}
                  onValueChange={(v) => patchSubject(subject.id, { choomId: v === '__none__' ? null : v })}
                >
                  <SelectTrigger className="h-8 flex-1 text-xs">
                    <SelectValue placeholder="Not a Choom" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Not a Choom</SelectItem>
                    {chooms.map(c => <SelectItem key={c.id} value={c.id}>This is {c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Switch
                  checked={subject.enabled}
                  onCheckedChange={(checked) => patchSubject(subject.id, { enabled: checked })}
                />
                <Button variant="ghost" size="sm" onClick={() => deleteSubject(subject.id)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
              {subject.choomId && (
                <p className="text-[11px] text-muted-foreground">
                  Attached automatically to this Choom&apos;s self-portraits.
                </p>
              )}
            </div>
          </div>

          <Separator />

          <div className="flex items-center gap-2 flex-wrap">
            {subject.images.map((image) => (
              <div key={image.id} className="relative w-20">
                <div className="relative w-20 h-20 rounded-md overflow-hidden border bg-muted">
                  <NextImage
                    src={`/api/reference-library/${subject.id}/images/${image.id}`}
                    alt={image.label || image.kind}
                    fill
                    unoptimized
                    className="object-cover"
                  />
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  className="absolute -top-1 -right-1 h-5 w-5 p-0 rounded-full"
                  onClick={() => deleteImage(subject.id, image.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
                <p className="text-[10px] text-center text-muted-foreground mt-0.5">{image.kind}</p>
              </div>
            ))}

            {KINDS.map((kind) => (
              <React.Fragment key={kind}>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  id={`lib-${subject.id}-${kind}`}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) uploadImage(subject.id, file, kind);
                    e.target.value = '';
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyId === subject.id}
                  onClick={() => document.getElementById(`lib-${subject.id}-${kind}`)?.click()}
                >
                  {busyId === subject.id
                    ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    : <ImagePlus className="h-3 w-3 mr-1" />}
                  {kind}
                </Button>
              </React.Fragment>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
