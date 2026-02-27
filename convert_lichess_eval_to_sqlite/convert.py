#!/usr/bin/env python3
"""
Convert lichess_db_eval.jsonl.zst into an SQLite DB with:
- fen
- best_move  (first move token from the chosen PV "line")
- cp
- mate
- depth

Selection policy (per Lichess notes):
- Choose the eval entry with the highest "depth"
- Use its first PV (pvs[0])
- cp/mate may be missing (omitted in source JSON)

Usage:
  python convert.py \
    --input lichess_db_eval.jsonl.zst \
    --output lichess_db_eval.sqlite \
    --batch 50000

Requires:
  pip install zstandard tqdm
"""

from __future__ import annotations

import argparse
import importlib
import io
import json
import os
import sqlite3
import sys
from typing import Any, Dict, Iterable, List, Optional, Tuple

try:
    import zstandard as zstd
except ImportError as e:
    print("Missing dependency: zstandard")
    print("Install with: pip install zstandard")
    raise

# Optional speedup. Falls back to stdlib json if unavailable.
try:
    _orjson = importlib.import_module("orjson")
    json_loads = _orjson.loads
    JsonDecodeError = _orjson.JSONDecodeError
except ImportError:
    json_loads = json.loads
    JsonDecodeError = json.JSONDecodeError

try:
    from tqdm import tqdm
except ImportError as e:
    print("Missing dependency: tqdm")
    print("Install with: pip install tqdm")
    raise


SchemaRow = Tuple[str, str, Optional[int], Optional[int], int]


def choose_best_record(obj: Dict[str, Any]) -> Optional[SchemaRow]:
    """
    Given one JSON object (one line), extract:
      fen, best_move, cp, mate, depth

    Returns None if required fields are missing or malformed.
    """
    fen = obj.get("fen")
    evals = obj.get("evals")
    if not isinstance(fen, str) or not isinstance(evals, list) or not evals:
        return None

    # Choose eval with max depth (depth is expected to be numeric; tolerate strings)
    best_eval = None
    best_depth = None

    for ev in evals:
        if not isinstance(ev, dict):
            continue
        d = ev.get("depth")
        try:
            depth_val = int(d)
        except (TypeError, ValueError):
            continue

        if best_depth is None or depth_val > best_depth:
            best_depth = depth_val
            best_eval = ev

    if best_eval is None or best_depth is None:
        return None

    pvs = best_eval.get("pvs")
    if not isinstance(pvs, list) or not pvs:
        return None
    pv0 = pvs[0]
    if not isinstance(pv0, dict):
        return None

    line = pv0.get("line")
    if not isinstance(line, str) or not line.strip():
        return None

    # "best move" = first token of the PV line (UCI / UCI_Chess960 move)
    best_move = line.split()[0]

    # cp / mate are optional and may be omitted (not None) in the source JSON
    cp = pv0.get("cp")
    mate = pv0.get("mate")

    cp_i: Optional[int]
    mate_i: Optional[int]

    try:
        cp_i = None if cp is None else int(cp)
    except (TypeError, ValueError):
        cp_i = None

    try:
        mate_i = None if mate is None else int(mate)
    except (TypeError, ValueError):
        mate_i = None

    return (fen, best_move, cp_i, mate_i, int(best_depth))


def iter_jsonl_zst(
    path: str,
    progress: Optional[Any] = None,
    progress_update_every_lines: int = 5000,
) -> Iterable[Dict[str, Any]]:
    """
    Stream-decompress a .zst JSONL file and yield JSON objects line by line.
    """
    with open(path, "rb") as fh:
        last_progress_pos = 0
        total_bytes = os.path.getsize(path)

        dctx = zstd.ZstdDecompressor(max_window_size=2**31)
        with dctx.stream_reader(fh) as reader:
            text_stream = io.TextIOWrapper(reader, encoding="utf-8", newline="")
            lines_since_progress = 0
            for line_num, line in enumerate(text_stream, start=1):
                if progress is not None:
                    lines_since_progress += 1
                    if lines_since_progress >= progress_update_every_lines:
                        cur_pos = fh.tell()
                        if cur_pos > last_progress_pos:
                            progress.update(cur_pos - last_progress_pos)
                            last_progress_pos = cur_pos
                        lines_since_progress = 0

                line = line.strip()
                if not line:
                    continue
                try:
                    yield json_loads(line)
                except JsonDecodeError as e:
                    # Skip malformed lines but keep going
                    sys.stderr.write(f"[warn] JSON decode error at line {line_num}: {e}\n")
                    continue

            # Make sure progress reaches 100% for cleanly-read files.
            if progress is not None and last_progress_pos < total_bytes:
                progress.update(total_bytes - last_progress_pos)


def init_db(conn: sqlite3.Connection, fast_unsafe: bool = False) -> None:
    cur = conn.cursor()

    # Speed pragmas for import.
    if fast_unsafe:
        # Faster bulk-load mode. If interrupted, output DB may be corrupted.
        cur.execute("PRAGMA journal_mode=OFF;")
        cur.execute("PRAGMA synchronous=OFF;")
        cur.execute("PRAGMA locking_mode=EXCLUSIVE;")
        cur.execute("PRAGMA cache_size=-200000;")
    else:
        cur.execute("PRAGMA journal_mode=WAL;")
        cur.execute("PRAGMA synchronous=NORMAL;")
    cur.execute("PRAGMA temp_store=MEMORY;")

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS evals (
            fen TEXT NOT NULL PRIMARY KEY,
            best_move TEXT NOT NULL,
            cp INTEGER NULL,
            mate INTEGER NULL,
            depth INTEGER NOT NULL
        ) WITHOUT ROWID;
        """
    )

    conn.commit()


def upsert_batch(conn: sqlite3.Connection, rows: List[SchemaRow]) -> None:
    """
    Insert rows; if fen already exists, keep the one with greater depth.
    """
    cur = conn.cursor()
    cur.executemany(
        """
        INSERT INTO evals (fen, best_move, cp, mate, depth)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(fen) DO UPDATE SET
            best_move=excluded.best_move,
            cp=excluded.cp,
            mate=excluded.mate,
            depth=excluded.depth
        WHERE excluded.depth > evals.depth;
        """,
        rows,
    )
    conn.commit()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="Path to lichess_db_eval.jsonl.zst")
    ap.add_argument("--output", required=True, help="Output SQLite file path")
    ap.add_argument("--batch", type=int, default=100000, help="Rows per transaction (default: 100000)")
    ap.add_argument(
        "--fast-unsafe",
        action="store_true",
        help="Use faster, crash-unsafe SQLite pragmas for bulk import",
    )
    ap.add_argument(
        "--no-progress",
        action="store_true",
        help="Disable progress bar to reduce console overhead",
    )
    ap.add_argument(
        "--progress-lines",
        type=int,
        default=5000,
        help="Update progress every N lines (default: 5000)",
    )
    args = ap.parse_args()

    in_path = args.input
    out_path = args.output
    batch_size = max(1, args.batch)
    progress_every = max(1, args.progress_lines)

    if not os.path.exists(in_path):
        print(f"Input file not found: {in_path}", file=sys.stderr)
        return 2

    conn = sqlite3.connect(out_path)
    try:
        init_db(conn, fast_unsafe=args.fast_unsafe)

        buf: List[SchemaRow] = []
        total_in = 0
        total_out = 0

        if args.no_progress:
            for obj in iter_jsonl_zst(in_path, progress=None):
                total_in += 1
                row = choose_best_record(obj)
                if row is None:
                    continue
                buf.append(row)

                if len(buf) >= batch_size:
                    upsert_batch(conn, buf)
                    total_out += len(buf)
                    buf.clear()

            if buf:
                upsert_batch(conn, buf)
                total_out += len(buf)
        else:
            total_bytes = os.path.getsize(in_path)
            with tqdm(
                total=total_bytes,
                desc="Reading .zst",
                unit="B",
                unit_scale=True,
                unit_divisor=1024,
            ) as progress:
                for obj in iter_jsonl_zst(
                    in_path,
                    progress=progress,
                    progress_update_every_lines=progress_every,
                ):
                    total_in += 1
                    row = choose_best_record(obj)
                    if row is None:
                        continue
                    buf.append(row)

                    if len(buf) >= batch_size:
                        upsert_batch(conn, buf)
                        total_out += len(buf)
                        buf.clear()

                if buf:
                    upsert_batch(conn, buf)
                    total_out += len(buf)

        print(f"Inserted/updated ~{total_out} rows (processed {total_in} lines).", file=sys.stderr)

        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())