import { Chess } from 'chess.js';
import { createReadStream, type Dirent } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import readline from 'node:readline';
import { normalizeFenWithoutMoveCounters } from '../fen.js';
import type { MoveStats, Side } from '../types.js';
import { tryCalculateMoveStatsWithRust } from './rustWdl.js';
import { fetchWith429Retries } from './retry.js';

type ArchivesResponse = { archives: string[] };
type ChessComUserGame = {
  pgn: string;
  white: { username: string; result: string };
  black: { username: string; result: string };
  end_time?: number;
  rules?: string;
};

type GamesResponse = {
  games: ChessComUserGame[];
};

type RequestOptions = {
  logNetwork?: boolean;
  logStarted?: boolean;
};

type UserCachePaths = {
  playerDirectory: string;
  dataDirectory: string;
  dataUciDirectory: string;
  byFenDirectory: string;
  monthlyGameCountCsvPath: string;
};

type UserByFenCachePayload = {
  source: 'chesscom-user-by-fen-v1';
  fen: string;
  side: Side;
  sinceTimestampMs: number | null;
  generatedAt: number;
  moves: MoveStats[];
};

const CHESSCOM_PLAYER_CACHE_ROOT = 'chess_com_player';
const CHESSCOM_PLAYER_DATA_DIRECTORY = 'data';
const CHESSCOM_PLAYER_DATA_UCI_DIRECTORY = 'data_uci';
const CHESSCOM_PLAYER_BY_FEN_DIRECTORY = 'by_fen';
const CHESSCOM_PLAYER_MONTHLY_GAME_COUNT_FILE = 'monthly_games.csv';

function normalizeResult(result: string): 'white' | 'black' | 'draw' | 'skip' {
  if (['win', 'checkmated', 'timeout', 'resigned', 'abandoned', 'lose', 'insufficient', '50move', 'repetition', 'stalemate', 'agreed'].includes(result)) {
    if (result === 'win') return 'white';
    if (['stalemate', 'agreed', 'repetition', '50move', 'insufficient'].includes(result)) return 'draw';
    return 'black';
  }
  if (['timeoutvsinsufficient', 'timevsinsufficient'].includes(result)) return 'draw';
  return 'skip';
}

function gameOutcome(whiteResult: string, blackResult: string): 'white' | 'black' | 'draw' | null {
  if (whiteResult === 'win' || blackResult === 'checkmated' || blackResult === 'timeout' || blackResult === 'resigned' || blackResult === 'abandoned' || blackResult === 'lose') {
    return 'white';
  }
  if (blackResult === 'win' || whiteResult === 'checkmated' || whiteResult === 'timeout' || whiteResult === 'resigned' || whiteResult === 'abandoned' || whiteResult === 'lose') {
    return 'black';
  }
  const w = normalizeResult(whiteResult);
  const b = normalizeResult(blackResult);
  if (w === 'draw' || b === 'draw') return 'draw';
  return null;
}

function sanitizeUserForFileName(user: string): string {
  return user.replace(/[^A-Za-z0-9_-]/g, '_');
}

function parseYearMonthFromArchiveUrl(archiveUrl: string): string | null {
  try {
    const parsed = new URL(archiveUrl);
    const match = parsed.pathname.match(/\/games\/(\d{4})\/(\d{2})\/?$/u);
    if (!match) {
      return null;
    }
    return `${match[1]}-${match[2]}`;
  } catch {
    return null;
  }
}

function parseYearMonthFromDataFileName(fileName: string): string | null {
  const match = /^(\d{4}-\d{2})\.ndjson$/u.exec(fileName);
  return match ? match[1] : null;
}

function parseYearMonthFromSanFileName(fileName: string): string | null {
  const match = /^(\d{4}-\d{2})\.txt$/u.exec(fileName);
  return match ? match[1] : null;
}

function sinceTimestampCacheKey(sinceTimestampMs: number | null): string {
  return sinceTimestampMs === null ? 'all-time' : `since-${sinceTimestampMs}`;
}

function formatYearMonth(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function parsePgnTagValue(pgn: string, tag: string): string | null {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = pgn.match(new RegExp(`\\[${escapedTag}\\s+"([^"]+)"\\]`, 'u'));
  return match?.[1]?.trim() || null;
}

function isStandardChessComGame(game: ChessComUserGame): boolean {
  const normalizedRules = game.rules?.trim().toLowerCase();
  if (normalizedRules && normalizedRules !== 'chess') {
    return false;
  }
  const variantTag = parsePgnTagValue(game.pgn, 'Variant');
  if (!variantTag) {
    return true;
  }
  return variantTag.trim().toLowerCase() === 'standard';
}

function extractGameTimestampMs(game: ChessComUserGame): number | null {
  if (typeof game.end_time === 'number' && Number.isFinite(game.end_time)) {
    return game.end_time >= 1_000_000_000_000 ? game.end_time : game.end_time * 1000;
  }

  const dateText = parsePgnTagValue(game.pgn, 'UTCDate') ?? parsePgnTagValue(game.pgn, 'Date');
  if (!dateText) {
    return null;
  }
  const dateMatch = /^(\d{4})\.(\d{2})\.(\d{2})$/u.exec(dateText);
  if (!dateMatch) {
    return null;
  }

  const year = Number.parseInt(dateMatch[1], 10);
  const month = Number.parseInt(dateMatch[2], 10);
  const day = Number.parseInt(dateMatch[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  let hour = 0;
  let minute = 0;
  let second = 0;
  const timeText = parsePgnTagValue(game.pgn, 'UTCTime');
  if (timeText) {
    const timeMatch = /^(\d{2}):(\d{2}):(\d{2})$/u.exec(timeText);
    if (!timeMatch) {
      return null;
    }
    hour = Number.parseInt(timeMatch[1], 10);
    minute = Number.parseInt(timeMatch[2], 10);
    second = Number.parseInt(timeMatch[3], 10);
    if (hour > 23 || minute > 59 || second > 59) {
      return null;
    }
  }

  const timestampMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const parsedDate = new Date(timestampMs);
  if (
    parsedDate.getUTCFullYear() !== year ||
    parsedDate.getUTCMonth() !== month - 1 ||
    parsedDate.getUTCDate() !== day ||
    parsedDate.getUTCHours() !== hour ||
    parsedDate.getUTCMinutes() !== minute ||
    parsedDate.getUTCSeconds() !== second
  ) {
    return null;
  }
  return timestampMs;
}

function addGameMoveStat(
  map: Map<string, MoveStats>,
  game: ChessComUserGame,
  username: string,
  fen: string,
  side: Side,
): void {
  if (!isStandardChessComGame(game)) {
    return;
  }

  const normalizedTargetFen = normalizeFenWithoutMoveCounters(fen);
  const targetUser = username.toLowerCase();
  const isWhite = game.white.username.toLowerCase() === targetUser;
  const isBlack = game.black.username.toLowerCase() === targetUser;
  if ((side === 'white' && !isWhite) || (side === 'black' && !isBlack)) return;

  const chess = new Chess();
  try {
    chess.loadPgn(game.pgn);
  } catch {
    return;
  }

  const history = chess.history({ verbose: true });
  const replay = new Chess();
  let targetMoveSan: string | null = null;

  for (const move of history) {
    if (normalizeFenWithoutMoveCounters(replay.fen()) === normalizedTargetFen) {
      targetMoveSan = move.san;
      break;
    }
    replay.move(move);
  }

  if (!targetMoveSan) return;

  const winner = gameOutcome(game.white.result, game.black.result);
  if (!winner) return;

  const existing = map.get(targetMoveSan) ?? {
    san: targetMoveSan,
    white: 0,
    draws: 0,
    black: 0,
    total: 0,
  };

  if (winner === 'white') existing.white += 1;
  else if (winner === 'black') existing.black += 1;
  else existing.draws += 1;

  existing.total += 1;
  map.set(targetMoveSan, existing);
}

function sortMoveStats(stats: Iterable<MoveStats>): MoveStats[] {
  return [...stats].sort((a, b) => b.total - a.total || a.san.localeCompare(b.san));
}

function parseMoveStatsArray(raw: unknown): MoveStats[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }

  const parsed: MoveStats[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return null;
    }

    const san = typeof (row as { san?: unknown }).san === 'string' ? (row as { san: string }).san : null;
    const white = typeof (row as { white?: unknown }).white === 'number' ? (row as { white: number }).white : null;
    const draws = typeof (row as { draws?: unknown }).draws === 'number' ? (row as { draws: number }).draws : null;
    const black = typeof (row as { black?: unknown }).black === 'number' ? (row as { black: number }).black : null;

    if (san === null || white === null || draws === null || black === null) {
      return null;
    }
    if (!Number.isFinite(white) || !Number.isFinite(draws) || !Number.isFinite(black)) {
      return null;
    }

    parsed.push({
      san,
      white,
      draws,
      black,
      total: white + draws + black,
    });
  }

  return sortMoveStats(parsed);
}

function outcomeToWhiteResultChar(outcome: 'white' | 'black' | 'draw' | null): 'w' | 'd' | 'l' | null {
  if (outcome === 'white') {
    return 'w';
  }
  if (outcome === 'draw') {
    return 'd';
  }
  if (outcome === 'black') {
    return 'l';
  }
  return null;
}

function parseUciMoveText(uciText: string): { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' } | null {
  const trimmed = uciText.trim().toLowerCase();
  const match = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/u.exec(trimmed);
  if (!match) {
    return null;
  }
  return {
    from: match[1],
    to: match[2],
    promotion: match[3] as 'q' | 'r' | 'b' | 'n' | undefined,
  };
}

function applyUciMove(chess: Chess, uciText: string): ReturnType<Chess['move']> | null {
  const parsed = parseUciMoveText(uciText);
  if (!parsed) {
    return null;
  }
  try {
    return chess.move(parsed) ?? null;
  } catch {
    return null;
  }
}

function addMoveStatFromUciLine(
  map: Map<string, MoveStats>,
  result: 'w' | 'd' | 'l',
  uciMoves: string[],
  targetFen: string,
): void {
  const normalizedTargetFen = normalizeFenWithoutMoveCounters(targetFen);
  const replay = new Chess();
  let targetMoveSan: string | null = null;

  for (const uciText of uciMoves) {
    if (normalizeFenWithoutMoveCounters(replay.fen()) === normalizedTargetFen) {
      const move = applyUciMove(replay, uciText);
      targetMoveSan = move?.san ?? null;
      break;
    }
    if (!applyUciMove(replay, uciText)) {
      return;
    }
  }

  if (!targetMoveSan) {
    return;
  }

  const existing = map.get(targetMoveSan) ?? {
    san: targetMoveSan,
    white: 0,
    draws: 0,
    black: 0,
    total: 0,
  };

  if (result === 'w') {
    existing.white += 1;
  } else if (result === 'd') {
    existing.draws += 1;
  } else {
    existing.black += 1;
  }

  existing.total += 1;
  map.set(targetMoveSan, existing);
}

export function moveStatsFromPgnGames(
  games: Iterable<ChessComUserGame>,
  username: string,
  fen: string,
  side: Side,
): MoveStats[] {
  const map = new Map<string, MoveStats>();
  for (const game of games) {
    addGameMoveStat(map, game, username, fen, side);
  }
  return sortMoveStats(map.values());
}

export class ChessComClient {
  private readonly downloadedUsers = new Set<string>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.chess.com',
    private readonly onNetworkStatus: (message: string) => void = () => {},
    private readonly dataInDirectory = resolve(process.cwd(), 'data_in'),
    private readonly onUserDumpProgress: (loadedFiles: number, totalFiles: number, done: boolean) => void = () => {},
    private readonly onDataUciBuildProgress: (processedFiles: number, totalFiles: number, done: boolean) => void = () =>
      {},
  ) {}

  async getUserMoveStats(
    username: string,
    fen: string,
    side: Side,
    sinceTimestampMs: number | null = null,
  ): Promise<MoveStats[]> {
    const cachePaths = await this.ensureUserGamesCache(username);
    const normalizedFen = normalizeFenWithoutMoveCounters(fen);
    return this.getOrCreateUserMoveStatsByFenCache(
      cachePaths,
      username,
      normalizedFen,
      side,
      sinceTimestampMs,
      true,
    );
  }

  async getUserMoveStatsFromDownloadedGames(
    username: string,
    fen: string,
    side: Side,
    sinceTimestampMs: number | null = null,
  ): Promise<MoveStats[]> {
    const cachePaths = this.userCachePaths(username);
    const normalizedFen = normalizeFenWithoutMoveCounters(fen);
    return this.getOrCreateUserMoveStatsByFenCache(
      cachePaths,
      username,
      normalizedFen,
      side,
      sinceTimestampMs,
      false,
    );
  }

  private async ensureUserGamesCache(username: string, forceSync = false): Promise<UserCachePaths> {
    const userKey = username.toLowerCase();
    const cachePaths = this.userCachePaths(username);
    if (!forceSync && this.downloadedUsers.has(userKey)) {
      return cachePaths;
    }

    await mkdir(cachePaths.dataDirectory, { recursive: true });
    await this.migrateLegacySanDirectory(cachePaths.playerDirectory, cachePaths.dataUciDirectory);
    await mkdir(cachePaths.dataUciDirectory, { recursive: true });
    await mkdir(cachePaths.byFenDirectory, { recursive: true });
    await this.syncUserGames(username, cachePaths);
    await this.ensureUciDataFiles(cachePaths, username, true);
    await this.clearByFenCacheDirectory(cachePaths.byFenDirectory);
    this.downloadedUsers.add(userKey);
    return cachePaths;
  }

  private userCachePaths(user: string): UserCachePaths {
    const sanitizedUser = sanitizeUserForFileName(user);
    const playerDirectory = resolve(this.dataInDirectory, CHESSCOM_PLAYER_CACHE_ROOT, sanitizedUser);
    const dataDirectory = resolve(playerDirectory, CHESSCOM_PLAYER_DATA_DIRECTORY);
    return {
      playerDirectory,
      dataDirectory,
      dataUciDirectory: resolve(playerDirectory, CHESSCOM_PLAYER_DATA_UCI_DIRECTORY),
      byFenDirectory: resolve(playerDirectory, CHESSCOM_PLAYER_BY_FEN_DIRECTORY),
      monthlyGameCountCsvPath: resolve(playerDirectory, CHESSCOM_PLAYER_MONTHLY_GAME_COUNT_FILE),
    };
  }

  private byFenCachePath(
    byFenDirectory: string,
    fen: string,
    side: Side,
    sinceTimestampMs: number | null,
  ): string {
    return resolve(byFenDirectory, `${encodeURIComponent(fen)}__${side}__${sinceTimestampCacheKey(sinceTimestampMs)}.json`);
  }

  private async clearByFenCacheDirectory(byFenDirectory: string): Promise<void> {
    await rm(byFenDirectory, { recursive: true, force: true });
    await mkdir(byFenDirectory, { recursive: true });
  }

  private async getOrCreateUserMoveStatsByFenCache(
    cachePaths: UserCachePaths,
    username: string,
    fen: string,
    side: Side,
    sinceTimestampMs: number | null,
    forceRefresh: boolean,
  ): Promise<MoveStats[]> {
    await this.ensureUciDataFiles(cachePaths, username, false);
    const cachePath = this.byFenCachePath(cachePaths.byFenDirectory, fen, side, sinceTimestampMs);
    if (!forceRefresh) {
      const cached = await this.readUserMoveStatsByFenCache(cachePath, fen, side, sinceTimestampMs);
      if (cached) {
        this.onNetworkStatus(
          `Chess.com by_fen cache hit for ${side} ${sinceTimestampCacheKey(
            sinceTimestampMs,
          )}; values are sourced from data_uci`,
        );
        return cached;
      }
    }

    const stats = await this.readUserMoveStatsFromUciDirectory(cachePaths.dataUciDirectory, fen, side, sinceTimestampMs);
    await this.writeUserMoveStatsByFenCache(cachePath, {
      source: 'chesscom-user-by-fen-v1',
      fen,
      side,
      sinceTimestampMs,
      generatedAt: Date.now(),
      moves: stats,
    });
    return stats;
  }

  private async readUserMoveStatsByFenCache(
    cachePath: string,
    fen: string,
    side: Side,
    sinceTimestampMs: number | null,
  ): Promise<MoveStats[] | null> {
    let text: string;
    try {
      text = await readFile(cachePath, 'utf8');
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(text) as Partial<UserByFenCachePayload>;
      if (parsed.source !== 'chesscom-user-by-fen-v1') {
        return null;
      }
      if (parsed.fen !== fen || parsed.side !== side || parsed.sinceTimestampMs !== sinceTimestampMs) {
        return null;
      }
      return parseMoveStatsArray(parsed.moves) ?? null;
    } catch {
      return null;
    }
  }

  private async writeUserMoveStatsByFenCache(cachePath: string, payload: UserByFenCachePayload): Promise<void> {
    await mkdir(resolve(cachePath, '..'), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(payload)}\n`, 'utf8');
  }

  private async syncUserGames(username: string, cachePaths: UserCachePaths): Promise<void> {
    const archivesUrl = new URL(`/pub/player/${username}/games/archives`, this.baseUrl);
    const archivesData = await this.request<ArchivesResponse>(archivesUrl, { logNetwork: true });

    const existingMonths = await this.readExistingYearMonths(cachePaths.dataDirectory);
    const archiveEntries = archivesData.archives
      .map((archiveUrl) => ({ archiveUrl, yearMonth: parseYearMonthFromArchiveUrl(archiveUrl) }))
      .filter((entry): entry is { archiveUrl: string; yearMonth: string } => entry.yearMonth !== null)
      .sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
    const latestYearMonth = archiveEntries.length > 0 ? archiveEntries[archiveEntries.length - 1].yearMonth : null;

    const pendingEntries = archiveEntries.filter(
      (entry) => !existingMonths.has(entry.yearMonth) || entry.yearMonth === latestYearMonth,
    );

    this.onUserDumpProgress(0, pendingEntries.length, false);
    let downloadedFiles = 0;
    for (const entry of pendingEntries) {
      const archiveData = await this.request<GamesResponse>(new URL(entry.archiveUrl), { logNetwork: true });
      await this.writeMonthlyGames(cachePaths.dataDirectory, entry.yearMonth, archiveData.games);
      downloadedFiles += 1;
      this.onUserDumpProgress(downloadedFiles, pendingEntries.length, false);
    }

    const monthlyGameCounts = await this.countGamesFromMonthlyFiles(cachePaths.dataDirectory);
    await this.writeMonthlyGameCounts(cachePaths.monthlyGameCountCsvPath, monthlyGameCounts);
    this.onUserDumpProgress(downloadedFiles, pendingEntries.length, true);
  }

  private async readUserMoveStatsFromUciDirectory(
    dataUciDirectory: string,
    fen: string,
    side: Side,
    sinceTimestampMs: number | null = null,
  ): Promise<MoveStats[]> {
    const minYearMonth = sinceTimestampMs === null ? null : formatYearMonth(sinceTimestampMs);
    const startedAt = Date.now();
    const filePaths = await this.listMonthlyUciFiles(resolve(dataUciDirectory, side), minYearMonth);
    this.onNetworkStatus(
      `Chess.com data_uci: using ${side} files (${filePaths.length}) for fen query${
        minYearMonth ? ` since ${minYearMonth}` : ''
      }`,
    );

    const rustStats = await tryCalculateMoveStatsWithRust(filePaths, fen, (message) =>
      this.onNetworkStatus(`Chess.com data_uci: ${message}`),
    );
    if (rustStats !== null) {
      const stats = sortMoveStats(rustStats);
      this.onNetworkStatus(
        `Chess.com data_uci: loaded ${stats.length} candidate moves from ${filePaths.length} files in ${
          Date.now() - startedAt
        }ms (Rust)`,
      );
      return stats;
    }

    const map = new Map<string, MoveStats>();
    for (const filePath of filePaths) {
      const fileStream = createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
      try {
        for await (const rawLine of rl) {
          const line = rawLine.trim();
          if (line === '') {
            continue;
          }
          const separatorIndex = line.indexOf('|');
          if (separatorIndex <= 0) {
            continue;
          }
          const resultToken = line.slice(0, separatorIndex).trim();
          if (resultToken !== 'w' && resultToken !== 'd' && resultToken !== 'l') {
            continue;
          }
          const movesText = line.slice(separatorIndex + 1).trim();
          const uciMoves = movesText === '' ? [] : movesText.split(/\s+/u);
          addMoveStatFromUciLine(map, resultToken, uciMoves, fen);
        }
      } finally {
        rl.close();
        fileStream.destroy();
      }
    }
    const stats = sortMoveStats(map.values());
    this.onNetworkStatus(
      `Chess.com data_uci: loaded ${stats.length} candidate moves from ${filePaths.length} files in ${Date.now() - startedAt}ms`,
    );
    return stats;
  }

  private async ensureUciDataFiles(cachePaths: UserCachePaths, username: string, rebuildAll: boolean): Promise<void> {
    const startedAt = Date.now();
    const whiteUciDirectory = resolve(cachePaths.dataUciDirectory, 'white');
    const blackUciDirectory = resolve(cachePaths.dataUciDirectory, 'black');
    await mkdir(whiteUciDirectory, { recursive: true });
    await mkdir(blackUciDirectory, { recursive: true });

    const whiteMonths = new Set(
      (await this.listMonthlyUciFiles(whiteUciDirectory))
        .map((filePath) => parseYearMonthFromSanFileName(basename(filePath)))
        .filter((yearMonth): yearMonth is string => yearMonth !== null),
    );
    const blackMonths = new Set(
      (await this.listMonthlyUciFiles(blackUciDirectory))
        .map((filePath) => parseYearMonthFromSanFileName(basename(filePath)))
        .filter((yearMonth): yearMonth is string => yearMonth !== null),
    );
    const dataFilePaths = await this.listMonthlyDataFiles(cachePaths.dataDirectory);
    const pendingEntries = dataFilePaths
      .map((dataFilePath) => {
        const yearMonth = parseYearMonthFromDataFileName(basename(dataFilePath));
        if (!yearMonth) {
          return null;
        }
        const shouldCreateWhite = rebuildAll || !whiteMonths.has(yearMonth);
        const shouldCreateBlack = rebuildAll || !blackMonths.has(yearMonth);
        if (!shouldCreateWhite && !shouldCreateBlack) {
          return null;
        }
        return { dataFilePath, yearMonth, shouldCreateWhite, shouldCreateBlack };
      })
      .filter(
        (
          entry,
        ): entry is {
          dataFilePath: string;
          yearMonth: string;
          shouldCreateWhite: boolean;
          shouldCreateBlack: boolean;
        } => entry !== null,
      );
    let createdWhiteFiles = 0;
    let createdBlackFiles = 0;
    let processedDataFiles = 0;
    if (pendingEntries.length > 0) {
      this.onDataUciBuildProgress(0, pendingEntries.length, false);
    }
    try {
      for (const entry of pendingEntries) {
        const { dataFilePath, yearMonth, shouldCreateWhite, shouldCreateBlack } = entry;

        const whiteLines: string[] = [];
        const blackLines: string[] = [];
        const fileStream = createReadStream(dataFilePath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
        try {
          for await (const rawLine of rl) {
            const line = rawLine.trim();
            if (line === '') {
              continue;
            }
            const game = this.parseGameLine(line, dataFilePath);
            const record = this.buildSanRecordFromGame(game, username);
            if (!record) {
              continue;
            }
            if (record.side === 'white') {
              whiteLines.push(record.line);
            } else {
              blackLines.push(record.line);
            }
          }
        } finally {
          rl.close();
          fileStream.destroy();
        }

        if (shouldCreateWhite) {
          const whitePath = resolve(whiteUciDirectory, `${yearMonth}.txt`);
          await writeFile(whitePath, whiteLines.length === 0 ? '' : `${whiteLines.join('\n')}\n`, 'utf8');
          createdWhiteFiles += 1;
        }
        if (shouldCreateBlack) {
          const blackPath = resolve(blackUciDirectory, `${yearMonth}.txt`);
          await writeFile(blackPath, blackLines.length === 0 ? '' : `${blackLines.join('\n')}\n`, 'utf8');
          createdBlackFiles += 1;
        }

        processedDataFiles += 1;
        this.onDataUciBuildProgress(processedDataFiles, pendingEntries.length, false);
      }
    } finally {
      if (pendingEntries.length > 0) {
        this.onDataUciBuildProgress(processedDataFiles, pendingEntries.length, true);
      }
    }
    const elapsedMs = Date.now() - startedAt;
    if (createdWhiteFiles > 0 || createdBlackFiles > 0) {
      this.onNetworkStatus(
        `Chess.com data_uci: created/updated ${createdWhiteFiles} white and ${createdBlackFiles} black monthly files in ${elapsedMs}ms`,
      );
      return;
    }
    this.onNetworkStatus(`Chess.com data_uci: no new files needed (already available) (${elapsedMs}ms)`);
  }

  private buildSanRecordFromGame(game: ChessComUserGame, username: string): { side: Side; line: string } | null {
    if (!isStandardChessComGame(game)) {
      return null;
    }

    const normalizedUser = username.trim().toLowerCase();
    const whiteUser = game.white.username.trim().toLowerCase();
    const blackUser = game.black.username.trim().toLowerCase();
    const side = whiteUser === normalizedUser ? 'white' : blackUser === normalizedUser ? 'black' : null;
    if (!side) {
      return null;
    }

    const result = outcomeToWhiteResultChar(gameOutcome(game.white.result, game.black.result));
    if (!result) {
      return null;
    }

    const chess = new Chess();
    try {
      chess.loadPgn(game.pgn);
    } catch {
      return null;
    }
    const uciMoves = chess
      .history({ verbose: true })
      .map((move) => `${move.from}${move.to}${move.promotion ?? ''}`);
    return {
      side,
      line: `${result}|${uciMoves.join(' ')}`,
    };
  }

  private parseGameLine(line: string, source: string): ChessComUserGame {
    try {
      return JSON.parse(line) as ChessComUserGame;
    } catch (error: unknown) {
      const parseMessage = error instanceof Error ? error.message : String(error);
      this.onNetworkStatus(`Network: NDJSON parse failed from ${source}; received line:\n${line}`);
      throw new Error(`Failed to parse NDJSON line from ${source}: ${parseMessage}\nReceived line:\n${line}`);
    }
  }

  private async readExistingYearMonths(dataDirectory: string): Promise<Set<string>> {
    const filePaths = await this.listMonthlyDataFiles(dataDirectory);
    return new Set(
      filePaths
        .map((filePath) => parseYearMonthFromDataFileName(basename(filePath)))
        .filter((yearMonth): yearMonth is string => yearMonth !== null),
    );
  }

  private async writeMonthlyGames(dataDirectory: string, yearMonth: string, games: ChessComUserGame[]): Promise<void> {
    const filePath = resolve(dataDirectory, `${yearMonth}.ndjson`);
    const body = games.map((game) => JSON.stringify(game)).join('\n');
    await writeFile(filePath, body === '' ? '' : `${body}\n`, 'utf8');
  }

  private async listMonthlyDataFiles(dataDirectory: string, minYearMonth: string | null = null): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(dataDirectory, { withFileTypes: true });
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }

    return entries
      .filter((entry) => {
        if (!entry.isFile()) {
          return false;
        }
        const yearMonth = parseYearMonthFromDataFileName(entry.name);
        if (yearMonth === null) {
          return false;
        }
        return minYearMonth === null || yearMonth >= minYearMonth;
      })
      .map((entry) => resolve(dataDirectory, entry.name))
      .sort((a, b) => basename(a).localeCompare(basename(b)));
  }

  private async migrateLegacySanDirectory(playerDirectory: string, dataUciDirectory: string): Promise<void> {
    const legacyDataSanDirectory = resolve(playerDirectory, 'data_san');
    try {
      await readdir(legacyDataSanDirectory);
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }

    try {
      await readdir(dataUciDirectory);
      return;
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    await rename(legacyDataSanDirectory, dataUciDirectory);
    this.onNetworkStatus('Chess.com data_uci: renamed legacy data_san directory to data_uci');
  }

  private async listMonthlyUciFiles(sideUciDirectory: string, minYearMonth: string | null = null): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(sideUciDirectory, { withFileTypes: true });
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }

    return entries
      .filter((entry) => {
        if (!entry.isFile()) {
          return false;
        }
        const yearMonth = parseYearMonthFromSanFileName(entry.name);
        if (yearMonth === null) {
          return false;
        }
        return minYearMonth === null || yearMonth >= minYearMonth;
      })
      .map((entry) => resolve(sideUciDirectory, entry.name))
      .sort((a, b) => basename(a).localeCompare(basename(b)));
  }

  private async countGamesFromMonthlyFiles(dataDirectory: string): Promise<Map<string, number>> {
    const filePaths = await this.listMonthlyDataFiles(dataDirectory);
    const counts = new Map<string, number>();
    for (const filePath of filePaths) {
      const yearMonth = parseYearMonthFromDataFileName(basename(filePath));
      if (!yearMonth) {
        continue;
      }

      const fileStream = createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
      let lineCount = 0;
      try {
        for await (const rawLine of rl) {
          if (rawLine.trim() !== '') {
            lineCount += 1;
          }
        }
      } finally {
        rl.close();
        fileStream.destroy();
      }
      counts.set(yearMonth, lineCount);
    }
    return counts;
  }

  private async writeMonthlyGameCounts(monthlyGameCountCsvPath: string, counts: Map<string, number>): Promise<void> {
    const rows = [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
    const csv = ['year_month,games', ...rows.map(([yearMonth, games]) => `${yearMonth},${games}`)].join('\n');
    await writeFile(monthlyGameCountCsvPath, `${csv}\n`, 'utf8');
  }

  private async request<T>(url: URL, options: RequestOptions = { logNetwork: true, logStarted: false }): Promise<T> {
    const startedAt = Date.now();
    const fullUrl = url.toString();
    const shouldLogNetwork = options.logNetwork ?? true;
    const shouldLogStarted = options.logStarted ?? false;
    if (shouldLogNetwork && shouldLogStarted) {
      this.onNetworkStatus(`Network: GET ${fullUrl} started`);
    }

    try {
      const response = await fetchWith429Retries(
        () => this.fetchImpl(url, { headers: { Accept: 'application/json' } }),
        {
          requestDescription: `GET ${fullUrl}`,
          onWarning: (message) => this.onNetworkStatus(message),
        },
      );
      const elapsedMs = Date.now() - startedAt;
      if (shouldLogNetwork) {
        this.onNetworkStatus(
          `Network: GET ${fullUrl} -> ${response.status} ${response.statusText} (${elapsedMs}ms)`,
        );
      }

      if (!response.ok) {
        throw new Error(`Chess.com API error ${response.status}: ${response.statusText}`);
      }

      const responseText = await response.text();
      return this.parseJsonResponse<T>(responseText, fullUrl);
    } catch (error: unknown) {
      const elapsedMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      if (shouldLogNetwork) {
        this.onNetworkStatus(`Network: GET ${fullUrl} failed after ${elapsedMs}ms (${message})`);
      }
      throw error;
    }
  }

  private parseJsonResponse<T>(responseText: string, fullUrl: string): T {
    try {
      return JSON.parse(responseText) as T;
    } catch (error: unknown) {
      const parseMessage = error instanceof Error ? error.message : String(error);
      const body = responseText.trim() === '' ? '[empty response body]' : responseText;
      this.onNetworkStatus(`Network: GET ${fullUrl} parse failed; received body:\n${body}`);
      throw new Error(`Failed to parse JSON from ${fullUrl}: ${parseMessage}\nReceived body:\n${body}`);
    }
  }
}
