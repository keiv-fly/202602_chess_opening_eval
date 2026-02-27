import { describe, expect, it } from 'vitest';
import { mergeStats, renderStatsTable } from '../src/evaluator.js';

describe('evaluator', () => {
  it('sorts by lichess user total first, then lichess db total', () => {
    const rows = mergeStats(
      [
        { san: 'Nf3', total: 20, white: 10, draws: 5, black: 5 },
        { san: 'e4', total: 30, white: 15, draws: 5, black: 10 },
      ],
      [{ san: 'd4', total: 99, white: 33, draws: 33, black: 33 }],
      [{ san: 'd4', total: 120, white: 50, draws: 30, black: 40, eval: { cp: 21, depth: 25 } }],
    );

    expect(rows[0].san).toBe('e4');
    expect(rows[1].san).toBe('Nf3');
    expect(rows[2].san).toBe('d4');
  });

  it('renders a table with formatted eval and percentages', () => {
    const table = renderStatsTable([
      {
        san: 'e4',
        eval: { cp: 34, depth: 25 },
        lichessUser: { san: 'e4', total: 10, white: 6, draws: 2, black: 2 },
        chessComUser: { san: 'e4', total: 8, white: 5, draws: 1, black: 2 },
        lichessDb: { san: 'e4', total: 100, white: 50, draws: 20, black: 30 },
      },
    ]);

    expect(table).toContain('0.34/25');
    expect(table).toContain('10/100% 60.0/20.0/20.0');
    expect(table).toContain('100/100% 50.0/20.0/30.0');
  });

  it('renders 100 percent without decimals and keeps alignment width', () => {
    const table = renderStatsTable([
      {
        san: 'e4',
        eval: { cp: 34, depth: 25 },
        lichessUser: { san: 'e4', total: 10, white: 10, draws: 0, black: 0 },
        chessComUser: { san: 'e4', total: 10, white: 0, draws: 10, black: 0 },
        lichessDb: { san: 'e4', total: 10, white: 0, draws: 0, black: 10 },
      },
    ]);

    expect(table).toContain('10/100%  100/ 0.0/ 0.0');
    expect(table).toContain('10/100%  0.0/ 100/ 0.0');
    expect(table).toContain('10/100%  0.0/ 0.0/ 100');
  });

  it('shows move share and uses k suffix for lichess db when top db row is in millions', () => {
    const table = renderStatsTable([
      {
        san: 'e4',
        eval: { cp: 34, depth: 25 },
        lichessUser: { san: 'e4', total: 10, white: 6, draws: 2, black: 2 },
        chessComUser: { san: 'e4', total: 8, white: 5, draws: 1, black: 2 },
        lichessDb: { san: 'e4', total: 403_048_999, white: 50, draws: 20, black: 30 },
      },
      {
        san: 'd4',
        eval: { cp: 12, depth: 20 },
        lichessUser: { san: 'd4', total: 10, white: 4, draws: 3, black: 3 },
        chessComUser: { san: 'd4', total: 8, white: 3, draws: 2, black: 3 },
        lichessDb: { san: 'd4', total: 403_048_111, white: 45, draws: 25, black: 30 },
      },
    ]);

    expect(table).toContain('10/50%');
    expect(table).toContain('8/50%');
    expect(table).toContain('403048k/50%');
  });
});
