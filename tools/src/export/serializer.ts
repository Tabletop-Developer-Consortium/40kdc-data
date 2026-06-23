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
 *
 * @packageDocumentation
 */
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
  | "atc-2026-full";

/** Serializes a {@link Roster} into one specific format. */
export interface RosterSerializer {
  id: ExportFormat;
  serialize(roster: Roster): string;
}
