#!/usr/bin/env node
/**
 * NDJSON conformance runner — the TypeScript implementation of the wire
 * protocol in `conformance/RUNNER_PROTOCOL.md`. Each line on stdin is a JSON
 * request `{op, args?}`; each line on stdout is a JSON response
 * `{ok: true, value}` or `{ok: false, error_kind, error_payload?}`.
 *
 * This file exports {@link processRequest} so vitest can drive the runner
 * in-process without spawning a child; the bottom `if (isCliMain())` block
 * wires the same dispatcher to real stdin/stdout for the cross-impl differ.
 *
 * The runner is a *thin* wrapper over the existing public API — it is not the
 * canonical way to use the package. Library consumers should import the
 * functions directly; the runner exists to give the cross-implementation
 * differ a uniform interface across language ports.
 */
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { Dataset } from "./data/dataset.js";
import { normalizeName } from "./data/normalize.js";
import { baseLoadout, maximalLoadout, checkUnitLegality } from "./data/loadout.js";
import { validateRosterCore, type NormRoster } from "./data/roster-resolve.js";
import { candidateAffordability, type AffordabilitySpec } from "./data/affordability.js";
import type { BattleSize } from "./import/types.js";
import { exportRoster, type ExportFormat } from "./export/index.js";
import { decodeShareToken, encodeShareToken, type ShareList } from "./share/index.js";
import { importRoster, tryImportRoster, REGISTERED_ADAPTERS } from "./import/import-roster.js";
import { selectAdapter } from "./import/adapter.js";
import { createValidator } from "./schema-loader.js";
import { attributeStages, crunch, type Buff, type EngineContext, type EngineInput } from "./cruncher/index.js";
import { compareCell, loadoutCell, type ComparePhase, type LoadoutLine } from "./compare.js";
import { describeScoringCard, describeAbility, type ScoringMode, type Effect, type AbilityScope, type AbilityAppliesTo, type AbilityUsage, type AbilityTrigger } from "./translate/index.js";
import { unitMatchesAppliesTo } from "./scope.js";
import {
  awardsOf,
  scoreTurn,
  scoreCap,
  scoreSecondaryEvent,
  scorePrimaryEvent,
  emptyPlayerGame,
  addToHand,
  scoreSecondary,
  removeScore,
  setPrimary,
  playerPrimary,
  playerSecondary,
  playerTotal,
  wtcResult,
  type AssertedAward,
  type PlayerGame,
} from "./scoring/index.js";
import type { SecondaryCard, GameEvent } from "./generated.js";
import {
  resolveLayout,
  TerrainResolveError,
  keystoneMeasurements,
  TerrainKeystoneError,
  BOARD_INCHES,
} from "./terrain/index.js";
import type { TerrainTemplate, TerrainLayout } from "./terrain/resolve.js";
import type Ajv from "ajv";

// -----------------------------------------------------------------------------
// Constants — spec version and implementation identity.
// -----------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSpecVersion(): number {
  // The corpus lives at repo-root/conformance/. Walk up from tools/src/ until
  // we find it so the runner works both from source (tsx) and from dist/.
  for (const candidate of [
    join(__dirname, "../../conformance/SPEC_VERSION"),
    join(__dirname, "../../../conformance/SPEC_VERSION"),
  ]) {
    try {
      return Number.parseInt(readFileSync(candidate, "utf8").trim(), 10);
    } catch {
      // try next
    }
  }
  throw new Error("could not locate conformance/SPEC_VERSION");
}

function loadImplVersion(): string {
  for (const candidate of [
    join(__dirname, "../package.json"),
    join(__dirname, "../../package.json"),
  ]) {
    try {
      return (JSON.parse(readFileSync(candidate, "utf8")) as { version: string }).version;
    } catch {
      // try next
    }
  }
  return "unknown";
}

const SPEC_VERSION = loadSpecVersion();
const IMPL_VERSION = loadImplVersion();
const IMPL_NAME = "ts";

// -----------------------------------------------------------------------------
// Error envelope helpers and the closed `error_kind` enum.
// -----------------------------------------------------------------------------

export type RunnerResponse =
  | { ok: true; value: unknown }
  | { ok: false; error_kind: ErrorKind; error_payload?: unknown };

const ERROR_KINDS = [
  "INVALID_INPUT",
  "UNKNOWN_OP",
  "UNKNOWN_ENTITY",
  "IMPORT_FAILED",
  "EXPORT_FAILED",
  "VALIDATION_ERROR",
  "CRUNCH_ERROR",
  "INTERNAL_ERROR",
] as const;
type ErrorKind = (typeof ERROR_KINDS)[number];

function ok(value: unknown): RunnerResponse {
  return { ok: true, value };
}
function err(kind: ErrorKind, payload?: unknown): RunnerResponse {
  return payload === undefined
    ? { ok: false, error_kind: kind }
    : { ok: false, error_kind: kind, error_payload: payload };
}

// -----------------------------------------------------------------------------
// Runner state — init must be the first request; subsequent ops fail with
// INVALID_INPUT until init succeeds. Dataset and validator are lazy.
// -----------------------------------------------------------------------------

export interface RunnerState {
  initialized: boolean;
  locale: string;
  tz: string;
  seed: number;
  dataset?: Dataset;
  validator?: Ajv;
}

export function createRunnerState(): RunnerState {
  return { initialized: false, locale: "C", tz: "UTC", seed: 0 };
}

function getDataset(state: RunnerState): Dataset {
  if (!state.dataset) state.dataset = Dataset.embedded();
  return state.dataset;
}

function getValidator(state: RunnerState): Ajv {
  if (!state.validator) state.validator = createValidator();
  return state.validator;
}

// -----------------------------------------------------------------------------
// Op handlers.
// -----------------------------------------------------------------------------

function handleInit(state: RunnerState, args: unknown): RunnerResponse {
  if (state.initialized) {
    return err("INVALID_INPUT", { detail: "init called twice" });
  }
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "init args must be an object" });
  }
  const a = args as { spec_version?: unknown; locale?: unknown; tz?: unknown; seed?: unknown };
  if (a.spec_version !== SPEC_VERSION) {
    return err("INVALID_INPUT", {
      detail: `spec_version mismatch: runner=${SPEC_VERSION}, request=${String(a.spec_version)}`,
    });
  }
  if (a.locale !== "C") {
    return err("INVALID_INPUT", { detail: `unsupported locale: ${String(a.locale)} (only "C")` });
  }
  if (a.tz !== "UTC") {
    return err("INVALID_INPUT", { detail: `unsupported tz: ${String(a.tz)} (only "UTC")` });
  }
  if (typeof a.seed !== "number") {
    return err("INVALID_INPUT", { detail: "seed must be a number" });
  }
  state.initialized = true;
  state.locale = a.locale;
  state.tz = a.tz;
  state.seed = a.seed;
  return ok({ impl: IMPL_NAME, spec_version: SPEC_VERSION, impl_version: IMPL_VERSION });
}

function handleNormalize(args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "normalize args must be an object" });
  }
  const a = args as { input?: unknown };
  if (typeof a.input !== "string") {
    return err("INVALID_INPUT", { detail: "normalize.input must be a string" });
  }
  return ok(normalizeName(a.input));
}

function handleImport(state: RunnerState, args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "import args must be an object" });
  }
  const a = args as { format?: unknown; input?: unknown };
  if (typeof a.input !== "string") {
    return err("INVALID_INPUT", { detail: "import.input must be a string" });
  }
  try {
    // The wire protocol carries every input as a string: JSON payloads come
    // through as the JSON text, text payloads come through as-is. The import
    // pipeline decides which by attempting to parse JSON first.
    const trimmed = a.input.trimStart();
    let decoded: unknown;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        decoded = JSON.parse(a.input);
      } catch {
        decoded = a.input;
      }
    } else {
      decoded = a.input;
    }
    const roster = importRoster(decoded, { dataset: getDataset(state) });
    return ok(roster);
  } catch (e) {
    return err("IMPORT_FAILED", { detail: (e as Error).message, format: a.format ?? null });
  }
}

function handleTryImport(state: RunnerState, args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "try_import args must be an object" });
  }
  const a = args as { input?: unknown };
  if (typeof a.input !== "string") {
    return err("INVALID_INPUT", { detail: "try_import.input must be a string" });
  }
  const result = tryImportRoster(a.input, { dataset: getDataset(state) });
  if (!result.ok) {
    return err("IMPORT_FAILED", { reason: result.reason, message: result.message });
  }
  return ok({ format: result.format, roster: result.roster });
}

const EXPORT_FORMATS: ExportFormat[] = [
  "newrecruit-json",
  "newrecruit-wtc-compact",
  "newrecruit-wtc-full",
  "newrecruit-simple",
  "roster-json",
  "rosterizer",
  "atc-2026-compact",
  "atc-2026-full",
  "yellowscribe",
];

function handleExport(state: RunnerState, args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "export args must be an object" });
  }
  const a = args as { format?: unknown; roster?: unknown };
  if (typeof a.format !== "string" || !EXPORT_FORMATS.includes(a.format as ExportFormat)) {
    return err("INVALID_INPUT", { detail: `unknown export format: ${String(a.format)}` });
  }
  if (typeof a.roster !== "object" || a.roster === null) {
    return err("INVALID_INPUT", { detail: "export.roster must be an object" });
  }
  try {
    // We assume the caller passes the canonical resolved Roster shape; if they
    // pass something the serializer can't handle, this throws. Dataset-backed
    // formats (yellowscribe) get the embedded dataset; the others ignore it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ok(exportRoster(a.roster as any, a.format as ExportFormat, getDataset(state)));
  } catch (e) {
    return err("EXPORT_FAILED", { detail: (e as Error).message });
  }
}

function handleShareEncode(args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "share_encode args must be an object" });
  }
  const a = args as { list?: unknown };
  if (typeof a.list !== "object" || a.list === null) {
    return err("INVALID_INPUT", { detail: "share_encode.list must be an object" });
  }
  try {
    return ok(encodeShareToken(a.list as ShareList));
  } catch (e) {
    // An id absent from the embedded registry is the only expected throw.
    return err("INVALID_INPUT", { detail: (e as Error).message });
  }
}

function handleShareDecode(args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "share_decode args must be an object" });
  }
  const a = args as { token?: unknown };
  if (typeof a.token !== "string") {
    return err("INVALID_INPUT", { detail: "share_decode.token must be a string" });
  }
  // The DecodeResult ({ ok, list } | { ok, reason }) is the compared value;
  // a malformed/stale token is a normal result, not a protocol error.
  return ok(decodeShareToken(a.token));
}

/**
 * Canonical string encoding of a base size for cross-impl comparison (mirrors the
 * string-encoding used by `maximal_loadout`). Returns null for an absent base.
 *   round 32     → "round:32"
 *   oval 75×42   → "oval:75x42"
 *   small flyer  → "flying-base:small:draft"
 *   hull (draft) → "hull:draft"
 */
export function encodeBase(
  b:
    | { shape: string; diameter?: number; width?: number; length?: number; size?: string; draft?: boolean }
    | null
    | undefined,
): string | null {
  if (!b) return null;
  const parts: string[] = [b.shape];
  if (b.shape === "round" && b.diameter != null) parts.push(String(b.diameter));
  else if (b.shape === "oval" && b.width != null && b.length != null) parts.push(`${b.width}x${b.length}`);
  else if (b.shape === "flying-base" && b.size) parts.push(b.size);
  if (b.draft) parts.push("draft");
  return parts.join(":");
}

/**
 * Whole-unit loadout legality (tier-aware) — the cross-impl pin for
 * {@link checkUnitLegality}. Args: `{ unitId, factionId?, modelCount, counts }`
 * where `counts` maps weapon/wargear id → count. Returns the violation list as
 * sorted `"code:id"` strings (the maths already sorts deterministically; the
 * extra sort keeps the wire result stable across the small encoding).
 */
function handleCheckUnitLegality(state: RunnerState, args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "check_unit_legality args must be an object" });
  }
  const a = args as {
    unitId?: unknown;
    factionId?: unknown;
    modelCount?: unknown;
    counts?: Record<string, number>;
  };
  if (typeof a.unitId !== "string" || typeof a.modelCount !== "number") {
    return err("INVALID_INPUT", { detail: "check_unit_legality.unitId/modelCount required" });
  }
  const ds = getDataset(state);
  const unit =
    typeof a.factionId === "string"
      ? ds.units.getInFaction(a.unitId, a.factionId)
      : ds.units.getAny(a.unitId);
  if (!unit) return err("UNKNOWN_ENTITY", { kind: "unit", id: a.unitId });
  const options = ds.wargearOptionsOf(unit.raw);
  const composition = ds.unitCompositionOf(unit.raw);
  const counts = new Map<string, number>(Object.entries(a.counts ?? {}));
  const violations = checkUnitLegality(
    unit.raw,
    a.modelCount,
    options,
    counts,
    composition?.models,
    composition?.tiers,
  );
  return ok(violations.map((v) => `${v.code}:${v.id}`).sort());
}

/**
 * Whole-army legality over a compact roster spec via {@link validateRosterCore}.
 * Args: `{ factionId, battleSize?, forceDisposition?, detachments: [{id}],
 * units: [{ unitId, modelCount, isWarlord?, enhancementId?, leaderBodyguardId?,
 * counts? }] }`. The response `value` is the sorted union of per-unit loadout
 * and army violations as `"<scope>|<severity>|<code>:<id>"` strings, where
 * `scope` is `army` or `u<index>` and `severity` is `error|warn`.
 */
function handleCheckRosterLegality(state: RunnerState, args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "check_roster_legality args must be an object" });
  }
  const a = args as {
    factionId?: unknown;
    battleSize?: unknown;
    forceDisposition?: unknown;
    detachments?: { id?: unknown }[];
    units?: {
      unitId?: unknown;
      modelCount?: unknown;
      isWarlord?: unknown;
      enhancementId?: unknown;
      leaderBodyguardId?: unknown;
      counts?: Record<string, number>;
    }[];
  };
  if (!Array.isArray(a.units)) {
    return err("INVALID_INPUT", { detail: "check_roster_legality.units must be an array" });
  }
  const spec: NormRoster = {
    factionId: typeof a.factionId === "string" ? a.factionId : null,
    battleSize: typeof a.battleSize === "string" ? (a.battleSize as BattleSize) : null,
    forceDisposition: typeof a.forceDisposition === "string" ? a.forceDisposition : null,
    detachmentIds: (a.detachments ?? [])
      .map((d) => d.id)
      .filter((id): id is string => typeof id === "string"),
    units: a.units.map((u) => ({
      unitId: typeof u.unitId === "string" ? u.unitId : "",
      modelCount: typeof u.modelCount === "number" ? u.modelCount : 0,
      isWarlord: u.isWarlord === true,
      enhancementId: typeof u.enhancementId === "string" ? u.enhancementId : null,
      leaderBodyguardId: typeof u.leaderBodyguardId === "string" ? u.leaderBodyguardId : null,
      counts: new Map<string, number>(Object.entries(u.counts ?? {})),
    })),
  };
  const result = validateRosterCore(spec, getDataset(state));
  const lines = [
    ...result.units.flatMap((u) =>
      u.violations.map((v) => `u${u.unitIndex}|error|${v.code}:${v.id}`),
    ),
    ...result.army.map(
      (v) => `${v.unitIndex === null ? "army" : `u${v.unitIndex}`}|${v.severity}|${v.code}:${v.id}`,
    ),
  ];
  return ok(lines.sort());
}

/**
 * Cheapest-next-copy pricing + affordability for a set of candidate units, via
 * {@link candidateAffordability}. Returns `[{ unitId, nextCopyCost, affordable }]`
 * sorted ascending by `(nextCopyCost, unitId)`.
 */
function handleCandidateAffordability(state: RunnerState, args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "candidate_affordability args must be an object" });
  }
  const a = args as {
    factionId?: unknown;
    battleSize?: unknown;
    pointsLimitOverride?: unknown;
    units?: { unitId?: unknown; modelCount?: unknown; enhancementId?: unknown }[];
    candidateUnitIds?: unknown;
  };
  if (!Array.isArray(a.units)) {
    return err("INVALID_INPUT", { detail: "candidate_affordability.units must be an array" });
  }
  const spec: AffordabilitySpec = {
    factionId: typeof a.factionId === "string" ? a.factionId : null,
    battleSize: typeof a.battleSize === "string" ? (a.battleSize as BattleSize) : null,
    pointsLimitOverride: typeof a.pointsLimitOverride === "number" ? a.pointsLimitOverride : null,
    units: a.units.map((u) => ({
      unitId: typeof u.unitId === "string" ? u.unitId : "",
      modelCount: typeof u.modelCount === "number" ? u.modelCount : 0,
      enhancementId: typeof u.enhancementId === "string" ? u.enhancementId : null,
    })),
    candidateUnitIds: Array.isArray(a.candidateUnitIds)
      ? a.candidateUnitIds.filter((id): id is string => typeof id === "string")
      : null,
  };
  return ok(candidateAffordability(spec, getDataset(state)));
}

function handleLinkedQuery(state: RunnerState, args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "linked_query args must be an object" });
  }
  const a = args as { query?: unknown; input?: unknown };
  if (typeof a.query !== "string") {
    return err("INVALID_INPUT", { detail: "linked_query.query must be a string" });
  }
  const ds = getDataset(state);
  const input = (a.input ?? {}) as Record<string, string>;
  // A shared chassis (same unit id in several factions) diverges per faction in
  // its options/composition/profiles; when the case pins `factionId`, resolve
  // that faction's copy, else fall back to first-wins `getAny` (back-compat).
  const resolveUnit = (id: string) =>
    input.factionId ? ds.units.getInFaction(id, input.factionId) : ds.units.getAny(id);
  try {
    switch (a.query) {
      case "find_unit":
        return ok(ds.units.find(input.query ?? "")?.id ?? null);
      case "find_weapon":
        return ok(ds.weapons.find(input.query ?? "")?.id ?? null);
      case "find_faction":
        return ok(ds.factions.find(input.query ?? "")?.id ?? null);
      case "find_ability":
        return ok(ds.abilities.find(input.query ?? "")?.id ?? null);
      case "abilities_of": {
        const u = resolveUnit(input.unitId);
        if (!u) return err("UNKNOWN_ENTITY", { kind: "unit", id: input.unitId });
        return ok(u.abilities.map((x) => x.id));
      }
      case "weapons_of": {
        const u = resolveUnit(input.unitId);
        if (!u) return err("UNKNOWN_ENTITY", { kind: "unit", id: input.unitId });
        return ok(u.weapons.map((x) => x.id));
      }
      case "wargear_options_of": {
        const u = resolveUnit(input.unitId);
        if (!u) return err("UNKNOWN_ENTITY", { kind: "unit", id: input.unitId });
        return ok(u.wargearOptions.map((x) => x.id));
      }
      case "base_loadout": {
        const u = resolveUnit(input.unitId);
        if (!u) return err("UNKNOWN_ENTITY", { kind: "unit", id: input.unitId });
        const modelCount = Number(input.modelCount);
        const comp = ds.unitCompositionOf(u.raw);
        const lo = baseLoadout(u.raw, modelCount, ds.wargearOptionsOf(u.raw), comp?.models);
        // Encode the id→count map as sorted "id:count" strings for set compare.
        return ok([...lo.counts].map(([id, n]) => `${id}:${n}`).sort());
      }
      case "maximal_loadout": {
        const u = resolveUnit(input.unitId);
        if (!u) return err("UNKNOWN_ENTITY", { kind: "unit", id: input.unitId });
        const modelCount = Number(input.modelCount);
        const comp = ds.unitCompositionOf(u.raw);
        const lo = maximalLoadout(u.raw, modelCount, ds.wargearOptionsOf(u.raw), comp?.models);
        // Encode the id→count map as sorted "id:count" strings for set compare.
        return ok([...lo.counts].map(([id, n]) => `${id}:${n}`).sort());
      }
      case "phases_of": {
        const ab = ds.abilities.getAny(input.abilityId);
        if (!ab) return err("UNKNOWN_ENTITY", { kind: "ability", id: input.abilityId });
        return ok([...ab.phases]);
      }
      case "faction_of": {
        const u = resolveUnit(input.unitId);
        if (!u) return err("UNKNOWN_ENTITY", { kind: "unit", id: input.unitId });
        return ok(u.faction?.id ?? null);
      }
      case "base_size_of": {
        const u = resolveUnit(input.unitId);
        if (!u) return err("UNKNOWN_ENTITY", { kind: "unit", id: input.unitId });
        return ok(encodeBase(u.raw.base_size_mm));
      }
      case "model_bases_of": {
        const u = resolveUnit(input.unitId);
        if (!u) return err("UNKNOWN_ENTITY", { kind: "unit", id: input.unitId });
        const comp = ds.unitCompositionOf(u.raw);
        // Ordered "modelName=encodedBase" pairs in declared model order.
        return ok((comp?.models ?? []).map((m) => `${m.name}=${encodeBase(m.base_size_mm) ?? "none"}`));
      }
      case "abilities_of_faction":
        return ok(ds.abilities.byFaction(input.factionId).map((x) => x.id));
      case "weapons_of_faction": {
        const f = ds.factions.get(input.factionId);
        if (!f) return err("UNKNOWN_ENTITY", { kind: "faction", id: input.factionId });
        return ok(f.weapons.map((x) => x.id));
      }
      case "logo_url_of_faction": {
        const f = ds.factions.get(input.factionId);
        if (!f) return err("UNKNOWN_ENTITY", { kind: "faction", id: input.factionId });
        return ok(f.logoUrl ?? null);
      }
      case "units_with_keyword":
        return ok(ds.unitsWithKeyword(input.keyword ?? "").map((u) => u.id));
      case "allies_for": {
        const raw = (input as Record<string, unknown>).detachmentIds;
        const detachmentIds = Array.isArray(raw) ? (raw as string[]) : [];
        return ok(ds.alliesFor(input.factionId ?? "", detachmentIds).map((r) => r.id));
      }
      case "ally_units_for":
        return ok(ds.allyUnitsFor(input.ruleId ?? "").map((u) => u.id));
      case "leaders_attachable_to":
        return ok(ds.leadersAttachableTo(input.bodyguardId ?? "").map((u) => u.id));
      case "bodyguards_attachable_from":
        return ok(ds.bodyguardsAttachableFrom(input.leaderId ?? "").map((u) => u.id));
      case "reactive_trigger_ability_ids":
        return ok(ds.reactiveTriggers().map((rt) => rt.abilityId));
      case "events_with_triggers":
        return ok([...ds.triggerIndex().keys()]);
      case "triggers_for_event":
        return ok((ds.triggerIndex().get((input.event ?? "") as GameEvent) ?? []).map((rt) => rt.abilityId));
      case "get_enhancement":
        // Returns the resolved enhancement's current id (or null). Exercises
        // renamed-id resolution: a since-renamed id resolves to its new record.
        return ok(ds.enhancements.get(input.id ?? "")?.id ?? null);
      default:
        return err("INVALID_INPUT", { detail: `unknown linked_query: ${a.query}` });
    }
  } catch (e) {
    return err("INTERNAL_ERROR", { detail: (e as Error).message });
  }
}

const VALIDATOR_TARGETS: Record<string, string> = {
  unit: "https://40kdc.dev/schemas/core/unit.schema.json",
  weapon: "https://40kdc.dev/schemas/core/weapon.schema.json",
  faction: "https://40kdc.dev/schemas/core/faction.schema.json",
  ability: "https://40kdc.dev/schemas/enrichment/ability-dsl/ability.schema.json",
  wargear: "https://40kdc.dev/schemas/core/wargear.schema.json",
  "wargear-option": "https://40kdc.dev/schemas/core/wargear-option.schema.json",
};

function ajvKeywordToCode(keyword: string): string {
  switch (keyword) {
    case "required":
      return "REQUIRED_MISSING";
    case "type":
      return "TYPE_MISMATCH";
    case "enum":
    case "const":
      return "ENUM_VIOLATION";
    case "pattern":
    case "format":
      return "PATTERN_MISMATCH";
    case "minimum":
    case "maximum":
    case "exclusiveMinimum":
    case "exclusiveMaximum":
    case "minLength":
    case "maxLength":
    case "minItems":
    case "maxItems":
      return "RANGE_VIOLATION";
    case "additionalProperties":
      return "ADDITIONAL_PROPERTY";
    case "uniqueItems":
      return "UNIQUE_VIOLATION";
    default:
      return `UNMAPPED:${keyword}`;
  }
}

function handleValidate(state: RunnerState, args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "validate args must be an object" });
  }
  const a = args as { target?: unknown; value?: unknown };
  if (typeof a.target !== "string" || !(a.target in VALIDATOR_TARGETS)) {
    return err("INVALID_INPUT", { detail: `unknown validator target: ${String(a.target)}` });
  }
  let validate;
  try {
    validate = getValidator(state).getSchema(VALIDATOR_TARGETS[a.target]);
  } catch (e) {
    return err("VALIDATION_ERROR", { detail: (e as Error).message });
  }
  if (!validate) {
    return err("VALIDATION_ERROR", { detail: `schema not loaded: ${a.target}` });
  }
  validate(a.value);
  const raw = validate.errors ?? [];
  const seen = new Set<string>();
  const out: { path: string; code: string }[] = [];
  for (const e of raw) {
    const code = ajvKeywordToCode(e.keyword);
    if (code.startsWith("UNMAPPED:")) continue;
    const path =
      e.keyword === "required"
        ? `${e.instancePath}/${(e.params as { missingProperty?: string }).missingProperty ?? ""}`
        : e.instancePath;
    const key = `${path}|${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, code });
  }
  return ok(out);
}

interface CrunchArgs {
  attacker?: { weaponId?: string; profileIndex?: number };
  modelsFiring?: number;
  target?: { unitId?: string; profileIndex?: number; modelCount?: number };
  context?: EngineContext;
  buffs?: Buff[];
}

/**
 * Validate the wire-shape `crunch`/`attribution` args and assemble the
 * {@link EngineInput} both ops share, or return a typed runner error. The two
 * ops have identical inputs — separating this lets each handler stay tiny and
 * keeps the validation contract in one place.
 */
function buildEngineInput(
  state: RunnerState,
  a: CrunchArgs,
  opName: string,
): { ok: true; input: EngineInput } | { ok: false; response: RunnerResponse } {
  if (!a.attacker?.weaponId || typeof a.attacker.profileIndex !== "number") {
    return { ok: false, response: err("INVALID_INPUT", { detail: `${opName}.attacker.weaponId/profileIndex required` }) };
  }
  if (!a.target?.unitId || typeof a.target.profileIndex !== "number") {
    return { ok: false, response: err("INVALID_INPUT", { detail: `${opName}.target.unitId/profileIndex required` }) };
  }
  if (typeof a.modelsFiring !== "number") {
    return { ok: false, response: err("INVALID_INPUT", { detail: `${opName}.modelsFiring required` }) };
  }
  if (!a.context) {
    return { ok: false, response: err("INVALID_INPUT", { detail: `${opName}.context required` }) };
  }
  const ds = getDataset(state);
  const weapon = ds.weapons.getAny(a.attacker.weaponId);
  if (!weapon) return { ok: false, response: err("UNKNOWN_ENTITY", { kind: "weapon", id: a.attacker.weaponId }) };
  const unit = ds.units.getAny(a.target.unitId);
  if (!unit) return { ok: false, response: err("UNKNOWN_ENTITY", { kind: "unit", id: a.target.unitId }) };
  const input: EngineInput = {
    attacker: { weapon: weapon.raw, profileIndex: a.attacker.profileIndex },
    target: {
      unit: unit.raw,
      profileIndex: a.target.profileIndex,
      ...(a.target.modelCount !== undefined ? { modelCount: a.target.modelCount } : {}),
    },
    modelsFiring: a.modelsFiring,
    buffs: a.buffs ?? [],
    context: a.context,
  };
  return { ok: true, input };
}

function handleCrunch(state: RunnerState, args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "crunch args must be an object" });
  }
  const built = buildEngineInput(state, args as CrunchArgs, "crunch");
  if (!built.ok) return built.response;
  try {
    // Canonical wire shape: stages array only. `resolved` is impl-internal
    // (TS/Rust shape diverges); per-stage `detail` strings aren't byte-equal
    // across impls. The differ compares per-stage `expected` with 5e-4
    // tolerance — that's the cross-impl contract.
    const out = crunch(built.input, getDataset(state));
    return ok({ stages: out.stages.map((s) => ({ name: s.name, expected: s.expected })) });
  } catch (e) {
    return err("CRUNCH_ERROR", { detail: (e as Error).message });
  }
}

function handleAttribution(state: RunnerState, args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "attribution args must be an object" });
  }
  const a = args as CrunchArgs & { epsilon?: number };
  const built = buildEngineInput(state, a, "attribution");
  if (!built.ok) return built.response;
  try {
    const opts = typeof a.epsilon === "number" ? { epsilon: a.epsilon } : undefined;
    // Drop `detail` from the wire (impl-specific formatting). Keep all
    // numeric fields and the kind-tagged BuffSource shape that's already
    // serde-compatible.
    const stages = attributeStages(built.input, getDataset(state), opts);
    return ok(
      stages.map((s) => ({
        name: s.name,
        expected: s.expected,
        baseline: s.baseline,
        lifts: s.lifts,
        residual: s.residual,
        intrinsics: s.intrinsics,
      })),
    );
  } catch (e) {
    return err("CRUNCH_ERROR", { detail: (e as Error).message });
  }
}

function handleCompare(state: RunnerState, args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "compare args must be an object" });
  }
  const a = args as {
    attacker?: {
      factionId?: unknown;
      unitId?: unknown;
      weaponId?: unknown;
      profileIndex?: unknown;
    };
    targetProfileId?: unknown;
    distance?: unknown;
    phase?: unknown;
    modelsFiring?: unknown;
  };
  const at = a.attacker ?? {};
  if (
    typeof at.factionId !== "string" ||
    typeof at.unitId !== "string" ||
    typeof at.weaponId !== "string" ||
    typeof at.profileIndex !== "number" ||
    typeof a.targetProfileId !== "string" ||
    typeof a.distance !== "number" ||
    (a.phase !== "shooting" && a.phase !== "fight")
  ) {
    return err("INVALID_INPUT", { detail: "compare: malformed attacker/target/distance/phase" });
  }
  try {
    const cell = compareCell(getDataset(state), {
      factionId: at.factionId,
      unitId: at.unitId,
      weaponId: at.weaponId,
      profileIndex: at.profileIndex,
      targetProfileId: a.targetProfileId,
      distance: a.distance,
      phase: a.phase as ComparePhase,
      modelsFiring: typeof a.modelsFiring === "number" ? a.modelsFiring : 1,
    });
    return ok(cell);
  } catch (e) {
    return err("UNKNOWN_ENTITY", { detail: (e as Error).message });
  }
}

function handleLoadout(state: RunnerState, args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "loadout args must be an object" });
  }
  const a = args as {
    lines?: unknown;
    targetProfileId?: unknown;
    distance?: unknown;
    phase?: unknown;
  };
  if (
    !Array.isArray(a.lines) ||
    typeof a.targetProfileId !== "string" ||
    typeof a.distance !== "number" ||
    (a.phase !== "shooting" && a.phase !== "fight")
  ) {
    return err("INVALID_INPUT", { detail: "loadout: malformed lines/target/distance/phase" });
  }
  try {
    const cell = loadoutCell(getDataset(state), {
      lines: a.lines as LoadoutLine[],
      targetProfileId: a.targetProfileId,
      distance: a.distance,
      phase: a.phase as ComparePhase,
    });
    return ok(cell);
  } catch (e) {
    return err("UNKNOWN_ENTITY", { detail: (e as Error).message });
  }
}

function handleTranslateScoring(state: RunnerState, args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "translate_scoring args must be an object" });
  }
  const a = args as { cardId?: unknown };
  if (typeof a.cardId !== "string") {
    return err("INVALID_INPUT", { detail: "translate_scoring.cardId must be a string" });
  }
  const card = getDataset(state).missionCards.get(a.cardId);
  if (!card) return err("UNKNOWN_ENTITY", { kind: "secondary-card", id: a.cardId });
  return ok({ awards: describeScoringCard(card) });
}

function handleTranslateEffect(args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "translate_effect args must be an object" });
  }
  const a = args as { effect?: unknown; scope?: unknown; usage?: unknown; trigger?: unknown; applies_to?: unknown };
  if (typeof a.effect !== "object" || a.effect === null) {
    return err("INVALID_INPUT", { detail: "translate_effect.effect must be an object" });
  }
  const scope =
    typeof a.scope === "object" && a.scope !== null ? (a.scope as AbilityScope) : undefined;
  const usage =
    typeof a.usage === "object" && a.usage !== null ? (a.usage as AbilityUsage) : undefined;
  const trigger =
    typeof a.trigger === "object" && a.trigger !== null ? (a.trigger as AbilityTrigger) : undefined;
  const appliesTo =
    typeof a.applies_to === "object" && a.applies_to !== null
      ? (a.applies_to as AbilityAppliesTo)
      : undefined;
  return ok({
    text: describeAbility({
      effect: a.effect as Effect,
      ...(scope ? { scope } : {}),
      ...(usage ? { usage } : {}),
      ...(trigger ? { trigger } : {}),
      ...(appliesTo ? { applies_to: appliesTo } : {}),
    }),
  });
}

function handleMatchAppliesTo(args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "match_applies_to args must be an object" });
  }
  const a = args as { applies_to?: unknown; units?: unknown };
  if (!Array.isArray(a.units)) {
    return err("INVALID_INPUT", { detail: "match_applies_to.units must be an array" });
  }
  const filter =
    typeof a.applies_to === "object" && a.applies_to !== null
      ? (a.applies_to as AbilityAppliesTo)
      : undefined;
  const matchedIds: string[] = [];
  for (const u of a.units as Array<{ id?: unknown; keywords?: unknown; faction_keywords?: unknown }>) {
    if (unitMatchesAppliesTo(filter, {
      keywords: Array.isArray(u.keywords) ? (u.keywords as string[]) : undefined,
      faction_keywords: Array.isArray(u.faction_keywords) ? (u.faction_keywords as string[]) : undefined,
    })) {
      matchedIds.push(String(u.id));
    }
  }
  return ok({ matchedIds });
}

// -----------------------------------------------------------------------------
// Scoring engine ops. Awards are referenced by index into the card's `awards`
// array (never serialized over the wire) so both impls reconstruct the same
// `AssertedAward` from the shared embedded dataset.
// -----------------------------------------------------------------------------

function isScoringMode(v: unknown): v is ScoringMode {
  return v === "fixed" || v === "tactical";
}

interface AssertionRef {
  index: number;
  count?: number;
}

/**
 * Resolve `[{index, count?}]` against a card's `awards`, or return a typed
 * error. The index addresses the full `awards` array (approach filtering only
 * affects the cap, not which indices are valid).
 */
function resolveAsserted(
  card: SecondaryCard,
  asserted: unknown,
): { ok: true; value: AssertedAward[] } | { ok: false; response: RunnerResponse } {
  if (!Array.isArray(asserted)) {
    return { ok: false, response: err("INVALID_INPUT", { detail: "asserted must be an array" }) };
  }
  const awards = awardsOf(card);
  const out: AssertedAward[] = [];
  for (const raw of asserted) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, response: err("INVALID_INPUT", { detail: "asserted entry must be an object" }) };
    }
    const a = raw as AssertionRef;
    if (typeof a.index !== "number" || a.index < 0 || a.index >= awards.length) {
      return { ok: false, response: err("INVALID_INPUT", { detail: `asserted.index out of range: ${String(a.index)}` }) };
    }
    out.push(a.count === undefined ? { award: awards[a.index] } : { award: awards[a.index], count: a.count });
  }
  return { ok: true, value: out };
}

function handleScoreEvent(state: RunnerState, args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "score_event args must be an object" });
  }
  const a = args as { cardId?: unknown; approach?: unknown; asserted?: unknown; roundCap?: unknown };
  if (typeof a.cardId !== "string") {
    return err("INVALID_INPUT", { detail: "score_event.cardId must be a string" });
  }
  if (!isScoringMode(a.approach)) {
    return err("INVALID_INPUT", { detail: "score_event.approach must be 'fixed' or 'tactical'" });
  }
  const card = getDataset(state).missionCards.get(a.cardId);
  if (!card) return err("UNKNOWN_ENTITY", { kind: "secondary-card", id: a.cardId });
  const resolved = resolveAsserted(card, a.asserted);
  if (!resolved.ok) return resolved.response;

  const turn = scoreTurn(resolved.value);
  const cap = scoreCap(card, a.approach);
  const banked = scoreSecondaryEvent(resolved.value, card, a.approach);
  const value: { turn: number; cap: number | null; banked: number; primaryBanked?: number } = {
    turn,
    // Infinity (uncapped fixed) has no JSON form — null means "no cap".
    cap: cap === Infinity ? null : cap,
    banked,
  };
  if (typeof a.roundCap === "number") {
    value.primaryBanked = scorePrimaryEvent(resolved.value, a.roundCap);
  }
  return ok(value);
}

type ScoreStateOp =
  | { kind: "draw"; cardId?: unknown }
  | { kind: "score-secondary"; cardId?: unknown; round?: unknown; asserted?: unknown }
  | { kind: "score-primary"; cardId?: unknown; round?: unknown; asserted?: unknown; roundCap?: unknown; gameCap?: unknown }
  | { kind: "set-primary"; round?: unknown; vp?: unknown; roundCap?: unknown; gameCap?: unknown }
  | { kind: "remove-score"; index?: unknown };

function optionalCaps(o: { roundCap?: unknown; gameCap?: unknown }): { roundCap?: number; gameCap?: number } {
  const caps: { roundCap?: number; gameCap?: number } = {};
  if (typeof o.roundCap === "number") caps.roundCap = o.roundCap;
  if (typeof o.gameCap === "number") caps.gameCap = o.gameCap;
  return caps;
}

function handleScoreState(state: RunnerState, args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "score_state args must be an object" });
  }
  const a = args as { approach?: unknown; ops?: unknown };
  if (!isScoringMode(a.approach)) {
    return err("INVALID_INPUT", { detail: "score_state.approach must be 'fixed' or 'tactical'" });
  }
  if (!Array.isArray(a.ops)) {
    return err("INVALID_INPUT", { detail: "score_state.ops must be an array" });
  }
  let pg: PlayerGame = emptyPlayerGame(a.approach);
  const ds = getDataset(state);
  for (const raw of a.ops as ScoreStateOp[]) {
    switch (raw.kind) {
      case "draw": {
        if (typeof raw.cardId !== "string") return err("INVALID_INPUT", { detail: "draw.cardId must be a string" });
        pg = addToHand(pg, raw.cardId);
        break;
      }
      case "score-secondary": {
        if (typeof raw.cardId !== "string" || typeof raw.round !== "number") {
          return err("INVALID_INPUT", { detail: "score-secondary needs cardId and round" });
        }
        const card = ds.missionCards.get(raw.cardId);
        if (!card) return err("UNKNOWN_ENTITY", { kind: "secondary-card", id: raw.cardId });
        const resolved = resolveAsserted(card, raw.asserted);
        if (!resolved.ok) return resolved.response;
        const vp = scoreSecondaryEvent(resolved.value, card, pg.approach);
        pg = scoreSecondary(pg, raw.round, raw.cardId, vp);
        break;
      }
      case "score-primary": {
        if (typeof raw.cardId !== "string" || typeof raw.round !== "number") {
          return err("INVALID_INPUT", { detail: "score-primary needs cardId and round" });
        }
        const card = ds.missionCards.get(raw.cardId);
        if (!card) return err("UNKNOWN_ENTITY", { kind: "secondary-card", id: raw.cardId });
        const resolved = resolveAsserted(card, raw.asserted);
        if (!resolved.ok) return resolved.response;
        // The app path: compute the round's raw total, then clamp on store.
        pg = setPrimary(pg, raw.round, scoreTurn(resolved.value), optionalCaps(raw));
        break;
      }
      case "set-primary": {
        if (typeof raw.round !== "number" || typeof raw.vp !== "number") {
          return err("INVALID_INPUT", { detail: "set-primary needs round and vp" });
        }
        pg = setPrimary(pg, raw.round, raw.vp, optionalCaps(raw));
        break;
      }
      case "remove-score": {
        if (typeof raw.index !== "number") return err("INVALID_INPUT", { detail: "remove-score needs index" });
        pg = removeScore(pg, raw.index);
        break;
      }
      default:
        return err("INVALID_INPUT", { detail: `unknown score_state op kind: ${String((raw as { kind?: unknown }).kind)}` });
    }
  }
  return ok({
    rounds: pg.rounds,
    handIds: pg.handIds,
    log: pg.log,
    primary: playerPrimary(pg),
    secondary: playerSecondary(pg),
    total: playerTotal(pg),
  });
}

function handleWtcResult(args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "wtc_result args must be an object" });
  }
  const a = args as { a?: unknown; b?: unknown };
  if (typeof a.a !== "number" || typeof a.b !== "number") {
    return err("INVALID_INPUT", { detail: "wtc_result needs numeric a and b" });
  }
  return ok(wtcResult(a.a, a.b));
}

function handleResolveTerrain(args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "resolve_terrain args must be an object" });
  }
  const a = args as { layout?: unknown; templates?: unknown };
  if (typeof a.layout !== "object" || a.layout === null) {
    return err("INVALID_INPUT", { detail: "resolve_terrain.layout must be an object" });
  }
  const templates = a.templates ?? [];
  if (!Array.isArray(templates)) {
    return err("INVALID_INPUT", { detail: "resolve_terrain.templates must be an array" });
  }
  try {
    const pieces = resolveLayout(a.layout as TerrainLayout, templates as TerrainTemplate[]);
    return ok({ pieces });
  } catch (e) {
    if (e instanceof TerrainResolveError) {
      return err("INVALID_INPUT", { detail: e.message });
    }
    return err("INTERNAL_ERROR", { detail: (e as Error).message });
  }
}

function handleKeystones(args: unknown): RunnerResponse {
  if (typeof args !== "object" || args === null) {
    return err("INVALID_INPUT", { detail: "keystones args must be an object" });
  }
  const a = args as { layout?: unknown; templates?: unknown; board?: unknown };
  if (typeof a.layout !== "object" || a.layout === null) {
    return err("INVALID_INPUT", { detail: "keystones.layout must be an object" });
  }
  const templates = a.templates ?? [];
  if (!Array.isArray(templates)) {
    return err("INVALID_INPUT", { detail: "keystones.templates must be an array" });
  }
  let board: { width: number; height: number } = BOARD_INCHES;
  if (a.board !== undefined) {
    const b = a.board as { width?: unknown; height?: unknown } | null;
    if (typeof b !== "object" || b === null || typeof b.width !== "number" || typeof b.height !== "number") {
      return err("INVALID_INPUT", { detail: "keystones.board must be {width, height}" });
    }
    board = { width: b.width, height: b.height };
  }
  try {
    const measurements = keystoneMeasurements(
      a.layout as TerrainLayout,
      templates as TerrainTemplate[],
      board,
    );
    return ok({ measurements });
  } catch (e) {
    if (e instanceof TerrainKeystoneError || e instanceof TerrainResolveError) {
      return err("INVALID_INPUT", { detail: e.message });
    }
    return err("INTERNAL_ERROR", { detail: (e as Error).message });
  }
}

// -----------------------------------------------------------------------------
// Dispatcher and per-line entry point.
// -----------------------------------------------------------------------------

/**
 * Apply one decoded request to the runner state and return the response. Used
 * directly by tests; the CLI loop wraps it with line parsing.
 */
export function dispatch(state: RunnerState, req: { op: string; args?: unknown }): RunnerResponse {
  if (!state.initialized && req.op !== "init") {
    return err("INVALID_INPUT", { detail: "must init before any other op" });
  }
  switch (req.op) {
    case "init":
      return handleInit(state, req.args);
    case "version":
      return ok({ impl: IMPL_NAME, spec_version: SPEC_VERSION, impl_version: IMPL_VERSION });
    case "normalize":
      return handleNormalize(req.args);
    case "import":
      return handleImport(state, req.args);
    case "try_import":
      return handleTryImport(state, req.args);
    case "export":
      return handleExport(state, req.args);
    case "linked_query":
      return handleLinkedQuery(state, req.args);
    case "check_unit_legality":
      return handleCheckUnitLegality(state, req.args);
    case "check_roster_legality":
      return handleCheckRosterLegality(state, req.args);
    case "candidate_affordability":
      return handleCandidateAffordability(state, req.args);
    case "validate":
      return handleValidate(state, req.args);
    case "crunch":
      return handleCrunch(state, req.args);
    case "compare":
      return handleCompare(state, req.args);
    case "loadout":
      return handleLoadout(state, req.args);
    case "attribution":
      return handleAttribution(state, req.args);
    case "translate_scoring":
      return handleTranslateScoring(state, req.args);
    case "translate_effect":
      return handleTranslateEffect(req.args);
    case "match_applies_to":
      return handleMatchAppliesTo(req.args);
    case "score_event":
      return handleScoreEvent(state, req.args);
    case "score_state":
      return handleScoreState(state, req.args);
    case "wtc_result":
      return handleWtcResult(req.args);
    case "resolve_terrain":
      return handleResolveTerrain(req.args);
    case "keystones":
      return handleKeystones(req.args);
    case "share_encode":
      return handleShareEncode(req.args);
    case "share_decode":
      return handleShareDecode(req.args);
    case "shutdown":
      return ok(null);
    default:
      return err("UNKNOWN_OP", { op: req.op });
  }
}

/**
 * Process one line of stdin (one NDJSON request) and return the line that
 * should be written to stdout (one NDJSON response). Returns `null` only on
 * fully-empty input lines, which should be silently ignored.
 */
export function processRequest(state: RunnerState, line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let req: { op?: unknown; args?: unknown };
  try {
    req = JSON.parse(trimmed);
  } catch (e) {
    return JSON.stringify(err("INVALID_INPUT", { detail: `not valid JSON: ${(e as Error).message}` }));
  }
  if (typeof req.op !== "string") {
    return JSON.stringify(err("INVALID_INPUT", { detail: "request must have a string `op` field" }));
  }
  const response = dispatch(state, { op: req.op, args: req.args });
  return JSON.stringify(response);
}

// -----------------------------------------------------------------------------
// CLI: wire stdin/stdout. Only runs when this file is the process entry point.
// -----------------------------------------------------------------------------

function isCliMain(): boolean {
  // process.argv[1] is the path the runtime invoked. With tsx and node both,
  // it points at this file (or its compiled .js form). Comparing absolute
  // paths is the most robust portable check.
  if (!process.argv[1]) return false;
  const entry = process.argv[1];
  const here = fileURLToPath(import.meta.url);
  return entry === here || entry.endsWith("/runner.js") || entry.endsWith("/runner.ts");
}

async function runCli(): Promise<void> {
  const state = createRunnerState();
  const rl = createInterface({ input: process.stdin });
  // We must respond on the same tick the request arrives — the differ
  // pipelines requests and expects responses in order. readline preserves
  // line ordering, so processing inside `line` handler is sufficient.
  for await (const line of rl) {
    const out = processRequest(state, line);
    if (out !== null) {
      process.stdout.write(out + "\n");
    }
    // `shutdown` returns `ok(null)`; honor it by exiting after the response
    // is flushed.
    try {
      const req = JSON.parse(line);
      if (req && req.op === "shutdown") {
        process.exit(0);
      }
    } catch {
      // already handled above; not a shutdown
    }
  }
}

if (isCliMain()) {
  runCli().catch((e) => {
    // Last-ditch INTERNAL_ERROR so the differ sees a typed failure rather
    // than an opaque crash.
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error_kind: "INTERNAL_ERROR",
        error_payload: { detail: (e as Error).message },
      }) + "\n",
    );
    process.exit(1);
  });
}
