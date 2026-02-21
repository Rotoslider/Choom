'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import {
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  Activity,
  Image as ImageIcon,
  ScrollText,
  Blocks,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ChoomList } from './choom-list';
import { ChatList } from './chat-list';
import { StatusIndicator } from '@/components/common/status-indicator';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { Choom, Chat } from '@/lib/types';

interface SidebarProps {
  chooms: Choom[];
  chats: Chat[];
  onSelectChoom: (id: string) => void;
  onSelectChat: (id: string) => void;
  onCreateChoom: () => void;
  onCreateChat: () => void;
  onEditChoom?: (choom: Choom) => void;
  onArchiveChat?: (id: string) => void;
  onDeleteChat?: (id: string) => void;
  onRenameChat?: (id: string, newTitle: string) => void;
  onOpenSettings: () => void;
  onOpenHealth: () => void;
  onOpenGallery?: () => void;
  onOpenLogs?: () => void;
}

export function Sidebar({
  chooms,
  chats,
  onSelectChoom,
  onSelectChat,
  onCreateChoom,
  onCreateChat,
  onEditChoom,
  onArchiveChat,
  onDeleteChat,
  onRenameChat,
  onOpenSettings,
  onOpenHealth,
  onOpenGallery,
  onOpenLogs,
}: SidebarProps) {
  const router = useRouter();
  const {
    ui,
    toggleSidebar,
    currentChoomId,
    currentChatId,
    services,
  } = useAppStore();

  // Count connected services (only the 5 implemented ones)
  const implementedServices = ['llm', 'tts', 'stt', 'imageGen', 'memory'] as const;
  const connectedCount = implementedServices.filter(
    (s) => services[s] === 'connected'
  ).length;
  const totalServices = implementedServices.length;

  return (
    <>
      {/* Collapsed sidebar toggle */}
      {!ui.isSidebarOpen && (
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          className="fixed top-4 left-4 z-50"
        >
          <PanelLeftOpen className="h-5 w-5" />
        </Button>
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed left-0 top-0 h-full bg-card border-r border-border flex flex-col z-40',
          'transition-all duration-300 ease-in-out',
          ui.isSidebarOpen ? 'w-[280px]' : 'w-0 overflow-hidden'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-primary flex items-center justify-center">
              <span className="text-white font-bold text-sm">C</span>
            </div>
            <span className="font-semibold text-gradient">Choom</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleSidebar}
            className="h-8 w-8"
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
        </div>

        {/* Choom list */}
        <div className="flex-shrink-0" style={{ height: '35%' }}>
          <ChoomList
            chooms={chooms}
            selectedId={currentChoomId}
            onSelect={onSelectChoom}
            onCreateNew={onCreateChoom}
            onEdit={onEditChoom}
          />
        </div>

        <Separator />

        {/* Chat list */}
        <div className="flex-1 min-h-0">
          <ChatList
            chats={chats}
            selectedId={currentChatId}
            onSelect={onSelectChat}
            onCreateNew={onCreateChat}
            onArchive={onArchiveChat}
            onDelete={onDeleteChat}
            onRename={onRenameChat}
          />
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 border-t border-border p-3">
          {/* Service status summary */}
          <button
            onClick={onOpenHealth}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-muted/50 transition-colors mb-2"
          >
            <Activity className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground flex-1 text-left">
              Services
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">
                {connectedCount}/{totalServices}
              </span>
              <StatusIndicator
                status={
                  connectedCount === totalServices
                    ? 'connected'
                    : connectedCount > 0
                      ? 'checking'
                      : 'disconnected'
                }
              />
            </div>
          </button>

          {/* Gallery button */}
          {onOpenGallery && (
            <Button
              variant="ghost"
              onClick={onOpenGallery}
              className="w-full justify-start gap-2 mb-1"
            >
              <ImageIcon className="h-4 w-4" />
              Image Gallery
            </Button>
          )}

          {/* Logs button */}
          {onOpenLogs && (
            <Button
              variant="ghost"
              onClick={onOpenLogs}
              className="w-full justify-start gap-2 mb-1"
            >
              <ScrollText className="h-4 w-4" />
              Activity Log
            </Button>
          )}

          {/* Skills button - navigates to skills management page */}
          <Button
            variant="ghost"
            onClick={() => router.push('/skills')}
            className="w-full justify-start gap-2 mb-1"
          >
            <Blocks className="h-4 w-4" />
            Skills
          </Button>

          {/* Settings button - navigates to full settings page */}
          <Button
            variant="ghost"
            onClick={() => router.push('/settings')}
            className="w-full justify-start gap-2"
          >
            <Settings className="h-4 w-4" />
            Settings
          </Button>
        </div>
      </aside>
    </>
  );
}
