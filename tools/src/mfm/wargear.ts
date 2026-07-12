/**
 * wargear.ts — Phase 5: derive per-model default loadouts AND wargear-options
 * from the GW MFM dump, the authoritative source (BSData is the fallback).
 *
 * The dump models loadouts at a different altitude than the repo schema:
 *   - `base_miniature_loadout` gives each model-type's out-of-the-box weapons →
 *     maps directly onto `unit-composition.models[].default_weapon_ids`.
 *   - `loadout_choice_set` ships two shapes: a whole-loadout *cross-product*
 *     (every swappable slot enumerated, base branch included) and a *per-slot*
 *     set (one set per independent choice, e.g. Necron Warriors' {ccw} +
 *     {gauss flayer | gauss reaper}). Each set is translated into one
 *     `replaces` + `replacement_choice` option by diffing its branches against
 *     the base loadout **restricted to the set's own scope** (the union of
 *     weapons its branches mention): the restriction is the identity for a
 *     cross-product set, keeps unrelated slots out of `replaces` for a per-slot
 *     set, and turns base-disjoint sets (icons, instruments) into pure
 *     additions. Every weapon a model can field appears in some branch, so
 *     every weapon stays reachable — no orphans.
 *   - `limited_wargear_choice_set` + `wargear_limit` carry per-weapon squad caps
 *     ("1 heavy weapon per 5 models"). The repo's per-option `model_constraint`
 *     can't express a per-weapon cap inside a cross-product option, so caps are
 *     applied best-effort (the tightest applicable ratio) and the residue is
 *     reported. Caps affect only the *advisory* maximal loadout — the pinned base
 *     loadout reads `default_weapon_ids` and is always exact.
 *
 * DRY RUN by default; `--write` applies. Matching is per faction (a datasheet is
 * reconciled against the repo unit in its own faction dir, with Space Marine /
 * Chaos shared-roster fallback to the parent dir).
 */
import * as fs from "fs";
import * as path from "path";
import { nameToId } from "../converters/id-generator.js";
import {
  MfmDump,
  REPO_ROOT,
  type DatasheetRow,
  type PublicationRow,
  type FactionKeywordRow,
  type MiniatureRow,
  type WargearItemRow,
  type WargearOptionRow,
  type WargearOptionGroupRow,
  type BaseMiniatureLoadoutRow,
  type BaseMiniatureLoadoutWargearOptionRow,
  type LoadoutChoiceSetRow,
  type LoadoutChoiceRow,
  type LoadoutChoiceWargearItemRow,
  type LimitedWargearChoiceSetRow,
  type WargearLimitRow,
  type UnitCompositionRow,
  type UnitCompositionMiniatureRow,
} from "./loader.js";
import { type GoldenMode, modeOfPublication, mergeMode } from "./game-mode.js";
import { repoDirForFactionName, repoDirs, FACTION_ALIASES, SHARED_ROSTERS } from "./faction-map.js";
import type { StagedWrite } from "./apply.js";

export const CORE_DIR = path.join(REPO_ROOT, "data", "core");
const UNMATCHED_DIR = path.join(REPO_ROOT, "_private", "mfm");
/** The game_version stamp every dump-sourced ingest writes (authoritative, launch dataslate). */
export const CONFIRMED = { edition: "11th", dataslate: "launch" };

interface ModelConstraint {
  model_name?: string;
  per_n_models?: number;
  max_count?: number;
  any_number?: boolean;
}
interface DerivedOption {
  replaces?: string[];
  replacement?: string[];
  replacement_choice?: string[][];
  model_constraint: ModelConstraint | null;
}
export interface DerivedWargear {
  /** model-type display name → ordered default weapon/wargear ids (repeated by count). */
  defaultsByModel: Map<string, string[]>;
  options: DerivedOption[];
  unresolved: { name: string; context: string }[];
  notes: string[];
}

interface UnitRecord {
  id: string;
  name?: string;
  weapon_ids?: string[];
  [k: string]: unknown;
}
interface CompModel {
  name: string;
  min: number;
  max: number;
  default_weapon_ids?: string[];
  is_leader_model?: boolean;
  [k: string]: unknown;
}
interface CompRecord {
  unit_id: string;
  models: CompModel[];
  [k: string]: unknown;
}
interface WargearOptionRecord {
  id: string;
  unit_id: string;
  faction_id: string;
  game_version: { edition: string; dataslate: string };
  model_constraint?: ModelConstraint | null;
  replaces?: string[];
  replacement?: string[];
  replacement_choice?: string[][];
  is_free?: boolean;
  [k: string]: unknown;
}

function readJson<T>(p: string): T[] {
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as T[]) : [];
}

/**
 * Reviewed dump-name → repo-id overrides, by faction, for weapon-name divergences
 * the fuzzy fallback can't safely bridge (edit distance >1, or a repo "profile
 * mode" id that names the weapon differently from the GW dump). Keyed by the slug
 * `nameToId` produces from the GW wargear-item name. Each entry was confirmed by
 * the per-faction orphan diagnosis (adversarially verified: the two are the same
 * physical weapon and the target id is genuinely in the unit's weapon_ids).
 */
export const WEAPON_ALIASES: Record<string, Record<string, string>> = {
  aeldari: {
    "kha-vir": "kha-vir-the-sword-of-sorrows",
    "fire-axe": "the-fire-axe",
    "blade-of-destruction": "strike",
  },
  "chaos-space-marines": {
    "hades-battle-cannon": "defiler-cannon",
    "shearing-claws": "defiler-claws",
    "tyrants-claw-heavy-flamer": "ranged",
  },
  "genestealer-cults": {
    "leaders-bio-weapons": "leaders-cult-weapons",
  },
  tyranids: {
    "screamer-killer-talons": "scream-killer-talons",
  },
};

/**
 * Per-unit weapon-name overrides, by `faction → unit_id → dump-name-slug → repo-id`.
 * Unlike {@link WEAPON_ALIASES} (faction-wide), these apply ONLY when resolving the
 * named datasheet — for cases where the GW dump reuses one display name across two
 * distinct repo weapons (different profiles) and the faction-wide alias would corrupt
 * the *other* unit that legitimately uses the generic id. Example: GW renamed Canis
 * Rex's "Chainbreaker multi-laser" to "Questoris multi-laser", but it keeps a distinct
 * BS2+/Sustained Hits 1 profile; the generic `questoris-multi-laser` (BS3+) is used by
 * `knight-preceptor`. Mapping the dump name to `chainbreaker-multi-laser` for canis-rex
 * only keeps both correct (and the override harmlessly no-ops if GW reverts the name).
 */
export const WEAPON_ALIASES_BY_UNIT: Record<string, Record<string, Record<string, string>>> = {
  "imperial-knights": {
    "canis-rex": { "questoris-multi-laser": "chainbreaker-multi-laser" },
  },
};

/**
 * Reviewed always-on weapons to ensure present in a model's `default_weapon_ids`,
 * by `faction → unit_id → model display name → [weapon ids]`. These are weapons a
 * model always carries that the GW dump does not model as a base-loadout item for
 * the matched datasheet (named-character weapons, profile variants, repo
 * weapon-id spelling that differs from the dump). Merged into the derived defaults
 * after resolution — making the implicit orphan→base fallback explicit so the
 * loadout-coverage gate sees no orphan. Each entry was confirmed by the
 * per-faction orphan resolution (the weapon is fixed, not a swap/choice).
 */
const MANUAL_DEFAULTS: Record<string, Record<string, Record<string, string[]>>> = {
  // Single fixed model (min=max=1) carries the weapon the GW dump doesn't model
  // as a base item for the matched datasheet. Verified per-unit (resolution pass):
  // each target is a single-figure model row, so the weapon lands on exactly that
  // figure — never multiplied across a bulk model-type.
  "adeptus-astartes": {
    "decimus-kill-team": { "Watch Sergeant": ["plasma-pistol"] },
  },
  aeldari: {
    // The Corsair Voidscarred specialist miniatures each carry a close combat
    // weapon per the GW app, but the dump's base_miniature_loadout omits it for
    // these figures (it lists only their distinguishing wargear). Re-add it so a
    // wargear --write keeps the per-figure rows matching the datasheet.
    "corsair-voidscarred": {
      "Shade Runner": ["close-combat-weapon"],
      "Soul Weaver": ["close-combat-weapon"],
      "Way Seeker": ["close-combat-weapon"],
    },
  },
  "agents-of-the-imperium": {
    "aquila-kill-team": { "Watch Sergeant": ["plasma-pistol"] },
    "rogue-trader-entourage": { "Lectro-Maester": ["voltaic-pistol"] },
  },
  "astra-militarum": {
    "gaunts-ghosts": { "Try Again Bragg": ["braggs-autocannon"] },
  },
  necrons: {
    "tesseract-vault": { "Tesseract Vault": ["tesla-spheres"] },
    "the-silent-king": { Szarekh: ["scythe-of-dust", "staff-of-stars"] },
  },
  "tau-empire": {
    "breacher-team": { "Breacher Fire Warrior Shas’ui": ["support-turret"] },
    "strike-team": { "Fire Warrior Shas’ui": ["support-turret"] },
  },
};

/** True when `a` and `b` differ by at most one insertion/deletion/substitution. */
export function withinEditDistance1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let diff = 0;
    for (let i = 0; i < la; i++) if (a[i] !== b[i]) if (++diff > 1) return false;
    return diff === 1;
  }
  // One longer: check it's the shorter with a single char inserted.
  const [short, long] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
    } else {
      if (skipped) return false;
      skipped = true;
      j++; // consume one extra char from the longer string
    }
  }
  return true;
}

export interface AutoResolution {
  name: string;
  from: string;
  to: string;
}

/**
 * A faction-scoped name→id resolver. Exact kebab match first; on a miss, a
 * *conservative* fuzzy fallback maps GW↔repo spelling drift (e.g. "Absolvor bolt
 * pistol" → `absolver-bolt-pistol`, plural drift) — edit distance ≤1 against the
 * faction vocabulary, the candidate unique and ≥6 chars so short ids never
 * collide. Every fuzzy hit is recorded for the report; genuine misses return null
 * (→ triaged). Mutates `audit` with each fuzzy resolution.
 *
 * `priorityAliases` (reviewed per-unit overrides) are applied BEFORE the direct
 * `validIds` match — they REMAP one valid id to another (the GW dump reuses a display
 * name across two distinct repo weapons), so they must win over the exact-slug return
 * that would otherwise pick the wrong weapon. They are not fuzzy, so they skip `audit`.
 */
export function makeResolver(
  validIds: Set<string>,
  audit: AutoResolution[],
  aliases: Record<string, string> = {},
  priorityAliases: Record<string, string> = {},
): (name: string) => string | null {
  const idList = [...validIds].filter((id) => id.length >= 6);
  return (name: string) => {
    let id: string;
    try {
      id = nameToId(name);
    } catch {
      return null;
    }
    const forced = priorityAliases[id];
    if (forced && validIds.has(forced)) return forced;
    if (validIds.has(id)) return id;
    // Reviewed faction override (weapon-name divergence the fuzzy pass can't bridge).
    const aliased = aliases[id];
    if (aliased && validIds.has(aliased)) {
      audit.push({ name, from: id, to: aliased });
      return aliased;
    }
    if (id.length < 6) return null;
    const near = idList.filter((v) => withinEditDistance1(id, v));
    if (near.length === 1) {
      audit.push({ name, from: id, to: near[0] });
      return near[0];
    }
    return null;
  };
}

/**
 * Per-unit resolver: layers the unit's reviewed alias overrides (when any) on the
 * faction resolver, then prefers the unit's own **stat variant** of the resolved
 * id. The `weapon-variants` pass splits stat-conflicting weapons into a bare entry
 * plus `${baseId}-${unitId}` variants and rewires this unit's references to the
 * variant — so resolving a dump name back to the bare id on a wargear re-run would
 * silently undo that rewiring and orphan the variant. If the faction vocabulary
 * holds a variant of the resolved id for this unit, the variant wins.
 */
export function unitScopedResolver(
  validIds: Set<string>,
  autoResolved: AutoResolution[],
  dir: string,
  unitId: string,
  factionResolve: (name: string) => string | null,
): (name: string) => string | null {
  const unitAliases = WEAPON_ALIASES_BY_UNIT[dir]?.[unitId];
  const base = unitAliases
    ? makeResolver(validIds, autoResolved, WEAPON_ALIASES[dir] ?? {}, unitAliases)
    : factionResolve;
  return (name: string) => {
    const id = base(name);
    if (id && validIds.has(`${id}-${unitId}`)) return `${id}-${unitId}`;
    return id;
  };
}

/** Faction-wide valid weapon-id vocabulary for `dir`: every id in `weapons.json`,
 *  plus every id already referenced by a unit (`weapon_ids`) or an existing option
 *  (so a dump weapon missing from `weapons.json` but present as a unit weapon still
 *  resolves). Shared by {@link runWargear} and {@link forEachDirDatasheet} so the
 *  golden resolves dump weapon names through the exact vocabulary ingest uses. */
export function dirValidIds(dir: string, units: UnitRecord[], wopts: WargearOptionRecord[]): Set<string> {
  const validIds = new Set<string>(
    readJson<{ id?: string }>(path.join(CORE_DIR, dir, "weapons.json")).map((w) => w.id ?? "")
  );
  for (const u of units) for (const id of u.weapon_ids ?? []) validIds.add(id);
  for (const o of wopts) {
    for (const id of o.replaces ?? []) validIds.add(id);
    for (const id of o.replacement ?? []) validIds.add(id);
    for (const g of o.replacement_choice ?? []) for (const id of g) validIds.add(id);
  }
  return validIds;
}

/** Multiset difference `a − b` (per-id counts), preserving a's order. */
function multisetDiff(a: string[], b: string[]): string[] {
  const rem = new Map<string, number>();
  for (const x of b) rem.set(x, (rem.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = rem.get(x) ?? 0;
    if (n > 0) rem.set(x, n - 1);
    else out.push(x);
  }
  return out;
}

/** Set-equality on two id multisets (order-insensitive, count-sensitive). */
function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const count = new Map<string, number>();
  for (const x of a) count.set(x, (count.get(x) ?? 0) + 1);
  for (const x of b) {
    const n = (count.get(x) ?? 0) - 1;
    if (n < 0) return false;
    count.set(x, n);
  }
  return true;
}

/** The dump's *default* unit composition row for a datasheet (isDefault, else lowest displayOrder). */
function defaultUnitComposition(dump: MfmDump, datasheetId: string): UnitCompositionRow | undefined {
  const ucs = (dump.groupBy<UnitCompositionRow>("unit_composition", "datasheetId").get(datasheetId) ?? [])
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder);
  return ucs.find((c) => c.isDefault) ?? ucs[0];
}

/** Per-miniature default model count (Σ `unit_composition_miniature.min`) for the default composition. */
function modelCountByMiniId(dump: MfmDump, datasheetId: string): Map<string, number> {
  const out = new Map<string, number>();
  const uc = defaultUnitComposition(dump, datasheetId);
  if (!uc) return out;
  const minis = dump
    .groupBy<UnitCompositionMiniatureRow>("unit_composition_miniature", "unitCompositionId")
    .get(uc.id!);
  for (const m of minis ?? []) out.set(m.miniatureId, (out.get(m.miniatureId) ?? 0) + m.min);
  return out;
}

/**
 * Resolve a datasheet's per-model default loadout from the GW `wargear_option_group`
 * / `wargear_option` model — the authoritative default the army builder shows.
 * Returns a map keyed by miniature display name; unresolved items are collected.
 *
 * A group is, in this dump, either entirely `defaultValue>0` (a base-loadout slot)
 * or entirely `defaultValue==0` (a swap slot). We read the base slots: each option's
 * per-model quantity is `defaultValue / model_count` (a checkbox `default=1` on a
 * single figure → 1; a bulk stepper `default=N` over N models → 1 each; a genuine
 * multi-weapon like the Megatrakk's twin big shoota `default=2` over 1 model → 2).
 * The matching swap slots (`defaultValue==0`) carry no `replaces` relationship, so
 * options stay derived from `loadout_choice_set` (delta-factored against this base).
 */
/**
 * The legacy base loadout from `base_miniature_loadout` (per miniature id) — the
 * 1.0.2 derivation source, kept as the *fallback* for miniatures the option-group
 * model can't cleanly express (heterogeneous / non-uniform). `skip` holds the
 * miniature ids already populated from option groups so the fallback never
 * re-reports their unresolved names or overrides their corrected default.
 */
function baseFromMiniatureLoadout(
  dump: MfmDump,
  datasheetId: string,
  resolve: (name: string) => string | null,
  unresolved: { name: string; context: string }[],
  skip: ReadonlySet<string>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!dump.tables["base_miniature_loadout"] || !dump.tables["base_miniature_loadout_wargear_option"]) {
    return out; // dump (or test fixture) without the legacy tables — no fallback
  }
  const miniById = dump.byId<MiniatureRow>("miniature");
  const miniName = (id: string) => dump.enName(miniById.get(id)) ?? id;
  const wiName = dump.byId<WargearItemRow>("wargear_item");
  const woById = dump.byId<WargearOptionRow>("wargear_option");
  const bmlOpts = dump.groupBy<BaseMiniatureLoadoutWargearOptionRow>(
    "base_miniature_loadout_wargear_option",
    "baseMiniatureLoadoutId",
  );
  for (const b of dump.groupBy<BaseMiniatureLoadoutRow>("base_miniature_loadout", "datasheetId").get(datasheetId) ?? []) {
    if (skip.has(b.miniatureId)) continue;
    const ids: string[] = [];
    let unresolvedWeapon = false;
    for (const x of bmlOpts.get(b.id) ?? []) {
      const wo = woById.get(x.wargearOptionId);
      if (!wo) continue;
      const item = wiName.get(wo.wargearItemId);
      const name = dump.enName(item);
      if (!name) continue;
      const id = resolve(name);
      if (!id) {
        unresolved.push({ name, context: `base loadout of ${miniName(b.miniatureId)}` });
        if (item?.wargearType === "weapon") unresolvedWeapon = true;
        continue;
      }
      for (let i = 0; i < Math.max(1, x.count); i++) ids.push(id);
    }
    if (ids.length && !unresolvedWeapon) out.set(b.miniatureId, ids);
  }
  return out;
}

function deriveDefaults(
  dump: MfmDump,
  datasheetId: string,
  resolve: (name: string) => string | null,
  unresolved: { name: string; context: string }[],
  notes: string[],
): { byName: Map<string, string[]>; byMiniId: Map<string, string[]> } {
  const miniById = dump.byId<MiniatureRow>("miniature");
  const miniName = (id: string) => dump.enName(miniById.get(id)) ?? id;
  const wiName = dump.byId<WargearItemRow>("wargear_item");
  const woByGroup = dump.groupBy<WargearOptionRow>("wargear_option", "wargearOptionGroupId");
  const groups = (dump.groupBy<WargearOptionGroupRow>("wargear_option_group", "datasheetId").get(datasheetId) ?? [])
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder);
  const modelCounts = modelCountByMiniId(dump, datasheetId);

  // Per miniature, the base (default>0) groups. A datasheet-wide group
  // (miniatureId null) names a unit-wide always-on item the dump can't attribute
  // to a model row — leave those to the reviewed MANUAL_DEFAULTS channel.
  const baseGroupsByMini = new Map<string, WargearOptionGroupRow[]>();
  for (const g of groups) {
    if (!g.miniatureId) continue;
    if ((woByGroup.get(g.id) ?? []).some((o) => o.defaultValue > 0)) {
      (baseGroupsByMini.get(g.miniatureId) ?? baseGroupsByMini.set(g.miniatureId, []).get(g.miniatureId)!).push(g);
    }
  }

  const byMiniId = new Map<string, string[]>();
  for (const [miniId, gs] of baseGroupsByMini) {
    // A miniature split across >1 default group has a non-uniform per-figure loadout
    // no single row can express (e.g. Aquila Kill Team's Deathwatch Veteran built from
    // choices, Voidsmen-at-Arms) — fall back to base_miniature_loadout below.
    if (gs.length > 1) {
      notes.push(`${miniName(miniId)}: ${gs.length} default loadout groups — base_miniature_loadout fallback`);
      continue;
    }
    const mc = modelCounts.get(miniId) ?? 0;
    if (!mc) {
      notes.push(`${miniName(miniId)}: no model_count — base_miniature_loadout fallback`);
      continue;
    }
    const ids: string[] = [];
    // Don't half-populate a model whose base *weapon* fails to resolve (a partial
    // default would leave the unresolved weapon a false orphan); a non-weapon item
    // (medikit, banner) failing is harmless — skip just the item.
    let unresolvedWeapon = false;
    let nonUniform = false;
    for (const o of (woByGroup.get(gs[0].id) ?? []).slice().sort((a, b) => a.displayOrder - b.displayOrder)) {
      if (o.defaultValue <= 0) continue;
      const item = wiName.get(o.wargearItemId);
      const name = dump.enName(item);
      if (!name) continue;
      const id = resolve(name);
      if (!id) {
        unresolved.push({ name, context: `default loadout of ${miniName(miniId)}` });
        if (item?.wargearType === "weapon") unresolvedWeapon = true;
        continue;
      }
      // A checkbox is per-model (every model of the type carries it); a stepper is a
      // squad-total count spread across the model_count (Breaka Boy hammer 5/5 = 1;
      // Megatrakk twin big shoota 2/1 = 2). A fractional stepper share (only some
      // models carry it by default) can't be a uniform per-model row → fall back.
      const perModel = o.inputType === "stepper" ? o.defaultValue / mc : o.defaultValue;
      if (!Number.isInteger(perModel) || perModel < 1) {
        nonUniform = true;
        break;
      }
      for (let i = 0; i < perModel; i++) ids.push(id);
    }
    if (nonUniform) {
      notes.push(`${miniName(miniId)}: non-uniform default count — base_miniature_loadout fallback`);
      continue;
    }
    if (ids.length && !unresolvedWeapon) byMiniId.set(miniId, ids);
  }

  // Fallback for every miniature the option-group path did not cleanly populate —
  // preserves the 1.0.2 base for heterogeneous/odd datasheets (no regression) while
  // the clean ones keep the corrected option-group default.
  for (const [miniId, ids] of baseFromMiniatureLoadout(dump, datasheetId, resolve, unresolved, new Set(byMiniId.keys()))) {
    if (!byMiniId.has(miniId)) byMiniId.set(miniId, ids);
  }

  const byName = new Map<string, string[]>();
  for (const [miniId, ids] of byMiniId) byName.set(miniName(miniId), ids);
  return { byName, byMiniId };
}

/**
 * Per-weapon caps from the **mini-scoped single-weapon** limited sets only — the
 * subset of squad caps that are NOT promoted to {@link limitedSetBudgets}
 * (datasheet-wide single + shared + flat all become budgets). Returns a map keyed
 * `${miniatureId}::${weaponId}` → `per_n_models` (`ceil(1/ratio)`, rounded up so the
 * advisory maximal stays legal). Used to set each swap option's `model_constraint`
 * from the weapon it actually grants, instead of one datasheet-wide tightest ratio
 * stamped on every option (which used to pin base weapons — e.g. it capped a
 * 3-per-5 power fist at 1 and falsely capped an unlimited combi-weapon).
 */
function miniScopedSingleCaps(
  dump: MfmDump,
  datasheetId: string,
  resolve: (name: string) => string | null,
): Map<string, number> {
  const sets =
    dump.groupBy<LimitedWargearChoiceSetRow>("limited_wargear_choice_set", "datasheetId").get(datasheetId) ?? [];
  const limitsBySet = dump.groupBy<WargearLimitRow>("wargear_limit", "limitedWargearChoiceSetId");
  const choicesBySet = dump.groupBy<{ id: string; limitedWargearChoiceSetId: string }>(
    "limited_wargear_choice",
    "limitedWargearChoiceSetId",
  );
  const itemsByChoice = dump.groupBy<{ limitedWargearChoiceId: string; wargearItemId: string }>(
    "limited_wargear_choice_wargear_item",
    "limitedWargearChoiceId",
  );
  const wiName = dump.byId<WargearItemRow>("wargear_item");

  const out = new Map<string, number>();
  for (const s of sets) {
    if (!s.miniatureId) continue; // datasheet-wide → a budget, not a per-option cap
    const itemIds = new Set<string>();
    for (const c of choicesBySet.get(s.id) ?? []) {
      for (const it of itemsByChoice.get(c.id) ?? []) {
        const id = resolve(dump.enName(wiName.get(it.wargearItemId)) ?? "");
        if (id) itemIds.add(id);
      }
    }
    if (itemIds.size !== 1) continue; // shared (≥2) sets are budgets
    let minRatio: number | null = null;
    for (const l of limitsBySet.get(s.id) ?? []) {
      if (l.modelCount > 0 && l.choiceLimit > 0) {
        const ratio = l.choiceLimit / l.modelCount;
        if (minRatio == null || ratio < minRatio) minRatio = ratio;
      }
    }
    if (minRatio == null) continue;
    const perN = Math.ceil(1 / minRatio);
    const [id] = [...itemIds];
    const key = `${s.miniatureId}::${id}`;
    out.set(key, Math.min(out.get(key) ?? Infinity, perN));
  }
  return out;
}

/**
 * Per-(miniature, weapon) input type of the dump's **optional swap** wargear
 * options — the `defaultValue == 0` rows of each `wargear_option_group`, excluding
 * the base loadout (`defaultValue > 0`). This is the table the GW app builds and
 * enforces loadouts from: a `checkbox` option is a 0/1 toggle the app caps at one
 * instance unit-wide (the "1 X can be replaced with 1 Y" shape — e.g. Goremongers'
 * blood harpoon), while a `stepper` is a 0..N counter ("Any number of models can
 * …", capped only by the model count or a `wargear_limit` ratio). Keyed
 * `${miniatureId}::${weaponId}` → the set of input types seen for that swap (a
 * weapon offered only via checkboxes maps to `{"checkbox"}`); the set guards the
 * case where a weapon is both a base item (stepper) and a swap (checkbox), since
 * only the `defaultValue == 0` swap rows are recorded here.
 */
function swapInputTypesByMiniWeapon(
  dump: MfmDump,
  datasheetId: string,
  resolve: (name: string) => string | null,
): Map<string, Set<string>> {
  const wiName = dump.byId<WargearItemRow>("wargear_item");
  const woByGroup = dump.groupBy<WargearOptionRow>("wargear_option", "wargearOptionGroupId");
  const groups = dump.groupBy<WargearOptionGroupRow>("wargear_option_group", "datasheetId").get(datasheetId) ?? [];
  const out = new Map<string, Set<string>>();
  for (const g of groups) {
    if (!g.miniatureId) continue;
    for (const o of woByGroup.get(g.id) ?? []) {
      if (o.defaultValue > 0) continue; // base loadout, not an optional swap
      const id = resolve(dump.enName(wiName.get(o.wargearItemId)) ?? "");
      if (!id) continue;
      const key = `${g.miniatureId}::${id}`;
      (out.get(key) ?? out.set(key, new Set()).get(key)!).add(o.inputType);
    }
  }
  return out;
}

/**
 * True iff every weapon this swap grants is offered **solely** via a `checkbox` on
 * `miniatureId` — a 0/1 toggle the GW app caps at one instance unit-wide. Any
 * granted weapon that is unknown to the swap map, or that is offered via a
 * `stepper` (a counter), leaves the swap uncapped (`false`) so we never
 * over-restrict. A multi-branch "one of A/B/C" swap caps at 1 iff each alternative
 * is itself a checkbox.
 */
function checkboxCapped(
  added: string[][],
  miniatureId: string,
  swapInputTypes: Map<string, Set<string>>,
): boolean {
  let sawCheckbox = false;
  for (const branch of added) {
    for (const id of branch) {
      const types = swapInputTypes.get(`${miniatureId}::${id}`);
      if (!types || types.size !== 1 || !types.has("checkbox")) return false;
      sawCheckbox = true;
    }
  }
  return sawCheckbox;
}

/**
 * A limited-wargear **squad budget**: the listed items share one allowance whose
 * size is `count` per `per_models` models — i.e. `floor(modelCount * count /
 * per_models)` copies across the unit. Stored per unit and enforced as a sum over
 * the final loadout (`Σ counts(items) ≤ cap`), which is robust to the dump's
 * cross-product option representation in a way per-option caps are not.
 */
export interface WargearBudget {
  items: string[];
  count: number;
  per_models: number;
}

/**
 * The limited-wargear budgets for a datasheet, derived from its dump
 * `limited_wargear_choice_set` rows — but ONLY the allowances the per-weapon
 * bounds cannot model:
 *
 *   - **Shared** sets (≥2 distinct items competing for one allowance, e.g. Chaos
 *     Terminators' `heavy flamer / reaper autocannon`, 1 per 5). The per-weapon
 *     bound would let each hit the cap independently; the budget enforces the sum.
 *   - **Flat** per-unit caps (a `wargear_limit` with `modelCount = 0`, e.g.
 *     Khorne Berzerkers' `icon of Khorne`, 1 per unit). Emitted with
 *     `per_models = 0`. The per-weapon bound inflates these — a flat item taken by
 *     two model types (champion + trooper) sums to 2 — so the flat budget overrides.
 *
 * A **single-weapon per-N** set (e.g. plasma pistol: 2 on the troopers PLUS 1 on
 * the champion = 3) is deliberately NOT a budget — the per-weapon bound already
 * sums the weapon's capacity across the model types that may take it, which is the
 * correct total. Forcing it into a unit-wide budget would wrongly cap that total at
 * the troopers' ratio alone. Items resolved via `resolve`; unresolved-item budgets
 * are dropped. The binding ratio is the smallest `choiceLimit/modelCount` across
 * the set's `wargear_limit` rows (GW lists the same ratio at several breakpoints).
 */
export function limitedSetBudgets(
  dump: MfmDump,
  datasheetId: string,
  resolve: (name: string) => string | null,
): WargearBudget[] {
  const sets =
    dump.groupBy<LimitedWargearChoiceSetRow>("limited_wargear_choice_set", "datasheetId").get(datasheetId) ?? [];
  const limitsBySet = dump.groupBy<WargearLimitRow>("wargear_limit", "limitedWargearChoiceSetId");
  const choicesBySet = dump.groupBy<{ id: string; limitedWargearChoiceSetId: string }>(
    "limited_wargear_choice",
    "limitedWargearChoiceSetId",
  );
  const itemsByChoice = dump.groupBy<{ limitedWargearChoiceId: string; wargearItemId: string }>(
    "limited_wargear_choice_wargear_item",
    "limitedWargearChoiceId",
  );
  const wiName = dump.byId<WargearItemRow>("wargear_item");

  const out: WargearBudget[] = [];
  for (const s of [...sets].sort((a, b) => a.id.localeCompare(b.id))) {
    const items = new Set<string>();
    for (const c of choicesBySet.get(s.id) ?? []) {
      for (const it of itemsByChoice.get(c.id) ?? []) {
        const id = resolve(dump.enName(wiName.get(it.wargearItemId)) ?? "");
        if (id) items.add(id);
      }
    }
    if (!items.size) continue;

    // A `modelCount = 0` limit is a flat per-unit cap; otherwise the smallest
    // `choiceLimit/modelCount` ratio across the rows is binding.
    let flat: number | null = null;
    let ratioCount: number | null = null;
    let ratioPer: number | null = null;
    for (const l of limitsBySet.get(s.id) ?? []) {
      if (l.choiceLimit <= 0) continue;
      if (l.modelCount === 0) {
        flat = flat == null ? l.choiceLimit : Math.min(flat, l.choiceLimit);
      } else if (ratioCount == null || l.choiceLimit / l.modelCount < ratioCount / ratioPer!) {
        ratioCount = l.choiceLimit;
        ratioPer = l.modelCount;
      }
    }

    const sorted = [...items].sort();
    if (flat != null) {
      // Flat per-unit cap (shared or single) — the per-weapon bound can't express it.
      out.push({ items: sorted, count: flat, per_models: 0 });
    } else if (ratioCount != null && ratioPer != null && (items.size >= 2 || s.miniatureId == null)) {
      // Shared ratio allowances (≥2 items) AND datasheet-wide single-weapon ratio
      // sets become summed budgets: the dump scopes these to the whole unit, so the
      // squad-wide sum `floor(modelCount * count / per_models)` is the correct cap and
      // a per-option `per_n_models` would mis-apply when several swap options add the
      // same weapon. Mini-scoped single-weapon ratio sets are deliberately NOT budgets
      // (a unit-wide budget would under-count a weapon a *different* model type can also
      // carry, e.g. a champion's plasma pistol on top of the troopers' ratio) — those
      // stay per-option in `deriveWargear`.
      out.push({ items: sorted, count: ratioCount, per_models: ratioPer });
    }
  }
  return out;
}

/**
 * Derive defaults + wargear-options for one datasheet. Pure over the dump + a
 * faction-scoped name resolver; the caller persists.
 */
export function deriveWargear(
  dump: MfmDump,
  datasheetId: string,
  resolve: (name: string) => string | null,
): DerivedWargear {
  const unresolved: { name: string; context: string }[] = [];
  const notes: string[] = [];
  const { byName: defaultsByModel, byMiniId: baseByMiniId } = deriveDefaults(
    dump,
    datasheetId,
    resolve,
    unresolved,
    notes,
  );

  const miniName = (id: string) => dump.enName(dump.byId<MiniatureRow>("miniature").get(id)) ?? id;
  const wiName = dump.byId<WargearItemRow>("wargear_item");
  const choicesBySet = dump.groupBy<LoadoutChoiceRow>("loadout_choice", "loadoutChoiceSetId");
  const itemsByChoice = dump.groupBy<LoadoutChoiceWargearItemRow>(
    "loadout_choice_wargear_item",
    "loadoutChoiceId",
  );
  const sets = dump
    .groupBy<LoadoutChoiceSetRow>("loadout_choice_set", "datasheetId")
    .get(datasheetId);

  // Multi-model = the datasheet has >1 miniature type (drives whether an option is
  // scoped with model_constraint.model_name). Read it from the dump composition, not
  // defaultsByModel.size — a miniature the heterogeneity guard skipped still counts.
  const multiModel = dumpComposition(dump, datasheetId).length > 1;
  const miniCaps = miniScopedSingleCaps(dump, datasheetId, resolve);
  const swapInputTypes = swapInputTypesByMiniWeapon(dump, datasheetId, resolve);
  const options: DerivedOption[] = [];

  for (const set of (sets ?? []).slice().sort((a, b) => a.id.localeCompare(b.id))) {
    const mini = set.miniatureId ? miniName(set.miniatureId) : null;
    // Base = the miniature's recorded base loadout (by id — robust to a dump↔repo
    // model-name mismatch that would otherwise misidentify the no-swap branch).
    const base = (set.miniatureId && baseByMiniId.get(set.miniatureId)) || null;
    if (set.alternate) notes.push(`alternate loadout_choice_set ${set.id.slice(0, 8)} (${mini ?? "all"}) — review`);

    // Resolve each choice branch to an id multiset; drop unresolved-emptied branches.
    const branches: string[][] = [];
    for (const ch of (choicesBySet.get(set.id) ?? []).slice().sort((a, b) => a.id.localeCompare(b.id))) {
      const ids: string[] = [];
      let dropped = false;
      for (const it of itemsByChoice.get(ch.id) ?? []) {
        const name = dump.enName(wiName.get(it.wargearItemId));
        if (!name) continue;
        const id = resolve(name);
        if (!id) {
          unresolved.push({ name, context: `loadout choice (${mini ?? "all"})` });
          dropped = true;
          continue;
        }
        for (let i = 0; i < Math.max(1, it.count); i++) ids.push(id);
      }
      if (dropped && ids.length === 0) continue;
      if (ids.length) branches.push(ids);
    }
    if (branches.length === 0) continue;

    // Factor each branch into its DELTA vs the model's base loadout, restricted
    // to the SET'S OWN SCOPE (the union of weapons its branches mention). The
    // dump ships two shapes under `loadout_choice_set`:
    //   - a whole-loadout cross-product (every slot enumerated, base branch
    //     included) — the scope covers the full base, so the restriction is the
    //     identity and the delta is the branch's real diff;
    //   - a PER-SLOT set (e.g. Necron Warriors: one set = {ccw}, another =
    //     {gauss flayer | gauss reaper}) — diffing against the FULL base would
    //     drag every other slot's weapon into `replaces` (the reaper swap ate
    //     the ccw), so the base is first restricted to the slot's weapons.
    // A set none of whose branches touch the base at all (icons, instruments)
    // restricts the base to ∅ and correctly becomes a pure addition rather than
    // a corrupt "replaces the whole kit" swap. Only weapons that actually change
    // become a swap, so an unchanged slot's weapon never lands on both the
    // `replaces` and `replacement` side (which would make a fixed base weapon
    // look swappable and corrupt its bounds). Branches that remove the same set
    // are grouped into one option's `replacement_choice`.
    const fullBase = base ?? branches[0];
    const scope = new Set<string>(branches.flat());
    const baseSet = fullBase.filter((id) => scope.has(id));
    const groups = new Map<string, { removed: string[]; added: string[][] }>();
    const seenAdded = new Set<string>();
    for (const b of branches) {
      const removed = multisetDiff(baseSet, b);
      const added = multisetDiff(b, baseSet);
      if (removed.length === 0 && added.length === 0) continue; // == base, no-op
      const rKey = [...removed].sort().join("|");
      const aKey = `${rKey}>>${[...added].sort().join("|")}`;
      if (seenAdded.has(aKey)) continue; // duplicate delta
      seenAdded.add(aKey);
      const g = groups.get(rKey) ?? { removed, added: [] };
      // A pure-removal branch (added empty) can't be a replacement; skip it — the
      // base already covers "not taking the upgrade".
      if (added.length > 0) g.added.push(added);
      groups.set(rKey, g);
    }

    for (const { removed, added } of groups.values()) {
      if (added.length === 0) continue;
      // The model_constraint caps how many MODELS may take this swap. Squad caps on
      // the *weapons* it grants are enforced by `wargear_budgets` (shared, flat, and
      // datasheet-wide single-weapon sets), so an option whose granted weapons are
      // budgeted or uncapped stays `any_number` (the swap itself is per-model — this
      // is what lets a base weapon drop to 0). The only caps applied per-option are
      // the mini-scoped single-weapon sets (not budgets): take the binding ratio over
      // the weapons this option actually grants.
      const mc: ModelConstraint = {};
      if (mini && multiModel) mc.model_name = mini;
      let perN: number | null = null;
      if (set.miniatureId) {
        for (const branch of added) {
          for (const id of branch) {
            const c = miniCaps.get(`${set.miniatureId}::${id}`);
            if (c != null) perN = perN == null ? c : Math.min(perN, c);
          }
        }
      }
      // Precedence: a `wargear_limit` ratio (mini-scoped single set) binds first;
      // else if the dump offers this swap solely via a checkbox (a 0/1 toggle), the
      // app caps it at 1 instance unit-wide (Goremongers' blood harpoon); else the
      // swap is per-model (`any_number`, capped by model count / a shared budget).
      if (perN != null) mc.per_n_models = perN;
      else if (set.miniatureId && checkboxCapped(added, set.miniatureId, swapInputTypes)) mc.max_count = 1;
      else mc.any_number = true;

      const opt: DerivedOption = {
        model_constraint: Object.keys(mc).length ? mc : null,
      };
      if (removed.length > 0) opt.replaces = removed;
      if (added.length === 1) opt.replacement = added[0];
      else opt.replacement_choice = added;
      options.push(opt);
    }
  }

  return { defaultsByModel, options, unresolved, notes };
}

/** One miniature row of the dump's default unit composition. */
export interface DumpMini {
  name: string;
  min: number;
  max: number;
}

/**
 * The dump's *default* unit composition for a datasheet, as an ordered list of
 * (miniature name, min, max) — sorted by the miniature's `displayOrder` so the
 * special/champion figure (which the dump lists first) leads. Empty when the
 * datasheet has no composition rows in the dump.
 */
export function dumpComposition(dump: MfmDump, datasheetId: string): DumpMini[] {
  const miniById = dump.byId<MiniatureRow & { displayOrder?: number }>("miniature");
  const miniName = (id: string) => dump.enName(miniById.get(id)) ?? id;
  const order = (id: string) => miniById.get(id)?.displayOrder ?? 0;
  const uc = defaultUnitComposition(dump, datasheetId);
  if (!uc) return [];
  const minis = (
    dump.groupBy<UnitCompositionMiniatureRow>("unit_composition_miniature", "unitCompositionId").get(uc.id!) ?? []
  )
    .slice()
    .sort((a, b) => order(a.miniatureId) - order(b.miniatureId));
  // Collapse duplicate miniature rows (same display name) by summing counts.
  const byName = new Map<string, DumpMini>();
  for (const m of minis) {
    const name = miniName(m.miniatureId);
    const cur = byName.get(name);
    if (cur) {
      cur.min += m.min;
      cur.max += m.max;
    } else {
      byName.set(name, { name, min: m.min, max: m.max });
    }
  }
  // Drop figures absent from the default composition (max 0) — these are optional
  // attachments the dump lists at 0/0, not model rows to synthesize.
  return [...byName.values()].filter((m) => m.max > 0);
}

/** A single dump composition tier as ordered per-miniature count ranges. */
export type DumpTier = { name: string; min: number; max: number }[];

export interface AggregatedComposition {
  /** One tier per dump `unit_composition` row, displayOrder-sorted; rows miniature-ordered. */
  tiers: DumpTier[];
  /** Per-miniature aggregate envelope: min-of-mins / max-of-maxes across all tiers. */
  envelope: Map<string, { min: number; max: number }>;
  /** Set when a tier listed a miniature name more than once (kill-team shape — do not auto-apply). */
  skip?: "duplicate-names";
}

/**
 * The dump's *full* set of buildable sizes for a datasheet — every
 * `unit_composition` row (not just the default), each as a per-miniature count
 * range, plus the aggregate envelope across them. This is the authoritative
 * source for a unit's composition tiers and the corrected `models[]` min/max.
 *
 * A tier that repeats a miniature display name (the kill-team per-slot shape,
 * e.g. several "Deathwatch Veteran" rows) cannot map onto the repo's
 * one-row-per-name model, so {@link AggregatedComposition.skip} is set and the
 * caller leaves the unit untouched. Rows the dump lists at max 0 (optional
 * attachments) are dropped, matching {@link dumpComposition}.
 */
export function aggregateComposition(dump: MfmDump, datasheetId: string): AggregatedComposition {
  const miniById = dump.byId<MiniatureRow & { displayOrder?: number }>("miniature");
  const miniName = (id: string) => dump.enName(miniById.get(id)) ?? id;
  const order = (id: string) => miniById.get(id)?.displayOrder ?? 0;
  const comps = (dump.groupBy<UnitCompositionRow>("unit_composition", "datasheetId").get(datasheetId) ?? [])
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder);

  const tiers: DumpTier[] = [];
  const envelope = new Map<string, { min: number; max: number }>();
  let skip: "duplicate-names" | undefined;
  for (const c of comps) {
    const minis = (
      dump.groupBy<UnitCompositionMiniatureRow>("unit_composition_miniature", "unitCompositionId").get(c.id!) ?? []
    )
      .slice()
      .sort((a, b) => order(a.miniatureId) - order(b.miniatureId));
    const rows: DumpTier = [];
    const seen = new Set<string>();
    for (const m of minis) {
      if (m.max <= 0) continue; // optional attachment listed at 0/0 — not a model row
      const name = miniName(m.miniatureId);
      if (seen.has(name)) skip = "duplicate-names";
      seen.add(name);
      rows.push({ name, min: m.min, max: m.max });
    }
    if (!rows.length) continue;
    tiers.push(rows);
  }
  // Aggregate envelope: a figure absent from a tier (listed at 0/0 there) counts as
  // 0 for that tier, so an optional figure gets envelope min 0 — min-of-mins /
  // max-of-maxes across every tier over the union of figure names.
  const names = new Set<string>();
  for (const t of tiers) for (const r of t) names.add(r.name);
  for (const name of names) {
    let min = Infinity;
    let max = 0;
    for (const t of tiers) {
      const r = t.find((x) => x.name === name);
      min = Math.min(min, r?.min ?? 0);
      max = Math.max(max, r?.max ?? 0);
    }
    envelope.set(name, { min, max });
  }
  return { tiers, envelope, skip };
}

interface BaseSize {
  shape: string;
  [k: string]: unknown;
}

/**
 * Reconcile a repo composition's `models` against the dump's authoritative
 * miniature list, *synthesizing* any per-figure row the dump lists but the repo
 * collapsed away (the Category ② "missing single-figure" defect). Dump-derived:
 * row name, `min`/`max`, and `default_weapon_ids` (the miniature's base loadout).
 * Inferred (the dump carries neither): `base_size_mm` is inherited from the repo's
 * existing rows when uniform, else the unit's own base; `is_leader_model` is the
 * singleton-among-a-bulk-squad heuristic. Both inferences are flagged in `notes`.
 *
 * Returns `null` when there is nothing to synthesize (no missing row). Returns a
 * result with empty `synthesized` (and a diagnostic note) when the repo carries a
 * row the dump does not list while also missing one — an ambiguous divergence the
 * importer refuses to auto-mangle, leaving it for manual reconciliation.
 */
export function reconcileModels(
  models: CompModel[],
  dumpMinis: DumpMini[],
  defaultsByModel: Map<string, string[]>,
  unit: UnitRecord,
): { models: CompModel[]; synthesized: string[]; notes: string[] } | null {
  if (dumpMinis.length === 0) return null;
  const byName = new Map(models.map((m) => [m.name, m]));
  const missing = dumpMinis.filter((d) => !byName.has(d.name));
  if (missing.length === 0) return null; // defaults-patch path already covers this

  const dumpNames = new Set(dumpMinis.map((d) => d.name));
  const extra = models.filter((m) => !dumpNames.has(m.name));
  if (extra.length) {
    return {
      models,
      synthesized: [],
      notes: [
        `composition has row(s) absent from the dump (${extra
          .map((m) => m.name)
          .join(", ")}) while ${missing.length} dump row(s) are missing — manual reconcile, not auto-synthesized`,
      ],
    };
  }

  // base_size_mm inheritance: the repo siblings' base when they share exactly one,
  // else the unit's own base. Never invented.
  const sibBases = models
    .map((m) => (m as { base_size_mm?: BaseSize }).base_size_mm)
    .filter((b): b is BaseSize => !!b);
  const uniform =
    sibBases.length && sibBases.every((b) => JSON.stringify(b) === JSON.stringify(sibBases[0]))
      ? sibBases[0]
      : (unit as { base_size_mm?: BaseSize }).base_size_mm;

  const notes: string[] = [];
  const synthesized: string[] = [];
  const out: CompModel[] = [];
  for (const d of dumpMinis) {
    const existing = byName.get(d.name);
    if (existing) {
      // Adopt the dump's authoritative counts (e.g. a collapsed bulk row of N
      // shrinks to N−1 once the champion gets its own row); preserve every other
      // hand-authored field and the already-patched defaults.
      existing.min = d.min;
      existing.max = d.max;
      out.push(existing);
      continue;
    }
    const row: CompModel = { name: d.name, min: d.min, max: d.max };
    row.is_leader_model = d.max === 1 && dumpMinis.some((x) => x.name !== d.name && x.max > 1);
    if (uniform) (row as { base_size_mm?: BaseSize }).base_size_mm = uniform;
    else notes.push(`synthesized row "${d.name}": no uniform base_size_mm to inherit — left unset`);
    const def = defaultsByModel.get(d.name);
    if (def?.length) row.default_weapon_ids = def;
    else notes.push(`synthesized row "${d.name}": dump has no resolvable base loadout — default_weapon_ids left empty`);
    notes.push(
      `synthesized model row "${d.name}" (min ${d.min}/max ${d.max}, leader=${row.is_leader_model}) from dump composition`,
    );
    synthesized.push(d.name);
    out.push(row);
  }

  const mc = (unit as { model_count?: { min?: number; max?: number } }).model_count;
  if (mc) {
    const sumMin = out.reduce((s, m) => s + m.min, 0);
    const sumMax = out.reduce((s, m) => s + m.max, 0);
    if (typeof mc.min === "number" && sumMin !== mc.min)
      notes.push(`synthesized composition min ${sumMin} ≠ unit model_count.min ${mc.min} — review`);
    if (typeof mc.max === "number" && sumMax !== mc.max)
      notes.push(`synthesized composition max ${sumMax} ≠ unit model_count.max ${mc.max} — review`);
  }
  return { models: out, synthesized, notes };
}

// ─────────────────────────── per-faction apply ───────────────────────────

/**
 * All candidate repo dirs for a datasheet's faction keyword. The direct dir
 * (when one exists) PLUS any shared-roster parents: a Space Marine chapter dir
 * (`black-templars`) holds only chapter-specific entities — its generic units
 * (Crusader Squad) live in the shared `adeptus-astartes` roster — so a chapter
 * datasheet must be allowed to match in the parent too. The first candidate that
 * actually contains the unit id wins (handled by the caller's matched-set guard).
 */
export function candidateDirs(dump: MfmDump, ds: DatasheetRow): string[] {
  const pub = dump.byId<PublicationRow>("publication").get(ds.publicationId);
  const name = pub?.factionKeywordId
    ? dump.enName(dump.byId<FactionKeywordRow>("faction_keyword").get(pub.factionKeywordId))
    : undefined;
  if (!name) return [];
  const out: string[] = [];
  const direct = repoDirForFactionName(name);
  if (direct) out.push(direct);
  let slug: string | undefined;
  try {
    slug = FACTION_ALIASES[name] ?? nameToId(name);
  } catch {
    slug = undefined;
  }
  for (const p of (slug ? SHARED_ROSTERS[slug] : undefined) ?? []) {
    if (repoDirs().has(p) && !out.includes(p)) out.push(p);
  }
  return out.filter((d) => repoDirs().has(d));
}

/** 0 when `dir` is the datasheet's own home faction dir, 1 when it's a shared-roster import. */
export function homeScore(dump: MfmDump, ds: DatasheetRow, dir: string): number {
  const pub = dump.byId<PublicationRow>("publication").get(ds.publicationId);
  const name = pub?.factionKeywordId
    ? dump.enName(dump.byId<FactionKeywordRow>("faction_keyword").get(pub.factionKeywordId))
    : undefined;
  return name && repoDirForFactionName(name) === dir ? 0 : 1;
}

export interface DirWargearResult {
  dir: string;
  matched: number;
  optionsChanged: number;
  defaultsChanged: number;
  /** per-figure composition rows synthesized from the dump (Category ② fill). */
  synthesizedRows: number;
  unresolvedNames: { id: string; name: string; context: string }[];
  /** GW↔repo spelling drift auto-resolved by the fuzzy fallback (auditable). */
  autoResolved: { name: string; from: string; to: string }[];
  notes: { id: string; note: string }[];
  /** dump-present datasheet with no repo unit by that id (author follow-up). */
  newInDump: string[];
  /** repo unit not present in the dump → keeps its BSData-derived data (fallback). */
  repoOnlyFallback: string[];
}
export interface WargearReport {
  dirs: DirWargearResult[];
  /** Projected file contents for {@link applyWrites} — populated in both modes. */
  staged: StagedWrite[];
}

export function runWargear(dump: MfmDump, write: boolean, onlyDir?: string): WargearReport {
  const dirs = repoDirs();
  // Bucket datasheets by candidate repo dir.
  const byDir = new Map<string, DatasheetRow[]>();
  for (const ds of dump.table<DatasheetRow>("datasheet")) {
    if (ds.isLegends) continue;
    for (const dir of candidateDirs(dump, ds)) {
      if (!dirs.has(dir)) continue;
      (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(ds);
    }
  }

  const results: DirWargearResult[] = [];
  const staged: StagedWrite[] = [];
  for (const dir of [...dirs].sort()) {
    if (onlyDir && dir !== onlyDir) continue;
    const upath = path.join(CORE_DIR, dir, "units.json");
    const wpath = path.join(CORE_DIR, dir, "wargear-options.json");
    const cpath = path.join(CORE_DIR, dir, "unit-compositions.json");
    if (!fs.existsSync(upath)) continue;

    const units = readJson<UnitRecord>(upath);
    const byId = new Map(units.map((u) => [u.id, u]));
    const comps = readJson<CompRecord>(cpath);
    // A unit can carry several compositions (different build tiers) — index ALL
    // of them so derived defaults and manual overrides patch every one, not just
    // the last (a Map keyed by unit_id would silently drop the earlier tiers).
    const compsByUnit = new Map<string, CompRecord[]>();
    for (const c of comps) (compsByUnit.get(c.unit_id) ?? compsByUnit.set(c.unit_id, []).get(c.unit_id)!).push(c);
    const wopts = readJson<WargearOptionRecord>(wpath);

    // Faction-wide valid id vocabulary (weapons.json ∪ unit/option-referenced ids),
    // shared with forEachDirDatasheet so the golden resolves names exactly as ingest.
    const validIds = dirValidIds(dir, units, wopts);
    const autoResolved: AutoResolution[] = [];
    const resolve = makeResolver(validIds, autoResolved, WEAPON_ALIASES[dir] ?? {});

    const res: DirWargearResult = {
      dir,
      matched: 0,
      optionsChanged: 0,
      defaultsChanged: 0,
      synthesizedRows: 0,
      unresolvedNames: [],
      autoResolved: [],
      notes: [],
      newInDump: [],
      repoOnlyFallback: [],
    };
    const matchedRepoIds = new Set<string>();
    const optionsByUnit = new Map<string, WargearOptionRecord[]>();
    let compsChanged = false;
    let optsChanged = false;

    // Process home-faction datasheets before shared-roster imports, so a unit's
    // own-faction loadout wins over a chapter/legion variant of the same name.
    const dsList = (byDir.get(dir) ?? [])
      .slice()
      .sort((a, b) => homeScore(dump, a, dir) - homeScore(dump, b, dir));
    for (const ds of dsList) {
      const name = dump.enName(ds);
      if (!name) continue;
      let id: string;
      try {
        id = nameToId(name);
      } catch {
        continue;
      }
      const rec = byId.get(id);
      if (!rec) {
        if (!res.newInDump.includes(id)) res.newInDump.push(id);
        continue;
      }
      if (matchedRepoIds.has(id)) continue; // first candidate dir wins
      matchedRepoIds.add(id);
      res.matched++;

      // A unit with reviewed per-unit overrides gets a resolver that layers them on
      // top of the faction aliases — for this datasheet only; every other unit keeps
      // the shared `resolve` (so a dump name reused across two profiles maps correctly).
      // Either way the unit's own stat variants win (see unitScopedResolver).
      const unitResolve = unitScopedResolver(validIds, autoResolved, dir, id, resolve);
      const derived = deriveWargear(dump, ds.id!, unitResolve);
      for (const u of derived.unresolved) res.unresolvedNames.push({ id, name: u.name, context: u.context });
      for (const n of derived.notes) res.notes.push({ id, note: n });

      // ── defaults → composition model rows (match by model name), every tier ──
      if (derived.defaultsByModel.size) {
        for (const comp of compsByUnit.get(id) ?? []) {
          for (const m of comp.models) {
            const ids = derived.defaultsByModel.get(m.name);
            if (!ids?.length) continue;
            const cur = Array.isArray(m.default_weapon_ids) ? m.default_weapon_ids : [];
            if (!sameMultiset(cur, ids)) {
              res.defaultsChanged++;
              m.default_weapon_ids = ids;
              compsChanged = true;
            }
          }
        }
      }

      // ── synthesize per-figure rows the dump lists but the repo collapsed away ──
      // The importer is patch-only on existing rows, so a datasheet whose dump
      // composition has a distinct single-figure miniature (e.g. a Boss Nob) with
      // no matching repo row would otherwise leave that figure's fixed weapon an
      // orphan. Rebuild the composition from the dump's authoritative miniature
      // list, inheriting base/leader where the dump is silent (both flagged).
      const dumpMinis = dumpComposition(dump, ds.id!);
      if (dumpMinis.length) {
        for (const comp of compsByUnit.get(id) ?? []) {
          const rec = reconcileModels(comp.models, dumpMinis, derived.defaultsByModel, byId.get(id)!);
          if (!rec) continue;
          for (const n of rec.notes) res.notes.push({ id, note: n });
          if (rec.synthesized.length) {
            res.synthesizedRows += rec.synthesized.length;
            comp.models = rec.models;
            compsChanged = true;
          }
        }
      }

      // ── options → wargear-options for this unit ──
      const built: WargearOptionRecord[] = derived.options.map((o, i) => {
        const rec: WargearOptionRecord = {
          id: `${id}-wgo-mfm-${i + 1}`,
          unit_id: id,
          // faction-scope the rebuilt option to the dir it lands in (Stage A made
          // faction_id required + the lookup key). A shared chassis (e.g.
          // chaos-terminators) thus gets a WE-scoped option here and an EC-scoped
          // one when the EC dir is processed — never a merged cross-faction set.
          faction_id: dir,
          game_version: { ...CONFIRMED },
          is_free: true,
        };
        if (o.replaces) rec.replaces = o.replaces;
        if (o.replacement) rec.replacement = o.replacement;
        if (o.replacement_choice) rec.replacement_choice = o.replacement_choice;
        if (o.model_constraint) rec.model_constraint = o.model_constraint;
        return rec;
      });
      optionsByUnit.set(id, built);
      if (built.length) {
        res.optionsChanged += built.length;
        optsChanged = true;
      }
    }

    // ── MANUAL_DEFAULTS: reviewed always-on weapons appended to a model's defaults
    // (faction → unit → model → ids). Applied here, after the dump pass, so it lands
    // whether or not the dump matched the datasheet, and APPENDS to the model's
    // current default loadout — never dropping a derived or pre-existing weapon.
    for (const [unitId, perModel] of Object.entries(MANUAL_DEFAULTS[dir] ?? {})) {
      for (const comp of compsByUnit.get(unitId) ?? []) {
        for (const m of comp.models) {
          const add = perModel[m.name];
          if (!add?.length) continue;
          const cur = Array.isArray(m.default_weapon_ids) ? m.default_weapon_ids : [];
          const merged = [...cur, ...add.filter((x) => !cur.includes(x))];
          if (!sameMultiset(cur, merged)) {
            res.defaultsChanged++;
            m.default_weapon_ids = merged;
            compsChanged = true;
          }
        }
      }
    }

    // Dump-primary rebuild of wargear-options: replace every matched unit's
    // options with the dump-derived set; keep options for dump-absent units. Built
    // and staged in BOTH modes so the dry-run rehearsal validates the exact array a
    // write would persist (cross-faction id collisions, shadowing, schema breaks).
    if (optsChanged) {
      const kept = wopts.filter((o) => !optionsByUnit.has(o.unit_id));
      const rebuilt = [...kept];
      for (const u of units) {
        const built = optionsByUnit.get(u.id);
        if (built) rebuilt.push(...built);
      }
      staged.push({ path: wpath, value: rebuilt });
    }
    if (compsChanged) staged.push({ path: cpath, value: comps });

    const seenAuto = new Set<string>();
    for (const a of autoResolved) {
      const k = `${a.from}→${a.to}`;
      if (seenAuto.has(k)) continue;
      seenAuto.add(k);
      res.autoResolved.push(a);
    }
    res.autoResolved.sort((a, b) => a.from.localeCompare(b.from));
    for (const u of units) {
      if (!matchedRepoIds.has(u.id)) res.repoOnlyFallback.push(u.id);
    }
    res.repoOnlyFallback.sort();
    res.newInDump.sort();
    res.unresolvedNames.sort((a, b) => a.id.localeCompare(b.id) || a.name.localeCompare(b.name));
    results.push(res);
  }

  if (write && results.some((r) => r.unresolvedNames.length)) {
    if (!fs.existsSync(UNMATCHED_DIR)) fs.mkdirSync(UNMATCHED_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(UNMATCHED_DIR, "unmatched-wargear.json"),
      JSON.stringify(
        results.flatMap((r) => r.unresolvedNames.map((u) => ({ dir: r.dir, ...u }))),
        null,
        2,
      ) + "\n",
    );
  }
  return { dirs: results, staged };
}

/** Context handed to the {@link forEachDirDatasheet} callback for one repo unit. */
export interface DirDatasheetCtx {
  dir: string;
  ds: DatasheetRow;
  unitId: string;
  /** Per-unit resolver (faction aliases + any WEAPON_ALIASES_BY_UNIT override). */
  resolve: (name: string) => string | null;
}

/**
 * Walk every live dump datasheet that maps to an existing repo unit, exactly as
 * {@link runWargear} does — same candidate-dir routing (home faction first,
 * shared-roster fallback), same first-dir-wins dedupe, same per-unit resolver — and
 * invoke `cb` once per (dir, repo unit). The inventory builders below sit on top of
 * this so their dump→repo derivation cannot drift from the reconcile path.
 */
export function forEachDirDatasheet(dump: MfmDump, cb: (ctx: DirDatasheetCtx) => void): void {
  const dirs = repoDirs();
  const byDir = new Map<string, DatasheetRow[]>();
  for (const ds of dump.table<DatasheetRow>("datasheet")) {
    if (ds.isLegends) continue;
    for (const dir of candidateDirs(dump, ds)) {
      if (!dirs.has(dir)) continue;
      (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(ds);
    }
  }
  for (const dir of [...dirs].sort()) {
    const upath = path.join(CORE_DIR, dir, "units.json");
    if (!fs.existsSync(upath)) continue;
    const units = readJson<UnitRecord>(upath);
    const wopts = readJson<WargearOptionRecord>(path.join(CORE_DIR, dir, "wargear-options.json"));
    const validIds = dirValidIds(dir, units, wopts);
    const autoResolved: AutoResolution[] = [];
    const resolve = makeResolver(validIds, autoResolved, WEAPON_ALIASES[dir] ?? {});
    const byId = new Map(units.map((u) => [u.id, u]));
    const matchedRepoIds = new Set<string>();
    const dsList = (byDir.get(dir) ?? [])
      .slice()
      .sort((a, b) => homeScore(dump, a, dir) - homeScore(dump, b, dir));
    for (const ds of dsList) {
      const name = dump.enName(ds);
      if (!name) continue;
      let id: string;
      try {
        id = nameToId(name);
      } catch {
        continue;
      }
      if (!byId.has(id)) continue; // dump datasheet with no repo unit → caught by unitInventory
      if (matchedRepoIds.has(id)) continue; // first candidate dir wins
      matchedRepoIds.add(id);
      const unitResolve = unitScopedResolver(validIds, autoResolved, dir, id, resolve);
      cb({ dir, ds, unitId: id, resolve: unitResolve });
    }
  }
}

/** dir → unit-ids the dump grants ≥1 wargear option (the golden's `wargear_options`
 *  category — catches a repo unit missing its loadout options entirely). */
export function wargearOptionInventory(dump: MfmDump): Map<string, Map<string, GoldenMode>> {
  const out = new Map<string, Map<string, GoldenMode>>();
  forEachDirDatasheet(dump, ({ dir, ds, unitId, resolve }) => {
    if (deriveWargear(dump, ds.id!, resolve).options.length === 0) return;
    const m = out.get(dir) ?? out.set(dir, new Map<string, GoldenMode>()).get(dir)!;
    m.set(unitId, mergeMode(m.get(unitId), modeOfPublication(dump, ds.publicationId)));
  });
  return out;
}

/** dir → unit-ids the dump has a datasheet for (the golden's `unit_compositions`
 *  category — catches a repo unit with no `unit-compositions.json` row). */
export function compositionInventory(dump: MfmDump): Map<string, Map<string, GoldenMode>> {
  const out = new Map<string, Map<string, GoldenMode>>();
  forEachDirDatasheet(dump, ({ dir, ds, unitId }) => {
    const m = out.get(dir) ?? out.set(dir, new Map<string, GoldenMode>()).get(dir)!;
    m.set(unitId, mergeMode(m.get(unitId), modeOfPublication(dump, ds.publicationId)));
  });
  return out;
}

/** dir → weapon repo-ids the dump implies for the dir's units (the golden's `weapons`
 *  category). Every resolved default + option id (covered by construction) plus a
 *  `nameToId` slug for each UNRESOLVED dump weapon — the genuinely-missing ids that
 *  land in `mfm-gaps.json` until authored. The only signal that catches a dump
 *  weapon the repo never references. */
export function weaponInventory(dump: MfmDump): Map<string, Map<string, GoldenMode>> {
  const out = new Map<string, Map<string, GoldenMode>>();
  forEachDirDatasheet(dump, ({ dir, ds, resolve }) => {
    const dw = deriveWargear(dump, ds.id!, resolve);
    const mode = modeOfPublication(dump, ds.publicationId);
    const m = out.get(dir) ?? out.set(dir, new Map<string, GoldenMode>()).get(dir)!;
    const add = (id: string): void => {
      m.set(id, mergeMode(m.get(id), mode));
    };
    for (const ids of dw.defaultsByModel.values()) for (const id of ids) add(id);
    for (const o of dw.options) {
      for (const id of o.replaces ?? []) add(id);
      for (const id of o.replacement ?? []) add(id);
      for (const g of o.replacement_choice ?? []) for (const id of g) add(id);
    }
    for (const u of dw.unresolved) {
      try {
        add(nameToId(u.name));
      } catch {
        /* unsluggable — skip */
      }
    }
  });
  return out;
}

export interface BudgetReport {
  dirs: { dir: string; matched: number; unitsWithBudgets: number; budgets: number }[];
  staged: StagedWrite[];
}

/**
 * Backfill each unit's {@link limitedSetBudgets} onto `units.json` `wargear_budgets`,
 * faction-scoped, **without touching its options** — the shared-allowance caps the
 * roster checker enforces as a per-budget sum. Mirrors {@link runWargear}'s
 * datasheet→repo-unit matching (home-faction first, shared-roster fallback) and
 * resolver so budget item names resolve identically. Field-additive: only
 * `wargear_budgets` changes; a unit with no limited sets has the field removed.
 */
export function runWargearBudgets(dump: MfmDump, onlyDir?: string): BudgetReport {
  const dirs = repoDirs();
  const byDir = new Map<string, DatasheetRow[]>();
  for (const ds of dump.table<DatasheetRow>("datasheet")) {
    if (ds.isLegends) continue;
    for (const dir of candidateDirs(dump, ds)) {
      if (!dirs.has(dir)) continue;
      (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(ds);
    }
  }

  const reportDirs: BudgetReport["dirs"] = [];
  const staged: StagedWrite[] = [];
  for (const dir of [...dirs].sort()) {
    if (onlyDir && dir !== onlyDir) continue;
    const upath = path.join(CORE_DIR, dir, "units.json");
    if (!fs.existsSync(upath)) continue;
    const units = readJson<UnitRecord>(upath);
    const byId = new Map(units.map((u) => [u.id, u]));
    const wopts = readJson<WargearOptionRecord>(path.join(CORE_DIR, dir, "wargear-options.json"));

    const validIds = new Set<string>(
      readJson<{ id?: string }>(path.join(CORE_DIR, dir, "weapons.json")).map((w) => w.id ?? ""),
    );
    for (const u of units) for (const id of u.weapon_ids ?? []) validIds.add(id);
    for (const o of wopts) {
      for (const id of o.replaces ?? []) validIds.add(id);
      for (const id of o.replacement ?? []) validIds.add(id);
      for (const g of o.replacement_choice ?? []) for (const id of g) validIds.add(id);
    }
    const autoResolved: AutoResolution[] = [];
    const resolve = makeResolver(validIds, autoResolved, WEAPON_ALIASES[dir] ?? {});

    const dsList = (byDir.get(dir) ?? [])
      .slice()
      .sort((a, b) => homeScore(dump, a, dir) - homeScore(dump, b, dir));
    const matchedRepoIds = new Set<string>();
    let matched = 0;
    let unitsWithBudgets = 0;
    let budgetCount = 0;
    let changed = false;
    for (const ds of dsList) {
      const name = dump.enName(ds);
      if (!name) continue;
      let id: string;
      try {
        id = nameToId(name);
      } catch {
        continue;
      }
      const rec = byId.get(id);
      if (!rec || matchedRepoIds.has(id)) continue;
      matchedRepoIds.add(id);
      matched++;

      const unitResolve = unitScopedResolver(validIds, autoResolved, dir, id, resolve);
      const budgets = limitedSetBudgets(dump, ds.id!, unitResolve);

      const before = JSON.stringify(rec.wargear_budgets ?? null);
      if (budgets.length) {
        rec.wargear_budgets = budgets;
        unitsWithBudgets++;
        budgetCount += budgets.length;
      } else {
        delete (rec as { wargear_budgets?: unknown }).wargear_budgets;
      }
      if (JSON.stringify(rec.wargear_budgets ?? null) !== before) changed = true;
    }
    if (changed) staged.push({ path: upath, value: units });
    reportDirs.push({ dir, matched, unitsWithBudgets, budgets: budgetCount });
  }
  return { dirs: reportDirs, staged };
}

export interface WargearCost {
  item_id: string;
  cost: number;
}

/**
 * Per-item MFM wargear prices for a datasheet: every priced `wargear_option`
 * row (`points > 0`) across the datasheet's option groups, resolved to its repo
 * item id and charged **per copy** present in the final loadout. This is the
 * authoritative form of the prices the option-level `additional_cost` on
 * wargear-option records cannot express — priced default-loadout items (which
 * have no swap option to hang a cost on, e.g. a Terminator Assault Squad's
 * thunder hammers) and heterogeneous choice groups where only some items in a
 * group cost points (e.g. only the storm shield in a Thunderwolf Cavalry
 * plasma-pistol/storm-shield/boltgun group). It also subsumes the expressible
 * swaps: the dump prices per copy (a swap granting two of an item is two priced
 * rows at the per-item cost, so `additional_cost = n * cost`), so a per-copy sum
 * over the final loadout reproduces those totals too — letting `wargear_costs`
 * be the single per-item price representation.
 *
 * Deduped by repo id: the same item recurs across a checkbox + a stepper group
 * at the same price, and the dump never prices one item two different ways
 * within a datasheet (verified). Sorted by id for deterministic output.
 */
export function pricedWargearItems(
  dump: MfmDump,
  datasheetId: string,
  resolve: (name: string) => string | null,
): WargearCost[] {
  const wiName = dump.byId<WargearItemRow>("wargear_item");
  const woByGroup = dump.groupBy<WargearOptionRow>("wargear_option", "wargearOptionGroupId");
  const groups = dump.groupBy<WargearOptionGroupRow>("wargear_option_group", "datasheetId").get(datasheetId) ?? [];
  const byItem = new Map<string, number>();
  for (const g of groups) {
    for (const o of woByGroup.get(g.id) ?? []) {
      if (!o.points || o.points <= 0) continue;
      const id = resolve(dump.enName(wiName.get(o.wargearItemId)) ?? "");
      if (!id) continue;
      // Same item can appear in several groups (checkbox + stepper) at the same
      // price; keep the max defensively so a stray lower row can't under-price it.
      const prev = byItem.get(id);
      byItem.set(id, prev == null ? o.points : Math.max(prev, o.points));
    }
  }
  return [...byItem.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([item_id, cost]) => ({ item_id, cost }));
}

export interface WargearCostsReport {
  dirs: { dir: string; matched: number; unitsWithCosts: number; costs: number; strippedAdditionalCost: number }[];
  staged: StagedWrite[];
}

/**
 * Backfill each unit's {@link pricedWargearItems} onto `units.json`
 * `wargear_costs`, faction-scoped — the per-item MFM prices consumers charge per
 * copy in the final loadout. Mirrors {@link runWargear}'s datasheet→repo-unit
 * matching (home-faction first, shared-roster fallback) and resolver so item
 * names resolve to the same ids the loadout uses. Field-additive on units.json:
 * only `wargear_costs` changes; a unit with no priced wargear has the field
 * removed.
 *
 * Because `wargear_costs` is the single per-item price representation (it
 * subsumes the expressible swaps the interim option-level `additional_cost`
 * carried), this pass also **strips** any `additional_cost` from the dir's
 * wargear-options.json in the same write — retiring the redundant encoding so no
 * consumer can double-charge. The `additional_cost` field remains in the schema
 * (additive-optional) but is no longer populated.
 */
export function runWargearCosts(dump: MfmDump, onlyDir?: string): WargearCostsReport {
  const dirs = repoDirs();
  const byDir = new Map<string, DatasheetRow[]>();
  for (const ds of dump.table<DatasheetRow>("datasheet")) {
    if (ds.isLegends) continue;
    for (const dir of candidateDirs(dump, ds)) {
      if (!dirs.has(dir)) continue;
      (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(ds);
    }
  }

  const reportDirs: WargearCostsReport["dirs"] = [];
  const staged: StagedWrite[] = [];
  for (const dir of [...dirs].sort()) {
    if (onlyDir && dir !== onlyDir) continue;
    const upath = path.join(CORE_DIR, dir, "units.json");
    const wpath = path.join(CORE_DIR, dir, "wargear-options.json");
    if (!fs.existsSync(upath)) continue;
    const units = readJson<UnitRecord>(upath);
    const byId = new Map(units.map((u) => [u.id, u]));
    const wopts = readJson<WargearOptionRecord>(wpath);

    // A priced item can be non-weapon wargear the unit carries (e.g. the Banner of
    // Macragge on the Chapter Ancient): those live in `wargear.json` and the model's
    // `default_weapon_ids`, not `weapons.json`. Extend the pricing vocabulary with both
    // so such items resolve — the weapon reconcile's narrower `dirValidIds` never sees them.
    const validIds = dirValidIds(dir, units, wopts);
    for (const w of readJson<{ id?: string }>(path.join(CORE_DIR, dir, "wargear.json"))) {
      if (w.id) validIds.add(w.id);
    }
    for (const c of readJson<CompRecord>(path.join(CORE_DIR, dir, "unit-compositions.json"))) {
      for (const m of c.models ?? []) for (const id of m.default_weapon_ids ?? []) validIds.add(id);
    }
    const autoResolved: AutoResolution[] = [];
    const resolve = makeResolver(validIds, autoResolved, WEAPON_ALIASES[dir] ?? {});

    const dsList = (byDir.get(dir) ?? [])
      .slice()
      .sort((a, b) => homeScore(dump, a, dir) - homeScore(dump, b, dir));
    const matchedRepoIds = new Set<string>();
    let matched = 0;
    let unitsWithCosts = 0;
    let costCount = 0;
    let unitsChanged = false;
    for (const ds of dsList) {
      const name = dump.enName(ds);
      if (!name) continue;
      let id: string;
      try {
        id = nameToId(name);
      } catch {
        continue;
      }
      const rec = byId.get(id);
      if (!rec || matchedRepoIds.has(id)) continue;
      matchedRepoIds.add(id);
      matched++;

      const unitAliases = WEAPON_ALIASES_BY_UNIT[dir]?.[id];
      const unitResolve = unitAliases
        ? makeResolver(validIds, autoResolved, WEAPON_ALIASES[dir] ?? {}, unitAliases)
        : resolve;
      const costs = pricedWargearItems(dump, ds.id!, unitResolve);

      const before = JSON.stringify(rec.wargear_costs ?? null);
      if (costs.length) {
        rec.wargear_costs = costs;
        unitsWithCosts++;
        costCount += costs.length;
      } else {
        delete (rec as { wargear_costs?: unknown }).wargear_costs;
      }
      if (JSON.stringify(rec.wargear_costs ?? null) !== before) unitsChanged = true;
    }

    // Retire the interim option-level `additional_cost` — `wargear_costs` is now
    // the single per-item price source, so leaving these would double-charge.
    let stripped = 0;
    let optsChanged = false;
    for (const o of wopts) {
      if (o.additional_cost != null) {
        delete (o as { additional_cost?: unknown }).additional_cost;
        stripped++;
        optsChanged = true;
      }
    }

    if (unitsChanged) staged.push({ path: upath, value: units });
    if (optsChanged) staged.push({ path: wpath, value: wopts });
    reportDirs.push({ dir, matched, unitsWithCosts, costs: costCount, strippedAdditionalCost: stripped });
  }
  return { dirs: reportDirs, staged };
}

export interface CompNamesReport {
  dirs: { dir: string; matched: number; rowsRenamed: number }[];
  skipped: { dir: string; id: string; reason: string }[];
  staged: StagedWrite[];
}

/**
 * Align each unit's composition row **names** to its home-faction dump view, so a
 * shared chassis whose composition was built from another faction's view (e.g. WE
 * Chaos Terminators carrying the Emperor's Children "Chaos Terminator" name) matches
 * the home-view options' `model_name` — which is what the eligible-model clamp keys
 * on. Conservative: renames only when the repo composition corresponds 1:1 to the
 * dump view (same row count, same `min`/`max` sequence); otherwise the unit is left
 * untouched and reported, never mangled. Only `name` changes.
 */
export function runCompositionNames(dump: MfmDump, onlyDir?: string): CompNamesReport {
  const dirs = repoDirs();
  const byDir = new Map<string, DatasheetRow[]>();
  for (const ds of dump.table<DatasheetRow>("datasheet")) {
    if (ds.isLegends) continue;
    for (const dir of candidateDirs(dump, ds)) {
      if (!dirs.has(dir)) continue;
      (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(ds);
    }
  }

  const reportDirs: CompNamesReport["dirs"] = [];
  const skipped: CompNamesReport["skipped"] = [];
  const staged: StagedWrite[] = [];
  for (const dir of [...dirs].sort()) {
    if (onlyDir && dir !== onlyDir) continue;
    const cpath = path.join(CORE_DIR, dir, "unit-compositions.json");
    if (!fs.existsSync(cpath)) continue;
    const comps = readJson<CompRecord>(cpath);
    const compsByUnit = new Map<string, CompRecord[]>();
    for (const c of comps)
      (compsByUnit.get(c.unit_id) ?? compsByUnit.set(c.unit_id, []).get(c.unit_id)!).push(c);

    const dsList = (byDir.get(dir) ?? [])
      .slice()
      .sort((a, b) => homeScore(dump, a, dir) - homeScore(dump, b, dir));
    const matchedRepoIds = new Set<string>();
    let matched = 0;
    let rowsRenamed = 0;
    let changed = false;
    for (const ds of dsList) {
      const name = dump.enName(ds);
      if (!name) continue;
      let id: string;
      try {
        id = nameToId(name);
      } catch {
        continue;
      }
      if (matchedRepoIds.has(id) || !compsByUnit.has(id)) continue;
      matchedRepoIds.add(id);
      matched++;
      const view = dumpComposition(dump, ds.id!);
      if (!view.length) continue;
      for (const comp of compsByUnit.get(id) ?? []) {
        if (comp.models.length !== view.length) {
          skipped.push({ dir, id, reason: `row count ${comp.models.length} ≠ dump ${view.length}` });
          continue;
        }
        const aligns = comp.models.every((m, i) => m.min === view[i].min && m.max === view[i].max);
        if (!aligns) {
          skipped.push({ dir, id, reason: "min/max sequence differs from dump view" });
          continue;
        }
        for (let i = 0; i < comp.models.length; i++) {
          if (comp.models[i].name !== view[i].name) {
            comp.models[i].name = view[i].name;
            rowsRenamed++;
            changed = true;
          }
        }
      }
    }
    if (changed) staged.push({ path: cpath, value: comps });
    reportDirs.push({ dir, matched, rowsRenamed });
  }
  return { dirs: reportDirs, skipped, staged };
}

export interface CompTiersReport {
  dirs: { dir: string; matched: number; unitsTiered: number; rowsAdjusted: number; modelCountResynced: number }[];
  skipped: { dir: string; id: string; reason: string }[];
  notes: { dir: string; id: string; note: string }[];
  staged: StagedWrite[];
}

/** Singular/plural- and punctuation-insensitive normal form for model-name matching. */
function normModelName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’'.\-]/g, "")
    .replace(/s\b/g, "") // drop trailing plural 's' on each word
    .replace(/\s+/g, "");
}

/**
 * Recover the repo→dump model-name mapping when names drift only by pluralisation
 * or punctuation (e.g. repo "Termagants" / "Allarus Custodians" vs dump "Termagant"
 * / "Allarus Custodian"). Returns the dump names in repo-row order iff the two name
 * sets form a clean bijection under {@link normModelName}; `null` otherwise — a
 * genuine GW rename ("Cadian Shock Trooper" → "Shock Trooper") or a different row
 * count is left untouched and reported, never auto-mapped onto the wrong figure.
 */
function matchNamesNormalized(repoNames: string[], dumpNames: string[]): string[] | null {
  if (repoNames.length !== dumpNames.length) return null;
  const byNorm = new Map<string, string>();
  for (const e of dumpNames) {
    const k = normModelName(e);
    if (byNorm.has(k)) return null; // ambiguous dump side
    byNorm.set(k, e);
  }
  const used = new Set<string>();
  const out: string[] = [];
  for (const rn of repoNames) {
    const e = byNorm.get(normModelName(rn));
    if (!e || used.has(e)) return null;
    used.add(e);
    out.push(e);
  }
  return out;
}

/**
 * Set each unit's discrete composition **tiers** and corrected `models[]` envelope
 * from the GW dump's full {@link aggregateComposition} (all `unit_composition` rows,
 * not just the default). Replaces the backed-out `points[].models` heuristic, which
 * could not represent units whose size scales across more than one row (Neurogaunts).
 *
 * Conservative — mirrors {@link runCompositionNames}: a unit is touched only when
 * the repo composition maps 1:1 to the dump tiers (same set of model-row names) and
 * the dump has no kill-team duplicate-name shape. Per matched unit it writes
 * `tiers[]` (rows ordered to match `models[]`), sets each `models[]` row's min/max
 * to the aggregate envelope, and re-syncs `units.json` `model_count` to the tier
 * span `{min: min Σtier-min, max: max Σtier-max}`. Everything else is preserved.
 */
export function runCompositionTiers(dump: MfmDump, onlyDir?: string): CompTiersReport {
  const dirs = repoDirs();
  const byDir = new Map<string, DatasheetRow[]>();
  for (const ds of dump.table<DatasheetRow>("datasheet")) {
    if (ds.isLegends) continue;
    for (const dir of candidateDirs(dump, ds)) {
      if (!dirs.has(dir)) continue;
      (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(ds);
    }
  }

  const reportDirs: CompTiersReport["dirs"] = [];
  const skipped: CompTiersReport["skipped"] = [];
  const notes: CompTiersReport["notes"] = [];
  const staged: StagedWrite[] = [];
  for (const dir of [...dirs].sort()) {
    if (onlyDir && dir !== onlyDir) continue;
    const cpath = path.join(CORE_DIR, dir, "unit-compositions.json");
    const upath = path.join(CORE_DIR, dir, "units.json");
    if (!fs.existsSync(cpath)) continue;
    const comps = readJson<CompRecord & { tiers?: { models: DumpTier }[] }>(cpath);
    const compsByUnit = new Map<string, (CompRecord & { tiers?: { models: DumpTier }[] })[]>();
    for (const c of comps)
      (compsByUnit.get(c.unit_id) ?? compsByUnit.set(c.unit_id, []).get(c.unit_id)!).push(c);
    const units = readJson<UnitRecord & { model_count?: { min: number; max: number } }>(upath);
    const unitsById = new Map(units.map((u) => [u.id, u]));

    const dsList = (byDir.get(dir) ?? [])
      .slice()
      .sort((a, b) => homeScore(dump, a, dir) - homeScore(dump, b, dir));
    const matchedRepoIds = new Set<string>();
    let matched = 0;
    let unitsTiered = 0;
    let rowsAdjusted = 0;
    let modelCountResynced = 0;
    let compsChanged = false;
    let unitsChanged = false;
    for (const ds of dsList) {
      const name = dump.enName(ds);
      if (!name) continue;
      let id: string;
      try {
        id = nameToId(name);
      } catch {
        continue;
      }
      if (matchedRepoIds.has(id) || !compsByUnit.has(id)) continue;
      matchedRepoIds.add(id);
      matched++;

      const agg = aggregateComposition(dump, ds.id!);
      if (agg.skip) {
        skipped.push({ dir, id, reason: `dump composition has duplicate model names (kill-team shape)` });
        continue;
      }
      if (!agg.tiers.length) continue;
      const envNames = new Set(agg.envelope.keys());

      for (const comp of compsByUnit.get(id) ?? []) {
        const matches = (ns: string[]) => ns.length === envNames.size && ns.every((n) => envNames.has(n));
        let names = comp.models.map((m) => m.name);
        if (!matches(names)) {
          // Drifted names: recover plural/punctuation drift via a normalized bijection.
          const recovered = matchNamesNormalized(names, [...envNames]);
          if (recovered && matches(recovered)) names = recovered;
        }
        if (!matches(names)) {
          skipped.push({ dir, id, reason: `repo model names ≠ dump tier names (${[...new Set(comp.models.map((m) => m.name))].sort().join(", ")})` });
          continue;
        }
        // Adopt the (possibly recovered) dump names so the envelope/tier keys align.
        comp.models.forEach((m, i) => {
          if (m.name !== names[i]) {
            m.name = names[i];
            rowsAdjusted++;
            compsChanged = true;
          }
        });
        // Corrected envelope on each models[] row.
        for (const m of comp.models) {
          const e = agg.envelope.get(m.name)!;
          if (m.min !== e.min || m.max !== e.max) {
            m.min = e.min;
            m.max = e.max;
            rowsAdjusted++;
            compsChanged = true;
          }
        }
        // Discrete tiers, each listing only the figures it contains (a tier omits a
        // figure the dump lists at 0/0 there), ordered to match models[] order.
        const tiers = agg.tiers.map((tier) => {
          const byName = new Map(tier.map((r) => [r.name, r]));
          return {
            models: comp.models.filter((m) => byName.has(m.name)).map((m) => ({ ...byName.get(m.name)! })),
          };
        });
        if (JSON.stringify(comp.tiers ?? null) !== JSON.stringify(tiers)) {
          comp.tiers = tiers;
          unitsTiered++;
          compsChanged = true;
        }
        // Re-sync the unit's model_count to the tier span.
        const span = {
          min: Math.min(...agg.tiers.map((t) => t.reduce((s, r) => s + r.min, 0))),
          max: Math.max(...agg.tiers.map((t) => t.reduce((s, r) => s + r.max, 0))),
        };
        const u = unitsById.get(id);
        if (u) {
          const before = JSON.stringify(u.model_count ?? null);
          if (before !== JSON.stringify(span)) {
            u.model_count = span;
            modelCountResynced++;
            unitsChanged = true;
          }
        }
      }
    }
    if (compsChanged) staged.push({ path: cpath, value: comps });
    if (unitsChanged) staged.push({ path: upath, value: units });
    reportDirs.push({ dir, matched, unitsTiered, rowsAdjusted, modelCountResynced });
  }
  return { dirs: reportDirs, skipped, notes, staged };
}

export function buildWargearReport(report: WargearReport, write: boolean): string {
  const { dirs } = report;
  const sum = (f: (d: DirWargearResult) => number) => dirs.reduce((a, d) => a + f(d), 0);
  const L: string[] = [];
  L.push(`# MFM wargear — ${write ? "APPLIED" : "DRY RUN"}`);
  L.push("");
  L.push("Dump-primary `default_weapon_ids` + wargear-options. BSData retained only for");
  L.push("dump-absent (repo-only) units. Unresolved weapon names are triaged, never guessed.");
  L.push("");
  L.push("| Dir | Matched | Options | Defaults Δ | Synth | Unresolved | Fuzzy | Notes | New-in-dump | Repo-only (fallback) |");
  L.push("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
  for (const d of dirs.filter((d) => d.matched || d.repoOnlyFallback.length)) {
    L.push(
      `| ${d.dir} | ${d.matched} | ${d.optionsChanged} | ${d.defaultsChanged} | ${d.synthesizedRows} | ${d.unresolvedNames.length} | ${d.autoResolved.length} | ${d.notes.length} | ${d.newInDump.length} | ${d.repoOnlyFallback.length} |`,
    );
  }
  L.push(
    `| **TOTAL** | **${sum((d) => d.matched)}** | **${sum((d) => d.optionsChanged)}** | **${sum((d) => d.defaultsChanged)}** | **${sum((d) => d.synthesizedRows)}** | **${sum((d) => d.unresolvedNames.length)}** | **${sum((d) => d.autoResolved.length)}** | **${sum((d) => d.notes.length)}** | **${sum((d) => d.newInDump.length)}** | **${sum((d) => d.repoOnlyFallback.length)}** |`,
  );
  L.push("");
  for (const d of dirs) {
    if (!d.unresolvedNames.length && !d.notes.length && !d.autoResolved.length) continue;
    L.push(`## ${d.dir}`);
    if (d.autoResolved.length) {
      L.push("", "**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**");
      d.autoResolved.forEach((a) => L.push(`- \`${a.name}\` → \`${a.to}\` (was \`${a.from}\`)`));
    }
    if (d.unresolvedNames.length) {
      L.push("", "**Unresolved weapon names (no repo id — option/default incomplete):**");
      const byName = new Map<string, Set<string>>();
      for (const u of d.unresolvedNames) (byName.get(u.name) ?? byName.set(u.name, new Set()).get(u.name)!).add(u.id);
      for (const [name, units] of [...byName].sort()) L.push(`- \`${name}\` — ${[...units].sort().join(", ")}`);
    }
    if (d.notes.length) {
      L.push("", "**Notes (cap approximations / alternates):**");
      d.notes.forEach((n) => L.push(`- ${n.id}: ${n.note}`));
    }
    L.push("");
  }
  return L.join("\n") + "\n";
}
