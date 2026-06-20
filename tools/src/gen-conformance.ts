/**
 * Generate the cross-implementation conformance corpus under repo-root
 * `conformance/`. The TypeScript package is the reference implementation, so
 * the goldens it emits are what the Rust crate must reproduce byte-for-byte
 * (structurally). Run via `npm run gen:conformance`; CI regenerates and asserts
 * `git diff --exit-code conformance/` is clean.
 *
 * Outputs:
 * - `conformance/normalize.json` — `[{ input, expected }]` for normalizeName.
 * - `conformance/roster/<case>/expected.roster.json` — the resolved Roster.
 * - `conformance/roster/<case>/expected.<fmt>.{txt,json}` — every export
 *   target's golden output. The TS exporter is the oracle; the Rust mirror
 *   asserts byte-equal output for the same Roster.
 * - `conformance/roster/<case>/input.newrecruit-{wtc-compact,wtc-full,simple}.txt`
 *   — text inputs derived from the seed by the exporter, so a re-import
 *   regression in either implementation surfaces immediately.
 *
 * Seeding: each `<case>/` carries one canonical input — either the legacy
 * `input.json` (ListForge) or `input.newrecruit-json.json` (NewRecruit). Other
 * inputs are derived.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Dataset } from "./data/dataset.js";
import { baseLoadout } from "./data/loadout.js";
import { normalizeName } from "./data/normalize.js";
import { describeScoringCard, describeAbility, type Effect, type AbilityUsage, type AbilityTrigger } from "./translate/index.js";
import type { GameEvent } from "./generated.js";
import { awardsOf } from "./scoring/index.js";
import { createRunnerState, dispatch } from "./runner.js";
import { exportRoster, type ExportFormat } from "./export/index.js";
import {
  decodeShareToken,
  encodeShareToken,
  shareRegistryVersion,
  type ShareList,
} from "./share/index.js";
import { importRoster, REGISTERED_ADAPTERS } from "./import/import-roster.js";
import { selectAdapter } from "./import/adapter.js";
import type { ParsedRoster, Roster } from "./import/types.js";
import { encodeBase } from "./runner.js";
import { attributeStages } from "./cruncher/attribution.js";
import type { EngineInput } from "./cruncher/index.js";
import {
  resolveLayout,
  type TerrainTemplate as ResolverTemplate,
  type TerrainLayout as ResolverLayout,
} from "./terrain/resolve.js";
import { keystoneMeasurements, BOARD_INCHES } from "./terrain/keystones.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const CONFORMANCE = join(REPO_ROOT, "conformance");

const NORMALIZE_INPUTS = [
  // NFD diacritic strip
  "Khârn the Betrayer",
  "Brôkhyr",
  "Ûthar",
  "Magnús",
  // apostrophe / quote variants
  "T'au",
  "Be’lakor",
  "Kor’sarro Khan",
  "Aetaos'rau'keres",
  "‘quoted’",
  // whitespace / hyphen collapse + trim
  "Brôkhyr Iron-master",
  "  the   betrayer  ",
  "space--marines",
  // casefold
  "KHÂRN THE BETRAYER",
  // already-normalized (idempotence)
  "kharn the betrayer",
  // distinctness anchors (must NOT collapse together)
  "Khorne",
  "Khârn",
  // Unicode whitespace beyond ASCII — every Unicode whitespace must collapse
  // identically across implementations or `find("Khorne Lord")` and
  // `find("Khorne Lord")` will silently disagree across ports.
  "Khorne Lord",
  "Khorne　Lord",
  // Turkish dotted-I: NFD decomposes to `I` + combining dot above; the dot is
  // stripped, then locale-independent lowercase yields `i`. The case pins that
  // no implementation introduces locale-aware casefolding (which would map
  // `I` → `ı` under Turkish locale and break ASCII-text search).
  "İmperial Fists",
  // Zero-width joiner: passes through every step today. Pinned so behavior
  // does not silently change — if a future commit strips Cf-category chars,
  // this golden updates in the same PR.
  "Khorne‍Lord",
];

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path: string, value: string): void {
  writeFileSync(path, value);
}

function genNormalize(): void {
  const table = NORMALIZE_INPUTS.map((input) => ({ input, expected: normalizeName(input) }));
  writeJson(join(CONFORMANCE, "normalize.json"), table);
  console.log(`normalize.json: ${table.length} cases`);
}

/** Locate the canonical input for a fixture dir: prefer `input.json` (legacy
 * ListForge), then `input.newrecruit-json.json` (NewRecruit), then the
 * text-only `input.gw.txt` / `input.listforge-text.txt` (app text exports —
 * import-only, like ListForge). */
function seedRoster(caseDir: string, ds: Dataset): Roster {
  const decoded = decodeCanonicalSeed(caseDir);
  return importRoster(decoded, { dataset: ds });
}

/** Return the decoded payload for the canonical seed — the same value the
 * import pipeline would dispatch on. JSON seeds come back parsed; text seeds
 * come back as the raw string. */
function decodeCanonicalSeed(caseDir: string): unknown {
  const jsonSeed = join(caseDir, "input.json");
  if (existsSync(jsonSeed)) {
    return JSON.parse(readFileSync(jsonSeed, "utf8"));
  }
  const nrSeed = join(caseDir, "input.newrecruit-json.json");
  if (existsSync(nrSeed)) {
    return JSON.parse(readFileSync(nrSeed, "utf8"));
  }
  const gwSeed = join(caseDir, "input.gw.txt");
  if (existsSync(gwSeed)) {
    return readFileSync(gwSeed, "utf8");
  }
  const lfTextSeed = join(caseDir, "input.listforge-text.txt");
  if (existsSync(lfTextSeed)) {
    return readFileSync(lfTextSeed, "utf8");
  }
  // A hand-authored canonical Roster (roster-json) — the lossless carrier used
  // for cases that no upstream format can yet express, e.g. multi-detachment
  // 11e lists. Like the legacy seeds it is import-only (no derived round-trip
  // inputs are generated), since the text/header exporters print every
  // detachment but their importers read only one.
  const rosterJsonSeed = join(caseDir, "input.roster-json.json");
  if (existsSync(rosterJsonSeed)) {
    return JSON.parse(readFileSync(rosterJsonSeed, "utf8"));
  }
  throw new Error(`no canonical input found in ${caseDir}`);
}

/** Run a decoded payload through the adapter pipeline up to (but not past)
 * resolution. The result is the format-agnostic ParsedRoster — the same
 * intermediate the resolver consumes. Pinning this layer surfaces parser
 * regressions even when resolution masks them. */
function parsedFromCanonicalSeed(caseDir: string): ParsedRoster {
  const decoded = decodeCanonicalSeed(caseDir);
  const adapter = selectAdapter(decoded, [...REGISTERED_ADAPTERS]);
  return adapter.parse(decoded);
}

const TEXT_FORMATS: { format: ExportFormat; inputName: string; goldenName: string }[] = [
  {
    format: "newrecruit-wtc-compact",
    inputName: "input.newrecruit-wtc-compact.txt",
    goldenName: "expected.newrecruit-wtc-compact.txt",
  },
  {
    format: "newrecruit-wtc-full",
    inputName: "input.newrecruit-wtc-full.txt",
    goldenName: "expected.newrecruit-wtc-full.txt",
  },
  {
    format: "newrecruit-simple",
    inputName: "input.newrecruit-simple.txt",
    goldenName: "expected.newrecruit-simple.txt",
  },
];

function genRosters(): void {
  const ds = Dataset.embedded();
  const rosterDir = join(CONFORMANCE, "roster");
  for (const entry of readdirSync(rosterDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const caseDir = join(rosterDir, entry.name);

    const seed = seedRoster(caseDir, ds);
    writeJson(join(caseDir, "expected.roster.json"), seed);

    // Parsed-stage golden — the intermediate ParsedRoster produced by the
    // adapter for the canonical seed, before resolution. Catches parser bugs
    // that resolution would otherwise mask (e.g. wrong unit count from a
    // duplicate cost line that resolves to the same unit twice).
    writeJson(join(caseDir, "expected.parsed.json"), parsedFromCanonicalSeed(caseDir));

    // JSON export golden — NewRecruit-shaped skeleton.
    const jsonOut = exportRoster(seed, "newrecruit-json");
    writeJson(join(caseDir, "expected.newrecruit-json.json"), JSON.parse(jsonOut));

    // Canonical Roster JSON export — should equal the resolved roster.
    writeJson(join(caseDir, "expected.roster-json.json"), JSON.parse(exportRoster(seed, "roster-json")));

    // Text exports: always write the export golden so every fixture exercises
    // the cross-implementation byte-equality check. Only write the
    // `input.*.txt` round-trip seed when the fixture was authored for the
    // NewRecruit pipeline — legacy ListForge fixtures carry decoration
    // (multi-force warnings, leader-attachment inference) that the simple/wtc
    // exporters can't fully preserve, so the round-trip would fail
    // structurally rather than uncover a parser bug.
    const isNewRecruitSeed = existsSync(join(caseDir, "input.newrecruit-json.json"));
    // The header text formats (wtc-compact/full, simple) print every detachment
    // but their parsers read only one, so a multi-detachment roster can't
    // round-trip through them — emit the export golden but not the derived
    // round-trip input (the same reasoning as the legacy-ListForge skip).
    const textRoundTrippable = isNewRecruitSeed && seed.detachments.length <= 1;
    for (const { format, inputName, goldenName } of TEXT_FORMATS) {
      const out = exportRoster(seed, format);
      writeText(join(caseDir, goldenName), out);
      if (textRoundTrippable) {
        writeText(join(caseDir, inputName), out);
      }
    }

    // Rosterizer JSON export + a derived round-trip input. The exporter is
    // deterministic and round-trips through the adapter, so emitting it as
    // both `expected.rosterizer.json` and `input.rosterizer.json` pins the
    // cross-implementation goldens and the importer regression at the same
    // time. Same NewRecruit-seed gate as the text formats — multi-force
    // ListForge fixtures lose their provisional leader-attachment under
    // round-trip, so they only get the export golden, not the derived input.
    const rosterizerOut = exportRoster(seed, "rosterizer");
    writeJson(join(caseDir, "expected.rosterizer.json"), JSON.parse(rosterizerOut));
    if (isNewRecruitSeed) {
      writeJson(join(caseDir, "input.rosterizer.json"), JSON.parse(rosterizerOut));
    }

    console.log(
      `roster/${entry.name}: ${seed.units.length} units, ${seed.diagnostics.warnings.length} warnings`,
    );
  }
}

/**
 * Linked-API query cases. Each descriptor names a query method on Dataset, the
 * args to call it with, and how the result should be compared.
 *
 * `comparison: "ordered"` pins the result order — used for queries that iterate
 * a data-driven array (`unit.ability_ids`, `unit.weapon_ids`) where order is
 * encoded in the data and both implementations iterate it the same way.
 *
 * `comparison: "set"` pins only the set of ids — used for queries that walk an
 * index (faction → abilities, ability → phases) where iteration order depends
 * on dataset bundler internals and is incidental. Ids are sorted before
 * comparison.
 *
 * `comparison: "scalar"` pins a single id-or-null result (find_* and
 * faction_of(unit)).
 */
type LinkedApiQuery =
  | { name: string; query: "find_unit"; args: { query: string }; comparison: "scalar" }
  | { name: string; query: "find_weapon"; args: { query: string }; comparison: "scalar" }
  | { name: string; query: "find_faction"; args: { query: string }; comparison: "scalar" }
  | { name: string; query: "find_ability"; args: { query: string }; comparison: "scalar" }
  | { name: string; query: "abilities_of"; args: { unitId: string }; comparison: "ordered" }
  | { name: string; query: "weapons_of"; args: { unitId: string }; comparison: "ordered" }
  | { name: string; query: "phases_of"; args: { abilityId: string }; comparison: "set" }
  | { name: string; query: "faction_of"; args: { unitId: string }; comparison: "scalar" }
  | { name: string; query: "abilities_of_faction"; args: { factionId: string }; comparison: "set" }
  | { name: string; query: "weapons_of_faction"; args: { factionId: string }; comparison: "set" }
  | { name: string; query: "logo_url_of_faction"; args: { factionId: string }; comparison: "scalar" }
  | { name: string; query: "base_size_of"; args: { unitId: string }; comparison: "scalar" }
  | { name: string; query: "model_bases_of"; args: { unitId: string }; comparison: "ordered" }
  | { name: string; query: "base_loadout"; args: { unitId: string; modelCount: string }; comparison: "set" }
  | { name: string; query: "units_with_keyword"; args: { keyword: string }; comparison: "set" }
  | {
      name: string;
      query: "allies_for";
      args: { factionId: string; detachmentIds?: string[] };
      comparison: "ordered";
    }
  | { name: string; query: "ally_units_for"; args: { ruleId: string }; comparison: "set" }
  | { name: string; query: "reactive_trigger_ability_ids"; args: Record<string, never>; comparison: "ordered" }
  | { name: string; query: "events_with_triggers"; args: Record<string, never>; comparison: "ordered" }
  | { name: string; query: "triggers_for_event"; args: { event: string }; comparison: "ordered" };

const LINKED_API_QUERIES: LinkedApiQuery[] = [
  // find_unit: diacritic-insensitive lookup, miss returns null.
  { name: "find_unit by diacritic name", query: "find_unit", args: { query: "Kharn" }, comparison: "scalar" },
  { name: "find_unit miss returns null", query: "find_unit", args: { query: "not-a-real-unit-xyz" }, comparison: "scalar" },
  // find_weapon: hyphen + space tolerance.
  { name: "find_weapon by name", query: "find_weapon", args: { query: "bolt rifle" }, comparison: "scalar" },
  // find_faction: punctuation/diacritic tolerance.
  { name: "find_faction by display name", query: "find_faction", args: { query: "World Eaters" }, comparison: "scalar" },
  // find_ability: ability name lookup.
  { name: "find_ability by name", query: "find_ability", args: { query: "Berzerker Frenzy" }, comparison: "scalar" },
  // abilities_of(unit): ordered, iterates unit.ability_ids array.
  { name: "abilities_of intercessor-squad", query: "abilities_of", args: { unitId: "intercessor-squad" }, comparison: "ordered" },
  { name: "abilities_of kharn-the-betrayer", query: "abilities_of", args: { unitId: "kharn-the-betrayer" }, comparison: "ordered" },
  // weapons_of(unit): ordered, iterates unit.weapon_ids array.
  { name: "weapons_of intercessor-squad", query: "weapons_of", args: { unitId: "intercessor-squad" }, comparison: "ordered" },
  { name: "weapons_of kharn-the-betrayer", query: "weapons_of", args: { unitId: "kharn-the-betrayer" }, comparison: "ordered" },
  // phases_of(ability): compared as set (phase index iteration order is incidental).
  { name: "phases_of berzerker-frenzy", query: "phases_of", args: { abilityId: "berzerker-frenzy" }, comparison: "set" },
  // faction_of(unit): scalar id or null.
  { name: "faction_of intercessor-squad", query: "faction_of", args: { unitId: "intercessor-squad" }, comparison: "scalar" },
  // abilities_of_faction: compared as set (collection-index order is incidental).
  { name: "abilities_of_faction world-eaters", query: "abilities_of_faction", args: { factionId: "world-eaters" }, comparison: "set" },
  // weapons_of_faction: compared as set.
  { name: "weapons_of_faction world-eaters", query: "weapons_of_faction", args: { factionId: "world-eaters" }, comparison: "set" },
  // logo_url_of_faction: scalar logo URL string, or null if unset.
  { name: "logo_url_of_faction adepta-sororitas", query: "logo_url_of_faction", args: { factionId: "adepta-sororitas" }, comparison: "scalar" },
  // base_size_of(unit): scalar encoded base — round, oval, and a draft flying-base.
  { name: "base_size_of intercessor-squad", query: "base_size_of", args: { unitId: "intercessor-squad" }, comparison: "scalar" },
  { name: "base_size_of vertus-praetors", query: "base_size_of", args: { unitId: "vertus-praetors" }, comparison: "scalar" },
  { name: "base_size_of windriders (draft flying base)", query: "base_size_of", args: { unitId: "windriders" }, comparison: "scalar" },
  // model_bases_of(unit): ordered per-model bases; jakhals mixes 28.5mm bodies with a 40mm Dishonoured.
  { name: "model_bases_of jakhals (mixed)", query: "model_bases_of", args: { unitId: "jakhals" }, comparison: "ordered" },
  // units_with_keyword: case-insensitive over keywords ∪ faction_keywords; compared as set.
  { name: "units_with_keyword Khorne", query: "units_with_keyword", args: { keyword: "Khorne" }, comparison: "set" },
  { name: "units_with_keyword damned (lowercase)", query: "units_with_keyword", args: { keyword: "damned" }, comparison: "set" },
  // allies_for: two-gate offer; ordered (allied-rules data-file order, locale-independent).
  { name: "allies_for chaos-knights (no detachment)", query: "allies_for", args: { factionId: "chaos-knights" }, comparison: "ordered" },
  { name: "allies_for chaos-knights with iconoclast-fiefdom", query: "allies_for", args: { factionId: "chaos-knights", detachmentIds: ["iconoclast-fiefdom"] }, comparison: "ordered" },
  { name: "allies_for world-eaters (two pools)", query: "allies_for", args: { factionId: "world-eaters" }, comparison: "ordered" },
  { name: "allies_for genestealer-cults with final-day", query: "allies_for", args: { factionId: "genestealer-cults", detachmentIds: ["final-day"] }, comparison: "ordered" },
  // ally_units_for: resolved pool; compared as set (accessor sorts by name, locale-dependent).
  { name: "ally_units_for iconoclast-fiefdom-damned", query: "ally_units_for", args: { ruleId: "iconoclast-fiefdom-damned" }, comparison: "set" },
  { name: "ally_units_for world-eaters-khorne-daemons", query: "ally_units_for", args: { ruleId: "world-eaters-khorne-daemons" }, comparison: "set" },
  { name: "ally_units_for star-childrens-blessings (excludes broodlord/genestealers)", query: "ally_units_for", args: { ruleId: "star-childrens-blessings" }, comparison: "set" },
  // base_loadout(unit, modelCount): the pinned legal default loadout, encoded as a
  // sorted "weaponId:count" multiset. chaos-terminators is a uniform squad (per-model
  // scaling); crusader-squad exercises leader+bulk per-figure allocation.
  { name: "base_loadout chaos-terminators @5 (legal default, no swaps)", query: "base_loadout", args: { unitId: "chaos-terminators", modelCount: "5" }, comparison: "set" },
  { name: "base_loadout chaos-terminators @10 scales per model", query: "base_loadout", args: { unitId: "chaos-terminators", modelCount: "10" }, comparison: "set" },
  { name: "base_loadout crusader-squad @10 exercises leader+bulk allocation", query: "base_loadout", args: { unitId: "crusader-squad", modelCount: "10" }, comparison: "set" },
  // reactive triggers: reactiveTriggers() sorts by ability id; triggerIndex() keys are
  // event-sorted and each bucket ability-id-sorted, so all three are order-pinned.
  { name: "reactive_trigger_ability_ids (all triggered abilities)", query: "reactive_trigger_ability_ids", args: {}, comparison: "ordered" },
  { name: "events_with_triggers (index keys)", query: "events_with_triggers", args: {}, comparison: "ordered" },
  { name: "triggers_for_event start-of-phase", query: "triggers_for_event", args: { event: "start-of-phase" }, comparison: "ordered" },
  { name: "triggers_for_event on-unit-selected", query: "triggers_for_event", args: { event: "on-unit-selected" }, comparison: "ordered" },
];

function genLinkedApi(): void {
  const ds = Dataset.embedded();
  const cases = LINKED_API_QUERIES.map((q) => {
    const expected = runLinkedQuery(ds, q);
    return { ...q, expected };
  });
  writeJson(join(CONFORMANCE, "linked-api", "cases.json"), cases);
  console.log(`linked-api/cases.json: ${cases.length} cases`);
}

function runLinkedQuery(ds: Dataset, q: LinkedApiQuery): string | null | string[] {
  switch (q.query) {
    case "find_unit":
      return ds.units.find(q.args.query)?.id ?? null;
    case "find_weapon":
      return ds.weapons.find(q.args.query)?.id ?? null;
    case "find_faction":
      return ds.factions.find(q.args.query)?.id ?? null;
    case "find_ability":
      return ds.abilities.find(q.args.query)?.id ?? null;
    case "abilities_of": {
      const u = ds.units.getAny(q.args.unitId);
      if (!u) throw new Error(`abilities_of: unknown unit ${q.args.unitId}`);
      return u.abilities.map((a) => a.id);
    }
    case "weapons_of": {
      const u = ds.units.getAny(q.args.unitId);
      if (!u) throw new Error(`weapons_of: unknown unit ${q.args.unitId}`);
      return u.weapons.map((w) => w.id);
    }
    case "phases_of": {
      const a = ds.abilities.get(q.args.abilityId);
      if (!a) throw new Error(`phases_of: unknown ability ${q.args.abilityId}`);
      return [...a.phases].sort();
    }
    case "faction_of": {
      const u = ds.units.getAny(q.args.unitId);
      if (!u) throw new Error(`faction_of: unknown unit ${q.args.unitId}`);
      return u.faction?.id ?? null;
    }
    case "abilities_of_faction":
      return ds.abilities.byFaction(q.args.factionId).map((a) => a.id).sort();
    case "weapons_of_faction": {
      // Mirrors Rust `weapons_of_faction`: aggregate weapons across the
      // faction's units and dedupe by id. The collection-level
      // `weapons.byFaction()` is a different operation (it looks up weapons
      // whose own `faction_id` is set, which is empty for most factions).
      const f = ds.factions.get(q.args.factionId);
      if (!f) throw new Error(`weapons_of_faction: unknown faction ${q.args.factionId}`);
      return f.weapons.map((w) => w.id).sort();
    }
    case "logo_url_of_faction": {
      const f = ds.factions.get(q.args.factionId);
      if (!f) throw new Error(`logo_url_of_faction: unknown faction ${q.args.factionId}`);
      return f.logoUrl ?? null;
    }
    case "base_size_of": {
      const u = ds.units.getAny(q.args.unitId);
      if (!u) throw new Error(`base_size_of: unknown unit ${q.args.unitId}`);
      return encodeBase(u.raw.base_size_mm);
    }
    case "model_bases_of": {
      const u = ds.units.getAny(q.args.unitId);
      if (!u) throw new Error(`model_bases_of: unknown unit ${q.args.unitId}`);
      const comp = ds.unitCompositions.find((c) => c.unit_id === q.args.unitId);
      return (comp?.models ?? []).map((m) => `${m.name}=${encodeBase(m.base_size_mm) ?? "none"}`);
    }
    case "base_loadout": {
      // Mirrors the runner's base_loadout op: the legal default loadout encoded as
      // a sorted "id:count" multiset (set-compared).
      const u = ds.units.getAny(q.args.unitId);
      if (!u) throw new Error(`base_loadout: unknown unit ${q.args.unitId}`);
      const comp = ds.unitCompositions.find((c) => c.unit_id === q.args.unitId);
      const lo = baseLoadout(u.raw, Number(q.args.modelCount), ds.wargearOptionsOf(u.raw), comp?.models);
      return [...lo.counts].map(([id, n]) => `${id}:${n}`).sort();
    }
    case "units_with_keyword":
      return ds.unitsWithKeyword(q.args.keyword).map((u) => u.id).sort();
    case "allies_for":
      // Ordered: allied-rules data-file order (deterministic across impls).
      return ds.alliesFor(q.args.factionId, q.args.detachmentIds ?? []).map((r) => r.id);
    case "ally_units_for":
      return ds.allyUnitsFor(q.args.ruleId).map((u) => u.id).sort();
    case "reactive_trigger_ability_ids":
      return ds.reactiveTriggers().map((rt) => rt.abilityId);
    case "events_with_triggers":
      return [...ds.triggerIndex().keys()];
    case "triggers_for_event":
      return (ds.triggerIndex().get(q.args.event as GameEvent) ?? []).map((rt) => rt.abilityId);
  }
}

/**
 * Attribution corpus: reuses the existing cruncher inputs from the cases that
 * carry at least one groupable buff (ability or manual). The expected shape
 * is the AttributedStage array produced by attributeStages; both
 * implementations of the leave-one-out decomposition must reproduce it
 * within the per-stage float tolerance.
 */
const ATTRIBUTION_CASE_FILES = [
  "05-anti-infantry-vs-cultist.json",
  "07-twin-linked-heavy-stationary-vs-knight.json",
];

interface CruncherCaseInput {
  name: string;
  attacker: { weaponId: string; profileIndex: number };
  modelsFiring: number;
  target: { unitId: string; profileIndex: number; modelCount?: number };
  context: EngineInput["context"];
  buffs: EngineInput["buffs"];
}

function loadAttributionInput(ds: Dataset, filename: string): {
  name: string;
  input: EngineInput;
} {
  const path = join(CONFORMANCE, "cruncher", filename);
  const c = JSON.parse(readFileSync(path, "utf8")) as CruncherCaseInput;
  const weapon = ds.weapons.get(c.attacker.weaponId);
  const unit = ds.units.getAny(c.target.unitId);
  if (!weapon) throw new Error(`attribution: unknown weapon ${c.attacker.weaponId}`);
  if (!unit) throw new Error(`attribution: unknown unit ${c.target.unitId}`);
  return {
    name: c.name,
    input: {
      attacker: { weapon: weapon.raw, profileIndex: c.attacker.profileIndex },
      target: {
        unit: unit.raw,
        profileIndex: c.target.profileIndex,
        ...(c.target.modelCount !== undefined ? { modelCount: c.target.modelCount } : {}),
      },
      modelsFiring: c.modelsFiring,
      buffs: c.buffs,
      context: c.context,
    },
  };
}

function genAttribution(): void {
  const ds = Dataset.embedded();
  const cases = ATTRIBUTION_CASE_FILES.map((filename, idx) => {
    const { name, input } = loadAttributionInput(ds, filename);
    const stages = attributeStages(input, ds);
    return {
      // Persist the input by file reference so the corpus stays a single
      // source of truth — the cruncher case file already pins the EngineInput.
      name,
      cruncher_case: filename,
      expected: stages.map((s) => ({
        name: s.name,
        expected: s.expected,
        baseline: s.baseline,
        lifts: s.lifts.map((l) => ({ source: l.source, delta: l.delta })),
        residual: s.residual,
        intrinsics: s.intrinsics,
      })),
      // Stable ordering of cases in the corpus file.
      _order: idx,
    };
  });
  // Sort by _order and strip the helper before writing.
  cases.sort((a, b) => a._order - b._order);
  const serialised = cases.map(({ _order: _o, ...rest }) => rest);
  writeJson(join(CONFORMANCE, "attribution", "cases.json"), serialised);
  console.log(`attribution/cases.json: ${cases.length} cases`);
}

/**
 * Scoring-card translation corpus: humanize each primary mission card's
 * `awards` into plain English. The TS translator is the oracle; the Rust port
 * must reproduce every string byte-for-byte (the differ compares structurally,
 * no tolerance). Only `card_type: "primary"` cards are pinned — the 14-card
 * secondary deck isn't revealed yet. Cases are sorted by id for stability, and
 * the `awards` array order within each card is load-bearing.
 */
function genScoringTranslation(): void {
  const ds = Dataset.embedded();
  mkdirSync(join(CONFORMANCE, "scoring-translation"), { recursive: true });
  // Pin the translation of every mission card's awards — primary and secondary
  // alike (the secondary deck has the same `awards` shape and deserves the same
  // cross-impl pinning).
  const cases = ds.missionCards.all
    .filter((c) => c.card_type === "primary" || c.card_type === "secondary")
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((card) => ({ cardId: card.id, expected: { awards: describeScoringCard(card) } }));
  writeJson(join(CONFORMANCE, "scoring-translation", "cases.json"), cases);
  console.log(`scoring-translation/cases.json: ${cases.length} cases`);
}

/**
 * Scoring-engine corpus: pin the pure VP arithmetic of the scoring engine
 * (`tools/src/scoring/` — the oracle) so the Rust `wh40kdc::scoring` port
 * reproduces it. Three ops, each case `{ name, op, args, expected }`:
 *
 * - `score_event` — per card and approach, assert every award matching the
 *   approach (by its full-`awards`-array index). Pins `scoreAward`, `scoreTurn`
 *   (exclusive-group "highest only", `vp_per × count` clamped to `per_max`,
 *   cumulative sums), `scoreCap` (tactical 5 vs fixed `vp_max`/uncapped), and
 *   `scoreSecondaryEvent`; primary cards also carry a `roundCap` to pin
 *   `scorePrimaryEvent`. `cap: null` means uncapped (Infinity has no JSON form).
 * - `score_state` — replay scenarios over a `PlayerGame`, pinning the per-round
 *   cap (15), per-game primary cap (45), grand-total cap (100), score+discard,
 *   and undo.
 * - `wtc_result` — the 20-point band mapping across its boundaries.
 *
 * Goldens are produced by driving the TS runner's own `dispatch`, so the corpus
 * and the runner agree by construction; the cross-impl contract is the Rust
 * runner reproducing them. Integers are compared exactly (no tolerance).
 */
function genScoring(): void {
  const ds = Dataset.embedded();
  mkdirSync(join(CONFORMANCE, "scoring"), { recursive: true });

  // One initialized runner state, reused across cases (the ops don't mutate it).
  const specVersion = Number.parseInt(
    readFileSync(join(CONFORMANCE, "SPEC_VERSION"), "utf8").trim(),
    10,
  );
  const state = createRunnerState();
  const init = dispatch(state, {
    op: "init",
    args: { spec_version: specVersion, locale: "C", tz: "UTC", seed: 0 },
  });
  if (!init.ok) throw new Error(`gen scoring: init failed: ${JSON.stringify(init)}`);
  const run = (op: string, args: unknown): unknown => {
    const r = dispatch(state, { op, args });
    if (!r.ok) throw new Error(`gen scoring: ${op} failed: ${JSON.stringify(r)} for ${JSON.stringify(args)}`);
    return r.value;
  };

  type Case = { name: string; op: string; args: unknown; expected: unknown };
  const cases: Case[] = [];

  // score_event: every mission card, both approaches. Assert the approach's
  // awards by their full-array index; count vp_per awards to their per_max
  // (else 2) so the cap logic actually bites.
  const cards = ds.missionCards.all
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const card of cards) {
    for (const approach of ["fixed", "tactical"] as const) {
      const asserted = awardsOf(card)
        .map((aw, index) => ({ aw, index }))
        .filter(({ aw }) => aw.mode == null || aw.mode === approach)
        .map(({ aw, index }) =>
          aw.vp_per != null ? { index, count: aw.per_max ?? 2 } : { index },
        );
      const args: Record<string, unknown> = { cardId: card.id, approach, asserted };
      if (card.card_type === "primary") args.roundCap = 15;
      cases.push({
        name: `score_event/${card.id}/${approach}`,
        op: "score_event",
        args,
        expected: run("score_event", args),
      });
    }
  }

  // score_state: hand-authored replay scenarios. Card ids are real deck/mission
  // cards; expected state is whatever the engine produces.
  const stateScenarios: { name: string; args: unknown }[] = [
    {
      name: "primary-round-and-game-caps",
      args: {
        approach: "tactical",
        ops: [
          { kind: "set-primary", round: 1, vp: 30, roundCap: 15, gameCap: 45 },
          { kind: "set-primary", round: 2, vp: 30, roundCap: 15, gameCap: 45 },
          { kind: "set-primary", round: 3, vp: 30, roundCap: 15, gameCap: 45 },
          { kind: "set-primary", round: 4, vp: 30, roundCap: 15, gameCap: 45 },
        ],
      },
    },
    {
      // The full primary path: a card's raw round total, clamped to the round
      // cap on store, then cleared back to 0 by a set-primary 0.
      name: "score-primary-then-clear",
      args: {
        approach: "tactical",
        ops: [
          {
            kind: "score-primary",
            cardId: "battlefield-dominance",
            round: 2,
            asserted: awardsOf(ds.missionCards.get("battlefield-dominance")!).map((aw, index) =>
              aw.vp_per != null ? { index, count: aw.per_max ?? 3 } : { index },
            ),
            roundCap: 15,
            gameCap: 45,
          },
          { kind: "set-primary", round: 3, vp: 99, roundCap: 15, gameCap: 45 },
          { kind: "set-primary", round: 2, vp: 0, roundCap: 15, gameCap: 45 },
        ],
      },
    },
    {
      name: "secondary-score-and-undo",
      args: {
        approach: "tactical",
        ops: [
          { kind: "draw", cardId: "no-prisoners" },
          { kind: "score-secondary", cardId: "no-prisoners", round: 2, asserted: [{ index: 0, count: 3 }] },
          { kind: "remove-score", index: 0 },
        ],
      },
    },
    {
      // Uncapped set-primary (no caps) overshoots so the 100 grand-total cap bites.
      name: "grand-total-cap-at-100",
      args: {
        approach: "tactical",
        ops: [
          { kind: "set-primary", round: 1, vp: 30 },
          { kind: "set-primary", round: 2, vp: 30 },
          { kind: "set-primary", round: 3, vp: 30 },
          { kind: "set-primary", round: 4, vp: 30 },
          { kind: "set-primary", round: 5, vp: 30 },
          { kind: "draw", cardId: "no-prisoners" },
          { kind: "score-secondary", cardId: "no-prisoners", round: 5, asserted: [{ index: 0, count: 99 }] },
        ],
      },
    },
  ];
  for (const s of stateScenarios) {
    cases.push({ name: `score_state/${s.name}`, op: "score_state", args: s.args, expected: run("score_state", s.args) });
  }

  // wtc_result: band boundaries and symmetry.
  const wtcPairs: [number, number][] = [
    [50, 50],
    [48, 45],
    [45, 50],
    [56, 50],
    [50, 61],
    [100, 50],
    [100, 49],
    [0, 100],
    [60, 40],
    [55, 50],
  ];
  for (const [a, b] of wtcPairs) {
    const args = { a, b };
    cases.push({ name: `wtc_result/${a}-${b}`, op: "wtc_result", args, expected: run("wtc_result", args) });
  }

  writeJson(join(CONFORMANCE, "scoring", "cases.json"), cases);
  console.log(`scoring/cases.json: ${cases.length} cases`);
}

/**
 * Terrain-resolver corpus: resolve template-anchored layouts to absolute
 * board-space vertices (y-down inches). The TS resolver is the oracle; the Rust
 * port must reproduce every vertex within 5e-4 (per-area invariant in
 * CONFORMANCE.md). Cases are self-contained — each carries its own `templates`
 * and `layout` — so the corpus does not depend on the bundled catalog and the
 * runner op can pass both in `args`. Coverage: per-template centroid anchoring
 * (identity), cardinal + oblique rotations, both mirror axes on an asymmetric
 * shape, embedded-feature composition, explicit parenting, and the inline
 * footprint escape hatch.
 */
function genTerrainResolver(): void {
  mkdirSync(join(CONFORMANCE, "terrain-resolver"), { recursive: true });

  const areaLarge: ResolverTemplate = {
    id: "area-large",
    name: "Large Area",
    kind: "area",
    footprint: { type: "rectangle", width: 11.5, height: 7 },
  };
  const areaMedium: ResolverTemplate = {
    id: "area-medium",
    name: "Medium Area",
    kind: "area",
    footprint: { type: "rectangle", width: 6, height: 4 },
  };
  const areaTrapezoid: ResolverTemplate = {
    id: "area-trapezoid",
    name: "Trapezoid Area",
    kind: "area",
    footprint: {
      type: "polygon",
      points: [
        { x: 0, y: 0 },
        { x: 8, y: 0 },
        { x: 2, y: 11.5 },
        { x: 0, y: 11.5 },
      ],
    },
  };
  const wedge: ResolverTemplate = {
    id: "wedge",
    name: "Right Wedge",
    kind: "area",
    footprint: { type: "right-triangle", width: 8, height: 11.5 },
  };
  const wallLong: ResolverTemplate = {
    id: "wall-long",
    name: "Long Wall",
    kind: "feature",
    footprint: { type: "rectangle", width: 7, height: 0.25 },
  };
  const ruinComposed: ResolverTemplate = {
    id: "ruin-composed",
    name: "Composed Ruin",
    kind: "area",
    footprint: { type: "rectangle", width: 11.5, height: 7 },
    features: [
      { id: "back-wall", template: "wall-long", position: { x: 0, y: -3 } },
      { id: "side-wall", template: "wall-long", position: { x: -5, y: 0 }, rotation_degrees: 90, mirror: "horizontal" },
    ],
  };

  const baseCatalog = [areaLarge, areaMedium, areaTrapezoid, wedge, wallLong];

  const layoutCases: { name: string; templates: ResolverTemplate[]; layout: ResolverLayout }[] = [
    {
      name: "identity-large",
      templates: baseCatalog,
      layout: { id: "c", name: "c", pieces: [{ id: "p", template: "area-large", position: { x: 30, y: 22 } }] },
    },
    {
      name: "identity-wedge",
      templates: baseCatalog,
      layout: { id: "c", name: "c", pieces: [{ id: "p", template: "wedge", position: { x: 12, y: 30 } }] },
    },
    {
      name: "identity-trapezoid",
      templates: baseCatalog,
      layout: { id: "c", name: "c", pieces: [{ id: "p", template: "area-trapezoid", position: { x: 40, y: 18 } }] },
    },
    {
      name: "rotate-medium-90",
      templates: baseCatalog,
      layout: { id: "c", name: "c", pieces: [{ id: "p", template: "area-medium", position: { x: 30, y: 22 }, rotation_degrees: 90 }] },
    },
    {
      name: "rotate-medium-180",
      templates: baseCatalog,
      layout: { id: "c", name: "c", pieces: [{ id: "p", template: "area-medium", position: { x: 30, y: 22 }, rotation_degrees: 180 }] },
    },
    {
      name: "rotate-medium-270",
      templates: baseCatalog,
      layout: { id: "c", name: "c", pieces: [{ id: "p", template: "area-medium", position: { x: 30, y: 22 }, rotation_degrees: 270 }] },
    },
    {
      name: "rotate-large-oblique-55",
      templates: baseCatalog,
      layout: { id: "c", name: "c", pieces: [{ id: "p", template: "area-large", position: { x: 30, y: 22 }, rotation_degrees: 55 }] },
    },
    {
      name: "rotate-trapezoid-oblique-235",
      templates: baseCatalog,
      layout: { id: "c", name: "c", pieces: [{ id: "p", template: "area-trapezoid", position: { x: 35.75, y: 27 }, rotation_degrees: 235 }] },
    },
    {
      name: "mirror-trapezoid-horizontal",
      templates: baseCatalog,
      layout: { id: "c", name: "c", pieces: [{ id: "p", template: "area-trapezoid", position: { x: 40, y: 18 }, mirror: "horizontal" }] },
    },
    {
      name: "mirror-trapezoid-vertical-rot90",
      templates: baseCatalog,
      layout: { id: "c", name: "c", pieces: [{ id: "p", template: "area-trapezoid", position: { x: 40, y: 18 }, rotation_degrees: 90, mirror: "vertical" }] },
    },
    {
      name: "composition-ruin-rot90-mirror-h",
      templates: [ruinComposed, wallLong],
      layout: { id: "c", name: "c", pieces: [{ id: "a1", template: "ruin-composed", position: { x: 30, y: 22 }, rotation_degrees: 90, mirror: "horizontal" }] },
    },
    {
      name: "explicit-parent-feature",
      templates: [areaLarge, wallLong],
      layout: {
        id: "c",
        name: "c",
        pieces: [
          { id: "a1", template: "area-large", position: { x: 30, y: 22 }, rotation_degrees: 90, mirror: "horizontal" },
          { id: "back-wall", template: "wall-long", parent_area_id: "a1", position: { x: 0, y: -3 } },
        ],
      },
    },
    {
      name: "inline-footprint-polygon",
      templates: [],
      layout: {
        id: "c",
        name: "c",
        pieces: [
          {
            id: "p",
            footprint: { type: "polygon", points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 5 }] },
            position: { x: 50, y: 40 },
            rotation_degrees: 30,
          },
        ],
      },
    },
  ];

  const cases = layoutCases.map((c) => ({
    name: c.name,
    templates: c.templates,
    layout: c.layout,
    expected: { pieces: resolveLayout(c.layout, c.templates) },
  }));
  writeJson(join(CONFORMANCE, "terrain-resolver", "cases.json"), cases);
  console.log(`terrain-resolver/cases.json: ${cases.length} cases`);
}

/**
 * Terrain-keystones corpus: derive the printed distance of each authored
 * keystone (board edge → piece feature) from resolved geometry. The TS helper
 * is the oracle; the Rust port must reproduce every distance within 5e-4.
 * Cases are self-contained like the resolver corpus. Coverage: all four
 * edges, vertex and bounding-face refs, an oblique rotation, a mirrored
 * asymmetric shape, a parented feature (composition through the parent
 * frame), an inline footprint, and a custom board size.
 */
function genTerrainKeystones(): void {
  mkdirSync(join(CONFORMANCE, "terrain-keystones"), { recursive: true });

  const areaLarge: ResolverTemplate = {
    id: "area-large",
    name: "Large Area",
    kind: "area",
    footprint: { type: "rectangle", width: 11.5, height: 7 },
  };
  const areaTrapezoid: ResolverTemplate = {
    id: "area-trapezoid",
    name: "Trapezoid Area",
    kind: "area",
    footprint: {
      type: "polygon",
      points: [
        { x: 0, y: 0 },
        { x: 8, y: 0 },
        { x: 2, y: 11.5 },
        { x: 0, y: 11.5 },
      ],
    },
  };
  const wallLong: ResolverTemplate = {
    id: "wall-long",
    name: "Long Wall",
    kind: "feature",
    footprint: { type: "rectangle", width: 7, height: 0.25 },
  };
  const catalog = [areaLarge, areaTrapezoid, wallLong];

  const keystoneCases: {
    name: string;
    templates: ResolverTemplate[];
    layout: ResolverLayout;
    board?: { width: number; height: number };
  }[] = [
    {
      name: "identity-four-edges-vertices",
      templates: catalog,
      layout: {
        id: "c",
        name: "c",
        pieces: [
          {
            id: "p",
            template: "area-large",
            position: { x: 30, y: 22 },
            keystones: [
              { edge: "left", ref: { kind: "vertex", index: 0 } },
              { edge: "top", ref: { kind: "vertex", index: 1 } },
              { edge: "right", ref: { kind: "vertex", index: 2 } },
              { edge: "bottom", ref: { kind: "vertex", index: 3 } },
            ],
          },
        ],
      },
    },
    {
      name: "identity-bounding-faces",
      templates: catalog,
      layout: {
        id: "c",
        name: "c",
        pieces: [
          {
            id: "p",
            template: "area-large",
            position: { x: 20, y: 30 },
            keystones: [
              { edge: "left", ref: { kind: "face", side: "min-x" } },
              { edge: "right", ref: { kind: "face", side: "max-x" } },
              { edge: "top", ref: { kind: "face", side: "min-y" } },
              { edge: "bottom", ref: { kind: "face", side: "max-y" } },
            ],
          },
        ],
      },
    },
    {
      name: "oblique-rotation-vertex",
      templates: catalog,
      layout: {
        id: "c",
        name: "c",
        pieces: [
          {
            id: "p",
            template: "area-trapezoid",
            position: { x: 35.75, y: 27 },
            rotation_degrees: 235,
            keystones: [
              { edge: "left", ref: { kind: "vertex", index: 2 } },
              { edge: "bottom", ref: { kind: "face", side: "max-y" } },
            ],
          },
        ],
      },
    },
    {
      name: "mirrored-trapezoid-vertex",
      templates: catalog,
      layout: {
        id: "c",
        name: "c",
        pieces: [
          {
            id: "p",
            template: "area-trapezoid",
            position: { x: 40, y: 18 },
            mirror: "horizontal",
            keystones: [
              { edge: "right", ref: { kind: "vertex", index: 1 } },
              { edge: "top", ref: { kind: "vertex", index: 0 } },
            ],
          },
        ],
      },
    },
    {
      name: "parented-feature-keystone",
      templates: catalog,
      layout: {
        id: "c",
        name: "c",
        pieces: [
          {
            id: "a1",
            template: "area-large",
            position: { x: 30, y: 22 },
            rotation_degrees: 90,
            mirror: "horizontal",
            keystones: [{ edge: "left", ref: { kind: "vertex", index: 0 } }],
          },
          {
            id: "back-wall",
            template: "wall-long",
            parent_area_id: "a1",
            position: { x: 0, y: -3 },
            keystones: [
              { edge: "top", ref: { kind: "vertex", index: 1 } },
              { edge: "right", ref: { kind: "face", side: "max-x" } },
            ],
          },
        ],
      },
    },
    {
      name: "inline-footprint-keystone",
      templates: [],
      layout: {
        id: "c",
        name: "c",
        pieces: [
          {
            id: "p",
            footprint: { type: "polygon", points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 5 }] },
            position: { x: 50, y: 40 },
            rotation_degrees: 30,
            keystones: [
              { edge: "right", ref: { kind: "vertex", index: 0 } },
              { edge: "bottom", ref: { kind: "vertex", index: 2 } },
            ],
          },
        ],
      },
    },
    {
      name: "custom-board-extents",
      templates: catalog,
      layout: {
        id: "c",
        name: "c",
        pieces: [
          {
            id: "p",
            template: "area-large",
            position: { x: 15, y: 15 },
            keystones: [
              { edge: "right", ref: { kind: "face", side: "max-x" } },
              { edge: "bottom", ref: { kind: "face", side: "max-y" } },
            ],
          },
        ],
      },
      board: { width: 30, height: 22.4 },
    },
  ];

  const cases = keystoneCases.map((c) => ({
    name: c.name,
    templates: c.templates,
    layout: c.layout,
    ...(c.board ? { board: c.board } : {}),
    expected: {
      measurements: keystoneMeasurements(c.layout, c.templates, c.board ?? BOARD_INCHES),
    },
  }));
  writeJson(join(CONFORMANCE, "terrain-keystones", "cases.json"), cases);
  console.log(`terrain-keystones/cases.json: ${cases.length} cases`);
}

/**
 * Effect-translation corpus: pin the Ability-DSL effect describer
 * (`describeEffect`/`describeAbility` — the "ability.print()") across the TS
 * and Rust ports. Cases embed the raw `effect` (+ `scope`) so parity does not
 * depend on collection dup-id resolution; selection greedily covers every
 * effect node type at least once (up to 5 exemplars per type) over the
 * id-sorted ability list, so the corpus stays small but exhaustive by shape.
 */
function genEffectTranslation(): void {
  const ds = Dataset.embedded();
  mkdirSync(join(CONFORMANCE, "effect-translation"), { recursive: true });

  const collectTypes = (e: unknown, out: Set<string>): void => {
    if (Array.isArray(e)) {
      for (const v of e) collectTypes(v, out);
      return;
    }
    if (typeof e !== "object" || e === null) return;
    const rec = e as Record<string, unknown>;
    if (typeof rec.type === "string") out.add(rec.type);
    for (const key of ["effect", "on_success", "on_fail", "steps", "options", "condition"]) {
      if (key in rec) collectTypes(rec[key], out);
    }
  };

  const abilities = ds.abilities.all
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const seen = new Map<string, number>();
  const CAP = 5;
  // Also cover the `applies_to` render path: force-include a few abilities that
  // carry a curated filter even when their effect-node types are already
  // exhausted, so the trailing `Applies to:` line stays pinned cross-impl.
  const APPLIES_CAP = 3;
  let appliesToSeen = 0;
  const cases: unknown[] = [];
  for (const a of abilities) {
    const types = new Set<string>();
    collectTypes(a.raw.effect, types);
    let fresh = false;
    for (const t of types) {
      if ((seen.get(t) ?? 0) < CAP) fresh = true;
    }
    const coversAppliesTo = a.raw.applies_to != null && appliesToSeen < APPLIES_CAP;
    if (coversAppliesTo) fresh = true;
    if (!fresh) continue;
    for (const t of types) seen.set(t, (seen.get(t) ?? 0) + 1);
    if (a.raw.applies_to != null) appliesToSeen += 1;
    const entry: Record<string, unknown> = {
      caseId: `${a.id}#${cases.length}`,
      effect: a.raw.effect,
      scope: a.raw.scope ?? null,
    };
    if (a.raw.applies_to != null) entry.applies_to = a.raw.applies_to;
    if (a.raw.usage != null) entry.usage = a.raw.usage;
    if (a.raw.trigger != null) entry.trigger = a.raw.trigger;
    entry.expected = {
      text: describeAbility({
        effect: a.raw.effect as Effect,
        scope: a.raw.scope,
        usage: a.raw.usage as AbilityUsage | undefined,
        trigger: a.raw.trigger as AbilityTrigger | undefined,
        applies_to: a.raw.applies_to,
      }),
    };
    cases.push(entry);
  }
  // Pin the scouts movement-modifier — movement-modifier caps out before scouts-6
  // sorts in alphabetically, so force-include one case to keep the new
  // "Before the first battle round, …" phrasing pinned cross-impl.
  {
    const fc = {
      effect: { type: "movement-modifier", target: "unit", modifier: { move_type: "scout", distance: 6 } },
      scope: { range: "unit", duration: "permanent" },
    };
    cases.push({
      caseId: `movement-modifier-scouts#${cases.length}`,
      effect: fc.effect,
      scope: fc.scope,
      expected: { text: describeAbility({ effect: fc.effect as Effect, scope: fc.scope }) },
    });
  }
  // Pin the curated ability-grant label overrides for the sibling ids — they
  // rarely surface in the capped sample above (ability-grant caps out on the
  // common `charge-after-advance`). Shapes mirror real enrichment data; expected
  // text still comes from the reference describer, so a second impl must
  // independently reproduce it. See ABILITY_GRANT_LABELS in translate/effect.ts.
  const FORCED_GRANT_CASES: { effect: Record<string, unknown>; scope: Record<string, unknown> }[] = [
    {
      effect: { type: "ability-grant", target: "unit", modifier: { grant_type: "charge-after-disembark" } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      effect: { type: "ability-grant", target: "self", modifier: { grant_type: "charge-after-fallback" } },
      scope: { range: "self", duration: "turn" },
    },
  ];
  for (const fc of FORCED_GRANT_CASES) {
    const id = (fc.effect.modifier as Record<string, unknown>).grant_type as string;
    cases.push({
      caseId: `grant-label-${id}#${cases.length}`,
      effect: fc.effect,
      scope: fc.scope,
      expected: { text: describeAbility({ effect: fc.effect as Effect, scope: fc.scope }) },
    });
  }
  // Batch A (describer-only gaps): pin the new condition lead-ins
  // (engagement-state / disposition-matches / fights-first), the `scaling`
  // trailing clause, and the inline dice-pool requirement label cross-impl.
  // `scaling` and `fights-first` have no enrichment usage, and several
  // engagement-state param branches never surface in the capped auto-sample, so
  // force-include exemplars; expected text still comes from the reference
  // describer, so a second impl must independently reproduce it.
  const FORCED_DESCRIBER_CASES: { id: string; effect: Record<string, unknown>; scope: Record<string, unknown> }[] = [
    {
      id: "engagement-state-engaged",
      effect: { type: "conditional", condition: { type: "engagement-state", parameters: { state: "within-engagement-range" } }, effect: { type: "fight-first", target: "unit" } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "engagement-state-on-battlefield",
      effect: { type: "conditional", condition: { type: "engagement-state", parameters: { state: "on-battlefield" } }, effect: { type: "deep-strike", target: "unit" } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "engagement-state-embarked",
      effect: { type: "conditional", condition: { type: "engagement-state", parameters: { state: "embarked" } }, effect: { type: "deep-strike", target: "unit" } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "engagement-state-empty",
      effect: { type: "conditional", condition: { type: "engagement-state", parameters: {} }, effect: { type: "deep-strike", target: "unit" } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "engagement-state-negated",
      effect: { type: "conditional", condition: { type: "engagement-state", negated: true, parameters: { state: "embarked" } }, effect: { type: "deep-strike", target: "unit" } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "disposition-matches-reserves",
      effect: { type: "conditional", condition: { type: "disposition-matches", parameters: { disposition: "strategic-reserves" } }, effect: { type: "deep-strike", target: "unit" } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "disposition-matches-enemy",
      effect: { type: "conditional", condition: { type: "disposition-matches", parameters: { disposition: "enemy" } }, effect: { type: "deep-strike", target: "unit" } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "fights-first-cond",
      effect: { type: "conditional", condition: { type: "fights-first", parameters: {} }, effect: { type: "stat-modifier", target: "unit", modifier: { stat: "A", operation: "add", value: 1 } } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "scaling-attacks-per-models",
      effect: { type: "stat-modifier", target: "unit", modifier: { stat: "A", operation: "add", value: 1 }, scaling: { per: 5, of: "enemy-models-in-range", within_inches: 6 } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "scaling-strength-wounds-lost",
      effect: { type: "stat-modifier", target: "self", modifier: { stat: "S", operation: "add", value: 1 }, scaling: { per: 1, of: "wounds-lost", round: "up", max_value: 3 } },
      scope: { range: "self", duration: "permanent" },
    },
    {
      id: "dice-pool-inline-label",
      effect: {
        type: "choice",
        options: [
          { type: "dice-pool-allocation", pool: { count: 3, die: "D6" }, max_activations: 1, options: [{ name: "Carnage", requirement: { type: "pair", min_value: 4 }, effect: { type: "mortal-wounds", target: "all-enemy", modifier: { count: 3 } } }] },
          { type: "fight-first", target: "unit" },
        ],
      },
      scope: { range: "unit", duration: "permanent" },
    },
  ];
  for (const fc of FORCED_DESCRIBER_CASES) {
    cases.push({
      caseId: `${fc.id}#${cases.length}`,
      effect: fc.effect,
      scope: fc.scope,
      expected: { text: describeAbility({ effect: fc.effect as Effect, scope: fc.scope }) },
    });
  }
  // Batch B (structured modifiers): parameterized weapon keywords (Anti-X / rated),
  // auto-result, transport (firing-deck / disembark-after-move), and the ability-level
  // `usage` limit. Shapes 3/5/6 have no enrichment usage yet; pin them synthetically.
  const FORCED_BATCH_B_CASES: { id: string; effect: Record<string, unknown>; scope: Record<string, unknown>; usage?: Record<string, unknown> }[] = [
    {
      id: "keyword-grant-anti-string",
      effect: { type: "keyword-grant", target: "unit", modifier: { keyword: "anti-titanic-3plus" } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "keyword-grant-anti-structured",
      effect: { type: "keyword-grant", target: "unit", modifier: { anti_keyword: "infantry", anti_threshold: 4 } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "keyword-grant-rated-value",
      effect: { type: "keyword-grant", target: "unit", modifier: { keyword: "sustained-hits", value: 2 } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "auto-result-battle-shock-pass",
      effect: { type: "auto-result", target: "unit", modifier: { test: "battle-shock", result: "pass" } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "auto-result-hit-six",
      effect: { type: "auto-result", target: "unit", modifier: { roll: "hit", result: 6 } },
      scope: { range: "unit", duration: "phase" },
    },
    {
      id: "firing-deck",
      effect: { type: "firing-deck", target: "self", modifier: { value: 2 } },
      scope: { range: "self", duration: "permanent" },
    },
    {
      id: "disembark-after-move",
      effect: { type: "disembark-after-move", target: "self", modifier: {} },
      scope: { range: "self", duration: "permanent" },
    },
    {
      id: "usage-once-per-turn",
      effect: { type: "cp-gain", target: "self", modifier: { amount: 1 } },
      scope: { range: "self", duration: "permanent" },
      usage: { frequency: "once-per-turn" },
    },
    {
      id: "usage-n-per-battle-per-unit",
      effect: { type: "stat-modifier", target: "unit", modifier: { stat: "A", operation: "add", value: 1 } },
      scope: { range: "unit", duration: "phase" },
      usage: { frequency: "n-per-battle", count: 2, per: "unit" },
    },
  ];
  for (const fc of FORCED_BATCH_B_CASES) {
    const entry: Record<string, unknown> = {
      caseId: `${fc.id}#${cases.length}`,
      effect: fc.effect,
      scope: fc.scope,
    };
    if (fc.usage) entry.usage = fc.usage;
    entry.expected = {
      text: describeAbility({
        effect: fc.effect as Effect,
        scope: fc.scope,
        usage: fc.usage as AbilityUsage | undefined,
      }),
    };
    cases.push(entry);
  }
  // Batch C (reactive trigger): pin the trigger lead-in across the event vocabulary
  // (no ability carries a trigger yet — forward-looking, like usage/auto-result).
  const FORCED_TRIGGER_CASES: { id: string; effect: Record<string, unknown>; scope: Record<string, unknown>; trigger: Record<string, unknown> }[] = [
    {
      id: "trigger-enemy-ended-move",
      effect: { type: "movement-modifier", target: "self", modifier: { move_type: "reactive", distance: "D6" } },
      scope: { range: "self", duration: "one-use" },
      trigger: { event: "enemy-unit-ended-move", subject: "enemy-unit", proximity: { of: "bearer", range: 9 } },
    },
    {
      id: "trigger-on-model-destroyed",
      effect: { type: "mortal-wounds", target: "all-enemy", modifier: { count: 1 } },
      scope: { range: "aura-6", duration: "one-use", range_inches: 6 },
      trigger: { event: "on-model-destroyed" },
    },
    {
      id: "trigger-before-save-with-condition",
      effect: { type: "re-roll", target: "unit", modifier: { roll: "save", subset: "all-failures" } },
      scope: { range: "unit", duration: "phase" },
      trigger: { event: "before-save-roll", subject: "self", condition: { type: "is-battle-shocked" } },
    },
  ];
  for (const fc of FORCED_TRIGGER_CASES) {
    cases.push({
      caseId: `${fc.id}#${cases.length}`,
      effect: fc.effect,
      scope: fc.scope,
      trigger: fc.trigger,
      expected: {
        text: describeAbility({
          effect: fc.effect as Effect,
          scope: fc.scope,
          trigger: fc.trigger as AbilityTrigger,
        }),
      },
    });
  }
  // Batch D (movement-modifier full closure + generic aura): pin one exemplar of
  // every new closed shape — move kinds, the optional-move_type passthrough
  // capability, redeploy/marker, the generic aura (range-bonus + tiered+effect),
  // and the re-homed deep-strike-range / engagement-no-end records. Several have
  // no enrichment usage (aura with nested effect, tiered range), so force them;
  // expected text still flows from the reference describer.
  const FORCED_BATCH_D_CASES: { id: string; effect: Record<string, unknown>; scope: Record<string, unknown> }[] = [
    {
      id: "move-passthrough-models-terrain",
      effect: { type: "movement-modifier", target: "self", modifier: { passthrough: ["non-titanic-models", "terrain-le-4"] } },
      scope: { range: "self", duration: "permanent" },
    },
    {
      id: "move-passthrough-applies-excludes",
      effect: { type: "movement-modifier", target: "unit", modifier: { passthrough: ["terrain-le-4"], vertical_limit: 4, excludes_keyword: "titanic", applies_to_moves: ["normal", "advance", "fall-back"] } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "move-ignore-vertical",
      effect: { type: "movement-modifier", target: "unit", modifier: { ignore_vertical: true } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "move-normal-applies",
      effect: { type: "movement-modifier", target: "unit", modifier: { move_type: "normal", distance: 3, applies_to_moves: ["normal", "advance", "fall-back"] } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "move-normal-negative",
      effect: { type: "movement-modifier", target: "defender", modifier: { move_type: "normal", distance: -2 } },
      scope: { range: "unit", duration: "turn" },
    },
    {
      id: "move-advance-bonus",
      effect: { type: "movement-modifier", target: "unit", modifier: { move_type: "advance", distance: 6 } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "move-pile-in",
      effect: { type: "movement-modifier", target: "unit", modifier: { move_type: "pile-in", distance: 3, replaces_default: true } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "move-consolidation",
      effect: { type: "movement-modifier", target: "unit", modifier: { move_type: "consolidation", distance: 6, replaces_default: true } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "move-surge",
      effect: { type: "movement-modifier", target: "unit", modifier: { move_type: "surge", distance: "D6" } },
      scope: { range: "unit", duration: "phase" },
    },
    {
      id: "move-shoot-and-scoot",
      effect: { type: "movement-modifier", target: "unit", modifier: { move_type: "shoot-and-scoot", distance: "D6" } },
      scope: { range: "unit", duration: "turn" },
    },
    {
      id: "move-redeploy-reserves-max",
      effect: { type: "movement-modifier", target: "unit", modifier: { move_type: "redeploy", to_reserves: true, max_units: 3 } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "move-redeploy-marker",
      effect: { type: "movement-modifier", target: "unit", modifier: { move_type: "redeploy", marker: { affected: "Cult Ambush markers" }, distance: 6 } },
      scope: { range: "unit", duration: "turn" },
    },
    {
      id: "move-redeploy-placement",
      effect: { type: "movement-modifier", target: "unit", modifier: { move_type: "redeploy", marker: { location: "floor sections", unit_filter: "Genestealer Cult Infantry" } } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "move-infiltrate",
      effect: { type: "movement-modifier", target: "unit", modifier: { move_type: "infiltrate" } },
      scope: { range: "unit", duration: "permanent" },
    },
    {
      id: "aura-range-bonus",
      effect: { type: "aura", target: "enemy-within-aura", modifier: { of: "contagion", range_bonus: 3 } },
      scope: { range: "self", duration: "permanent" },
    },
    {
      id: "aura-tiered-effect",
      effect: { type: "aura", target: "enemy-within-aura", modifier: { range: [3, 6, 9], effect: { type: "stat-modifier", target: "enemy-within-aura", modifier: { stat: "T", operation: "subtract", value: 1 } } } },
      scope: { range: "self", duration: "permanent" },
    },
    {
      id: "rehome-deep-strike-min-distance",
      effect: { type: "deep-strike", target: "unit", modifier: { min_distance: 6, replaces_default: true } },
      scope: { range: "unit", duration: "phase" },
    },
    {
      id: "rehome-engagement-no-end",
      effect: { type: "engagement-passthrough", target: "self", modifier: { no_end_in_engagement: true } },
      scope: { range: "self", duration: "permanent" },
    },
  ];
  for (const fc of FORCED_BATCH_D_CASES) {
    cases.push({
      caseId: `${fc.id}#${cases.length}`,
      effect: fc.effect,
      scope: fc.scope,
      expected: { text: describeAbility({ effect: fc.effect as Effect, scope: fc.scope }) },
    });
  }
  writeJson(join(CONFORMANCE, "effect-translation", "cases.json"), cases);
  console.log(`effect-translation/cases.json: ${cases.length} cases (${seen.size} node types)`);
}

/** Unsigned LEB128 of a small non-negative integer (for hand-built tokens). */
function leb128(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}

/** base64url (no padding) of a raw byte array — for negative decode goldens. */
function bytesToBase64url(bytes: number[]): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The share-token corpus. Each positive case pins `encodeShareToken(list)` to an
 * exact `token` and asserts `decodeShareToken(token)` round-trips to `list`;
 * negative cases pin the decoder's `malformed` / `stale-registry` verdicts. The
 * input lists are derived from the embedded dataset deterministically (sorted,
 * first-N) so the goldens are stable and self-maintaining. Rust and Python must
 * reproduce every `token` byte-for-byte and every decode verdict.
 */
function genShare(): void {
  mkdirSync(join(CONFORMANCE, "share"), { recursive: true });
  const ds = Dataset.embedded();
  const f = "adeptus-astartes";
  const dets = ds.detachments.all
    .filter((d) => d.faction_id === f)
    .map((d) => d.id)
    .sort();
  const units = ds.units
    .byFaction(f)
    .map((u) => u.id)
    .sort();
  const weapons = ds.weapons.all.map((w) => w.id).sort();
  const enhancement = ds.enhancements.all.map((e) => e.id).sort()[0];
  const disposition = ds.forceDispositions.all.map((d) => d.id).sort()[0];
  const allyFactionId = "chaos-daemons";
  const allyRuleId = ds.alliedRules.all.map((r) => r.id).sort()[0];

  const plainUnit = (id: string): ShareList["units"][number] => ({
    datasheetId: id,
    modelCount: 1,
    isWarlord: false,
    enhancementId: null,
    allyFactionId: null,
    allyRuleId: null,
    attachedToOrdinal: null,
    grants: [],
    loadout: [],
  });

  const lists: { name: string; list: ShareList }[] = [
    {
      name: "minimal",
      list: {
        name: "",
        factionId: f,
        detachmentIds: [],
        battleSize: "strike-force",
        disposition: null,
        units: [],
      },
    },
    {
      name: "warlord-enhancement-grants",
      list: {
        name: "Strîke Force 🔨",
        factionId: f,
        detachmentIds: [dets[0]],
        battleSize: "strike-force",
        disposition,
        units: [
          {
            ...plainUnit(units[0]),
            modelCount: 5,
            isWarlord: true,
            enhancementId: enhancement,
            grants: ["Character"],
            loadout: [
              [weapons[0], 2],
              [weapons[1], 1],
            ],
          },
          { ...plainUnit(units[1]), modelCount: 10, loadout: [[weapons[2], 10]] },
        ],
      },
    },
    {
      name: "allies-attachment",
      list: {
        name: "Soup",
        factionId: f,
        detachmentIds: [dets[0], dets[1]],
        battleSize: "incursion",
        disposition,
        units: [
          { ...plainUnit(units[0]), isWarlord: true, attachedToOrdinal: 1 }, // leader → bodyguard
          { ...plainUnit(units[1]), modelCount: 5 },
          {
            ...plainUnit(units[2]),
            allyFactionId,
            allyRuleId,
            grants: ["Battleline"],
            loadout: [[weapons[3], 1]],
          },
        ],
      },
    },
  ];

  interface ShareCase {
    name: string;
    list?: ShareList;
    token?: string;
    decode_token?: string;
    expected_decode?: ReturnType<typeof decodeShareToken>;
  }

  const cases: ShareCase[] = lists.map(({ name, list }) => {
    const token = encodeShareToken(list);
    const decoded = decodeShareToken(token);
    if (!decoded.ok) throw new Error(`share case ${name} failed to round-trip: ${decoded.reason}`);
    // Sanity: the generator's own round-trip must reproduce the input exactly.
    if (JSON.stringify(decoded.list) !== JSON.stringify(list)) {
      throw new Error(`share case ${name} did not round-trip losslessly`);
    }
    return { name, list, token };
  });

  // Negative decode cases (deterministic hand-built tokens).
  cases.push({
    name: "malformed-bad-format-byte",
    decode_token: bytesToBase64url([0x00]),
    expected_decode: { ok: false, reason: "malformed" },
  });
  cases.push({
    name: "stale-future-index",
    // Valid header (format 1, registry version, empty name) then a faction
    // index no committed registry will ever hold → stale-registry.
    decode_token: bytesToBase64url([0x01, ...leb128(shareRegistryVersion), 0x00, ...leb128(2_000_000)]),
    expected_decode: { ok: false, reason: "stale-registry" },
  });

  writeJson(join(CONFORMANCE, "share", "cases.json"), cases);
  console.log(
    `share/cases.json: ${cases.length} cases (registry v${shareRegistryVersion}, ` +
      `${cases.filter((c) => c.token).length} round-trip + ${cases.filter((c) => c.decode_token).length} negative)`,
  );
}

genNormalize();
genRosters();
genLinkedApi();
genAttribution();
genScoringTranslation();
genEffectTranslation();
genScoring();
genTerrainResolver();
genTerrainKeystones();
genShare();
