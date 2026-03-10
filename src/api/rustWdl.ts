import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MoveStats } from '../types.js';

type RustCalculateMoveStatsOptions = {
  fen: string;
  filePaths: string[];
};

type RustMoveStatsRow = {
  san: string;
  white: number;
  draws: number;
  black: number;
  total: number;
};

type RustCalculateWdlService = {
  calculateMoveStats: (options: RustCalculateMoveStatsOptions) => Promise<RustMoveStatsRow[]>;
};

let rustServicePromise: Promise<RustCalculateWdlService> | null = null;
let rustUnavailableReason: string | null = null;
let rustUnavailableLogged = false;

async function loadRustCalculateWdlService(): Promise<RustCalculateWdlService> {
  const servicePath = resolve(process.cwd(), 'rust_calculate_wdl', 'service.js');
  const moduleUrl = pathToFileURL(servicePath).href;
  const loaded = (await import(moduleUrl)) as Partial<RustCalculateWdlService>;
  if (typeof loaded.calculateMoveStats !== 'function') {
    throw new Error(`Invalid rust_calculate_wdl service module: ${servicePath}`);
  }
  return loaded as RustCalculateWdlService;
}

function toMoveStatsRow(rawRow: RustMoveStatsRow): MoveStats {
  if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow) || typeof rawRow.san !== 'string') {
    throw new Error('rust_calculate_wdl returned an invalid stats row payload');
  }

  const toFiniteNonNegativeInt = (value: unknown, fieldName: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`rust_calculate_wdl returned non-numeric field: ${fieldName}`);
    }
    return Math.max(0, Math.trunc(value));
  };

  const white = toFiniteNonNegativeInt(rawRow.white, 'white');
  const draws = toFiniteNonNegativeInt(rawRow.draws, 'draws');
  const black = toFiniteNonNegativeInt(rawRow.black, 'black');
  const totalFromParts = white + draws + black;
  const totalCandidate = toFiniteNonNegativeInt(rawRow.total, 'total');
  const total = totalCandidate === totalFromParts ? totalCandidate : totalFromParts;

  return {
    san: rawRow.san,
    white,
    draws,
    black,
    total,
  };
}

function markRustUnavailable(error: unknown, onUnavailable?: (message: string) => void): void {
  const message = error instanceof Error ? error.message : String(error);
  rustUnavailableReason = message;
  rustServicePromise = null;
  if (!rustUnavailableLogged && onUnavailable) {
    rustUnavailableLogged = true;
    onUnavailable(`rust_calculate_wdl unavailable; using TypeScript fallback (${message})`);
  }
}

export async function tryCalculateMoveStatsWithRust(
  filePaths: string[],
  fen: string,
  onUnavailable?: (message: string) => void,
): Promise<MoveStats[] | null> {
  if (rustUnavailableReason !== null) {
    return null;
  }

  try {
    if (!rustServicePromise) {
      rustServicePromise = loadRustCalculateWdlService();
    }
    const service = await rustServicePromise;
    const rawRows = await service.calculateMoveStats({ fen, filePaths });
    if (!Array.isArray(rawRows)) {
      throw new Error('rust_calculate_wdl returned a non-array payload');
    }
    return rawRows.map((row) => toMoveStatsRow(row));
  } catch (error: unknown) {
    markRustUnavailable(error, onUnavailable);
    return null;
  }
}
