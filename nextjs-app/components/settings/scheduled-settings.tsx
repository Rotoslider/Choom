'use client';

import React, { useState, useEffect } from 'react';
import { Clock, Calendar, Bell, Sun, Zap, RefreshCw, CheckCircle, XCircle } from 'lucide-react';
import { Switch } from '@/components/ui/switch';

interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  schedule: string;
  enabled: boolean;
  lastRun?: string;
  icon: React.ReactNode;
}

const defaultTasks: ScheduledTask[] = [
  {
    id: 'morning_briefing',
    name: 'Morning Briefing',
    description: 'Your Choom sends weather, calendar, and system status at 7am',
    schedule: 'Daily at 7:00 AM',
    enabled: true,
    icon: <Sun className="h-4 w-4 text-yellow-500" />,
  },
  {
    id: 'weather_check_07',
    name: 'Weather Check (Morning)',
    description: 'Check weather conditions at 7am',
    schedule: 'Daily at 7:00 AM',
    enabled: true,
    icon: <Clock className="h-4 w-4 text-blue-500" />,
  },
  {
    id: 'weather_check_12',
    name: 'Weather Check (Noon)',
    description: 'Check weather conditions at noon',
    schedule: 'Daily at 12:00 PM',
    enabled: true,
    icon: <Clock className="h-4 w-4 text-blue-500" />,
  },
  {
    id: 'weather_check_18',
    name: 'Weather Check (Evening)',
    description: 'Check weather conditions at 6pm',
    schedule: 'Daily at 6:00 PM',
    enabled: true,
    icon: <Clock className="h-4 w-4 text-blue-500" />,
  },
  {
    id: 'aurora_check_12',
    name: 'Aurora Forecast (Noon)',
    description: 'Check aurora forecast and alert if visible',
    schedule: 'Daily at 12:00 PM',
    enabled: true,
    icon: <Zap className="h-4 w-4 text-purple-500" />,
  },
  {
    id: 'aurora_check_18',
    name: 'Aurora Forecast (Evening)',
    description: 'Check aurora forecast and alert if visible',
    schedule: 'Daily at 6:00 PM',
    enabled: true,
    icon: <Zap className="h-4 w-4 text-purple-500" />,
  },
  {
    id: 'system_health',
    name: 'System Health Check',
    description: 'Check all services and alert on issues',
    schedule: 'Every 30 minutes',
    enabled: true,
    icon: <RefreshCw className="h-4 w-4 text-green-500" />,
  },
];

export function ScheduledSettings() {
  const [tasks, setTasks] = useState<ScheduledTask[]>(defaultTasks);
  const [serviceStatus, setServiceStatus] = useState<'connected' | 'disconnected' | 'checking'>('checking');

  useEffect(() => {
    // Check if signal-bridge is running
    const checkService = async () => {
      try {
        // This would ideally call an API to check the signal-bridge status
        // For now, we assume it's running if the page loads
        setServiceStatus('connected');
      } catch {
        setServiceStatus('disconnected');
      }
    };
    checkService();
  }, []);

  const toggleTask = (taskId: string) => {
    setTasks(tasks.map(task =>
      task.id === taskId ? { ...task, enabled: !task.enabled } : task
    ));
    // In the future, this would call an API to update the signal-bridge config
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50">
        <div className="flex items-center gap-3">
          <Bell className="h-5 w-5 text-primary" />
          <div>
            <h3 className="font-medium">Signal Bridge Status</h3>
            <p className="text-sm text-muted-foreground">
              Scheduled tasks run via the Signal Bridge service
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {serviceStatus === 'connected' ? (
            <>
              <CheckCircle className="h-5 w-5 text-green-500" />
              <span className="text-sm text-green-600">Connected</span>
            </>
          ) : serviceStatus === 'disconnected' ? (
            <>
              <XCircle className="h-5 w-5 text-red-500" />
              <span className="text-sm text-red-600">Disconnected</span>
            </>
          ) : (
            <>
              <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Checking...</span>
            </>
          )}
        </div>
      </div>

      <div>
        <h3 className="text-lg font-medium mb-4 flex items-center gap-2">
          <Calendar className="h-5 w-5" />
          Cron Jobs
        </h3>
        <p className="text-sm text-muted-foreground mb-4">
          These tasks run automatically on a schedule. Toggle to enable/disable.
        </p>

        <div className="space-y-3">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="flex items-center justify-between p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                {task.icon}
                <div>
                  <h4 className="font-medium">{task.name}</h4>
                  <p className="text-sm text-muted-foreground">{task.description}</p>
                  <p className="text-xs text-muted-foreground mt-1">{task.schedule}</p>
                </div>
              </div>
              <Switch
                checked={task.enabled}
                onCheckedChange={() => toggleTask(task.id)}
              />
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-lg font-medium mb-4 flex items-center gap-2">
          <Bell className="h-5 w-5" />
          Quick Commands
        </h3>
        <p className="text-sm text-muted-foreground mb-4">
          Use these commands via Signal to manage tasks:
        </p>

        <div className="grid gap-2 text-sm">
          <div className="p-3 rounded bg-muted/50 font-mono">
            remind me in 30 minutes to check the oven
          </div>
          <div className="p-3 rounded bg-muted/50 font-mono">
            remind me at 3pm to call mom
          </div>
          <div className="p-3 rounded bg-muted/50 font-mono">
            calendar this week
          </div>
          <div className="p-3 rounded bg-muted/50 font-mono">
            add to groceries: milk
          </div>
          <div className="p-3 rounded bg-muted/50 font-mono">
            show groceries
          </div>
        </div>
      </div>
    </div>
  );
}
