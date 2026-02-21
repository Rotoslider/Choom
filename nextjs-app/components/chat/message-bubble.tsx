'use client';

import React, { useState, useEffect, Component, ErrorInfo, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/cjs/styles/prism';
import { cn } from '@/lib/utils';
import { formatTime } from '@/lib/utils';
import { User, Bot, Wrench } from 'lucide-react';
import { FileReference } from './file-reference';
import type { Message, ToolResult } from '@/lib/types';

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  streamingContent?: string;
  choomName?: string;
}

// Extended tool result with image data
interface ImageToolResult extends ToolResult {
  result: {
    success?: boolean;
    message?: string;
    imageId?: string;
    imageUrl?: string;
  } | unknown;
}

// Error boundary — if react-markdown crashes, fall back to plain text
class MarkdownErrorBoundary extends Component<
  { children: ReactNode; fallback: string },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; fallback: string }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('MarkdownContent render error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return <span style={{ whiteSpace: 'pre-wrap' }}>{this.props.fallback}</span>;
    }
    return this.props.children;
  }
}

// Markdown content renderer using react-markdown
function MarkdownContent({ content }: { content: string }) {
  return (
    <MarkdownErrorBoundary fallback={content}>
      <ReactMarkdown
        components={{
          // Fenced code blocks
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const codeString = String(children).replace(/\n$/, '');

            // Block code (fenced with language)
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

            // Multi-line code without language tag — still render as block
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

            // Inline code
            return (
              <code className="bg-muted px-1 py-0.5 rounded text-xs font-mono" {...props}>
                {children}
              </code>
            );
          },
          // Links open in new tab
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline hover:opacity-80">
                {children}
              </a>
            );
          },
          p({ children }) {
            return <p className="mb-2 last:mb-0">{children}</p>;
          },
          ul({ children }) {
            return <ul className="ml-4 list-disc mb-2">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="ml-4 list-decimal mb-2">{children}</ol>;
          },
          li({ children }) {
            return <li className="mb-0.5">{children}</li>;
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
          blockquote({ children }) {
            return <blockquote className="border-l-2 border-primary pl-3 italic my-2">{children}</blockquote>;
          },
          table({ children }) {
            return <table className="border-collapse my-2 text-xs w-full">{children}</table>;
          },
          th({ children }) {
            return <th className="border border-border px-2 py-1 bg-muted font-medium text-left">{children}</th>;
          },
          td({ children }) {
            return <td className="border border-border px-2 py-1">{children}</td>;
          },
          hr() {
            return <hr className="my-3 border-border" />;
          },
          // Let code component handle pre styling
          pre({ children }) {
            return <>{children}</>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </MarkdownErrorBoundary>
  );
}

function buildImageFilename(choomName: string | undefined, imageId: string, settings?: string | null): string {
  const name = choomName || 'Choom';
  let isSelfie = false;
  if (settings) {
    try {
      const parsed = JSON.parse(settings);
      isSelfie = !!parsed.isSelfPortrait;
    } catch { /* ignore */ }
  }
  const shortId = imageId.slice(-8);
  return `${name}-${isSelfie ? 'selfie' : 'image'}-${shortId}.png`;
}

// Component to load and display an image by its ID
function ImageById({ imageId, choomName }: { imageId: string; choomName?: string }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageSettings, setImageSettings] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/images/${imageId}`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (!cancelled && data?.imageUrl) {
          setImageUrl(data.imageUrl);
          setImageSettings(data.settings || null);
        }
        if (!cancelled) setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [imageId]);

  if (loading) {
    return (
      <div className="w-full h-48 bg-muted/50 rounded-lg animate-pulse flex items-center justify-center">
        <span className="text-sm text-muted-foreground">Loading image...</span>
      </div>
    );
  }

  if (!imageUrl) return null;

  const filename = buildImageFilename(choomName, imageId, imageSettings);

  return (
    <div className="relative">
      <img
        src={imageUrl}
        alt="Generated image"
        className="max-w-full rounded-lg shadow-md cursor-pointer hover:opacity-90 transition-opacity"
        style={{ maxHeight: '400px' }}
        onClick={() => {
          const link = document.createElement('a');
          link.href = imageUrl;
          link.download = filename;
          link.click();
        }}
      />
      <div className="absolute bottom-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded">
        Click to download
      </div>
    </div>
  );
}

export function MessageBubble({
  message,
  isStreaming = false,
  streamingContent,
  choomName,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const content = isStreaming ? streamingContent : message.content;

  // Parse tool results if present (for extracting generated images)
  const toolResults: ImageToolResult[] = message.toolResults
    ? typeof message.toolResults === 'string'
      ? JSON.parse(message.toolResults)
      : message.toolResults
    : [];

  // Extract generated images from tool results
  const generatedImages = toolResults
    .filter((tr) => tr.name === 'generate_image' && tr.result && typeof tr.result === 'object')
    .map((tr) => {
      const result = tr.result as { imageUrl?: string; imageId?: string };
      return { imageUrl: result.imageUrl, imageId: result.imageId };
    })
    .filter((img) => img.imageUrl || img.imageId);

  // Extract workspace file references
  const fileRefs = toolResults
    .filter((tr) => (tr.name === 'workspace_write_file' || tr.name === 'workspace_generate_pdf') && tr.result && typeof tr.result === 'object')
    .map((tr) => {
      const result = tr.result as { path?: string };
      const action = tr.name === 'workspace_write_file' ? 'created' : 'created';
      return { path: result.path || '', action: action as 'created' };
    })
    .filter((f) => f.path);

  return (
    <div
      className={cn(
        'flex gap-3 animate-slide-up',
        isUser ? 'flex-row-reverse' : 'flex-row'
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center',
          isUser
            ? 'bg-gradient-primary'
            : isTool
              ? 'bg-secondary-500'
              : 'bg-primary-600'
        )}
      >
        {isUser ? (
          <User className="w-4 h-4 text-white" />
        ) : isTool ? (
          <Wrench className="w-4 h-4 text-white" />
        ) : (
          <Bot className="w-4 h-4 text-white" />
        )}
      </div>

      {/* Message content */}
      <div
        className={cn(
          'flex flex-col max-w-[75%] space-y-1',
          isUser ? 'items-end' : 'items-start'
        )}
      >
        <div
          className={cn(
            'px-4 py-2.5 shadow-sm',
            isUser
              ? 'message-user'
              : 'bg-card border border-border rounded-2xl rounded-bl-md'
          )}
        >
          {/* Main content */}
          {!isUser && content ? (
            <div className="text-sm break-words">
              <MarkdownContent content={content} />
              {isStreaming && (
                <span className="inline-block w-1.5 h-4 ml-0.5 bg-primary-400 animate-pulse" />
              )}
            </div>
          ) : (
            <div className="text-sm whitespace-pre-wrap break-words">
              {content}
              {isStreaming && (
                <span className="inline-block w-1.5 h-4 ml-0.5 bg-primary-400 animate-pulse" />
              )}
            </div>
          )}

          {/* File references display */}
          {fileRefs.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {fileRefs.map((f, idx) => (
                <FileReference key={idx} path={f.path} action={f.action} />
              ))}
            </div>
          )}

          {/* Generated images display */}
          {generatedImages.length > 0 && (
            <div className="mt-3 space-y-2">
              {generatedImages.map((img, idx) => (
                <div key={img.imageId || idx}>
                  {img.imageUrl ? (
                    <div className="relative">
                      <img
                        src={img.imageUrl}
                        alt="Generated image"
                        className="max-w-full rounded-lg shadow-md cursor-pointer hover:opacity-90 transition-opacity"
                        style={{ maxHeight: '400px' }}
                        onClick={() => {
                          if (img.imageUrl) {
                            const link = document.createElement('a');
                            link.href = img.imageUrl;
                            link.download = buildImageFilename(choomName, img.imageId || String(idx));
                            link.click();
                          }
                        }}
                      />
                      <div className="absolute bottom-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded">
                        Click to download
                      </div>
                    </div>
                  ) : img.imageId ? (
                    <ImageById imageId={img.imageId} choomName={choomName} />
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Timestamp */}
        <span className="text-xs text-muted-foreground px-1">
          {formatTime(message.createdAt)}
        </span>
      </div>
    </div>
  );
}
