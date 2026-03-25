/**
 * Token Usage Tracking Integration Test
 *
 * Tests the Prisma model, API route, and data aggregation.
 * Run: npx tsx scripts/test-token-usage.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

async function cleanup() {
  await prisma.tokenUsage.deleteMany({
    where: { choomName: { contains: '__TEST__' } },
  });
}

async function testPrismaModel() {
  console.log('\n🧪 Test 1: Prisma Model (CRUD)');

  const entry = await prisma.tokenUsage.create({
    data: {
      choomId: 'test-choom-1',
      choomName: '__TEST__ Genesis',
      chatId: 'test-chat-1',
      model: 'qwen2.5-32b',
      provider: 'local',
      endpoint: 'http://localhost:1234/v1',
      promptTokens: 5000,
      completionTokens: 1500,
      totalTokens: 6500,
      iterations: 3,
      toolCalls: 2,
      toolNames: JSON.stringify(['web_search', 'remember']),
      durationMs: 4500,
      source: 'chat',
    },
  });
  assert(!!entry.id, 'Created token usage entry');
  assert(entry.promptTokens === 5000, 'Prompt tokens correct');
  assert(entry.totalTokens === 6500, 'Total tokens correct');
  assert(entry.provider === 'local', 'Provider correct');

  const found = await prisma.tokenUsage.findUnique({ where: { id: entry.id } });
  assert(found !== null, 'Can read by ID');
  assert(found?.model === 'qwen2.5-32b', 'Model matches');

  await prisma.tokenUsage.delete({ where: { id: entry.id } });
  const deleted = await prisma.tokenUsage.findUnique({ where: { id: entry.id } });
  assert(deleted === null, 'Deleted successfully');
}

async function testAggregation() {
  console.log('\n🧪 Test 2: Aggregation');

  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  // Create test data: 2 chooms, 2 models, 2 providers
  await prisma.tokenUsage.createMany({
    data: [
      {
        choomId: 'test-choom-1', choomName: '__TEST__ Genesis',
        model: 'qwen2.5-32b', provider: 'local',
        promptTokens: 3000, completionTokens: 1000, totalTokens: 4000,
        iterations: 2, toolCalls: 1, durationMs: 3000, source: 'chat',
        timestamp: now,
      },
      {
        choomId: 'test-choom-1', choomName: '__TEST__ Genesis',
        model: 'qwen2.5-32b', provider: 'local',
        promptTokens: 2000, completionTokens: 800, totalTokens: 2800,
        iterations: 1, toolCalls: 0, durationMs: 2000, source: 'chat',
        timestamp: yesterday,
      },
      {
        choomId: 'test-choom-2', choomName: '__TEST__ Aloy',
        model: 'claude-3-5-sonnet', provider: 'anthropic',
        promptTokens: 8000, completionTokens: 3000, totalTokens: 11000,
        iterations: 4, toolCalls: 3, durationMs: 8000, source: 'delegation',
        timestamp: now,
      },
      {
        choomId: 'test-choom-1', choomName: '__TEST__ Genesis',
        model: 'qwen2.5-32b', provider: 'local',
        promptTokens: 1500, completionTokens: 500, totalTokens: 2000,
        iterations: 1, toolCalls: 0, durationMs: 1500, source: 'heartbeat',
        timestamp: now,
      },
    ],
  });

  // Aggregate
  const entries = await prisma.tokenUsage.findMany({
    where: { choomName: { contains: '__TEST__' } },
  });

  assert(entries.length === 4, `4 test entries created (got ${entries.length})`);

  // By choom
  const byChoom: Record<string, number> = {};
  for (const e of entries) {
    byChoom[e.choomName] = (byChoom[e.choomName] || 0) + e.totalTokens;
  }
  assert(byChoom['__TEST__ Genesis'] === 8800, `Genesis total: 8800 (got ${byChoom['__TEST__ Genesis']})`);
  assert(byChoom['__TEST__ Aloy'] === 11000, `Aloy total: 11000 (got ${byChoom['__TEST__ Aloy']})`);

  // By model
  const byModel: Record<string, number> = {};
  for (const e of entries) {
    byModel[e.model] = (byModel[e.model] || 0) + e.totalTokens;
  }
  assert(byModel['qwen2.5-32b'] === 8800, `Qwen total: 8800 (got ${byModel['qwen2.5-32b']})`);
  assert(byModel['claude-3-5-sonnet'] === 11000, `Claude total: 11000 (got ${byModel['claude-3-5-sonnet']})`);

  // By provider
  const byProvider: Record<string, number> = {};
  for (const e of entries) {
    byProvider[e.provider] = (byProvider[e.provider] || 0) + e.totalTokens;
  }
  assert(byProvider['local'] === 8800, `Local total: 8800 (got ${byProvider['local']})`);
  assert(byProvider['anthropic'] === 11000, `Anthropic total: 11000 (got ${byProvider['anthropic']})`);

  // By source
  const bySource: Record<string, number> = {};
  for (const e of entries) {
    bySource[e.source] = (bySource[e.source] || 0) + e.totalTokens;
  }
  assert(bySource['chat'] === 6800, `Chat total: 6800 (got ${bySource['chat']})`);
  assert(bySource['delegation'] === 11000, `Delegation total: 11000 (got ${bySource['delegation']})`);
  assert(bySource['heartbeat'] === 2000, `Heartbeat total: 2000 (got ${bySource['heartbeat']})`);

  // Totals
  const totalTokens = entries.reduce((s, e) => s + e.totalTokens, 0);
  assert(totalTokens === 19800, `Grand total: 19800 (got ${totalTokens})`);

  const totalDuration = entries.reduce((s, e) => s + (e.durationMs || 0), 0);
  assert(totalDuration === 14500, `Total duration: 14500ms (got ${totalDuration})`);

  const totalToolCalls = entries.reduce((s, e) => s + e.toolCalls, 0);
  assert(totalToolCalls === 4, `Total tool calls: 4 (got ${totalToolCalls})`);
}

async function testIndexes() {
  console.log('\n🧪 Test 3: Index Queries');

  // Query by choomId
  const byChoom = await prisma.tokenUsage.findMany({
    where: { choomId: 'test-choom-1', choomName: { contains: '__TEST__' } },
  });
  assert(byChoom.length === 3, `ChoomId filter: 3 entries (got ${byChoom.length})`);

  // Query by model
  const byModel = await prisma.tokenUsage.findMany({
    where: { model: 'claude-3-5-sonnet', choomName: { contains: '__TEST__' } },
  });
  assert(byModel.length === 1, `Model filter: 1 entry (got ${byModel.length})`);

  // Query by provider
  const byProvider = await prisma.tokenUsage.findMany({
    where: { provider: 'anthropic', choomName: { contains: '__TEST__' } },
  });
  assert(byProvider.length === 1, `Provider filter: 1 entry (got ${byProvider.length})`);

  // Query by source
  const bySource = await prisma.tokenUsage.findMany({
    where: { source: 'heartbeat', choomName: { contains: '__TEST__' } },
  });
  assert(bySource.length === 1, `Source filter: 1 entry (got ${bySource.length})`);
}

async function testApiRoute() {
  console.log('\n🧪 Test 4: API Route (if server is running)');

  try {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

    const statsRes = await fetch(`${baseUrl}/api/token-usage?action=stats&period=month`);
    if (statsRes.ok) {
      const data = await statsRes.json();
      assert(data.success === true, 'API stats endpoint returns success');
      assert(typeof data.data.totalTokens === 'number', 'Stats has totalTokens');
      assert(typeof data.data.byChoom === 'object', 'Stats has byChoom breakdown');
      assert(typeof data.data.byModel === 'object', 'Stats has byModel breakdown');
      assert(typeof data.data.daily === 'object', 'Stats has daily breakdown');
    } else {
      console.log('  ⚠️  API server not running — skipping API tests');
    }

    const filtersRes = await fetch(`${baseUrl}/api/token-usage?action=filters`);
    if (filtersRes.ok) {
      const data = await filtersRes.json();
      assert(data.success === true, 'API filters endpoint returns success');
      assert(Array.isArray(data.data.chooms), 'Filters has chooms array');
      assert(Array.isArray(data.data.models), 'Filters has models array');
    }
  } catch {
    console.log('  ⚠️  API server not reachable — skipping API tests');
  }
}

async function main() {
  console.log('========================================');
  console.log('  Token Usage Tracking Integration Tests');
  console.log('========================================');

  try {
    await testPrismaModel();
    await testAggregation();
    await testIndexes();
    await testApiRoute();
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }

  console.log('\n========================================');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('========================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
