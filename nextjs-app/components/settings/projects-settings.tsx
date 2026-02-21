'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { FolderOpen, Plus, RefreshCw, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppStore } from '@/lib/store';

interface ProjectMetadata {
  name: string;
  description?: string;
  created?: string;
  lastModified?: string;
  assignedChoom?: string;
  status: 'active' | 'paused' | 'complete';
  maxIterations?: number;
  llmProviderId?: string;
  llmModel?: string;
}

interface ProjectInfo {
  folder: string;
  metadata: ProjectMetadata;
  fileCount: number;
  totalSizeKB: number;
}

function formatSize(kb: number): string {
  if (kb < 1024) return `${kb} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function formatDate(iso?: string): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const statusColors: Record<string, string> = {
  active: 'bg-green-500/20 text-green-400 border-green-500/30',
  paused: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  complete: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
};

export function ProjectsSettings() {
  const providers = useAppStore((s) => s.settings.providers || []);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchProjects = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch('/api/projects');
      const data = await response.json();
      if (data.success) {
        setProjects(data.projects);
      }
    } catch (error) {
      console.error('Failed to fetch projects:', error);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  // Auto-refresh every 15s to pick up workspace activity
  useEffect(() => {
    const interval = setInterval(() => fetchProjects(true), 15000);
    return () => clearInterval(interval);
  }, [fetchProjects]);

  const createProject = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, description: newDescription }),
      });
      const data = await response.json();
      if (data.success) {
        setNewName('');
        setNewDescription('');
        setShowNewForm(false);
        await fetchProjects();
      }
    } catch (error) {
      console.error('Failed to create project:', error);
    } finally {
      setCreating(false);
    }
  };

  const deleteProject = async (folder: string) => {
    setDeleting(true);
    try {
      const response = await fetch(`/api/projects?folder=${encodeURIComponent(folder)}`, {
        method: 'DELETE',
      });
      const data = await response.json();
      if (data.success) {
        setDeleteConfirm(null);
        setExpandedProject(null);
        await fetchProjects();
      }
    } catch (error) {
      console.error('Failed to delete project:', error);
    } finally {
      setDeleting(false);
    }
  };

  const updateProject = async (folder: string, updates: Partial<ProjectMetadata>) => {
    try {
      await fetch('/api/projects', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, ...updates }),
      });
      await fetchProjects();
    } catch (error) {
      console.error('Failed to update project:', error);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium flex items-center gap-2">
            <FolderOpen className="h-4 w-4" />
            Project Management
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Manage workspace projects, status, and per-project iteration limits.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchProjects()}
            disabled={loading}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            size="sm"
            onClick={() => setShowNewForm(!showNewForm)}
          >
            <Plus className="h-4 w-4 mr-1" />
            New Project
          </Button>
        </div>
      </div>

      {/* New Project Form */}
      {showNewForm && (
        <div className="p-4 rounded-lg border border-border bg-card space-y-3">
          <div className="space-y-2">
            <label htmlFor="new-project-name" className="text-sm font-medium">Name</label>
            <Input
              id="new-project-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g., Solar Panel Research"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="new-project-desc" className="text-sm font-medium">Description</label>
            <Textarea
              id="new-project-desc"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="What is this project about?"
              rows={2}
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setShowNewForm(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={createProject} disabled={creating || !newName.trim()}>
              {creating ? 'Creating...' : 'Create'}
            </Button>
          </div>
        </div>
      )}

      {/* Projects List */}
      {loading && projects.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2" />
          Loading projects...
        </div>
      ) : projects.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <FolderOpen className="h-8 w-8 mx-auto mb-2 opacity-50" />
          No projects yet. Create one or ask a Choom to start a workspace task.
        </div>
      ) : (
        <div className="space-y-2">
          {projects.map((project) => {
            const isExpanded = expandedProject === project.folder;
            return (
              <div
                key={project.folder}
                className="rounded-lg border border-border bg-card overflow-hidden"
              >
                {/* Summary Row */}
                <button
                  className="w-full flex items-center gap-3 p-3 text-left hover:bg-muted/50 transition-colors"
                  onClick={() => setExpandedProject(isExpanded ? null : project.folder)}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  )}
                  <FolderOpen className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">{project.metadata.name}</span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full border ${
                          statusColors[project.metadata.status] || statusColors.active
                        }`}
                      >
                        {project.metadata.status}
                      </span>
                    </div>
                    {project.metadata.description && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {project.metadata.description}
                      </p>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0 text-xs text-muted-foreground space-y-0.5">
                    <div>{project.fileCount} file{project.fileCount !== 1 ? 's' : ''}</div>
                    <div>{formatSize(project.totalSizeKB)}</div>
                  </div>
                </button>

                {/* Expanded Details */}
                {isExpanded && (
                  <div className="p-4 border-t border-border space-y-4 bg-muted/20">
                    <div className="grid grid-cols-2 gap-4 text-xs">
                      <div>
                        <span className="text-muted-foreground">Folder:</span>{' '}
                        <span className="font-mono">{project.folder}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Last Activity:</span>{' '}
                        {formatDate(project.metadata.lastModified)}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Created:</span>{' '}
                        {formatDate(project.metadata.created)}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Assigned Choom:</span>{' '}
                        {project.metadata.assignedChoom || 'None'}
                      </div>
                    </div>

                    {/* Editable Fields */}
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <label className="text-xs font-medium">Description</label>
                        <Textarea
                          value={project.metadata.description || ''}
                          onChange={(e) =>
                            updateProject(project.folder, { description: e.target.value })
                          }
                          placeholder="Project description..."
                          rows={2}
                          className="text-sm"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                          <label className="text-xs font-medium">Status</label>
                          <Select
                            value={project.metadata.status}
                            onValueChange={(value: 'active' | 'paused' | 'complete') =>
                              updateProject(project.folder, { status: value })
                            }
                          >
                            <SelectTrigger className="text-sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="active">Active</SelectItem>
                              <SelectItem value="paused">Paused</SelectItem>
                              <SelectItem value="complete">Complete</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <label className="text-xs font-medium">Max Iterations</label>
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            value={project.metadata.maxIterations || ''}
                            onChange={(e) =>
                              updateProject(project.folder, {
                                maxIterations: e.target.value ? parseInt(e.target.value) : undefined,
                              })
                            }
                            placeholder="Default (15)"
                            className="text-sm"
                          />
                          <p className="text-xs text-muted-foreground">
                            0 or empty = use global default (15)
                          </p>
                        </div>
                      </div>

                      {/* LLM Provider Override */}
                      {providers.length > 0 && (
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-2">
                            <label className="text-xs font-medium">LLM Provider</label>
                            <Select
                              value={project.metadata.llmProviderId || '_default'}
                              onValueChange={(value) =>
                                updateProject(project.folder, {
                                  llmProviderId: value === '_default' ? undefined : value,
                                  llmModel: value === '_default' ? undefined : project.metadata.llmModel,
                                })
                              }
                            >
                              <SelectTrigger className="text-sm">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="_default">Default (use Choom setting)</SelectItem>
                                {providers.map((p) => (
                                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="space-y-2">
                            <label className="text-xs font-medium">Model</label>
                            {(() => {
                              const selectedProvider = providers.find(p => p.id === project.metadata.llmProviderId);
                              if (selectedProvider && selectedProvider.models.length > 0) {
                                return (
                                  <Select
                                    value={project.metadata.llmModel || '_default'}
                                    onValueChange={(value) =>
                                      updateProject(project.folder, {
                                        llmModel: value === '_default' ? undefined : value,
                                      })
                                    }
                                  >
                                    <SelectTrigger className="text-sm">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="_default">Default</SelectItem>
                                      {selectedProvider.models.map((m) => (
                                        <SelectItem key={m} value={m}>{m}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                );
                              }
                              return (
                                <Input
                                  value={project.metadata.llmModel || ''}
                                  onChange={(e) =>
                                    updateProject(project.folder, { llmModel: e.target.value || undefined })
                                  }
                                  placeholder={project.metadata.llmProviderId ? 'Model name' : 'Select provider first'}
                                  disabled={!project.metadata.llmProviderId}
                                  className="text-sm"
                                />
                              );
                            })()}
                          </div>
                        </div>
                      )}

                      {/* Delete Project */}
                      <div className="pt-3 border-t border-border/50">
                        {deleteConfirm === project.folder ? (
                          <div className="flex items-center gap-3 p-3 rounded-lg bg-destructive/10 border border-destructive/30">
                            <p className="text-sm text-destructive flex-1">
                              Delete &quot;{project.metadata.name}&quot; and all its files? This cannot be undone.
                            </p>
                            <div className="flex gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setDeleteConfirm(null)}
                                disabled={deleting}
                              >
                                Cancel
                              </Button>
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => deleteProject(project.folder)}
                                disabled={deleting}
                              >
                                {deleting ? 'Deleting...' : 'Delete'}
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:bg-destructive/10"
                            onClick={() => setDeleteConfirm(project.folder)}
                          >
                            <Trash2 className="h-4 w-4 mr-1" />
                            Delete Project
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
