import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { close, currentDbPath, getDefaultDbPath, init, isInitialized, queryFens } from '../service.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const INVALID_FEN = 'this is not a fen';
const repoDbPath = resolve(process.cwd(), '..', 'lichess_eval_rocksdb');

afterEach(async () => {
  await close();
});

describe('rust_read_rocksdb_eval addon', () => {
  it('exports a fixed default db path in repo root', () => {
    expect(getDefaultDbPath()).toBe(resolve(process.cwd(), '..', 'lichess_eval_rocksdb'));
  });

  it('returns per-item errors for invalid fens and keeps row shape', async () => {
    if (!existsSync(repoDbPath)) {
      return;
    }

    await init({ dbPath: repoDbPath });
    const rows = await queryFens([START_FEN, INVALID_FEN]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      fen: START_FEN,
    });
    expect(rows[0]).toHaveProperty('eval');
    expect(rows[0]).toHaveProperty('mate');
    expect(rows[0]).toHaveProperty('depth');
    expect(rows[0]).toHaveProperty('first_move');
    expect(rows[0]).toHaveProperty('error');

    expect(rows[1]).toMatchObject({
      fen: INVALID_FEN,
      eval: null,
      mate: null,
      depth: null,
      first_move: null,
    });
    expect(typeof rows[1].error).toBe('string');
    expect(rows[1].error?.toLowerCase()).toContain('invalid fen');
  });

  it('requires init before querying and supports re-init', async () => {
    await close();
    await expect(queryFens([START_FEN])).rejects.toThrow(/not initialized/i);

    if (!existsSync(repoDbPath)) {
      return;
    }

    await init({ dbPath: repoDbPath });
    expect(await isInitialized()).toBe(true);
    expect(await currentDbPath()).toBe(repoDbPath);
    const rows = await queryFens([START_FEN]);
    expect(rows).toHaveLength(1);
  });
});
