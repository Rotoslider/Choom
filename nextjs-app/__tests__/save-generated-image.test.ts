/**
 * Test: save_generated_image tool definition and handler
 * Verifies the tool is properly defined, registered, and the handler has the right logic
 */
import { readFileSync } from 'fs';
import path from 'path';

describe('save_generated_image Tool', () => {
  const toolsPath = path.join(__dirname, '..', 'skills', 'core', 'image-generation', 'tools.ts');
  const handlerPath = path.join(__dirname, '..', 'skills', 'core', 'image-generation', 'handler.ts');
  const skillMdPath = path.join(__dirname, '..', 'skills', 'core', 'image-generation', 'SKILL.md');

  let toolsContent: string;
  let handlerContent: string;
  let skillMdContent: string;

  beforeAll(() => {
    toolsContent = readFileSync(toolsPath, 'utf-8');
    handlerContent = readFileSync(handlerPath, 'utf-8');
    skillMdContent = readFileSync(skillMdPath, 'utf-8');
  });

  describe('Tool Definition', () => {
    test('save_generated_image tool is defined in tools.ts', () => {
      expect(toolsContent).toContain("name: 'save_generated_image'");
    });

    test('tool has image_id parameter', () => {
      expect(toolsContent).toContain('image_id');
      // Verify it's a required param
      expect(toolsContent).toMatch(/required:.*'image_id'/);
    });

    test('tool has save_path parameter', () => {
      expect(toolsContent).toContain('save_path');
      expect(toolsContent).toMatch(/required:.*'save_path'/);
    });

    test('tool description mentions project workspace', () => {
      // Find the save_generated_image block and check its description
      const toolBlock = toolsContent.split("name: 'save_generated_image'")[1];
      expect(toolBlock).toBeTruthy();
      expect(toolBlock).toContain('workspace');
    });
  });

  describe('Handler', () => {
    test('handler registers save_generated_image in TOOL_NAMES', () => {
      expect(handlerContent).toContain("'save_generated_image'");
      expect(handlerContent).toMatch(/TOOL_NAMES.*save_generated_image/);
    });

    test('handler has switch case for save_generated_image', () => {
      expect(handlerContent).toContain("case 'save_generated_image':");
    });

    test('handler imports WorkspaceService', () => {
      expect(handlerContent).toContain("import { WorkspaceService }");
    });

    test('handler uses the canonical workspace extension policy', () => {
      // Extension lists live only in lib/config.ts now; local shadow copies
      // drifted and silently rejected files the policy allows (.lisp).
      expect(handlerContent).toContain("WORKSPACE_ALLOWED_EXTENSIONS, WORKSPACE_IMAGE_EXTENSIONS } from '@/lib/config'");
      expect(handlerContent).not.toMatch(/const WORKSPACE_IMAGE_EXTENSIONS = \[/);
    });

    test('handler uses writeFileBuffer (not writeFile)', () => {
      expect(handlerContent).toContain('writeFileBuffer');
    });

    test('handler looks up image by ID from prisma', () => {
      expect(handlerContent).toContain('prisma.generatedImage.findUnique');
    });

    test('handler extracts base64 from data URL', () => {
      expect(handlerContent).toContain("startsWith('data:')");
      expect(handlerContent).toContain("split(',')[1]");
    });

    test('handler converts base64 to Buffer', () => {
      expect(handlerContent).toContain("Buffer.from(base64Data, 'base64')");
    });

    test('handler updates session file count', () => {
      expect(handlerContent).toContain('sessionFileCount.created++');
    });

    test('handler sends file_created SSE event', () => {
      expect(handlerContent).toContain("type: 'file_created'");
    });
  });

  describe('SKILL.md', () => {
    test('SKILL.md lists save_generated_image tool', () => {
      expect(skillMdContent).toContain('save_generated_image');
    });
  });

  describe('generate_image mentions save_generated_image', () => {
    test('generate_image success message references save_generated_image', () => {
      expect(handlerContent).toContain('save_generated_image');
      // The success message should tell the LLM how to use it
      expect(handlerContent).toContain('call save_generated_image');
    });
  });
});
