import { Chess } from 'chess.js';
import { createReadStream, createWriteStream, type Dirent, type WriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import readline from 'node:readline';
import type { MoveEval, MoveStats, Side } from '../types.js';

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

type LichessUserGame = {
  createdAt?: number;
  moves?: string;
  winner?: 'white' | 'black';
  status?: string;
  players?: {
    white?: { user?: { name?: string } };
    black?: { user?: { name?: string } };
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

function applyUciMove(chess: Chess, uci: string): string | null {
  const trimmed = uci.trim();
  if (trimmed.length < 4) {
    return null;
  }
  const from = trimmed.slice(0, 2);
  const to = trimmed.slice(2, 4);
  const promotion = trimmed.length > 4 ? (trimmed[4].toLowerCase() as 'q' | 'r' | 'b' | 'n') : undefined;
  const move = chess.move({ from, to, promotion });
  return move?.san ?? null;
}

function addGameMoveStat(
  map: Map<string, MoveStats>,
  game: LichessUserGame,
  username: string,
  fen: string,
  side: Side,
): void {
  const targetUser = username.toLowerCase();
  const whiteUser = game.players?.white?.user?.name?.toLowerCase();
  const blackUser = game.players?.black?.user?.name?.toLowerCase();
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
  for (const uci of game.moves.trim().split(/\s+/)) {
    if (replay.fen() === fen) {
      targetMoveSan = applyUciMove(replay, uci);
      break;
    }
    if (!applyUciMove(replay, uci)) {
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
  ) {}

  async getUserMoveStats(user: string, fen: string, side: Side): Promise<MoveStats[]> {
    const cachePaths = await this.ensureUserGamesCache(user);
    return this.readUserMoveStatsFromDirectory(cachePaths.dataDirectory, user, fen, side);
  }

  async getDatabaseMoveStats(fen: string): Promise<Array<MoveStats & { eval?: MoveEval }>> {
    const url = new URL('/lichess', this.baseUrl);
    url.searchParams.set('fen', fen);

    const data = await this.requestJson<{ moves?: LichessDbMove[] }>(url);
    return (data.moves ?? []).map((m) => ({
      san: m.san,
      white: m.white,
      draws: m.draws,
      black: m.black,
      total: m.white + m.draws + m.black,
      eval: m.cp !== undefined || m.mate !== undefined ? { cp: m.cp, mate: m.mate } : undefined,
    }));
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
  ): Promise<MoveStats[]> {
    const filePaths = await this.listMonthlyDataFiles(dataDirectory);
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

  private async listMonthlyDataFiles(dataDirectory: string): Promise<string[]> {
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
      .filter((entry) => entry.isFile() && parseYearMonthFromDataFileName(entry.name) !== null)
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
    const startedAt = Date.now();
    const fullUrl = url.toString();
    const shouldLogNetwork = options.logNetwork ?? true;
    if (shouldLogNetwork) {
      this.onNetworkStatus(`Network: GET ${fullUrl} started`);
    }

    try {
      const response = await this.fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, br',
        },
      });

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
      const response = await this.fetchImpl(url, {
        headers: {
          Accept: 'application/x-ndjson',
          'Accept-Encoding': 'gzip, br',
        },
      });
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
