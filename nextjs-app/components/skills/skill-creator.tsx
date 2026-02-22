'use client';

import React, { useState, useCallback, useRef } from 'react';
import {
  Plus,
  Trash2,
  Loader2,
  Wrench,
  AlertCircle,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface ParamDef {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

interface ToolDef {
  name: string;
  description: string;
  params: ParamDef[];
}

interface SkillCreatorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  /** If set, opens in edit mode with pre-filled data from this skill */
  editSkillName?: string | null;
}

const PARAM_TYPES = ['string', 'number', 'boolean', 'object', 'array'];

const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

function generateHandlerSkeleton(skillName: string, tools: ToolDef[]): string {
  const toolCases = tools
    .map((tool) => {
      const paramNames = tool.params.map((p) => p.name);
      const destructure = paramNames.length > 0
        ? `  const { ${paramNames.join(', ')} } = args;\n`
        : '';
      return `    case '${tool.name}':\n${destructure}      // TODO: implement ${tool.name}\n      return { success: true, message: '${tool.name} executed' };`;
    })
    .join('\n\n');

  return `import { SkillHandler } from '@/skills/core/skill-handler';

export default class ${skillName.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\s/g, '')}Handler extends SkillHandler {
  async execute(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    switch (toolName) {
${toolCases}

      default:
        throw new Error(\`Unknown tool: \${toolName}\`);
    }
  }
}
`;
}

export function SkillCreator({ open, onOpenChange, onCreated, editSkillName }: SkillCreatorProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tools, setTools] = useState<ToolDef[]>([
    { name: '', description: '', params: [] },
  ]);
  const [handlerCode, setHandlerCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch skill data when editing
  React.useEffect(() => {
    if (!open || !editSkillName) {
      setEditMode(false);
      return;
    }
    setEditMode(true);
    setEditLoading(true);
    fetch(`/api/skills/${encodeURIComponent(editSkillName)}`)
      .then(res => res.json())
      .then(data => {
        const skill = data.skill || data;
        setName(skill.name || '');
        setDescription(skill.description || '');
        if (skill.handlerSource) setHandlerCode(skill.handlerSource);
        // Convert API tool format to ToolDef[]
        if (Array.isArray(skill.tools) && skill.tools.length > 0) {
          const imported: ToolDef[] = skill.tools.map((t: Record<string, unknown>) => {
            const params: ParamDef[] = [];
            const parameters = t.parameters as Record<string, unknown> | undefined;
            if (parameters?.properties) {
              const props = parameters.properties as Record<string, { type?: string; description?: string }>;
              const reqList = (parameters.required as string[]) || [];
              for (const [pName, pDef] of Object.entries(props)) {
                params.push({
                  name: pName,
                  type: pDef.type || 'string',
                  description: pDef.description || '',
                  required: reqList.includes(pName),
                });
              }
            }
            return { name: (t.name as string) || '', description: (t.description as string) || '', params };
          });
          setTools(imported);
        }
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load skill'))
      .finally(() => setEditLoading(false));
  }, [open, editSkillName]);

  // Import from JSON file
  const handleImportJson = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const json = JSON.parse(ev.target?.result as string);

        // Populate name (prefer "name" over "displayName")
        if (json.name) setName(json.name);

        // Populate description
        if (json.description) setDescription(json.description);

        // Populate tools from various JSON formats
        if (Array.isArray(json.tools) && json.tools.length > 0) {
          const importedTools: ToolDef[] = json.tools.map((t: Record<string, unknown>) => {
            const params: ParamDef[] = [];

            // Handle full tool definition format with parameters.properties
            const parameters = t.parameters as Record<string, unknown> | undefined;
            if (parameters?.properties) {
              const props = parameters.properties as Record<string, { type?: string; description?: string }>;
              const reqList = (parameters.required as string[]) || [];
              for (const [pName, pDef] of Object.entries(props)) {
                params.push({
                  name: pName,
                  type: pDef.type || 'string',
                  description: pDef.description || '',
                  required: reqList.includes(pName),
                });
              }
            }

            return {
              name: (t.name as string) || '',
              description: (t.description as string) || '',
              params,
            };
          });
          setTools(importedTools);
        }

        // Populate handler code if provided
        if (json.handlerCode) setHandlerCode(json.handlerCode);

        setError(null);
      } catch {
        setError('Failed to parse JSON file. Check the format and try again.');
      }
    };
    reader.readAsText(file);

    // Reset the file input so re-importing the same file works
    e.target.value = '';
  }, []);

  // Name validation
  const nameError = name.length > 0 && !NAME_PATTERN.test(name)
    ? 'Must start with lowercase letter, only a-z, 0-9, hyphens, underscores'
    : null;

  // Auto-generate handler skeleton when tools change
  const regenerateHandler = useCallback(() => {
    const validTools = tools.filter((t) => t.name.trim());
    if (name.trim() && validTools.length > 0) {
      setHandlerCode(generateHandlerSkeleton(name, validTools));
    }
  }, [name, tools]);

  // Tool management
  const addTool = () => {
    setTools([...tools, { name: '', description: '', params: [] }]);
  };

  const removeTool = (index: number) => {
    setTools(tools.filter((_, i) => i !== index));
  };

  const updateTool = (index: number, field: keyof ToolDef, value: string) => {
    const updated = [...tools];
    updated[index] = { ...updated[index], [field]: value };
    setTools(updated);
  };

  // Parameter management
  const addParam = (toolIndex: number) => {
    const updated = [...tools];
    updated[toolIndex] = {
      ...updated[toolIndex],
      params: [...updated[toolIndex].params, { name: '', type: 'string', description: '', required: false }],
    };
    setTools(updated);
  };

  const removeParam = (toolIndex: number, paramIndex: number) => {
    const updated = [...tools];
    updated[toolIndex] = {
      ...updated[toolIndex],
      params: updated[toolIndex].params.filter((_, i) => i !== paramIndex),
    };
    setTools(updated);
  };

  const updateParam = (toolIndex: number, paramIndex: number, field: keyof ParamDef, value: string | boolean) => {
    const updated = [...tools];
    const params = [...updated[toolIndex].params];
    params[paramIndex] = { ...params[paramIndex], [field]: value };
    updated[toolIndex] = { ...updated[toolIndex], params };
    setTools(updated);
  };

  const handleCreate = async () => {
    setError(null);

    // Validation
    if (!name.trim()) {
      setError('Skill name is required');
      return;
    }
    if (nameError) {
      setError(nameError);
      return;
    }

    const validTools = tools.filter((t) => t.name.trim());
    if (validTools.length === 0) {
      setError('At least one tool with a name is required');
      return;
    }

    // Build tool definitions for the API
    const toolDefinitions = validTools.map((tool) => {
      const properties: Record<string, { type: string; description: string }> = {};
      const required: string[] = [];

      tool.params.forEach((param) => {
        if (param.name.trim()) {
          properties[param.name] = {
            type: param.type,
            description: param.description || `The ${param.name} parameter`,
          };
          if (param.required) {
            required.push(param.name);
          }
        }
      });

      return {
        name: tool.name,
        description: tool.description || `Execute ${tool.name}`,
        parameters: {
          type: 'object',
          properties,
          required,
        },
      };
    });

    setCreating(true);
    try {
      const url = editMode
        ? `/api/skills/${encodeURIComponent(name)}`
        : '/api/skills';
      const method = editMode ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description,
          tools: toolDefinitions,
          handlerCode: handlerCode || generateHandlerSkeleton(name, validTools),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to ${editMode ? 'update' : 'create'} skill: ${res.status}`);
      }

      // Reset form
      setName('');
      setDescription('');
      setTools([{ name: '', description: '', params: [] }]);
      setHandlerCode('');
      setEditMode(false);
      onOpenChange(false);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create skill');
    } finally {
      setCreating(false);
    }
  };

  const reset = () => {
    setName('');
    setDescription('');
    setTools([{ name: '', description: '', params: [] }]);
    setHandlerCode('');
    setError(null);
    setEditMode(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] !flex !flex-col overflow-hidden p-0">
        <DialogHeader className="px-6 pt-6 pb-0 flex-shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle>{editMode ? 'Edit Skill' : 'Create Custom Skill'}</DialogTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="text-xs"
            >
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              Import JSON
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleImportJson}
              className="hidden"
            />
          </div>
          <DialogDescription>
            Define a new skill with tools and a handler, or import from a JSON file.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 overflow-auto px-6">
          <div className="space-y-6 py-4">
            {/* Error banner */}
            {error && (
              <div className="flex items-center gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-400">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                {error}
              </div>
            )}

            {/* Name */}
            <div className="space-y-2">
              <label htmlFor="skill-name" className="text-sm font-medium">Skill Name</label>
              <Input
                id="skill-name"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                placeholder="e.g., my-custom-skill"
                disabled={editMode}
                className={cn(nameError && 'border-red-500/50 focus:ring-red-500/50')}
              />
              {nameError && (
                <p className="text-xs text-red-400">{nameError}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Lowercase letters, numbers, hyphens, and underscores only.
              </p>
            </div>

            {/* Description */}
            <div className="space-y-2">
              <label htmlFor="skill-desc" className="text-sm font-medium">Description</label>
              <Textarea
                id="skill-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this skill do?"
                rows={2}
              />
            </div>

            <Separator />

            {/* Tool definitions */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium flex items-center gap-2">
                  <Wrench className="h-4 w-4" />
                  Tool Definitions
                </h3>
                <Button variant="outline" size="sm" onClick={addTool}>
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add Tool
                </Button>
              </div>

              {tools.map((tool, toolIndex) => (
                <div key={toolIndex} className="rounded-lg border border-border bg-card p-3 space-y-3">
                  {/* Tool header */}
                  <div className="flex items-start gap-2">
                    <div className="flex-1 space-y-2">
                      <Input
                        value={tool.name}
                        onChange={(e) => updateTool(toolIndex, 'name', e.target.value)}
                        placeholder="tool_name (e.g., fetch_data)"
                        className="font-mono text-sm"
                      />
                      <Input
                        value={tool.description}
                        onChange={(e) => updateTool(toolIndex, 'description', e.target.value)}
                        placeholder="Tool description"
                        className="text-sm"
                      />
                    </div>
                    {tools.length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10 flex-shrink-0 mt-0.5"
                        onClick={() => removeTool(toolIndex)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>

                  {/* Parameters */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground">Parameters</span>
                      <Button variant="ghost" size="sm" onClick={() => addParam(toolIndex)} className="h-6 text-xs px-2">
                        <Plus className="h-3 w-3 mr-1" />
                        Add
                      </Button>
                    </div>

                    {tool.params.length === 0 ? (
                      <p className="text-xs text-muted-foreground/60 italic">No parameters. Click Add to define one.</p>
                    ) : (
                      <div className="space-y-2">
                        {tool.params.map((param, paramIndex) => (
                          <div key={paramIndex} className="flex items-center gap-2 rounded border border-border/50 bg-muted/20 p-2">
                            <Input
                              value={param.name}
                              onChange={(e) => updateParam(toolIndex, paramIndex, 'name', e.target.value)}
                              placeholder="name"
                              className="h-7 text-xs font-mono flex-1 min-w-0"
                            />
                            <select
                              value={param.type}
                              onChange={(e) => updateParam(toolIndex, paramIndex, 'type', e.target.value)}
                              className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground w-24 flex-shrink-0"
                            >
                              {PARAM_TYPES.map((t) => (
                                <option key={t} value={t}>{t}</option>
                              ))}
                            </select>
                            <Input
                              value={param.description}
                              onChange={(e) => updateParam(toolIndex, paramIndex, 'description', e.target.value)}
                              placeholder="description"
                              className="h-7 text-xs flex-1 min-w-0"
                            />
                            <div className="flex items-center gap-1 flex-shrink-0" title="Required">
                              <Switch
                                checked={param.required}
                                onCheckedChange={(checked) => updateParam(toolIndex, paramIndex, 'required', checked)}
                                className="scale-75"
                              />
                              <span className="text-[10px] text-muted-foreground">Req</span>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive flex-shrink-0"
                              onClick={() => removeParam(toolIndex, paramIndex)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <Separator />

            {/* Handler code */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Handler Code (TypeScript)</label>
                <Button variant="ghost" size="sm" onClick={regenerateHandler} className="h-6 text-xs">
                  Generate Skeleton
                </Button>
              </div>
              <Textarea
                value={handlerCode}
                onChange={(e) => setHandlerCode(e.target.value)}
                placeholder="Handler code will be auto-generated when you click 'Generate Skeleton', or write your own..."
                rows={12}
                className="font-mono text-xs leading-relaxed"
              />
              <p className="text-xs text-muted-foreground">
                The handler receives the tool name and arguments object. Return a result object.
              </p>
            </div>
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border flex-shrink-0">
          <Button variant="ghost" size="sm" onClick={() => { reset(); onOpenChange(false); }}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={creating || !name.trim() || !!nameError}
          >
            {creating ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
            ) : (
              <Plus className="h-4 w-4 mr-1.5" />
            )}
            {creating ? (editMode ? 'Saving...' : 'Creating...') : (editMode ? 'Save Changes' : 'Create Skill')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
