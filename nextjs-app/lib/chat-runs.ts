/**
 * Replies under way, by Choom and chat. A newer message from Donny in the same chat ends the older
 * reply. On 2026-10-30 a reply to him that fell to the Mac's Qwen with the chat trimmed went 27 rounds
 * about a project from two months before, talking on the glass as Genesis beside her real replies, and
 * the glass opened his reply window whenever either one paused. Nothing could stop it: a reply started
 * at the tower is read to its end by the tower's own route, so it never sees a browser go away.
 *
 * Kept on globalThis so a dev-server hot reload doesn't lose the replies already running.
 */
type Run = { stop: () => void };

const store = globalThis as unknown as { __choomChatRuns?: Map<string, Set<Run>> };
const runs = (store.__choomChatRuns ??= new Map<string, Set<Run>>());

/**
 * Registers a reply. With `takeOver` (a message Donny wrote or said), every older reply in the same
 * chat is stopped first; a note from the house or a scheduled turn never stops his. `finish` is called
 * when the reply ends, however it ends.
 */
export function startChatRun(
  choomId: string, chatId: string, stop: () => void, takeOver: boolean,
): { ended: number; finish: () => void } {
  const key = `${choomId}:${chatId}`;
  const inChat = runs.get(key) ?? new Set<Run>();
  let ended = 0;
  if (takeOver) {
    for (const older of inChat) {
      older.stop();
      ended++;
    }
    inChat.clear();
  }
  const run: Run = { stop };
  inChat.add(run);
  runs.set(key, inChat);
  return {
    ended,
    finish: () => {
      inChat.delete(run);
      if (inChat.size === 0 && runs.get(key) === inChat) runs.delete(key);
    },
  };
}

/** How many replies are under way in a chat (for tests and logs). */
export function chatRunsUnderWay(choomId: string, chatId: string): number {
  return runs.get(`${choomId}:${chatId}`)?.size ?? 0;
}
