/**
 * A throwaway SQLite database built from the live prisma/schema.prisma, so
 * handler tests run against the same columns and constraints production does
 * without touching (or copying) the 360MB dev.db.
 *
 * Loaded from a jest.mock('@/lib/db') factory, which is why the setup runs at
 * module load: the mocked module must expose a live client the moment the
 * handler under test requires it.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choom-scratch-db-'));
const dbPath = path.join(tmpDir, 'test.db');
const appRoot = path.join(__dirname, '..', '..');

const schemaPath = path.join(tmpDir, 'schema.prisma');
fs.writeFileSync(
  schemaPath,
  fs.readFileSync(path.join(appRoot, 'prisma', 'schema.prisma'), 'utf-8')
    .replace(/url\s*=\s*"file:[^"]*"/, `url = "file:${dbPath}"`),
);
execFileSync('npx', ['prisma', 'db', 'push', `--schema=${schemaPath}`, '--skip-generate'], {
  cwd: appRoot,
  stdio: 'pipe',
});

export const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

export async function teardown(): Promise<void> {
  await prisma.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
