/**
 * weapon-variants.ts — split stat-conflicting duplicate weapon ids into one bare
 * entry plus per-unit variants, recovering the per-datasheet mapping from the GW
 * MFM dump.
 *
 * The bug: `data/core/<faction>/weapons.json` holds multiple entries that share
 * one `id` but carry different `profiles` (e.g. aeldari `dragon-fusion-gun` BS 2
 * for the Autarch vs BS 3 for Fire Dragons; `reaper-launcher` with `Heavy` for
 * the Autarch but not for Dark Reapers). The {@link Collection} indexes weapons
 * first-wins by id, so every unit, the importer, and render-time all resolve to
 * the FIRST variant — the per-unit stat divergence is silently lost.
 *
 * The fix is a clean cutover that preserves every existing bare id:
 *   - The bare id keeps the file's first-wins entry verbatim (so existing share
 *     tokens / cached resolutions stay stable).
 *   - For every unit whose datasheet's actual weapon stats differ from the bare
 *     entry, a variant `${baseId}-${unitId}` is added (sourced from the repo's
 *     own divergent duplicate entry, so the on-disk format is preserved exactly)
 *     and every reference for THAT unit is rewired from `baseId` to the variant.
 *   - Redundant duplicate bare entries collapse to the single first-wins one.
 *
 * The per-unit mapping is recovered from the dump: each repo unit resolves to a
 * non-Legends datasheet, whose loadout chain
 * (`loadout_choice_set` / `base_miniature_loadout` / `limited_wargear_choice`)
 * names the SPECIFIC `wargear_item` that unit fields. Minting that item via
 * {@link mintWeapon} and comparing its stat/keyword fingerprint (name-independent)
 * to the bare entry decides bare-vs-variant. Dry-run by default; `--write` routes
 * the projected files through {@link applyWrites} (AJV + integrity, atomic).
 *
 * @packageDocumentation
 */
import * as path from "path";
import { MfmDump } from "./loader.js";
import { readJsonArray, CORE_DIR } from "./repo-files.js";
import { findDatasheet } from "./project-loadout.js";
import {
  mintWeapon,
  type WeaponProfile,
  type WeaponRecord,
  type GameVersion,
} from "./gear-projection.js";
import { wargearItemsForDatasheet } from "./wargear.js";
import { nameToId } from "../converters/id-generator.js";
import { repoDirs } from "./faction-map.js";
import type { StagedWrite } from "./apply.js";



interface CoreWeapon {
  id: string;
  name: string;
  type: string;
  profiles: WeaponProfile[];
  game_version?: GameVersion;
  [k: string]: unknown;
}
interface WargearBudget {
  items: string[];
  [k: string]: unknown;
}
interface UnitRow {
  id: string;
  faction_id?: string;
  weapon_ids?: string[];
  wargear_budgets?: WargearBudget[];
  game_version?: GameVersion;
  [k: string]: unknown;
}
interface CompModel {
  default_weapon_ids?: string[];
  [k: string]: unknown;
}
interface CompRow {
  unit_id: string;
  models?: CompModel[];
  [k: string]: unknown;
}
interface OptionRow {
  unit_id: string;
  replaces?: string[];
  replacement?: string[];
  replacement_choice?: string[][];
  [k: string]: unknown;
}



// ── fingerprinting (name-independent: stats + keywords + range, order-free) ──

function keywordFp(kws: WeaponProfile["keywords"]): string {
  return JSON.stringify(
    [...(kws ?? [])]
      .map((k) => ({ k: k.keyword_id, p: k.parameters ?? null }))
      .sort((a, b) => `${a.k}${JSON.stringify(a.p)}`.localeCompare(`${b.k}${JSON.stringify(b.p)}`)),
  );
}

function profileFp(p: WeaponProfile): string {
  const s = p.stats as Record<string, unknown>;
  // Skill is BS for ranged, WS for melee; normalize both (null when absent) so a
  // dump-minted profile and a repo profile fingerprint identically.
  const stat = JSON.stringify({
    A: s.A ?? null,
    BS: s.BS ?? null,
    WS: s.WS ?? null,
    S: s.S ?? null,
    AP: s.AP ?? null,
    D: s.D ?? null,
  });
  return JSON.stringify({ range: p.range, stat, kw: keywordFp(p.keywords) });
}

/** Order-independent fingerprint of a weapon's whole profile set. Excludes
 * profile NAMES (cosmetic; the divergence that creates variants is in stats and
 * keywords), so dump-minted and repo-stored weapons compare cleanly. */
function weaponFp(profiles: WeaponProfile[]): string {
  return JSON.stringify([...profiles].map(profileFp).sort());
}

// ── dump loadout walk: the weapon wargear_items a datasheet actually fields ──


// ── reference rewiring ──

const remap = (ids: string[] | undefined, m: Map<string, string>): string[] | undefined =>
  ids?.map((id) => m.get(id) ?? id);

function rewireUnit(u: UnitRow, m: Map<string, string>): UnitRow {
  const out: UnitRow = { ...u };
  if (u.weapon_ids) out.weapon_ids = remap(u.weapon_ids, m);
  if (u.wargear_budgets)
    out.wargear_budgets = u.wargear_budgets.map((b) => ({ ...b, items: remap(b.items, m) ?? b.items }));
  return out;
}

function rewireComp(c: CompRow, m: Map<string, string>): CompRow {
  if (!c.models) return c;
  return {
    ...c,
    models: c.models.map((mdl) =>
      mdl.default_weapon_ids
        ? { ...mdl, default_weapon_ids: remap(mdl.default_weapon_ids, m) }
        : mdl,
    ),
  };
}

function rewireOption(o: OptionRow, m: Map<string, string>): OptionRow {
  const out: OptionRow = { ...o };
  if (o.replaces) out.replaces = remap(o.replaces, m);
  if (o.replacement) out.replacement = remap(o.replacement, m);
  if (o.replacement_choice) out.replacement_choice = o.replacement_choice.map((g) => remap(g, m) ?? g);
  return out;
}

// ── report types ──

export interface DirVariantResult {
  dir: string;
  conflictingIds: number;
  variantsAdded: number;
  unitsRewired: number;
  duplicatesDropped: number;
  warnings: string[];
}
export interface WeaponVariantsReport {
  dirs: DirVariantResult[];
  staged: StagedWrite[];
}

/** Build the variant-split projection for one or every faction dir. */
export function runWeaponVariants(dump: MfmDump, onlyDir?: string): WeaponVariantsReport {
  const dirs = [...repoDirs()].filter((d) => !onlyDir || d === onlyDir).sort();
  const staged: StagedWrite[] = [];
  const reportDirs: DirVariantResult[] = [];

  for (const dir of dirs) {
    const wpnPath = path.join(CORE_DIR, dir, "weapons.json");
    const unitsPath = path.join(CORE_DIR, dir, "units.json");
    const compsPath = path.join(CORE_DIR, dir, "unit-compositions.json");
    const optsPath = path.join(CORE_DIR, dir, "wargear-options.json");

    const weapons = readJsonArray<CoreWeapon>(wpnPath);
    if (weapons.length === 0) continue;
    const units = readJsonArray<UnitRow>(unitsPath);
    const comps = readJsonArray<CompRow>(compsPath);
    const options = readJsonArray<OptionRow>(optsPath);

    // Conflicting ids: an id whose entries do not all share one fingerprint.
    const entriesById = new Map<string, CoreWeapon[]>();
    for (const w of weapons) (entriesById.get(w.id) ?? entriesById.set(w.id, []).get(w.id)!).push(w);
    const conflicting = new Set<string>();
    const bareFp = new Map<string, string>();
    const repoEntryByFp = new Map<string, Map<string, CoreWeapon>>();
    for (const [id, es] of entriesById) {
      if (es.length < 2) continue;
      const byFp = new Map<string, CoreWeapon>();
      for (const e of es) {
        const f = weaponFp(e.profiles);
        if (!byFp.has(f)) byFp.set(f, e);
      }
      if (byFp.size < 2) continue; // identical-stat duplicates — leave untouched
      conflicting.add(id);
      bareFp.set(id, weaponFp(es[0].profiles));
      repoEntryByFp.set(id, byFp);
    }

    const hasDuplicateIds = [...entriesById.values()].some((es) => es.length > 1);
    if (conflicting.size === 0 && !hasDuplicateIds) {
      reportDirs.push({ dir, conflictingIds: 0, variantsAdded: 0, unitsRewired: 0, duplicatesDropped: 0, warnings: [] });
      continue;
    }

    // Index options by unit so a unit's conflicting references are complete.
    const optsByUnit = new Map<string, OptionRow[]>();
    for (const o of options) (optsByUnit.get(o.unit_id) ?? optsByUnit.set(o.unit_id, []).get(o.unit_id)!).push(o);

    const refsOf = (u: UnitRow): Set<string> => {
      const refs = new Set<string>();
      for (const id of u.weapon_ids ?? []) if (conflicting.has(id)) refs.add(id);
      for (const b of u.wargear_budgets ?? []) for (const id of b.items) if (conflicting.has(id)) refs.add(id);
      for (const o of optsByUnit.get(u.id) ?? []) {
        for (const id of o.replaces ?? []) if (conflicting.has(id)) refs.add(id);
        for (const id of o.replacement ?? []) if (conflicting.has(id)) refs.add(id);
        for (const g of o.replacement_choice ?? []) for (const id of g) if (conflicting.has(id)) refs.add(id);
      }
      return refs;
    };

    const warnings: string[] = [];
    const assignments = new Map<string, Map<string, string>>(); // unitId -> (baseId -> variantId)
    const variantEntries = new Map<string, CoreWeapon>(); // variantId -> weapon

    for (const unit of [...units].sort((a, b) => a.id.localeCompare(b.id))) {
      const refs = refsOf(unit);
      if (refs.size === 0) continue;
      const ds = findDatasheet(dump, unit.id, dir);
      if (!ds) {
        warnings.push(`${unit.id}: no unambiguous dump datasheet — left on bare for [${[...refs].sort().join(", ")}]`);
        continue;
      }
      const gv: GameVersion = unit.game_version ?? { edition: "11th", dataslate: "launch" };
      const ctx = { dump, gv, warnings: [] as string[] };

      // baseId -> (fingerprint -> minted record) for this datasheet's weapons.
      const byBase = new Map<string, Map<string, WeaponRecord>>();
      for (const wargearItem of wargearItemsForDatasheet(dump, ds.id)) {
        if (wargearItem.wargearType !== "weapon") continue;
        const name = dump.enName(wargearItem);
        if (!name) continue;
        let baseId: string;
        try {
          baseId = nameToId(name);
        } catch {
          continue;
        }
        if (!conflicting.has(baseId)) continue;
        const wi = wargearItem;
        let minted: WeaponRecord;
        try {
          minted = mintWeapon(ctx, wi, baseId, name);
        } catch (e) {
          warnings.push(`${unit.id}: could not mint "${name}": ${(e as Error).message}`);
          continue;
        }
        const fp = weaponFp(minted.profiles);
        (byBase.get(baseId) ?? byBase.set(baseId, new Map()).get(baseId)!).set(fp, minted);
      }

      for (const baseId of [...refs].sort()) {
        const byFp = byBase.get(baseId);
        if (!byFp || byFp.size === 0) {
          warnings.push(`${unit.id}: no dump weapon for "${baseId}" — left on bare`);
          continue;
        }
        if (byFp.size > 1) {
          warnings.push(`${unit.id}: "${baseId}" maps to ${byFp.size} differing dump items — left on bare (author by hand)`);
          continue;
        }
        const [fp, minted] = [...byFp][0];
        if (fp === bareFp.get(baseId)) continue; // matches the bare entry — keep it
        const variantId = `${baseId}-${unit.id}`;
        const repoEntry = repoEntryByFp.get(baseId)!.get(fp);
        const src = repoEntry ?? minted;
        if (!repoEntry)
          warnings.push(`${unit.id}: "${baseId}" dump stats match no existing repo entry — minted variant "${variantId}" from the dump`);
        variantEntries.set(variantId, {
          ...(src as CoreWeapon),
          id: variantId,
          // Preserve repo format; normalize keyword-less profiles to an empty array.
          profiles: src.profiles.map((p) => ({ ...p, keywords: p.keywords ?? [] })),
          game_version: (src as CoreWeapon).game_version ?? gv,
        });
        (assignments.get(unit.id) ?? assignments.set(unit.id, new Map()).get(unit.id)!).set(baseId, variantId);
      }
    }

    // Rebuild weapons.json: keep the FIRST entry of each id and drop every later
    // duplicate (cosmetic name-only and identical-stat dupes included — they all
    // first-wins-resolve to this same entry today). The divergent stats of the
    // stat-conflicting ids are preserved as the appended per-unit variants.
    const seen = new Set<string>();
    const newWeapons: CoreWeapon[] = [];
    let duplicatesDropped = 0;
    for (const w of weapons) {
      if (seen.has(w.id)) {
        duplicatesDropped += 1;
        continue;
      }
      seen.add(w.id);
      newWeapons.push(w);
    }
    for (const v of [...variantEntries.values()].sort((a, b) => a.id.localeCompare(b.id))) newWeapons.push(v);

    // Rewire references for every assigned unit.
    const newUnits = units.map((u) => {
      const m = assignments.get(u.id);
      return m ? rewireUnit(u, m) : u;
    });
    const newComps = comps.map((c) => {
      const m = assignments.get(c.unit_id);
      return m ? rewireComp(c, m) : c;
    });
    const newOptions = options.map((o) => {
      const m = assignments.get(o.unit_id);
      return m ? rewireOption(o, m) : o;
    });

    if (variantEntries.size > 0 || duplicatesDropped > 0) staged.push({ path: wpnPath, value: newWeapons });
    if (assignments.size > 0) {
      if (JSON.stringify(newUnits) !== JSON.stringify(units)) staged.push({ path: unitsPath, value: newUnits });
      if (JSON.stringify(newComps) !== JSON.stringify(comps)) staged.push({ path: compsPath, value: newComps });
      if (JSON.stringify(newOptions) !== JSON.stringify(options)) staged.push({ path: optsPath, value: newOptions });
    }

    reportDirs.push({
      dir,
      conflictingIds: conflicting.size,
      variantsAdded: variantEntries.size,
      unitsRewired: assignments.size,
      duplicatesDropped,
      warnings,
    });
  }

  return { dirs: reportDirs, staged };
}

/** Render the dry-run/applied report as markdown. */
export function buildWeaponVariantsReport(report: WeaponVariantsReport, write: boolean): string {
  const { dirs } = report;
  const sum = (f: (d: DirVariantResult) => number) => dirs.reduce((a, d) => a + f(d), 0);
  const L: string[] = [];
  L.push(`# Weapon-variant split ${write ? "(applied)" : "(dry run)"}`);
  L.push("");
  L.push(
    `Totals: ${sum((d) => d.conflictingIds)} conflicting id(s), ` +
      `+${sum((d) => d.variantsAdded)} variant(s), ` +
      `${sum((d) => d.unitsRewired)} unit(s) rewired, ` +
      `${sum((d) => d.duplicatesDropped)} duplicate bare entr(y/ies) dropped.`,
  );
  L.push("");
  L.push("| faction | conflicting | variants | units rewired | dupes dropped | warnings |");
  L.push("| --- | --: | --: | --: | --: | --: |");
  for (const d of dirs) {
    if (d.conflictingIds === 0 && d.variantsAdded === 0) continue;
    L.push(`| ${d.dir} | ${d.conflictingIds} | ${d.variantsAdded} | ${d.unitsRewired} | ${d.duplicatesDropped} | ${d.warnings.length} |`);
  }
  const warned = dirs.filter((d) => d.warnings.length > 0);
  if (warned.length) {
    L.push("");
    L.push("## Warnings");
    for (const d of warned) {
      L.push("");
      L.push(`### ${d.dir}`);
      for (const w of d.warnings) L.push(`- ${w}`);
    }
  }
  L.push("");
  return L.join("\n");
}
