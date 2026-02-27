import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LichessClient, moveStatsFromLichessGames } from '../src/api/lichess.js';

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const SAMPLE_GAMES = [
  {
    createdAt: 1_710_000_000_000,
    moves: 'e2e4 e7e5 g1f3',
    winner: 'white',
    players: {
      white: { user: { name: 'me' } },
      black: { user: { name: 'op1' } },
    },
  },
  {
    createdAt: 1_709_999_999_000,
    moves: 'd2d4 d7d5 c2c4',
    status: 'draw',
    players: {
      white: { user: { name: 'me' } },
      black: { user: { name: 'op2' } },
    },
  },
  {
    createdAt: 1_709_999_998_000,
    moves: 'e2e4 c7c5',
    winner: 'black',
    players: {
      white: { user: { name: 'other' } },
      black: { user: { name: 'me' } },
    },
  },
] as const;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('LichessClient', () => {
  it('collects move stats from Lichess game objects', () => {
    const stats = moveStatsFromLichessGames(SAMPLE_GAMES, 'me', INITIAL_FEN, 'white');
    expect(stats).toHaveLength(2);
    expect(stats[0]).toMatchObject({ san: 'd4', total: 1, draws: 1 });
    expect(stats[1]).toMatchObject({ san: 'e4', total: 1, white: 1 });
  });

  it('downloads user games into data_in and reuses the dump', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lichess-user-dump-'));
    tempDirs.push(dataDir);
    const progressEvents: Array<{ loaded: number; total: number; done: boolean }> = [];
    const body = `${JSON.stringify(SAMPLE_GAMES[0])}\n${JSON.stringify(SAMPLE_GAMES[1])}\n`;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ count: { all: 999 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(body, { status: 200 }));
    const client = new LichessClient(
      fetchImpl as unknown as typeof fetch,
      'https://explorer.lichess.ovh',
      () => {},
      () => {},
      'https://lichess.org',
      dataDir,
      (loaded, total, done) => progressEvents.push({ loaded, total, done }),
    );

    const first = await client.getUserMoveStats('me', INITIAL_FEN, 'white');
    const second = await client.getUserMoveStats('me', INITIAL_FEN, 'white');

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const firstCallUrl = fetchImpl.mock.calls[0][0] as URL;
    const secondCallUrl = fetchImpl.mock.calls[1][0] as URL;
    expect(firstCallUrl.toString()).toContain('/api/user/me');
    expect(secondCallUrl.toString()).toContain('/api/games/user/me');
    expect(progressEvents).toEqual([
      { loaded: 2, total: 999, done: false },
      { loaded: 2, total: 999, done: true },
    ]);

    const dumpPath = join(dataDir, 'lichess_me.ndjson');
    const dumpContents = await readFile(dumpPath, 'utf8');
    expect(dumpContents).toContain('"moves":"e2e4 e7e5 g1f3"');
  });

  it('maps Lichess database move stats and eval fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ moves: [{ san: 'e4', white: 30, draws: 10, black: 20, cp: 34 }] }), {
        status: 200,
      }),
    );
    const client = new LichessClient(fetchImpl as unknown as typeof fetch, 'https://explorer.lichess.ovh');

    const db = await client.getDatabaseMoveStats('fen');
    expect(db[0].eval?.cp).toBe(34);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('includes failing NDJSON line when user dump parsing fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ count: { all: 123 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response('not-json\n', { status: 200 }));
    const client = new LichessClient(fetchImpl as unknown as typeof fetch, 'https://explorer.lichess.ovh');

    await expect(client.getUserMoveStats('x', INITIAL_FEN, 'white')).rejects.toThrow(
      'Received line:\nnot-json',
    );
  });
});
