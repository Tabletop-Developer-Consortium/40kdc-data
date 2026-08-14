/**
 * project-loadout.ts — additively complete a freshly-seeded MFM skeleton unit's
 * loadout from the GW MFM dump, touching ONLY that unit.
 *
 * Why this exists (and why it is NOT `ingest-mfm wargear`): the `wargear`
 * subcommand is a whole-faction *reconcile* that only *links* dump weapon names to
 * EXISTING repo weapon ids. For a `seed-units` skeleton — a brand-new 11e unit whose
 * weapons are not in `weapons.json` yet — it has nothing to link to, and the
 * whole-faction pass also rewrites already-complete neighbours (a single
 * unresolvable name there drops an option and orphans a weapon, e.g. "Twin penitent
 * flails" vs repo `twin-penitent-flail`), so `applyWrites`' all-or-nothing
 * validation blocks the write. The Knight-Destrier commit (779848e4) hand-authored
 * the missing pieces instead. This tool is that hand-authoring, mechanised and
 * dump-grounded, scoped to one unit:
 *
 *   1. MINT the weapons the dump references but the repo lacks, from
 *      `wargear_item` + `wargear_item_profile` (full 11e stats + keywords).
 *   2. Reuse the trusted `deriveWargear` / `aggregateComposition` projection from
 *      `wargear.ts` (so default loadout, swap options, and tiers match exactly what
 *      the faction reconcile would produce) — with a resolver that mints on a miss
 *      rather than dropping the weapon.
 *   3. Set the unit's `weapon_ids`, profile `invuln_sv`, a `unit-composition`, and
 *      any `wargear-options`.
 *   4. Persist through the same `applyWrites` seam ingest-mfm uses: the whole
 *      projected dataset is AJV + integrity validated (a clean dry run guarantees a
 *      clean write), and only the target unit's rows are added — neighbours are never
 *      touched.
 *
 * Abilities are out of scope (community DSL, authored separately via the
 * author-ability pipeline). IP: only structural stats/points land here, never prose.
 *
 * Usage:
 *   npx tsx src/mfm/project-loadout.ts --dir <faction> --unit <unit_id> [--unit ...] [--write]
 *   npx tsx src/mfm/project-loadout.ts --dir <faction> --all-skeletons [--write]
 */
import * as path from "path";
import { pathToFileURL } from "node:url";
import {
  loadDump,
  MfmDump,
  type DatasheetRow,
  type InvulnerableSaveRow,
  type MiniatureRow,
  type WargearItemRow,
} from "./loader.js";
import { CORE_DIR, readJsonArray } from "./repo-files.js";
import {
  deriveWargear,
  aggregateComposition,
  makeResolver,
  WEAPON_ALIASES,
  WEAPON_ALIASES_BY_UNIT,
  type AutoResolution,
} from "./wargear.js";
import { repoDirForFactionName } from "./faction-map.js";
import { nameToId } from "../converters/id-generator.js";
import { applyWrites, type StagedWrite } from "./apply.js";
import {
  mintWeapon,
  mintWargear,
  parseSkill,
  type GameVersion,
  type MintContext,
  type WeaponRecord,
  type WargearRecord,
} from "./gear-projection.js";

const DATA_CORE = CORE_DIR;

interface UnitProfile {
  name: string;
  invuln_sv?: number | null;
  invuln_sv_ranged?: number | null;
  invuln_sv_melee?: number | null;
  [k: string]: unknown;
}
interface UnitRecord {
  id: string;
  name: string;
  faction_id: string;
  profiles?: UnitProfile[];
  weapon_ids?: string[];
  game_version?: GameVersion;
  [k: string]: unknown;
}



/**
 * The whole-unit invulnerable-save projection: an unconditional `invuln_sv` plus
 * the attack-scoped `invuln_sv_ranged` / `invuln_sv_melee`. `found` records whether
 * any universal (miniatureId-null) row existed; `warnings` collects every
 * unparseable value, footnote/save disagreement, and unrecognized-prose case.
 */
export interface InvulnerableSaveProjection {
  invuln_sv: number | null;
  invuln_sv_ranged: number | null;
  invuln_sv_melee: number | null;
  found: boolean;
  warnings: string[];
}

// The narrow, closed set of English attack-scope footnotes issue #87 normalizes.
// Everything else (See Shadow Field, model-only / exclusion caveats, re-roll notes)
// is deliberately NOT scope and stays outside the static attack-type model. Matched
// after stripping `*`, trimming, lower-casing, and removing a terminal `.`.
const INVULN_RANGED_PLAIN = /^against ranged attacks only$/;
const INVULN_MELEE_PLAIN = /^against melee attacks only$/;
const INVULN_RANGED_N = /^(\d)\+ against ranged attacks only$/;
const INVULN_MELEE_N = /^(\d)\+ against melee attacks only$/;
const INVULN_RANGED_MODEL = /^this model has a (\d)\+ invulnerable save against ranged attacks$/;
const INVULN_MELEE_MODEL = /^this model has a (\d)\+ invulnerable save against melee attacks$/;

/**
 * Project the `invulnerable_save` rows of ONE datasheet into a static, whole-unit
 * invulnerable-save shape (issue #87). Structured scoped columns win first and
 * coexist with an unconditional save; otherwise the closed footnote set above
 * narrows a `save` to one attack scope. The value is ALWAYS the parsed
 * save/rangedSave/meleeSave column — a footnote `<N>+` is only an equality guard,
 * never a value source. Universal rows disagreeing on any output field throw.
 * Coverage remains partial because model-specific rows and mechanics outside the
 * schema's unconditional/ranged/melee fields cannot be projected losslessly.
 */
export function projectInvulnerableSave(rows: readonly unknown[]): InvulnerableSaveProjection {
  const warnings: string[] = [];
  let invulnSv: number | null = null;
  let rangedSv: number | null = null;
  let meleeSv: number | null = null;
  let found = false;

  const combine = (current: number | null, incoming: number, label: string): number => {
    if (current != null && current !== incoming) {
      throw new Error(`conflicting ${label} invulnerable saves for one datasheet: ${current}+ vs ${incoming}+`);
    }
    return incoming;
  };

  for (const raw of rows) {
    const row = raw as InvulnerableSaveRow;
    if (row.miniatureId != null) continue; // model-level exception: not representable here
    found = true;

    const parseSource = (value: string | null | undefined, label: string): number | null => {
      if (value == null || value.trim() === "") return null;
      const n = parseSkill(value);
      if (n == null) {
        warnings.push(`unparseable ${label} invulnerable save "${value}"`);
        return null;
      }
      return n;
    };

    const rangedVal = parseSource(row.rangedSave, "ranged");
    const meleeVal = parseSource(row.meleeSave, "melee");
    const saveVal = parseSource(row.save, "save");
    const structuredScope = row.rangedSave != null || row.meleeSave != null;

    if (rangedVal != null) rangedSv = combine(rangedSv, rangedVal, "ranged");
    if (meleeVal != null) meleeSv = combine(meleeSv, meleeVal, "melee");

    if (structuredScope) {
      // Structured columns are authoritative; a non-null save stays unconditional.
      if (saveVal != null) invulnSv = combine(invulnSv, saveVal, "unconditional");
      continue;
    }
    if (saveVal == null) continue;

    const rules = (row.localisations?.en?.rules ?? "")
      .replace(/\*/g, "")
      .trim()
      .toLowerCase()
      .replace(/\.$/, "");
    const rangedN = INVULN_RANGED_N.exec(rules) ?? INVULN_RANGED_MODEL.exec(rules);
    const meleeN = INVULN_MELEE_N.exec(rules) ?? INVULN_MELEE_MODEL.exec(rules);

    if (INVULN_RANGED_PLAIN.test(rules)) {
      rangedSv = combine(rangedSv, saveVal, "ranged");
    } else if (INVULN_MELEE_PLAIN.test(rules)) {
      meleeSv = combine(meleeSv, saveVal, "melee");
    } else if (rangedN) {
      if (Number(rangedN[1]) !== saveVal) {
        warnings.push(`ranged footnote ${rangedN[1]}+ disagrees with save ${saveVal}+; row left unprojected`);
      } else {
        rangedSv = combine(rangedSv, saveVal, "ranged");
      }
    } else if (meleeN) {
      if (Number(meleeN[1]) !== saveVal) {
        warnings.push(`melee footnote ${meleeN[1]}+ disagrees with save ${saveVal}+; row left unprojected`);
      } else {
        meleeSv = combine(meleeSv, saveVal, "melee");
      }
    } else {
      // Unrecognized / ability-governed prose: the save stays unconditional.
      invulnSv = combine(invulnSv, saveVal, "unconditional");
    }
  }

  return { invuln_sv: invulnSv, invuln_sv_ranged: rangedSv, invuln_sv_melee: meleeSv, found, warnings };
}

/** One-line render of a projection for the CLI summary (never an object). */
function invulnSummary(projection: InvulnerableSaveProjection): string {
  const parts: string[] = [];
  if (projection.invuln_sv != null) parts.push(`${projection.invuln_sv}+`);
  if (projection.invuln_sv_ranged != null) parts.push(`${projection.invuln_sv_ranged}+ ranged`);
  if (projection.invuln_sv_melee != null) parts.push(`${projection.invuln_sv_melee}+ melee`);
  return parts.length ? parts.join(", ") : "—";
}

/**
 * Authoritative --invulns-only migration for one profile: overwrite the three
 * invulnerable fields from the projection. invuln_sv is written even when null (a
 * scoped-only source clears the stale phantom all-attack save); an absent scoped
 * value deletes its key rather than serializing null.
 */
function syncInvulnProfile(profile: UnitProfile, projection: InvulnerableSaveProjection): void {
  profile.invuln_sv = projection.invuln_sv;
  if (projection.invuln_sv_ranged != null) profile.invuln_sv_ranged = projection.invuln_sv_ranged;
  else delete profile.invuln_sv_ranged;
  if (projection.invuln_sv_melee != null) profile.invuln_sv_melee = projection.invuln_sv_melee;
  else delete profile.invuln_sv_melee;
}

/**
 * --invulns-only entry point: for each targeted unit, look up its dump datasheet,
 * project the invulnerable_save rows, synchronize every profile, and stage ONLY
 * units.json (no weapons / wargear / composition / options).
 */
async function runInvulnsOnly(opts: {
  dump: MfmDump;
  dir: string;
  targets: string[];
  files: FactionFiles;
  unitsPath: string;
  write: boolean;
}): Promise<void> {
  const { dump, dir, targets, files, unitsPath, write } = opts;
  const unitsOut = files.units.map((u) => ({ ...u }));
  console.log(
    `\n${"=".repeat(64)}\n  project-loadout --invulns-only — ${dir} (${write ? "WRITE" : "DRY RUN"})\n${"=".repeat(64)}`,
  );
  for (const unitId of targets) {
    const unit = unitsOut.find((u) => u.id === unitId);
    if (!unit) {
      console.error(`[${dir}] ${unitId}: not found in units.json`);
      continue;
    }
    const ds = findDatasheet(dump, unitId, dir);
    if (!ds) {
      console.error(`[${dir}] ${unitId}: no unambiguous dump datasheet`);
      continue;
    }
    const rows = dump.groupBy("invulnerable_save", "datasheetId").get(ds.id!) ?? [];
    const projection = projectInvulnerableSave(rows);
    console.log(`\n## ${unitId}\n   invuln: ${invulnSummary(projection)}`);
    for (const w of projection.warnings) console.log(`   ⚠ ${w}`);
    if (Array.isArray(unit.profiles)) for (const prof of unit.profiles) syncInvulnProfile(prof, projection);
  }
  await applyWrites([{ path: unitsPath, value: unitsOut }], { write, label: "project-loadout --invulns-only" });
  if (!write) console.log("\nDRY RUN — no files written. Re-run with --write to apply.");
}

// ───────────────────────── datasheet lookup ─────────────────────────
export function findDatasheet(dump: MfmDump, unitId: string, dir: string): DatasheetRow | null {
  const matches: DatasheetRow[] = [];
  for (const ds of dump.table("datasheet")) {
    if (ds.isLegends) continue;
    const name = dump.enName(ds);
    if (!name) continue;
    let slug: string;
    try {
      slug = nameToId(name);
    } catch {
      continue;
    }
    if (slug === unitId) matches.push(ds);
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  // Disambiguate by faction dir (shared-roster datasheets slug-collide across dirs).
  const scoped = matches.filter((ds) => {
    const fkId = dump.factionKeywordOfDatasheet(ds.id!);
    const fk = fkId ? dump.byId("faction_keyword").get(fkId) : undefined;
    return repoDirForFactionName(dump.enName(fk)) === dir;
  });
  return scoped.length === 1 ? scoped[0] : null;
}

// ───────────────────────── per-unit projection ─────────────────────────
interface FactionFiles {
  units: UnitRecord[];
  weapons: WeaponRecord[];
  wargear: WargearRecord[];
  comps: any[];
  options: any[];
}
interface Projection {
  unitId: string;
  mintedWeapons: WeaponRecord[];
  mintedWargear: WargearRecord[];
  weaponIds: string[];
  invuln: InvulnerableSaveProjection;
  composition: any;
  options: any[];
  warnings: string[];
}

function projectUnit(
  dump: MfmDump,
  dir: string,
  unitId: string,
  files: FactionFiles,
): Projection {
  const warnings: string[] = [];
  const unit = files.units.find((u) => u.id === unitId);
  if (!unit) throw new Error(`unit "${unitId}" not found in ${dir}/units.json`);
  const ds = findDatasheet(dump, unitId, dir);
  if (!ds) throw new Error(`no unambiguous dump datasheet for "${unitId}" in ${dir}`);
  const gv: GameVersion = unit.game_version ?? { edition: "11th", dataslate: "launch" };

  // Valid repo weapon ids (for resolve-before-mint): existing faction weapons +
  // anything already on units / options in this faction.
  const validIds = new Set<string>(files.weapons.map((w) => w.id));
  for (const u of files.units) for (const w of u.weapon_ids ?? []) validIds.add(w);

  // Name → wargear_item, to classify an unresolved name (weapon → mint; other → skip).
  const itemByName = new Map<string, WargearItemRow>();
  for (const it of dump.table("wargear_item")) {
    const n = dump.enName(it);
    if (n) itemByName.set(n.trim().toLowerCase(), it);
  }

  // Resolve dump weapon names against the same faction (and per-unit) aliases the
  // wargear reconcile uses, so a shared chassis reuses the faction's existing id
  // (e.g. the dump's "Shearing claws" → the repo's `defiler-claws`) instead of
  // minting a divergent duplicate on refresh.
  const audit: AutoResolution[] = [];
  const baseResolve = makeResolver(
    validIds,
    audit,
    WEAPON_ALIASES[dir] ?? {},
    WEAPON_ALIASES_BY_UNIT[dir]?.[unitId],
  );
  const ctx: MintContext = { dump, gv, warnings };
  const minted = new Map<string, WeaponRecord>();
  const mintedWargear = new Map<string, WargearRecord>();

  const resolve = (name: string): string | null => {
    const hit = baseResolve(name);
    if (hit) return hit;
    const item = itemByName.get(name.trim().toLowerCase());
    if (!item) return null;
    let id: string;
    try {
      id = nameToId(name);
    } catch {
      return null;
    }
    if (item.wargearType === "weapon") {
      if (!minted.has(id)) {
        try {
          minted.set(id, mintWeapon(ctx, item, id, name.trim()));
        } catch (e) {
          warnings.push(`could not mint "${name}": ${(e as Error).message}`);
          return null;
        }
      }
      validIds.add(id); // visible to subsequent default/option resolution
      return id;
    }
    // Non-weapon wargear (banner, icon, relic): mint a wargear.json entity so a
    // priced item the dump lists in the loadout (e.g. Banner of Macragge, 10 pts on
    // the Chapter Ancient) participates in the loadout and can carry a per-item cost,
    // rather than being silently dropped. Its game effect stays an authored ability.
    if (!mintedWargear.has(id)) mintedWargear.set(id, mintWargear(ctx, item, id, name.trim()));
    validIds.add(id);
    return id;
  };

  const dsId = ds.id!;
  const derived = deriveWargear(dump, dsId, resolve);
  for (const u of derived.unresolved) warnings.push(`unresolved: "${u.name}" (${u.context})`);
  for (const n of derived.notes) warnings.push(`note: ${n}`);

  // Composition: tiers + envelope from the dump's unit_composition rows.
  const agg = aggregateComposition(dump, dsId);
  if (agg.skip) warnings.push(`composition skipped: ${agg.skip} (kill-team shape — author by hand)`);

  const models: any[] = [];
  const weaponIdSet = new Set<string>();
  const envNames = [...agg.envelope.keys()];
  // Order models by dump composition order (champion/lead first) when available.
  const orderedNames = envNames.length ? envNames : [...derived.defaultsByModel.keys()];
  for (const name of orderedNames) {
    const env = agg.envelope.get(name) ?? { min: 1, max: 1 };
    const def = derived.defaultsByModel.get(name) ?? [];
    // `weapon_ids` is the unit's WEAPON vocabulary; a non-weapon wargear default
    // (e.g. the banner) belongs in the model's loadout but not here.
    for (const w of def) if (!mintedWargear.has(w)) weaponIdSet.add(w);
    const m: any = { name, min: env.min, max: env.max };
    if (def.length) m.default_weapon_ids = def;
    models.push(m);
  }
  if (models.length === 0) {
    warnings.push("no composition models derived — unit left without a composition");
  }

  // Tiers (only when the dump lists >1 buildable size and names map 1:1).
  let tiers: any[] | undefined;
  if (!agg.skip && agg.tiers.length > 1) {
    tiers = agg.tiers.map((t) => ({
      models: t.map((r) => ({ name: r.name, min: r.min, max: r.max })),
    }));
  }

  // Options + their referenced ids feed weapon_ids too.
  const options: any[] = [];
  derived.options.forEach((o, i) => {
    const rec: any = {
      id: `${unitId}-wgo-mfm-${i + 1}`,
      unit_id: unitId,
      faction_id: unit.faction_id,
      game_version: gv,
      is_free: true,
    };
    if (o.model_constraint && Object.keys(o.model_constraint).length) rec.model_constraint = o.model_constraint;
    if (o.replaces) rec.replaces = o.replaces;
    if (o.replacement) rec.replacement = o.replacement;
    if (o.replacement_choice) rec.replacement_choice = o.replacement_choice;
    for (const w of o.replaces ?? []) weaponIdSet.add(w);
    for (const w of o.replacement ?? []) weaponIdSet.add(w);
    for (const g of o.replacement_choice ?? []) for (const w of g) weaponIdSet.add(w);
    options.push(rec);
  });

  // Invuln from invulnerable_save (miniatureId-null rows → whole unit). The
  // projection normalizes structured scoped columns and the narrow English
  // attack-scope footnotes; a recognized scoped save stays off the unconditional field.
  const invuln = projectInvulnerableSave(
    dump.groupBy("invulnerable_save", "datasheetId").get(dsId) ?? [],
  );
  for (const w of invuln.warnings) warnings.push(w);

  const composition =
    models.length > 0
      ? {
          unit_id: unitId,
          faction_id: unit.faction_id,
          models,
          ...(tiers ? { tiers } : {}),
          game_version: gv,
        }
      : null;

  return {
    unitId,
    mintedWeapons: [...minted.values()],
    mintedWargear: [...mintedWargear.values()],
    weaponIds: [...weaponIdSet],
    invuln,
    composition,
    options,
    warnings,
  };
}

// ───────────────────────── apply ─────────────────────────


async function main() {
  const argv = process.argv.slice(2);
  const dirFlag = argv.indexOf("--dir");
  const dir = dirFlag >= 0 ? argv[dirFlag + 1] : undefined;
  const write = argv.includes("--write");
  const allSkeletons = argv.includes("--all-skeletons");
  // --invulns-only re-derives ONLY the invulnerable-save fields (invuln_sv plus the
  // scoped invuln_sv_ranged / invuln_sv_melee) for explicitly-named units from the
  // dump and stages just units.json — it mints no weapons/wargear and touches no
  // composition/options. Authoritative migration behaviour: every targeted profile
  // is synchronised to the projection (absent scoped keys deleted rather than
  // serialised null, and invuln_sv written null when the source is scoped-only).
  const invulnsOnly = argv.includes("--invulns-only");
  // --dump overrides the default _private/dump.json source, so a user can point at
  // their own local export without the repo ever containing that JSON.
  const dumpFlag = argv.indexOf("--dump");
  const dumpPath = dumpFlag >= 0 ? argv[dumpFlag + 1] : undefined;
  // --refresh re-derives an EXISTING unit's dump-owned loadout from the dump and
  // REPLACES it (weapon_ids, minted weapons, composition, options), instead of the
  // default seed-only behaviour that never clobbers a populated unit. This is the
  // importer path for units whose loadout drifted stale against a newer dataslate
  // (e.g. a shared chassis GW re-profiled: the World Eaters defiler was authored
  // fresh for 11e while the CSM/Death Guard/Thousand Sons copies kept their pre-11e
  // weapons). Restricted to explicitly-named `--unit` targets — never `--all-skeletons`
  // — so a wholesale re-projection can't silently overwrite hand-curated loadouts.
  const refresh = argv.includes("--refresh");
  const unitIds: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--unit") unitIds.push(argv[i + 1]);
  if (!dir) {
    console.error(
      "Usage: project-loadout --dir <faction> --unit <id> [--unit <id> ...] [--invulns-only] [--dump <path>] [--write]",
    );
    process.exit(2);
  }
  if (refresh && (allSkeletons || unitIds.length === 0)) {
    console.error("--refresh requires explicit --unit <id> targets (it replaces existing loadout data).");
    process.exit(2);
  }
  if (invulnsOnly && (allSkeletons || unitIds.length === 0)) {
    console.error("--invulns-only requires one or more explicit --unit <id> targets.");
    process.exit(2);
  }

  const factionRoot = path.join(DATA_CORE, dir);
  const unitsPath = path.join(factionRoot, "units.json");
  const weaponsPath = path.join(factionRoot, "weapons.json");
  const wargearPath = path.join(factionRoot, "wargear.json");
  const compsPath = path.join(factionRoot, "unit-compositions.json");
  const optionsPath = path.join(factionRoot, "wargear-options.json");

  const files: FactionFiles = {
    units: readJsonArray<UnitRecord>(unitsPath),
    weapons: readJsonArray<WeaponRecord>(weaponsPath),
    wargear: readJsonArray<WargearRecord>(wargearPath),
    comps: readJsonArray<any>(compsPath),
    options: readJsonArray<any>(optionsPath),
  };

  let targets = unitIds;
  if (allSkeletons) {
    const compUnits = new Set(files.comps.map((c) => c.unit_id));
    targets = files.units
      .filter((u) => !u.is_legend && (u.weapon_ids?.length ?? 0) === 0)
      .map((u) => u.id);
    console.log(`[${dir}] --all-skeletons → ${targets.length} weaponless unit(s): ${targets.join(", ")}`);
    void compUnits;
  }
  if (targets.length === 0) {
    console.log(`[${dir}] no target units.`);
    return;
  }

  const dump = loadDump(dumpPath);
  if (invulnsOnly) {
    await runInvulnsOnly({ dump, dir, targets, files, unitsPath, write });
    return;
  }
  const projections: Projection[] = [];
  for (const unitId of targets) {
    try {
      projections.push(projectUnit(dump, dir, unitId, files));
    } catch (e) {
      console.error(`[${dir}] ${unitId}: ${(e as Error).message}`);
      projections.push({
        unitId,
        mintedWeapons: [],
        mintedWargear: [],
        weaponIds: [],
        invuln: { invuln_sv: null, invuln_sv_ranged: null, invuln_sv_melee: null, found: false, warnings: [] },
        composition: null,
        options: [],
        warnings: [`FAILED: ${(e as Error).message}`],
      });
    }
  }

  // Apply projections additively onto in-memory copies of the five files.
  const weaponsOut = files.weapons.slice();
  const weaponIdsPresent = new Set(weaponsOut.map((w) => w.id));
  const wargearOut = files.wargear.slice();
  const wargearIdsPresent = new Set(wargearOut.map((w) => w.id));
  const compsOut = files.comps.slice();
  const optionsOut = files.options.slice();
  const unitsOut = files.units.map((u) => ({ ...u }));

  console.log(`\n${"=".repeat(64)}\n  project-loadout — ${dir} (${write ? "WRITE" : "DRY RUN"})\n${"=".repeat(64)}`);
  for (const p of projections) {
    console.log(`\n## ${p.unitId}`);
    console.log(
      `   minted ${p.mintedWeapons.length} weapon(s): ${p.mintedWeapons.map((w) => w.id).join(", ") || "—"}`,
    );
    console.log(`   weapon_ids (${p.weaponIds.length}): ${p.weaponIds.join(", ") || "—"}`);
    console.log(`   invuln: ${invulnSummary(p.invuln)}   composition: ${p.composition ? "yes" : "no"}   options: ${p.options.length}`);
    for (const w of p.warnings) console.log(`   ⚠ ${w}`);

    console.log(
      `   minted ${p.mintedWargear.length} wargear: ${p.mintedWargear.map((w) => w.id).join(", ") || "—"}`,
    );
    // Mint new weapons (skip ids already present — idempotent).
    for (const w of p.mintedWeapons) {
      if (!weaponIdsPresent.has(w.id)) {
        weaponsOut.push(w);
        weaponIdsPresent.add(w.id);
      }
    }
    // Mint new wargear entities (non-weapon loadout items — skip ids already present).
    for (const w of p.mintedWargear) {
      if (!wargearIdsPresent.has(w.id)) {
        wargearOut.push(w);
        wargearIdsPresent.add(w.id);
      }
    }
    // --refresh preserves any per-unit weapon VARIANT the repo split out
    // (`${base}-${unitId}`, e.g. Victrix's A5 master-crafted power weapon vs the A7
    // base): the dump derivation only knows base ids, so remap each derived id back to
    // the unit's variant where one exists — on weapon_ids AND the composition loadout —
    // so a refresh can't silently downgrade the variant's stats to the base.
    const toVariant = (id: string): string =>
      refresh && weaponIdsPresent.has(`${id}-${p.unitId}`) ? `${id}-${p.unitId}` : id;
    const weaponIds = p.weaponIds.map(toVariant);
    if (p.composition?.models) {
      for (const m of p.composition.models) {
        if (Array.isArray(m.default_weapon_ids)) m.default_weapon_ids = m.default_weapon_ids.map(toVariant);
      }
    }

    // Patch unit: weapon_ids + invuln. Seed-only by default (never clobber a
    // populated unit); --refresh REPLACES the dump-owned weapon_ids outright so a
    // stale loadout is brought current. `ability_ids` and other authored fields are
    // never touched here, so a co-landing ability fix (e.g. the Defiler leak) survives.
    const u = unitsOut.find((x) => x.id === p.unitId);
    if (u) {
      if (((u.weapon_ids?.length ?? 0) === 0 || refresh) && weaponIds.length) u.weapon_ids = weaponIds;
      if (p.invuln.found && Array.isArray(u.profiles)) {
        const scoped = p.invuln.invuln_sv_ranged != null || p.invuln.invuln_sv_melee != null;
        for (const prof of u.profiles) {
          if (scoped) {
            // Recognized scoped source: never seed a phantom all-attack save. Clear
            // this profile's stale unconditional invuln_sv and set the scoped field(s).
            if (prof.invuln_sv != null) prof.invuln_sv = null;
            if (p.invuln.invuln_sv_ranged != null && prof.invuln_sv_ranged == null)
              prof.invuln_sv_ranged = p.invuln.invuln_sv_ranged;
            if (p.invuln.invuln_sv_melee != null && prof.invuln_sv_melee == null)
              prof.invuln_sv_melee = p.invuln.invuln_sv_melee;
          } else if (p.invuln.invuln_sv != null && prof.invuln_sv == null) {
            // Unconditional source: seed-only, as before.
            prof.invuln_sv = p.invuln.invuln_sv;
          }
        }
      }
    }
    // Composition: seed if the unit has none; --refresh replaces its existing rows.
    if (refresh) {
      const rest = compsOut.filter((c) => c.unit_id !== p.unitId);
      compsOut.length = 0;
      compsOut.push(...rest);
    }
    if (p.composition && !compsOut.some((c) => c.unit_id === p.unitId)) compsOut.push(p.composition);
    // Options: seed if the unit has none; --refresh replaces its existing rows.
    if (refresh) {
      const rest = optionsOut.filter((o) => o.unit_id !== p.unitId);
      optionsOut.length = 0;
      optionsOut.push(...rest);
    }
    if (p.options.length && !optionsOut.some((o) => o.unit_id === p.unitId)) optionsOut.push(...p.options);
  }

  const staged: StagedWrite[] = [
    { path: weaponsPath, value: weaponsOut },
    { path: wargearPath, value: wargearOut },
    { path: unitsPath, value: unitsOut },
    { path: compsPath, value: compsOut },
    { path: optionsPath, value: optionsOut },
  ];
  await applyWrites(staged, { write, label: "project-loadout" });
  if (!write) console.log("\nDRY RUN — no files written. Re-run with --write to apply.");
}

// Only run the CLI when invoked as the entry script; importing its projection
// helpers must have no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
