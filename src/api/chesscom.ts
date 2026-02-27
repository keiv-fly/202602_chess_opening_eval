import { Chess } from 'chess.js';
import type { MoveStats, Side } from '../types.js';

type ArchivesResponse = { archives: string[] };
type GamesResponse = {
  games: Array<{
    pgn: string;
    white: { username: string; result: string };
    black: { username: string; result: string };
  }>;
};

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

export function moveStatsFromPgnGames(
  games: GamesResponse['games'],
  username: string,
  fen: string,
  side: Side,
): MoveStats[] {
  const targetUser = username.toLowerCase();
  const map = new Map<string, MoveStats>();

  for (const game of games) {
    const isWhite = game.white.username.toLowerCase() === targetUser;
    const isBlack = game.black.username.toLowerCase() === targetUser;
    if ((side === 'white' && !isWhite) || (side === 'black' && !isBlack)) continue;

    const chess = new Chess();
    try {
      chess.loadPgn(game.pgn);
    } catch {
      continue;
    }

    const history = chess.history({ verbose: true });
    const replay = new Chess();
    let targetMoveSan: string | null = null;

    for (const move of history) {
      if (replay.fen() === fen) {
        targetMoveSan = move.san;
        break;
      }
      replay.move(move);
    }

    if (!targetMoveSan) continue;

    const winner = gameOutcome(game.white.result, game.black.result);
    if (!winner) continue;

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

  return [...map.values()].sort((a, b) => b.total - a.total || a.san.localeCompare(b.san));
}

export class ChessComClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly baseUrl = 'https://api.chess.com/pub') {}

  async getUserMoveStats(username: string, fen: string, side: Side): Promise<MoveStats[]> {
    const archivesUrl = new URL(`/player/${username}/games/archives`, this.baseUrl);
    const archivesData = await this.request<ArchivesResponse>(archivesUrl);

    const gamesPromises = archivesData.archives.map(async (archive) => {
      const archiveData = await this.request<GamesResponse>(new URL(archive));
      return archiveData.games;
    });

    const allGames = (await Promise.all(gamesPromises)).flat();
    return moveStatsFromPgnGames(allGames, username, fen, side);
  }

  private async request<T>(url: URL): Promise<T> {
    const response = await this.fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`Chess.com API error ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as T;
  }
}
