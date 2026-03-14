type BrowserPageBootstrap = {
  lichessUser: string;
  chessComUser: string;
};

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function renderBrowserPage(bootstrap: BrowserPageBootstrap): string {
  const bootstrapJson = escapeScriptJson(bootstrap);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Chess Opening Eval</title>
  <style>
    :root {
      --bg: #ffffff;
      --text: #1f2937;
      --border: #e5e7eb;
      --input-bg: #ffffff;
      --button: #111827;
      --button-text: #ffffff;
      --muted: #6b7280;
      --shadow: 0 8px 24px rgba(0,0,0,0.06);
      --max-width: 920px;
      --user-bg: #f4f4f4;
      --topbar-icon: #6b7280;
      --menu-bg: #ffffff;
      --menu-hover: #f4f4f4;
      --surface: #fafafa;
      --surface-strong: #f4f4f5;
      --accent: #111827;
      --danger: #b91c1c;
      --success: #166534;
      --mono: Consolas, "Courier New", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
    }

    * { box-sizing: border-box; }

    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
    }

    body {
      min-height: 100vh;
      background: var(--bg);
    }

    .theme-toggle {
      position: fixed;
      opacity: 0;
      pointer-events: none;
    }

    .page {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      background: var(--bg);
      color: var(--text);
    }

    #theme-dark:checked ~ .page {
      --bg: #212121;
      --text: #ececec;
      --border: #3a3a3a;
      --input-bg: #2b2b2b;
      --button: #ececec;
      --button-text: #212121;
      --muted: #b7b7b7;
      --shadow: 0 8px 24px rgba(0,0,0,0.28);
      --user-bg: #303030;
      --topbar-icon: #d4d4d4;
      --menu-bg: #2b2b2b;
      --menu-hover: #383838;
      --surface: #2a2a2a;
      --surface-strong: #313131;
      --accent: #ececec;
      --danger: #fca5a5;
      --success: #86efac;
    }

    .topbar {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      padding: 16px 20px 0;
    }

    .settings {
      position: relative;
    }

    .settings-toggle {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }

    .settings-button {
      width: 40px;
      height: 40px;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: var(--topbar-icon);
      background: transparent;
      border: 1px solid transparent;
      user-select: none;
      position: relative;
      z-index: 21;
    }

    .settings-button:hover {
      background: rgba(127,127,127,0.08);
    }

    .settings-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 19;
      background: transparent;
    }

    .settings-menu {
      position: absolute;
      top: 46px;
      right: 0;
      width: 170px;
      background: var(--menu-bg);
      border: 1px solid var(--border);
      border-radius: 14px;
      box-shadow: var(--shadow);
      padding: 6px;
      display: none;
      z-index: 20;
    }

    .settings-toggle:checked ~ .settings-backdrop,
    .settings-toggle:checked ~ .settings-menu {
      display: block;
    }

    .settings-option {
      display: block;
      width: 100%;
      padding: 10px 12px;
      border-radius: 10px;
      color: var(--text);
      text-decoration: none;
      cursor: pointer;
      user-select: none;
      background: transparent;
      border: none;
      text-align: left;
      font: inherit;
    }

    .settings-option:hover {
      background: var(--menu-hover);
    }

    .content-wrap {
      flex: 1;
      display: flex;
      justify-content: center;
      padding: 24px 20px 20px;
    }

    .content {
      width: 100%;
      max-width: var(--max-width);
      display: flex;
      flex-direction: column;
      gap: 24px;
      font-size: 16px;
      line-height: 1.65;
      padding-bottom: 24px;
      min-width: 0;
    }

    .message-assistant {
      padding: 0 6px;
      min-width: 0;
    }

    .message-user {
      align-self: flex-end;
      background: var(--user-bg);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 14px 18px;
      max-width: 85%;
      white-space: pre-wrap;
      line-height: 1.45;
    }

    .assistant-cycle {
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-width: 0;
    }

    .assistant-intro {
      color: var(--muted);
    }

    .assistant-meta,
    .progress-list,
    .log-card,
    .result-card,
    .session-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 14px 16px;
      box-shadow: var(--shadow);
    }

    .assistant-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      min-width: 0;
    }

    .assistant-meta-title {
      font-weight: 600;
    }

    .assistant-meta-status {
      color: var(--muted);
      font-size: 14px;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 999px;
      background: var(--surface-strong);
      border: 1px solid var(--border);
      font-size: 12px;
      line-height: 1.2;
      color: var(--muted);
    }

    .pill.is-error {
      color: var(--danger);
    }

    .pill.is-success {
      color: var(--success);
    }

    .progress-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .progress-item {
      display: grid;
      gap: 6px;
    }

    .progress-header {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      font-size: 14px;
      color: var(--muted);
    }

    .progress-header strong {
      color: var(--text);
      font-weight: 600;
    }

    progress {
      width: 100%;
      height: 10px;
      appearance: none;
    }

    .log-card {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
    }

    .section-label {
      font-size: 13px;
      font-weight: 600;
      color: var(--muted);
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }

    .log-lines {
      margin: 0;
      padding: 14px 16px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: var(--surface-strong);
      font-family: var(--mono);
      font-size: 13px;
      line-height: 1.5;
      max-height: 320px;
      overflow: auto;
      white-space: pre;
      min-width: 0;
    }

    .log-line {
      margin: 0;
      white-space: inherit;
    }

    .result-card {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
    }

    .mono-output {
      display: block;
      width: 100%;
      max-width: 100%;
      margin: 0;
      padding: 14px 16px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: var(--surface-strong);
      font-family: var(--mono);
      font-size: 14px;
      line-height: 1.45;
      white-space: pre;
      overflow: auto;
      min-width: 0;
    }

    .mono-output.is-board {
      overflow-x: visible;
    }

    .stats-table-wrap {
      width: 100%;
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: var(--surface-strong);
    }

    .stats-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
      table-layout: auto;
    }

    .stats-table col.col-move,
    .stats-table col.col-eval,
    .stats-table col.col-user,
    .stats-table col.col-pot {
      width: 1px;
    }

    .stats-table th,
    .stats-table td {
      padding: 8px 4px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
      min-width: 0;
    }

    .stats-table tr > :first-child {
      padding-left: 8px;
    }

    .stats-table tr > :last-child {
      padding-right: 8px;
    }

    .stats-table th {
      position: sticky;
      top: 0;
      background: var(--surface);
      text-align: left;
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0.02em;
      white-space: normal;
    }

    .stats-table tbody tr:last-child td {
      border-bottom: none;
    }

    .stats-table td.is-num,
    .stats-table th.is-num {
      text-align: right;
    }

    .stats-table td.is-mono {
      font-family: var(--mono);
    }

    .stats-table .col-move {
      width: 1px;
      white-space: nowrap;
    }

    .stats-table .col-eval,
    .stats-table .col-user,
    .stats-table .col-pot {
      width: 1px;
      white-space: nowrap;
    }

    .stats-cell {
      display: grid;
      gap: 2px;
      min-width: 0;
    }

    .stats-cell-main {
      font-family: var(--mono);
      white-space: normal;
    }

    .stats-cell-sub {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
      white-space: normal;
    }

    .stats-table-empty {
      color: var(--muted);
      text-align: center;
    }

    .pot-positive {
      color: var(--success);
      font-weight: 600;
    }

    .pot-negative {
      color: var(--danger);
      font-weight: 600;
    }

    .fen-line {
      font-family: var(--mono);
      font-size: 13px;
      overflow-x: auto;
      white-space: nowrap;
      padding-bottom: 2px;
      min-width: 0;
    }

    .composer {
      padding: 18px 20px 26px;
      display: flex;
      justify-content: center;
      background: linear-gradient(to top, var(--bg) 70%, rgba(247,247,248,0));
      position: sticky;
      bottom: 0;
    }

    #theme-dark:checked ~ .page .composer {
      background: linear-gradient(to top, #212121 70%, rgba(33,33,33,0));
    }

    .composer-inner {
      width: 100%;
      max-width: var(--max-width);
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 22px;
      box-shadow: var(--shadow);
      padding: 8px;
    }

    .composer-input {
      width: 100%;
      border: none;
      outline: none;
      background: transparent;
      font-size: 15px;
      padding: 0 12px;
      color: var(--text);
    }

    .composer-input::placeholder {
      color: #9ca3af;
    }

    #theme-dark:checked ~ .page .composer-input::placeholder {
      color: #c8c8c8;
    }

    .composer-button {
      height: 44px;
      padding: 0 16px;
      border: none;
      border-radius: 14px;
      background: var(--button);
      color: var(--button-text);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }

    .composer-button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    .composer-form {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .composer-input {
      flex: 1;
      min-width: 0;
      height: 46px;
    }

    @media (max-width: 640px) {
      .topbar {
        padding: 12px 14px 0;
      }

      .content-wrap {
        padding: 20px 14px 10px;
      }

      .composer {
        padding: 14px;
      }

      .composer-form {
        flex-direction: column;
        align-items: stretch;
      }

      .composer-button,
      .composer-input {
        width: 100%;
      }

      .message-user {
        max-width: 100%;
      }
    }
  </style>
</head>
<body>
  <input class="theme-toggle" type="radio" name="theme" id="theme-light" checked />
  <input class="theme-toggle" type="radio" name="theme" id="theme-dark" />

  <div class="page">
    <header class="topbar">
      <div class="settings">
        <input class="settings-toggle" type="checkbox" id="settings-open" />
        <label class="settings-button" for="settings-open" aria-label="Open theme settings" title="Theme settings">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37 1 .608 2.296.07 2.572-1.065Z" stroke="currentColor" stroke-width="1.8"/>
            <path d="M12 15.25A3.25 3.25 0 1 0 12 8.75a3.25 3.25 0 0 0 0 6.5Z" stroke="currentColor" stroke-width="1.8"/>
          </svg>
        </label>
        <label class="settings-backdrop" for="settings-open" aria-hidden="true"></label>
        <div class="settings-menu" id="settings-menu">
          <button class="settings-option" type="button" data-theme="light">Light theme</button>
          <button class="settings-option" type="button" data-theme="dark">Dark theme</button>
        </div>
      </div>
    </header>

    <main class="content-wrap">
      <div class="content" id="content">
        <div class="message-assistant assistant-intro">
          This browser UI keeps the board as plain text, renders merged statistics as an HTML table, and streams backend logs and progress in real time.
        </div>
        <div class="message-assistant">
          The composer below now works like the original CLI: answer each prompt in order, then use SAN moves, \`c\` to export CSV, \`u\` to refresh user games, or send an empty input to go back one move.
        </div>
      </div>
    </main>

    <section class="composer">
      <div class="composer-inner">
        <form class="composer-form" id="composer-form">
          <input
            class="composer-input"
            id="composer-input"
            type="text"
            name="message"
            placeholder="Loading prompt..."
            autocomplete="off"
          />
          <button class="composer-button" id="send-button" type="submit">Send</button>
        </form>
      </div>
    </section>
  </div>

  <script>
    window.__APP_BOOTSTRAP__ = ${bootstrapJson};
  </script>
  <script>
    (function () {
      const bootstrap = window.__APP_BOOTSTRAP__ || {};
      const content = document.getElementById('content');
      const composerForm = document.getElementById('composer-form');
      const composerInput = document.getElementById('composer-input');
      const sendButton = document.getElementById('send-button');
      const settingsToggle = document.getElementById('settings-open');
      const settingsButton = document.querySelector('.settings-button');
      const settingsMenu = document.getElementById('settings-menu');
      const themeLight = document.getElementById('theme-light');
      const themeDark = document.getElementById('theme-dark');
      const themeButtons = document.querySelectorAll('[data-theme]');

      const state = {
        phase: null,
        lichessUser: typeof bootstrap.lichessUser === 'string' ? bootstrap.lichessUser : '',
        chessComUser: typeof bootstrap.chessComUser === 'string' ? bootstrap.chessComUser : '',
        initialPosition: '',
        side: 'white',
        timeFilter: '',
        history: [],
        preferDownloadedUserGames: true,
        activeJobId: null,
        latestJobId: null,
        latestResult: null,
        eventSource: null,
        nextPhaseOnError: null,
      };

      function closeMenu() {
        settingsToggle.checked = false;
      }

      themeButtons.forEach(function (button) {
        button.addEventListener('click', function () {
          const theme = button.getAttribute('data-theme');
          if (theme === 'dark') {
            themeDark.checked = true;
          } else {
            themeLight.checked = true;
          }
          closeMenu();
        });
      });

      document.addEventListener('click', function (event) {
        const clickedInsideSettings = event.target.closest('.settings');
        if (!clickedInsideSettings) {
          closeMenu();
        }
      });

      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
          closeMenu();
        }
      });

      settingsMenu.addEventListener('click', function (event) {
        event.stopPropagation();
      });

      settingsButton.addEventListener('click', function (event) {
        event.stopPropagation();
      });

      function scrollToLatest() {
        window.requestAnimationFrame(function () {
          window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        });
      }

      function focusComposer() {
        window.requestAnimationFrame(function () {
          composerInput.focus();
        });
      }

      function setBusy(isBusy) {
        const disabled = Boolean(isBusy);
        composerInput.disabled = disabled;
        sendButton.disabled = disabled;
        if (disabled) {
          composerInput.placeholder = 'Waiting for backend...';
        } else {
          updatePromptPlaceholder();
          focusComposer();
        }
      }

      function appendUserMessage(text) {
        const node = document.createElement('div');
        node.className = 'message-user';
        node.textContent = text === '' ? ' ' : text;
        content.appendChild(node);
        scrollToLatest();
      }

      function appendAssistantNote(text, isError) {
        const node = document.createElement('div');
        node.className = 'message-assistant';
        node.textContent = text;
        if (isError) {
          node.style.color = 'var(--danger)';
        }
        content.appendChild(node);
        scrollToLatest();
      }

      function stripAnsi(text) {
        return String(text || '').replace(/\\u001b\\[[0-9;]*m/g, '');
      }

      function normalizeTerminalText(text) {
        return stripAnsi(text).replace(/\\r/g, '');
      }

      const LICHESS_CP_TO_WIN_PROBABILITY_K = 0.00368208;

      function formatPercentValue(value) {
        const formatted = value.toFixed(1);
        return formatted === '100.0' ? '100' : formatted;
      }

      function formatPercent(part, total) {
        if (!total || total <= 0) {
          return '--.-';
        }
        return formatPercentValue((part / total) * 100);
      }

      function formatEvalCell(evalValue) {
        if (!evalValue) {
          return {
            main: 'nan',
            sub: 'WW --.-%',
          };
        }

        if (typeof evalValue.cp === 'number') {
          const depthSuffix = typeof evalValue.depth === 'number' ? '/' + String(evalValue.depth) : '';
          const winChancePercent = (1 / (1 + Math.exp(-LICHESS_CP_TO_WIN_PROBABILITY_K * evalValue.cp))) * 100;
          return {
            main: (evalValue.cp / 100).toFixed(2) + depthSuffix,
            sub: 'WW ' + winChancePercent.toFixed(1) + '%',
          };
        }

        if (typeof evalValue.mate === 'number') {
          const mateDepthSuffix = typeof evalValue.depth === 'number' ? '/' + String(evalValue.depth) : '';
          return {
            main: 'M' + String(evalValue.mate) + mateDepthSuffix,
            sub: 'WW --.-%',
          };
        }

        return {
          main: 'nan',
          sub: 'WW --.-%',
        };
      }

      function statsScoreRate(stats) {
        if (!stats || stats.total <= 0) {
          return null;
        }
        return (stats.white + stats.draws / 2) / stats.total;
      }

      function evalWhiteWinRate(evalValue) {
        if (!evalValue || typeof evalValue.cp !== 'number') {
          return null;
        }
        return 1 / (1 + Math.exp(-LICHESS_CP_TO_WIN_PROBABILITY_K * evalValue.cp));
      }

      function combineUserStatsForRow(row) {
        const lichessUser = row && row.lichessUser ? row.lichessUser : null;
        const chessComUser = row && row.chessComUser ? row.chessComUser : null;
        const combinedTotal = (lichessUser ? lichessUser.total : 0) + (chessComUser ? chessComUser.total : 0);
        if (combinedTotal <= 0) {
          return null;
        }

        return {
          san: row.san,
          total: combinedTotal,
          white: (lichessUser ? lichessUser.white : 0) + (chessComUser ? chessComUser.white : 0),
          draws: (lichessUser ? lichessUser.draws : 0) + (chessComUser ? chessComUser.draws : 0),
          black: (lichessUser ? lichessUser.black : 0) + (chessComUser ? chessComUser.black : 0),
        };
      }

      function calculateMovePotential(row, sourceTotals) {
        const lichessUser = row && row.lichessUser ? row.lichessUser : null;
        const chessComUser = row && row.chessComUser ? row.chessComUser : null;
        const lichessDb = row && row.lichessDb ? row.lichessDb : null;
        const moveCombinedTotal = (lichessUser ? lichessUser.total : 0) + (chessComUser ? chessComUser.total : 0);
        const actualScoreRate =
          moveCombinedTotal > 0
            ? (
                (lichessUser ? lichessUser.white : 0) +
                (lichessUser ? lichessUser.draws : 0) / 2 +
                (chessComUser ? chessComUser.white : 0) +
                (chessComUser ? chessComUser.draws : 0) / 2
              ) / moveCombinedTotal
            : 0;
        const dbGames = lichessDb ? lichessDb.total : 0;
        const dbScoreRate = statsScoreRate(lichessDb);
        const evalScoreRate = evalWhiteWinRate(row ? row.eval : null);
        const baseScoreRate = dbGames >= 20 ? dbScoreRate : (evalScoreRate !== null ? evalScoreRate : dbScoreRate);
        const allUserGames = sourceTotals.lichessUser + sourceTotals.chessComUser;
        const moveShare = allUserGames > 0 ? moveCombinedTotal / allUserGames : 0;
        const potential = (actualScoreRate - (baseScoreRate !== null ? baseScoreRate : 0)) * moveShare * 10000;
        return Math.abs(potential) < 0.05 ? 0 : potential;
      }

      function formatMoveCount(total, abbreviateThousands) {
        if (!abbreviateThousands) {
          return String(total);
        }
        return String(Math.floor(total / 1000)) + 'k';
      }

      function createTextCell(tagName, text, className) {
        const cell = document.createElement(tagName);
        if (className) {
          cell.className = className;
        }
        cell.textContent = text;
        return cell;
      }

      function createStatsSourceCell(stats, columnTotal, abbreviateThousands) {
        const cell = document.createElement('td');
        if (!stats || stats.total <= 0) {
          cell.className = 'is-mono';
          cell.textContent = '--';
          return cell;
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'stats-cell';

        const main = document.createElement('div');
        main.className = 'stats-cell-main';
        main.textContent = formatMoveCount(stats.total, abbreviateThousands) + ' / ' + formatPercent(stats.total, columnTotal) + '%';

        const split = document.createElement('div');
        split.className = 'stats-cell-sub';
        split.textContent =
          'W/D/L ' +
          formatPercent(stats.white, stats.total) +
          ' / ' +
          formatPercent(stats.draws, stats.total) +
          ' / ' +
          formatPercent(stats.black, stats.total);

        const score = document.createElement('div');
        score.className = 'stats-cell-sub';
        score.textContent = 'Score ' + formatPercent(stats.white + stats.draws / 2, stats.total);

        wrapper.appendChild(main);
        wrapper.appendChild(split);
        wrapper.appendChild(score);
        cell.appendChild(wrapper);
        return cell;
      }

      function createMergedStatsTable(rows) {
        const wrapper = document.createElement('div');
        wrapper.className = 'stats-table-wrap';

        const table = document.createElement('table');
        table.className = 'stats-table';

        const colgroup = document.createElement('colgroup');
        ['col-move', 'col-eval', '', '', 'col-user', '', 'col-pot'].forEach(function (className) {
          const col = document.createElement('col');
          if (className) {
            col.className = className;
          }
          colgroup.appendChild(col);
        });
        table.appendChild(colgroup);

        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        const headers = [
          { label: 'mv.', className: 'col-move' },
          { label: 'Eval', className: 'is-num col-eval' },
          { label: 'Lichess user', className: '' },
          { label: 'Chess.com user', className: '' },
          { label: 'User', className: 'is-num col-user' },
          { label: 'Lichess DB', className: '' },
          { label: 'Pot.', className: 'is-num col-pot' },
        ];

        headers.forEach(function (header) {
          headRow.appendChild(createTextCell('th', header.label, header.className));
        });
        thead.appendChild(headRow);

        const tbody = document.createElement('tbody');
        const safeRows = Array.isArray(rows) ? rows : [];
        const lichessUserTotal = safeRows.reduce(function (sum, row) {
          return sum + (row && row.lichessUser ? row.lichessUser.total : 0);
        }, 0);
        const chessComTotal = safeRows.reduce(function (sum, row) {
          return sum + (row && row.chessComUser ? row.chessComUser.total : 0);
        }, 0);
        const lichessDbTotal = safeRows.reduce(function (sum, row) {
          return sum + (row && row.lichessDb ? row.lichessDb.total : 0);
        }, 0);
        const lichessDbTopTotal = safeRows.length > 0 && safeRows[0] && safeRows[0].lichessDb ? safeRows[0].lichessDb.total : 0;
        const useThousandsForLichessDb = lichessDbTopTotal >= 1000000;
        const sourceTotals = {
          lichessUser: lichessUserTotal,
          chessComUser: chessComTotal,
        };

        if (safeRows.length === 0) {
          const emptyRow = document.createElement('tr');
          const emptyCell = createTextCell('td', 'No moves found.', 'stats-table-empty');
          emptyCell.colSpan = 7;
          emptyRow.appendChild(emptyCell);
          tbody.appendChild(emptyRow);
        }

        safeRows.forEach(function (row) {
          const tr = document.createElement('tr');
          const evalCell = formatEvalCell(row.eval);
          const evalTd = document.createElement('td');
          evalTd.className = 'is-num is-mono col-eval';

          const evalMain = document.createElement('div');
          evalMain.className = 'stats-cell-main';
          evalMain.textContent = evalCell.main;

          const evalSub = document.createElement('div');
          evalSub.className = 'stats-cell-sub';
          evalSub.textContent = evalCell.sub;

          evalTd.appendChild(evalMain);
          evalTd.appendChild(evalSub);

          const userStats = combineUserStatsForRow(row);
          const userScoreText = userStats ? formatPercent(userStats.white + userStats.draws / 2, userStats.total) : '--.-';
          const potValue = calculateMovePotential(row, sourceTotals);
          const potClassName = potValue > 0 ? 'is-num is-mono pot-positive' : (potValue < 0 ? 'is-num is-mono pot-negative' : 'is-num is-mono');

          tr.appendChild(createTextCell('td', row.san, 'is-mono col-move'));
          tr.appendChild(evalTd);
          tr.appendChild(createStatsSourceCell(row.lichessUser, lichessUserTotal, false));
          tr.appendChild(createStatsSourceCell(row.chessComUser, chessComTotal, false));
          tr.appendChild(createTextCell('td', userScoreText, 'is-num is-mono col-user'));
          tr.appendChild(createStatsSourceCell(row.lichessDb, lichessDbTotal, useThousandsForLichessDb));
          tr.appendChild(createTextCell('td', potValue.toFixed(1), potClassName + ' col-pot'));
          tbody.appendChild(tr);
        });

        table.appendChild(thead);
        table.appendChild(tbody);
        wrapper.appendChild(table);
        return wrapper;
      }

      function createAssistantCycle(options) {
        const root = document.createElement('div');
        root.className = 'message-assistant assistant-cycle';
        const showCompletionState = Boolean(options && options.showCompletionState);

        const meta = document.createElement('div');
        meta.className = 'assistant-meta';

        const title = document.createElement('div');
        title.className = 'assistant-meta-title';
        title.textContent = 'Running evaluation';

        const status = document.createElement('div');
        status.className = 'assistant-meta-status';
        status.textContent = 'Waiting for backend...';

        const progress = document.createElement('div');
        progress.className = 'progress-list';
        progress.hidden = true;
        progress._items = new Map();

        const logs = document.createElement('div');
        logs.className = 'log-card';
        logs.hidden = true;

        const logsLabel = document.createElement('div');
        logsLabel.className = 'section-label';
        logsLabel.textContent = 'Logs';

        const logLines = document.createElement('pre');
        logLines.className = 'log-lines';

        logs.appendChild(logsLabel);
        logs.appendChild(logLines);

        const results = document.createElement('div');
        results.className = 'result-card';
        results.hidden = true;

        meta.appendChild(title);
        meta.appendChild(status);
        if (showCompletionState) {
          root.appendChild(meta);
        }
        root.appendChild(logs);
        root.appendChild(results);
        content.appendChild(root);
        scrollToLatest();

        return {
          root: root,
          meta: meta,
          title: title,
          status: status,
          progress: progress,
          logLines: logLines,
          logs: logs,
          results: results,
          showCompletionState: showCompletionState,
          progressMounted: false,
        };
      }

      function updatePromptPlaceholder() {
        switch (state.phase) {
          case 'lichessUser':
            composerInput.placeholder = 'Lichess username';
            break;
          case 'chessComUser':
            composerInput.placeholder = 'Chess.com username';
            break;
          case 'initialPosition':
            composerInput.placeholder = 'FEN, SAN moves, or leave blank for the starting position';
            break;
          case 'side':
            composerInput.placeholder = 'white/black or w/b';
            break;
          case 'timeFilter':
            composerInput.placeholder = 'ISO date/time, YYYY-MM, YYYY, or blank for all-time';
            break;
          case 'action':
            composerInput.placeholder = 'SAN move, c, u, or send empty input to go back';
            break;
          default:
            composerInput.placeholder = 'Type a message...';
            break;
        }
      }

      function setPhase(phase) {
        state.phase = phase;
        updatePromptPlaceholder();
      }

      function promptCurrentPhase() {
        updatePromptPlaceholder();

        if (state.phase === 'lichessUser') {
          appendAssistantNote('Lichess username:');
        } else if (state.phase === 'chessComUser') {
          appendAssistantNote('Chess.com username:');
        } else if (state.phase === 'initialPosition') {
          appendAssistantNote('FEN (or SAN moves from start):');
        } else if (state.phase === 'side') {
          appendAssistantNote('Side (white/black or w/b):');
        } else if (state.phase === 'timeFilter') {
          appendAssistantNote('Time filter (ISO date/time, YYYY-MM, YYYY; Enter for all):');
        } else if (state.phase === 'action') {
          appendAssistantNote('Move (SAN), c to export CSV, u to download games, or send empty input to go back:');
        }

        focusComposer();
      }

      function setActionPhase() {
        setPhase('action');
        promptCurrentPhase();
      }

      function determineInitialPhase() {
        if (!state.lichessUser) {
          return 'lichessUser';
        }
        if (!state.chessComUser) {
          return 'chessComUser';
        }
        return 'initialPosition';
      }

      function parseSide(value) {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'white' || normalized === 'w') {
          return 'white';
        }
        if (normalized === 'black' || normalized === 'b') {
          return 'black';
        }
        return null;
      }

      function renderProgressItem(cycle, update) {
        const container = cycle.progress;
        if (!cycle.progressMounted) {
          cycle.root.insertBefore(container, cycle.logs);
          cycle.progressMounted = true;
        }
        let item = container._items.get(update.key);
        if (!item) {
          const root = document.createElement('div');
          root.className = 'progress-item';

          const header = document.createElement('div');
          header.className = 'progress-header';

          const label = document.createElement('strong');
          const value = document.createElement('span');
          const bar = document.createElement('progress');

          header.appendChild(label);
          header.appendChild(value);
          root.appendChild(header);
          root.appendChild(bar);
          container.appendChild(root);

          item = { label: label, value: value, bar: bar };
          container._items.set(update.key, item);
        }

        const total = Math.max(0, Number(update.total) || 0);
        const current = Math.max(0, Number(update.current) || 0);
        const normalizedMax = Math.max(1, total);
        const normalizedValue = update.done ? normalizedMax : Math.min(current, normalizedMax);

        item.label.textContent = update.label;
        item.value.textContent = total > 0 ? String(current) + ' / ' + String(total) : (update.done ? 'done' : String(current));
        item.bar.max = normalizedMax;
        item.bar.value = normalizedValue;
        container.hidden = false;
      }

      function appendLogLine(cycle, message) {
        cycle.logs.hidden = false;
        const normalizedMessage = normalizeTerminalText(message);
        const renderedMessage = normalizedMessage === '' ? ' ' : normalizedMessage;
        cycle.logLines.appendChild(
          document.createTextNode((cycle.logLines.textContent ? '\\n' : '') + renderedMessage),
        );
        cycle.logLines.scrollTop = cycle.logLines.scrollHeight;
        scrollToLatest();
      }

      function renderResult(cycle, result) {
        cycle.results.hidden = false;
        cycle.results.innerHTML = '';
        if (cycle.progressMounted && (!cycle.progress._items || cycle.progress._items.size === 0)) {
          cycle.progress.remove();
          cycle.progressMounted = false;
        }

        const fenLabel = document.createElement('div');
        fenLabel.className = 'section-label';
        fenLabel.textContent = 'FEN';

        const fenLine = document.createElement('div');
        fenLine.className = 'fen-line';
        fenLine.textContent = result.fen;

        const boardLabel = document.createElement('div');
        boardLabel.className = 'section-label';
        boardLabel.textContent = 'Board';

        const boardPre = document.createElement('pre');
        boardPre.className = 'mono-output is-board';
        boardPre.textContent = normalizeTerminalText(result.boardText);

        const tableLabel = document.createElement('div');
        tableLabel.className = 'section-label';
        tableLabel.textContent = 'Merged Statistics';

        const tableView = createMergedStatsTable(result.rows);

        cycle.results.appendChild(fenLabel);
        cycle.results.appendChild(fenLine);
        cycle.results.appendChild(boardLabel);
        cycle.results.appendChild(boardPre);
        cycle.results.appendChild(tableLabel);
        cycle.results.appendChild(tableView);

        if (cycle.showCompletionState) {
          cycle.title.textContent = 'Evaluation complete';
          cycle.status.textContent = 'Board rendered from backend text; statistics rendered as an HTML table.';
        }

        state.history = Array.isArray(result.history) ? result.history.slice() : [];
        state.preferDownloadedUserGames = Boolean(result.userGamesPrimed);
        state.latestResult = result;
      }

      async function postJson(url, body) {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        let payload = null;
        try {
          payload = await response.json();
        } catch (error) {
          payload = null;
        }

        if (!response.ok) {
          const message = payload && payload.error ? payload.error : 'Request failed.';
          throw new Error(message);
        }

        return payload;
      }

      function handleJobEvent(jobId, cycle, event) {
        if (!event || typeof event !== 'object') {
          return;
        }

        if (event.type === 'log') {
          appendLogLine(cycle, event.message || '');
          return;
        }

        if (event.type === 'progress') {
          renderProgressItem(cycle, event);
          cycle.status.textContent = 'Receiving progress updates...';
          return;
        }

        if (event.type === 'result') {
          state.latestJobId = jobId;
          renderResult(cycle, event);
          state.phase = 'action';
          return;
        }

        if (event.type === 'error') {
          cycle.title.textContent = 'Evaluation failed';
          cycle.status.textContent = event.message || 'Unknown error.';
          appendLogLine(cycle, 'Error: ' + (event.message || 'Unknown error.'));
          return;
        }

        if (event.type === 'done') {
          if (!cycle.showCompletionState) {
            if (cycle.progressMounted && (!cycle.progress._items || cycle.progress._items.size === 0)) {
              cycle.progress.remove();
              cycle.progressMounted = false;
            }
          }
          cycle.status.textContent = state.latestJobId === jobId ? 'Done.' : cycle.status.textContent;
          closeEventSource();
          state.activeJobId = null;
          setBusy(false);
          if (state.phase === 'action') {
            promptCurrentPhase();
          } else if (state.nextPhaseOnError) {
            setPhase(state.nextPhaseOnError);
            promptCurrentPhase();
          }
          state.nextPhaseOnError = null;
        }
      }

      function closeEventSource() {
        if (state.eventSource) {
          state.eventSource.close();
          state.eventSource = null;
        }
      }

      function openJobStream(jobId, cycle) {
        closeEventSource();
        const source = new EventSource('/api/jobs/' + encodeURIComponent(jobId) + '/events');
        state.eventSource = source;

        source.onmessage = function (messageEvent) {
          let payload;
          try {
            payload = JSON.parse(messageEvent.data);
          } catch (error) {
            return;
          }
          handleJobEvent(jobId, cycle, payload);
        };

        source.onerror = function () {
          cycle.status.textContent = 'Connection lost while waiting for updates.';
          closeEventSource();
          state.activeJobId = null;
          setBusy(false);
          if (state.phase) {
            promptCurrentPhase();
          }
        };
      }

      async function startEvaluation(options) {
        if (state.activeJobId) {
          return;
        }

        const request = {
          lichessUser: state.lichessUser,
          chessComUser: state.chessComUser,
          initialPosition: state.initialPosition,
          history: Array.isArray(options.historyOverride) ? options.historyOverride.slice() : state.history.slice(),
          side: state.side,
          timeFilter: state.timeFilter,
          forceRefreshUserGames: Boolean(options.forceRefresh),
          preferDownloadedUserGames: Boolean(state.preferDownloadedUserGames),
        };

        appendUserMessage(options.bubbleText);
        const cycle = createAssistantCycle({
          showCompletionState: Boolean(options.forceRefresh),
        });

        try {
          setBusy(true);
          state.nextPhaseOnError = options.onErrorPhase || state.phase;
          cycle.status.textContent = 'Creating backend job...';
          const payload = await postJson('/api/evaluate', request);
          state.activeJobId = payload.jobId;
          composerInput.value = '';
          openJobStream(payload.jobId, cycle);
        } catch (error) {
          cycle.title.textContent = 'Request failed';
          cycle.status.textContent = error instanceof Error ? error.message : String(error);
          state.activeJobId = null;
          setBusy(false);
          promptCurrentPhase();
        }
      }

      composerForm.addEventListener('submit', function (event) {
        event.preventDefault();
        if (state.activeJobId) {
          return;
        }

        const value = composerInput.value;
        const trimmed = value.trim();

        if (state.phase === 'lichessUser') {
          appendUserMessage(trimmed);
          if (trimmed === '') {
            appendAssistantNote('Lichess username is required.', true);
            promptCurrentPhase();
            return;
          }
          state.lichessUser = trimmed;
          composerInput.value = '';
          setPhase('chessComUser');
          promptCurrentPhase();
          return;
        }

        if (state.phase === 'chessComUser') {
          appendUserMessage(trimmed);
          if (trimmed === '') {
            appendAssistantNote('Chess.com username is required.', true);
            promptCurrentPhase();
            return;
          }
          state.chessComUser = trimmed;
          composerInput.value = '';
          setPhase('initialPosition');
          promptCurrentPhase();
          return;
        }

        if (state.phase === 'initialPosition') {
          appendUserMessage(value);
          state.initialPosition = value;
          state.history = [];
          state.preferDownloadedUserGames = true;
          state.latestJobId = null;
          state.latestResult = null;
          composerInput.value = '';
          setPhase('side');
          promptCurrentPhase();
          return;
        }

        if (state.phase === 'side') {
          appendUserMessage(trimmed);
          const parsedSide = parseSide(trimmed);
          if (!parsedSide) {
            appendAssistantNote('Side must be white/black or w/b.', true);
            promptCurrentPhase();
            return;
          }
          state.side = parsedSide;
          composerInput.value = '';
          setPhase('timeFilter');
          promptCurrentPhase();
          return;
        }

        if (state.phase === 'timeFilter') {
          state.timeFilter = value;
          startEvaluation({
            forceRefresh: false,
            bubbleText: value,
            onErrorPhase: 'timeFilter',
          });
          return;
        }

        if (state.phase === 'action') {
          const normalized = trimmed.toLowerCase();

          if (normalized === 'c') {
            appendUserMessage(trimmed);
            composerInput.value = '';
            if (!state.latestJobId) {
              appendAssistantNote('Run an evaluation before exporting CSV.', true);
              promptCurrentPhase();
              return;
            }

            postJson('/api/export', { jobId: state.latestJobId })
              .then(function (payload) {
                appendAssistantNote('CSV exported: ' + payload.path);
                promptCurrentPhase();
              })
              .catch(function (error) {
                appendAssistantNote(error instanceof Error ? error.message : String(error), true);
                promptCurrentPhase();
              });
            return;
          }

          if (normalized === 'u') {
            startEvaluation({
              historyOverride: state.history.slice(),
              forceRefresh: true,
              bubbleText: trimmed,
              onErrorPhase: 'action',
            });
            return;
          }

          if (trimmed === '') {
            if (state.history.length === 0) {
              appendUserMessage(value);
              appendAssistantNote('No history yet.');
              promptCurrentPhase();
              composerInput.value = '';
              return;
            }

            startEvaluation({
              historyOverride: state.history.slice(0, -1),
              forceRefresh: false,
              bubbleText: value,
              onErrorPhase: 'action',
            });
            return;
          }

          startEvaluation({
            historyOverride: state.history.concat([trimmed]),
            forceRefresh: false,
            bubbleText: trimmed,
            onErrorPhase: 'action',
          });
        }
      });

      setBusy(false);
      composerInput.value = '';

      if (state.lichessUser) {
        appendAssistantNote('Using Lichess username from environment: ' + state.lichessUser);
      }
      if (state.chessComUser) {
        appendAssistantNote('Using Chess.com username from environment: ' + state.chessComUser);
      }

      setPhase(determineInitialPhase());
      promptCurrentPhase();
    })();
  </script>
</body>
</html>`;
}
