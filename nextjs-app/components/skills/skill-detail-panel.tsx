'use client';

import React, { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/cjs/styles/prism';
import {
  X,
  Wrench,
  Play,
  Trash2,
  Pencil,
  Code,
  FileText,
  User,
  Tag,
  Loader2,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
}

interface SkillDetail {
  name: string;
  description: string;
  version: string;
  author: string;
  type: 'core' | 'custom' | 'external';
  enabled: boolean;
  toolCount: number;
  tools: ToolDefinition[];
  fullDoc: string;
  handlerSource?: string;
  handlerCode?: string; // alias for handlerSource
}

const typeBadgeColors: Record<string, string> = {
  core: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  custom: 'bg-green-500/20 text-green-400 border-green-500/30',
  external: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
};

interface SkillDetailPanelProps {
  skillName: string;
  onClose: () => void;
}

export function SkillDetailPanel({ skillName, onClose }: SkillDetailPanelProps) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'docs' | 'tools' | 'code'>('docs');

  // Test runner state
  const [testToolName, setTestToolName] = useState<string>('');
  const [testArgs, setTestArgs] = useState('{}');
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; data?: unknown; error?: string } | null>(null);

  // Tool expand state
  const [expandedTool, setExpandedTool] = useState<string | null>(null);

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}`);
      if (!res.ok) {
        throw new Error(`Failed to load skill: ${res.status}`);
      }
      const data = await res.json();
      const skillData = data.skill || data;
      setDetail(skillData);
      if (skillData.tools?.length > 0 && !testToolName) {
        const firstTool = typeof skillData.tools[0] === 'string' ? skillData.tools[0] : skillData.tools[0].name;
        setTestToolName(firstTool);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load skill details');
    } finally {
      setLoading(false);
    }
  }, [skillName, testToolName]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const runTest = async () => {
    if (!testToolName) return;
    setTestRunning(true);
    setTestResult(null);
    try {
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(testArgs);
      } catch {
        setTestResult({ success: false, error: 'Invalid JSON in arguments' });
        setTestRunning(false);
        return;
      }

      const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolName: testToolName, arguments: parsedArgs }),
      });
      const data = await res.json();
      setTestResult(data);
    } catch (err) {
      setTestResult({ success: false, error: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setTestRunning(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        onClose();
      }
    } catch (err) {
      console.error('Failed to delete skill:', err);
    } finally {
      setDeleting(false);
      setDeleteConfirm(false);
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading skill...
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-3">
        <XCircle className="h-8 w-8 opacity-50" />
        <p className="text-sm">{error || 'Skill not found'}</p>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>
    );
  }

  const tabs = [
    { id: 'docs' as const, label: 'Documentation', icon: FileText },
    { id: 'tools' as const, label: `Tools (${detail.toolCount})`, icon: Wrench },
    ...((detail.handlerSource || detail.handlerCode) ? [{ id: 'code' as const, label: 'Handler Code', icon: Code }] : []),
  ];

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between p-4 border-b border-border">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-base font-semibold truncate">{detail.name}</h2>
            <Badge
              variant="outline"
              className={cn('text-[10px] px-1.5 py-0 flex-shrink-0', typeBadgeColors[detail.type])}
            >
              {detail.type}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">{detail.description}</p>
          <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
            {detail.version && (
              <span className="flex items-center gap-1">
                <Tag className="h-3 w-3" />
                v{detail.version}
              </span>
            )}
            {detail.author && (
              <span className="flex items-center gap-1">
                <User className="h-3 w-3" />
                {detail.author}
              </span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} className="flex-shrink-0 -mr-2 -mt-1">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-border px-4">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors border-b-2 -mb-px',
              activeTab === tab.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <tab.icon className="h-3.5 w-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Documentation tab */}
          {activeTab === 'docs' && (
            <div className="prose prose-sm prose-invert max-w-none">
              {detail.fullDoc ? (
                <ReactMarkdown
                  components={{
                    code({ className, children, ...props }) {
                      const match = /language-(\w+)/.exec(className || '');
                      const codeString = String(children).replace(/\n$/, '');
                      if (match) {
                        return (
                          <div className="code-block my-2">
                            <div className="code-block-lang">{match[1]}</div>
                            <SyntaxHighlighter
                              style={oneDark}
                              language={match[1]}
                              PreTag="div"
                              customStyle={{ margin: 0, padding: '0.75rem', fontSize: '0.75rem', lineHeight: '1.625' }}
                            >
                              {codeString}
                            </SyntaxHighlighter>
                          </div>
                        );
                      }
                      if (codeString.includes('\n')) {
                        return (
                          <div className="code-block my-2">
                            <SyntaxHighlighter
                              style={oneDark}
                              language="text"
                              PreTag="div"
                              customStyle={{ margin: 0, padding: '0.75rem', fontSize: '0.75rem', lineHeight: '1.625' }}
                            >
                              {codeString}
                            </SyntaxHighlighter>
                          </div>
                        );
                      }
                      return (
                        <code className="bg-muted px-1 py-0.5 rounded text-xs font-mono" {...props}>
                          {children}
                        </code>
                      );
                    },
                    a({ href, children }) {
                      return (
                        <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline hover:opacity-80">
                          {children}
                        </a>
                      );
                    },
                    p({ children }) {
                      return <p className="mb-2 last:mb-0 text-sm">{children}</p>;
                    },
                    h1({ children }) {
                      return <h1 className="text-lg font-bold mb-2">{children}</h1>;
                    },
                    h2({ children }) {
                      return <h2 className="text-base font-bold mb-1.5">{children}</h2>;
                    },
                    h3({ children }) {
                      return <h3 className="text-sm font-bold mb-1">{children}</h3>;
                    },
                    ul({ children }) {
                      return <ul className="ml-4 list-disc mb-2 text-sm">{children}</ul>;
                    },
                    ol({ children }) {
                      return <ol className="ml-4 list-decimal mb-2 text-sm">{children}</ol>;
                    },
                    li({ children }) {
                      return <li className="mb-0.5">{children}</li>;
                    },
                    blockquote({ children }) {
                      return <blockquote className="border-l-2 border-primary pl-3 italic my-2 text-sm">{children}</blockquote>;
                    },
                  }}
                >
                  {detail.fullDoc}
                </ReactMarkdown>
              ) : (
                <p className="text-sm text-muted-foreground italic">No documentation available for this skill.</p>
              )}
            </div>
          )}

          {/* Tools tab */}
          {activeTab === 'tools' && (
            <div className="space-y-2">
              {detail.tools.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">No tool definitions found.</p>
              ) : (
                detail.tools.map((tool) => {
                  const isExpanded = expandedTool === tool.name;
                  const paramEntries = Object.entries(tool.parameters.properties || {});
                  return (
                    <div key={tool.name} className="rounded-lg border border-border bg-card overflow-hidden">
                      <button
                        onClick={() => setExpandedTool(isExpanded ? null : tool.name)}
                        className="w-full flex items-center gap-2 p-3 text-left hover:bg-muted/50 transition-colors"
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                        )}
                        <Wrench className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                        <span className="font-mono text-sm font-medium truncate">{tool.name}</span>
                      </button>

                      {isExpanded && (
                        <div className="px-3 pb-3 border-t border-border bg-muted/20">
                          <p className="text-xs text-muted-foreground mt-2 mb-3">{tool.description}</p>

                          {paramEntries.length > 0 && (
                            <div className="space-y-1">
                              <span className="text-[10px] font-medium uppercase text-muted-foreground tracking-wider">Parameters</span>
                              <div className="rounded border border-border overflow-hidden">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="bg-muted/50">
                                      <th className="text-left px-2 py-1.5 font-medium">Name</th>
                                      <th className="text-left px-2 py-1.5 font-medium">Type</th>
                                      <th className="text-left px-2 py-1.5 font-medium">Description</th>
                                      <th className="text-center px-2 py-1.5 font-medium">Req</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {paramEntries.map(([paramName, param]) => (
                                      <tr key={paramName} className="border-t border-border/50">
                                        <td className="px-2 py-1.5 font-mono text-primary">{paramName}</td>
                                        <td className="px-2 py-1.5 text-muted-foreground">
                                          {param.type}
                                          {param.enum && (
                                            <span className="ml-1 text-[10px]">
                                              [{param.enum.join(', ')}]
                                            </span>
                                          )}
                                        </td>
                                        <td className="px-2 py-1.5 text-muted-foreground">{param.description}</td>
                                        <td className="px-2 py-1.5 text-center">
                                          {tool.parameters.required?.includes(paramName) ? (
                                            <CheckCircle2 className="h-3 w-3 text-green-400 inline" />
                                          ) : (
                                            <span className="text-muted-foreground/40">-</span>
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* Code tab */}
          {activeTab === 'code' && (detail.handlerSource || detail.handlerCode) && (
            <div className="code-block rounded-lg overflow-hidden">
              <SyntaxHighlighter
                style={oneDark}
                language="typescript"
                PreTag="div"
                customStyle={{
                  margin: 0,
                  padding: '1rem',
                  fontSize: '0.75rem',
                  lineHeight: '1.625',
                  maxHeight: '500px',
                  overflow: 'auto',
                }}
                showLineNumbers
              >
                {(detail.handlerSource || detail.handlerCode)!}
              </SyntaxHighlighter>
            </div>
          )}
        </div>

        {/* Test runner */}
        <div className="p-4 border-t border-border">
          <Separator className="mb-4" />
          <h3 className="text-xs font-medium uppercase text-muted-foreground tracking-wider mb-3">
            Test Runner
          </h3>

          <div className="space-y-3">
            {/* Tool selector */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Tool</label>
              <Select value={testToolName} onValueChange={setTestToolName}>
                <SelectTrigger className="text-sm">
                  <SelectValue placeholder="Select a tool..." />
                </SelectTrigger>
                <SelectContent>
                  {detail.tools.map((t) => (
                    <SelectItem key={t.name} value={t.name}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Args textarea */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Arguments (JSON)</label>
              <Textarea
                value={testArgs}
                onChange={(e) => setTestArgs(e.target.value)}
                placeholder='{"key": "value"}'
                rows={4}
                className="font-mono text-xs"
              />
            </div>

            {/* Run button */}
            <Button
              size="sm"
              onClick={runTest}
              disabled={testRunning || !testToolName}
              className="w-full"
            >
              {testRunning ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <Play className="h-4 w-4 mr-1.5" />
              )}
              {testRunning ? 'Running...' : 'Run Test'}
            </Button>

            {/* Result display */}
            {testResult && (
              <div className={cn(
                'rounded-lg border p-3',
                testResult.success
                  ? 'border-green-500/30 bg-green-500/10'
                  : 'border-red-500/30 bg-red-500/10'
              )}>
                <div className="flex items-center gap-1.5 mb-2">
                  {testResult.success ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 text-red-400" />
                  )}
                  <span className={cn('text-xs font-medium', testResult.success ? 'text-green-400' : 'text-red-400')}>
                    {testResult.success ? 'Success' : 'Error'}
                  </span>
                </div>
                <pre className="text-xs font-mono whitespace-pre-wrap overflow-auto max-h-48 text-foreground/80">
                  {testResult.error
                    ? testResult.error
                    : JSON.stringify(testResult.data, null, 2)
                  }
                </pre>
              </div>
            )}
          </div>
        </div>

        {/* Actions for custom skills */}
        {detail.type === 'custom' && (
          <div className="p-4 border-t border-border">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="flex-1" asChild>
                <a href={`/skills?edit=${encodeURIComponent(detail.name)}`}>
                  <Pencil className="h-3.5 w-3.5 mr-1.5" />
                  Edit Skill
                </a>
              </Button>

              {deleteConfirm ? (
                <div className="flex-1 flex items-center gap-2 p-2 rounded-lg bg-destructive/10 border border-destructive/30">
                  <span className="text-xs text-destructive flex-1">Delete this skill?</span>
                  <Button variant="ghost" size="sm" onClick={() => setDeleteConfirm(false)} disabled={deleting}>
                    Cancel
                  </Button>
                  <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleting}>
                    {deleting ? 'Deleting...' : 'Delete'}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10"
                  onClick={() => setDeleteConfirm(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
