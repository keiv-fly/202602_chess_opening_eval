import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const native = require('./binding.cjs');

export async function calculateMoveStats(options) {
  const rows = await native.calculateMoveStats(options);
  return rows.map((row) => ({
    san: row.san,
    white: row.white,
    draws: row.draws,
    black: row.black,
    total: row.total,
  }));
}
