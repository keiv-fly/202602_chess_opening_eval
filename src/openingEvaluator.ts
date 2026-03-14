import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LichessClient } from './api/lichess.js';
import { ChessComClient } from './api/chesscom.js';
import { renderBoard } from './board.js';
import { SessionCache } from './cache.js';
import { mergeStats, renderStatsCsv, renderStatsTable } from './evaluator.js';
import { normalizeFenWithoutMoveCounters } from './fen.js';
import type {
  CloudEvalRetryPromptRequest,
  CombinedMoveRow,
  EvaluatePositionRequest,
  EvaluatePositionResult,
  ProgressUpdate,
} from './types.js';
import { formatTimestamp, parseInitialPosition, parseUserTimeFilter, resolvePositionFromHistory } from './workflow.js';

export type EvaluationHooks = {
  onLog?: (message: string) => void;
  onProgress?: (update: ProgressUpdate) => void;
  ansiOutput?: boolean;
  onRetryPrompt?: (
    request: CloudEvalRetryPromptRequest,
  ) => Promise<'continue-retries' | 'use-cached-values'> | 'continue-retries' | 'use-cached-values';
};

export class OpeningEvaluator {
  constructor(private readonly cache = new SessionCache()) {}

  async evaluate(request: EvaluatePositionRequest, hooks: EvaluationHooks = {}): Promise<EvaluatePositionResult> {
    const lichessUser = request.lichessUser.trim();
    const chessComUser = request.chessComUser.trim();
    if (lichessUser === '') {
      throw new Error('Lichess username is required.');
    }
    if (chessComUser === '') {
      throw new Error('Chess.com username is required.');
    }

    const initialPosition = parseInitialPosition(request.initialPosition);
    const history = [...initialPosition.initialHistory, ...request.history];
    const resolvedPosition = resolvePositionFromHistory(initialPosition.baseFen, history);
    if (!resolvedPosition) {
      throw new Error('Failed to resolve position from base FEN and history.');
    }

    const timeFilter = parseUserTimeFilter(request.timeFilter);
    const log = (message: string): void => {
      hooks.onLog?.(message);
    };
    const logStatus = (message: string): void => {
      log(`Status: ${message}`);
    };
    const emitProgress = (update: ProgressUpdate): void => {
      hooks.onProgress?.(update);
    };

    const lichessClient = new LichessClient(
      fetch,
      undefined,
      (message) => logStatus(message),
      undefined,
      undefined,
      undefined,
      (loadedGames, totalGames, done) =>
        emitProgress({
          key: 'lichess-user-dump',
          label: 'Lichess user dump',
          current: loadedGames,
          total: totalGames,
          done,
        }),
      (retryRequest) => hooks.onRetryPrompt?.(retryRequest) ?? 'continue-retries',
      undefined,
      (processedFiles, totalFiles, done) =>
        emitProgress({
          key: 'lichess-data-uci',
          label: 'Lichess data_uci',
          current: processedFiles,
          total: totalFiles,
          done,
        }),
    );
    const chessComClient = new ChessComClient(
      fetch,
      undefined,
      (message) => logStatus(message),
      undefined,
      (loadedFiles, totalFiles, done) =>
        emitProgress({
          key: 'chesscom-user-dump',
          label: 'Chess.com user dump',
          current: loadedFiles,
          total: totalFiles,
          done,
        }),
      (processedFiles, totalFiles, done) =>
        emitProgress({
          key: 'chesscom-data-uci',
          label: 'Chess.com data_uci',
          current: processedFiles,
          total: totalFiles,
          done,
        }),
    );

    let useDownloadedGamesOnly = request.preferDownloadedUserGames;
    if (request.forceRefreshUserGames) {
      log('Status: User games update requested; syncing from sites now...');
      this.clearCachedUserMoveStats();
      useDownloadedGamesOnly = false;
    }

    const fen = resolvedPosition.fen;
    log('');
    log(renderBoard(fen));
    log(`FEN: ${fen}`);
    log(`Fetching stats for ${request.side}...`);
    log(`Time filter: ${timeFilter.label}`);

    const normalizedFen = normalizeFenWithoutMoveCounters(fen);
    const lichessUserKey = `lichess-user:${lichessUser}:${request.side}:${timeFilter.cacheKey}:${normalizedFen}`;
    const lichessDbKey = `lichess-db:${normalizedFen}`;
    const chessComKey = `chesscom:${chessComUser}:${request.side}:${timeFilter.cacheKey}:${normalizedFen}`;

    log(
      useDownloadedGamesOnly
        ? 'Status: User games mode -> local downloaded games only (no Lichess/Chess.com user-site requests)'
        : 'Status: User games mode -> site sync requested; downloading/updating now, then local downloaded games',
    );

    log(useDownloadedGamesOnly ? 'Status: Lichess user local read started' : 'Status: Lichess user request started');
    const lichessUserStats = await this.cache.getOrSet(lichessUserKey, () =>
      useDownloadedGamesOnly
        ? lichessClient.getUserMoveStatsFromDownloadedGames(
            lichessUser,
            normalizedFen,
            request.side,
            timeFilter.sinceTimestampMs,
          )
        : lichessClient.getUserMoveStats(lichessUser, normalizedFen, request.side, timeFilter.sinceTimestampMs),
    );
    log(useDownloadedGamesOnly ? 'Status: Lichess user local read finished' : 'Status: Lichess user request finished');

    log('Status: Lichess DB request started');
    const lichessDbPromise = this.cache.getOrSet(lichessDbKey, () => lichessClient.getDatabaseMoveStats(normalizedFen));

    log(useDownloadedGamesOnly ? 'Status: Chess.com user local read started' : 'Status: Chess.com user request started');
    const chessComPromise = this.cache.getOrSet(chessComKey, () =>
      useDownloadedGamesOnly
        ? chessComClient.getUserMoveStatsFromDownloadedGames(
            chessComUser,
            normalizedFen,
            request.side,
            timeFilter.sinceTimestampMs,
          )
        : chessComClient.getUserMoveStats(chessComUser, normalizedFen, request.side, timeFilter.sinceTimestampMs),
    );

    const [lichessDbStats, chessComStats] = await Promise.all([lichessDbPromise, chessComPromise]);
    log('Status: Lichess DB request finished');
    log(useDownloadedGamesOnly ? 'Status: Chess.com user local read finished' : 'Status: Chess.com user request finished');
    if (!useDownloadedGamesOnly) {
      log('Status: User games cache primed for this session; next positions use local files only.');
    }

    this.logSourceTotals(log, lichessUserStats, chessComStats, lichessDbStats);

    const rows = mergeStats(lichessUserStats, chessComStats, lichessDbStats);
    const tableText = renderStatsTable(rows, { enableColors: hooks.ansiOutput === true });
    log('');
    log(tableText);

    return {
      baseFen: initialPosition.baseFen,
      fen,
      side: request.side,
      positionTurn: resolvedPosition.side,
      boardText: renderBoard(fen),
      tableText,
      rows,
      history,
      timeFilterLabel: timeFilter.label,
      userGamesPrimed: true,
    };
  }

  clearCachedUserMoveStats(): void {
    this.cache.deleteByPrefix('lichess-user:');
    this.cache.deleteByPrefix('chesscom:');
  }

  async exportRowsToCsv(rows: CombinedMoveRow[], fen: string, side: EvaluatePositionResult['side']): Promise<string> {
    const timestamp = formatTimestamp(new Date());
    const outputDir = path.join(process.cwd(), 'data_out');
    const filePath = path.join(outputDir, `${timestamp}.csv`);
    const csv = renderStatsCsv(rows, { fen, side });

    await mkdir(outputDir, { recursive: true });
    await writeFile(filePath, csv, 'utf8');
    return filePath;
  }

  private logSourceTotals(
    log: (message: string) => void,
    lichessUserStats: CombinedMoveRow['lichessUser'][],
    chessComStats: CombinedMoveRow['chessComUser'][],
    lichessDbStats: Array<NonNullable<CombinedMoveRow['lichessDb']> & { eval?: CombinedMoveRow['eval'] }>,
  ): void {
    const lichessUserGames = lichessUserStats.reduce((sum, row) => sum + (row?.total ?? 0), 0);
    const chessComGames = chessComStats.reduce((sum, row) => sum + (row?.total ?? 0), 0);
    const lichessDbGames = lichessDbStats.reduce((sum, row) => sum + row.total, 0);

    log(
      `Status: Source matches -> Lichess user ${lichessUserGames} games (${lichessUserStats.length} moves), ` +
        `Chess.com user ${chessComGames} games (${chessComStats.length} moves), ` +
        `Lichess DB ${lichessDbGames} games (${lichessDbStats.length} moves)`,
    );

    if (chessComGames === 0) {
      log('Status: Chess.com has no matching games for this exact FEN + side + time filter (independent from Lichess retry stop).');
    }
  }
}
