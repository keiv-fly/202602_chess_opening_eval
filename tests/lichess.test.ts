import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LichessClient, moveStatsFromLichessGames } from '../src/api/lichess.js';
import { normalizeFenWithoutMoveCounters } from '../src/fen.js';

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FEN_AFTER_E4_C5 = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

const SAMPLE_GAMES = [
  {
    id: 'sample-1',
    createdAt: Date.UTC(2024, 0, 20),
    moves: 'e2e4 e7e5 g1f3',
    winner: 'white',
    players: {
      white: { user: { name: 'me' } },
      black: { user: { name: 'op1' } },
    },
  },
  {
    id: 'sample-2',
    createdAt: Date.UTC(2024, 1, 2),
    moves: 'd2d4 d7d5 c2c4',
    status: 'draw',
    players: {
      white: { user: { name: 'me' } },
      black: { user: { name: 'op2' } },
    },
  },
  {
    id: 'sample-3',
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

function localEvalResponse(
  depth: number,
  pv: { moves?: string; cp?: number; mate?: number },
): { data: { depth: number; pvs: Array<{ moves?: string; cp?: number; mate?: number }> }; rawResponseText: string } {
  const data = { depth, pvs: [pv] };
  return { data, rawResponseText: JSON.stringify(data) };
}

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

  it('collects move stats from SAN move strings in Lichess game files', () => {
    const stats = moveStatsFromLichessGames(
      [
        {
          createdAt: Date.UTC(2026, 1, 27),
          moves: 'e4 c5 Nf3 e6',
          winner: 'white',
          players: {
            white: { user: { name: 'me', id: 'me' } },
            black: { user: { name: 'op1', id: 'op1' } },
          },
        },
      ],
      'me',
      FEN_AFTER_E4_C5,
      'white',
    );
    expect(stats).toEqual([{ san: 'Nf3', white: 1, draws: 0, black: 0, total: 1 }]);
  });

  it('ignores non-standard variant games when collecting user stats', () => {
    const stats = moveStatsFromLichessGames(
      [
        {
          createdAt: Date.UTC(2026, 1, 27),
          variant: 'crazyhouse',
          moves: 'e4 d5 exd5 Nf6 c4 g6 Nf3 Qd6 Bd3 e5 Nc3 Bg4 h3 Bxf3 Qxf3 N@f4',
          winner: 'white',
          players: {
            white: { user: { name: 'me', id: 'me' } },
            black: { user: { name: 'op1', id: 'op1' } },
          },
        },
        {
          createdAt: Date.UTC(2026, 1, 28),
          variant: 'standard',
          moves: 'e4 c5 Nf3 e6',
          winner: 'white',
          players: {
            white: { user: { name: 'me', id: 'me' } },
            black: { user: { name: 'op2', id: 'op2' } },
          },
        },
      ],
      'me',
      FEN_AFTER_E4_C5,
      'white',
    );
    expect(stats).toEqual([{ san: 'Nf3', white: 1, draws: 0, black: 0, total: 1 }]);
  });

  it('matches move stats while ignoring FEN move counters', () => {
    const stats = moveStatsFromLichessGames(
      [
        {
          createdAt: Date.UTC(2026, 1, 27),
          moves: 'e4 c5 Nf3 e6',
          winner: 'white',
          players: {
            white: { user: { name: 'me', id: 'me' } },
            black: { user: { name: 'op1', id: 'op1' } },
          },
        },
      ],
      'me',
      'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 37 99',
      'white',
    );
    expect(stats).toEqual([{ san: 'Nf3', white: 1, draws: 0, black: 0, total: 1 }]);
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
    expect(secondCallUrl.searchParams.get('perfType')).toBe(
      'ultraBullet,bullet,blitz,rapid,classical,correspondence',
    );
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

  it('filters user move stats by a since timestamp', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lichess-user-filtered-'));
    tempDirs.push(dataDir);
    const body = `${JSON.stringify(SAMPLE_GAMES[0])}\n${JSON.stringify(SAMPLE_GAMES[1])}\n`;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ count: { all: 999 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(body, { status: 200 }));
    const client = new LichessClient(fetchImpl as unknown as typeof fetch, undefined, () => {}, () => {}, undefined, dataDir);

    const stats = await client.getUserMoveStats('me', INITIAL_FEN, 'white', Date.UTC(2024, 1, 1));

    expect(stats).toEqual([{ san: 'd4', white: 0, draws: 1, black: 0, total: 1 }]);
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

  it('deduplicates existing monthly files and skips duplicate incoming games', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lichess-user-dump-dedup-'));
    tempDirs.push(dataDir);

    const januaryGame = {
      id: 'jan-1',
      createdAt: Date.UTC(2024, 0, 20),
      moves: 'e2e4 e7e5 g1f3',
      winner: 'white',
      players: {
        white: { user: { name: 'me' } },
        black: { user: { name: 'op1' } },
      },
    };
    const februaryGame = {
      id: 'feb-1',
      createdAt: Date.UTC(2024, 1, 2),
      moves: 'd2d4 d7d5 c2c4',
      status: 'draw',
      players: {
        white: { user: { name: 'me' } },
        black: { user: { name: 'op2' } },
      },
    };

    const playerDir = join(dataDir, 'lichess_player', 'me');
    const dataPath = join(playerDir, 'data');
    await mkdir(dataPath, { recursive: true });
    await writeFile(
      join(dataPath, '2024-01.ndjson'),
      `${JSON.stringify(januaryGame)}\n${JSON.stringify(januaryGame)}\n`,
      'utf8',
    );
    await writeFile(join(playerDir, 'last_available_at.txt'), `${januaryGame.createdAt}\n`, 'utf8');
    await writeFile(join(playerDir, 'monthly_games.csv'), 'year_month,games\n2024-01,2\n', 'utf8');

    const body = `${JSON.stringify(februaryGame)}\n${JSON.stringify(februaryGame)}\n`;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ count: { all: 2 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(body, { status: 200 }));
    const client = new LichessClient(fetchImpl as unknown as typeof fetch, undefined, () => {}, () => {}, undefined, dataDir);

    const stats = await client.getUserMoveStats('me', INITIAL_FEN, 'white');
    expect(stats).toHaveLength(2);

    const januaryDumpContents = await readFile(join(dataPath, '2024-01.ndjson'), 'utf8');
    const februaryDumpContents = await readFile(join(dataPath, '2024-02.ndjson'), 'utf8');
    expect(januaryDumpContents.trim().split('\n')).toHaveLength(1);
    expect(februaryDumpContents.trim().split('\n')).toHaveLength(1);

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

  it('retries 429 responses for profile and game dump requests and logs warnings', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lichess-retry-429-'));
    tempDirs.push(dataDir);
    const statusMessages: string[] = [];
    const body = `${JSON.stringify(SAMPLE_GAMES[0])}\n`;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ count: { all: 999 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response(body, { status: 200 }));
    const client = new LichessClient(
      fetchImpl as unknown as typeof fetch,
      undefined,
      (message) => statusMessages.push(message),
      () => {},
      undefined,
      dataDir,
    );

    const stats = await client.getUserMoveStats('me', INITIAL_FEN, 'white');
    expect(stats).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(
      statusMessages.some(
        (message) =>
          message.includes('Warning: GET https://lichess.org/api/user/me') &&
          message.includes('returned 429 Too Many Requests; retry 1/10'),
      ),
    ).toBe(true);
    expect(
      statusMessages.some(
        (message) =>
          message.includes('Warning: GET https://lichess.org/api/games/user/me') &&
          message.includes('returned 429 Too Many Requests; retry 1/10'),
      ),
    ).toBe(true);
  });

  it('maps and caches Lichess database move stats by FEN', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lichess-db-cache-'));
    tempDirs.push(dataDir);
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ moves: [{ san: 'e4', white: 30, draws: 10, black: 20, cp: 34 }] }), {
        status: 200,
      }),
    );
    const client = new LichessClient(
      fetchImpl as unknown as typeof fetch,
      'https://explorer.lichess.ovh',
      () => {},
      () => {},
      undefined,
      dataDir,
    );
    const evalLookupSpy = vi
      .spyOn(client as unknown as { queryEvalForFenFromSource: (fen: string) => Promise<unknown> }, 'queryEvalForFenFromSource')
      .mockImplementation(async (fen: string) => {
        if (fen === 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1') {
          return localEvalResponse(25, { moves: 'e2e4 e7e5', cp: 30 });
        }
        return null;
      });

    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 23 19';
    const normalizedFen = normalizeFenWithoutMoveCounters(fen);
    const db = await client.getDatabaseMoveStats(fen);
    const cachedDb = await client.getDatabaseMoveStats(fen);
    expect(db[0].eval).toEqual({ cp: 30, mate: undefined, depth: 25 });
    expect(cachedDb[0].eval).toEqual({ cp: 30, mate: undefined, depth: 25 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(evalLookupSpy).toHaveBeenCalledTimes(1);

    const dbRequestUrl = fetchImpl.mock.calls[0][0] as URL;
    expect(dbRequestUrl.searchParams.get('moves')).toBe('50');
    expect(dbRequestUrl.searchParams.get('fen')).toBe(normalizedFen);
    expect(dbRequestUrl.searchParams.get('variant')).toBe('standard');

    const cachePath = join(dataDir, 'lichess_database', 'fen', encodeURIComponent(normalizedFen));
    const cacheText = await readFile(cachePath, 'utf8');
    expect(cacheText).toContain('"san":"e4"');
    expect(cacheText).toContain('"cloudEvalsBySan"');
    expect(cacheText).toContain('"depth":25');

    const evalPath = join(dataDir, 'lichess_eval', 'fen', encodeURIComponent(normalizedFen), encodeURIComponent('e4'));
    const evalText = await readFile(evalPath, 'utf8');
    expect(evalText).toContain('"depth":25');
    expect(evalText).toContain('"moves":"e2e4 e7e5"');
    expect(evalText).not.toContain('"source"');
  });

  it('sends bearer auth when querying explorer.lichess.ovh', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lichess-db-auth-explorer-'));
    tempDirs.push(dataDir);
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ moves: [] }), { status: 200 }));
    const client = new LichessClient(
      fetchImpl as unknown as typeof fetch,
      'https://explorer.lichess.ovh',
      () => {},
      () => {},
      undefined,
      dataDir,
      () => {},
      () => 'continue-retries',
      'test-token',
    );

    await client.getDatabaseMoveStats(INITIAL_FEN);

    const requestInit = fetchImpl.mock.calls[0][1] as { headers?: Record<string, string> };
    expect(requestInit.headers?.Authorization).toBe('Bearer test-token');
  });

  it('does not send bearer auth to non-Lichess hosts', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lichess-db-auth-non-lichess-'));
    tempDirs.push(dataDir);
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ moves: [] }), { status: 200 }));
    const client = new LichessClient(
      fetchImpl as unknown as typeof fetch,
      'https://example.com',
      () => {},
      () => {},
      undefined,
      dataDir,
      () => {},
      () => 'continue-retries',
      'test-token',
    );

    await client.getDatabaseMoveStats(INITIAL_FEN);

    const requestInit = fetchImpl.mock.calls[0][1] as { headers?: Record<string, string> };
    expect(requestInit.headers?.Authorization).toBeUndefined();
  });

  it('backfills lichess_eval files from cached cloud eval map with real API output', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lichess-eval-backfill-'));
    tempDirs.push(dataDir);
    const fetchImpl = vi.fn();
    const client = new LichessClient(fetchImpl as unknown as typeof fetch, undefined, () => {}, () => {}, undefined, dataDir);
    const evalLookupSpy = vi
      .spyOn(client as unknown as { queryEvalForFenFromSource: (fen: string) => Promise<unknown> }, 'queryEvalForFenFromSource')
      .mockImplementation(async (fen: string) => {
        if (fen === 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1') {
          return localEvalResponse(31, { moves: 'e7e5', cp: -42 });
        }
        return null;
      });
    const normalizedFen = normalizeFenWithoutMoveCounters(INITIAL_FEN);
    const cachePath = join(dataDir, 'lichess_database', 'fen', encodeURIComponent(normalizedFen));
    await mkdir(join(dataDir, 'lichess_database', 'fen'), { recursive: true });
    await writeFile(
      cachePath,
      `${JSON.stringify({
        fen: normalizedFen,
        cachedAt: Date.now(),
        moves: [{ san: 'e4', white: 1, draws: 0, black: 0 }],
        cloudEvalsBySan: { e4: { cp: 42, depth: 31 } },
      })}\n`,
      'utf8',
    );

    const db = await client.getDatabaseMoveStats(INITIAL_FEN);
    expect(db.find((move) => move.san === 'e4')?.eval).toEqual({ cp: -42, mate: undefined, depth: 31 });
    expect(fetchImpl).toHaveBeenCalledTimes(0);
    expect(evalLookupSpy).toHaveBeenCalledTimes(1);

    const evalPath = join(dataDir, 'lichess_eval', 'fen', encodeURIComponent(normalizedFen), encodeURIComponent('e4'));
    const evalText = await readFile(evalPath, 'utf8');
    expect(evalText).toContain('"depth":31');
    expect(evalText).toContain('"moves":"e7e5"');
    expect(evalText).toContain('"cp":-42');
    expect(evalText).not.toContain('"source"');
  });

  it('keeps root cloud eval signs unchanged from API response', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lichess-db-white-perspective-'));
    tempDirs.push(dataDir);
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ moves: [{ san: 'e5', white: 30, draws: 10, black: 20 }] }), {
        status: 200,
      }),
    );
    const client = new LichessClient(fetchImpl as unknown as typeof fetch, undefined, () => {}, () => {}, undefined, dataDir);
    const evalLookupSpy = vi
      .spyOn(client as unknown as { queryEvalForFenFromSource: (fen: string) => Promise<unknown> }, 'queryEvalForFenFromSource')
      .mockResolvedValue(localEvalResponse(26, { moves: 'e7e5 g1f3', cp: 40 }));

    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const db = await client.getDatabaseMoveStats(fen);
    expect(db.find((move) => move.san === 'e5')?.eval).toEqual({ cp: 40, mate: undefined, depth: 26 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(evalLookupSpy).toHaveBeenCalledTimes(1);
  });

  it('fills missing move evals using child-position cloud eval', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lichess-db-cloud-eval-all-moves-'));
    tempDirs.push(dataDir);
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          moves: [
            { san: 'e4', white: 30, draws: 10, black: 20 },
            { san: 'd4', white: 25, draws: 10, black: 15 },
          ],
        }),
        { status: 200 },
      ),
    );
    const client = new LichessClient(fetchImpl as unknown as typeof fetch, undefined, () => {}, () => {}, undefined, dataDir);
    const evalLookupSpy = vi
      .spyOn(client as unknown as { queryEvalForFenFromSource: (fen: string) => Promise<unknown> }, 'queryEvalForFenFromSource')
      .mockImplementation(async (fen: string) => {
        if (fen === 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1') {
          return localEvalResponse(25, { moves: 'e2e4 e7e5', cp: 30 });
        }
        if (fen === 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1') {
          return localEvalResponse(20, { moves: 'd7d5', cp: 12 });
        }
        return null;
      });

    const db = await client.getDatabaseMoveStats(INITIAL_FEN);
    const cachedDb = await client.getDatabaseMoveStats(INITIAL_FEN);
    expect(db.find((move) => move.san === 'e4')?.eval).toEqual({ cp: 30, mate: undefined, depth: 25 });
    expect(db.find((move) => move.san === 'd4')?.eval).toEqual({ cp: 12, mate: undefined, depth: 20 });
    expect(cachedDb.find((move) => move.san === 'd4')?.eval).toEqual({ cp: 12, mate: undefined, depth: 20 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(evalLookupSpy).toHaveBeenCalledTimes(2);

    const childEvalPath = join(dataDir, 'lichess_eval', 'fen', encodeURIComponent(INITIAL_FEN), encodeURIComponent('d4'));
    const childEvalText = await readFile(childEvalPath, 'utf8');
    expect(childEvalText).toContain('"depth":20');
    expect(childEvalText).toContain('"moves":"d7d5"');
    expect(childEvalText).not.toContain('"source"');
  });

  it('fetches only uncached cloud eval positions first', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lichess-db-prefers-uncached-'));
    tempDirs.push(dataDir);
    const fetchImpl = vi.fn();
    const client = new LichessClient(fetchImpl as unknown as typeof fetch, undefined, () => {}, () => {}, undefined, dataDir);
    const evalLookupSpy = vi
      .spyOn(client as unknown as { queryEvalForFenFromSource: (fen: string) => Promise<unknown> }, 'queryEvalForFenFromSource')
      .mockImplementation(async (fen: string) => {
        if (fen === 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1') {
          return localEvalResponse(20, { moves: 'd7d5', cp: 12 });
        }
        return null;
      });
    const normalizedFen = normalizeFenWithoutMoveCounters(INITIAL_FEN);
    const cachePath = join(dataDir, 'lichess_database', 'fen', encodeURIComponent(normalizedFen));
    await mkdir(join(dataDir, 'lichess_database', 'fen'), { recursive: true });
    await writeFile(
      cachePath,
      `${JSON.stringify({
        fen: normalizedFen,
        cachedAt: Date.now(),
        moves: [
          { san: 'e4', white: 30, draws: 10, black: 20 },
          { san: 'd4', white: 25, draws: 10, black: 15 },
        ],
      })}\n`,
      'utf8',
    );

    const evalDir = join(dataDir, 'lichess_eval', 'fen', encodeURIComponent(normalizedFen));
    await mkdir(evalDir, { recursive: true });
    await writeFile(
      join(evalDir, encodeURIComponent('e4')),
      JSON.stringify({ depth: 25, pvs: [{ moves: 'e2e4 e7e5', cp: 30 }] }),
      'utf8',
    );

    const db = await client.getDatabaseMoveStats(INITIAL_FEN);
    expect(db.find((move) => move.san === 'e4')?.eval).toEqual({ cp: 30, mate: undefined, depth: 25 });
    expect(db.find((move) => move.san === 'd4')?.eval).toEqual({ cp: 12, mate: undefined, depth: 20 });
    expect(fetchImpl).toHaveBeenCalledTimes(0);
    expect(evalLookupSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps cached move evals when local eval lookup returns no row', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lichess-db-local-eval-missing-'));
    tempDirs.push(dataDir);
    const fetchImpl = vi.fn();
    const onCloudEvalFirstRetryWhenCacheReady = vi.fn().mockResolvedValue('use-cached-values');
    const client = new LichessClient(
      fetchImpl as unknown as typeof fetch,
      undefined,
      () => {},
      () => {},
      undefined,
      dataDir,
      () => {},
      onCloudEvalFirstRetryWhenCacheReady,
    );
    const evalLookupSpy = vi
      .spyOn(client as unknown as { queryEvalForFenFromSource: (fen: string) => Promise<unknown> }, 'queryEvalForFenFromSource')
      .mockResolvedValue(null);
    const normalizedFen = normalizeFenWithoutMoveCounters(INITIAL_FEN);
    const cachePath = join(dataDir, 'lichess_database', 'fen', encodeURIComponent(normalizedFen));
    await mkdir(join(dataDir, 'lichess_database', 'fen'), { recursive: true });
    await writeFile(
      cachePath,
      `${JSON.stringify({
        fen: normalizedFen,
        cachedAt: Date.now(),
        moves: [{ san: 'e4', white: 30, draws: 10, black: 20 }],
        cloudEvalsBySan: { e4: { cp: 30, depth: 25 } },
      })}\n`,
      'utf8',
    );

    const db = await client.getDatabaseMoveStats(INITIAL_FEN);
    expect(db.find((move) => move.san === 'e4')?.eval).toEqual({ cp: 30, mate: undefined, depth: 25 });
    expect(fetchImpl).toHaveBeenCalledTimes(0);
    expect(evalLookupSpy).toHaveBeenCalledTimes(1);
    expect(onCloudEvalFirstRetryWhenCacheReady).toHaveBeenCalledTimes(0);
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
