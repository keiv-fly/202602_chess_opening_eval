import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const native = require('./binding.cjs');

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultDbPath = resolve(moduleDir, '..', 'lichess_eval_rocksdb');
let exitHooksRegistered = false;

function safeClose() {
  try {
    native.close();
  } catch {
    // Ignore close errors during process shutdown.
  }
}

function registerExitHooks() {
  if (exitHooksRegistered) {
    return;
  }
  exitHooksRegistered = true;

  process.once('beforeExit', safeClose);
  process.once('exit', safeClose);

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      safeClose();
      process.kill(process.pid, signal);
    });
  }
}

export function getDefaultDbPath() {
  return defaultDbPath;
}

export async function init(options = {}) {
  const dbPath = options.dbPath ?? defaultDbPath;
  native.init({ dbPath });
  registerExitHooks();
}

export async function queryFens(fens) {
  const rows = await native.queryFens(fens);
  return rows.map((row) => ({
    fen: row.fen,
    eval: row.eval ?? null,
    mate: row.mate ?? null,
    depth: row.depth ?? null,
    first_move: row.first_move ?? null,
    error: row.error ?? null,
  }));
}

export async function close() {
  native.close();
}

export async function isInitialized() {
  return native.isInitialized();
}

export async function currentDbPath() {
  return native.currentDbPath();
}
