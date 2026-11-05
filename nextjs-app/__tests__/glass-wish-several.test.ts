/**
 * glass_wish takes several wishes in one call (Nov 5, 2026: Donny wants the Chooms to ask for several
 * moves at once, each its own new move). Each goes to the glass on its own, in order.
 */
import { tools } from '@/skills/core/looking-glass/tools';

const asked: Array<{ choom: string; op: string; what: string; kind?: string }> = [];
let glassUp = true;
jest.mock('@/lib/glass-closet', () => ({
  askGlass: async (choom: string, op: string, what = '', kind?: string) => {
    if (!glassUp) return { ok: false, error: 'The Looking Glass (the hologram on the NUC) is not running right now.' };
    asked.push({ choom, op, what, kind });
    return { ok: true, done: false, message: `"${what}" is on Donny's wish list in Glass Studio now.` };
  },
}));

describe('glass_wish: several at once, each its own wish', () => {
  const ctx = { choomId: 'eve-id', choom: { name: 'Eve' } } as never;
  const call = (args: Record<string, unknown>) => ({ id: 'tc', name: 'glass_wish', arguments: args });
  const parse = (r: { result?: unknown }) => (typeof r.result === 'string' ? JSON.parse(r.result) : r.result) as Record<string, any>;
  let h: { execute: (c: ReturnType<typeof call>, ctx: never) => Promise<{ result?: unknown; error?: string }> };

  beforeAll(async () => {
    const { default: Handler } = await import('@/skills/core/looking-glass/handler');
    h = new Handler() as unknown as typeof h;
  });
  beforeEach(() => { asked.length = 0; glassUp = true; });

  test('the tool offers a list and needs neither field by itself', () => {
    const t = tools.find((x) => x.name === 'glass_wish')!;
    const props = (t.parameters as any).properties;
    expect(props.wishes).toEqual(expect.objectContaining({ type: 'array', items: { type: 'string' } }));
    expect((t.parameters as any).required ?? []).toEqual([]);
  });

  test('three moves in one call are three wishes, in order, all moves', async () => {
    const r = parse(await h.execute(call({ kind: 'move', wishes: ['blow a kiss', 'a sidelong glance', 'a slow twirl, skirt flaring'] }), ctx));
    expect(asked.map((a) => [a.what, a.kind, a.op])).toEqual([
      ['blow a kiss', 'move', 'wish'], ['a sidelong glance', 'move', 'wish'], ['a slow twirl, skirt flaring', 'move', 'wish']]);
    expect(r.message).toMatch(/^3 separate wishes are on Donny's wish list/);
    expect(r.added).toHaveLength(3);
  });

  test('wish and wishes together, repeats dropped; one wish answers as before', async () => {
    await h.execute(call({ kind: 'move', wish: 'Blow a kiss', wishes: ['blow a kiss', 'wave', ' '] }), ctx);
    expect(asked.map((a) => a.what)).toEqual(['Blow a kiss', 'wave']);
    asked.length = 0;
    const one = parse(await h.execute(call({ wish: 'a red dress' }), ctx));
    expect(asked).toEqual([{ choom: 'Eve', op: 'wish', what: 'a red dress', kind: 'wear' }]);
    expect(one.message).toBe('"a red dress" is on Donny\'s wish list in Glass Studio now.');
  });

  test('nothing to wish for, or the glass not running, is an error', async () => {
    expect((await h.execute(call({ kind: 'move' }), ctx)).error).toMatch(/wishes` for several/);
    glassUp = false;
    const r = await h.execute(call({ wishes: ['a', 'b'] }), ctx);
    expect(r.error).toMatch(/not running/);
    expect(r.error).toMatch(/"b": not sent/);
  });
});
