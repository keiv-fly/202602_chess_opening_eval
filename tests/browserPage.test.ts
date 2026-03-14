import { describe, expect, it } from 'vitest';
import { renderBrowserPage } from '../src/browserPage.js';

describe('browserPage', () => {
  it('escapes regex backslashes inside the inline script', () => {
    const html = renderBrowserPage({
      lichessUser: 'lichess-user',
      chessComUser: 'chesscom-user',
    });

    expect(html).toContain(String.raw`replace(/\u001b\[[0-9;]*m/g, '')`);
    expect(html).toContain(String.raw`replace(/\r/g, '')`);
    expect(html).toContain(String.raw`textContent ? '\n' : ''`);
  });

  it('keeps user-game refresh manual until u is requested', () => {
    const html = renderBrowserPage({
      lichessUser: 'lichess-user',
      chessComUser: 'chesscom-user',
    });

    expect(html).toContain('preferDownloadedUserGames: true');
    expect(html).not.toContain('state.preferDownloadedUserGames = false;');
  });

  it('shows completion chrome only for explicit refreshes', () => {
    const html = renderBrowserPage({
      lichessUser: 'lichess-user',
      chessComUser: 'chesscom-user',
    });

    expect(html).toContain('showCompletionState: Boolean(options.forceRefresh)');
    expect(html).toContain('if (showCompletionState) {');
    expect(html).toContain('cycle.root.insertBefore(container, cycle.logs);');
    expect(html).not.toContain('root.appendChild(progress);');
  });
});
