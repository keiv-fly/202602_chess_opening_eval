export function normalizeFenWithoutMoveCounters(fen: string): string {
  const normalizedWhitespaceFen = fen.trim().replace(/\s+/g, ' ');
  const [board, side, castling = '-', enPassant = '-'] = normalizedWhitespaceFen.split(' ');
  if (!board || !side) {
    return normalizedWhitespaceFen;
  }
  return `${board} ${side} ${castling} ${enPassant} 0 1`;
}
