import { describe, expect, it, vi } from 'vitest';
import { LichessClient } from '../src/api/lichess.js';

describe('LichessClient', () => {
  it('maps move stats and eval fields', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ moves: [{ san: 'e4', white: 3, draws: 1, black: 2 }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ moves: [{ san: 'e4', white: 30, draws: 10, black: 20, cp: 34 }] }), {
          status: 200,
        }),
      );

    const client = new LichessClient(fetchImpl as unknown as typeof fetch, 'https://explorer.lichess.ovh');
    const user = await client.getUserMoveStats('x', 'fen', 'white');
    const db = await client.getDatabaseMoveStats('fen');

    expect(user[0].total).toBe(6);
    expect(db[0].eval?.cp).toBe(34);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const firstCallUrl = fetchImpl.mock.calls[0][0] as URL;
    const firstCallOptions = fetchImpl.mock.calls[0][1] as { headers: Record<string, string> };
    expect(firstCallUrl.toString()).toContain('/player?player=x&fen=fen&color=white&recentGames=0');
    expect(firstCallOptions.headers).toMatchObject({
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, br',
    });
  });

  it('includes response text when JSON parsing fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not-json', { status: 200 }));
    const client = new LichessClient(fetchImpl as unknown as typeof fetch, 'https://explorer.lichess.ovh');

    await expect(client.getUserMoveStats('x', 'fen', 'white')).rejects.toThrow(
      'Received body:\nnot-json',
    );
  });
});
