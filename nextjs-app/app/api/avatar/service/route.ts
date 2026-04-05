import { NextRequest, NextResponse } from 'next/server';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';

const SERVICE_DIR = path.join(process.cwd(), 'services', 'avatar-service');
const MUSETALK_VENV = '/home/nuc1/projects/MuseTalk/venv/bin/activate';
const AVATAR_SERVICE_URL = process.env.AVATAR_SERVICE_URL || 'http://127.0.0.1:8020';

let serviceProcess: ChildProcess | null = null;

async function isServiceRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${AVATAR_SERVICE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * GET /api/avatar/service — check service status
 */
export async function GET() {
  const running = await isServiceRunning();
  return NextResponse.json({
    running,
    managed: serviceProcess !== null,
    pid: serviceProcess?.pid || null,
  });
}

/**
 * POST /api/avatar/service — start or stop the service
 * Body: { action: "start" | "stop" }
 */
export async function POST(request: NextRequest) {
  const { action } = await request.json();

  if (action === 'start') {
    // Check if already running
    if (await isServiceRunning()) {
      return NextResponse.json({ success: true, message: 'Already running' });
    }

    // Kill any existing managed process
    if (serviceProcess) {
      serviceProcess.kill();
      serviceProcess = null;
    }

    // Spawn the service
    const cmd = `source ${MUSETALK_VENV} && cd ${SERVICE_DIR} && python3 main.py`;
    serviceProcess = spawn('bash', ['-c', cmd], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serviceProcess.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`[avatar-service] ${line}`);
    });

    serviceProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line && !line.includes('DeprecationWarning')) {
        console.error(`[avatar-service] ${line}`);
      }
    });

    serviceProcess.on('exit', (code) => {
      console.log(`[avatar-service] Exited with code ${code}`);
      serviceProcess = null;
    });

    // Wait for service to be ready (up to 15s)
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await isServiceRunning()) {
        return NextResponse.json({ success: true, message: 'Started', pid: serviceProcess?.pid });
      }
    }

    return NextResponse.json({ success: false, message: 'Timeout waiting for service to start' }, { status: 500 });

  } else if (action === 'stop') {
    if (serviceProcess) {
      serviceProcess.kill();
      serviceProcess = null;
    }

    // Also try to kill any orphaned service on the port
    try {
      const { execSync } = require('child_process');
      execSync('fuser -k 8020/tcp 2>/dev/null', { timeout: 3000 });
    } catch {}

    return NextResponse.json({ success: true, message: 'Stopped' });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
