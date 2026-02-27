import { Chess } from 'chess.js';
import cliProgress from 'cli-progress';
import * as dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { renderBoard } from './board.js';
import { SessionCache } from './cache.js';
import { LichessClient } from './api/lichess.js';
import { ChessComClient } from './api/chesscom.js';
import { mergeStats, renderStatsCsv, renderStatsTable } from './evaluator.js';
import { normalizeFenWithoutMoveCounters } from './fen.js';
import type { CombinedMoveRow, Side } from './types.js';

dotenv.config();

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

type UserTimeFilter = {
  sinceTimestampMs: number | null;
  cacheKey: string;
  label: string;
};

class App {
  private readonly cache = new SessionCache();
  private readonly lichessClient = new LichessClient(
    fetch,
    undefined,
    (message) => this.logStatus(message),
    undefined,
    undefined,
    undefined,
    (loadedGames, totalGames, done) => this.updateLichessDumpProgress(loadedGames, totalGames, done),
  );
  private readonly chessComClient = new ChessComClient(
    fetch,
    undefined,
    (message) => this.logStatus(message),
    undefined,
    (loadedFiles, totalFiles, done) => this.updateChessComDumpProgress(loadedFiles, totalFiles, done),
  );
  private readonly history: string[] = [];
  private lichessDumpProgress: cliProgress.SingleBar | null = null;
  private lichessDumpProgressTotal = 0;
  private chessComDumpProgress: cliProgress.SingleBar | null = null;
  private chessComDumpProgressTotal = 0;

  async run(): Promise<void> {
    const rl = readline.createInterface({ input, output });
    const lichessUser = process.env.LICHESS_USER || (await rl.question('Lichess username: '));
    const chessComUser = process.env.CHESSCOM_USER || (await rl.question('Chess.com username: '));

    let fen = this.parseInitialFen(await rl.question('FEN (or SAN moves from start): '));
    const sideInput = (await rl.question('Side (white/black or w/b): ')).trim().toLowerCase();
    let side: Side;
    if (sideInput === 'white' || sideInput === 'w') {
      side = 'white';
    } else if (sideInput === 'black' || sideInput === 'b') {
      side = 'black';
    } else {
      throw new Error('Side must be white/black or w/b.');
    }

    const timeFilterInput = await rl.question('Time filter (ISO date/time, YYYY-MM, YYYY; Enter for all): ');
    const timeFilter = this.parseUserTimeFilter(timeFilterInput);

    let currentRows = await this.evaluatePosition(fen, side, lichessUser, chessComUser, timeFilter);

    for (;;) {
      const action = await rl.question('Move (SAN), c to export CSV, left arrow (←), or Enter to go back: ');
      const trimmedAction = action.trim();
      if (trimmedAction.toLowerCase() === 'c') {
        await this.exportRowsToCsv(currentRows, fen, side);
        continue;
      }

      if (trimmedAction === '') {
        if (this.history.length === 0) {
          this.logLine('No history yet.');
          continue;
        }
        this.history.pop();
      } else if (action.includes('\u001b[D')) {
        this.history.pop();
      } else {
        this.history.push(trimmedAction);
      }

      const chess = new Chess();
      chess.load(fen);

      for (const move of this.history) {
        const result = chess.move(move, { strict: false });
        if (!result) {
          this.logLine(`Invalid move in history: ${move}. Resetting history.`);
          this.history.length = 0;
          break;
        }
      }

      fen = chess.fen();
      side = chess.turn() === 'w' ? 'white' : 'black';
      currentRows = await this.evaluatePosition(fen, side, lichessUser, chessComUser, timeFilter);
    }
  }

  private async evaluatePosition(
    fen: string,
    side: Side,
    lichessUser: string,
    chessComUser: string,
    timeFilter: UserTimeFilter,
  ): Promise<CombinedMoveRow[]> {
    this.logLine('\n' + renderBoard(fen));
    this.logLine(`\nFetching stats for ${side}...`);
    this.logLine(`Time filter: ${timeFilter.label}`);
    const normalizedFen = normalizeFenWithoutMoveCounters(fen);

    const lichessUserKey = `lichess-user:${lichessUser}:${side}:${timeFilter.cacheKey}:${normalizedFen}`;
    const lichessDbKey = `lichess-db:${normalizedFen}`;
    const chessComKey = `chesscom:${chessComUser}:${side}:${timeFilter.cacheKey}:${normalizedFen}`;

    this.logLine('Status: Lichess user request started');
    const lichessUserStats = await this.cache.getOrSet(lichessUserKey, () =>
      this.lichessClient.getUserMoveStats(lichessUser, normalizedFen, side, timeFilter.sinceTimestampMs),
    );
    this.logLine('Status: Lichess user request finished');

    this.logLine('Status: Lichess DB request started');
    const lichessDbPromise = this.cache.getOrSet(lichessDbKey, () => this.lichessClient.getDatabaseMoveStats(normalizedFen));

    this.logLine('Status: Chess.com user request started');
    const chessComPromise = this.cache.getOrSet(chessComKey, () =>
      this.chessComClient.getUserMoveStats(chessComUser, normalizedFen, side, timeFilter.sinceTimestampMs),
    );

    const [lichessDbStats, chessComStats] = await Promise.all([lichessDbPromise, chessComPromise]);
    this.logLine('Status: Lichess DB request finished');
    this.logLine('Status: Chess.com user request finished');

    const rows = mergeStats(lichessUserStats, chessComStats, lichessDbStats);
    this.logLine('\n' + renderStatsTable(rows));
    return rows;
  }

  private parseInitialFen(input: string): string {
    const trimmedInput = input.trim();
    if (trimmedInput === '') {
      return STARTING_FEN;
    }

    const fenCandidate = new Chess();
    try {
      fenCandidate.load(trimmedInput);
      return fenCandidate.fen();
    } catch {
      // Try SAN parsing below.
    }

    const sanPosition = new Chess();
    const rawTokens = trimmedInput.replaceAll(',', ' ').split(/\s+/u);
    let parsedAnyMove = false;

    for (const rawToken of rawTokens) {
      const san = this.normalizeInitialSanToken(rawToken);
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
      parsedAnyMove = true;
    }

    if (!parsedAnyMove) {
      throw new Error('Position input must be a valid FEN or SAN moves from starting position.');
    }
    return sanPosition.fen();
  }

  private normalizeInitialSanToken(token: string): string | null {
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

  private parseUserTimeFilter(input: string): UserTimeFilter {
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

  private async exportRowsToCsv(rows: CombinedMoveRow[], fen: string, side: Side): Promise<void> {
    const timestamp = this.formatTimestamp(new Date());
    const outputDir = path.join(process.cwd(), 'data_out');
    const filePath = path.join(outputDir, `${timestamp}.csv`);
    const csv = renderStatsCsv(rows, { fen, side });

    await mkdir(outputDir, { recursive: true });
    await writeFile(filePath, csv, 'utf8');
    this.logLine(`CSV exported: ${filePath}`);
  }

  private formatTimestamp(date: Date): string {
    const pad2 = (value: number): string => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  }

  private logStatus(message: string): void {
    const formatted = `Status: ${message}`;
    this.logLine(formatted);
  }

  private logLine(message: string): void {
    console.log(message);
  }

  private updateLichessDumpProgress(loadedGames: number, totalGames: number, done: boolean): void {
    const normalizedTotal = Math.max(0, totalGames);
    const normalizedLoaded = Math.max(0, Math.min(loadedGames, normalizedTotal));
    const progressTotal = Math.max(1, normalizedTotal);
    const progressLoaded = done ? progressTotal : Math.min(normalizedLoaded, progressTotal);
    const progressPayload = {
      displayValue: done ? normalizedTotal : normalizedLoaded,
      displayTotal: normalizedTotal,
    };

    if (!this.lichessDumpProgress) {
      this.lichessDumpProgress = new cliProgress.SingleBar(
        {
          format:
            'Status: Lichess user dump [{bar}] {displayValue}/{displayTotal} ETA {eta_formatted} Elapsed {duration_formatted}',
          hideCursor: true,
          clearOnComplete: false,
          stopOnComplete: false,
          stream: output,
          autopadding: true,
          forceRedraw: true,
        },
        cliProgress.Presets.shades_classic,
      );
      this.lichessDumpProgressTotal = progressTotal;
      this.lichessDumpProgress.start(progressTotal, progressLoaded, progressPayload);
    } else {
      if (progressTotal !== this.lichessDumpProgressTotal) {
        this.lichessDumpProgressTotal = progressTotal;
        this.lichessDumpProgress.setTotal(progressTotal);
      }
      this.lichessDumpProgress.update(progressLoaded, progressPayload);
    }

    if (done && this.lichessDumpProgress) {
      this.lichessDumpProgress.update(progressLoaded, progressPayload);
      this.lichessDumpProgress.stop();
      this.lichessDumpProgress = null;
      this.lichessDumpProgressTotal = 0;
    }
  }

  private updateChessComDumpProgress(loadedFiles: number, totalFiles: number, done: boolean): void {
    const normalizedTotal = Math.max(0, totalFiles);
    const normalizedLoaded = Math.max(0, Math.min(loadedFiles, normalizedTotal));
    const progressTotal = Math.max(1, normalizedTotal);
    const progressLoaded = done ? progressTotal : Math.min(normalizedLoaded, progressTotal);
    const progressPayload = {
      displayValue: done ? normalizedTotal : normalizedLoaded,
      displayTotal: normalizedTotal,
    };

    if (!this.chessComDumpProgress) {
      this.chessComDumpProgress = new cliProgress.SingleBar(
        {
          format:
            'Status: Chess.com user dump [{bar}] {displayValue}/{displayTotal} ETA {eta_formatted} Elapsed {duration_formatted}',
          hideCursor: true,
          clearOnComplete: false,
          stopOnComplete: false,
          stream: output,
          autopadding: true,
          forceRedraw: true,
        },
        cliProgress.Presets.shades_classic,
      );
      this.chessComDumpProgressTotal = progressTotal;
      this.chessComDumpProgress.start(progressTotal, progressLoaded, progressPayload);
    } else {
      if (progressTotal !== this.chessComDumpProgressTotal) {
        this.chessComDumpProgressTotal = progressTotal;
        this.chessComDumpProgress.setTotal(progressTotal);
      }
      this.chessComDumpProgress.update(progressLoaded, progressPayload);
    }

    if (done && this.chessComDumpProgress) {
      this.chessComDumpProgress.update(progressLoaded, progressPayload);
      this.chessComDumpProgress.stop();
      this.chessComDumpProgress = null;
      this.chessComDumpProgressTotal = 0;
    }
  }
}

const app = new App();
app.run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
