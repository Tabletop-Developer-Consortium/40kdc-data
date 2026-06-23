/**
 * Types for the army-list importer.
 *
 * Two layers live here:
 * - The **output** types ({@link Roster} and friends) mirror
 *   `schemas/core/roster.schema.json` field-for-field. They are hand-authored
 *   rather than generated so importer work isn't gated on the Rust→typify codegen
 *   round-trip; the AJV validator (against the real schema) is the source of truth
 *   for conformance.
 * - The **intermediate** type ({@link ParsedRoster}) is format-agnostic: a parser
 *   adapter lowers a source payload to this shape (raw names + counts only, no
 *   resolved ids), and {@link resolve} turns it into a {@link Roster}.
 *
 * Nothing here ever carries reproduced rules or ability text — only permitted
 * facts (names, counts, points, keywords, entity ids).
 *
 * @packageDocumentation
 */

/** A 40kdc battle size (mirrors the shared `battle-size` def). */
export type BattleSize = "incursion" | "strike-force";

/** Diagnostic warning codes emitted during an import. */
export type WarningCode =
  | "faction-unresolved"
  | "unit-unresolved"
  | "weapon-unresolved"
  | "enhancement-unresolved"
  | "detachment-unresolved"
  | "detachment-points-exceeded"
  | "battle-size-unmapped"
  | "points-mismatch"
  | "leader-attachment-inferred"
  | "multi-force"
  | "unknown-field";

// ---------------------------------------------------------------------------
// Output types (mirror roster.schema.json)
// ---------------------------------------------------------------------------

/** A near-match suggestion offered when resolution fails. */
export interface Candidate {
  id: string;
  name: string;
}

/**
 * A reference to a 40kdc entity that may or may not have resolved. Retains the
 * source's raw name so the import is lossless even on a miss.
 */
export interface ResolvedRef {
  /** Resolved entity id, or null when no match was found. */
  id: string | null;
  /** The display name exactly as it appeared in the source payload. */
  raw_name: string;
  /** True iff {@link id} is non-null. */
  resolved: boolean;
  /** Up to 5 best-guess alternatives when resolution failed. */
  candidates: Candidate[];
}

/** A weapon/wargear selection on a unit. */
export interface RosterWargear {
  ref: ResolvedRef;
  count: number;
}

/** One detachment on the roster, paired with its resolved DP cost. */
export interface RosterDetachment {
  ref: ResolvedRef;
  /** DP cost (1–3) from the resolved detachment entity; null when unresolved or unrecorded. */
  dp_cost: number | null;
}

/** An inferred, always-provisional leader→bodyguard attachment. */
export interface RosterLeaderAttachment {
  bodyguard_ref: ResolvedRef;
  /**
   * Role of the attaching character relative to the bodyguard unit. `leader`
   * renders as "<leader> leading <bodyguard>"; `support` (a character that
   * cannot operate alone) renders as "supported by <support>". Import only ever
   * infers `support`; the list-builder emits `leader`.
   */
  role: "leader" | "support";
  provisional: boolean;
}

/** One unit entry in a roster. */
export interface RosterUnit {
  ref: ResolvedRef;
  model_count: number;
  /** Base unit cost (without the enhancement). */
  points: number | null;
  is_warlord: boolean;
  enhancement: ResolvedRef | null;
  /** Points cost of the enhancement when the source reported one; null otherwise. */
  enhancement_points: number | null;
  wargear: RosterWargear[];
  leader_attachment: RosterLeaderAttachment | null;
}

/** Identifier for the adapter that produced this roster. New format adapters
 * extend this union; `roster.schema.json` keeps the canonical enum. */
export type RosterFormat =
  | "listforge"
  | "listforge-text"
  | "newrecruit-json"
  | "newrecruit-wtc-compact"
  | "newrecruit-wtc-full"
  | "newrecruit-simple"
  | "rosterizer"
  | "gw"
  | "roster-json";

/** Provenance of the imported list. */
export interface RosterSource {
  format: RosterFormat;
  generated_by: string | null;
}

/** Point totals; reported and computed are kept distinct, never reconciled. */
export interface RosterPoints {
  declared_limit: number | null;
  /** 11e detachment-point budget from the battle size (strike-force 3, incursion 2); null when unknown. */
  detachment_cap: number | null;
  total_reported: number | null;
  total_computed: number;
}

/** A single diagnostic warning. */
export interface Warning {
  code: WarningCode;
  message: string;
  raw_name: string | null;
}

/** A summary of what resolved and what did not during the import. */
export interface Diagnostics {
  resolved_units: number;
  unresolved_units: number;
  resolved_weapons: number;
  unresolved_weapons: number;
  warnings: Warning[];
}

/** Reference to the game edition + dataslate (mirrors game-version-ref). */
export interface GameVersionRef {
  edition: string;
  dataslate: string;
}

/** A fully-resolved army list. Validates against `roster.schema.json`. */
export interface Roster {
  name: string;
  source: RosterSource;
  faction_id: string | null;
  detachments: RosterDetachment[];
  battle_size: BattleSize | null;
  /**
   * The selected Force Disposition id (a `force-disposition-id`), or null when
   * none has been picked. Required to be present (nullable) — picking one is
   * mandatory in 11e list-building, but the source formats don't yet encode it,
   * so imports default to null and the roster-legality checker surfaces an
   * advisory `disposition-not-picked`.
   */
  force_disposition: string | null;
  points: RosterPoints;
  units: RosterUnit[];
  game_version: GameVersionRef;
  diagnostics: Diagnostics;
}

// ---------------------------------------------------------------------------
// Intermediate types (format-agnostic; produced by a parser adapter)
// ---------------------------------------------------------------------------

/** A weapon/wargear selection before id resolution. */
export interface ParsedWargear {
  raw_name: string;
  count: number;
}

/** A unit selection before id resolution. */
export interface ParsedUnit {
  raw_name: string;
  /** True when the source classifies this as a character/leader-capable model. */
  is_character: boolean;
  model_count: number;
  /** Base unit cost (without the enhancement). */
  points: number | null;
  is_warlord: boolean;
  enhancement_raw_name: string | null;
  /** Points cost of the enhancement when the source reported one; null otherwise. */
  enhancement_points: number | null;
  wargear: ParsedWargear[];
}

/**
 * The format-agnostic intermediate. A {@link FormatAdapter} produces this from a
 * decoded source payload; {@link resolve} consumes it. Contains only raw display
 * names and counts — never reproduced rules text.
 */
export interface ParsedRoster {
  name: string;
  generated_by: string | null;
  /** Raw faction name from the source (e.g. "Grey Knights"). */
  faction_raw_name: string | null;
  /**
   * Raw detachment names in source order (e.g. ["Gladius Task Force"]). 11e lists may
   * carry several; most formats and pre-11e lists carry zero or one.
   */
  detachment_raw_names: string[];
  /** Raw battle-size label (e.g. "2. Strike Force (2000 Point limit)"). */
  battle_size_raw: string | null;
  /**
   * Selected Force Disposition id, when the source carried one (only the
   * canonical roster-json round-trip does today). Absent/null otherwise.
   */
  force_disposition?: string | null;
  /** Points limit parsed from the battle-size label, if any. */
  declared_limit: number | null;
  /** Total points reported by the source cost block. */
  total_reported: number | null;
  /** Points summed from every cost line in the source tree. */
  total_computed: number;
  units: ParsedUnit[];
  /** True when the source contained more than one distinct faction. */
  multi_force: boolean;
}
