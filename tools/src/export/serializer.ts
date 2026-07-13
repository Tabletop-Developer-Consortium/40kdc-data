/**
 * The roster-serializer seam — symmetric counterpart to the
 * {@link FormatAdapter} import seam.
 *
 * Each supported export target implements {@link RosterSerializer}: it takes a
 * fully-resolved {@link Roster} and produces a deterministic string in that
 * format. The seam stays Dataset-free so the TS and Rust mirrors can produce
 * byte-identical output for conformance.
 *
 * Registered targets:
 * - `newrecruit-json`         — NewRecruit-shaped JSON skeleton (rules-free).
 * - `newrecruit-wtc-compact`  — tournament-friendly one-line-per-unit text.
 * - `newrecruit-wtc-full`     — tournament-friendly section-and-wargear text.
 * - `newrecruit-simple`       — markdown-ish text.
 * - `roster-json`             — canonical Roster JSON (the lossless pivot).
 * - `atc-2026-compact`        — ATC 2026 header + WTC compact body (export-only).
 * - `atc-2026-full`           — ATC 2026 header + WTC full body (export-only).
 * - `yellowscribe`            — BattleScribe `.ros` XML for Tabletop Simulator
 *                               import (export-only, **Dataset-backed**).
 *
 * @packageDocumentation
 */
import type { Dataset } from "../data/dataset.js";
import type { Roster } from "../import/types.js";

/** Stable id for an export target. */
export type ExportFormat =
  | "newrecruit-json"
  | "newrecruit-wtc-compact"
  | "newrecruit-wtc-full"
  | "newrecruit-simple"
  | "roster-json"
  | "rosterizer"
  | "atc-2026-compact"
  | "atc-2026-full"
  | "yellowscribe";

/**
 * Serializes a {@link Roster} into one specific format. The seam stays
 * Dataset-free so the TS/Rust/Python/Go mirrors can produce byte-identical
 * output for conformance from the Roster alone.
 */
export interface RosterSerializer {
  id: ExportFormat;
  serialize(roster: Roster): string;
}

/**
 * A serializer that additionally reads the {@link Dataset} — for a target that
 * needs full datasheet data (stat lines, weapon profiles, keywords, ability
 * text) the Roster doesn't carry (e.g. Yellowscribe's TTS tooltips). The
 * separate seam keeps the Dataset-free {@link RosterSerializer} contract — and
 * every format on it — unchanged. Output stays deterministic: the embedded
 * dataset is identical across ports, so byte-parity still holds.
 */
export interface DatasetSerializer {
  id: ExportFormat;
  serialize(roster: Roster, dataset: Dataset): string;
}
