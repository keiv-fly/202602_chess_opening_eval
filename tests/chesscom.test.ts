import { describe, expect, it } from 'vitest';
import { moveStatsFromPgnGames } from '../src/api/chesscom.js';

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
});
