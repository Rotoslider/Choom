import { NextResponse } from 'next/server';
import { requestRestart, restartStatus, type RestartMode } from '@/lib/app-restart';

export const dynamic = 'force-dynamic';

// GET /api/restart: where a restart stands (lib/app-restart.ts), for the Restart Choom dialog.
export async function GET() {
  return NextResponse.json(await restartStatus());
}

// POST /api/restart {mode: "now" | "quiet"}: restart the app and its memory server through the
// restart agent. Only from the app's own pages: a request another site's page makes is refused.
export async function POST(request: Request) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    return NextResponse.json({ error: 'refused: this came from another site' }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  const mode = body?.mode;
  if (mode !== 'now' && mode !== 'quiet') {
    return NextResponse.json({ error: 'send {"mode": "now"} or {"mode": "quiet"}' }, { status: 400 });
  }
  const result = await requestRestart(mode as RestartMode);
  console.log(`🔁 Restart Choom asked for from the app (${mode})${result.already ? ': the restart agent was already running' : ''}${result.error ? `: ${result.error}` : ''}`);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
