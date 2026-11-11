/**
 * 2026-11-11: the dev server restarts once a week (scripts/weekly-restart.py), and only when no Choom
 * turn is under way. lib/turns-open.ts counts them; GET /api/turns reports them.
 */
import { openTurn, turnsOpen } from '@/lib/turns-open';
import { GET } from '@/app/api/turns/route';

describe('turns under way', () => {
  it('counts a turn from its start until it ends, however many run at once', () => {
    const endGenesis = openTurn('Genesis', 'chat', 1_000);
    const endRoom = openTurn('The Campfire', 'room', 4_000);
    expect(turnsOpen(11_000)).toEqual([
      { who: 'Genesis', kind: 'chat', seconds: 10 },
      { who: 'The Campfire', kind: 'room', seconds: 7 },
    ]);
    endGenesis();
    expect(turnsOpen(11_000)).toEqual([{ who: 'The Campfire', kind: 'room', seconds: 7 }]);
    endRoom();
    expect(turnsOpen()).toEqual([]);
  });

  it('ending a turn twice does not end another one', () => {
    const endAloy = openTurn('Aloy', 'heartbeat');
    const endEve = openTurn('Eve', 'chat');
    endAloy();
    endAloy();
    expect(turnsOpen().map((t) => t.who)).toEqual(['Eve']);
    endEve();
  });

  it('GET /api/turns says how many are open', async () => {
    const end = openTurn('Optic', 'delegation');
    const body = await (await GET()).json();
    expect(body.open).toBe(1);
    expect(body.turns[0]).toMatchObject({ who: 'Optic', kind: 'delegation' });
    end();
    expect((await (await GET()).json()).open).toBe(0);
  });
});
