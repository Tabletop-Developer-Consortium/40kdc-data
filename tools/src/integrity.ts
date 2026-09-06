import { readFileSync } from "node:fs";
import { glob } from "glob";
import { resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ValidationResult } from "./validate.js";
import { baseLoadout, checkUnitLegality, type LoadoutModel, type LoadoutTier } from "./data/loadout.js";
import type { Unit, WargearOption } from "./generated.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DATA_ROOT = resolve(__dirname, "../../data");

/**
 * Factions whose units carry exactly one bare legion/faction faction_keyword.
 *
 * These are the shared-datasheet factions where contamination has been observed:
 * a unit materialized from a parent template keeps the parent's faction keyword
 * (e.g. a World Eaters Chaos Rhino left carrying `Emperor's Children`, or a Chaos
 * Space Marines unit carrying the full multi-legion union line). For a faction in
 * this map, every unit's `faction_keywords` must be a subset of `{home}`.
 *
 * Factions absent from this map (e.g. Space Marine chapters, which legitimately
 * carry several faction_keywords) are not subject to the membership check, so the
 * guard never produces a false positive on them. Extend this map as other
 * single-token factions adopt the convention.
 */
export const FACTION_HOME_KEYWORD: Record<string, string> = {
  "chaos-space-marines": "Heretic Astartes",
  "world-eaters": "World Eaters",
  "death-guard": "Death Guard",
  "thousand-sons": "Thousand Sons",
  "emperors-children": "Emperor’s Children",
};

/**
 * How one per-faction data file type's ids may collide across faction
 * directories. Every basename that appears under a `data/{core,enrichment}/
 * <faction>/` directory MUST be declared here — an undeclared basename fails
 * validation, so a new entity type cannot ship without a collision decision
 * (the durable fix for the recurring cross-faction id-shadowing bugs: weapons
 * in issue #59, the idol-of-blessed-blood ability, the imperial-fists
 * stratagem drift).
 *
 *  - `faction-scoped` — the same id may appear under several factions with
 *    copies that legitimately diverge; the linked API keeps every copy
 *    (dedupe on `(faction_id, id)`) and resolves faction-first, so the only
 *    invariant is id uniqueness *within* a faction dir.
 *  - `replicated-identical` — the same id may appear under several factions
 *    ONLY as byte-identical copies (canonical JSON): the linked API collapses
 *    them first-wins, so any divergence silently shadows all but one copy.
 *    Cross-faction drift fails validation.
 *  - `unique` — an id may exist in exactly one faction dir; a cross-faction
 *    duplicate is an error outright (promote to one of the classes above the
 *    first time sharing is genuinely needed).
 *  - `merged` — records carry no per-record id; consumers union/scan all of
 *    them, so no uniqueness constraint applies.
 */
type CollisionPolicy =
  | { policy: "faction-scoped"; idKey: string }
  | { policy: "replicated-identical"; idKey: string }
  | { policy: "unique"; idKey: string }
  | { policy: "merged" };

export const COLLISION_POLICIES: Record<string, CollisionPolicy> = {
  units: { policy: "faction-scoped", idKey: "id" },
  weapons: { policy: "faction-scoped", idKey: "id" },
  detachments: { policy: "faction-scoped", idKey: "id" },
  "wargear-options": { policy: "faction-scoped", idKey: "id" },
  "unit-compositions": { policy: "faction-scoped", idKey: "unit_id" },
  abilities: { policy: "faction-scoped", idKey: "ability_id" },
  // Attachment records are keyed by leader; a shared leader chassis carries a
  // distinct bodyguard list per faction, and consumers scan (never collapse).
  "leader-attachments": { policy: "faction-scoped", idKey: "leader_id" },
  // Chapter-replicated content: every copy must stay byte-identical or the
  // linked API's first-wins collapse hides real differences (the drift class
  // fixed for the bastion-task-force stratagems/enhancements).
  stratagems: { policy: "replicated-identical", idKey: "id" },
  enhancements: { policy: "replicated-identical", idKey: "id" },
  wargear: { policy: "replicated-identical", idKey: "id" },
  factions: { policy: "unique", idKey: "id" },
  "resource-pools": { policy: "unique", idKey: "id" },
  "hull-shapes": { policy: "unique", idKey: "id" },
  // Phase assignments carry no id; the dataset unions them per source.
  "phase-mappings": { policy: "merged" },
};

/**
 * Known, accepted cross-faction drift in `replicated-identical` files, keyed
 * `<basename>/<id>`. EMPTY by design — all pre-existing drift was re-synced
 * when the gate landed. Add an entry only with a comment justifying why the
 * copies genuinely cannot be identical; never to silence a fixable re-sync.
 * A stale entry (no longer drifted) is reported so the list stays minimal.
 */
export const KNOWN_REPLICATED_DRIFT: ReadonlySet<string> = new Set<string>([]);

/**
 * Basenames whose within-faction duplicate-id detection is owned by the
 * older, message-rich checks above (kept for their targeted diagnostics);
 * the table-driven pass skips them to avoid double-reporting.
 */
const LEGACY_DUP_CHECKED = new Set(["units", "wargear-options", "unit-compositions"]);

interface PointsTierLike {
  models?: number;
  models_max?: number;
  cost?: number;
  unit_count_min?: number;
  unit_count_max?: number | null;
}
interface UnitLike {
  id?: string;
  ability_ids?: string[];
  faction_keywords?: string[];
  weapon_ids?: string[];
  points?: PointsTierLike[];
  model_count?: { min?: number; max?: number };
}
interface CompModelLike {
  name?: string;
  min?: number;
  max?: number;
  default_weapon_ids?: string[];
  loadout_variants?: LoadoutVariantLike[];
  loadout_variant_budgets?: VariantBudgetLike[];
}
interface LoadoutVariantLike {
  name?: string;
  weapon_ids?: string[];
  max_count?: number;
}
interface VariantBudgetLike {
  variant_names?: string[];
  count?: number;
  per_models?: number;
  scope?: string;
}
interface CompTierLike {
  models?: CompModelLike[];
}
interface CompLike {
  unit_id?: string;
  models?: CompModelLike[];
  tiers?: CompTierLike[];
}
interface AbilityLike {
  ability_id?: string;
}

/**
 * Known, accepted loadout orphans — a `<faction>/<unit_id>/<weapon_id>` triple
 * whose weapon is in the unit's `weapon_ids` but is neither a recorded
 * `default_weapon_ids` entry nor reachable through any wargear-option. Each entry
 * is a deliberate, reviewed exception — a NEW orphan (any triple not listed) fails
 * CI, and a listed triple that is no longer an orphan is reported as stale so the
 * list stays minimal.
 *
 * This set is now EMPTY: every former orphan has been resolved by restructuring
 * the unit composition to match the GW MFM dump's per-figure miniature rows
 * (collapsed single-figure squads, daemon split-models, kill-team weapon variants,
 * and same-named distinct-loadout figures). Keep the gate zero-tolerance — add a
 * triple here only with a comment justifying why the dump genuinely cannot model
 * the loadout, never to silence a fixable data gap.
 */
export const KNOWN_LOADOUT_ORPHANS: ReadonlySet<string> = new Set<string>([]);
interface WargearOptionLike {
  id?: string;
  replaces?: string[];
  replacement?: string[];
  replacement_choice?: string[][];
}

/**
 * Corruption signatures of a wargear-option weapon ref synthesized from prose
 * rather than structural data — the failure mode of the retired army-assist prose
 * lineage, kept here as a source-agnostic regression tripwire:
 *  - a dangling conjunction tail ("…-and"/"…-or") — a severed "A and B" group;
 *  - a captured prose qualifier ("options-you-cannot-select-the-same-option…",
 *    "duplicates-are-not-allowed") swallowed as a fake weapon.
 * Neither shape can occur in a real weapon/wargear id, so flagging them is safe.
 */
const DANGLING_CONJUNCTION = /-(?:and|or)$/;
const CAPTURED_QUALIFIER = /^options-|-you-cannot-|-not-allowed$|-the-same-option/;

function readArray<T>(file: string): T[] {
  return JSON.parse(readFileSync(file, "utf-8")) as T[];
}

/**
 * The unit a `<base>-<unit_id>` weapon variant belongs to, or `undefined` when
 * the id carries no unit suffix at all.
 *
 * Matching must take the LONGEST unit-id suffix, not the first that fits:
 * `choppa-beast-snagga-boyz` ends with `-boyz` as well as
 * `-beast-snagga-boyz`, so a naive scan hands the Beast Snagga weapon to the
 * plain Boyz unit. Whichever suffix is longest is the real owner.
 */
export function variantWeaponOwner(weaponId: string, unitIds: Iterable<string>): string | undefined {
  let owner: string | undefined;
  for (const unitId of unitIds) {
    if (!unitId || unitId === weaponId) continue;
    if (!weaponId.endsWith(`-${unitId}`)) continue;
    if (owner === undefined || unitId.length > owner.length) owner = unitId;
  }
  return owner;
}

/**
 * Structural checks over one composition's `loadout_variants` /
 * `loadout_variant_budgets`.
 *
 * A variant states a WHOLE per-model loadout, so nothing downstream re-derives
 * its equipment from the unit's own vocabulary — an unresolvable or misappropriated
 * weapon id would surface only as a silently wrong candidate loadout. Scope is
 * the faction's weapon + wargear pool rather than the owning unit's
 * `weapon_ids`, deliberately: a variant may legitimately name equipment the
 * unit record does not list (Boyz' `close-combat-weapon`), and keeping
 * `units.json` untouched is a property the BSData projection relies on.
 */
function collectVariantErrors(
  comp: CompLike,
  index: number,
  factionEquipment: ReadonlySet<string>,
  factionUnitIds: ReadonlySet<string>,
): Array<{ path: string; message: string }> {
  const errs: Array<{ path: string; message: string }> = [];
  const unitId = comp.unit_id ?? "";
  const models = comp.models ?? [];

  for (let m = 0; m < models.length; m++) {
    const row = models[m];
    const variants = row.loadout_variants;
    const budgets = row.loadout_variant_budgets;
    const where = `unit "${unitId}" model row "${row.name ?? m}"`;

    if (!variants?.length) {
      // A budget with nothing to budget cannot be enforced; the caps only
      // mean anything relative to named variants in the same row.
      if (budgets?.length) {
        errs.push({
          path: `/${index}/models/${m}/loadout_variant_budgets`,
          message: `${where}: loadout_variant_budgets is present with no loadout_variants — a variant budget can only cap variants declared in its own row`,
        });
      }
      continue;
    }

    const names = new Set<string>();
    for (let v = 0; v < variants.length; v++) {
      const variant = variants[v];
      const name = variant.name ?? "";
      if (names.has(name)) {
        errs.push({
          path: `/${index}/models/${m}/loadout_variants/${v}`,
          message: `${where}: duplicate loadout_variant name "${name}" — variant names are the budget's only handle on a variant, so they must be unique within a model row`,
        });
      }
      names.add(name);

      for (const wid of variant.weapon_ids ?? []) {
        if (!factionEquipment.has(wid)) {
          errs.push({
            path: `/${index}/models/${m}/loadout_variants/${v}`,
            message: `${where}: loadout_variant "${name}" names equipment "${wid}" that is neither a weapon nor a wargear entry in this faction — a variant states a whole loadout, so every id must resolve`,
          });
          continue;
        }
        const owner = variantWeaponOwner(wid, factionUnitIds);
        if (owner !== undefined && owner !== unitId) {
          errs.push({
            path: `/${index}/models/${m}/loadout_variants/${v}`,
            message: `${where}: loadout_variant "${name}" names "${wid}", which is unit "${owner}"'s own weapon variant — a variant must not borrow another unit's stat-specific weapon`,
          });
        }
      }
    }

    for (let b = 0; b < (budgets?.length ?? 0); b++) {
      const budget = budgets![b];
      for (const name of budget.variant_names ?? []) {
        if (!names.has(name)) {
          errs.push({
            path: `/${index}/models/${m}/loadout_variant_budgets/${b}`,
            message: `${where}: loadout_variant_budget names variant "${name}", which does not exist in this model row (declared: ${[...names].map((n) => `"${n}"`).join(", ")})`,
          });
        }
      }
      const perModels = budget.per_models ?? 0;
      const count = budget.count ?? 0;
      if (perModels > 0 && count > perModels) {
        errs.push({
          path: `/${index}/models/${m}/loadout_variant_budgets/${b}`,
          message: `${where}: loadout_variant_budget allows ${count} per ${perModels} model(s) — a ratio above 1:1 caps nothing per model and is a flat limit in disguise; use per_models: 0 for a flat cap`,
        });
      }
    }
  }

  return errs;
}

function loadAbilityIds(file: string, into: Set<string>): void {
  try {
    for (const a of readArray<AbilityLike>(file)) {
      if (a.ability_id) into.add(a.ability_id);
    }
  } catch {
    // file absent — faction has no enrichment abilities, or no shared core pool
  }
}

/** Collect violations of the closed dice-table face partition. */
function collectDiceTableErrors(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const value of node) collectDiceTableErrors(value, out);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const effect = node as Record<string, unknown>;
  if (effect.type === "dice-table" && (effect.dice === "D3" || effect.dice === "D6") && Array.isArray(effect.outcomes)) {
    const sides = effect.dice === "D3" ? 3 : 6;
    const counts = Array.from({ length: sides + 1 }, () => 0);
    for (const outcome of effect.outcomes) {
      if (outcome === null || typeof outcome !== "object" || !("results" in outcome) || !Array.isArray(outcome.results)) continue;
      for (const resultFace of outcome.results) {
        if (typeof resultFace === "number" && Number.isInteger(resultFace) && resultFace >= 1 && resultFace <= sides) {
          counts[resultFace]++;
        }
      }
    }
    const missing = counts.flatMap((count, face) => (face > 0 && count === 0 ? [face] : []));
    const overlaps = counts.flatMap((count, face) => (face > 0 && count > 1 ? [face] : []));
    if (missing.length > 0) out.push(`dice-table ${effect.dice} omits result${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`);
    if (overlaps.length > 0) out.push(`dice-table ${effect.dice} repeats result${overlaps.length === 1 ? "" : "s"} ${overlaps.join(", ")}`);
  }
  for (const value of Object.values(effect)) collectDiceTableErrors(value, out);
}

export function diceTableInvariantErrors(effect: unknown): string[] {
  const errors: string[] = [];
  collectDiceTableErrors(effect, errors);
  return errors;
}
/**
 * Cross-entity referential integrity that per-file JSON Schema validation cannot
 * express:
 *
 *  - every unit `ability_id` must resolve to an ability defined in that faction's
 *    `enrichment/<faction>/abilities.json` (or the shared `enrichment/_core` pool).
 *    Same-faction scoping is deliberate — a union check would pass shared-unit
 *    contaminants because they happen to be defined in some *other* faction's
 *    enrichment.
 *  - every unit `faction_keywords` entry must be permitted for the unit's faction
 *    (see {@link FACTION_HOME_KEYWORD}).
 *
 * Results reuse {@link ValidationResult} so the CLI reporter can render them.
 */
export async function checkReferentialIntegrity(dataRoot?: string): Promise<ValidationResult> {
  const root = dataRoot ?? DATA_ROOT;
  const result: ValidationResult = {
    totalFiles: 0,
    totalItems: 0,
    passed: 0,
    failed: 0,
    errors: [],
  };

  // Shared core ability pool, available to every faction (optional).
  const coreAbilities = new Set<string>();
  loadAbilityIds(resolve(root, "enrichment/_core/abilities.json"), coreAbilities);
  const coreAbilityById = new Map<string, AbilityLike & { id?: string; effect?: unknown }>();
  try {
    for (const ability of readArray<AbilityLike & { id?: string; effect?: unknown }>(
      resolve(root, "enrichment/_core/abilities.json"),
    )) {
      const id = ability.ability_id ?? ability.id;
      if (id) coreAbilityById.set(id, ability);
    }
  } catch {
    // Optional shared core pool may be absent or unreadable.
  }

  const unitFiles = await glob("core/*/units.json", { cwd: root, absolute: true });
  unitFiles.sort();

  for (const file of unitFiles) {
    const faction = basename(dirname(file));
    if (faction.startsWith("_")) continue; // scratch/example/report dirs

    let units: UnitLike[];
    try {
      units = readArray<UnitLike>(file);
    } catch {
      continue; // structural problems are the AJV pass's job
    }
    if (!Array.isArray(units)) continue;

    // No two units in a faction file may share an id. The linked API keys units
    // by id with first-wins (`Collection`), so a duplicate silently shadows the
    // later entry — e.g. a stale `pre-launch-provisional` points row hiding the
    // authoritative `launch` row, so the corrected points never reach consumers.
    // An append-instead-of-replace ingest is the recurring cause; flag any
    // collision so it can't ship.
    const idCounts = new Map<string, number>();
    for (const u of units) if (u.id) idCounts.set(u.id, (idCounts.get(u.id) ?? 0) + 1);
    const dupIds = [...idCounts].filter(([, n]) => n > 1).map(([id]) => id);
    if (dupIds.length > 0) {
      result.failed++;
      result.errors.push({
        file,
        index: 0,
        errors: dupIds.map((id) => ({
          path: "/",
          message: `duplicate unit id "${id}" appears ${idCounts.get(id)}× in ${faction}/units.json — the linked API keys by id (first-wins), so the later entry is silently shadowed; keep exactly one`,
        })),
      });
    }

    const defined = new Set<string>(coreAbilities);
    loadAbilityIds(resolve(root, `enrichment/${faction}/abilities.json`), defined);
    const home = FACTION_HOME_KEYWORD[faction];

    result.totalFiles++;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      result.totalItems++;
      const errs: Array<{ path: string; message: string }> = [];

      for (const aid of u.ability_ids ?? []) {
        if (!defined.has(aid)) {
          errs.push({
            path: `/${i}/ability_ids`,
            message: `unit "${u.id}": ability_id "${aid}" is not defined in ${faction} enrichment`,
          });
        }
      }

      if (home !== undefined) {
        for (const fk of u.faction_keywords ?? []) {
          if (fk !== home) {
            errs.push({
              path: `/${i}/faction_keywords`,
              message: `unit "${u.id}": faction_keyword "${fk}" is not permitted for ${faction} (expected only "${home}")`,
            });
          }
        }
      }

      if (errs.length > 0) {
        result.failed++;
        result.errors.push({ file, index: i, errors: errs });
      } else {
        result.passed++;
      }
    }
  }

  // rule-state slug resolution beyond what JSON Schema can express. The schema
  // pins `core-rule` slugs to a closed enum and leaves `keyword` free (the open
  // keyword set), but `ability`/`faction-rule` slugs are free strings that must
  // resolve to a real entity — the negative counterpart of unit `ability_id`
  // resolution. Scope is GLOBAL (every ability id across all factions + core),
  // because a suppression legitimately references another faction's ability
  // (e.g. negating an enemy's Lone Operative); a same-faction check would falsely
  // fail those cross-faction references. faction-rule slugs resolve against the
  // `faction_rule_id` set declared on the factions.
  const allAbilityIds = new Set<string>(coreAbilities);
  const abilityIdsByFaction = new Map<string, Set<string>>();
  const abilityRecordsByFaction = new Map<string, Map<string, AbilityLike & { id?: string; effect?: unknown }>>();
  const abilityFiles = await glob("enrichment/*/abilities.json", { cwd: root, absolute: true });
  for (const f of abilityFiles) {
    const faction = basename(dirname(f));
    if (faction.startsWith("_")) continue;
    try {
      const abilityIds = new Set<string>();
      const abilityRecords = new Map<string, AbilityLike & { id?: string; effect?: unknown }>();
      for (const a of readArray<AbilityLike & { id?: string }>(f)) {
        if (a.ability_id) {
          allAbilityIds.add(a.ability_id);
          abilityIds.add(a.ability_id);
          abilityRecords.set(a.ability_id, a);
        }
        if (a.id) allAbilityIds.add(a.id);
      }
      abilityIdsByFaction.set(faction, abilityIds);
      abilityRecordsByFaction.set(faction, abilityRecords);
    } catch {
      // skip unreadable ability files
    }
  }
  const factionRuleIds = new Set<string>();
  for (const f of await glob("core/*/factions.json", { cwd: root, absolute: true })) {
    try {
      for (const fac of readArray<{ faction_rule_id?: string }>(f)) {
        if (fac.faction_rule_id) factionRuleIds.add(fac.faction_rule_id);
      }
    } catch {
      // skip unreadable faction files
    }
  }

  /** Collect (rule_kind, rule) pairs from every rule-state effect in a value tree. */
  const collectRuleStateRefs = (node: unknown, out: Array<{ kind: string; rule: string }>): void => {
    if (Array.isArray(node)) {
      for (const v of node) collectRuleStateRefs(v, out);
    } else if (node !== null && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (o.type === "rule-state" && o.modifier !== null && typeof o.modifier === "object") {
        const m = o.modifier as Record<string, unknown>;
        if (typeof m.rule_kind === "string" && typeof m.rule === "string") {
          out.push({ kind: m.rule_kind, rule: m.rule });
        }
      }
      for (const v of Object.values(o)) collectRuleStateRefs(v, out);
    }
  };

  /** A named selection event references its source ability, not a display label. */
  const collectSourceAbilityRefs = (node: unknown, out: Array<{ abilityId: string; owner: string }>): void => {
    if (Array.isArray(node)) {
      node.forEach((value) => collectSourceAbilityRefs(value, out));
    } else if (node !== null && typeof node === "object") {
      const rec = node as Record<string, unknown>;
      if (rec.source_ability !== null && typeof rec.source_ability === "object") {
        const source = rec.source_ability as Record<string, unknown>;
        if (typeof source.ability_id === "string") out.push({ abilityId: source.ability_id, owner: String(source.owner) });
      }
      Object.values(rec).forEach((value) => collectSourceAbilityRefs(value, out));
    }
  };

  /** Collect entity-backed ability grants, including reusable rules bundles. */
  const collectAbilityGrantRefs = (node: unknown, out: string[]): void => {
    if (Array.isArray(node)) {
      for (const value of node) collectAbilityGrantRefs(value, out);
    } else if (node !== null && typeof node === "object") {
      const effect = node as Record<string, unknown>;
      if (effect.type === "ability-grant" && effect.modifier !== null && typeof effect.modifier === "object") {
        const modifier = effect.modifier as Record<string, unknown>;
        const abilityId = modifier.ability_id;
        if (modifier.rules_bundle === true && typeof abilityId === "string") out.push(abilityId);
      }
      for (const value of Object.values(effect)) collectAbilityGrantRefs(value, out);
    }
  };


  for (const file of abilityFiles) {
    const faction = basename(dirname(file));
    if (faction.startsWith("_")) continue;
    let abilities: Array<AbilityLike & { id?: string; effect?: unknown }>;
    try {
      abilities = readArray(file);
    } catch {
      continue;
    }
    if (!Array.isArray(abilities)) continue;

    for (let i = 0; i < abilities.length; i++) {
      const a = abilities[i];
      const sourceAbilityRefs: Array<{ abilityId: string; owner: string }> = [];
      collectSourceAbilityRefs(a, sourceAbilityRefs);
      const refs: Array<{ kind: string; rule: string }> = [];
      collectRuleStateRefs(a.effect, refs);
      const abilityGrantRefs: string[] = [];
      collectAbilityGrantRefs(a.effect, abilityGrantRefs);
      const diceTableErrors: string[] = [];
      collectDiceTableErrors(a.effect, diceTableErrors);
      // Only abilities carrying an entity reference or dice-table invariant
      // have anything to resolve here; skip the rest so this check does not
      // inflate unrelated counts.
      if (refs.length === 0 && abilityGrantRefs.length === 0 && diceTableErrors.length === 0 && sourceAbilityRefs.length === 0) continue;
      result.totalItems++;
      const errs: Array<{ path: string; message: string }> = [];
      for (const message of diceTableErrors) {
        errs.push({
          path: `/${i}/effect`,
          message: `ability "${a.id ?? a.ability_id}": ${message}`,
        });
      }
      for (const { kind, rule } of refs) {
        if (kind === "ability" && !allAbilityIds.has(rule)) {
          errs.push({
            path: `/${i}/effect`,
            message: `ability "${a.id ?? a.ability_id}": rule-state rule_kind:ability "${rule}" resolves to no ability entity in the dataset`,
          });
        } else if (kind === "faction-rule" && !factionRuleIds.has(rule)) {
          errs.push({
            path: `/${i}/effect`,
            message: `ability "${a.id ?? a.ability_id}": rule-state rule_kind:faction-rule "${rule}" is not a declared faction_rule_id`,
          });
        }
      }
      const factionAbilityRecords = abilityRecordsByFaction.get(faction);
      for (const { abilityId, owner } of sourceAbilityRefs) {
        const resolves = owner === "enemy" ? allAbilityIds.has(abilityId) :
          factionAbilityRecords?.has(abilityId) || coreAbilityById.has(abilityId);
        if (!resolves) errs.push({
          path: `/${i}/trigger/source_ability/ability_id`,
          message: `ability "${a.id ?? a.ability_id}": source_ability "${abilityId}" does not resolve for ${owner} source in ${faction}`,
        });
      }

      for (const abilityId of abilityGrantRefs) {
        const grantedAbility = factionAbilityRecords?.get(abilityId) ?? coreAbilityById.get(abilityId);
        if (!grantedAbility) {
          errs.push({
            path: `/${i}/effect`,
            message: `ability "${a.id ?? a.ability_id}": rules-bundle grant "${abilityId}" resolves to no ability entity in ${faction} enrichment or the shared core pool`,
          });
        } else if ((grantedAbility.effect as { type?: unknown } | undefined)?.type !== "rules-bundle") {
          errs.push({
            path: `/${i}/effect`,
            message: `ability "${a.id ?? a.ability_id}": rules-bundle grant "${abilityId}" resolves to an ability whose effect is not rules-bundle`,
          });
        }
      }
      if (errs.length > 0) {
        result.failed++;
        result.errors.push({ file, index: i, errors: errs });
      } else {
        result.passed++;
      }
    }
  }

  // Wargear-option weapon refs must not carry a parser-corruption signature. This
  // guards against the "1 A and 1 B" choice-group severing recurring on any
  // future data regeneration or hand-edit.
  const optionFiles = await glob("core/*/wargear-options.json", { cwd: root, absolute: true });
  optionFiles.sort();
  for (const file of optionFiles) {
    const faction = basename(dirname(file));
    if (faction.startsWith("_")) continue;

    let options: WargearOptionLike[];
    try {
      options = readArray<WargearOptionLike>(file);
    } catch {
      continue;
    }
    if (!Array.isArray(options)) continue;

    // No two options in a faction file may share an id. The linked API keys
    // options by (faction_id, unit_id) and an id is unique only *within* a
    // faction — a shared chassis legitimately reuses ids across factions (e.g.
    // `chaos-terminators-wgo-mfm-4` in World Eaters and Emperors Children mean
    // different swaps). So cross-faction reuse is fine, but a duplicate *within*
    // one faction file silently shadows the later option in `wargearOptionsOf`.
    // Mirror of the duplicate-unit-id guard above.
    const optIdCounts = new Map<string, number>();
    for (const o of options) if (o.id) optIdCounts.set(o.id, (optIdCounts.get(o.id) ?? 0) + 1);
    const dupOptIds = [...optIdCounts].filter(([, n]) => n > 1).map(([id]) => id);
    if (dupOptIds.length > 0) {
      result.failed++;
      result.errors.push({
        file,
        index: 0,
        errors: dupOptIds.map((id) => ({
          path: "/",
          message: `duplicate wargear-option id "${id}" appears ${optIdCounts.get(id)}× in ${faction}/wargear-options.json — ids must be unique within a faction (cross-faction reuse for a shared chassis is allowed); the later entry is silently shadowed`,
        })),
      });
    }

    // The faction's weapon ids — to catch plural-of-weapon refs ("lascannons"
    // where only the singular "lascannon" is a real weapon), the relic of a
    // converter that lacked a "2 X" → singular fallback.
    let weaponIds = new Set<string>();
    try {
      weaponIds = new Set(readArray<{ id?: string }>(resolve(dirname(file), "weapons.json")).map((w) => w.id ?? ""));
    } catch {
      // no weapons file — skip the plural-of-weapon check for this faction
    }

    result.totalFiles++;
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      result.totalItems++;
      const errs: Array<{ path: string; message: string }> = [];

      const refs = [...(o.replaces ?? []), ...(o.replacement ?? [])];
      for (const group of o.replacement_choice ?? []) refs.push(...group);
      for (const ref of refs) {
        if (DANGLING_CONJUNCTION.test(ref)) {
          errs.push({
            path: `/${i}`,
            message: `wargear-option "${o.id}": weapon ref "${ref}" ends in a dangling conjunction — a prose-derived ref severed an "A and B" group`,
          });
        } else if (CAPTURED_QUALIFIER.test(ref)) {
          errs.push({
            path: `/${i}`,
            message: `wargear-option "${o.id}": weapon ref "${ref}" is a captured prose qualifier, not a weapon`,
          });
        } else if (!weaponIds.has(ref) && ref.endsWith("s") && weaponIds.has(ref.slice(0, -1))) {
          errs.push({
            path: `/${i}`,
            message: `wargear-option "${o.id}": weapon ref "${ref}" is a plural of weapon "${ref.slice(0, -1)}" — use the singular weapon id`,
          });
        }
      }

      if (errs.length > 0) {
        result.failed++;
        result.errors.push({ file, index: i, errors: errs });
      } else {
        result.passed++;
      }
    }
  }

  // ── Loadout coverage: no orphan weapons on a populated composition ──
  //
  // A unit's `weapon_id` must be either a recorded per-model default or reachable
  // through some wargear-option (the swap/add structure). A weapon that is
  // neither — an "orphan" — is the defect class behind the Chaos Terminators
  // illegal-loadout bug (a special/heavy weapon the data never modeled as an
  // option). The check is scoped to *populated* compositions (every model row
  // carries `default_weapon_ids`); an unpopulated composition falls back to the
  // loadout layer's derivation and is out of scope. Known, reviewed residue lives
  // in {@link KNOWN_LOADOUT_ORPHANS}; a new orphan fails, a stale allowlist entry
  // is reported.
  const seenAllowed = new Set<string>();
  const scannedFactions = new Set<string>();
  const compFiles = await glob("core/*/unit-compositions.json", { cwd: root, absolute: true });
  compFiles.sort();
  for (const file of compFiles) {
    const faction = basename(dirname(file));
    if (faction.startsWith("_")) continue;
    scannedFactions.add(faction);

    let comps: CompLike[];
    try {
      comps = readArray<CompLike>(file);
    } catch {
      continue;
    }
    if (!Array.isArray(comps)) continue;

    // At most one composition per unit within a faction. The linked API keys the
    // composition by (faction_id, unit_id) first-wins, so a within-faction
    // duplicate silently shadows the later row. (Cross-faction is fine — a shared
    // chassis has a distinct composition per faction.) Same regression class as
    // the duplicate-unit and duplicate-option guards.
    const compCounts = new Map<string, number>();
    for (const c of comps) if (c.unit_id) compCounts.set(c.unit_id, (compCounts.get(c.unit_id) ?? 0) + 1);
    const dupComps = [...compCounts].filter(([, n]) => n > 1).map(([id]) => id);
    if (dupComps.length > 0) {
      result.failed++;
      result.errors.push({
        file,
        index: 0,
        errors: dupComps.map((id) => ({
          path: "/",
          message: `duplicate unit-composition for unit "${id}" appears ${compCounts.get(id)}× in ${faction}/unit-compositions.json — at most one composition per unit within a faction; the later entry is silently shadowed`,
        })),
      });
    }

    const dir = dirname(file);
    let units: UnitLike[];
    try {
      units = readArray<UnitLike>(resolve(dir, "units.json"));
    } catch {
      continue;
    }
    const weaponIdsByUnit = new Map<string, string[]>(units.map((u) => [u.id ?? "", u.weapon_ids ?? []]));
    const unitRecById = new Map<string, UnitLike>(units.map((u) => [u.id ?? "", u]));
    // The faction's whole equipment vocabulary + unit ids, for the
    // loadout_variant checks (see collectVariantErrors).
    const factionUnitIds = new Set<string>(units.map((u) => u.id ?? "").filter(Boolean));
    const factionEquipment = new Set<string>();
    for (const name of ["weapons.json", "wargear.json"]) {
      try {
        for (const e of readArray<{ id?: string }>(resolve(dir, name))) if (e.id) factionEquipment.add(e.id);
      } catch {
        // faction has no file of this kind — the other one still constrains variants
      }
    }
    const reachableByUnit = new Map<string, Set<string>>();
    const optionsByUnit = new Map<string, WargearOptionLike[]>();
    try {
      for (const o of readArray<WargearOptionLike & { unit_id?: string }>(resolve(dir, "wargear-options.json"))) {
        const set = reachableByUnit.get(o.unit_id ?? "") ?? new Set<string>();
        for (const id of o.replaces ?? []) set.add(id);
        for (const id of o.replacement ?? []) set.add(id);
        for (const g of o.replacement_choice ?? []) for (const id of g) set.add(id);
        reachableByUnit.set(o.unit_id ?? "", set);
        (optionsByUnit.get(o.unit_id ?? "") ?? optionsByUnit.set(o.unit_id ?? "", []).get(o.unit_id ?? "")!).push(o);
      }
    } catch {
      // no wargear-options file — every weapon must be a default then
    }

    result.totalFiles++;
    for (let i = 0; i < comps.length; i++) {
      const c = comps[i];
      result.totalItems++;
      const models = c.models ?? [];
      // Whole-loadout model variants and their caps are checked regardless of
      // whether the composition is "populated" — they carry their own complete
      // equipment and do not depend on default_weapon_ids being present.
      const errs: Array<{ path: string; message: string }> = collectVariantErrors(
        c,
        i,
        factionEquipment,
        factionUnitIds,
      );
      // Populated = every model row carries a non-empty default loadout.
      const populated = models.length > 0 && models.every((m) => (m.default_weapon_ids?.length ?? 0) > 0);
      if (!populated) {
        if (errs.length > 0) {
          result.failed++;
          result.errors.push({ file, index: i, errors: errs });
        } else {
          result.passed++;
        }
        continue;
      }
      const defaults = new Set<string>();
      for (const m of models) for (const id of m.default_weapon_ids ?? []) defaults.add(id);
      const reachable = reachableByUnit.get(c.unit_id ?? "") ?? new Set<string>();
      for (const wid of weaponIdsByUnit.get(c.unit_id ?? "") ?? []) {
        if (defaults.has(wid) || reachable.has(wid)) continue;
        const key = `${faction}/${c.unit_id}/${wid}`;
        if (KNOWN_LOADOUT_ORPHANS.has(key)) {
          seenAllowed.add(key);
          continue;
        }
        errs.push({
          path: `/${i}`,
          message: `unit "${c.unit_id}": weapon "${wid}" is an orphan — neither a default_weapon_ids entry nor reachable via a wargear-option`,
        });
      }

      // ── Stock-loadout legality: the out-of-the-box build is legal by ──
      // ── construction — GW never prints a datasheet whose default build ──
      // ── violates its own wargear rules. ──
      //
      // This is the semantic gate the ATC false-positive classes slipped past:
      // AJV checks shape, the orphan check above checks reachability, and the
      // conformance corpus checks cross-implementation parity — four ports
      // agreeing on the same wrong budget passes all three. A budget that
      // counts a default weapon, an option cap below the printed allowance, or
      // a stale composition row all surface here as a "stock squad is illegal"
      // failure at ingest time (applyWrites runs this via npm run validate).
      const unitRec = unitRecById.get(c.unit_id ?? "");
      if (unitRec) {
        const tiers = (c as { tiers?: LoadoutTier[] }).tiers;
        // Stock is computed per buildable size with THAT size's model
        // allocation (tier rows merged onto the base models by name — mirrors
        // the checker's own tier selection); computing it from the envelope
        // would seat e.g. one sergeant where the 20-model tier fields two.
        const byName = new Map(models.map((m) => [m.name, m]));
        const shapes: { size: number; rows: CompModelLike[] }[] = [];
        if (tiers?.length) {
          for (const t of tiers) {
            const rows = (t.models ?? []).map((tm) => ({
              ...(tm.name != null ? byName.get(tm.name) ?? {} : {}),
              name: tm.name,
              min: tm.min,
              max: tm.max,
            }));
            shapes.push({ size: rows.reduce((s, m) => s + (m.min ?? 0), 0), rows });
            shapes.push({ size: rows.reduce((s, m) => s + (m.max ?? 0), 0), rows });
          }
        } else {
          shapes.push({ size: models.reduce((s, m) => s + (m.min ?? 0), 0), rows: models });
          shapes.push({ size: models.reduce((s, m) => s + (m.max ?? 0), 0), rows: models });
        }
        const options = (optionsByUnit.get(c.unit_id ?? "") ?? []) as unknown as WargearOption[];
        const asLoadoutModels = (ms: CompModelLike[]): LoadoutModel[] =>
          ms.map((m) => ({ ...m, min: m.min ?? 0, max: m.max ?? m.min ?? 0 }));
        const seen = new Set<number>();
        for (const { size, rows } of shapes.sort((a, b) => a.size - b.size)) {
          if (size <= 0 || seen.has(size)) continue;
          seen.add(size);
          const stock = baseLoadout(unitRec as unknown as Unit, size, options, asLoadoutModels(rows));
          const violations = checkUnitLegality(
            unitRec as unknown as Unit,
            size,
            options,
            stock.counts,
            asLoadoutModels(models),
            tiers,
          );
          for (const v of violations) {
            errs.push({
              path: `/${i}`,
              message: `unit "${c.unit_id}": STOCK loadout at ${size} models is illegal (${v.code}:${v.id}) — the default build must always validate; fix the budgets/options/composition, never ship this`,
            });
          }
        }
      }

      if (errs.length > 0) {
        result.failed++;
        result.errors.push({ file, index: i, errors: errs });
      } else {
        result.passed++;
      }
    }

    // Points ↔ composition-tier coverage. A composition's `tiers` are the
    // structural authority for the legal squad sizes; `points` is the priced
    // projection. Every whole-squad model count a tier admits must resolve to
    // exactly one `points` tier — otherwise a builder that resizes into the gap
    // misprices or crashes (the Venatari 4–6 range regression: tiers said 4–6
    // was legal, points priced only 3 and 6). This is the invariant that would
    // have caught that bug; a range-priced tier must carry `models_max`.
    //
    // Units whose tier size-ranges OVERLAP are choice-based / optional-attachment
    // shapes a flat size→cost array cannot model (e.g. Outrider Squad's Invader
    // ATV builds, per-build wargear prices); their price is derived per build, so
    // skip the coverage check rather than false-flag — mirroring the ambiguity
    // guard in tools/src/mfm/points.ts deriveDatasheet.
    const unitsById = new Map(units.map((u) => [u.id ?? "", u]));
    for (const c of comps) {
      const u = unitsById.get(c.unit_id ?? "");
      const points = u?.points;
      const tiers = c.tiers;
      if (!u || !points?.length || !tiers?.length) continue; // nothing to cross-check
      const ranges = tiers
        .map((t) => {
          const rows = t.models ?? [];
          return {
            min: rows.reduce((n, m) => n + (m.min ?? 0), 0),
            max: rows.reduce((n, m) => n + (m.max ?? 0), 0),
          };
        })
        .filter((r) => r.max > 0);
      if (!ranges.length) continue;
      const overlap = ranges.some((a, i) =>
        ranges.some((b, j) => i < j && a.min <= b.max && b.min <= a.max),
      );
      if (overlap) continue; // choice-based pricing — not a flat size→cost map
      // First-copy prices (army ordinal 1): every legal size must be covered.
      const firstCopy = points.filter((p) => p.unit_count_min == null || p.unit_count_min <= 1);
      const active = firstCopy.length ? firstCopy : points;
      const covers = (n: number) =>
        active.some((p) => (p.models ?? 0) <= n && n <= (p.models_max ?? p.models ?? 0));
      const shown = points
        .map((p) => (p.models_max && p.models_max !== p.models ? `${p.models}-${p.models_max}` : `${p.models}`))
        .join(", ");
      const errs: Array<{ path: string; message: string }> = [];
      for (const r of ranges) {
        let gap: number | undefined;
        for (let n = r.min; n <= r.max; n++)
          if (!covers(n)) {
            gap = n;
            break;
          }
        if (gap !== undefined)
          errs.push({
            path: `/${c.unit_id}`,
            message: `unit "${c.unit_id}": composition tier admits ${gap} model(s) but no points tier prices that size (points sizes: ${shown}) — a range-priced tier is missing its models_max, or points and composition tiers are misaligned`,
          });
      }
      if (errs.length > 0) {
        result.failed++;
        result.errors.push({ file: resolve(dir, "units.json"), index: 0, errors: errs });
      }
    }
  }

  // A stale allowlist entry (no longer an orphan) must be removed so the list
  // can't silently mask a future regression at that triple. Only entries whose
  // faction was actually scanned are eligible — so a partial dataset (e.g. a test
  // fixture with no compositions for that faction) never spuriously flags them.
  const stale = [...KNOWN_LOADOUT_ORPHANS].filter(
    (k) => scannedFactions.has(k.split("/")[0]) && !seenAllowed.has(k),
  );
  if (stale.length > 0) {
    result.failed++;
    result.errors.push({
      file: "tools/src/integrity.ts",
      index: 0,
      errors: stale.map((k) => ({
        path: "/KNOWN_LOADOUT_ORPHANS",
        message: `allowlist entry "${k}" is no longer an orphan — remove it`,
      })),
    });
  }

  // ── Cross-faction collision policy (see COLLISION_POLICIES) ──
  //
  // One table-driven pass over every per-faction data file: undeclared file
  // types fail, within-faction duplicate ids fail, `replicated-identical`
  // copies must be canonically equal across factions, and `unique` ids may
  // live in only one faction dir. This is the repo-wide gate that replaces
  // per-entity whack-a-mole fixes for id shadowing.
  const factionFiles = await glob("{core,enrichment}/*/*.json", { cwd: root, absolute: true });
  factionFiles.sort();
  const canonical = (v: unknown): string =>
    JSON.stringify(v, (_key, value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
        : value,
    );
  /** basename → id → [{faction, file, blob}] for the cross-faction passes. */
  const byBasename = new Map<string, Map<string, { faction: string; file: string; blob: string }[]>>();
  const seenDrift = new Set<string>();

  for (const file of factionFiles) {
    const faction = basename(dirname(file));
    const name = basename(file, ".json");
    // Scratch/report dirs and files are not dataset content; the shared
    // `_core` enrichment pool is.
    if (faction.startsWith("_") && faction !== "_core") continue;
    if (name.startsWith("_")) continue;

    const policy = COLLISION_POLICIES[name];
    if (!policy) {
      result.failed++;
      result.errors.push({
        file,
        index: 0,
        errors: [
          {
            path: "/",
            message:
              `data file type "${name}.json" has no declared collision policy — add "${name}" to ` +
              `COLLISION_POLICIES in tools/src/integrity.ts (faction-scoped / replicated-identical / ` +
              `unique / merged) so cross-faction id collisions can't silently shadow records`,
          },
        ],
      });
      continue;
    }
    if (policy.policy === "merged") continue;

    let records: Record<string, unknown>[];
    try {
      records = readArray<Record<string, unknown>>(file);
    } catch {
      continue; // structural problems are the AJV pass's job
    }
    if (!Array.isArray(records)) continue;

    // Within-faction id uniqueness (all id-bearing classes). The linked API
    // collapses same-(faction,id) records first-wins, silently shadowing the
    // later one. Skip types the older targeted checks already cover.
    if (!LEGACY_DUP_CHECKED.has(name)) {
      const counts = new Map<string, number>();
      for (const r of records) {
        const id = r[policy.idKey];
        if (typeof id === "string") counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const dups = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
      if (dups.length > 0) {
        result.failed++;
        result.errors.push({
          file,
          index: 0,
          errors: dups.map((id) => ({
            path: "/",
            message: `duplicate ${policy.idKey} "${id}" appears ${counts.get(id)}× in ${faction}/${name}.json — ids must be unique within a faction; the later entry is silently shadowed (first-wins)`,
          })),
        });
      }
    }

    let group = byBasename.get(name);
    if (!group) {
      group = new Map();
      byBasename.set(name, group);
    }
    for (const r of records) {
      const id = r[policy.idKey];
      if (typeof id !== "string") continue;
      const entry = group.get(id) ?? [];
      entry.push({ faction, file, blob: canonical(r) });
      group.set(id, entry);
    }
  }

  for (const [name, group] of byBasename) {
    const policy = COLLISION_POLICIES[name];
    if (!policy || policy.policy === "merged" || policy.policy === "faction-scoped") continue;
    result.totalFiles++;
    for (const [id, copies] of group) {
      const factions = [...new Set(copies.map((c) => c.faction))];
      if (factions.length < 2) continue;
      result.totalItems++;
      if (policy.policy === "unique") {
        result.failed++;
        result.errors.push({
          file: copies[0].file,
          index: 0,
          errors: [
            {
              path: "/",
              message: `${name} id "${id}" exists under ${factions.length} factions (${factions.join(", ")}) — this type's ids are declared unique; either rename the copies or promote "${name}" to a shared collision policy`,
            },
          ],
        });
        continue;
      }
      // replicated-identical
      const blobs = new Set(copies.map((c) => c.blob));
      if (blobs.size > 1) {
        const key = `${name}/${id}`;
        if (KNOWN_REPLICATED_DRIFT.has(key)) {
          seenDrift.add(key);
          result.passed++;
          continue;
        }
        result.failed++;
        result.errors.push({
          file: copies[0].file,
          index: 0,
          errors: [
            {
              path: "/",
              message: `${name} id "${id}" has drifted across factions (${factions.join(", ")}) — replicated copies must be byte-identical (the linked API collapses them first-wins, so drift silently shadows all but one copy); re-sync from the authoritative copy`,
            },
          ],
        });
      } else {
        result.passed++;
      }
    }
  }

  // Stale drift-allowlist entries must be removed (mirror of the loadout-orphan
  // staleness rule) so the list can't mask a future regression. Only entries
  // whose file type was actually scanned are eligible — a partial dataset
  // (test fixture) never spuriously flags them.
  const staleDrift = [...KNOWN_REPLICATED_DRIFT].filter(
    (k) => byBasename.has(k.split("/")[0]) && !seenDrift.has(k),
  );
  if (staleDrift.length > 0) {
    result.failed++;
    result.errors.push({
      file: "tools/src/integrity.ts",
      index: 0,
      errors: staleDrift.map((k) => ({
        path: "/KNOWN_REPLICATED_DRIFT",
        message: `drift-allowlist entry "${k}" is no longer drifted — remove it`,
      })),
    });
  }

  return result;
}
