use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};

use anyhow::{Context, Result};
use napi::Error as NapiError;
use napi_derive::napi;
use shakmaty::fen::Fen;
use shakmaty::san::San;
use shakmaty::uci::UciMove;
use shakmaty::zobrist::{Zobrist64, ZobristHash};
use shakmaty::{CastlingMode, Chess, EnPassantMode, Position};

#[napi(object)]
pub struct CalculateOptions {
  pub fen: String,
  #[napi(js_name = "filePaths")]
  pub file_paths: Vec<String>,
}

#[napi(object)]
pub struct MoveStatsRow {
  pub san: String,
  pub white: i32,
  pub draws: i32,
  pub black: i32,
  pub total: i32,
}

#[derive(Debug, Default, Clone, Copy)]
struct MoveCounts {
  white: u32,
  draws: u32,
  black: u32,
}

#[napi(js_name = "calculateMoveStats")]
pub fn calculate_move_stats(options: CalculateOptions) -> napi::Result<Vec<MoveStatsRow>> {
  run_calculate(options).map_err(napi_err)
}

fn run_calculate(options: CalculateOptions) -> Result<Vec<MoveStatsRow>> {
  if options.file_paths.is_empty() {
    return Ok(Vec::new());
  }

  let Some(target_hash) = target_fen_hash(&options.fen) else {
    return Ok(Vec::new());
  };

  let mut map = HashMap::<String, MoveCounts>::new();
  for file_path in options.file_paths {
    process_uci_file(&file_path, target_hash, &mut map)?;
  }

  let mut rows = map
    .into_iter()
    .map(|(san, counts)| {
      let total = counts.white + counts.draws + counts.black;
      MoveStatsRow {
        san,
        white: to_i32_saturated(counts.white),
        draws: to_i32_saturated(counts.draws),
        black: to_i32_saturated(counts.black),
        total: to_i32_saturated(total),
      }
    })
    .collect::<Vec<_>>();

  rows.sort_by(|a, b| b.total.cmp(&a.total).then_with(|| a.san.cmp(&b.san)));
  Ok(rows)
}

fn process_uci_file(
  file_path: &str,
  target_hash: u64,
  map: &mut HashMap<String, MoveCounts>,
) -> Result<()> {
  let file = File::open(file_path).with_context(|| format!("failed to open data_uci file {file_path}"))?;
  let reader = BufReader::new(file);

  for line_result in reader.lines() {
    let raw_line = line_result.with_context(|| format!("failed reading line from {file_path}"))?;
    let line = raw_line.trim();
    if line.is_empty() {
      continue;
    }

    let Some(separator_index) = line.find('|') else {
      continue;
    };
    if separator_index == 0 {
      continue;
    }

    let result_token = line[..separator_index].trim();
    let result = match result_token {
      "w" => 'w',
      "d" => 'd',
      "l" => 'l',
      _ => continue,
    };

    let moves_text = line[separator_index + 1..].trim();
    let uci_moves = if moves_text.is_empty() {
      Vec::new()
    } else {
      moves_text.split_whitespace().collect::<Vec<_>>()
    };

    add_move_stat_from_uci_line(map, result, &uci_moves, target_hash);
  }

  Ok(())
}

fn add_move_stat_from_uci_line(
  map: &mut HashMap<String, MoveCounts>,
  result: char,
  uci_moves: &[&str],
  target_hash: u64,
) {
  let mut replay = Chess::default();

  for uci_text in uci_moves {
    let current_hash: Zobrist64 = replay.zobrist_hash(EnPassantMode::Legal);
    if current_hash.0 == target_hash {
      let Some(next_move) = parse_uci_move_for_position(&replay, uci_text) else {
        return;
      };
      let san = San::from_move(&replay, next_move).to_string();
      let entry = map.entry(san).or_default();
      match result {
        'w' => entry.white += 1,
        'd' => entry.draws += 1,
        'l' => entry.black += 1,
        _ => return,
      }
      return;
    }

    let Some(next_move) = parse_uci_move_for_position(&replay, uci_text) else {
      return;
    };
    replay.play_unchecked(next_move);
  }
}

fn parse_uci_move_for_position(position: &Chess, uci_text: &str) -> Option<shakmaty::Move> {
  let normalized = uci_text.trim().to_ascii_lowercase();
  if !is_valid_uci_text(&normalized) {
    return None;
  }
  let uci_move: UciMove = normalized.parse().ok()?;
  uci_move.to_move(position).ok()
}

fn is_valid_uci_text(text: &str) -> bool {
  let bytes = text.as_bytes();
  if bytes.len() != 4 && bytes.len() != 5 {
    return false;
  }

  is_file(bytes[0])
    && is_rank(bytes[1])
    && is_file(bytes[2])
    && is_rank(bytes[3])
    && (bytes.len() == 4 || matches!(bytes[4], b'q' | b'r' | b'b' | b'n'))
}

fn is_file(byte: u8) -> bool {
  (b'a'..=b'h').contains(&byte)
}

fn is_rank(byte: u8) -> bool {
  (b'1'..=b'8').contains(&byte)
}

fn target_fen_hash(fen: &str) -> Option<u64> {
  let normalized = normalize_fen_without_move_counters(fen);
  let setup: Fen = normalized.parse().ok()?;
  let position: Chess = setup.into_position(CastlingMode::Standard).ok()?;
  let hash: Zobrist64 = position.zobrist_hash(EnPassantMode::Legal);
  Some(hash.0)
}

fn normalize_fen_without_move_counters(fen: &str) -> String {
  let normalized_whitespace_fen = fen.split_whitespace().collect::<Vec<_>>().join(" ");
  let mut parts = normalized_whitespace_fen.split(' ');

  let Some(board) = parts.next() else {
    return normalized_whitespace_fen;
  };
  let Some(side) = parts.next() else {
    return normalized_whitespace_fen;
  };
  let castling = parts.next().unwrap_or("-");
  let en_passant = parts.next().unwrap_or("-");
  format!("{board} {side} {castling} {en_passant} 0 1")
}

fn to_i32_saturated(value: u32) -> i32 {
  i32::try_from(value).unwrap_or(i32::MAX)
}

fn napi_err(error: anyhow::Error) -> NapiError {
  NapiError::from_reason(format!("{error:#}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  const START_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const FEN_AFTER_E4_C5: &str = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 99 42";

  #[test]
  fn normalize_fen_without_move_counters_matches_typescript_behavior() {
    let normalized =
      normalize_fen_without_move_counters("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 27 42");
    assert_eq!(normalized, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  }

  #[test]
  fn collects_stats_for_starting_position() {
    let target_hash = target_fen_hash(START_FEN).unwrap();
    let mut map = HashMap::<String, MoveCounts>::new();

    add_move_stat_from_uci_line(&mut map, 'w', &["e2e4", "e7e5"], target_hash);
    add_move_stat_from_uci_line(&mut map, 'l', &["e2e4", "c7c5"], target_hash);
    add_move_stat_from_uci_line(&mut map, 'd', &["d2d4", "d7d5"], target_hash);

    let e4 = map.get("e4").unwrap();
    assert_eq!(e4.white, 1);
    assert_eq!(e4.draws, 0);
    assert_eq!(e4.black, 1);

    let d4 = map.get("d4").unwrap();
    assert_eq!(d4.white, 0);
    assert_eq!(d4.draws, 1);
    assert_eq!(d4.black, 0);
  }

  #[test]
  fn ignores_invalid_uci_tokens() {
    let target_hash = target_fen_hash(START_FEN).unwrap();
    let mut map = HashMap::<String, MoveCounts>::new();

    add_move_stat_from_uci_line(&mut map, 'w', &["e9e4", "e7e5"], target_hash);
    add_move_stat_from_uci_line(&mut map, 'w', &["abcd", "e7e5"], target_hash);

    assert!(map.is_empty());
  }

  #[test]
  fn matches_positions_even_when_target_fen_has_different_move_counters() {
    let target_hash = target_fen_hash(FEN_AFTER_E4_C5).unwrap();
    let mut map = HashMap::<String, MoveCounts>::new();

    add_move_stat_from_uci_line(&mut map, 'w', &["e2e4", "c7c5", "g1f3"], target_hash);
    add_move_stat_from_uci_line(&mut map, 'd', &["e2e4", "c7c5", "d2d4"], target_hash);

    assert_eq!(map.get("Nf3").map(|counts| counts.white), Some(1));
    assert_eq!(map.get("d4").map(|counts| counts.draws), Some(1));
  }
}
