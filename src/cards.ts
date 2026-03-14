import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Chess } from 'chess.js';
import { normalizeFenWithoutMoveCounters } from './fen.js';

const CARDS_DIRECTORY_NAME = 'cards_db';
const CARDS_DATABASE_FILE_NAME = 'cards.sqlite';
const ZOBRIST_MASK_64 = 0xffffffffffffffffn;
const PIECE_INDEX: Record<string, number> = {
  P: 0,
  N: 1,
  B: 2,
  R: 3,
  Q: 4,
  K: 5,
  p: 6,
  n: 7,
  b: 8,
  r: 9,
  q: 10,
  k: 11,
};
const ZOBRIST_SEED = 0x6a09e667f3bcc909n;
let zobristState = ZOBRIST_SEED;

export type SavedCard = {
  fen: string;
  zobr64: string;
  user: string;
  moveSan: string;
  moveUci: string;
  status: 'new';
};

export type SaveCardOptions = {
  rootDir?: string;
  localUser?: string;
  promptText?: string | null;
  revealText?: string | null;
};

const CARDS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY,
    fen TEXT NOT NULL,
    zobr64 TEXT NOT NULL,
    user TEXT NOT NULL,
    move_uci TEXT NOT NULL,
    prompt_text TEXT,
    reveal_text TEXT,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'learning', 'stop')),
    mov_avg_x REAL NOT NULL DEFAULT 1.2,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user, fen)
);

CREATE INDEX IF NOT EXISTS idx_cards_user_zobr64
    ON cards (user, zobr64);
`;

const ZOBRIST_PIECE_SQUARE_KEYS = createZobristKeys(12 * 64);
const ZOBRIST_SIDE_TO_MOVE_KEY = createZobristKeys(1)[0];
const ZOBRIST_CASTLING_KEYS = {
  K: createZobristKeys(1)[0],
  Q: createZobristKeys(1)[0],
  k: createZobristKeys(1)[0],
  q: createZobristKeys(1)[0],
};
const ZOBRIST_EN_PASSANT_FILE_KEYS = createZobristKeys(8);

function createZobristKeys(count: number): bigint[] {
  return Array.from({ length: count }, () => nextZobristKey());
}

function nextZobristKey(): bigint {
  zobristState = (zobristState + 0x9e3779b97f4a7c15n) & ZOBRIST_MASK_64;
  let value = zobristState;
  value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & ZOBRIST_MASK_64;
  value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & ZOBRIST_MASK_64;
  return (value ^ (value >> 31n)) & ZOBRIST_MASK_64;
}

function normalizeCardSan(moveSan: string): string {
  return moveSan.trim().replace(/[!?]+$/u, '');
}

function computeMoveUciFromSan(fen: string, moveSan: string): { moveSan: string; moveUci: string } {
  const chess = new Chess(fen);
  const normalizedMoveSan = normalizeCardSan(moveSan);
  if (normalizedMoveSan === '') {
    throw new Error('Use "s <SAN move>" to save a card.');
  }

  const move = chess.move(normalizedMoveSan, { strict: false });
  if (!move) {
    throw new Error(`Invalid SAN move for this position: ${normalizedMoveSan}`);
  }

  return {
    moveSan: move.san,
    moveUci: `${move.from}${move.to}${move.promotion ?? ''}`,
  };
}

function computeZobrist64(fen: string): string {
  const [board, sideToMove, castling = '-', enPassant = '-'] = normalizeFenWithoutMoveCounters(fen).split(' ');
  let hash = 0n;
  const ranks = board.split('/');

  for (let rank = 0; rank < ranks.length; rank += 1) {
    let file = 0;
    for (const symbol of ranks[rank]) {
      const emptySquares = Number.parseInt(symbol, 10);
      if (!Number.isNaN(emptySquares)) {
        file += emptySquares;
        continue;
      }

      const pieceIndex = PIECE_INDEX[symbol];
      if (pieceIndex === undefined) {
        throw new Error(`Unsupported piece in FEN while computing Zobrist hash: ${symbol}`);
      }

      const squareIndex = rank * 8 + file;
      hash ^= ZOBRIST_PIECE_SQUARE_KEYS[pieceIndex * 64 + squareIndex];
      file += 1;
    }
  }

  if (sideToMove === 'b') {
    hash ^= ZOBRIST_SIDE_TO_MOVE_KEY;
  }

  for (const symbol of castling) {
    if (symbol in ZOBRIST_CASTLING_KEYS) {
      hash ^= ZOBRIST_CASTLING_KEYS[symbol as keyof typeof ZOBRIST_CASTLING_KEYS];
    }
  }

  if (enPassant !== '-' && /^[a-h][36]$/u.test(enPassant)) {
    hash ^= ZOBRIST_EN_PASSANT_FILE_KEYS[enPassant.charCodeAt(0) - 97];
  }

  return hash.toString(16).padStart(16, '0');
}

async function openCardsDatabase(rootDir: string) {
  const cardsDirectory = path.join(rootDir, CARDS_DIRECTORY_NAME);
  const databasePath = path.join(cardsDirectory, CARDS_DATABASE_FILE_NAME);
  await mkdir(cardsDirectory, { recursive: true });

  const database = new Database(databasePath);
  database.exec(CARDS_SCHEMA_SQL);
  return { database, databasePath };
}

export async function saveCardForPosition(fen: string, moveSan: string, options: SaveCardOptions = {}): Promise<SavedCard> {
  const user = (options.localUser ?? process.env.LOCAL_USER ?? '').trim();
  if (user === '') {
    throw new Error('LOCAL_USER is required to save cards.');
  }

  const normalizedFen = normalizeFenWithoutMoveCounters(fen);
  const resolvedMove = computeMoveUciFromSan(normalizedFen, moveSan);
  const zobr64 = computeZobrist64(normalizedFen);
  const { database } = await openCardsDatabase(options.rootDir ?? process.cwd());

  try {
    const statement = database.prepare(`
      INSERT INTO cards (fen, zobr64, user, move_uci, prompt_text, reveal_text)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    statement.run(
      normalizedFen,
      zobr64,
      user,
      resolvedMove.moveUci,
      options.promptText ?? null,
      options.revealText ?? null,
    );

    return {
      fen: normalizedFen,
      zobr64,
      user,
      moveSan: resolvedMove.moveSan,
      moveUci: resolvedMove.moveUci,
      status: 'new',
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: cards.user, cards.fen')) {
      throw new Error(`Card already exists for user "${user}" at this position.`);
    }
    throw error;
  } finally {
    database.close();
  }
}
