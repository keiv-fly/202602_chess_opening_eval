# rust_read_rocksdb_eval

Native `napi-rs` addon that reads `lichess_eval_rocksdb` and exposes async Node.js APIs.

## Build

```bash
npm install
npm run build
```

## Test

```bash
npm test
```

## TypeScript usage

```ts
import { init, queryFens, close } from './rust_read_rocksdb_eval/service.js';

await init(); // uses <repo_root>/lichess_eval_rocksdb by default
const rows = await queryFens([
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'this is not a fen',
]);
console.log(rows);
await close();
```

Each row includes:

- `fen`
- `eval`
- `mate`
- `depth`
- `first_move`
- `error` (per-item error text or `null`)
