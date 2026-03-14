import { describe, expect, it } from 'vitest';
import {
  STARTING_FEN,
  parseInitialPosition,
  parseSideInput,
  parseUserTimeFilter,
  resolvePositionFromHistory,
} from '../src/workflow.js';

describe('workflow helpers', () => {
  it('parses SAN input into a starting-position base with canonical history', () => {
    const result = parseInitialPosition('1. e4 e5 2. Nf3');

    expect(result.baseFen).toBe(STARTING_FEN);
    expect(result.initialHistory).toEqual(['e4', 'e5', 'Nf3']);
    expect(result.currentFen).toBe('rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2');
  });

  it('resolves a position from base FEN plus SAN history', () => {
    const resolved = resolvePositionFromHistory(STARTING_FEN, ['e4', 'e5', 'Nf3']);

    expect(resolved).toEqual({
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
      side: 'black',
    });
  });

  it('parses year-month time filters into the first day of the month', () => {
    const result = parseUserTimeFilter('2026-03');

    expect(result.sinceTimestampMs).toBe(Date.UTC(2026, 2, 1, 0, 0, 0, 0));
    expect(result.cacheKey).toBe(`since-${Date.UTC(2026, 2, 1, 0, 0, 0, 0)}`);
  });

  it('accepts short side aliases', () => {
    expect(parseSideInput('w')).toBe('white');
    expect(parseSideInput('b')).toBe('black');
  });
});
