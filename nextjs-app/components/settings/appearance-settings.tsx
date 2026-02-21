'use client';

import React from 'react';
import { Moon, Sun, Monitor } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';

export function AppearanceSettings() {
  const { settings, updateAppearanceSettings } = useAppStore();
  const appearance = settings.appearance;

  const themeOptions = [
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
    { value: 'system', label: 'System', icon: Monitor },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium mb-4">Appearance</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Customize the look and feel of the application
        </p>
      </div>

      {/* Theme */}
      <div className="space-y-3">
        <label className="text-sm font-medium">Theme</label>
        <div className="grid grid-cols-3 gap-2">
          {themeOptions.map((option) => {
            const Icon = option.icon;
            const isSelected = appearance.theme === option.value;

            return (
              <button
                key={option.value}
                onClick={() =>
                  updateAppearanceSettings({
                    theme: option.value as typeof appearance.theme,
                  })
                }
                className={cn(
                  'flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all',
                  isSelected
                    ? 'border-primary bg-primary/10'
                    : 'border-border hover:border-primary/50'
                )}
              >
                <Icon
                  className={cn(
                    'h-5 w-5',
                    isSelected ? 'text-primary' : 'text-muted-foreground'
                  )}
                />
                <span
                  className={cn(
                    'text-sm',
                    isSelected ? 'text-primary font-medium' : 'text-muted-foreground'
                  )}
                >
                  {option.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Font Size */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Font Size</label>
        <Select
          value={appearance.fontSize}
          onValueChange={(v) =>
            updateAppearanceSettings({ fontSize: v as typeof appearance.fontSize })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="small">Small</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="large">Large</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Animations */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Animations</label>
          <p className="text-xs text-muted-foreground">
            Enable smooth transitions and animations
          </p>
        </div>
        <Switch
          checked={appearance.animationsEnabled}
          onCheckedChange={(checked) =>
            updateAppearanceSettings({ animationsEnabled: checked })
          }
        />
      </div>

      {/* Accent Color Preview */}
      <div className="space-y-3">
        <label className="text-sm font-medium">Accent Color</label>
        <div className="p-4 rounded-lg bg-muted/50">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-lg bg-gradient-primary" />
            <div>
              <p className="text-sm font-medium">Purple-Pink-Blue Gradient</p>
              <p className="text-xs text-muted-foreground">
                The signature Choom color scheme
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
