import { NextRequest, NextResponse } from 'next/server';

const AVATAR_SERVICE_URL = process.env.AVATAR_SERVICE_URL || 'http://127.0.0.1:8020';

export async function POST(request: NextRequest) {
  try {
    const { choomId } = await request.json();
    const url = choomId
      ? `${AVATAR_SERVICE_URL}/animate/clear-cache?choom_id=${choomId}`
      : `${AVATAR_SERVICE_URL}/animate/clear-cache`;

    await fetch(url, { method: 'POST' });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false });
  }
}
