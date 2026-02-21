import { NextRequest, NextResponse } from 'next/server';

// Google Tasks API proxy - calls the Signal Bridge's Google client
// This allows the web app to access Google Tasks through the bridge

const SIGNAL_BRIDGE_URL = process.env.SIGNAL_BRIDGE_URL || 'http://localhost:8765';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const action = searchParams.get('action');
  const listName = searchParams.get('list');

  try {
    // For now, return a message that tasks are accessed via Signal
    // In the future, we could add a REST API to the signal bridge

    if (action === 'lists') {
      return NextResponse.json({
        message: 'Task lists are available via Signal commands',
        commands: [
          'my lists - Show all task lists',
          'show groceries - Show items in groceries list',
          'add to groceries: milk - Add item to list',
        ]
      });
    }

    return NextResponse.json({
      message: 'Google Tasks integration',
      available_commands: [
        'my lists',
        'show <list>',
        'add to <list>: <item>',
        'calendar',
        'today',
        'this week calendar'
      ]
    });
  } catch (error) {
    console.error('Tasks API error:', error);
    return NextResponse.json(
      { error: 'Failed to access tasks' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, listName, item } = body;

    // Placeholder - in future could call signal bridge API
    return NextResponse.json({
      message: 'Task operations are handled via Signal Bridge',
      hint: 'Send a message via Signal like: add to groceries: milk'
    });
  } catch (error) {
    console.error('Tasks API error:', error);
    return NextResponse.json(
      { error: 'Failed to process task request' },
      { status: 500 }
    );
  }
}
