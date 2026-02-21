'use client';

import React, { useState, useEffect } from 'react';
import { Bell, Trash2, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Reminder {
  id: string;
  text: string;
  remind_at: string;
  created_at: string;
}

export function RemindersSettings() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchReminders = async () => {
    try {
      const res = await fetch('/api/reminders');
      if (res.ok) {
        const data = await res.json();
        setReminders(data);
      }
    } catch (err) {
      console.error('Failed to fetch reminders:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReminders();
  }, []);

  const deleteReminder = async (id: string) => {
    try {
      const res = await fetch(`/api/reminders?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setReminders((prev) => prev.filter((r) => r.id !== id));
      }
    } catch (err) {
      console.error('Failed to delete reminder:', err);
    }
  };

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  const isPast = (iso: string) => {
    try {
      return new Date(iso) < new Date();
    } catch {
      return false;
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-medium mb-2 flex items-center gap-2">
          <Bell className="h-5 w-5" />
          Pending Reminders
        </h3>
        <p className="text-sm text-muted-foreground mb-4">
          Reminders created via Signal. They persist across bridge restarts.
        </p>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading reminders...</div>
      ) : reminders.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <Bell className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p>No pending reminders</p>
          <p className="text-xs mt-1">
            Create one via Signal: &quot;remind me in 30 minutes to check the oven&quot;
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {reminders.map((r) => (
            <div
              key={r.id}
              className={`flex items-center justify-between p-4 rounded-lg border bg-card ${
                isPast(r.remind_at) ? 'opacity-50' : ''
              }`}
            >
              <div className="flex items-start gap-3 flex-1">
                <Clock className="h-4 w-4 mt-0.5 text-primary" />
                <div>
                  <p className="font-medium">{r.text}</p>
                  <p className="text-sm text-muted-foreground">
                    {isPast(r.remind_at) ? 'Expired: ' : 'Fires: '}
                    {formatDate(r.remind_at)}
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => deleteReminder(r.id)}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 pt-4 border-t">
        <h4 className="text-sm font-medium mb-2">Signal Commands</h4>
        <div className="grid gap-2 text-sm">
          <div className="p-3 rounded bg-muted/50 font-mono">remind me in 30 minutes to check the oven</div>
          <div className="p-3 rounded bg-muted/50 font-mono">remind me at 3pm to call mom</div>
          <div className="p-3 rounded bg-muted/50 font-mono">remind me to take out trash in 2 hours</div>
        </div>
      </div>
    </div>
  );
}
