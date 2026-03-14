import { Chess } from 'chess.js';
import type { InitialPositionInput, Side, UserTimeFilter } from './types.js';

export const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function parseInitialPosition(input: string): InitialPositionInput {
  const trimmedInput = input.trim();
  if (trimmedInput === '') {
    return {
      baseFen: STARTING_FEN,
      currentFen: STARTING_FEN,
      initialHistory: [],
    };
  }

  const fenCandidate = new Chess();
  try {
    fenCandidate.load(trimmedInput);
    const normalizedFen = fenCandidate.fen();
    return {
      baseFen: normalizedFen,
      currentFen: normalizedFen,
      initialHistory: [],
    };
  } catch {
    // Try SAN parsing below.
  }

  const sanPosition = new Chess();
  const rawTokens = trimmedInput.replaceAll(',', ' ').split(/\s+/u);
  const initialHistory: string[] = [];
  let parsedAnyMove = false;

  for (const rawToken of rawTokens) {
    const san = normalizeInitialSanToken(rawToken);
    if (!san) {
      continue;
    }
    if (san === '1-0' || san === '0-1' || san === '1/2-1/2' || san === '*') {
      break;
    }

    const result = sanPosition.move(san, { strict: false });
    if (!result) {
      throw new Error('Position input must be a valid FEN or SAN moves from starting position.');
    }
    initialHistory.push(result.san);
    parsedAnyMove = true;
  }

  if (!parsedAnyMove) {
    throw new Error('Position input must be a valid FEN or SAN moves from starting position.');
  }

  return {
    baseFen: STARTING_FEN,
    currentFen: sanPosition.fen(),
    initialHistory,
  };
}

export function resolvePositionFromHistory(baseFen: string, history: string[]): { fen: string; side: Side } | null {
  const chess = new Chess();
  chess.load(baseFen);
  for (const move of history) {
    let result: ReturnType<Chess['move']>;
    try {
      result = chess.move(move, { strict: false });
    } catch {
      return null;
    }
    if (!result) {
      return null;
    }
  }
  return {
    fen: chess.fen(),
    side: chess.turn() === 'w' ? 'white' : 'black',
  };
}

export function parseUserTimeFilter(input: string): UserTimeFilter {
  const trimmed = input.trim();
  if (trimmed === '') {
    return {
      sinceTimestampMs: null,
      cacheKey: 'all-time',
      label: 'all-time',
    };
  }

  const yearMatch = /^(\d{4})$/u.exec(trimmed);
  if (yearMatch) {
    const year = Number.parseInt(yearMatch[1], 10);
    const sinceTimestampMs = Date.UTC(year, 0, 1, 0, 0, 0, 0);
    return {
      sinceTimestampMs,
      cacheKey: `since-${sinceTimestampMs}`,
      label: `since ${new Date(sinceTimestampMs).toISOString()} (${trimmed} => Jan 1)`,
    };
  }

  const yearMonthMatch = /^(\d{4})-(\d{2})$/u.exec(trimmed);
  if (yearMonthMatch) {
    const year = Number.parseInt(yearMonthMatch[1], 10);
    const month = Number.parseInt(yearMonthMatch[2], 10);
    if (month < 1 || month > 12) {
      throw new Error('Time filter month must be in 01..12.');
    }
    const sinceTimestampMs = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
    return {
      sinceTimestampMs,
      cacheKey: `since-${sinceTimestampMs}`,
      label: `since ${new Date(sinceTimestampMs).toISOString()} (${trimmed} => 1st day of month)`,
    };
  }

  if (!/^\d{4}-\d{2}-\d{2}(?:[Tt ].*)?$/u.test(trimmed)) {
    throw new Error('Time filter must be ISO date/time, YYYY-MM, or YYYY.');
  }

  const parsedTimestamp = Date.parse(trimmed);
  if (Number.isNaN(parsedTimestamp)) {
    throw new Error('Time filter must be ISO date/time, YYYY-MM, or YYYY.');
  }

  return {
    sinceTimestampMs: parsedTimestamp,
    cacheKey: `since-${parsedTimestamp}`,
    label: `since ${new Date(parsedTimestamp).toISOString()}`,
  };
}

export function parseSideInput(input: string): Side {
  const normalized = input.trim().toLowerCase();
  if (normalized === 'white' || normalized === 'w') {
    return 'white';
  }
  if (normalized === 'black' || normalized === 'b') {
    return 'black';
  }
  throw new Error('Side must be white/black or w/b.');
}

export function formatTimestamp(date: Date): string {
  const pad2 = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

function normalizeInitialSanToken(token: string): string | null {
  const trimmedToken = token.trim();
  if (trimmedToken === '') {
    return null;
  }
  if (/^\d+\.(?:\.\.)?$/u.test(trimmedToken)) {
    return null;
  }

  const tokenWithoutMoveNumber = trimmedToken.replace(/^\d+\.(?:\.\.)?/u, '').replace(/^\.\.\./u, '');
  if (tokenWithoutMoveNumber === '') {
    return null;
  }

  const tokenWithoutAnnotations = tokenWithoutMoveNumber.replace(/[!?]+$/u, '');
  if (tokenWithoutAnnotations === '') {
    return null;
  }
  return tokenWithoutAnnotations;
}
