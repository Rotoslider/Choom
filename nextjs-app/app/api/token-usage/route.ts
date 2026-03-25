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

      const byChoom: Record<string, { name: string; prompt: number; completion: number; total: number; requests: number }> = {};
      const byModel: Record<string, { prompt: number; completion: number; total: number; requests: number }> = {};
      const byProvider: Record<string, { prompt: number; completion: number; total: number; requests: number }> = {};
      const bySource: Record<string, { prompt: number; completion: number; total: number; requests: number }> = {};
      const daily: Record<string, { prompt: number; completion: number; total: number; requests: number }> = {};

      for (const e of entries) {
        totalPrompt += e.promptTokens;
        totalCompletion += e.completionTokens;
        totalTokens += e.totalTokens;
        totalDuration += e.durationMs || 0;
        totalIterations += e.iterations;
        totalToolCalls += e.toolCalls;

        // By Choom
        if (!byChoom[e.choomId]) byChoom[e.choomId] = { name: e.choomName, prompt: 0, completion: 0, total: 0, requests: 0 };
        byChoom[e.choomId].prompt += e.promptTokens;
        byChoom[e.choomId].completion += e.completionTokens;
        byChoom[e.choomId].total += e.totalTokens;
        byChoom[e.choomId].requests++;

        // By Model
        if (!byModel[e.model]) byModel[e.model] = { prompt: 0, completion: 0, total: 0, requests: 0 };
        byModel[e.model].prompt += e.promptTokens;
        byModel[e.model].completion += e.completionTokens;
        byModel[e.model].total += e.totalTokens;
        byModel[e.model].requests++;

        // By Provider
        if (!byProvider[e.provider]) byProvider[e.provider] = { prompt: 0, completion: 0, total: 0, requests: 0 };
        byProvider[e.provider].prompt += e.promptTokens;
        byProvider[e.provider].completion += e.completionTokens;
        byProvider[e.provider].total += e.totalTokens;
        byProvider[e.provider].requests++;

        // By Source
        if (!bySource[e.source]) bySource[e.source] = { prompt: 0, completion: 0, total: 0, requests: 0 };
        bySource[e.source].prompt += e.promptTokens;
        bySource[e.source].completion += e.completionTokens;
        bySource[e.source].total += e.totalTokens;
        bySource[e.source].requests++;

        // Daily
        const dayKey = e.timestamp.toISOString().slice(0, 10);
        if (!daily[dayKey]) daily[dayKey] = { prompt: 0, completion: 0, total: 0, requests: 0 };
        daily[dayKey].prompt += e.promptTokens;
        daily[dayKey].completion += e.completionTokens;
        daily[dayKey].total += e.totalTokens;
        daily[dayKey].requests++;
      }

      return NextResponse.json({
        success: true,
        data: {
          totalRequests: entries.length,
          totalPromptTokens: totalPrompt,
          totalCompletionTokens: totalCompletion,
          totalTokens,
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
