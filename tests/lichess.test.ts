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
  });
});
