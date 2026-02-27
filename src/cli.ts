import { Chess } from 'chess.js';
import cliProgress from 'cli-progress';
import * as dotenv from 'dotenv';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { renderBoard } from './board.js';
import { SessionCache } from './cache.js';
import { LichessClient } from './api/lichess.js';
import { ChessComClient } from './api/chesscom.js';
import { mergeStats, renderStatsTable } from './evaluator.js';
import type { Side } from './types.js';

dotenv.config();

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
  private readonly chessComClient = new ChessComClient(fetch, undefined, (message) => this.logStatus(message));
  private readonly history: string[] = [];
  private lichessDumpProgress: cliProgress.SingleBar | null = null;
  private lichessDumpProgressTotal = 0;

  async run(): Promise<void> {
    const rl = readline.createInterface({ input, output });
    const lichessUser = process.env.LICHESS_USER || (await rl.question('Lichess username: '));
    const chessComUser = process.env.CHESSCOM_USER || (await rl.question('Chess.com username: '));

    let fen = await rl.question('FEN: ');
    const sideInput = (await rl.question('Side (white/black or w/b): ')).trim().toLowerCase();
    let side: Side;
    if (sideInput === 'white' || sideInput === 'w') {
      side = 'white';
    } else if (sideInput === 'black' || sideInput === 'b') {
      side = 'black';
    } else {
      throw new Error('Side must be white/black or w/b.');
    }

    await this.evaluatePosition(fen, side, lichessUser, chessComUser);

    for (;;) {
      const action = await rl.question('Move (SAN), left arrow (←), or Enter to go back: ');
      if (action.trim() === '') {
        if (this.history.length === 0) {
          this.logLine('No history yet.');
          continue;
        }
        this.history.pop();
      } else if (action.includes('\u001b[D')) {
        this.history.pop();
      } else {
        this.history.push(action.trim());
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
      await this.evaluatePosition(fen, side, lichessUser, chessComUser);
    }
  }

  private async evaluatePosition(fen: string, side: Side, lichessUser: string, chessComUser: string): Promise<void> {
    this.logLine('\n' + renderBoard(fen));
    this.logLine(`\nFetching stats for ${side}...`);

    const lichessUserKey = `lichess-user:${lichessUser}:${side}:${fen}`;
    const lichessDbKey = `lichess-db:${fen}`;
    const chessComKey = `chesscom:${chessComUser}:${side}:${fen}`;

    this.logLine('Status: Lichess user request started');
    const lichessUserStats = await this.cache.getOrSet(lichessUserKey, () => this.lichessClient.getUserMoveStats(lichessUser, fen, side));
    this.logLine('Status: Lichess user request finished');

    this.logLine('Status: Lichess DB request started');
    const lichessDbPromise = this.cache.getOrSet(lichessDbKey, () => this.lichessClient.getDatabaseMoveStats(fen));

    this.logLine('Status: Chess.com user request started');
    const chessComPromise = this.cache.getOrSet(chessComKey, () => this.chessComClient.getUserMoveStats(chessComUser, fen, side));

    const [lichessDbStats, chessComStats] = await Promise.all([lichessDbPromise, chessComPromise]);
    this.logLine('Status: Lichess DB request finished');
    this.logLine('Status: Chess.com user request finished');

    const rows = mergeStats(lichessUserStats, chessComStats, lichessDbStats);
    this.logLine('\n' + renderStatsTable(rows));
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
}

const app = new App();
app.run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
