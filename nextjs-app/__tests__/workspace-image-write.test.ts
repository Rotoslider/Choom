/**
 * Test: WorkspaceService writeFileBuffer with image extensions
 * Verifies that the workspace service can write image files when given image extensions
 */
import { WorkspaceService } from '@/lib/workspace-service';
import { existsSync, unlinkSync, rmdirSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';

const TEST_WORKSPACE = path.join(os.tmpdir(), 'choom-test-workspace-' + Date.now());
const TEXT_EXTENSIONS = ['.md', '.txt', '.json'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
const ALL_EXTENSIONS = [...TEXT_EXTENSIONS, ...IMAGE_EXTENSIONS];

describe('WorkspaceService Image File Writing', () => {
  beforeAll(() => {
    mkdirSync(TEST_WORKSPACE, { recursive: true });
  });

  afterAll(() => {
    // Cleanup
    try {
      const { execSync } = require('child_process');
      execSync(`rm -rf "${TEST_WORKSPACE}"`);
    } catch { /* ignore */ }
  });

  test('writeFileBuffer rejects .png with default text-only extensions', async () => {
    const ws = new WorkspaceService(TEST_WORKSPACE, 1024, TEXT_EXTENSIONS);
    const buffer = Buffer.from('fake png data');
    await expect(ws.writeFileBuffer('test/image.png', buffer))
      .rejects.toThrow('Extension ".png" not allowed');
  });

  test('writeFileBuffer accepts .png with image extensions enabled', async () => {
    const ws = new WorkspaceService(TEST_WORKSPACE, 1024, ALL_EXTENSIONS);
    // Create a small valid-ish buffer (doesn't need to be a real PNG for the write test)
    const buffer = Buffer.from('fake png data for testing');
    const result = await ws.writeFileBuffer('test_project/images/test.png', buffer, ALL_EXTENSIONS);
    expect(result).toContain('Wrote');
    expect(result).toContain('test_project/images/test.png');

    // Verify file exists on disk
    const fullPath = path.join(TEST_WORKSPACE, 'test_project', 'images', 'test.png');
    expect(existsSync(fullPath)).toBe(true);
  });

  test('writeFileBuffer accepts .jpg with image extensions enabled', async () => {
    const ws = new WorkspaceService(TEST_WORKSPACE, 1024, ALL_EXTENSIONS);
    const buffer = Buffer.from('fake jpg data');
    const result = await ws.writeFileBuffer('test_project/photos/test.jpg', buffer, ALL_EXTENSIONS);
    expect(result).toContain('Wrote');
  });

  test('writeFileBuffer rejects files exceeding size limit', async () => {
    const ws = new WorkspaceService(TEST_WORKSPACE, 1, ALL_EXTENSIONS); // 1KB limit
    const bigBuffer = Buffer.alloc(2 * 1024); // 2KB
    await expect(ws.writeFileBuffer('test_project/big.png', bigBuffer, ALL_EXTENSIONS))
      .rejects.toThrow('File too large');
  });

  test('writeFileBuffer creates parent directories automatically', async () => {
    const ws = new WorkspaceService(TEST_WORKSPACE, 1024, ALL_EXTENSIONS);
    const buffer = Buffer.from('nested test');
    const result = await ws.writeFileBuffer('deep/nested/dir/image.png', buffer, ALL_EXTENSIONS);
    expect(result).toContain('Wrote');
    const fullPath = path.join(TEST_WORKSPACE, 'deep', 'nested', 'dir', 'image.png');
    expect(existsSync(fullPath)).toBe(true);
  });

  test('base64 round-trip: encode then decode produces same bytes', () => {
    // Simulates what save_generated_image does
    const originalData = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // PNG header
    const base64 = originalData.toString('base64');
    const dataUrl = `data:image/png;base64,${base64}`;

    // Extract base64 from data URL (same logic as handler)
    const extracted = dataUrl.split(',')[1];
    const decoded = Buffer.from(extracted, 'base64');

    expect(decoded).toEqual(originalData);
  });
});
