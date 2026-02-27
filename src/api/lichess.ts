import { Chess } from 'chess.js';
import { createReadStream, createWriteStream, type Dirent, type WriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import readline from 'node:readline';
import { normalizeFenWithoutMoveCounters } from '../fen.js';
import type { MoveEval, MoveStats, Side } from '../types.js';
import { fetchWith429Retries, type Retry429Attempt, type Retry429Decision } from './retry.js';

type LichessMove = {
  san: string;
  white: number;
  draws: number;
  black: number;
};

type LichessDbMove = LichessMove & {
  cp?: number;
  mate?: number;
};

type LichessCloudEvalPv = {
  moves?: string;
  cp?: number;
  mate?: number;
};

type LichessCloudEvalResponse = {
  depth?: number;
  pvs?: LichessCloudEvalPv[];
};

type LichessCloudEvalResponseResult = {
  data: LichessCloudEvalResponse;
  rawResponseText: string;
};

type LichessDatabaseCachePayload = {
  fen?: string;
  cachedAt?: number;
  moves?: LichessDbMove[];
  cloudEvalsBySan?: Record<string, MoveEval>;
};

type LichessUserGame = {
  createdAt?: number;
  moves?: string;
  variant?: string;
  winner?: 'white' | 'black';
  status?: string;
  pgn?: string;
  players?: {
    white?: { user?: { name?: string; id?: string } };
    black?: { user?: { name?: string; id?: string } };
  };
};

type LichessUserProfile = {
  count?: {
    all?: number;
  };
};

type RequestOptions = {
  logNetwork?: boolean;
  onResponseOk?: () => void;
  onBefore429Retry?: (attempt: Retry429Attempt) => Promise<Retry429Decision> | Retry429Decision;
  onWaitFor429Retry?: (attempt: Retry429Attempt) => Promise<Retry429Decision> | Retry429Decision;
  max429Retries?: number;
  retryWarningSuffix?: string;
};

type CloudEvalRetryChoice = 'continue-retries' | 'use-cached-values';

type CloudEvalRetryPromptContext = {
  enabled: boolean;
  choice: CloudEvalRetryChoice | null;
};

type CloudEvalRetryPromptRequest = {
  requestDescription: string;
  retryIndex: number;
  maxRetries: number;
  waitSeconds: number;
};

type UserDumpStepTotals = {
  requestPageMs: number;
  downloadBodyMs: number;
  readBodyMs: number;
  parseLinesMs: number;
  writeLinesMs: number;
  progressMs: number;
};

type UserCachePaths = {
  playerDirectory: string;
  dataDirectory: string;
  lastAvailableAtPath: string;
  monthlyGameCountCsvPath: string;
};

const LICHESS_USER_PAGE_SIZE = 100000;
const USER_DUMP_PROGRESS_UPDATE_STEP = 25;
const LICHESS_PLAYER_CACHE_ROOT = 'lichess_player';
const LICHESS_PLAYER_DATA_DIRECTORY = 'data';
const LICHESS_PLAYER_LAST_AVAILABLE_AT_FILE = 'last_available_at.txt';
const LICHESS_PLAYER_MONTHLY_GAME_COUNT_FILE = 'monthly_games.csv';
const LICHESS_DATABASE_CACHE_ROOT = 'lichess_database';
const LICHESS_DATABASE_FEN_DIRECTORY = 'fen';
const LICHESS_DATABASE_MOVE_LIMIT = 50;
const LICHESS_EVAL_CACHE_ROOT = 'lichess_eval';
const LICHESS_EVAL_FEN_DIRECTORY = 'fen';
const LICHESS_STANDARD_VARIANT = 'standard';
const LICHESS_STANDARD_PERF_TYPES = 'ultraBullet,bullet,blitz,rapid,classical,correspondence';
const LICHESS_CLOUD_EVAL_MAX_429_RETRIES = 3;

function sanitizeUserForFileName(user: string): string {
  return user.replace(/[^A-Za-z0-9_-]/g, '_');
}

function formatYearMonth(createdAt: number): string {
  const date = new Date(createdAt);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function parseYearMonthFromDataFileName(fileName: string): string | null {
  const match = /^(\d{4}-\d{2})\.ndjson$/u.exec(fileName);
  return match ? match[1] : null;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function gameOutcome(game: LichessUserGame): 'white' | 'black' | 'draw' | null {
  if (game.winner === 'white' || game.winner === 'black') {
    return game.winner;
  }
  if (game.status === 'draw') {
    return 'draw';
  }
  return null;
}

function parsePgnTagValue(pgn: string | undefined, tag: string): string | null {
  if (!pgn) {
    return null;
  }
  const match = pgn.match(new RegExp(`\\[${tag}\\s+"([^"]+)"\\]`));
  return match?.[1]?.trim() || null;
}

function isStandardLichessGame(game: LichessUserGame): boolean {
  const variant = game.variant ?? parsePgnTagValue(game.pgn, 'Variant');
  if (variant === undefined || variant === null) {
    return true;
  }
  return variant.trim().toLowerCase() === LICHESS_STANDARD_VARIANT;
}

function userNameToCompare(name: string | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function extractPlayerName(game: LichessUserGame, side: Side): string | null {
  const user = side === 'white' ? game.players?.white?.user : game.players?.black?.user;
  const direct = userNameToCompare(user?.name ?? user?.id);
  if (direct) {
    return direct;
  }

  return parsePgnTagValue(game.pgn, side === 'white' ? 'White' : 'Black')?.toLowerCase() ?? null;
}

function applyMove(chess: Chess, moveText: string): string | null {
  const trimmed = moveText.trim();
  if (trimmed === '') {
    return null;
  }

  const uciMatch = /^([a-h][1-8])([a-h][1-8])([qrbnQRBN])?$/u.exec(trimmed);
  if (uciMatch) {
    const from = uciMatch[1];
    const to = uciMatch[2];
    const promotion = uciMatch[3]?.toLowerCase() as 'q' | 'r' | 'b' | 'n' | undefined;
    try {
      const move = chess.move({ from, to, promotion });
      return move?.san ?? null;
    } catch {
      return null;
    }
  }

  try {
    const sanMove = chess.move(trimmed, { strict: false });
    return sanMove?.san ?? null;
  } catch {
    return null;
  }
}

function mapDatabaseMoves(
  moves: LichessDbMove[],
  cloudEvalsBySan: Map<string, MoveEval> | undefined = undefined,
): Array<MoveStats & { eval?: MoveEval }> {
  return moves.map((m) => ({
    san: m.san,
    white: m.white,
    draws: m.draws,
    black: m.black,
    total: m.white + m.draws + m.black,
    eval:
      cloudEvalsBySan?.get(m.san) ??
      (m.cp !== undefined || m.mate !== undefined ? { cp: m.cp, mate: m.mate } : undefined),
  }));
}

function addGameMoveStat(
  map: Map<string, MoveStats>,
  game: LichessUserGame,
  username: string,
  fen: string,
  side: Side,
): void {
  if (!isStandardLichessGame(game)) {
    return;
  }

  const normalizedTargetFen = normalizeFenWithoutMoveCounters(fen);
  const targetUser = username.toLowerCase();
  const whiteUser = extractPlayerName(game, 'white');
  const blackUser = extractPlayerName(game, 'black');
  const userMatchesSide = side === 'white' ? whiteUser === targetUser : blackUser === targetUser;
  if (!userMatchesSide) {
    return;
  }

  if (!game.moves || game.moves.trim() === '') {
    return;
  }

  const outcome = gameOutcome(game);
  if (!outcome) {
    return;
  }

  const replay = new Chess();
  let targetMoveSan: string | null = null;
  for (const moveText of game.moves.trim().split(/\s+/)) {
    if (normalizeFenWithoutMoveCounters(replay.fen()) === normalizedTargetFen) {
      targetMoveSan = applyMove(replay, moveText);
      break;
    }
    if (!applyMove(replay, moveText)) {
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

  if (outcome === 'white') existing.white += 1;
  else if (outcome === 'black') existing.black += 1;
  else existing.draws += 1;

  existing.total += 1;
  map.set(targetMoveSan, existing);
}

function sortMoveStats(stats: Iterable<MoveStats>): MoveStats[] {
  return [...stats].sort((a, b) => b.total - a.total || a.san.localeCompare(b.san));
}

function extractCreatedAtTimestamp(line: string): number | null {
  const match = line.match(/"createdAt"\s*:\s*(\d+)/);
  if (!match) {
    return null;
  }
  const createdAt = Number.parseInt(match[1], 10);
  return Number.isFinite(createdAt) ? createdAt : null;
}

export function moveStatsFromLichessGames(
  games: Iterable<LichessUserGame>,
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

export class LichessClient {
  private static cloudEvalRequestQueue: Promise<void> = Promise.resolve();
  private readonly downloadedUsers = new Set<string>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = 'https://explorer.lichess.ovh',
    private readonly onNetworkStatus: (message: string) => void = () => {},
    _onPlayerResponseLine: (line: string) => void = () => {},
    private readonly gamesBaseUrl = 'https://lichess.org',
    private readonly dataInDirectory = resolve(process.cwd(), 'data_in'),
    private readonly onUserDumpProgress: (loadedGames: number, totalGames: number, done: boolean) => void = () =>
      {},
    private readonly onCloudEvalFirstRetryWhenCacheReady: (
      request: CloudEvalRetryPromptRequest,
    ) => Promise<CloudEvalRetryChoice> | CloudEvalRetryChoice = () => 'continue-retries',
    private readonly apiToken: string | null = (process.env.LICHESS_API_TOKEN ?? '').trim() || null,
  ) {}

  async getUserMoveStats(user: string, fen: string, side: Side, sinceTimestampMs: number | null = null): Promise<MoveStats[]> {
    const cachePaths = await this.ensureUserGamesCache(user);
    const normalizedFen = normalizeFenWithoutMoveCounters(fen);
    return this.readUserMoveStatsFromDirectory(cachePaths.dataDirectory, user, normalizedFen, side, sinceTimestampMs);
  }

  async getDatabaseMoveStats(fen: string): Promise<Array<MoveStats & { eval?: MoveEval }>> {
    const normalizedFen = normalizeFenWithoutMoveCounters(fen);
    const cachePath = this.databaseCachePathForFen(normalizedFen);
    const cloudEvalRetryPromptContext: CloudEvalRetryPromptContext = { enabled: false, choice: null };
    const cached = await this.readDatabaseCache(cachePath);
    if (cached) {
      const cloudEvalsBySan = await this.getCloudEvalsForAllMoves(
        normalizedFen,
        cached.moves,
        cached.cloudEvalsBySan,
        cloudEvalRetryPromptContext,
      );
      cloudEvalRetryPromptContext.enabled = true;
      await this.ensureExactCloudEvalFiles(normalizedFen, cached.moves, cloudEvalsBySan, cloudEvalRetryPromptContext);
      for (const [san, evalValue] of (await this.readCloudEvalsBySanFromFiles(normalizedFen, cached.moves)).entries()) {
        cloudEvalsBySan.set(san, evalValue);
      }
      if (cloudEvalsBySan.size > 0 && (!cached.cloudEvalsBySan || cloudEvalsBySan.size !== cached.cloudEvalsBySan.size)) {
        await this.writeDatabaseCache(cachePath, {
          fen: normalizedFen,
          cachedAt: Date.now(),
          moves: cached.moves,
          cloudEvalsBySan: this.serializeCloudEvalsBySan(cloudEvalsBySan),
        });
      }
      return mapDatabaseMoves(cached.moves, cloudEvalsBySan);
    }

    const url = new URL('/lichess', this.baseUrl);
    url.searchParams.set('fen', normalizedFen);
    url.searchParams.set('moves', String(LICHESS_DATABASE_MOVE_LIMIT));
    url.searchParams.set('variant', LICHESS_STANDARD_VARIANT);

    const data = await this.requestJson<{ moves?: LichessDbMove[] }>(url);
    const moves = data.moves ?? [];
    const cloudEvalsBySan = await this.getCloudEvalsForAllMoves(
      normalizedFen,
      moves,
      undefined,
      cloudEvalRetryPromptContext,
    );
    cloudEvalRetryPromptContext.enabled = true;
    await this.ensureExactCloudEvalFiles(normalizedFen, moves, cloudEvalsBySan, cloudEvalRetryPromptContext);
    await this.writeDatabaseCache(cachePath, {
      fen: normalizedFen,
      cachedAt: Date.now(),
      moves,
      cloudEvalsBySan: this.serializeCloudEvalsBySan(cloudEvalsBySan),
    });
    return mapDatabaseMoves(moves, cloudEvalsBySan);
  }

  private async ensureUserGamesCache(user: string): Promise<UserCachePaths> {
    const userKey = user.toLowerCase();
    const cachePaths = this.userCachePaths(user);
    if (this.downloadedUsers.has(userKey)) {
      return cachePaths;
    }

    await mkdir(cachePaths.dataDirectory, { recursive: true });
    await this.syncUserGames(user, cachePaths);
    this.downloadedUsers.add(userKey);
    return cachePaths;
  }

  private userCachePaths(user: string): UserCachePaths {
    const sanitizedUser = sanitizeUserForFileName(user);
    const playerDirectory = resolve(this.dataInDirectory, LICHESS_PLAYER_CACHE_ROOT, sanitizedUser);
    const dataDirectory = resolve(playerDirectory, LICHESS_PLAYER_DATA_DIRECTORY);
    return {
      playerDirectory,
      dataDirectory,
      lastAvailableAtPath: resolve(playerDirectory, LICHESS_PLAYER_LAST_AVAILABLE_AT_FILE),
      monthlyGameCountCsvPath: resolve(playerDirectory, LICHESS_PLAYER_MONTHLY_GAME_COUNT_FILE),
    };
  }

  private databaseCachePathForFen(fen: string): string {
    return resolve(
      this.dataInDirectory,
      LICHESS_DATABASE_CACHE_ROOT,
      LICHESS_DATABASE_FEN_DIRECTORY,
      encodeURIComponent(fen),
    );
  }

  private evalResponsePathForFenMove(baseFen: string, move: string): string {
    return resolve(
      this.dataInDirectory,
      LICHESS_EVAL_CACHE_ROOT,
      LICHESS_EVAL_FEN_DIRECTORY,
      encodeURIComponent(baseFen),
      encodeURIComponent(move),
    );
  }

  private async readDatabaseCache(
    cachePath: string,
  ): Promise<{ moves: LichessDbMove[]; cloudEvalsBySan?: Map<string, MoveEval> } | null> {
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
      const parsed = JSON.parse(text) as LichessDatabaseCachePayload;
      if (!parsed || typeof parsed !== 'object' || !('moves' in parsed) || !Array.isArray(parsed.moves)) {
        return null;
      }
      return {
        moves: parsed.moves as LichessDbMove[],
        cloudEvalsBySan: this.parseCloudEvalsBySan(parsed.cloudEvalsBySan),
      };
    } catch {
      return null;
    }
  }

  private async writeDatabaseCache(
    cachePath: string,
    payload: { fen: string; cachedAt: number; moves: LichessDbMove[]; cloudEvalsBySan?: Record<string, MoveEval> },
  ): Promise<void> {
    await mkdir(resolve(this.dataInDirectory, LICHESS_DATABASE_CACHE_ROOT, LICHESS_DATABASE_FEN_DIRECTORY), {
      recursive: true,
    });
    await writeFile(cachePath, `${JSON.stringify(payload)}\n`, 'utf8');
  }

  private parseCloudEvalsBySan(raw: unknown): Map<string, MoveEval> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return undefined;
    }

    const parsed = new Map<string, MoveEval>();
    for (const [san, evalRaw] of Object.entries(raw as Record<string, unknown>)) {
      if (!evalRaw || typeof evalRaw !== 'object' || Array.isArray(evalRaw)) {
        continue;
      }

      const cpRaw = (evalRaw as { cp?: unknown }).cp;
      const mateRaw = (evalRaw as { mate?: unknown }).mate;
      const depthRaw = (evalRaw as { depth?: unknown }).depth;
      const cp = typeof cpRaw === 'number' && Number.isFinite(cpRaw) ? cpRaw : undefined;
      const mate = typeof mateRaw === 'number' && Number.isFinite(mateRaw) ? mateRaw : undefined;
      const depth = typeof depthRaw === 'number' && Number.isFinite(depthRaw) ? depthRaw : undefined;
      if (cp === undefined && mate === undefined) {
        continue;
      }
      parsed.set(san, { cp, mate, depth });
    }

    return parsed.size > 0 ? parsed : undefined;
  }

  private serializeCloudEvalsBySan(cloudEvalsBySan: Map<string, MoveEval>): Record<string, MoveEval> | undefined {
    if (cloudEvalsBySan.size === 0) {
      return undefined;
    }
    return Object.fromEntries(cloudEvalsBySan.entries());
  }

  private async writeCloudEvalResponseForMove(
    baseFen: string,
    move: string,
    rawResponseText: string,
  ): Promise<void> {
    const fenDirectory = resolve(
      this.dataInDirectory,
      LICHESS_EVAL_CACHE_ROOT,
      LICHESS_EVAL_FEN_DIRECTORY,
      encodeURIComponent(baseFen),
    );
    await mkdir(fenDirectory, { recursive: true });
    const path = this.evalResponsePathForFenMove(baseFen, move);
    await writeFile(path, rawResponseText, 'utf8');
  }

  private async ensureExactCloudEvalFiles(
    baseFen: string,
    moves: LichessDbMove[],
    cloudEvalsBySan: Map<string, MoveEval>,
    retryPromptContext: CloudEvalRetryPromptContext,
  ): Promise<void> {
    if (retryPromptContext.enabled && retryPromptContext.choice === 'use-cached-values') {
      return;
    }

    for (const move of moves) {
      const san = move.san;
      if (!cloudEvalsBySan.has(san)) {
        continue;
      }
      const path = this.evalResponsePathForFenMove(baseFen, san);
      if (await this.isRealCloudEvalApiFile(path)) {
        continue;
      }
      await this.getCloudEvalForMove(baseFen, san, retryPromptContext);
      if (retryPromptContext.enabled && retryPromptContext.choice === 'use-cached-values') {
        return;
      }
    }
  }

  private async readCloudEvalsBySanFromFiles(fen: string, moves: LichessDbMove[]): Promise<Map<string, MoveEval>> {
    const evalsBySan = new Map<string, MoveEval>();
    for (const move of moves) {
      const path = this.evalResponsePathForFenMove(fen, move.san);
      const evalValue = await this.readPrimaryEvalFromStoredFile(path);
      if (evalValue) {
        evalsBySan.set(move.san, evalValue);
      }
    }
    return evalsBySan;
  }

  private async readPrimaryEvalFromStoredFile(path: string): Promise<MoveEval | undefined> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'response' in parsed) {
        const wrappedResponse = (parsed as { response?: unknown }).response;
        if (wrappedResponse && typeof wrappedResponse === 'object' && !Array.isArray(wrappedResponse)) {
          return this.getPrimaryCloudEval(wrappedResponse as LichessCloudEvalResponse) ?? undefined;
        }
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return this.getPrimaryCloudEval(parsed as LichessCloudEvalResponse) ?? undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async isRealCloudEvalApiFile(path: string): Promise<boolean> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return false;
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return false;
      }
      if ('response' in parsed || 'baseFen' in parsed || 'requestedFen' in parsed || 'source' in parsed) {
        return false;
      }
      return 'pvs' in parsed || 'depth' in parsed;
    } catch {
      return false;
    }
  }

  private async getCloudEvalsForAllMoves(
    fen: string,
    moves: LichessDbMove[],
    existing: Map<string, MoveEval> | undefined = undefined,
    retryPromptContext: CloudEvalRetryPromptContext | undefined = undefined,
  ): Promise<Map<string, MoveEval>> {
    const merged = new Map<string, MoveEval>(existing);
    for (const [san, evalValue] of (await this.readCloudEvalsBySanFromFiles(fen, moves)).entries()) {
      merged.set(san, evalValue);
    }

    for (const move of moves) {
      if (retryPromptContext?.choice === 'use-cached-values') {
        break;
      }
      if (merged.has(move.san)) {
        continue;
      }
      const evalAfterMove = await this.getCloudEvalForMove(fen, move.san, retryPromptContext);
      if (evalAfterMove) {
        merged.set(move.san, evalAfterMove);
      }
    }

    return merged;
  }

  private async getCloudEvalForMove(
    fen: string,
    san: string,
    retryPromptContext: CloudEvalRetryPromptContext | undefined = undefined,
  ): Promise<MoveEval | undefined> {
    if (retryPromptContext?.choice === 'use-cached-values') {
      return undefined;
    }

    const chess = new Chess();
    chess.load(fen);
    const moveResult = chess.move(san, { strict: false });
    if (!moveResult) {
      return undefined;
    }

    const childFen = normalizeFenWithoutMoveCounters(chess.fen());
    const childResult = await this.getCloudEvalResponse(childFen, retryPromptContext);
    if (childResult) {
      await this.writeCloudEvalResponseForMove(fen, san, childResult.rawResponseText);
      this.onNetworkStatus(`Status: Lichess cloud-eval move ${san} ok.`);
    }
    const childData = childResult?.data ?? null;
    const childEval = this.getPrimaryCloudEval(childData);
    if (!childEval) {
      return undefined;
    }
    return childEval;
  }

  private getPrimaryCloudEval(data: LichessCloudEvalResponse | null): MoveEval | undefined {
    if (!data) {
      return undefined;
    }

    const depth = typeof data.depth === 'number' && Number.isFinite(data.depth) ? data.depth : undefined;
    for (const pv of data.pvs ?? []) {
      const cp = typeof pv.cp === 'number' && Number.isFinite(pv.cp) ? pv.cp : undefined;
      const mate = typeof pv.mate === 'number' && Number.isFinite(pv.mate) ? pv.mate : undefined;
      if (cp !== undefined || mate !== undefined) {
        return { cp, mate, depth };
      }
    }
    return undefined;
  }

  private async runCloudEvalRequestSequentially<T>(operation: () => Promise<T>): Promise<T> {
    const previousOperation = LichessClient.cloudEvalRequestQueue;
    let releaseQueue: (() => void) | undefined;
    LichessClient.cloudEvalRequestQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previousOperation;
    try {
      return await operation();
    } finally {
      releaseQueue?.();
    }
  }

  private async handleCloudEval429Retry(
    attempt: Retry429Attempt,
    retryPromptContext: CloudEvalRetryPromptContext | undefined,
  ): Promise<Retry429Decision> {
    if (!retryPromptContext?.enabled) {
      return 'retry';
    }
    if (retryPromptContext.choice === 'continue-retries') {
      return 'retry';
    }
    if (retryPromptContext.choice === 'use-cached-values') {
      return 'stop';
    }

    const choice = await this.onCloudEvalFirstRetryWhenCacheReady({
      requestDescription: attempt.requestDescription,
      retryIndex: attempt.retryIndex,
      maxRetries: attempt.maxRetries,
      waitSeconds: Math.ceil(attempt.waitMs / 1000),
    });
    retryPromptContext.choice = choice;
    if (choice === 'use-cached-values') {
      this.onNetworkStatus(`Cloud eval: using cached values; skipped remaining retries for ${attempt.requestDescription}`);
      return 'stop';
    }
    return 'retry';
  }

  private async getCloudEvalResponse(
    fen: string,
    retryPromptContext: CloudEvalRetryPromptContext | undefined = undefined,
  ): Promise<LichessCloudEvalResponseResult | null> {
    if (retryPromptContext?.enabled && retryPromptContext.choice === 'use-cached-values') {
      return null;
    }

    return this.runCloudEvalRequestSequentially(async () => {
      const url = new URL('/api/cloud-eval', this.gamesBaseUrl);
      url.searchParams.set('fen', fen);

      try {
        return await this.requestJsonWithRaw<LichessCloudEvalResponse>(url, {
          logNetwork: false,
          onBefore429Retry: (attempt) => this.handleCloudEval429Retry(attempt, retryPromptContext),
          onWaitFor429Retry: (attempt) => this.waitForCloudEvalRetryWaitInput(attempt, retryPromptContext),
          max429Retries: LICHESS_CLOUD_EVAL_MAX_429_RETRIES,
          retryWarningSuffix: ' Press "s" to stop retries while waiting.',
        });
      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes('Lichess API error 404')) {
          return null;
        }
        if (error instanceof Error && error.message.includes('Lichess API error 429')) {
          if (retryPromptContext) {
            retryPromptContext.enabled = true;
            retryPromptContext.choice = 'use-cached-values';
          }
          this.onNetworkStatus('Cloud eval: retries exhausted; stopping further eval downloads for this position.');
          return null;
        }
        throw error;
      }
    });
  }

  private async waitForCloudEvalRetryWaitInput(
    attempt: Retry429Attempt,
    retryPromptContext: CloudEvalRetryPromptContext | undefined,
  ): Promise<Retry429Decision> {
    const waitMs = Math.max(0, attempt.waitMs);
    if (waitMs === 0) {
      return 'retry';
    }

    const stdin = process.stdin;
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      return retryPromptContext?.choice === 'use-cached-values' ? 'stop' : 'retry';
    }

    const wasRawMode = stdin.isRaw === true;
    const wasPaused = stdin.isPaused();
    return new Promise<Retry429Decision>((resolve) => {
      let finished = false;
      const timer = setTimeout(() => {
        finish('retry');
      }, waitMs);

      const finish = (decision: Retry429Decision): void => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        stdin.off('data', onData);
        if (!wasRawMode) {
          try {
            stdin.setRawMode(false);
          } catch {
            // Ignore raw-mode reset failures and continue shutdown.
          }
        }
        if (wasPaused) {
          stdin.pause();
        }
        resolve(decision);
      };

      const onData = (chunk: Buffer | string): void => {
        const key = (typeof chunk === 'string' ? chunk : chunk.toString('utf8')).toLowerCase();
        if (key.includes('\u0003')) {
          finish('stop');
          process.kill(process.pid, 'SIGINT');
          return;
        }
        if (!key.includes('s')) {
          return;
        }
        if (retryPromptContext) {
          retryPromptContext.enabled = true;
          retryPromptContext.choice = 'use-cached-values';
        }
        this.onNetworkStatus(
          `Cloud eval: stop requested by keypress; skipped remaining retries for ${attempt.requestDescription}`,
        );
        finish('stop');
      };

      if (!wasRawMode) {
        try {
          stdin.setRawMode(true);
        } catch {
          stdin.off('data', onData);
          clearTimeout(timer);
          if (wasPaused) {
            stdin.pause();
          }
          resolve('retry');
          return;
        }
      }
      stdin.on('data', onData);
      stdin.resume();
    });
  }

  private async syncUserGames(user: string, cachePaths: UserCachePaths): Promise<void> {
    const startedAt = Date.now();
    this.onNetworkStatus(`Lichess user dump: start ${user} -> ${cachePaths.dataDirectory}`);
    const monthlyWriters = new Map<string, WriteStream>();
    const monthlyGameCounts = await this.loadMonthlyGameCounts(cachePaths);
    const lastAvailableAt = await this.readLastAvailableAt(cachePaths.lastAvailableAtPath);
    const since = lastAvailableAt === null ? null : lastAvailableAt + 1;
    const expectedTotalGames = await this.getUserTotalGameCount(user);
    const cachedGames = [...monthlyGameCounts.values()].reduce((sum, count) => sum + count, 0);
    const expectedRemainingGames = expectedTotalGames === null ? null : Math.max(expectedTotalGames - cachedGames, 0);
    let downloadedGames = 0;
    let until: number | null = null;
    let isFirstPage = true;
    let newestCreatedAt = lastAvailableAt;
    let lastReportedDownloadedGames = -1;
    const stepTotals: UserDumpStepTotals = {
      requestPageMs: 0,
      downloadBodyMs: 0,
      readBodyMs: 0,
      parseLinesMs: 0,
      writeLinesMs: 0,
      progressMs: 0,
    };

    const emitProgress = (done: boolean, force: boolean): void => {
      if (expectedRemainingGames === null) {
        return;
      }
      if (!done && downloadedGames === lastReportedDownloadedGames) {
        return;
      }
      if (
        force ||
        done ||
        downloadedGames === 0 ||
        downloadedGames - lastReportedDownloadedGames >= USER_DUMP_PROGRESS_UPDATE_STEP
      ) {
        this.onUserDumpProgress(downloadedGames, expectedRemainingGames, done);
        lastReportedDownloadedGames = downloadedGames;
      }
    };

    try {
      for (;;) {
        const url = new URL(`/api/games/user/${encodeURIComponent(user)}`, this.gamesBaseUrl);
        url.searchParams.set('max', String(LICHESS_USER_PAGE_SIZE));
        url.searchParams.set('moves', 'true');
        url.searchParams.set('pgnInJson', 'true');
        url.searchParams.set('opening', 'false');
        url.searchParams.set('clocks', 'false');
        url.searchParams.set('evals', 'false');
        url.searchParams.set('perfType', LICHESS_STANDARD_PERF_TYPES);
        if (since !== null) {
          url.searchParams.set('since', String(since));
        }
        if (until !== null) {
          url.searchParams.set('until', String(until));
        }

        const { lineCount, oldestCreatedAt, timings } = await this.requestNdjsonLines(
          url,
          {
            logNetwork: isFirstPage,
            onResponseOk:
              isFirstPage && expectedRemainingGames !== null
                ? () => this.onUserDumpProgress(downloadedGames, expectedRemainingGames, false)
                : undefined,
          },
          async (line) => {
            const game = this.parseUserGameLine(line, `${url.toString()}#download`);
            const createdAt = typeof game.createdAt === 'number' && Number.isFinite(game.createdAt) ? game.createdAt : null;
            if (createdAt === null) {
              throw new Error('Lichess user dump line missing createdAt; cannot batch user cache by month.');
            }
            const yearMonth = formatYearMonth(createdAt);
            const writeStartedAt = Date.now();
            await this.writeLineToMonthlyFile(monthlyWriters, cachePaths.dataDirectory, yearMonth, line);
            stepTotals.writeLinesMs += Date.now() - writeStartedAt;

            monthlyGameCounts.set(yearMonth, (monthlyGameCounts.get(yearMonth) ?? 0) + 1);
            if (newestCreatedAt === null || createdAt > newestCreatedAt) {
              newestCreatedAt = createdAt;
            }

            downloadedGames += 1;
            const progressStartedAt = Date.now();
            emitProgress(false, false);
            stepTotals.progressMs += Date.now() - progressStartedAt;
          },
        );
        stepTotals.requestPageMs += timings.requestPageMs;
        stepTotals.downloadBodyMs += timings.downloadBodyMs;
        stepTotals.readBodyMs += timings.readBodyMs;
        stepTotals.parseLinesMs += timings.parseLinesMs;
        isFirstPage = false;
        if (lineCount === 0) {
          break;
        }
        const forcedProgressStartedAt = Date.now();
        emitProgress(false, true);
        stepTotals.progressMs += Date.now() - forcedProgressStartedAt;

        if (lineCount < LICHESS_USER_PAGE_SIZE || oldestCreatedAt === null) {
          break;
        }
        until = oldestCreatedAt - 1;
      }
    } finally {
      await this.closeMonthlyWriters(monthlyWriters);
    }

    if (newestCreatedAt !== null) {
      await this.writeLastAvailableAt(cachePaths.lastAvailableAtPath, newestCreatedAt);
    }
    await this.writeMonthlyGameCounts(cachePaths.monthlyGameCountCsvPath, monthlyGameCounts);
    const doneProgressStartedAt = Date.now();
    emitProgress(true, true);
    stepTotals.progressMs += Date.now() - doneProgressStartedAt;
    this.logUserDumpStepTotals(stepTotals);
    const elapsedMs = Date.now() - startedAt;
    this.onNetworkStatus(`Lichess user dump: finished with ${downloadedGames} new games in ${elapsedMs}ms`);
  }

  private async readUserMoveStatsFromDirectory(
    dataDirectory: string,
    user: string,
    fen: string,
    side: Side,
    sinceTimestampMs: number | null = null,
  ): Promise<MoveStats[]> {
    const minYearMonth = sinceTimestampMs === null ? null : formatYearMonth(sinceTimestampMs);
    const filePaths = await this.listMonthlyDataFiles(dataDirectory, minYearMonth);
    const map = new Map<string, MoveStats>();
    for (const filePath of filePaths) {
      const fileStream = createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
      let lineNumber = 0;
      try {
        for await (const rawLine of rl) {
          lineNumber += 1;
          const line = rawLine.trim();
          if (line === '') {
            continue;
          }
          const game = this.parseUserGameLine(line, `${filePath}#${lineNumber}`);
          if (sinceTimestampMs !== null) {
            const createdAt = typeof game.createdAt === 'number' && Number.isFinite(game.createdAt) ? game.createdAt : null;
            if (createdAt === null || createdAt < sinceTimestampMs) {
              continue;
            }
          }
          addGameMoveStat(map, game, user, fen, side);
        }
      } finally {
        rl.close();
        fileStream.destroy();
      }
    }
    return sortMoveStats(map.values());
  }

  private async writeLineToMonthlyFile(
    monthlyWriters: Map<string, WriteStream>,
    dataDirectory: string,
    yearMonth: string,
    line: string,
  ): Promise<void> {
    let writer = monthlyWriters.get(yearMonth);
    if (!writer) {
      const filePath = resolve(dataDirectory, `${yearMonth}.ndjson`);
      writer = createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
      monthlyWriters.set(yearMonth, writer);
    }
    const writeAccepted = writer.write(`${line}\n`);
    if (!writeAccepted) {
      await new Promise<void>((resolvePromise) => {
        writer!.once('drain', () => resolvePromise());
      });
    }
  }

  private async closeMonthlyWriters(monthlyWriters: Map<string, WriteStream>): Promise<void> {
    await Promise.all(
      [...monthlyWriters.values()].map(
        (writer) =>
          new Promise<void>((resolvePromise) => {
            writer.end(() => resolvePromise());
          }),
      ),
    );
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

  private async readLastAvailableAt(lastAvailableAtPath: string): Promise<number | null> {
    try {
      const text = (await readFile(lastAvailableAtPath, 'utf8')).trim();
      if (text === '') {
        return null;
      }
      const parsed = Number.parseInt(text, 10);
      return Number.isFinite(parsed) ? parsed : null;
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async writeLastAvailableAt(lastAvailableAtPath: string, lastAvailableAt: number): Promise<void> {
    await writeFile(lastAvailableAtPath, `${lastAvailableAt}\n`, 'utf8');
  }

  private async loadMonthlyGameCounts(cachePaths: UserCachePaths): Promise<Map<string, number>> {
    const fromCsv = await this.readMonthlyGameCounts(cachePaths.monthlyGameCountCsvPath);
    if (fromCsv !== null) {
      return fromCsv;
    }
    return this.countGamesFromMonthlyFiles(cachePaths.dataDirectory);
  }

  private async readMonthlyGameCounts(monthlyGameCountCsvPath: string): Promise<Map<string, number> | null> {
    let text: string;
    try {
      text = await readFile(monthlyGameCountCsvPath, 'utf8');
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }

    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (lines.length === 0) {
      return new Map<string, number>();
    }

    const counts = new Map<string, number>();
    const startIndex = lines[0].toLowerCase() === 'year_month,games' ? 1 : 0;
    for (let index = startIndex; index < lines.length; index += 1) {
      const [yearMonthRaw, gamesRaw, extra] = lines[index].split(',');
      if (!yearMonthRaw || !gamesRaw || extra !== undefined) {
        return null;
      }
      const yearMonth = yearMonthRaw.trim();
      if (!/^\d{4}-\d{2}$/u.test(yearMonth)) {
        return null;
      }
      const games = Number.parseInt(gamesRaw.trim(), 10);
      if (!Number.isFinite(games) || games < 0) {
        return null;
      }
      counts.set(yearMonth, games);
    }
    return counts;
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

  private async getUserTotalGameCount(user: string): Promise<number | null> {
    const url = new URL(`/api/user/${encodeURIComponent(user)}`, this.gamesBaseUrl);
    try {
      const profile = await this.requestJson<LichessUserProfile>(url, { logNetwork: false });
      return typeof profile.count?.all === 'number' ? profile.count.all : null;
    } catch {
      return null;
    }
  }

  private async requestJson<T>(url: URL, options: RequestOptions = { logNetwork: true }): Promise<T> {
    const { data } = await this.requestJsonWithRaw<T>(url, options);
    return data;
  }

  private async requestJsonWithRaw<T>(
    url: URL,
    options: RequestOptions = { logNetwork: true },
  ): Promise<{ data: T; rawResponseText: string }> {
    const startedAt = Date.now();
    const fullUrl = url.toString();
    const shouldLogNetwork = options.logNetwork ?? true;
    if (shouldLogNetwork) {
      this.onNetworkStatus(`Network: GET ${fullUrl} started`);
    }

    try {
      const response = await fetchWith429Retries(
        () =>
          this.fetchImpl(url, {
            headers: this.requestHeaders(url, 'application/json'),
          }),
        {
          requestDescription: `GET ${fullUrl}`,
          onWarning: (message) => this.onNetworkStatus(`${message}${options.retryWarningSuffix ?? ''}`),
          onBeforeRetry: options.onBefore429Retry,
          onWait: options.onWaitFor429Retry,
          maxRetries: options.max429Retries,
        },
      );

      const elapsedMs = Date.now() - startedAt;
      if (shouldLogNetwork) {
        this.onNetworkStatus(
          `Network: GET ${fullUrl} -> ${response.status} ${response.statusText} (${elapsedMs}ms)`,
        );
      }

      if (!response.ok) {
        throw new Error(`Lichess API error ${response.status}: ${response.statusText}`);
      }

      const responseText = await response.text();
      return {
        data: this.parseJsonResponse<T>(responseText, fullUrl),
        rawResponseText: responseText,
      };
    } catch (error: unknown) {
      const elapsedMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      if (shouldLogNetwork) {
        this.onNetworkStatus(`Network: GET ${fullUrl} failed after ${elapsedMs}ms (${message})`);
      }
      throw error;
    }
  }

  private async requestNdjsonLines(
    url: URL,
    options: RequestOptions = { logNetwork: true },
    onLine: ((line: string) => void | Promise<void>) | undefined = undefined,
  ): Promise<{
    lineCount: number;
    oldestCreatedAt: number | null;
    timings: Pick<UserDumpStepTotals, 'requestPageMs' | 'downloadBodyMs' | 'readBodyMs' | 'parseLinesMs'>;
  }> {
    const startedAt = Date.now();
    const fullUrl = url.toString();
    const shouldLogNetwork = options.logNetwork ?? true;
    if (shouldLogNetwork) {
      this.onNetworkStatus(`Network: GET ${fullUrl} started`);
    }

    try {
      const requestPageStartedAt = Date.now();
      const response = await fetchWith429Retries(
        () =>
          this.fetchImpl(url, {
            headers: this.requestHeaders(url, 'application/x-ndjson'),
          }),
        {
          requestDescription: `GET ${fullUrl}`,
          onWarning: (message) => this.onNetworkStatus(`${message}${options.retryWarningSuffix ?? ''}`),
          onBeforeRetry: options.onBefore429Retry,
          onWait: options.onWaitFor429Retry,
          maxRetries: options.max429Retries,
        },
      );
      const requestPageMs = Date.now() - requestPageStartedAt;

      const elapsedMs = Date.now() - startedAt;
      if (shouldLogNetwork) {
        this.onNetworkStatus(
          `Network: GET ${fullUrl} -> ${response.status} ${response.statusText} (${elapsedMs}ms)`,
        );
      }

      if (!response.ok) {
        throw new Error(`Lichess API error ${response.status}: ${response.statusText}`);
      }
      options.onResponseOk?.();

      let lineCount = 0;
      let oldestCreatedAt: number | null = null;
      const downloadBodyStartedAt = Date.now();
      let readBodyMs = 0;
      let parseLinesMs = 0;

      if (!response.body) {
        const responseBytes = await response.arrayBuffer();
        const downloadBodyMs = Date.now() - downloadBodyStartedAt;
        const readBodyStartedAt = Date.now();
        const responseText = new TextDecoder().decode(responseBytes);
        readBodyMs = Date.now() - readBodyStartedAt;
        const parseLinesStartedAt = Date.now();
        for (const rawLine of responseText.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (line === '') {
            continue;
          }
          lineCount += 1;
          const createdAt = extractCreatedAtTimestamp(line);
          if (createdAt !== null) {
            oldestCreatedAt = createdAt;
          }
          if (onLine) {
            await onLine(line);
          }
        }
        parseLinesMs = Date.now() - parseLinesStartedAt;
        return { lineCount, oldestCreatedAt, timings: { requestPageMs, downloadBodyMs, readBodyMs, parseLinesMs } };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let remainder = '';
      for (;;) {
        const readStartedAt = Date.now();
        const { done, value } = await reader.read();
        readBodyMs += Date.now() - readStartedAt;
        if (done) {
          break;
        }

        const decodeStartedAt = Date.now();
        remainder += decoder.decode(value, { stream: true });
        readBodyMs += Date.now() - decodeStartedAt;

        const parseStartedAt = Date.now();
        const lines = remainder.split(/\r?\n/);
        remainder = lines.pop() ?? '';
        parseLinesMs += Date.now() - parseStartedAt;

        for (const rawLine of lines) {
          const parseLineStartedAt = Date.now();
          const line = rawLine.trim();
          if (line === '') {
            parseLinesMs += Date.now() - parseLineStartedAt;
            continue;
          }
          lineCount += 1;
          const createdAt = extractCreatedAtTimestamp(line);
          if (createdAt !== null) {
            oldestCreatedAt = createdAt;
          }
          parseLinesMs += Date.now() - parseLineStartedAt;
          if (onLine) {
            await onLine(line);
          }
        }
      }

      const flushStartedAt = Date.now();
      remainder += decoder.decode();
      readBodyMs += Date.now() - flushStartedAt;
      const downloadBodyMs = Date.now() - downloadBodyStartedAt;
      const finalLineParseStartedAt = Date.now();
      const finalLine = remainder.trim();
      if (finalLine !== '') {
        lineCount += 1;
        const createdAt = extractCreatedAtTimestamp(finalLine);
        if (createdAt !== null) {
          oldestCreatedAt = createdAt;
        }
        if (onLine) {
          await onLine(finalLine);
        }
      }
      parseLinesMs += Date.now() - finalLineParseStartedAt;

      return { lineCount, oldestCreatedAt, timings: { requestPageMs, downloadBodyMs, readBodyMs, parseLinesMs } };
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

  private requestHeaders(url: URL, accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: accept,
      'Accept-Encoding': 'gzip, br',
    };
    if (this.apiToken && this.isLichessApiHost(url)) {
      headers.Authorization = `Bearer ${this.apiToken}`;
    }
    return headers;
  }

  private isLichessApiHost(url: URL): boolean {
    return /(^|\.)lichess\.org$/iu.test(url.hostname);
  }

  private parseUserGameLine(line: string, source: string): LichessUserGame {
    try {
      return JSON.parse(line) as LichessUserGame;
    } catch (error: unknown) {
      const parseMessage = error instanceof Error ? error.message : String(error);
      this.onNetworkStatus(`Network: NDJSON parse failed from ${source}; received line:\n${line}`);
      throw new Error(`Failed to parse NDJSON line from ${source}: ${parseMessage}\nReceived line:\n${line}`);
    }
  }

  private logUserDumpStepTotals(stepTotals: UserDumpStepTotals): void {
    const totalMs =
      stepTotals.requestPageMs +
      stepTotals.downloadBodyMs +
      stepTotals.readBodyMs +
      stepTotals.parseLinesMs +
      stepTotals.writeLinesMs +
      stepTotals.progressMs;
    if (totalMs === 0) {
      return;
    }

    const asPercent = (value: number): string => ((value / totalMs) * 100).toFixed(1);
    this.onNetworkStatus(
      `Lichess user dump timings (sum ${totalMs}ms): ` +
        `1/request=${stepTotals.requestPageMs}ms (${asPercent(stepTotals.requestPageMs)}%), ` +
        `2/download=${stepTotals.downloadBodyMs}ms (${asPercent(stepTotals.downloadBodyMs)}%), ` +
        `3/readBody=${stepTotals.readBodyMs}ms (${asPercent(stepTotals.readBodyMs)}%), ` +
        `4/parse=${stepTotals.parseLinesMs}ms (${asPercent(stepTotals.parseLinesMs)}%), ` +
        `5/write=${stepTotals.writeLinesMs}ms (${asPercent(stepTotals.writeLinesMs)}%), ` +
        `6/progress=${stepTotals.progressMs}ms (${asPercent(stepTotals.progressMs)}%)`,
    );
  }
}
