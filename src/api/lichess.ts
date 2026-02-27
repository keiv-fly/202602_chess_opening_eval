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

export class LichessClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = 'https://explorer.lichess.ovh',
  ) {}

  async getUserMoveStats(user: string, fen: string, side: Side): Promise<MoveStats[]> {
    const url = new URL('/player', this.baseUrl);
    url.searchParams.set('player', user);
    url.searchParams.set('fen', fen);
    url.searchParams.set('color', side);

    const data = await this.request<{ moves?: LichessMove[] }>(url);
    return (data.moves ?? []).map((m) => ({
      san: m.san,
      white: m.white,
      draws: m.draws,
      black: m.black,
      total: m.white + m.draws + m.black,
    }));
  }

  async getDatabaseMoveStats(fen: string): Promise<Array<MoveStats & { eval?: MoveEval }>> {
    const url = new URL('/lichess', this.baseUrl);
    url.searchParams.set('fen', fen);

    const data = await this.request<{ moves?: LichessDbMove[] }>(url);
    return (data.moves ?? []).map((m) => ({
      san: m.san,
      white: m.white,
      draws: m.draws,
      black: m.black,
      total: m.white + m.draws + m.black,
      eval: m.cp !== undefined || m.mate !== undefined ? { cp: m.cp, mate: m.mate } : undefined,
    }));
  }

  private async request<T>(url: URL): Promise<T> {
    const response = await this.fetchImpl(url, {
      headers: {
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Lichess API error ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as T;
  }
}
