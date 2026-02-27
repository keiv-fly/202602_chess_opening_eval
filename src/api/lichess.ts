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
    private readonly onNetworkStatus: (message: string) => void = () => {},
    private readonly onPlayerResponseLine: (line: string) => void = () => {},
  ) {}

  async getUserMoveStats(user: string, fen: string, side: Side): Promise<MoveStats[]> {
    const url = new URL('/player', this.baseUrl);
    url.searchParams.set('player', user);
    url.searchParams.set('fen', fen);
    url.searchParams.set('color', side);
    url.searchParams.set('recentGames', '0');

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
    const startedAt = Date.now();
    const fullUrl = url.toString();
    this.onNetworkStatus(`Network: GET ${fullUrl} started`);

    try {
      const response = await this.fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, br',
        },
      });

      const elapsedMs = Date.now() - startedAt;
      this.onNetworkStatus(
        `Network: GET ${fullUrl} -> ${response.status} ${response.statusText} (${elapsedMs}ms)`,
      );

      if (!response.ok) {
        throw new Error(`Lichess API error ${response.status}: ${response.statusText}`);
      }

      const responseText = await this.readResponseText(url, response);
      return this.parseJsonResponse<T>(responseText, fullUrl);
    } catch (error: unknown) {
      const elapsedMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      this.onNetworkStatus(`Network: GET ${fullUrl} failed after ${elapsedMs}ms (${message})`);
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

  private async readResponseText(url: URL, response: Response): Promise<string> {
    if (url.pathname !== '/player') {
      return response.text();
    }

    return this.readPlayerResponseText(response);
  }

  private async readPlayerResponseText(response: Response): Promise<string> {
    if (!response.body) {
      return response.text();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullBody = '';
    let pending = '';
    let lastBlockReadAt = Date.now();

    const emitCompleteLines = (): void => {
      let newlineIndex = pending.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = pending.slice(0, newlineIndex + 1);
        this.onPlayerResponseLine(line);
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf('\n');
      }
    };

    const interval = setInterval(() => {
      emitCompleteLines();
      const secondsSinceLastBlock = Math.floor((Date.now() - lastBlockReadAt) / 1_000);
      this.onNetworkStatus(`Network: /player stream ${secondsSinceLastBlock}s since last block read`);
    }, 1_000);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        lastBlockReadAt = Date.now();
        const decoded = decoder.decode(value, { stream: true });
        fullBody += decoded;
        pending += decoded;
      }

      const remainder = decoder.decode();
      if (remainder !== '') {
        fullBody += remainder;
        pending += remainder;
      }

      emitCompleteLines();
      return fullBody;
    } finally {
      clearInterval(interval);
    }
  }
}
