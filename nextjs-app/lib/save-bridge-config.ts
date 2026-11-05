/**
 * Save a change to the server's bridge-config.json from a settings tab.
 *
 * The server takes a change without asking only from a browser on the machine running the app
 * (localhost); any other device gets 412 until it resends with `x-confirm-remote-write: yes`
 * (app/api/bridge-config/route.ts). The YouTube, Heartbeats and Scheduled Tasks tabs ignored the
 * 412, so from Brave on the NUC their switches did nothing at all, with no word why (2026-11-05:
 * ten refused YouTube channel toggles in the log). This asks once, then sends it confirmed, and
 * says so when a save fails.
 */
export type SaveBridgeConfigResult =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; error: string };

export interface SaveBridgeConfigOptions {
  /** What is being changed, for the question: "YouTube channels". */
  what: string;
  /** Asks the person; window.confirm by default. */
  confirm?: (question: string) => boolean;
  fetchImpl?: typeof fetch;
}

// Asked once per page visit: some fields save on every keystroke (number and time boxes), and a
// question per keystroke would be no use. A reload asks again.
let confirmedThisVisit = false;

export function resetSaveConfirmation(): void {
  confirmedThisVisit = false;
}

export async function saveBridgeConfig(
  payload: Record<string, unknown>,
  { what, confirm, fetchImpl }: SaveBridgeConfigOptions,
): Promise<SaveBridgeConfigResult> {
  const doFetch = fetchImpl ?? fetch;
  const ask = confirm ?? ((q: string) => window.confirm(q));
  const post = (confirmed: boolean) => doFetch('/api/bridge-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(confirmed ? { 'x-confirm-remote-write': 'yes' } : {}) },
    body: JSON.stringify(payload),
  });
  try {
    let res = await post(confirmedThisVisit);
    if (res.status === 412) {
      if (!ask(`You're on another device than the server, so it asks first.\n\nSave this change to the server's settings (${what})? Further changes on this page save without asking until you reload it.`)) {
        return { ok: false, cancelled: true };
      }
      confirmedThisVisit = true;
      res = await post(true);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({} as Record<string, unknown>));
      return { ok: false, error: String(body.message || body.error || `HTTP ${res.status}`) };
    }
    return { ok: true, config: await res.json() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The tabs' failure message: an alert naming what didn't save. Cancelling says nothing. */
export function reportSaveFailure(result: SaveBridgeConfigResult, what: string): void {
  if (!result.ok && !result.cancelled) {
    window.alert(`Could not save the ${what} setting: ${result.error}`);
  }
}
