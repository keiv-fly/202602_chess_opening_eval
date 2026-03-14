import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { listCards, saveCardForPosition } from '../src/cards.js';
import { STARTING_FEN } from '../src/workflow.js';

async function withTempRoot(run: (rootDir: string) => Promise<void>): Promise<void> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'chess-opening-cards-'));
  try {
    await run(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

describe('saveCardForPosition', () => {
  it('creates the cards database and stores the normalized position with the move uci', async () => {
    await withTempRoot(async (rootDir) => {
      const savedCard = await saveCardForPosition(STARTING_FEN, 'e4', {
        rootDir,
        localUser: 'tester',
      });

      expect(savedCard).toMatchObject({
        fen: STARTING_FEN,
        user: 'tester',
        moveSan: 'e4',
        moveUci: 'e2e4',
        status: 'new',
      });
      expect(savedCard.zobr64).toMatch(/^[0-9a-f]{16}$/u);

      const databasePath = path.join(rootDir, 'cards_db', 'cards.sqlite');
      expect(existsSync(databasePath)).toBe(true);

      const database = new Database(databasePath);
      try {
        const row = database
          .prepare('SELECT fen, zobr64, user, move_uci, status, mov_avg_x, prompt_text, reveal_text FROM cards')
          .get() as {
          fen: string;
          zobr64: string;
          user: string;
          move_uci: string;
          status: string;
          mov_avg_x: number;
          prompt_text: string | null;
          reveal_text: string | null;
        };

        expect(row).toEqual({
          fen: STARTING_FEN,
          zobr64: savedCard.zobr64,
          user: 'tester',
          move_uci: 'e2e4',
          status: 'new',
          mov_avg_x: 1.2,
          prompt_text: null,
          reveal_text: null,
        });
      } finally {
        database.close();
      }
    });
  });

  it('rejects duplicate cards for the same user and position', async () => {
    await withTempRoot(async (rootDir) => {
      await saveCardForPosition(STARTING_FEN, 'e4', {
        rootDir,
        localUser: 'tester',
      });

      await expect(
        saveCardForPosition(STARTING_FEN, 'd4', {
          rootDir,
          localUser: 'tester',
        }),
      ).rejects.toThrow('Card already exists for user "tester" at this position.');
    });
  });
});

describe('listCards', () => {
  it('returns saved cards for the requested user with mov_avg_x exposed as movAvgX', async () => {
    await withTempRoot(async (rootDir) => {
      const savedCard = await saveCardForPosition(STARTING_FEN, 'e4', {
        rootDir,
        localUser: 'tester',
      });

      const databasePath = path.join(rootDir, 'cards_db', 'cards.sqlite');
      const database = new Database(databasePath);
      try {
        database
          .prepare(
            `
              UPDATE cards
              SET mov_avg_x = ?, status = ?, updated_at = '2026-03-14 12:00:00'
              WHERE user = ? AND fen = ?
            `,
          )
          .run(2.75, 'learning', 'tester', STARTING_FEN);
      } finally {
        database.close();
      }

      const cards = await listCards({
        rootDir,
        localUser: 'tester',
      });

      expect(cards).toEqual([
        {
          fen: STARTING_FEN,
          zobr64: savedCard.zobr64,
          user: 'tester',
          moveUci: 'e2e4',
          status: 'learning',
          movAvgX: 2.75,
          createdAt: expect.any(String),
          updatedAt: '2026-03-14 12:00:00',
        },
      ]);
    });
  });
});
