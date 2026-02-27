import { describe, expect, it } from 'vitest';
import { renderBoard } from '../src/board.js';

describe('renderBoard', () => {
  it('renders board with coordinates and unicode pieces', () => {
    const board = renderBoard('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
    expect(board).toContain('a b c d e f g h');
    expect(board).toContain('♖');
    expect(board).toContain('·');
  });
});
