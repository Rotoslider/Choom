'use client';

import React, { useState } from 'react';
import { Plus, MessageSquare, Archive, MoreHorizontal, Trash2, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn, formatRelativeTime } from '@/lib/utils';
import type { Chat } from '@/lib/types';

interface ChatListProps {
  chats: Chat[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreateNew: () => void;
  onArchive?: (id: string) => void;
  onDelete?: (id: string) => void;
  onRename?: (id: string, newTitle: string) => void;
}

export function ChatList({
  chats,
  selectedId,
  onSelect,
  onCreateNew,
  onArchive,
  onDelete,
  onRename,
}: ChatListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  const handleStartRename = (chat: Chat) => {
    setEditingId(chat.id);
    setEditTitle(chat.title || '');
  };

  const handleSaveRename = (chatId: string) => {
    if (editTitle.trim() && onRename) {
      onRename(chatId, editTitle.trim());
    }
    setEditingId(null);
    setEditTitle('');
  };

  const handleCancelRename = () => {
    setEditingId(null);
    setEditTitle('');
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Chats
        </h3>
        <Button
          variant="ghost"
          size="icon"
          onClick={onCreateNew}
          className="h-7 w-7"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {chats.length === 0 ? (
            <div className="px-3 py-6 text-center">
              <MessageSquare className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" />
              <p className="text-sm text-muted-foreground mb-3">
                No chats yet
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={onCreateNew}
                className="gap-1"
              >
                <Plus className="h-4 w-4" />
                Start a new chat
              </Button>
            </div>
          ) : (
            chats.map((chat) => (
              <div
                key={chat.id}
                className={cn(
                  'group relative flex items-center gap-2 px-3 py-2 rounded-lg transition-all duration-200',
                  'hover:bg-muted/50 cursor-pointer',
                  selectedId === chat.id &&
                    'bg-primary/10 border border-primary/30'
                )}
                onClick={() => editingId !== chat.id && onSelect(chat.id)}
              >
                <MessageSquare className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                <div className="min-w-0" style={{ maxWidth: 'calc(100% - 3.5rem)' }}>
                  {editingId === chat.id ? (
                    <Input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveRename(chat.id);
                        if (e.key === 'Escape') handleCancelRename();
                      }}
                      onBlur={() => handleSaveRename(chat.id)}
                      className="h-6 text-sm px-1"
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <p
                      className={cn(
                        'text-sm font-medium line-clamp-2',
                        selectedId === chat.id && 'text-primary'
                      )}
                      title={chat.title || 'New Chat'}
                    >
                      {chat.title || 'New Chat'}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground truncate">
                    {formatRelativeTime(chat.updatedAt)}
                  </p>
                </div>

                {/* Dropdown menu for actions - always visible */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 flex-shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    {onRename && (
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStartRename(chat);
                        }}
                      >
                        <Pencil className="h-4 w-4 mr-2" />
                        Rename
                      </DropdownMenuItem>
                    )}
                    {onArchive && (
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          onArchive(chat.id);
                        }}
                      >
                        <Archive className="h-4 w-4 mr-2" />
                        Archive
                      </DropdownMenuItem>
                    )}
                    {(onRename || onArchive) && onDelete && <DropdownMenuSeparator />}
                    {onDelete && (
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(chat.id);
                        }}
                        className="text-red-400 focus:text-red-400"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
