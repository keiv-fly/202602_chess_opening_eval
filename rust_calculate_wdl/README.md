# rust_calculate_wdl

Native `napi-rs` addon that calculates move-level W/D/L stats from `data_uci` files.

## Build

```bash
npm install
npm run build
```

## Usage

```ts
import { calculateMoveStats } from './rust_calculate_wdl/service.js';

const rows = await calculateMoveStats({
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  filePaths: [
    'C:/repo/data_in/lichess_player/me/data_uci/white/2024-01.txt',
    'C:/repo/data_in/chess_com_player/me/data_uci/white/2024-02.txt',
  ],
});
console.log(rows);
```
