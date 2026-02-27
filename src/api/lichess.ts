import { Chess } from 'chess.js';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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
  logNetwork: boolean;
};

const LICHESS_USER_PAGE_SIZE = 300;

function sanitizeUserForFileName(user: string): string {
  return user.replace(/[^A-Za-z0-9_-]/g, '_');
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
    const filePath = await this.ensureUserGamesFile(user);
    return this.readUserMoveStatsFromFile(filePath, user, fen, side);
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

  private async ensureUserGamesFile(user: string): Promise<string> {
    const userKey = user.toLowerCase();
    const filePath = resolve(this.dataInDirectory, `lichess_${sanitizeUserForFileName(user)}.ndjson`);
    if (this.downloadedUsers.has(userKey)) {
      return filePath;
    }

    await mkdir(dirname(filePath), { recursive: true });
    await this.downloadAllUserGames(user, filePath);
    this.downloadedUsers.add(userKey);
    return filePath;
  }

  private async downloadAllUserGames(user: string, filePath: string): Promise<void> {
    const startedAt = Date.now();
    this.onNetworkStatus(`Lichess user dump: start ${user} -> ${filePath}`);
    const out = createWriteStream(filePath, { flags: 'w', encoding: 'utf8' });
    const expectedTotalGames = await this.getUserTotalGameCount(user);
    let totalGames = 0;
    let until: number | null = null;
    let isFirstPage = true;

    try {
      for (;;) {
        const url = new URL(`/api/games/user/${encodeURIComponent(user)}`, this.gamesBaseUrl);
        url.searchParams.set('max', String(LICHESS_USER_PAGE_SIZE));
        url.searchParams.set('moves', 'true');
        url.searchParams.set('pgnInJson', 'true');
        url.searchParams.set('opening', 'false');
        url.searchParams.set('clocks', 'false');
        url.searchParams.set('evals', 'false');
        if (until !== null) {
          url.searchParams.set('until', String(until));
        }

        const { lines, oldestCreatedAt } = await this.requestNdjsonLines(url, { logNetwork: isFirstPage });
        isFirstPage = false;
        if (lines.length === 0) {
          break;
        }

        for (const line of lines) {
          out.write(`${line}\n`);
        }
        totalGames += lines.length;
        if (expectedTotalGames !== null) {
          this.onUserDumpProgress(totalGames, expectedTotalGames, false);
        }

        if (lines.length < LICHESS_USER_PAGE_SIZE || oldestCreatedAt === null) {
          break;
        }
        until = oldestCreatedAt - 1;
      }
    } catch (error: unknown) {
      out.destroy();
      throw error;
    }

    await new Promise<void>((resolvePromise) => {
      out.end(() => resolvePromise());
    });
    if (expectedTotalGames !== null) {
      this.onUserDumpProgress(totalGames, expectedTotalGames, true);
    }
    const elapsedMs = Date.now() - startedAt;
    this.onNetworkStatus(`Lichess user dump: finished with ${totalGames} games in ${elapsedMs}ms`);
  }

  private async readUserMoveStatsFromFile(filePath: string, user: string, fen: string, side: Side): Promise<MoveStats[]> {
    const fileStream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    const map = new Map<string, MoveStats>();
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
      return sortMoveStats(map.values());
    } finally {
      rl.close();
      fileStream.destroy();
    }
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
    if (options.logNetwork) {
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
      if (options.logNetwork) {
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
      if (options.logNetwork) {
        this.onNetworkStatus(`Network: GET ${fullUrl} failed after ${elapsedMs}ms (${message})`);
      }
      throw error;
    }
  }

  private async requestNdjsonLines(
    url: URL,
    options: RequestOptions = { logNetwork: true },
  ): Promise<{ lines: string[]; oldestCreatedAt: number | null }> {
    const startedAt = Date.now();
    const fullUrl = url.toString();
    if (options.logNetwork) {
      this.onNetworkStatus(`Network: GET ${fullUrl} started`);
    }

    try {
      const response = await this.fetchImpl(url, {
        headers: {
          Accept: 'application/x-ndjson',
          'Accept-Encoding': 'gzip, br',
        },
      });

      const elapsedMs = Date.now() - startedAt;
      if (options.logNetwork) {
        this.onNetworkStatus(
          `Network: GET ${fullUrl} -> ${response.status} ${response.statusText} (${elapsedMs}ms)`,
        );
      }

      if (!response.ok) {
        throw new Error(`Lichess API error ${response.status}: ${response.statusText}`);
      }

      const responseText = await response.text();
      const lines = responseText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '');

      let oldestCreatedAt: number | null = null;
      for (const line of lines) {
        const game = this.parseUserGameLine(line, fullUrl);
        if (typeof game.createdAt === 'number') {
          oldestCreatedAt = oldestCreatedAt === null ? game.createdAt : Math.min(oldestCreatedAt, game.createdAt);
        }
      }

      return { lines, oldestCreatedAt };
    } catch (error: unknown) {
      const elapsedMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      if (options.logNetwork) {
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
}
