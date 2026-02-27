import { describe, expect, it } from 'vitest';
import { renderBoard } from '../src/board.js';

describe('renderBoard', () => {
  it('renders board with left ranks, bottom files, and unicode pieces', () => {
    const board = renderBoard('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
    const lines = board.split('\n');

    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe('8 · · · · ♚ · · ·');
    expect(lines[8]).toBe('  a b c d e f g h');
    expect(board).toContain('♖');
    expect(board).toContain('·');
  });
});
