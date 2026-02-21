'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { User } from 'lucide-react';

interface AvatarDisplayProps {
  name?: string | null;
  avatarUrl?: string | null;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showGlow?: boolean;
  className?: string;
}

const sizeClasses = {
  sm: 'w-8 h-8',
  md: 'w-12 h-12',
  lg: 'w-16 h-16',
  xl: 'w-24 h-24',
};

const iconSizes = {
  sm: 'w-4 h-4',
  md: 'w-6 h-6',
  lg: 'w-8 h-8',
  xl: 'w-12 h-12',
};

export function AvatarDisplay({
  name,
  avatarUrl,
  size = 'md',
  showGlow = false,
  className,
}: AvatarDisplayProps) {
  const initials = name
    ? name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : null;

  return (
    <div
      className={cn(
        'relative rounded-full flex items-center justify-center overflow-hidden',
        sizeClasses[size],
        showGlow && 'avatar-glow',
        className
      )}
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={name || 'Avatar'}
          className="w-full h-full object-cover"
        />
      ) : initials ? (
        <div className="w-full h-full bg-gradient-primary flex items-center justify-center">
          <span
            className={cn(
              'font-semibold text-white',
              size === 'sm' && 'text-xs',
              size === 'md' && 'text-sm',
              size === 'lg' && 'text-lg',
              size === 'xl' && 'text-2xl'
            )}
          >
            {initials}
          </span>
        </div>
      ) : (
        <div className="w-full h-full bg-muted flex items-center justify-center">
          <User className={cn('text-muted-foreground', iconSizes[size])} />
        </div>
      )}

      {/* Glow effect overlay */}
      {showGlow && (
        <div className="absolute inset-0 rounded-full bg-gradient-primary opacity-20 blur-md -z-10 scale-110" />
      )}
    </div>
  );
}
