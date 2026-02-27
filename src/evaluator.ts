import Table from 'cli-table3';
import type { CombinedMoveRow, MoveEval, MoveStats } from './types.js';

export function mergeStats(
  lichessUser: MoveStats[],
  chessComUser: MoveStats[],
  lichessDb: Array<MoveStats & { eval?: MoveEval }>,
): CombinedMoveRow[] {
  const sanSet = new Set<string>();
  for (const m of lichessUser) sanSet.add(m.san);
  for (const m of chessComUser) sanSet.add(m.san);
  for (const m of lichessDb) sanSet.add(m.san);

  const luMap = new Map(lichessUser.map((m) => [m.san, m]));
  const ccMap = new Map(chessComUser.map((m) => [m.san, m]));
  const dbMap = new Map(lichessDb.map((m) => [m.san, m]));

  const rows: CombinedMoveRow[] = [...sanSet].map((san) => ({
    san,
    lichessUser: luMap.get(san),
    chessComUser: ccMap.get(san),
    lichessDb: dbMap.get(san),
    eval: dbMap.get(san)?.eval,
  }));

  rows.sort((a, b) => {
    const aPrimary = a.lichessUser?.total ?? 0;
    const bPrimary = b.lichessUser?.total ?? 0;
    if (aPrimary !== bPrimary) return bPrimary - aPrimary;

    const aFallback = a.lichessDb?.total ?? 0;
    const bFallback = b.lichessDb?.total ?? 0;
    if (aFallback !== bFallback) return bFallback - aFallback;

    return a.san.localeCompare(b.san);
  });

  return rows;
}

function evalToString(evalValue?: MoveEval): string {
  if (!evalValue) return 'nan';
  const depthSuffix = evalValue.depth !== undefined ? `/${evalValue.depth}` : '';
  if (evalValue.cp !== undefined) return `${(evalValue.cp / 100).toFixed(2)}${depthSuffix}`;
  if (evalValue.mate !== undefined) return `M${evalValue.mate}${depthSuffix}`;
  return `nan${depthSuffix}`;
}

function formatMoveCount(total: number, abbreviateThousands: boolean): string {
  if (!abbreviateThousands) {
    return String(total);
  }
  return `${Math.floor(total / 1000)}k`;
}

function statsToString(
  stats: MoveStats | undefined,
  width: number,
  columnTotal: number,
  abbreviateThousands: boolean,
): string {
  if (!stats || stats.total === 0) return `${''.padStart(width, ' ')}/--% --.-/--.-/--.-`;

  const sharePercent = columnTotal > 0 ? Math.round((stats.total / columnTotal) * 100) : null;
  const share =
    sharePercent === null ? '--%' : `${sharePercent >= 100 ? '100' : String(sharePercent).padStart(2, ' ')}%`;

  const percentToString = (value: number): string => {
    const formatted = value.toFixed(1);
    return (formatted === '100.0' ? '100' : formatted).padStart(4, ' ');
  };
  const ww = percentToString((stats.white / stats.total) * 100);
  const dd = percentToString((stats.draws / stats.total) * 100);
  const bb = percentToString((stats.black / stats.total) * 100);
  return `${formatMoveCount(stats.total, abbreviateThousands).padStart(width, ' ')}/${share} ${ww}/${dd}/${bb}`;
}

export function renderStatsTable(rows: CombinedMoveRow[]): string {
  const maxLichessUser = Math.max(0, ...rows.map((r) => r.lichessUser?.total ?? 0));
  const maxChessCom = Math.max(0, ...rows.map((r) => r.chessComUser?.total ?? 0));
  const useThousandsForLichessDb = (rows[0]?.lichessDb?.total ?? 0) >= 1_000_000;

  const luWidth = formatMoveCount(maxLichessUser, false).length;
  const ccWidth = formatMoveCount(maxChessCom, false).length;
  const dbWidth = Math.max(
    1,
    ...rows.map((row) => formatMoveCount(row.lichessDb?.total ?? 0, useThousandsForLichessDb).length),
  );
  const lichessUserTotal = rows.reduce((sum, row) => sum + (row.lichessUser?.total ?? 0), 0);
  const chessComTotal = rows.reduce((sum, row) => sum + (row.chessComUser?.total ?? 0), 0);
  const lichessDbTotal = rows.reduce((sum, row) => sum + (row.lichessDb?.total ?? 0), 0);

  const evalStrings = rows.map((row) => evalToString(row.eval));
  const evalWidth = Math.max(3, ...evalStrings.map((value) => value.length));

  const table = new Table({
    head: ['Move (SAN)', 'Eval', 'Lichess user', 'Chess.com user', 'Lichess DB'],
    colAligns: ['left', 'right', 'left', 'left', 'left'],
    wordWrap: true,
  });

  for (const [index, row] of rows.entries()) {
    table.push([
      row.san,
      evalStrings[index].padStart(evalWidth, ' '),
      statsToString(row.lichessUser, luWidth, lichessUserTotal, false),
      statsToString(row.chessComUser, ccWidth, chessComTotal, false),
      statsToString(row.lichessDb, dbWidth, lichessDbTotal, useThousandsForLichessDb),
    ]);
  }

  return table.toString();
}
