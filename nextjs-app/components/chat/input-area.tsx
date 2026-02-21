'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Send, Mic, Image as ImageIcon, Square, Volume2, VolumeX, StopCircle, RotateCcw, Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/lib/store';
import { STTClient } from '@/lib/stt-client';
import { log } from '@/lib/log-store';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export interface ImageAttachment {
  file: File;
  preview: string; // object URL for preview
  uploading: boolean;
  workspacePath?: string; // set after upload
  error?: string;
}

interface InputAreaProps {
  onSend: (message: string, attachment?: ImageAttachment) => void;
  onStop?: () => void;
  onRegenerate?: () => void;
  onImageRequest?: () => void;
  disabled?: boolean;
  placeholder?: string;
  canRegenerate?: boolean;
}

export function InputArea({
  onSend,
  onStop,
  onRegenerate,
  onImageRequest,
  disabled = false,
  placeholder = 'Type a message...',
  canRegenerate = false,
}: InputAreaProps) {
  const [message, setMessage] = useState('');
  const [attachment, setAttachment] = useState<ImageAttachment | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sttClientRef = useRef<STTClient | null>(null);
  const { ui, settings, isStreaming, toggleMute, setRecording } = useAppStore();

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [message]);

  // Cleanup object URLs
  useEffect(() => {
    return () => {
      if (attachment?.preview) {
        URL.revokeObjectURL(attachment.preview);
      }
    };
  }, [attachment]);

  const uploadImage = useCallback(async (file: File): Promise<ImageAttachment> => {
    const preview = URL.createObjectURL(file);
    const att: ImageAttachment = { file, preview, uploading: true };
    setAttachment(att);

    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();

      if (data.success) {
        const uploaded = { ...att, uploading: false, workspacePath: data.path };
        setAttachment(uploaded);
        return uploaded;
      } else {
        const failed = { ...att, uploading: false, error: data.error };
        setAttachment(failed);
        return failed;
      }
    } catch (err) {
      const failed = { ...att, uploading: false, error: err instanceof Error ? err.message : 'Upload failed' };
      setAttachment(failed);
      return failed;
    }
  }, []);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await uploadImage(file);
    }
    // Reset input so the same file can be selected again
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [uploadImage]);

  const removeAttachment = useCallback(() => {
    if (attachment?.preview) {
      URL.revokeObjectURL(attachment.preview);
    }
    setAttachment(null);
  }, [attachment]);

  const handleSend = useCallback(() => {
    const hasText = message.trim();
    const hasAttachment = attachment && !attachment.uploading && !attachment.error && attachment.workspacePath;

    if ((hasText || hasAttachment) && !disabled && !isStreaming) {
      onSend(message.trim(), attachment || undefined);
      setMessage('');
      setAttachment(null);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
  }, [message, attachment, disabled, isStreaming, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Send on Enter (without Shift)
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
      // Cancel on Escape
      if (e.key === 'Escape') {
        setMessage('');
      }
    },
    [handleSend]
  );

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          await uploadImage(file);
        }
        return;
      }
    }
  }, [uploadImage]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      await uploadImage(file);
    }
  }, [uploadImage]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleMicClick = useCallback(async () => {
    if (ui.isRecording) {
      // Stop recording
      if (sttClientRef.current) {
        sttClientRef.current.stopRecording();
      }
      setRecording(false);
    } else {
      // Start recording
      setRecording(true);
      const recordingStartTime = Date.now();
      log.sttStart();

      sttClientRef.current = new STTClient(settings.stt, {
        onRecordingChange: (isRecording) => {
          setRecording(isRecording);
        },
        onResult: (result) => {
          log.sttResult(result.text, Date.now() - recordingStartTime);
          if (result.text) {
            setMessage((prev) => prev + (prev ? ' ' : '') + result.text);
            // Focus textarea for editing
            setTimeout(() => textareaRef.current?.focus(), 100);
          }
        },
        onError: (error) => {
          log.sttError(error.message);
          setRecording(false);
        },
      });

      try {
        await sttClientRef.current.startRecording();
      } catch (error) {
        log.sttError(error instanceof Error ? error.message : 'Failed to start recording');
        setRecording(false);
      }
    }
  }, [ui.isRecording, settings.stt, setRecording]);

  return (
    <TooltipProvider>
      <div className="border-t border-border bg-card/50 backdrop-blur-sm p-4">
        <div className="max-w-4xl mx-auto">
          {/* Attachment preview */}
          {attachment && (
            <div className="mb-2 flex items-center gap-2">
              <div className="relative inline-block">
                <img
                  src={attachment.preview}
                  alt="Attachment"
                  className={cn(
                    'h-16 w-16 object-cover rounded-lg border border-border',
                    attachment.uploading && 'opacity-50',
                    attachment.error && 'border-red-500/50'
                  )}
                />
                {attachment.uploading && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="h-4 w-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  </div>
                )}
                <button
                  onClick={removeAttachment}
                  className="absolute -top-1 -right-1 bg-destructive text-destructive-foreground rounded-full p-0.5 hover:bg-destructive/80"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
              <div className="text-xs text-muted-foreground">
                {attachment.uploading && 'Uploading...'}
                {attachment.error && <span className="text-red-400">{attachment.error}</span>}
                {attachment.workspacePath && (
                  <span className="text-green-400">Ready - {attachment.file.name}</span>
                )}
              </div>
            </div>
          )}

          <div
            className="relative flex items-end gap-2"
            onDrop={handleDrop}
            onDragOver={handleDragOver}
          >
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
              onChange={handleFileSelect}
              className="hidden"
            />

            {/* Text input area */}
            <div className="flex-1 relative">
              <Textarea
                ref={textareaRef}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={placeholder}
                disabled={disabled || isStreaming}
                spellCheck={true}
                className={cn(
                  'min-h-[52px] max-h-[200px] pr-12 resize-none',
                  'bg-background/50 border-border/50',
                  isStreaming && 'opacity-50'
                )}
                rows={1}
              />
              {/* Character count (optional - show when getting long) */}
              {message.length > 500 && (
                <span className="absolute right-3 bottom-2 text-xs text-muted-foreground">
                  {message.length}
                </span>
              )}
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-1">
              {/* TTS Mute/Unmute toggle */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={toggleMute}
                    className={cn(
                      'text-muted-foreground hover:text-foreground',
                      ui.isMuted && 'text-red-400 hover:text-red-300'
                    )}
                  >
                    {ui.isMuted ? (
                      <VolumeX className="h-5 w-5" />
                    ) : (
                      <Volume2 className="h-5 w-5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {ui.isMuted ? 'Unmute TTS' : 'Mute TTS'}
                </TooltipContent>
              </Tooltip>

              {/* Image attachment */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={disabled || isStreaming || !!attachment}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Paperclip className="h-5 w-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Attach image for Optic analysis</TooltipContent>
              </Tooltip>

              {/* Voice input toggle */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleMicClick}
                    disabled={disabled || isStreaming}
                    className={cn(
                      'text-muted-foreground hover:text-foreground',
                      ui.isRecording && 'text-red-500 hover:text-red-400 animate-pulse'
                    )}
                  >
                    {ui.isRecording ? (
                      <Square className="h-5 w-5" />
                    ) : (
                      <Mic className="h-5 w-5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {ui.isRecording ? 'Stop recording' : 'Start voice input'}
                </TooltipContent>
              </Tooltip>

              {/* Image generation */}
              {onImageRequest && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={onImageRequest}
                      disabled={disabled || isStreaming || ui.isGeneratingImage}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <ImageIcon className="h-5 w-5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Generate Selfie</TooltipContent>
                </Tooltip>
              )}

              {/* Regenerate button - show when there's a last message and not streaming */}
              {canRegenerate && onRegenerate && !isStreaming && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={onRegenerate}
                      disabled={disabled}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <RotateCcw className="h-5 w-5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Regenerate response</TooltipContent>
                </Tooltip>
              )}

              {/* Stop button - show when streaming */}
              {isStreaming && onStop ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="destructive"
                      size="icon"
                      onClick={onStop}
                      className="h-10 w-10"
                    >
                      <StopCircle className="h-5 w-5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Stop generating</TooltipContent>
                </Tooltip>
              ) : (
                /* Send button */
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      onClick={handleSend}
                      disabled={(!message.trim() && !attachment?.workspacePath) || disabled || isStreaming}
                      className="btn-primary h-10 w-10"
                      size="icon"
                    >
                      <Send className="h-5 w-5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Send message (Enter)
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>

          {/* Keyboard shortcut hints */}
          <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground/50">
            <span>Press Enter to send, Shift+Enter for new line, paste/drop images</span>
            {isStreaming && (
              <span className="text-primary-400 animate-pulse">
                AI is responding...
              </span>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
