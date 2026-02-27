import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LichessClient, moveStatsFromLichessGames } from '../src/api/lichess.js';

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const SAMPLE_GAMES = [
  {
    createdAt: Date.UTC(2024, 0, 20),
    moves: 'e2e4 e7e5 g1f3',
    winner: 'white',
    players: {
      white: { user: { name: 'me' } },
      black: { user: { name: 'op1' } },
    },
  },
  {
    createdAt: Date.UTC(2024, 1, 2),
    moves: 'd2d4 d7d5 c2c4',
    status: 'draw',
    players: {
      white: { user: { name: 'me' } },
      black: { user: { name: 'op2' } },
    },
  },
  {
    createdAt: Date.UTC(2024, 1, 1),
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

  it('downloads user games into monthly cache files and reuses the dump', async () => {
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
    expect(secondCallUrl.searchParams.get('max')).toBe('100000');
    expect(progressEvents).toEqual([
      { loaded: 0, total: 999, done: false },
      { loaded: 2, total: 999, done: false },
      { loaded: 2, total: 999, done: true },
    ]);

    const playerDir = join(dataDir, 'lichess_player', 'me');
    const januaryDumpPath = join(playerDir, 'data', '2024-01.ndjson');
    const februaryDumpPath = join(playerDir, 'data', '2024-02.ndjson');
    const januaryDumpContents = await readFile(januaryDumpPath, 'utf8');
    const februaryDumpContents = await readFile(februaryDumpPath, 'utf8');
    expect(januaryDumpContents).toContain('"moves":"e2e4 e7e5 g1f3"');
    expect(februaryDumpContents).toContain('"moves":"d2d4 d7d5 c2c4"');

    const lastAvailableAt = await readFile(join(playerDir, 'last_available_at.txt'), 'utf8');
    expect(lastAvailableAt.trim()).toBe(String(SAMPLE_GAMES[1].createdAt));

    const monthlyGameCounts = await readFile(join(playerDir, 'monthly_games.csv'), 'utf8');
    expect(monthlyGameCounts).toBe('year_month,games\n2024-01,1\n2024-02,1\n');
  });

  it('uses last_available_at metadata to fetch only new games', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lichess-user-dump-incremental-'));
    tempDirs.push(dataDir);

    const playerDir = join(dataDir, 'lichess_player', 'me');
    const dataPath = join(playerDir, 'data');
    await mkdir(dataPath, { recursive: true });
    await writeFile(join(dataPath, '2024-01.ndjson'), `${JSON.stringify(SAMPLE_GAMES[0])}\n`, 'utf8');
    await writeFile(join(playerDir, 'last_available_at.txt'), `${SAMPLE_GAMES[0].createdAt}\n`, 'utf8');
    await writeFile(join(playerDir, 'monthly_games.csv'), 'year_month,games\n2024-01,1\n', 'utf8');

    const body = `${JSON.stringify(SAMPLE_GAMES[1])}\n`;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ count: { all: 999 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(body, { status: 200 }));
    const client = new LichessClient(fetchImpl as unknown as typeof fetch, undefined, () => {}, () => {}, undefined, dataDir);

    const stats = await client.getUserMoveStats('me', INITIAL_FEN, 'white');

    expect(stats).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const gamesUrl = fetchImpl.mock.calls[1][0] as URL;
    expect(gamesUrl.searchParams.get('since')).toBe(String(SAMPLE_GAMES[0].createdAt + 1));

    const februaryDumpContents = await readFile(join(dataPath, '2024-02.ndjson'), 'utf8');
    expect(februaryDumpContents).toContain('"moves":"d2d4 d7d5 c2c4"');

    const lastAvailableAt = await readFile(join(playerDir, 'last_available_at.txt'), 'utf8');
    expect(lastAvailableAt.trim()).toBe(String(SAMPLE_GAMES[1].createdAt));

    const monthlyGameCounts = await readFile(join(playerDir, 'monthly_games.csv'), 'utf8');
    expect(monthlyGameCounts).toBe('year_month,games\n2024-01,1\n2024-02,1\n');
  });

  it('reports 0/0 progress when there are no new games to download', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lichess-user-dump-no-new-games-'));
    tempDirs.push(dataDir);

    const playerDir = join(dataDir, 'lichess_player', 'me');
    const dataPath = join(playerDir, 'data');
    await mkdir(dataPath, { recursive: true });
    await writeFile(join(dataPath, '2024-01.ndjson'), `${JSON.stringify(SAMPLE_GAMES[0])}\n`, 'utf8');
    await writeFile(join(playerDir, 'last_available_at.txt'), `${SAMPLE_GAMES[0].createdAt}\n`, 'utf8');
    await writeFile(join(playerDir, 'monthly_games.csv'), 'year_month,games\n2024-01,1\n', 'utf8');

    const progressEvents: Array<{ loaded: number; total: number; done: boolean }> = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ count: { all: 1 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    const client = new LichessClient(
      fetchImpl as unknown as typeof fetch,
      undefined,
      () => {},
      () => {},
      undefined,
      dataDir,
      (loaded, total, done) => progressEvents.push({ loaded, total, done }),
    );

    await client.getUserMoveStats('me', INITIAL_FEN, 'white');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(progressEvents).toEqual([
      { loaded: 0, total: 0, done: false },
      { loaded: 0, total: 0, done: true },
    ]);
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
    const dataDir = await mkdtemp(join(tmpdir(), 'lichess-user-dump-parse-fail-'));
    tempDirs.push(dataDir);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ count: { all: 123 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response('not-json\n', { status: 200 }));
    const client = new LichessClient(fetchImpl as unknown as typeof fetch, 'https://explorer.lichess.ovh', () => {}, () => {}, undefined, dataDir);

    await expect(client.getUserMoveStats('x', INITIAL_FEN, 'white')).rejects.toThrow(
      'Received line:\nnot-json',
    );
  });
});
