/**
 * A Choom's wake-up model (Choom.wakeModel / wakeProvider, set in her edit panel).
 *
 * Her own wake-ups (the follow-ups she books for herself and any heartbeat
 * tasks; the bridge sends both with isHeartbeat) can run on a different model
 * from her chats: Opus for talking with Donny, say, and a cheaper model for
 * checking in on her own. It rides the task-override path (Layer 4 in
 * app/api/chat/route.ts), so if it fails her primary model is tried, then her
 * fallbacks. A heartbeat task's own model (Settings → Heartbeats) still wins.
 */
export interface TaskModelOverride {
  model: string;
  provider_id?: string;
  endpoint?: string;
}

export function withWakeModel(
  requested: TaskModelOverride | null | undefined,
  choom: { wakeModel?: string | null; wakeProvider?: string | null },
  isHeartbeat: boolean,
): TaskModelOverride | undefined {
  if (requested?.model) return requested;
  if (!isHeartbeat || !choom.wakeModel) return undefined;
  return choom.wakeProvider
    ? { model: choom.wakeModel, provider_id: choom.wakeProvider }
    : { model: choom.wakeModel };
}
