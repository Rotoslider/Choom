import { NextRequest } from 'next/server';
import { HomeAssistantService, type HomeAssistantSettings } from '@/lib/homeassistant-service';

/**
 * Proxy API for Home Assistant — avoids browser CORS issues.
 *
 * GET /api/homeassistant?action=test&baseUrl=...&accessToken=...
 * GET /api/homeassistant?action=entities&baseUrl=...&accessToken=...
 * GET /api/homeassistant?action=state&baseUrl=...&accessToken=...&entity_id=...
 * GET /api/homeassistant?action=history&baseUrl=...&accessToken=...&entity_id=...&hours=24
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const action = params.get('action') || 'test';
  const baseUrl = params.get('baseUrl') || '';
  const accessToken = params.get('accessToken') || '';

  if (!baseUrl || !accessToken) {
    return Response.json({ success: false, error: 'baseUrl and accessToken are required' }, { status: 400 });
  }

  const settings: HomeAssistantSettings = {
    baseUrl,
    accessToken,
    entityFilter: params.get('entityFilter') || '',
    injectIntoPrompt: false,
    promptEntities: '',
    cacheSeconds: 30,
  };

  const ha = new HomeAssistantService(settings);

  try {
    switch (action) {
      case 'test': {
        const result = await ha.testConnection();
        return Response.json({ success: true, ...result });
      }

      case 'entities': {
        const domain = params.get('domain') || undefined;
        const area = params.get('area') || undefined;
        const entities = await ha.listStates(domain, area);
        const list = entities.map(e => ({
          entity_id: e.entity_id,
          friendly_name: String(e.attributes.friendly_name || e.entity_id),
          state: e.state,
          domain: e.entity_id.split('.')[0],
        }));
        return Response.json({ success: true, count: list.length, entities: list });
      }

      case 'state': {
        const entityId = params.get('entity_id');
        if (!entityId) return Response.json({ success: false, error: 'entity_id required' }, { status: 400 });
        const entity = await ha.getState(entityId);
        return Response.json({ success: true, entity });
      }

      case 'history': {
        const entityId = params.get('entity_id');
        if (!entityId) return Response.json({ success: false, error: 'entity_id required' }, { status: 400 });
        const hours = parseInt(params.get('hours') || '24');
        const summary = await ha.getHistory(entityId, hours);
        return Response.json({ success: true, summary });
      }

      default:
        return Response.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return Response.json({ success: false, error: msg }, { status: 500 });
  }
}
