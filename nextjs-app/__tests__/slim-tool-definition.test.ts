/**
 * slimToolDefinition (C-28) — the schema the model ACTUALLY receives.
 *
 * The old slimming (first sentence / 117 chars, all param docs stripped)
 * delivered 30% of the authored description text and 0% of the parameter
 * docs — 43,245 chars of authored guidance never reached the model. The
 * relaxed contract: whole sentences up to 200 chars, required params keep
 * their docs at up to 80 chars, optional params stay doc-less. Measured at
 * +4,936 tokens across the live 133-tool set (13,755 vs 8,819; unslimmed
 * is 21,457).
 */
import { slimToolDefinition } from '../lib/llm-client';
import type { ToolDefinition } from '../lib/types';

const S80 = 'x'.repeat(90);

function tool(overrides: Partial<ToolDefinition>): ToolDefinition {
  return {
    name: 'demo_tool',
    description: 'Does a thing.',
    parameters: { type: 'object', properties: {}, required: [] },
    ...overrides,
  } as ToolDefinition;
}

type Slimmed = { description: string; parameters: { properties: Record<string, { description?: string; enum?: unknown[] }>; required?: string[] } };

describe('description truncation', () => {
  test('keeps WHOLE SENTENCES up to 200 chars (not just the first)', () => {
    const s1 = 'First sentence about what the tool does.';       // 40
    const s2 = 'Second sentence with the decision rule.';        // 39
    const s3 = 'Third sentence with an example call.';           // 36
    const s4 = 'And a fourth that pushes the total past the two-hundred character budget for sure, well past it.';
    const out = slimToolDefinition(tool({ description: [s1, s2, s3, s4].join(' ') })) as Slimmed;
    expect(out.description).toBe([s1, s2, s3].join(' '));
  });

  test('a description that already fits stays byte-identical', () => {
    const d = 'Short and complete guidance. With two sentences.';
    expect((slimToolDefinition(tool({ description: d })) as Slimmed).description).toBe(d);
  });

  test('a single giant sentence hard-cuts at 200 with ellipsis', () => {
    const d = 'A'.repeat(300);
    const out = (slimToolDefinition(tool({ description: d })) as Slimmed).description;
    expect(out).toHaveLength(200);
    expect(out.endsWith('...')).toBe(true);
  });
});

describe('parameter docs', () => {
  const params: ToolDefinition['parameters'] = {
    type: 'object',
    properties: {
      at: { type: 'string', description: 'Wall-clock time to fire, local.' },
      prompt: { type: 'string', description: S80 },
      style: { type: 'string', description: 'Optional flourish.', enum: ['a', 'b'] },
    },
    required: ['at', 'prompt'],
  };

  test('REQUIRED params keep their description (80-char cap)', () => {
    const out = slimToolDefinition(tool({ parameters: params })) as Slimmed;
    expect(out.parameters.properties.at.description).toBe('Wall-clock time to fire, local.');
    expect(out.parameters.properties.prompt.description).toHaveLength(80);
    expect(out.parameters.properties.prompt.description!.endsWith('...')).toBe(true);
  });

  test('optional params stay doc-less but keep enum', () => {
    const out = slimToolDefinition(tool({ parameters: params })) as Slimmed;
    expect(out.parameters.properties.style.description).toBeUndefined();
    expect(out.parameters.properties.style.enum).toEqual(['a', 'b']);
    expect(out.parameters.required).toEqual(['at', 'prompt']);
  });
});

describe('generate_image keeps its craft docs on the wire (2026-09-13)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tools: imageGenerationTools } = require('../skills/core/image-generation/tools') as { tools: ToolDefinition[] };
  const gen = imageGenerationTools.find(t => t.name === 'generate_image')!;

  test('the likeness rule is in the first sentence and survives the 200-char cut', () => {
    const out = slimToolDefinition(gen) as Slimmed;
    expect(out.description).toContain('never the hair, face, eyes or build of anyone referenced');
    expect(out.description).toContain('`references`');
  });

  test('prompt and references keep their FULL docs, including an appended catalog; other optional params stay doc-less', () => {
    const withCatalog: ToolDefinition = {
      ...gen,
      parameters: {
        ...gen.parameters,
        properties: {
          ...gen.parameters.properties,
          references: { ...gen.parameters.properties.references, description: gen.parameters.properties.references.description + '\n\nAvailable references:\n- "genesis" — Genesis\n- "eve" — Eve' },
        },
      },
    };
    const out = slimToolDefinition(withCatalog) as Slimmed;
    expect(out.parameters.properties.prompt.description).toBe(gen.parameters.properties.prompt.description);
    expect(out.parameters.properties.prompt.description).toContain('Do NOT describe the face, hair');
    expect(out.parameters.properties.references.description).toContain('Available references:\n- "genesis"');
    expect(out.parameters.properties.references.description).toContain('ORDER MATTERS');
    expect(out.parameters.properties.negative_prompt.description).toBeUndefined();
  });
});

describe('music_play keeps the "never invent a uri" rule on the wire (2026-09-15)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tools: musicTools } = require('../skills/core/music-assistant/tools') as { tools: ToolDefinition[] };
  test('media docs are kept in full', () => {
    const play = musicTools.find(t => t.name === 'music_play')!;
    const out = slimToolDefinition(play) as Slimmed;
    expect(out.parameters.properties.media.description).toContain('Never invent a uri');
  });
});
