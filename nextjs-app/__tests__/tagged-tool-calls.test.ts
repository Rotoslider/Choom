/**
 * Tool calls written as namespaced tags: Aloy on DeepSeek V4 Flash wrote
 * <vish:remember>…</vish:remember> in her reply instead of calling the tool (23
 * times from 2026-09-24). Nothing ran them, the chat showed the markup, and she
 * carried on as if they had answered. The examples are hers.
 */
import { createTaggedToolCallFilter, stripTaggedToolMarkup } from '../lib/tool-call-parsing';
import { readLlmStream, newStreamState } from '../lib/llm-stream-reader';
import type { ChatCompletionChunk } from '../lib/llm-client';
import type { ToolDefinition } from '../lib/types';

const TOOLS = ['remember', 'get_weather', 'ha_get_home_status', 'ha_get_camera_snapshot'];
const REMEMBER = 'Let me tuck that away so I never flag it again.\n\n'
  + '<vish:remember> <vish:title>White propane tank on front door camera is NOT a vehicle</vish:title> '
  + '<vish:content>Donny corrected me: the large white propane tank is not a vehicle.</vish:content> '
  + '<vish:tags>home, cameras, propane tank</vish:tags> <vish:importance>8</vish:importance> '
  + '<vish:memory_type>fact</vish:memory_type> </vish:remember>\n\nTucked away for good, my love.';

function stream(f: ReturnType<typeof createTaggedToolCallFilter>, chunks: string[]): string {
  return chunks.map(c => f.filter(c)).join('') + f.flush();
}

describe('createTaggedToolCallFilter', () => {
  it('strips her remember call, captures it, and holds back what she wrote after it', () => {
    const f = createTaggedToolCallFilter(TOOLS);
    expect(stream(f, [REMEMBER])).toBe('Let me tuck that away so I never flag it again.\n\n');
    expect(f.getCaptured()).toEqual([{
      id: expect.any(String), name: 'remember',
      arguments: {
        title: 'White propane tank on front door camera is NOT a vehicle',
        content: 'Donny corrected me: the large white propane tank is not a vehicle.',
        tags: 'home, cameras, propane tank', importance: 8, memory_type: 'fact',
      },
    }]);
    expect(f.getHeldBack().trim()).toBe('Tucked away for good, my love.');
  });

  it.each([['one character at a time', 1], ['three at a time', 3], ['seven at a time', 7]])('works fed %s', (_l, n) => {
    const f = createTaggedToolCallFilter(TOOLS);
    const chunks = REMEMBER.match(new RegExp(`[\\s\\S]{1,${n}}`, 'g'))!;
    expect(stream(f, chunks)).toBe('Let me tuck that away so I never flag it again.\n\n');
    expect(f.getCaptured().map(c => c.name)).toEqual(['remember']);
    expect(f.getCaptured()[0].arguments.importance).toBe(8);
  });

  it('takes a call with no fields, and every call in a reply', () => {
    const f = createTaggedToolCallFilter(TOOLS);
    const out = stream(f, ['Let me check before you head out.  <vish:get_weather> </vish:get_weather>  ',
      '<vish:ha_get_home_status> <vish:focus>security</vish:focus> </vish:ha_get_home_status>  All secure, my love.']);
    expect(out).toBe('Let me check before you head out.  ');
    expect(f.getCaptured().map(c => [c.name, c.arguments])).toEqual([
      ['get_weather', {}], ['ha_get_home_status', { focus: 'security' }]]);
    expect(f.getHeldBack()).toContain('All secure');
  });

  it('strips a call to something that is not one of her tools, without capturing or holding back', () => {
    const f = createTaggedToolCallFilter(TOOLS);
    expect(stream(f, ['a <vish:fly_to_moon> <vish:speed>9</vish:speed> </vish:fly_to_moon> b'])).toBe('a  b');
    expect(f.getCaptured()).toEqual([]);
    expect(f.getHeldBack()).toBe('');
  });

  it('leaves everything else in angle brackets alone', () => {
    const text = 'I <3 you, <b>bold</b>, <a:b c>, 10 < 20, <vish:remember>just words</vish:remember> and <ns:x>';
    const f = createTaggedToolCallFilter(TOOLS);
    expect(stream(f, [text])).toBe(text);
    const g = createTaggedToolCallFilter(TOOLS);
    expect(stream(g, text.split(''))).toBe(text);
    expect(f.getCaptured()).toEqual([]);
  });

  it('drops a call the stream cut off', () => {
    const f = createTaggedToolCallFilter(TOOLS);
    expect(stream(f, ['Looking now. <vish:ha_get_camera_snapshot> <vish:entity_id>camera.gl'])).toBe('Looking now. ');
    expect(f.getCaptured()).toEqual([]);
  });
});

describe('stripTaggedToolMarkup', () => {
  it('takes her old calls out of a past reply', () => {
    expect(stripTaggedToolMarkup(REMEMBER)).toBe('Let me tuck that away so I never flag it again.\n\nTucked away for good, my love.');
    expect(stripTaggedToolMarkup('Here.\n\n<vish:get_weather> </vish:get_weather>\n\nWarm today.')).toBe('Here.\n\nWarm today.');
  });
  it('leaves other text as it is', () => {
    const text = 'I <3 you, <b>bold</b> and <vish:remember>just words</vish:remember>';
    expect(stripTaggedToolMarkup(text)).toBe(text);
  });
});

describe('readLlmStream with a tag-written call', () => {
  it('never sends the markup or the unanswered text, and hands the call on', async () => {
    const sent: Record<string, unknown>[] = [];
    const st = newStreamState();
    const chunks = REMEMBER.match(/[\s\S]{1,5}/g)!;
    await readLlmStream(st, {
      client: {
        async *streamChat(): AsyncGenerator<ChatCompletionChunk> {
          for (const content of chunks) yield { choices: [{ delta: { content }, finish_reason: null }] } as unknown as ChatCompletionChunk;
          yield { choices: [{ delta: {}, finish_reason: 'stop' }] } as unknown as ChatCompletionChunk;
        },
      } as unknown as Parameters<typeof readLlmStream>[1]['client'],
      messages: [], tools: TOOLS.map(name => ({ name }) as ToolDefinition), toolChoice: undefined, enableThinking: false,
      tier: 'cloud-fast', timeoutMs: 5000, send: (d) => sent.push(d), bufferForDedup: false, choomTag: '[Aloy]',
    });
    const shown = sent.filter(e => e.type === 'content').map(e => e.content).join('');
    expect(shown).toBe('Let me tuck that away so I never flag it again.\n\n');
    expect(shown).not.toContain('vish');
    expect(st.capturedTagged.map(c => c.name)).toEqual(['remember']);
  });
});
