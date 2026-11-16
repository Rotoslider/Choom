import { applyEngineSwitch, generateWithH3, h3Endpoint, h3ReferenceLead } from '../lib/h3-image-client';
import { ImageGenClient } from '../lib/image-gen-client';
import type { ImageGenSettings } from '../lib/types';

const base: ImageGenSettings = {
  endpoint: 'http://192.168.1.23:7860', engine: 'h3image', defaultCheckpoint: 'flux-2-klein-9b', defaultSampler: 'Euler',
  defaultScheduler: 'flux2', defaultSteps: 15, defaultCfgScale: 1, defaultDistilledCfg: 3.5, defaultWidth: 1024,
  defaultHeight: 1024, defaultNegativePrompt: '', selfPortrait: {} as ImageGenSettings['selfPortrait'],
};

describe('h3ReferenceLead', () => {
  it('names each reference picture in order', () => {
    expect(h3ReferenceLead([{ name: 'Genesis', count: 2 }, { name: 'Donny', count: 1 }], 3)).toBe(
      'Reference pictures: <Picture 1> and <Picture 2> show Genesis; <Picture 3> shows Donny. ' +
        'The target image is a new picture of them, keeping their faces and looks exactly as in those pictures: ');
  });
  it('calls pictures past the named ones further references, and says nothing without pictures', () => {
    expect(h3ReferenceLead([{ name: 'Eve', count: 1 }], 3)).toContain('<Picture 1> shows Eve; <Picture 2> and <Picture 3> are further references');
    expect(h3ReferenceLead([{ name: 'Eve', count: 5 }], 2)).toContain('<Picture 1> and <Picture 2> show Eve.');
    expect(h3ReferenceLead([], 0)).toBe('');
  });
});

describe('h3Endpoint', () => {
  afterEach(() => { delete process.env.H3_IMAGE_ENDPOINT; });
  it('is Forge’s host on port 7870 unless set', () => {
    expect(h3Endpoint(base)).toBe('http://192.168.1.23:7870');
    process.env.H3_IMAGE_ENDPOINT = 'http://nuc:7871/';
    expect(h3Endpoint(base)).toBe('http://nuc:7871');
    expect(h3Endpoint({ ...base, h3Endpoint: 'http://other:9000' })).toBe('http://other:9000');
  });
});

describe('generateWithH3 and the engine switch', () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  beforeEach(() => {
    calls.length = 0;
    process.env.H3_IMAGE_TOKEN = 'tok';
    let polls = 0;
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.endsWith('/jobs')) return json({ id: 'j1' });
      if (url.includes('/jobs/j1')) return json(++polls < 2 ? { status: 'running' } : { status: 'done', image: 'UE5H', seed: 42, width: 1536, height: 2048, ms: 35000, waitedMs: 0 });
      if (url.endsWith('/load') || url.endsWith('/release')) return json({ state: 'ok' });
      return new Response('unexpected', { status: 500 });
    }) as unknown as typeof fetch;
  });
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; delete process.env.H3_IMAGE_TOKEN; });

  it('sends the prompt with its reference names, polls, and returns the picture', async () => {
    const out = await generateWithH3(base, {
      prompt: 'Genesis on the porch', width: 1536, height: 2048, referenceImages: ['AAA', 'BBB'],
      referenceSubjects: [{ name: 'Genesis', count: 2 }], label: "Genesis's selfie",
    });
    expect(out.imageUrl).toBe('data:image/png;base64,UE5H');
    expect(out.seed).toBe(42);
    expect(out.settings.engine).toBe('h3image');
    expect(out.settings.referenceImages).toBeUndefined();
    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent.prompt).toBe(h3ReferenceLead([{ name: 'Genesis', count: 2 }], 2) + 'Genesis on the porch');
    expect(sent.references).toEqual(['AAA', 'BBB']);
    expect(sent.seed).toBe(-1);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(calls.filter((c) => c.url.includes('/jobs/j1')).length).toBe(2);
  });

  it('needs the token', async () => {
    delete process.env.H3_IMAGE_TOKEN;
    await expect(generateWithH3(base, { prompt: 'x' })).rejects.toThrow(/H3_IMAGE_TOKEN/);
  });

  it('ImageGenClient goes to H3 Image, never to Forge, when the engine is H3 Image', async () => {
    const client = new ImageGenClient(base);
    await client.setCheckpointWithModules('flux-2-klein-9b', 'klein');
    const out = await client.generate({ prompt: 'a cat', width: 1024, height: 1024 });
    expect(out.imageUrl).toContain('UE5H');
    expect(calls.some((c) => c.url.includes(':7860'))).toBe(false);
  });

  it('switching loads H3 Image, and switching back has it let go for good', async () => {
    await applyEngineSwitch(base);
    expect(calls.at(-1)?.url).toBe('http://192.168.1.23:7870/load');
    await applyEngineSwitch({ ...base, engine: 'forge' });
    expect(calls.at(-1)?.url).toBe('http://192.168.1.23:7870/release');
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({ off: true });
  });
});
