/**
 * Drama 3 delivery cues (Nov 22 2026): "[warm] You left the shop lights on."
 * Chat shows them dimmed, rooms too, Signal hides them; a Choom pinned to a
 * Drama 3 provider is told how to use them; the Looking Glass, which knows only
 * the voice, speaks through that Choom's own provider.
 */
import { markVoiceCues, splitVoiceCues, stripVoiceCues, VOICE_CUE_HREF, VOICE_CUES_NOTE } from '@/lib/voice-cues';
import { buildSystemPrompt, type SystemPromptParams } from '@/lib/chat-prompt';

jest.mock('@/lib/db', () => ({
  __esModule: true,
  default: {
    choom: {
      findMany: jest.fn(async () => [
        { voiceId: 'aloy', ttsProviderId: 'tts_drama3' },
        { voiceId: 'Eva_zu_Beck', ttsProviderId: null },
      ]),
    },
  },
}));
jest.mock('@/lib/bridge-config-store', () => ({
  loadConfig: jest.fn(async () => ({
    ttsProviders: [
      { id: 'tts_mac_local', name: 'Mac (local)', endpoint: 'http://localhost:8004' },
      { id: 'tts_drama3', name: 'Drama 3', endpoint: 'http://localhost:8004/drama' },
    ],
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const provider = require('@/lib/tts-provider') as typeof import('@/lib/tts-provider');

describe('stripVoiceCues', () => {
  test('removes cues and tidies the spaces', () => {
    expect(stripVoiceCues('[warm] You left the lights on. [small laugh] Again.')).toBe('You left the lights on. Again.');
    expect(stripVoiceCues('I read it twice [laughs], really.')).toBe('I read it twice, really.');
  });

  test('leaves links, name labels, PASS, footnotes, checkboxes and code alone', () => {
    for (const text of ['See [the docs](https://x.y).', '[Eve]: hi', '[PASS]', 'Footnote [1].', '- [x] done',
      '[Mount Graham] is high.', 'a [[wiki]] link', 'use `[a, b, c]` here']) {
      expect(stripVoiceCues(text)).toBe(text);
    }
    expect(stripVoiceCues('```py\nx = [a, b, c]\n```\n[softly] done')).toBe('```py\nx = [a, b, c]\n```\ndone');
  });
});

describe('markVoiceCues / splitVoiceCues', () => {
  test('a cue becomes a link the renderer draws dimmed', () => {
    expect(markVoiceCues('[warm] Hi. See [docs](https://x).')).toBe(`[warm](${VOICE_CUE_HREF}) Hi. See [docs](https://x).`);
    expect(markVoiceCues('`[a, b]` and [low, focused] go')).toBe(`\`[a, b]\` and [low, focused](${VOICE_CUE_HREF}) go`);
  });

  test('plain text splits into text and cue pieces', () => {
    expect(splitVoiceCues('[teasing] You owe me one.')).toEqual([{ text: 'teasing', cue: true }, { text: ' You owe me one.' }]);
    expect(splitVoiceCues('No cues here.')).toEqual([{ text: 'No cues here.' }]);
  });
});

describe('system prompt', () => {
  const base = (over: Partial<SystemPromptParams> = {}): SystemPromptParams => ({
    choom: { name: 'Aloy', systemPrompt: 'You are Aloy.', imageSettings: null } as never,
    toolDocs: '', timeInfo: '', weatherInfo: '', homeAssistantInfo: '', recentImagesInfo: '', growthInfo: '',
    autoMemoriesInfo: '', crossSessionInfo: '', isGroupTurn: false, groupSpeakerName: '', groupParticipantNames: [],
    groupRoomTopic: undefined, groupRecentImages: [], groupImageDescriptions: {}, groupIsInitiator: false,
    groupProjectFolder: undefined, ...over,
  });

  test('only a Drama 3 Choom is told about cues', () => {
    expect(buildSystemPrompt(base())).not.toContain('YOUR SPEAKING VOICE');
    expect(buildSystemPrompt(base({ voiceCues: true }))).toContain(VOICE_CUES_NOTE.trim());
  });
});

describe('TTS provider', () => {
  test('a /drama endpoint or voiceCues flag takes cues', () => {
    expect(provider.providerTakesVoiceCues({ endpoint: 'http://localhost:8004/drama' })).toBe(true);
    expect(provider.providerTakesVoiceCues({ endpoint: 'http://localhost:8004', voiceCues: true })).toBe(true);
    expect(provider.providerTakesVoiceCues({ endpoint: 'http://localhost:8004' })).toBe(false);
    expect(provider.providerTakesVoiceCues(undefined)).toBe(false);
  });

  test('choomTakesVoiceCues follows her pin', async () => {
    expect(await provider.choomTakesVoiceCues('tts_drama3')).toBe(true);
    expect(await provider.choomTakesVoiceCues('tts_mac_local')).toBe(false);
    expect(await provider.choomTakesVoiceCues(null)).toBe(false);
  });

  test('a voice alone (the glass) resolves to its Choom\'s provider', async () => {
    expect(await provider.resolveTTSEndpointForVoice('aloy', 'http://localhost:8004')).toBe('http://localhost:8004/drama');
    expect(await provider.resolveTTSEndpointForVoice('Eva_zu_Beck', 'http://localhost:8004')).toBe('http://localhost:8004');
    expect(await provider.resolveTTSEndpointForVoice('nobody', 'http://localhost:8004')).toBe('http://localhost:8004');
  });
});
