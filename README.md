# Chess Opening Eval CLI

Interactive TypeScript CLI that evaluates a chess position by combining:
- Lichess user move stats
- Chess.com user move stats
- Lichess opening database stats and cloud evaluation (shown as `score/depth`, e.g. `0.30/25`)

For Lichess user data, the CLI stores monthly NDJSON files in `data_in/lichess_player/<user>/data/` and computes per-position move stats from those local files.
Lichess opening-database responses are cached by FEN in `data_in/lichess_database/fen/<encoded-fen>`.

The app prints the board, fetches stats, and displays a merged move table. You can then enter SAN moves to continue exploring the position move by move.

## Prerequisites

- Node.js 18+ (required for native `fetch`)
- npm

## Install

From the project root:

```bash
npm install
```

## Configure Users

Create a `.env` file in the project root:

```env
LICHESS_USER=your_lichess_username
CHESSCOM_USER=your_chesscom_username
LICHESS_API_TOKEN=your_lichess_api_token
```

If these are not set, the CLI will ask for the usernames when it starts.
If `LICHESS_API_TOKEN` is set, Lichess API requests are sent with `Authorization: Bearer <token>`.

## Run the Program

Start the interactive CLI:

```bash
npm run start
```

(`npm run dev` runs the same command in this project.)

You will be prompted for:
- Position as either:
  - FEN
  - SAN moves from starting position (for example, `e4 e5 Nf3`); empty input uses starting position
- Side (`white`/`black` or `w`/`b`)

After results are shown, you can:
- Enter a move in SAN notation (for example, `Nf3`)
- Enter `c` to export the currently displayed table to `data_out/YYYYMMDD_HHMMSS.csv`
- Press Enter on an empty prompt to go back one move in history
- Use left arrow and submit to go back one move

## Other Useful Commands

Run tests:

```bash
npm test
```

Build TypeScript:

```bash
npm run build
```
