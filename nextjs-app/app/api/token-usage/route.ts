import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

// =============================================================================
// GET /api/token-usage?action=entries|stats|by-choom|by-model|by-provider|daily
// =============================================================================
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const action = searchParams.get('action') || 'stats';

    // Common filters
    const choomId = searchParams.get('choomId') || undefined;
    const model = searchParams.get('model') || undefined;
    const provider = searchParams.get('provider') || undefined;
    const source = searchParams.get('source') || undefined;
    const dateFrom = searchParams.get('date_from') || undefined;
    const dateTo = searchParams.get('date_to') || undefined;
    const period = searchParams.get('period') || 'month';

    // Build date range
    const now = new Date();
    let periodStart: Date;
    switch (period) {
      case 'day':
        periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'week':
        periodStart = new Date(now);
        periodStart.setDate(periodStart.getDate() - 7);
        break;
      case 'month':
        periodStart = new Date(now);
        periodStart.setMonth(periodStart.getMonth() - 1);
        break;
      case 'year':
        periodStart = new Date(now);
        periodStart.setFullYear(periodStart.getFullYear() - 1);
        break;
      default:
        periodStart = new Date(0);
    }

    const where: Record<string, unknown> = {};
    if (choomId) where.choomId = choomId;
    if (model) where.model = model;
    if (provider) where.provider = provider;
    if (source) where.source = source;
    if (dateFrom) {
      where.timestamp = { ...(where.timestamp as Record<string, unknown> || {}), gte: new Date(dateFrom) };
    } else {
      where.timestamp = { ...(where.timestamp as Record<string, unknown> || {}), gte: periodStart };
    }
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      where.timestamp = { ...(where.timestamp as Record<string, unknown> || {}), lte: end };
    }

    if (action === 'entries') {
      const limit = parseInt(searchParams.get('limit') || '100');
      const entries = await prisma.tokenUsage.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: limit,
      });
      return NextResponse.json({ success: true, data: entries, count: entries.length });
    }

    if (action === 'stats') {
      const entries = await prisma.tokenUsage.findMany({ where });

      let totalPrompt = 0;
      let totalCompletion = 0;
      let totalTokens = 0;
      let totalDuration = 0;
      let totalIterations = 0;
      let totalToolCalls = 0;
      let totalSaved = 0;
      // Prompt cache (2026-10-29): cached = prompt tokens the provider served
      // from its cache; cacheSeen = prompt tokens of the requests whose
      // provider reported it at all, so the share isn't diluted by older rows
      // and by local LM Studio, which keeps its cache numbers to its own log.
      let totalCached = 0;
      let totalCacheSeen = 0;

      type Bucket = { prompt: number; completion: number; total: number; requests: number; cached: number; cacheSeen: number };
      const bucket = (): Bucket => ({ prompt: 0, completion: 0, total: 0, requests: 0, cached: 0, cacheSeen: 0 });
      const byChoom: Record<string, Bucket & { name: string }> = {};
      const byModel: Record<string, Bucket> = {};
      const byProvider: Record<string, Bucket> = {};
      const bySource: Record<string, Bucket> = {};
      const daily: Record<string, Bucket & { saved: number }> = {};

      for (const e of entries) {
        totalPrompt += e.promptTokens;
        totalCompletion += e.completionTokens;
        totalTokens += e.totalTokens;
        totalDuration += e.durationMs || 0;
        totalIterations += e.iterations;
        totalToolCalls += e.toolCalls;
        totalSaved += e.savedTokens || 0;
        const reported = e.cachedPromptTokens !== null;
        if (reported) {
          totalCached += e.cachedPromptTokens!;
          totalCacheSeen += e.promptTokens;
        }

        const dayKey = e.timestamp.toISOString().slice(0, 10);
        if (!byChoom[e.choomId]) byChoom[e.choomId] = { name: e.choomName, ...bucket() };
        if (!byModel[e.model]) byModel[e.model] = bucket();
        if (!byProvider[e.provider]) byProvider[e.provider] = bucket();
        if (!bySource[e.source]) bySource[e.source] = bucket();
        if (!daily[dayKey]) daily[dayKey] = { ...bucket(), saved: 0 };
        for (const b of [byChoom[e.choomId], byModel[e.model], byProvider[e.provider], bySource[e.source], daily[dayKey]] as Bucket[]) {
          b.prompt += e.promptTokens;
          b.completion += e.completionTokens;
          b.total += e.totalTokens;
          b.requests++;
          if (reported) {
            b.cached += e.cachedPromptTokens!;
            b.cacheSeen += e.promptTokens;
          }
        }
        daily[dayKey].saved += e.savedTokens || 0;
      }

      return NextResponse.json({
        success: true,
        data: {
          totalRequests: entries.length,
          totalPromptTokens: totalPrompt,
          totalCompletionTokens: totalCompletion,
          totalTokens,
          totalSavedTokens: totalSaved,
          totalCachedTokens: totalCached,
          totalCacheSeenTokens: totalCacheSeen,
          totalDurationMs: totalDuration,
          totalIterations,
          totalToolCalls,
          avgTokensPerRequest: entries.length > 0 ? Math.round(totalTokens / entries.length) : 0,
          avgDurationMs: entries.length > 0 ? Math.round(totalDuration / entries.length) : 0,
          byChoom,
          byModel,
          byProvider,
          bySource,
          daily,
        },
      });
    }

    // Distinct values for filter dropdowns
    if (action === 'filters') {
      const chooms = await prisma.tokenUsage.findMany({
        distinct: ['choomId'],
        select: { choomId: true, choomName: true },
      });
      const models = await prisma.tokenUsage.findMany({
        distinct: ['model'],
        select: { model: true },
      });
      const providersList = await prisma.tokenUsage.findMany({
        distinct: ['provider'],
        select: { provider: true },
      });
      return NextResponse.json({
        success: true,
        data: {
          chooms: chooms.map(c => ({ id: c.choomId, name: c.choomName })),
          models: models.map(m => m.model),
          providers: providersList.map(p => p.provider),
        },
      });
    }

    return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    console.error('[TokenUsageAPI] Error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
