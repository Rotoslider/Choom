import { PrismaClient } from '@prisma/client';

// Prevent multiple instances of Prisma Client in development
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Only log errors and warnings, not every query
    log: ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Clean orphaned records that bypass Prisma's cascade (e.g. direct SQLite inserts).
// Runs once per process startup. Prevents Prisma Studio crashes from dangling FKs.
const cleanupKey = Symbol.for('prisma_orphan_cleanup_done');
if (!(globalThis as Record<symbol, boolean>)[cleanupKey]) {
  (globalThis as Record<symbol, boolean>)[cleanupKey] = true;
  prisma.$executeRawUnsafe(
    `DELETE FROM Message WHERE chatId NOT IN (SELECT id FROM Chat)`
  ).then((count: number) => {
    if (count > 0) console.log(`   🧹 Cleaned ${count} orphaned Message rows`);
  }).catch(() => { /* table may not exist yet */ });
}

export default prisma;
