use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use napi::Error as NapiError;
use napi_derive::napi;
use once_cell::sync::Lazy;
use rocksdb::{DB, Options};
use serde::Deserialize;
use shakmaty::zobrist::{Zobrist64, ZobristHash};
use shakmaty::{fen::Fen, CastlingMode, Chess, EnPassantMode};

const DEFAULT_ROCKSDB_DIR: &str = "/lichess_eval_rocksdb";
const ENTRY_SIZE: usize = 39;
const BOARD34_SIZE: usize = 34;

#[derive(Debug)]
struct DbState {
  db: DB,
  path: PathBuf,
}

static DB_SINGLETON: Lazy<Mutex<Option<DbState>>> = Lazy::new(|| Mutex::new(None));

#[napi(object)]
pub struct InitOptions {
  #[napi(js_name = "dbPath")]
  pub db_path: Option<String>,
}

#[napi(object)]
pub struct QueryRow {
  pub fen: String,
  pub eval: Option<i32>,
  pub mate: Option<i32>,
  pub depth: Option<i32>,
  #[napi(js_name = "first_move")]
  pub first_move: Option<String>,
  pub error: Option<String>,
}

#[derive(Debug, Clone)]
struct DecodedEntry {
  fen: String,
  eval: Option<i32>,
  mate: Option<i32>,
  depth: i32,
  first_move: Option<String>,
}

#[napi(js_name = "init")]
pub fn init(options: Option<InitOptions>) -> napi::Result<()> {
  let cwd = std::env::current_dir().context("failed to read current working directory");
  let cwd = cwd.map_err(napi_err)?;
  let db_dir_raw = options
    .and_then(|opt| opt.db_path)
    .unwrap_or_else(|| DEFAULT_ROCKSDB_DIR.to_string());
  let rocksdb_dir = resolve_user_path(&cwd, &db_dir_raw);

  let mut db_opts = Options::default();
  db_opts.create_if_missing(false);
  let db = DB::open_for_read_only(&db_opts, &rocksdb_dir, false)
    .with_context(|| format!("failed to open rocksdb {}", rocksdb_dir.display()))
    .map_err(napi_err)?;

  let mut lock = DB_SINGLETON
    .lock()
    .map_err(|_| NapiError::from_reason("failed to lock singleton state"))?;
  *lock = Some(DbState {
    db,
    path: rocksdb_dir,
  });

  Ok(())
}

#[napi(js_name = "close")]
pub fn close() -> napi::Result<()> {
  let mut lock = DB_SINGLETON
    .lock()
    .map_err(|_| NapiError::from_reason("failed to lock singleton state"))?;
  *lock = None;
  Ok(())
}

#[napi(js_name = "isInitialized")]
pub fn is_initialized() -> napi::Result<bool> {
  let lock = DB_SINGLETON
    .lock()
    .map_err(|_| NapiError::from_reason("failed to lock singleton state"))?;
  Ok(lock.is_some())
}

#[napi(js_name = "currentDbPath")]
pub fn current_db_path() -> napi::Result<Option<String>> {
  let lock = DB_SINGLETON
    .lock()
    .map_err(|_| NapiError::from_reason("failed to lock singleton state"))?;
  Ok(lock
    .as_ref()
    .map(|state| state.path.to_string_lossy().to_string()))
}

#[napi(js_name = "queryFens")]
pub async fn query_fens(fens: Vec<String>) -> napi::Result<Vec<QueryRow>> {
  if fens.is_empty() {
    return Ok(Vec::new());
  }

  let lock = DB_SINGLETON
    .lock()
    .map_err(|_| NapiError::from_reason("failed to lock singleton state"))?;
  let state = lock
    .as_ref()
    .ok_or_else(|| NapiError::from_reason("rocksdb is not initialized; call init() first"))?;

  Ok(run_query_batch(&state.db, &fens))
}

fn run_query_batch(db: &DB, fens: &[String]) -> Vec<QueryRow> {
  let mut rows = fens.iter().map(|fen| empty_row(fen)).collect::<Vec<_>>();

  let mut valid_indexes: Vec<usize> = Vec::new();
  let mut valid_keys: Vec<u64> = Vec::new();

  for (index, fen) in fens.iter().enumerate() {
    match zobrist64_from_fen(fen) {
      Ok(key) => {
        valid_indexes.push(index);
        valid_keys.push(key);
      }
      Err(error) => {
        rows[index].error = Some(format!("{error:#}"));
      }
    }
  }

  if valid_indexes.is_empty() {
    return rows;
  }

  let values = db.multi_get(valid_keys.iter().map(|key| key.to_be_bytes()));
  if values.len() != valid_indexes.len() {
    let message = format!(
      "multi_get returned {} values for {} input fens",
      values.len(),
      valid_indexes.len()
    );
    for row_index in valid_indexes {
      rows[row_index].error = Some(message.clone());
    }
    return rows;
  }

  for (value_index, value_result) in values.into_iter().enumerate() {
    let row_index = valid_indexes[value_index];
    let fen = &fens[row_index];

    let row = match value_result {
      Err(error) => QueryRow {
        error: Some(format!("rocksdb multi_get failed: {error}")),
        ..empty_row(fen)
      },
      Ok(None) => empty_row(fen),
      Ok(Some(raw)) => match decode_rocks_value(raw.as_ref()) {
        Err(error) => QueryRow {
          error: Some(format!("{error:#}")),
          ..empty_row(fen)
        },
        Ok(decoded) => match select_best_entry_for_fen(&decoded, fen) {
          Some(best) => QueryRow {
            fen: fen.clone(),
            eval: best.eval,
            mate: best.mate,
            depth: Some(best.depth),
            first_move: best.first_move.clone(),
            error: None,
          },
          None => empty_row(fen),
        },
      },
    };

    rows[row_index] = row;
  }

  rows
}

fn empty_row(fen: &str) -> QueryRow {
  QueryRow {
    fen: fen.to_string(),
    eval: None,
    mate: None,
    depth: None,
    first_move: None,
    error: None,
  }
}

fn select_best_entry_for_fen<'a>(entries: &'a [DecodedEntry], fen: &str) -> Option<&'a DecodedEntry> {
  entries
    .iter()
    .filter(|entry| entry.fen == fen)
    .max_by_key(|entry| entry.depth)
}

fn zobrist64_from_fen(fen: &str) -> Result<u64> {
  let setup: Fen = fen
    .parse()
    .with_context(|| format!("invalid fen syntax: {fen}"))?;
  let position: Chess = setup
    .into_position(CastlingMode::Standard)
    .with_context(|| format!("invalid fen position: {fen}"))?;
  let hash: Zobrist64 = position.zobrist_hash(EnPassantMode::Legal);
  Ok(hash.0)
}

fn decode_rocks_value(raw: &[u8]) -> Result<Vec<DecodedEntry>> {
  if raw.is_empty() {
    bail!("empty rocksdb value");
  }

  let count = raw[0] as usize;
  if count > 0 && 1 + count * ENTRY_SIZE == raw.len() {
    return decode_binary_entries(raw);
  }

  decode_legacy_json_entry(raw)
}

fn decode_binary_entries(raw: &[u8]) -> Result<Vec<DecodedEntry>> {
  let count = raw[0] as usize;
  if count == 0 {
    bail!("invalid binary rocksdb value with count=0");
  }
  if raw.len() != 1 + count * ENTRY_SIZE {
    bail!(
      "invalid binary rocksdb value length: expected {}, got {}",
      1 + count * ENTRY_SIZE,
      raw.len()
    );
  }

  let mut out = Vec::with_capacity(count);
  for index in 0..count {
    let base = 1 + index * ENTRY_SIZE;
    let score = i16::from_le_bytes([raw[base], raw[base + 1]]) as i32;
    let depth = i32::from(raw[base + 2]);
    let move_meta = u16::from_le_bytes([raw[base + 3], raw[base + 4]]);
    let board = &raw[base + 5..base + 5 + BOARD34_SIZE];
    let fen = board34_to_fen(board)?;

    let kind = (move_meta >> 15) & 0x01;
    let first_move = decode_move_meta_to_uci(move_meta)?;
    let (eval, mate) = if kind == 0 {
      (Some(score), None)
    } else {
      (None, Some(score))
    };

    out.push(DecodedEntry {
      fen,
      eval,
      mate,
      depth,
      first_move,
    });
  }
  Ok(out)
}

#[derive(Debug, Deserialize)]
struct LegacyJsonValue {
  eval: Option<i32>,
  mate: Option<i32>,
  depth: i32,
  fen: String,
  first_move: Option<String>,
  r#move: Option<String>,
}

fn decode_legacy_json_entry(raw: &[u8]) -> Result<Vec<DecodedEntry>> {
  let parsed: LegacyJsonValue =
    serde_json::from_slice(raw).context("failed parsing legacy json value")?;
  Ok(vec![DecodedEntry {
    fen: parsed.fen,
    eval: parsed.eval,
    mate: parsed.mate,
    depth: parsed.depth,
    first_move: parsed.first_move.or(parsed.r#move),
  }])
}

fn decode_move_meta_to_uci(move_meta: u16) -> Result<Option<String>> {
  let from = (move_meta & 0x3F) as u8;
  let to = ((move_meta >> 6) & 0x3F) as u8;
  let promo = ((move_meta >> 12) & 0x07) as u8;

  if from == 0 && to == 0 && promo == 0 {
    return Ok(None);
  }

  let promo_char = match promo {
    0 => "",
    1 => "n",
    2 => "b",
    3 => "r",
    4 => "q",
    other => bail!("unsupported promotion code {other}"),
  };

  Ok(Some(format!(
    "{}{}{}",
    square_to_coord(from)?,
    square_to_coord(to)?,
    promo_char
  )))
}

fn square_to_coord(idx: u8) -> Result<String> {
  if idx >= 64 {
    bail!("square index out of bounds: {idx}");
  }
  let file = (idx % 8) + b'a';
  let rank = (idx / 8) + 1;
  Ok(format!("{}{}", file as char, rank))
}

fn board34_to_fen(board: &[u8]) -> Result<String> {
  if board.len() != BOARD34_SIZE {
    bail!(
      "invalid board34 length: expected {}, got {}",
      BOARD34_SIZE,
      board.len()
    );
  }

  let mut squares = [0u8; 64];
  for index in 0..32 {
    let byte = board[index];
    squares[2 * index] = byte & 0x0F;
    squares[2 * index + 1] = (byte >> 4) & 0x0F;
  }

  let mut board_part = String::new();
  for rank in (0..8).rev() {
    let mut empty = 0usize;
    for file in 0..8 {
      let idx = rank * 8 + file;
      let piece = piece_code_to_char(squares[idx])?;
      if let Some(ch) = piece {
        if empty > 0 {
          board_part.push_str(&empty.to_string());
          empty = 0;
        }
        board_part.push(ch);
      } else {
        empty += 1;
      }
    }
    if empty > 0 {
      board_part.push_str(&empty.to_string());
    }
    if rank > 0 {
      board_part.push('/');
    }
  }

  let state = board[32];
  let side = if (state & (1 << 0)) != 0 { "b" } else { "w" };
  let mut castling = String::new();
  if (state & (1 << 1)) != 0 {
    castling.push('K');
  }
  if (state & (1 << 2)) != 0 {
    castling.push('Q');
  }
  if (state & (1 << 3)) != 0 {
    castling.push('k');
  }
  if (state & (1 << 4)) != 0 {
    castling.push('q');
  }
  if castling.is_empty() {
    castling.push('-');
  }

  let ep = if board[33] == u8::MAX {
    "-".to_string()
  } else {
    square_to_coord(board[33])?
  };

  Ok(format!("{board_part} {side} {castling} {ep}"))
}

fn piece_code_to_char(code: u8) -> Result<Option<char>> {
  let out = match code {
    0 => None,
    1 => Some('P'),
    2 => Some('N'),
    3 => Some('B'),
    4 => Some('R'),
    5 => Some('Q'),
    6 => Some('K'),
    7 => Some('p'),
    8 => Some('n'),
    9 => Some('b'),
    10 => Some('r'),
    11 => Some('q'),
    12 => Some('k'),
    other => bail!("invalid board34 piece code {other}"),
  };
  Ok(out)
}

fn resolve_user_path(cwd: &Path, user_path: &str) -> PathBuf {
  if cfg!(windows) && (user_path.starts_with('/') || user_path.starts_with('\\')) {
    return cwd.join(user_path.trim_start_matches(['/', '\\']));
  }

  let path = PathBuf::from(user_path);
  if path.is_absolute() {
    return path;
  }
  cwd.join(path)
}

fn napi_err(error: anyhow::Error) -> NapiError {
  NapiError::from_reason(format!("{error:#}"))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::PathBuf;

  fn pack_board34(squares: &[u8; 64], state: u8, ep: u8) -> [u8; BOARD34_SIZE] {
    let mut board = [0u8; BOARD34_SIZE];
    for index in 0..32 {
      board[index] = (squares[2 * index] & 0x0F) | ((squares[2 * index + 1] & 0x0F) << 4);
    }
    board[32] = state;
    board[33] = ep;
    board
  }

  #[test]
  fn decode_move_meta_to_uci_basic_move() {
    let from = 12u16; // e2
    let to = 28u16; // e4
    let move_meta = from | (to << 6);
    let uci = decode_move_meta_to_uci(move_meta).unwrap();
    assert_eq!(uci.as_deref(), Some("e2e4"));
  }

  #[test]
  fn board34_to_fen_kings_only() {
    let mut squares = [0u8; 64];
    squares[4] = 6; // white king e1
    squares[60] = 12; // black king e8
    let board = pack_board34(&squares, 0, u8::MAX);
    let fen = board34_to_fen(&board).unwrap();
    assert_eq!(fen, "4k3/8/8/8/8/8/8/4K3 w - -");
  }

  #[test]
  fn decode_legacy_json_row() {
    let raw = br#"{"eval":42,"depth":31,"fen":"x","first_move":"e2e4"}"#;
    let rows = decode_legacy_json_entry(raw).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].fen, "x");
    assert_eq!(rows[0].eval, Some(42));
    assert_eq!(rows[0].mate, None);
    assert_eq!(rows[0].depth, 31);
    assert_eq!(rows[0].first_move.as_deref(), Some("e2e4"));
  }

  #[test]
  fn selects_highest_depth_for_exact_fen_match() {
    let entries = vec![
      DecodedEntry {
        fen: "fen_a".to_string(),
        eval: Some(12),
        mate: None,
        depth: 18,
        first_move: Some("e2e4".to_string()),
      },
      DecodedEntry {
        fen: "fen_a".to_string(),
        eval: Some(22),
        mate: None,
        depth: 21,
        first_move: Some("d2d4".to_string()),
      },
      DecodedEntry {
        fen: "fen_b".to_string(),
        eval: Some(30),
        mate: None,
        depth: 99,
        first_move: None,
      },
    ];
    let best = select_best_entry_for_fen(&entries, "fen_a").unwrap();
    assert_eq!(best.depth, 21);
    assert_eq!(best.first_move.as_deref(), Some("d2d4"));
  }

  #[test]
  fn resolve_user_path_joins_relative_path() {
    let cwd = PathBuf::from("C:/repo");
    let resolved = resolve_user_path(&cwd, "lichess_eval_rocksdb");
    assert!(resolved.ends_with(PathBuf::from("C:/repo/lichess_eval_rocksdb")));
  }
}
