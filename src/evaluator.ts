import Table from 'cli-table3';
import type { CombinedMoveRow, MoveEval, MoveStats, Side } from './types.js';

export type CsvExportContext = {
  fen: string;
  side: Side;
};

const SOURCE_SUFFIXES = [
  'total',
  'share_percent',
  'white_count',
  'draw_count',
  'black_count',
  'white_percent',
  'draw_percent',
  'black_percent',
] as const;
const SOURCE_PREFIXES = ['source_lichess_user', 'source_chesscom_user', 'source_lichess_db'] as const;
const LICHESS_CP_TO_WIN_PROBABILITY_K = 0.00368208;
const CSV_COLUMNS = [
  'position_fen',
  'position_side_to_move',
  'move_rank',
  'move_san',
  'move_eval_cp',
  'move_eval_mate',
  'move_eval_depth',
  ...SOURCE_PREFIXES.flatMap((prefix) => SOURCE_SUFFIXES.map((suffix) => `${prefix}_${suffix}`)),
] as const;

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
  if (!evalValue) return 'nan|--.-';
  const depthSuffix = evalValue.depth !== undefined ? `/${evalValue.depth}` : '';
  if (evalValue.cp !== undefined) {
    const whiteWinChancePercent =
      (1 / (1 + Math.exp(-LICHESS_CP_TO_WIN_PROBABILITY_K * evalValue.cp))) * 100;
    return `${(evalValue.cp / 100).toFixed(2)}${depthSuffix}|${whiteWinChancePercent.toFixed(1)}`;
  }
  if (evalValue.mate !== undefined) return `M${evalValue.mate}${depthSuffix}|--.-`;
  return `nan${depthSuffix}|--.-`;
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
  if (!stats || stats.total === 0) return `${''.padStart(width, ' ')}/--% --.-/--.-/--.-|--.-`;

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
  const score = ((((stats.white / stats.total) * 100) + ((stats.draws / stats.total) * 100) / 2)).toFixed(1);
  return `${formatMoveCount(stats.total, abbreviateThousands).padStart(width, ' ')}/${share} ${ww}/${dd}/${bb}|${score}`;
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
    head: ['Move', 'Eval', 'Lichess user', 'Chess.com user', 'Lichess DB'],
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

function toOneDecimal(value: number): number {
  return Number(value.toFixed(1));
}

function toPercent(part: number, total: number): number | undefined {
  if (total <= 0) return undefined;
  return toOneDecimal((part / total) * 100);
}

function addSourceColumns(
  record: Record<string, string | number>,
  prefix: (typeof SOURCE_PREFIXES)[number],
  stats: MoveStats | undefined,
  sourceTotal: number,
): void {
  if (!stats || stats.total <= 0) {
    for (const suffix of SOURCE_SUFFIXES) {
      record[`${prefix}_${suffix}`] = '';
    }
    return;
  }

  record[`${prefix}_total`] = stats.total;
  record[`${prefix}_share_percent`] = toPercent(stats.total, sourceTotal) ?? '';
  record[`${prefix}_white_count`] = stats.white;
  record[`${prefix}_draw_count`] = stats.draws;
  record[`${prefix}_black_count`] = stats.black;
  record[`${prefix}_white_percent`] = toPercent(stats.white, stats.total) ?? '';
  record[`${prefix}_draw_percent`] = toPercent(stats.draws, stats.total) ?? '';
  record[`${prefix}_black_percent`] = toPercent(stats.black, stats.total) ?? '';
}

function csvEscape(value: string | number): string {
  const asString = String(value);
  if (!/[,"\n\r]/.test(asString)) {
    return asString;
  }
  return `"${asString.replaceAll('"', '""')}"`;
}

export function renderStatsCsv(rows: CombinedMoveRow[], context: CsvExportContext): string {
  const sourceTotals = {
    lichessUser: rows.reduce((sum, row) => sum + (row.lichessUser?.total ?? 0), 0),
    chessComUser: rows.reduce((sum, row) => sum + (row.chessComUser?.total ?? 0), 0),
    lichessDb: rows.reduce((sum, row) => sum + (row.lichessDb?.total ?? 0), 0),
  };

  const bodyLines = rows.map((row, index) => {
    const record: Record<string, string | number> = {
      position_fen: context.fen,
      position_side_to_move: context.side,
      move_rank: index + 1,
      move_san: row.san,
      move_eval_cp: row.eval?.cp ?? '',
      move_eval_mate: row.eval?.mate ?? '',
      move_eval_depth: row.eval?.depth ?? '',
    };

    addSourceColumns(record, 'source_lichess_user', row.lichessUser, sourceTotals.lichessUser);
    addSourceColumns(record, 'source_chesscom_user', row.chessComUser, sourceTotals.chessComUser);
    addSourceColumns(record, 'source_lichess_db', row.lichessDb, sourceTotals.lichessDb);

    return CSV_COLUMNS.map((column) => csvEscape(record[column] ?? '')).join(',');
  });

  return [CSV_COLUMNS.join(','), ...bodyLines].join('\n');
}
