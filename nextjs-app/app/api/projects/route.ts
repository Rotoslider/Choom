import { NextRequest, NextResponse } from 'next/server';
import { ProjectService } from '@/lib/project-service';
import { WORKSPACE_ROOT } from '@/lib/config';

/** GET — list all projects */
export async function GET() {
  try {
    const service = new ProjectService(WORKSPACE_ROOT);
    const projects = await service.listProjects();
    return NextResponse.json({ success: true, projects });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/** POST — create a new project */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, description, status, maxIterations } = body;

    if (!name || typeof name !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Project name is required' },
        { status: 400 }
      );
    }

    // Sanitize folder name
    const folderName = name.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
    if (!folderName) {
      return NextResponse.json(
        { success: false, error: 'Invalid project name' },
        { status: 400 }
      );
    }

    const service = new ProjectService(WORKSPACE_ROOT);
    const project = await service.createProject(folderName, {
      name: folderName,
      description,
      status: status || 'active',
      maxIterations: maxIterations || undefined,
    });

    return NextResponse.json({ success: true, project });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/** PATCH — update project metadata */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { folder, ...updates } = body;

    if (!folder || typeof folder !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Project folder name is required' },
        { status: 400 }
      );
    }

    const service = new ProjectService(WORKSPACE_ROOT);
    const existing = await service.getProject(folder);
    if (!existing) {
      return NextResponse.json(
        { success: false, error: `Project "${folder}" not found` },
        { status: 404 }
      );
    }

    const metadata = await service.updateProjectMetadata(folder, updates);
    return NextResponse.json({ success: true, metadata });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/** DELETE — delete a project and its folder */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const folder = searchParams.get('folder');

    if (!folder) {
      return NextResponse.json(
        { success: false, error: 'folder query parameter is required' },
        { status: 400 }
      );
    }

    const service = new ProjectService(WORKSPACE_ROOT);
    const existing = await service.getProject(folder);
    if (!existing) {
      return NextResponse.json(
        { success: false, error: `Project "${folder}" not found` },
        { status: 404 }
      );
    }

    await service.deleteProject(folder);
    return NextResponse.json({ success: true, message: `Project "${folder}" deleted` });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
