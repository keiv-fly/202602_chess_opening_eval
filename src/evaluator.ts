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
  if (!evalValue) return '  nan';
  if (evalValue.cp !== undefined) return `${(evalValue.cp / 100).toFixed(2).padStart(5, ' ')}`;
  if (evalValue.mate !== undefined) return `M${String(evalValue.mate).padStart(4, ' ')}`;
  return '  nan';
}

function statsToString(stats: MoveStats | undefined, width: number): string {
  if (!stats || stats.total === 0) return `${''.padStart(width, ' ')} --.-/--.-/--.-`;
  const percentToString = (value: number): string => {
    const formatted = value.toFixed(1);
    return (formatted === '100.0' ? '100' : formatted).padStart(4, ' ');
  };
  const ww = percentToString((stats.white / stats.total) * 100);
  const dd = percentToString((stats.draws / stats.total) * 100);
  const bb = percentToString((stats.black / stats.total) * 100);
  return `${String(stats.total).padStart(width, ' ')} ${ww}/${dd}/${bb}`;
}

export function renderStatsTable(rows: CombinedMoveRow[]): string {
  const maxLichessUser = Math.max(0, ...rows.map((r) => r.lichessUser?.total ?? 0));
  const maxChessCom = Math.max(0, ...rows.map((r) => r.chessComUser?.total ?? 0));
  const maxLichessDb = Math.max(0, ...rows.map((r) => r.lichessDb?.total ?? 0));

  const luWidth = String(maxLichessUser).length;
  const ccWidth = String(maxChessCom).length;
  const dbWidth = String(maxLichessDb).length;

  const table = new Table({
    head: ['Move (SAN)', 'Eval', 'Lichess user', 'Chess.com user', 'Lichess DB'],
    wordWrap: true,
  });

  for (const row of rows) {
    table.push([
      row.san,
      evalToString(row.eval),
      statsToString(row.lichessUser, luWidth),
      statsToString(row.chessComUser, ccWidth),
      statsToString(row.lichessDb, dbWidth),
    ]);
  }

  return table.toString();
}
