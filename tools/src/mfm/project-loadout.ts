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
import * as fs from "fs";
import * as path from "path";
import {
  loadDump,
  MfmDump,
  REPO_ROOT,
  type DatasheetRow,
  type MiniatureRow,
  type WargearItemRow,
} from "./loader.js";
import {
  deriveWargear,
  aggregateComposition,
  makeResolver,
  type AutoResolution,
} from "./wargear.js";
import { repoDirForFactionName } from "./faction-map.js";
import { nameToId } from "../converters/id-generator.js";
import { applyWrites, type StagedWrite } from "./apply.js";

const DATA_CORE = path.join(REPO_ROOT, "data", "core");

interface GameVersion {
  edition: string;
  dataslate: string;
}
interface WeaponProfile {
  name: string;
  range: number | "Melee";
  stats: {
    A: number | string;
    BS?: number | null;
    WS?: number | null;
    S: number | string;
    AP: number;
    D: number | string;
  };
  keywords?: { keyword_id: string; parameters?: Record<string, unknown> }[];
}
interface WeaponRecord {
  id: string;
  name: string;
  type: "ranged" | "melee";
  profiles: WeaponProfile[];
  game_version: GameVersion;
}
interface UnitProfile {
  name: string;
  invuln_sv?: number | null;
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

// ───────────────────────── weapon-keyword mapping ─────────────────────────
// The dump prints a weapon ability as a single display string ("Melta 2",
// "Anti-Infantry 4+", "Sustained Hits D3"); the repo splits it into a catalog
// `keyword_id` + reference-site `parameters`. Case varies in the dump (UPPER and
// Title forms both appear), so match case-insensitively. Every id below exists in
// data/core/weapon-keywords.json; an unmapped ability is reported, never invented.

/** Parse one dump wargear_ability display name → repo keyword reference(s). */
function mapWeaponKeyword(
  raw: string,
): { keyword_id: string; parameters?: Record<string, unknown> }[] | null {
  const name = raw.trim();
  const lower = name.toLowerCase();

  // Anti-<keyword> N+  →  anti { target_keyword, threshold }. "Monster/Vehicle"
  // is two keywords mechanically; emit one `anti` per target.
  const anti = lower.match(/^anti-([a-z/ ]+?)\s*(\d)\+$/);
  if (anti) {
    const threshold = Number(anti[2]);
    const targets = anti[1]
      .split("/")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => t.replace(/\b\w/g, (c) => c.toUpperCase()));
    return targets.map((target_keyword) => ({
      keyword_id: "anti",
      parameters: { target_keyword, threshold },
    }));
  }

  // <keyword> <value>  for the parameterised flat keywords.
  const valued = name.match(/^([A-Za-z\- ]+?)\s+(\d+|D\d+(?:\+\d+)?|\d*[dD]\d+(?:\+\d+)?)$/);
  if (valued) {
    const base = valued[1].trim().toLowerCase();
    const valStr = valued[2];
    const value: number | string = /^\d+$/.test(valStr) ? Number(valStr) : valStr.toUpperCase();
    const byBase: Record<string, string> = {
      melta: "melta",
      "rapid fire": "rapid-fire",
      "sustained hits": "sustained-hits",
      cleave: "cleave",
    };
    if (byBase[base]) return [{ keyword_id: byBase[base], parameters: { value } }];
    // "Blast 1/2" — repo `blast` takes no parameter; drop the value.
    if (base === "blast") return [{ keyword_id: "blast" }];
  }

  // Flat, parameter-less keywords.
  const flat: Record<string, string> = {
    "lethal hits": "lethal-hits",
    "devastating wounds": "devastating-wounds",
    "twin-linked": "twin-linked",
    "rapid fire": "rapid-fire", // bare (no value) — paramless variant in dump
    heavy: "heavy",
    assault: "assault",
    pistol: "pistol",
    torrent: "torrent",
    blast: "blast",
    melta: "melta",
    anti: "anti", // bare "ANTI" with no target — skip below (needs params)
    "ignores cover": "ignores-cover",
    precision: "precision",
    hazardous: "hazardous",
    "indirect fire": "indirect-fire",
    "extra attacks": "extra-attacks",
    psychic: "psychic",
    "one shot": "one-shot",
    lance: "lance",
    cleave: "cleave",
    "close-quarters": "close-quarters",
    overcharge: "overcharge",
    conversion: "conversion",
    "linked fire": "linked-fire",
    "plasma warhead": "plasma-warhead",
    "psychic assassin": "psychic-assassin",
    "reverberating summons": "reverberating-summons",
    bubblechukka: "bubblechukka",
    "dead choppy": "dead-choppy",
    harpooned: "harpooned",
    hooked: "hooked",
    impaled: "impaled",
    snagged: "snagged",
    sustained: "sustained-hits",
  };
  const id = flat[lower];
  if (!id) return null;
  // Bare "ANTI"/"MELTA"/"RAPID FIRE"/"SUSTAINED HITS"/"CLEAVE" with no number carry
  // no usable parameter — the dump occasionally lists the header form. Skip the
  // parameterised ones (they require a value); keep only genuinely paramless ids.
  if (["anti", "melta", "cleave"].includes(id)) return null;
  if (id === "rapid-fire" || id === "sustained-hits") return null;
  return [{ keyword_id: id }];
}

// ───────────────────────── stat parsing ─────────────────────────
function parseStatValue(s: string | null | undefined): number | string {
  const v = (s ?? "").trim();
  if (/^\d+$/.test(v)) return Number(v);
  const dice = v.match(/^(\d*)[dD](\d+)(\+\d+)?$/);
  if (dice) return `${dice[1]}D${dice[2]}${dice[3] ?? ""}`;
  // Bare numbers with a leading sign or stray chars — best effort.
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  throw new Error(`unparseable stat-value "${s}"`);
}
function parseSkill(s: string | null | undefined): number | null {
  const v = (s ?? "").trim();
  const m = v.match(/^(\d)\+?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 2 && n <= 6 ? n : null;
}
function parseAP(s: string | null | undefined): number {
  const v = (s ?? "0").trim();
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}
function parseRange(s: string | null | undefined, type: string): number | "Melee" {
  if (type === "melee") return "Melee";
  const v = (s ?? "").trim();
  if (/melee/i.test(v)) return "Melee";
  const n = parseInt(v.replace(/["”]/g, ""), 10);
  if (!Number.isFinite(n)) throw new Error(`unparseable range "${s}"`);
  return n;
}

// ───────────────────────── minting ─────────────────────────
interface MintContext {
  dump: MfmDump;
  gv: GameVersion;
  warnings: string[];
}

/** Build a repo weapon record from the dump's wargear_item + its profiles. */
function mintWeapon(ctx: MintContext, item: WargearItemRow, id: string, name: string): WeaponRecord {
  const { dump } = ctx;
  const profiles = (dump.groupBy<any>("wargear_item_profile", "wargearItemId").get(item.id!) ?? [])
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder);
  if (profiles.length === 0) throw new Error(`weapon "${name}" has no profile rows in the dump`);

  const abilByProfile = dump.groupBy<any>("wargear_item_profile_wargear_ability", "wargearItemProfileId");
  const abilById = dump.byId<any>("wargear_ability");

  const built: WeaponProfile[] = profiles.map((p) => {
    const ranged = p.type !== "melee";
    const stats: WeaponProfile["stats"] = {
      A: parseStatValue(p.attacks),
      S: parseStatValue(p.strength),
      AP: parseAP(p.armourPenetration),
      D: parseStatValue(p.damage),
    };
    if (ranged) stats.BS = parseSkill(p.ballisticSkill);
    else stats.WS = parseSkill(p.weaponSkill);

    const keywords: WeaponProfile["keywords"] = [];
    for (const link of abilByProfile.get(p.id) ?? []) {
      const ab = abilById.get(link.wargearAbilityId);
      const abName = dump.enName(ab);
      if (!abName) continue;
      const mapped = mapWeaponKeyword(abName);
      if (!mapped) {
        ctx.warnings.push(`weapon "${name}": unmapped keyword "${abName}" (skipped)`);
        continue;
      }
      keywords.push(...mapped);
    }

    // Single-profile weapons name the profile after the weapon; multi-profile keep
    // the dump's per-profile label (e.g. "Standard" / "Supercharge").
    const profName = profiles.length > 1 ? dump.enName(p) ?? p.localisations?.en?.name ?? name : name;
    const prof: WeaponProfile = { name: profName, range: parseRange(p.range, p.type), stats };
    if (keywords.length) prof.keywords = keywords;
    return prof;
  });

  const type: "ranged" | "melee" = profiles[0].type === "melee" ? "melee" : "ranged";
  return { id, name, type, profiles: built, game_version: ctx.gv };
}

// ───────────────────────── datasheet lookup ─────────────────────────
function findDatasheet(dump: MfmDump, unitId: string, dir: string): DatasheetRow | null {
  const matches: DatasheetRow[] = [];
  for (const ds of dump.table<DatasheetRow>("datasheet")) {
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
  comps: any[];
  options: any[];
}
interface Projection {
  unitId: string;
  mintedWeapons: WeaponRecord[];
  weaponIds: string[];
  invuln: number | null;
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
  for (const it of dump.table<WargearItemRow>("wargear_item")) {
    const n = dump.enName(it);
    if (n) itemByName.set(n.trim().toLowerCase(), it);
  }

  const audit: AutoResolution[] = [];
  const baseResolve = makeResolver(validIds, audit);
  const ctx: MintContext = { dump, gv, warnings };
  const minted = new Map<string, WeaponRecord>();

  const resolve = (name: string): string | null => {
    const hit = baseResolve(name);
    if (hit) return hit;
    const item = itemByName.get(name.trim().toLowerCase());
    if (item?.wargearType === "weapon") {
      let id: string;
      try {
        id = nameToId(name);
      } catch {
        return null;
      }
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
    return null; // non-weapon wargear (medikit, banner, …) — out of loadout scope
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
    for (const w of def) weaponIdSet.add(w);
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

  // Invuln from invulnerable_save (miniatureId null → all profiles).
  let invuln: number | null = null;
  for (const s of dump.groupBy<any>("invulnerable_save", "datasheetId").get(dsId) ?? []) {
    const n = parseSkill(s.save);
    if (n) invuln = n;
  }

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
    weaponIds: [...weaponIdSet],
    invuln,
    composition,
    options,
    warnings,
  };
}

// ───────────────────────── apply ─────────────────────────
function readArr<T>(p: string): T[] {
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as T[]) : [];
}

async function main() {
  const argv = process.argv.slice(2);
  const dirFlag = argv.indexOf("--dir");
  const dir = dirFlag >= 0 ? argv[dirFlag + 1] : undefined;
  const write = argv.includes("--write");
  const allSkeletons = argv.includes("--all-skeletons");
  const unitIds: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--unit") unitIds.push(argv[i + 1]);
  if (!dir) {
    console.error("Usage: project-loadout --dir <faction> (--unit <id> ... | --all-skeletons) [--write]");
    process.exit(2);
  }

  const factionRoot = path.join(DATA_CORE, dir);
  const unitsPath = path.join(factionRoot, "units.json");
  const weaponsPath = path.join(factionRoot, "weapons.json");
  const compsPath = path.join(factionRoot, "unit-compositions.json");
  const optionsPath = path.join(factionRoot, "wargear-options.json");

  const files: FactionFiles = {
    units: readArr<UnitRecord>(unitsPath),
    weapons: readArr<WeaponRecord>(weaponsPath),
    comps: readArr<any>(compsPath),
    options: readArr<any>(optionsPath),
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

  const dump = loadDump();
  const projections: Projection[] = [];
  for (const unitId of targets) {
    try {
      projections.push(projectUnit(dump, dir, unitId, files));
    } catch (e) {
      console.error(`[${dir}] ${unitId}: ${(e as Error).message}`);
      projections.push({
        unitId,
        mintedWeapons: [],
        weaponIds: [],
        invuln: null,
        composition: null,
        options: [],
        warnings: [`FAILED: ${(e as Error).message}`],
      });
    }
  }

  // Apply projections additively onto in-memory copies of the four files.
  const weaponsOut = files.weapons.slice();
  const weaponIdsPresent = new Set(weaponsOut.map((w) => w.id));
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
    console.log(`   invuln: ${p.invuln ?? "—"}   composition: ${p.composition ? "yes" : "no"}   options: ${p.options.length}`);
    for (const w of p.warnings) console.log(`   ⚠ ${w}`);

    // Mint new weapons (skip ids already present — idempotent).
    for (const w of p.mintedWeapons) {
      if (!weaponIdsPresent.has(w.id)) {
        weaponsOut.push(w);
        weaponIdsPresent.add(w.id);
      }
    }
    // Patch unit: weapon_ids (only if currently empty — never clobber) + invuln.
    const u = unitsOut.find((x) => x.id === p.unitId);
    if (u) {
      if ((u.weapon_ids?.length ?? 0) === 0 && p.weaponIds.length) u.weapon_ids = p.weaponIds;
      if (p.invuln && Array.isArray(u.profiles)) {
        for (const prof of u.profiles) if (prof.invuln_sv == null) prof.invuln_sv = p.invuln;
      }
    }
    // Composition: add only if the unit has none yet.
    if (p.composition && !compsOut.some((c) => c.unit_id === p.unitId)) compsOut.push(p.composition);
    // Options: add only if the unit has none yet.
    if (p.options.length && !optionsOut.some((o) => o.unit_id === p.unitId)) optionsOut.push(...p.options);
  }

  const staged: StagedWrite[] = [
    { path: weaponsPath, value: weaponsOut },
    { path: unitsPath, value: unitsOut },
    { path: compsPath, value: compsOut },
    { path: optionsPath, value: optionsOut },
  ];
  await applyWrites(staged, { write, label: "project-loadout" });
  if (!write) console.log("\nDRY RUN — no files written. Re-run with --write to apply.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
