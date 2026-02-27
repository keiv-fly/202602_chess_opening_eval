import { Chess } from 'chess.js';

const PIECES: Record<string, string> = {
  p: '♟',
  r: '♜',
  n: '♞',
  b: '♝',
  q: '♛',
  k: '♚',
  P: '♙',
  R: '♖',
  N: '♘',
  B: '♗',
  Q: '♕',
  K: '♔',
};

export function renderBoard(fen: string): string {
  const chess = new Chess(fen);
  const board = chess.board();

  const lines: string[] = [];
  for (let rank = 0; rank < 8; rank += 1) {
    const row = board[rank];
    const rankLabel = 8 - rank;
    const pieces = row
      .map((piece) => {
        if (!piece) return '·';
        const key = piece.color === 'w' ? piece.type.toUpperCase() : piece.type;
        return PIECES[key];
      })
      .join(' ');
    lines.push(`${rankLabel} ${pieces}`);
  }
  lines.push('  a b c d e f g h');

  return lines.join('\n');
}
