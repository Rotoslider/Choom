import { NextRequest, NextResponse } from 'next/server';

const DEFAULT_IMAGE_GEN_ENDPOINT = process.env.IMAGE_GEN_ENDPOINT || 'http://localhost:7860';

// Checkpoint type detection based on name patterns
function detectCheckpointType(name: string): 'pony' | 'flux' | 'other' {
  const nameLower = name.toLowerCase();
  if (nameLower.includes('pony') || nameLower.includes('pdxl')) {
    return 'pony';
  }
  if (nameLower.includes('flux')) {
    return 'flux';
  }
  return 'other';
}

// LoRA category detection based on path/folder
function detectLoraCategory(path: string, name: string): 'pony' | 'flux' | 'other' {
  const pathLower = (path || name).toLowerCase();
  // Check path for folder indicators
  if (pathLower.includes('/pony/') || pathLower.includes('\\pony\\') || pathLower.startsWith('pony/') || pathLower.startsWith('pony\\')) {
    return 'pony';
  }
  if (pathLower.includes('/flux/') || pathLower.includes('\\flux\\') || pathLower.startsWith('flux/') || pathLower.startsWith('flux\\')) {
    return 'flux';
  }
  // Also check if the path or name contains the type
  if (pathLower.includes('pony')) {
    return 'pony';
  }
  if (pathLower.includes('flux')) {
    return 'flux';
  }
  return 'other';
}

interface Checkpoint {
  id: string;
  name: string;
  type: 'pony' | 'flux' | 'other';
}

interface LoRA {
  id: string;
  name: string;
  path: string;
  category: 'pony' | 'flux' | 'other';
}

interface Scheduler {
  id: string;
  name: string;
}

// GET /api/services/checkpoints - Fetch available SD checkpoints and LoRAs
export async function GET(request: NextRequest) {
  // Get endpoint from query param or use default
  const { searchParams } = new URL(request.url);
  const endpoint = searchParams.get('endpoint') || DEFAULT_IMAGE_GEN_ENDPOINT;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    // Fetch checkpoints
    const checkpointsPromise = fetch(`${endpoint}/sdapi/v1/sd-models`, {
      method: 'GET',
      signal: controller.signal,
    });

    // Fetch LoRAs
    const lorasPromise = fetch(`${endpoint}/sdapi/v1/loras`, {
      method: 'GET',
      signal: controller.signal,
    });

    // Fetch samplers
    const samplersPromise = fetch(`${endpoint}/sdapi/v1/samplers`, {
      method: 'GET',
      signal: controller.signal,
    });

    // Fetch schedulers (if available)
    const schedulersPromise = fetch(`${endpoint}/sdapi/v1/schedulers`, {
      method: 'GET',
      signal: controller.signal,
    });

    const [checkpointsRes, lorasRes, samplersRes, schedulersRes] = await Promise.allSettled([
      checkpointsPromise,
      lorasPromise,
      samplersPromise,
      schedulersPromise,
    ]);

    clearTimeout(timeout);

    const checkpoints: Checkpoint[] = [];
    const loras: LoRA[] = [];
    const samplers: { id: string; name: string }[] = [];
    const schedulers: Scheduler[] = [];

    // Parse checkpoints with type detection
    if (checkpointsRes.status === 'fulfilled' && checkpointsRes.value.ok) {
      const data = await checkpointsRes.value.json();
      if (Array.isArray(data)) {
        data.forEach((m: { title?: string; model_name?: string; name?: string; filename?: string }) => {
          const id = m.title || m.model_name || m.name || '';
          const name = m.model_name || m.name || m.title || '';
          const filename = m.filename || m.title || '';
          if (id) {
            checkpoints.push({
              id,
              name,
              type: detectCheckpointType(filename || name),
            });
          }
        });
      }
    }

    // Parse LoRAs with category detection - return ALL of them
    if (lorasRes.status === 'fulfilled' && lorasRes.value.ok) {
      const data = await lorasRes.value.json();
      if (Array.isArray(data)) {
        data.forEach((l: { name?: string; alias?: string; path?: string }) => {
          const id = l.name || l.alias || '';
          const name = l.alias || l.name || '';
          const path = l.path || l.name || '';
          if (id) {
            loras.push({
              id,
              name,
              path,
              category: detectLoraCategory(path, name),
            });
          }
        });
      }
    }

    // Parse samplers
    if (samplersRes.status === 'fulfilled' && samplersRes.value.ok) {
      const data = await samplersRes.value.json();
      if (Array.isArray(data)) {
        data.forEach((s: { name?: string }) => {
          if (s.name) {
            samplers.push({ id: s.name, name: s.name });
          }
        });
      }
    }

    // Parse schedulers
    if (schedulersRes.status === 'fulfilled' && schedulersRes.value.ok) {
      const data = await schedulersRes.value.json();
      if (Array.isArray(data)) {
        data.forEach((s: { name?: string; label?: string }) => {
          const name = s.name || s.label || '';
          if (name) {
            schedulers.push({ id: name, name: s.label || name });
          }
        });
      }
    }

    return NextResponse.json({
      checkpoints,
      loras,
      samplers,
      schedulers,
      // Summary counts for debugging
      counts: {
        checkpoints: checkpoints.length,
        loras: loras.length,
        ponyLoras: loras.filter(l => l.category === 'pony').length,
        fluxLoras: loras.filter(l => l.category === 'flux').length,
        otherLoras: loras.filter(l => l.category === 'other').length,
        samplers: samplers.length,
        schedulers: schedulers.length,
      },
    });
  } catch (error) {
    console.error('Failed to fetch image gen options:', error);
    return NextResponse.json(
      { error: 'Service unavailable', checkpoints: [], loras: [], samplers: [], schedulers: [], counts: {} },
      { status: 503 }
    );
  }
}
