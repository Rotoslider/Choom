/**
 * 2026-11-21: Second Brain showed an edit as saved when the memory server had
 * refused it. Donny removed the old Tower camera password from a memory twice;
 * both saves came back 422 from the memory server (the page sent the memory's
 * own importance, 6.5, and the server takes whole numbers), the route answered
 * 200, and the page closed the editor. A refused edit or delete now answers
 * 502 with the server's reason, and the page shows it.
 */
const update = jest.fn();
const remove = jest.fn();
jest.mock('@/lib/memory-client', () => ({
  MemoryClient: class {
    update(...a: unknown[]) { return update(...a); }
    delete(...a: unknown[]) { return remove(...a); }
  },
}));

import { PUT, DELETE } from '@/app/api/memories/route';

const req = (method: 'PUT' | 'DELETE', body: unknown) =>
  new Request('http://localhost:3000/api/memories', {
    method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  }) as never;

const REFUSED = { success: false, reason: 'Request failed: {"detail":[{"type":"int_from_float","loc":["body","importance"]}]}' };

beforeEach(() => { update.mockReset(); remove.mockReset(); });

describe('PUT /api/memories', () => {
  it('answers 502 with the reason when the memory server refuses the edit', async () => {
    update.mockResolvedValueOnce(REFUSED);
    const res = await PUT(req('PUT', { memory_id: 'mem_1', content: 'no password here', importance: 6.5 }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual(REFUSED);
  });

  it('answers 200 when the edit is saved, passing only the fields the page sent', async () => {
    update.mockResolvedValueOnce({ success: true, data: { id: 'mem_1' } });
    const res = await PUT(req('PUT', { memory_id: 'mem_1', title: 'T', content: 'C' }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith('mem_1', { title: 'T', content: 'C' });
  });

  it('still answers 400 without a memory_id', async () => {
    const res = await PUT(req('PUT', { content: 'C' }));
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/memories', () => {
  it('answers 502 when the memory server refuses the delete', async () => {
    remove.mockResolvedValueOnce({ success: false, reason: 'Request failed: Memory not found' });
    const res = await DELETE(req('DELETE', { memory_id: 'mem_gone' }));
    expect(res.status).toBe(502);
    expect((await res.json()).reason).toContain('not found');
  });

  it('answers 200 when the memory is deleted', async () => {
    remove.mockResolvedValueOnce({ success: true });
    const res = await DELETE(req('DELETE', { memory_id: 'mem_1' }));
    expect(res.status).toBe(200);
  });
});
