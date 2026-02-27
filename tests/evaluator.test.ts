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
      [{ san: 'd4', total: 120, white: 50, draws: 30, black: 40, eval: { cp: 21 } }],
    );

    expect(rows[0].san).toBe('e4');
    expect(rows[1].san).toBe('Nf3');
    expect(rows[2].san).toBe('d4');
  });

  it('renders a table with formatted eval and percentages', () => {
    const table = renderStatsTable([
      {
        san: 'e4',
        eval: { cp: 34 },
        lichessUser: { san: 'e4', total: 10, white: 6, draws: 2, black: 2 },
        chessComUser: { san: 'e4', total: 8, white: 5, draws: 1, black: 2 },
        lichessDb: { san: 'e4', total: 100, white: 50, draws: 20, black: 30 },
      },
    ]);

    expect(table).toContain('0.34');
    expect(table).toContain('10 60.0/20.0/20.0');
    expect(table).toContain('100 50.0/20.0/30.0');
  });
});
