'use client';

import { useEffect, useState } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAppStore } from '@/lib/store';

export function Providers({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const settings = useAppStore((state) => state.settings);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    // Apply theme
    const root = document.documentElement;
    const theme = settings.appearance.theme;

    if (theme === 'system') {
      const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.toggle('dark', systemDark);
    } else {
      root.classList.toggle('dark', theme === 'dark');
    }
  }, [mounted, settings.appearance.theme]);

  // Prevent hydration mismatch by not rendering until mounted
  if (!mounted) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#0f0f14' }}>
        <div className="text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full animate-pulse" style={{ background: 'linear-gradient(135deg, #9333ea 0%, #ec4899 50%, #3b82f6 100%)' }} />
          <p style={{ color: '#a78bfa' }}>Loading Choom...</p>
        </div>
      </div>
    );
  }

  return <TooltipProvider>{children}</TooltipProvider>;
}
