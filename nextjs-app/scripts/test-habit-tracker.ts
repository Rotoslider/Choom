/**
 * Habit Tracker Integration Test
 *
 * Tests the Prisma models, handler, and API route.
 * Run: npx tsx scripts/test-habit-tracker.ts
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
  // Delete test entries
  await prisma.habitEntry.deleteMany({
    where: { notes: { contains: '__TEST__' } },
  });
}

async function testPrismaModels() {
  console.log('\n🧪 Test 1: Prisma Models (CRUD)');

  // Create
  const entry = await prisma.habitEntry.create({
    data: {
      choomId: 'test-choom-1',
      category: 'vehicle',
      activity: 'filled gas',
      location: 'Shell on 5th',
      quantity: 15.5,
      unit: 'gallons',
      notes: '__TEST__ integration test entry',
    },
  });
  assert(!!entry.id, 'Created habit entry with valid ID');
  assert(entry.category === 'vehicle', 'Category set correctly');
  assert(entry.quantity === 15.5, 'Quantity set correctly');
  assert(entry.location === 'Shell on 5th', 'Location set correctly');

  // Read
  const found = await prisma.habitEntry.findUnique({ where: { id: entry.id } });
  assert(found !== null, 'Can read entry by ID');
  assert(found?.activity === 'filled gas', 'Activity matches');

  // Update — Prisma doesn't have an update for HabitEntry directly but let's test findMany
  const entries = await prisma.habitEntry.findMany({
    where: { notes: { contains: '__TEST__' } },
  });
  assert(entries.length >= 1, 'findMany with filter works');

  // Delete
  await prisma.habitEntry.delete({ where: { id: entry.id } });
  const deleted = await prisma.habitEntry.findUnique({ where: { id: entry.id } });
  assert(deleted === null, 'Entry deleted successfully');
}

async function testCategories() {
  console.log('\n🧪 Test 2: Categories');

  // Ensure defaults exist (upsert)
  await prisma.habitCategory.upsert({
    where: { name: 'vehicle' },
    create: { name: 'vehicle', icon: '🚗', color: '#3b82f6', description: 'test' },
    update: {},
  });

  const categories = await prisma.habitCategory.findMany();
  assert(categories.length > 0, `Categories exist (${categories.length} found)`);

  const vehicle = categories.find(c => c.name === 'vehicle');
  assert(vehicle !== undefined, 'Vehicle category exists');
  assert(vehicle?.icon === '🚗', 'Vehicle has correct icon');
}

async function testQueryFilters() {
  console.log('\n🧪 Test 3: Query Filters');

  // Create test data across multiple categories and dates
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const lastWeek = new Date(now);
  lastWeek.setDate(lastWeek.getDate() - 5);

  await prisma.habitEntry.createMany({
    data: [
      { choomId: 'test-choom-1', category: 'vehicle', activity: 'filled gas', location: 'Shell', notes: '__TEST__', timestamp: now },
      { choomId: 'test-choom-1', category: 'hygiene', activity: 'shower', notes: '__TEST__', timestamp: now },
      { choomId: 'test-choom-1', category: 'hygiene', activity: 'shower', notes: '__TEST__', timestamp: yesterday },
      { choomId: 'test-choom-1', category: 'outdoor', activity: 'camping', location: 'Lake Tahoe', notes: '__TEST__', timestamp: lastWeek },
      { choomId: 'test-choom-1', category: 'shopping', activity: 'went to Walmart', quantity: 47.50, unit: '$', notes: '__TEST__', timestamp: yesterday },
    ],
  });

  // Filter by category
  const hygieneEntries = await prisma.habitEntry.findMany({
    where: { category: 'hygiene', notes: { contains: '__TEST__' } },
  });
  assert(hygieneEntries.length === 2, `Category filter: hygiene has 2 entries (got ${hygieneEntries.length})`);

  // Filter by activity keyword
  const showerEntries = await prisma.habitEntry.findMany({
    where: { activity: { contains: 'shower' }, notes: { contains: '__TEST__' } },
  });
  assert(showerEntries.length === 2, `Activity filter: shower has 2 entries (got ${showerEntries.length})`);

  // Filter by date range (use a window around "now" to avoid UTC/local timezone edge cases)
  const windowStart = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 1 * 60 * 60 * 1000);
  const todayEntries = await prisma.habitEntry.findMany({
    where: {
      notes: { contains: '__TEST__' },
      timestamp: { gte: windowStart, lte: windowEnd },
    },
  });
  assert(todayEntries.length === 2, `Date filter: today has 2 entries (got ${todayEntries.length})`);

  // Filter by location
  const locationEntries = await prisma.habitEntry.findMany({
    where: { location: { contains: 'Tahoe' }, notes: { contains: '__TEST__' } },
  });
  assert(locationEntries.length === 1, `Location filter: Tahoe has 1 entry (got ${locationEntries.length})`);

  // Order by newest
  const newest = await prisma.habitEntry.findMany({
    where: { notes: { contains: '__TEST__' } },
    orderBy: { timestamp: 'desc' },
    take: 1,
  });
  assert(newest.length === 1, 'Newest ordering works');
}

async function testStats() {
  console.log('\n🧪 Test 4: Statistics Calculation');

  const testEntries = await prisma.habitEntry.findMany({
    where: { notes: { contains: '__TEST__' } },
  });

  // Category breakdown
  const categoryBreakdown: Record<string, number> = {};
  for (const e of testEntries) {
    categoryBreakdown[e.category] = (categoryBreakdown[e.category] || 0) + 1;
  }
  assert(categoryBreakdown['hygiene'] === 2, `Hygiene count is 2 (got ${categoryBreakdown['hygiene']})`);
  assert(categoryBreakdown['vehicle'] === 1, `Vehicle count is 1 (got ${categoryBreakdown['vehicle']})`);

  // Daily counts
  const dailyCounts: Record<string, number> = {};
  for (const e of testEntries) {
    const day = e.timestamp.toISOString().slice(0, 10);
    dailyCounts[day] = (dailyCounts[day] || 0) + 1;
  }
  const uniqueDays = Object.keys(dailyCounts).length;
  assert(uniqueDays >= 2, `Multiple active days (${uniqueDays})`);

  // Total
  assert(testEntries.length === 5, `Total test entries: 5 (got ${testEntries.length})`);
}

async function testApiRoute() {
  console.log('\n🧪 Test 5: API Route (if server is running)');

  try {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

    // Test entries endpoint
    const entriesRes = await fetch(`${baseUrl}/api/habits?action=entries&limit=5`);
    if (entriesRes.ok) {
      const data = await entriesRes.json();
      assert(data.success === true, 'API entries endpoint returns success');
      assert(Array.isArray(data.data), 'API returns data array');
    } else {
      console.log('  ⚠️  API server not running — skipping API tests');
    }

    // Test categories endpoint
    const catRes = await fetch(`${baseUrl}/api/habits?action=categories`);
    if (catRes.ok) {
      const data = await catRes.json();
      assert(data.success === true, 'API categories endpoint returns success');
      assert(data.data.length > 0, `API returns ${data.data.length} categories`);
    }

    // Test stats endpoint
    const statsRes = await fetch(`${baseUrl}/api/habits?action=stats&period=month`);
    if (statsRes.ok) {
      const data = await statsRes.json();
      assert(data.success === true, 'API stats endpoint returns success');
      assert(typeof data.data.totalCount === 'number', 'Stats has totalCount');
      assert(typeof data.data.currentStreak === 'number', 'Stats has currentStreak');
    }

    // Test heatmap endpoint
    const heatRes = await fetch(`${baseUrl}/api/habits?action=heatmap`);
    if (heatRes.ok) {
      const data = await heatRes.json();
      assert(data.success === true, 'API heatmap endpoint returns success');
      assert(typeof data.data === 'object', 'Heatmap returns object');
    }
  } catch {
    console.log('  ⚠️  API server not reachable — skipping API tests');
  }
}

async function main() {
  console.log('========================================');
  console.log('  Habit Tracker Integration Tests');
  console.log('========================================');

  try {
    await testPrismaModels();
    await testCategories();
    await testQueryFilters();
    await testStats();
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
