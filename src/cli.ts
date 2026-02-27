import { Chess } from 'chess.js';
import * as dotenv from 'dotenv';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
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
  private transientStatusVisible = false;
  private readonly playerStreamFile = createWriteStream(resolve(process.cwd(), 'player.ndjson'), {
    flags: 'a',
    encoding: 'utf8',
  });
  private readonly lichessClient = new LichessClient(
    fetch,
    undefined,
    (message) => this.logStatus(message),
    (line) => this.writePlayerLine(line),
  );
  private readonly chessComClient = new ChessComClient(fetch, undefined, (message) => this.logStatus(message));
  private readonly history: string[] = [];

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
    const isPlayerStreamTick = message.startsWith('Network: /player stream ');

    if (isPlayerStreamTick && output.isTTY) {
      output.write(`\r\x1b[2K${formatted}`);
      this.transientStatusVisible = true;
      return;
    }

    this.logLine(formatted);
  }

  private logLine(message: string): void {
    if (this.transientStatusVisible && output.isTTY) {
      output.write('\r\x1b[2K');
      this.transientStatusVisible = false;
    }
    console.log(message);
  }

  private writePlayerLine(line: string): void {
    if (this.transientStatusVisible && output.isTTY) {
      output.write('\r\x1b[2K');
      this.transientStatusVisible = false;
    }
    process.stdout.write(line);
    this.playerStreamFile.write(line);
  }
}

const app = new App();
app.run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
