import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChessComClient, moveStatsFromPgnGames } from '../src/api/chesscom.js';

const GAMES = [
  {
    pgn: '[Event "Live Chess"]\n[Site "Chess.com"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0',
    white: { username: 'me', result: 'win' },
    black: { username: 'op', result: 'resigned' },
  },
  {
    pgn: '[Event "Live Chess"]\n[Site "Chess.com"]\n[Result "0-1"]\n\n1. e4 c5 2. Nf3 d6 0-1',
    white: { username: 'me', result: 'resigned' },
    black: { username: 'op2', result: 'win' },
  },
  {
    pgn: '[Event "Live Chess"]\n[Site "Chess.com"]\n[Result "1/2-1/2"]\n\n1. d4 d5 1/2-1/2',
    white: { username: 'other', result: 'agreed' },
    black: { username: 'me', result: 'agreed' },
  },
] as const;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('moveStatsFromPgnGames', () => {
  it('collects next-move stats for matching FEN and side', () => {
    const initialFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const stats = moveStatsFromPgnGames([...GAMES], 'me', initialFen, 'white');

    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ san: 'e4', total: 2, white: 1, black: 1, draws: 0 });
  });

  it('handles black side and draw outcomes', () => {
    const initialFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const stats = moveStatsFromPgnGames([...GAMES], 'me', initialFen, 'black');

    expect(stats[0]).toMatchObject({ san: 'd4', total: 1, draws: 1 });
  });

  it('matches move stats while ignoring FEN move counters', () => {
    const fenWithDifferentMoveCounters =
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 27 42';
    const stats = moveStatsFromPgnGames([...GAMES], 'me', fenWithDifferentMoveCounters, 'white');

    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ san: 'e4', total: 2, white: 1, black: 1, draws: 0 });
  });

  it('ignores non-standard variant games', () => {
    const initialFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const stats = moveStatsFromPgnGames(
      [
        {
          pgn: '[Event "Live Chess"]\n[Site "Chess.com"]\n[Result "1-0"]\n\n1. e4 e5 1-0',
          white: { username: 'me', result: 'win' },
          black: { username: 'op', result: 'resigned' },
        },
        {
          pgn: '[Event "Live Chess"]\n[Site "Chess.com"]\n[Variant "Chess960"]\n[Result "1-0"]\n\n1. e4 e5 1-0',
          white: { username: 'me', result: 'win' },
          black: { username: 'op2', result: 'resigned' },
        },
        {
          pgn: '[Event "Live Chess"]\n[Site "Chess.com"]\n[Result "1-0"]\n\n1. e4 e5 1-0',
          white: { username: 'me', result: 'win' },
          black: { username: 'op3', result: 'resigned' },
          rules: 'chess960',
        },
      ],
      'me',
      initialFen,
      'white',
    );

    expect(stats).toEqual([{ san: 'e4', white: 1, draws: 0, black: 0, total: 1 }]);
  });
});

describe('ChessComClient', () => {
  it('requests archives from the official /pub endpoint', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'chesscom-endpoint-'));
    tempDirs.push(dataDir);
    const initialFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            archives: ['https://api.chess.com/pub/player/keiv84/games/2024/01'],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ games: [] }), { status: 200 }));

    const client = new ChessComClient(fetchImpl as unknown as typeof fetch, undefined, () => {}, dataDir);
    const stats = await client.getUserMoveStats('keiv84', initialFen, 'white');

    expect(stats).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const archivesUrl = fetchImpl.mock.calls[0][0] as URL;
    expect(archivesUrl.toString()).toBe('https://api.chess.com/pub/player/keiv84/games/archives');
  });

  it('downloads monthly archives to data_in/chess_com_player and writes monthly_games.csv', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'chesscom-user-dump-'));
    tempDirs.push(dataDir);
    const initialFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const progressEvents: Array<{ loaded: number; total: number; done: boolean }> = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            archives: [
              'https://api.chess.com/pub/player/me/games/2024/01',
              'https://api.chess.com/pub/player/me/games/2024/02',
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ games: [GAMES[0]] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ games: [GAMES[1], GAMES[2]] }), { status: 200 }));

    const client = new ChessComClient(
      fetchImpl as unknown as typeof fetch,
      undefined,
      () => {},
      dataDir,
      (loaded, total, done) => progressEvents.push({ loaded, total, done }),
    );

    const first = await client.getUserMoveStats('me', initialFen, 'white');
    const second = await client.getUserMoveStats('me', initialFen, 'white');

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const userDir = join(dataDir, 'chess_com_player', 'me');
    const januaryDump = await readFile(join(userDir, 'data', '2024-01.ndjson'), 'utf8');
    const februaryDump = await readFile(join(userDir, 'data', '2024-02.ndjson'), 'utf8');
    const monthlyCsv = await readFile(join(userDir, 'monthly_games.csv'), 'utf8');

    expect(januaryDump).toContain('[Site \\"Chess.com\\"]');
    expect(februaryDump).toContain('[Site \\"Chess.com\\"]');
    expect(monthlyCsv).toBe('year_month,games\n2024-01,1\n2024-02,2\n');

    expect(progressEvents[0]).toEqual({ loaded: 0, total: 2, done: false });
    expect(progressEvents[progressEvents.length - 1]).toEqual({ loaded: 2, total: 2, done: true });
  });

  it('filters user move stats by a since timestamp', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'chesscom-user-filtered-'));
    tempDirs.push(dataDir);
    const initialFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const januaryGames = [
      {
        pgn: '[Event "Live Chess"]\n[Site "Chess.com"]\n[Result "1-0"]\n\n1. e4 e5 1-0',
        white: { username: 'me', result: 'win' },
        black: { username: 'op', result: 'resigned' },
        end_time: Math.floor(Date.UTC(2024, 0, 20) / 1000),
      },
    ];
    const februaryGames = [
      {
        pgn: '[Event "Live Chess"]\n[Site "Chess.com"]\n[Result "1-0"]\n\n1. d4 d5 1-0',
        white: { username: 'me', result: 'win' },
        black: { username: 'op2', result: 'resigned' },
        end_time: Math.floor(Date.UTC(2024, 1, 2) / 1000),
      },
    ];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            archives: [
              'https://api.chess.com/pub/player/me/games/2024/01',
              'https://api.chess.com/pub/player/me/games/2024/02',
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ games: januaryGames }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ games: februaryGames }), { status: 200 }));
    const client = new ChessComClient(fetchImpl as unknown as typeof fetch, undefined, () => {}, dataDir);

    const stats = await client.getUserMoveStats('me', initialFen, 'white', Date.UTC(2024, 1, 1));

    expect(stats).toEqual([{ san: 'd4', white: 1, draws: 0, black: 0, total: 1 }]);
  });

  it('does not emit chess.com network started lines', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'chesscom-no-started-lines-'));
    tempDirs.push(dataDir);
    const initialFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const statusMessages: string[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            archives: ['https://api.chess.com/pub/player/keiv84/games/2024/01'],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ games: [] }), { status: 200 }));

    const client = new ChessComClient(
      fetchImpl as unknown as typeof fetch,
      undefined,
      (message) => statusMessages.push(message),
      dataDir,
    );
    await client.getUserMoveStats('keiv84', initialFen, 'white');

    expect(statusMessages.some((message) => message.includes(' started'))).toBe(false);
    expect(
      statusMessages.some((message) =>
        message.includes('Network: GET https://api.chess.com/pub/player/keiv84/games/archives -> 200'),
      ),
    ).toBe(true);
  });

  it('retries 429 responses up to two times within the retry window and logs warnings', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'chesscom-retry-429-'));
    tempDirs.push(dataDir);
    const initialFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const statusMessages: string[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response('', { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            archives: ['https://api.chess.com/pub/player/keiv84/games/2024/01'],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ games: [] }), { status: 200 }));

    const client = new ChessComClient(
      fetchImpl as unknown as typeof fetch,
      undefined,
      (message) => statusMessages.push(message),
      dataDir,
    );

    const stats = await client.getUserMoveStats('keiv84', initialFen, 'white');
    expect(stats).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(statusMessages.some((message) => message.includes('Warning: GET https://api.chess.com/pub/player/keiv84/games/archives returned 429 Too Many Requests; retry 1/2'))).toBe(true);
    expect(statusMessages.some((message) => message.includes('Warning: GET https://api.chess.com/pub/player/keiv84/games/archives returned 429 Too Many Requests; retry 2/2'))).toBe(true);
  });
});
