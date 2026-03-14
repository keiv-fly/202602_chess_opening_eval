import cliProgress from 'cli-progress';
import * as dotenv from 'dotenv';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { OpeningEvaluator } from './openingEvaluator.js';
import { parseSideInput, resolvePositionFromHistory } from './workflow.js';
import type { CloudEvalRetryPromptRequest, CombinedMoveRow, ProgressUpdate, Side } from './types.js';

dotenv.config();

class App {
  private readonly evaluator = new OpeningEvaluator();
  private initialPosition = '';
  private history: string[] = [];
  private lichessUser = '';
  private chessComUser = '';
  private side: Side = 'white';
  private timeFilter = '';
  private preferDownloadedUserGames = true;
  private lichessDumpProgress: cliProgress.SingleBar | null = null;
  private lichessDumpProgressTotal = 0;
  private lichessDataUciProgress: cliProgress.SingleBar | null = null;
  private lichessDataUciProgressTotal = 0;
  private chessComDumpProgress: cliProgress.SingleBar | null = null;
  private chessComDumpProgressTotal = 0;
  private chessComDataUciProgress: cliProgress.SingleBar | null = null;
  private chessComDataUciProgressTotal = 0;
  private stripLeadingStopKeyOnNextMovePrompt = false;

  async run(): Promise<void> {
    const rl = readline.createInterface({ input, output });
    this.lichessUser = process.env.LICHESS_USER || (await rl.question('Lichess username: '));
    this.chessComUser = process.env.CHESSCOM_USER || (await rl.question('Chess.com username: '));
    this.initialPosition = await rl.question('FEN (or SAN moves from start): ');
    this.history = [];
    this.side = parseSideInput(await rl.question('Side (white/black or w/b): '));
    this.timeFilter = await rl.question('Time filter (ISO date/time, YYYY-MM, YYYY; Enter for all): ');

    let currentRows = await this.evaluateCurrentPosition();

    for (;;) {
      if (this.stripLeadingStopKeyOnNextMovePrompt) {
        // Clear any buffered line input captured while "s" was used to stop Lichess retries.
        rl.write('', { ctrl: true, name: 'u' });
      }
      let action = await rl.question('Move (SAN), c to export CSV, u to download games, left arrow (←), or Enter to go back: ');
      if (this.stripLeadingStopKeyOnNextMovePrompt && action.toLowerCase().startsWith('s')) {
        action = action.slice(1);
      }
      this.stripLeadingStopKeyOnNextMovePrompt = false;
      const trimmedAction = action.trim();
      const normalizedAction = trimmedAction.toLowerCase();
      if (normalizedAction === 'c') {
        await this.exportRowsToCsv(currentRows);
        continue;
      }
      if (normalizedAction === 'u') {
        currentRows = await this.evaluateCurrentPosition(true);
        continue;
      }

      if (trimmedAction === '') {
        if (this.history.length === 0) {
          this.logLine('No history yet.');
          continue;
        }
        this.history.pop();
      } else if (action.includes('\u001b[D')) {
        if (this.history.length === 0) {
          this.logLine('No history yet.');
          continue;
        }
        this.history.pop();
      } else {
        const attemptedHistory = [...this.history, trimmedAction];
        if (!resolvePositionFromHistory(this.initialPosition, attemptedHistory)) {
          this.logLine(`Invalid move: ${trimmedAction}`);
          continue;
        }
        this.history = attemptedHistory;
      }

      currentRows = await this.evaluateCurrentPosition();
    }
  }

  private async evaluateCurrentPosition(forceRefreshUserGames = false): Promise<CombinedMoveRow[]> {
    const result = await this.evaluator.evaluate(
      {
        lichessUser: this.lichessUser,
        chessComUser: this.chessComUser,
        initialPosition: this.initialPosition,
        history: this.history,
        side: this.side,
        timeFilter: this.timeFilter,
        forceRefreshUserGames,
        preferDownloadedUserGames: this.preferDownloadedUserGames,
      },
      {
        ansiOutput: true,
        onLog: (message) => {
          if (message.includes('Cloud eval: stop requested by keypress')) {
            this.stripLeadingStopKeyOnNextMovePrompt = true;
          }
          this.logLine(message);
        },
        onProgress: (update) => this.handleProgress(update),
        onRetryPrompt: (request) => this.promptCloudEvalRetryDecision(request),
      },
    );

    this.initialPosition = result.baseFen;
    this.history = [...result.history];
    this.preferDownloadedUserGames = result.userGamesPrimed;
    return result.rows;
  }

  private async exportRowsToCsv(rows: CombinedMoveRow[]): Promise<void> {
    const resolvedPosition = resolvePositionFromHistory(this.initialPosition, this.history);
    if (!resolvedPosition) {
      throw new Error('Failed to resolve position from base FEN and history.');
    }
    const filePath = await this.evaluator.exportRowsToCsv(rows, resolvedPosition.fen, this.side);
    this.logLine(`CSV exported: ${filePath}`);
  }

  private handleProgress(update: ProgressUpdate): void {
    switch (update.key) {
      case 'lichess-user-dump':
        this.updateLichessDumpProgress(update.current, update.total, update.done);
        break;
      case 'lichess-data-uci':
        this.updateLichessDataUciProgress(update.current, update.total, update.done);
        break;
      case 'chesscom-user-dump':
        this.updateChessComDumpProgress(update.current, update.total, update.done);
        break;
      case 'chesscom-data-uci':
        this.updateChessComDataUciProgress(update.current, update.total, update.done);
        break;
      default:
        break;
    }
  }

  private logLine(message: string): void {
    console.log(message);
  }

  private async promptCloudEvalRetryDecision(
    request: CloudEvalRetryPromptRequest,
  ): Promise<'continue-retries' | 'use-cached-values'> {
    this.logLine(
      `Status: Cloud eval retry needed (${request.retryIndex}/${request.maxRetries}, wait ~${request.waitSeconds}s): ${request.requestDescription}`,
    );
    const rl = readline.createInterface({ input, output });
    try {
      for (;;) {
        const answer = (
          await rl.question('Continue retries? [Y]es to keep retrying, [N]o to continue with cached values: ')
        )
          .trim()
          .toLowerCase();
        if (answer === '' || answer === 'y' || answer === 'yes') {
          return 'continue-retries';
        }
        if (answer === 'n' || answer === 'no') {
          return 'use-cached-values';
        }
        this.logLine('Please answer y/yes or n/no.');
      }
    } finally {
      rl.close();
    }
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

  private updateLichessDataUciProgress(processedFiles: number, totalFiles: number, done: boolean): void {
    const normalizedTotal = Math.max(0, totalFiles);
    const normalizedProcessed = Math.max(0, Math.min(processedFiles, normalizedTotal));
    const progressTotal = Math.max(1, normalizedTotal);
    const progressProcessed = done ? progressTotal : Math.min(normalizedProcessed, progressTotal);
    const progressPayload = {
      displayValue: done ? normalizedTotal : normalizedProcessed,
      displayTotal: normalizedTotal,
    };

    if (!this.lichessDataUciProgress) {
      this.lichessDataUciProgress = new cliProgress.SingleBar(
        {
          format:
            'Status: Lichess data_uci [{bar}] {displayValue}/{displayTotal} ETA {eta_formatted} Elapsed {duration_formatted}',
          hideCursor: true,
          clearOnComplete: false,
          stopOnComplete: false,
          stream: output,
          autopadding: true,
          forceRedraw: true,
        },
        cliProgress.Presets.shades_classic,
      );
      this.lichessDataUciProgressTotal = progressTotal;
      this.lichessDataUciProgress.start(progressTotal, progressProcessed, progressPayload);
    } else {
      if (progressTotal !== this.lichessDataUciProgressTotal) {
        this.lichessDataUciProgressTotal = progressTotal;
        this.lichessDataUciProgress.setTotal(progressTotal);
      }
      this.lichessDataUciProgress.update(progressProcessed, progressPayload);
    }

    if (done && this.lichessDataUciProgress) {
      this.lichessDataUciProgress.update(progressProcessed, progressPayload);
      this.lichessDataUciProgress.stop();
      this.lichessDataUciProgress = null;
      this.lichessDataUciProgressTotal = 0;
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

  private updateChessComDataUciProgress(processedFiles: number, totalFiles: number, done: boolean): void {
    const normalizedTotal = Math.max(0, totalFiles);
    const normalizedProcessed = Math.max(0, Math.min(processedFiles, normalizedTotal));
    const progressTotal = Math.max(1, normalizedTotal);
    const progressProcessed = done ? progressTotal : Math.min(normalizedProcessed, progressTotal);
    const progressPayload = {
      displayValue: done ? normalizedTotal : normalizedProcessed,
      displayTotal: normalizedTotal,
    };

    if (!this.chessComDataUciProgress) {
      this.chessComDataUciProgress = new cliProgress.SingleBar(
        {
          format:
            'Status: Chess.com data_uci [{bar}] {displayValue}/{displayTotal} ETA {eta_formatted} Elapsed {duration_formatted}',
          hideCursor: true,
          clearOnComplete: false,
          stopOnComplete: false,
          stream: output,
          autopadding: true,
          forceRedraw: true,
        },
        cliProgress.Presets.shades_classic,
      );
      this.chessComDataUciProgressTotal = progressTotal;
      this.chessComDataUciProgress.start(progressTotal, progressProcessed, progressPayload);
    } else {
      if (progressTotal !== this.chessComDataUciProgressTotal) {
        this.chessComDataUciProgressTotal = progressTotal;
        this.chessComDataUciProgress.setTotal(progressTotal);
      }
      this.chessComDataUciProgress.update(progressProcessed, progressPayload);
    }

    if (done && this.chessComDataUciProgress) {
      this.chessComDataUciProgress.update(progressProcessed, progressPayload);
      this.chessComDataUciProgress.stop();
      this.chessComDataUciProgress = null;
      this.chessComDataUciProgressTotal = 0;
    }
  }
}

const app = new App();
app.run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
