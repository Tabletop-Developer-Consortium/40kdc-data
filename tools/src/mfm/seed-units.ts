/**
 * seed-units.ts — create skeleton unit entities for datasheets that exist in the
 * GW MFM dump but have no repo entity yet (the "Units new in dump" gap the
 * coverage report tracks).
 *
 * Every other MFM subcommand ENRICHES units that already exist — it matches a
 * dump datasheet to a repo unit by `nameToId(name)` and SKIPS any with no match
 * (the `if (!rec) { newInDump.push(...); continue; }` branch in points.ts). This
 * command acts on exactly that branch: for each unmatched-but-live datasheet it
 * emits a schema- and integrity-valid SKELETON carrying only the structural
 * facts the dump can supply (id, name, faction_id, profiles, keywords,
 * faction_keywords, role, model_count). Points, wargear, composition, attachment
 * role, and abilities are LEFT EMPTY — the existing enrichment subcommands (and,
 * for abilities, the separate author-ability pipeline into the out-of-repo store)
 * fill them in afterwards.
 *
 * IP: this reads ONLY numeric/id/enum tables — `miniature` (stat line), keywords,
 * faction keywords, compositions. It NEVER dereferences the GW prose under
 * `invuln_sv` remains `null` in this skeleton pass: `project-loadout.ts`
 * consumes the structured `invulnerable_save` table later, where whole-unit
 * versus model/attack-scoped representability can be handled explicitly.
 */
import * as fs from "fs";
import * as path from "path";
import { nameToId } from "../converters/id-generator.js";
import { FACTION_HOME_KEYWORD } from "../integrity.js";
import {
  MfmDump,
  type DatasheetRow,
  type PublicationRow,
  type FactionKeywordRow,
  type MiniatureRow,
  type MiniatureKeywordRow,
  type DatasheetFactionKeywordRow,
  type UnitCompositionRow,
  type UnitCompositionMiniatureRow,
} from "./loader.js";
import { CORE_DIR, readJsonArray } from "./repo-files.js";
import {
  repoDirForFactionName,
  repoDirs,
  SHARED_ROSTERS,
} from "./faction-map.js";
import {
  deriveDatasheet,
  cleanTier,
  type Tier,
  type AlliedTier,
} from "./points.js";
import type { StagedWrite } from "./apply.js";
import { type GoldenMode, isCombatPatrolPublication } from "./game-mode.js";

const CONFIRMED = { edition: "11th", dataslate: "launch" };
/** Combat-Patrol-only entities carry this so the golden files them on the
 *  combat-patrol coverage dimension instead of inflating competitive gaps. */
const COMBAT_PATROL_ONLY: readonly GoldenMode[] = ["combat-patrol"];

interface Profile {
  name?: string;
  M: number;
  T: number;
  W: number;
  Sv: number;
  invuln_sv: number | null;
  Ld: number;
  OC: number;
}
interface SeedUnit {
  id: string;
  external_refs: { namespace: string; id: string }[];
  name: string;
  faction_id: string;
  role?: string;
  profiles: Profile[];
  points?: Tier[];
  allied_points?: AlliedTier[];
  keywords?: string[];
  faction_keywords?: string[];
  model_count: { min: number; max: number };
  game_version: { edition: string; dataslate: string };
  game_modes?: GoldenMode[];
  is_legend: boolean;
  points_provisional: boolean;
}
interface UnitRecord {
  id: string;
  [k: string]: unknown;
}

/** Raised when a datasheet cannot be seeded; carries a human-readable reason. */
class SeedSkip extends Error {}

/**
 * Parse a dump stat string to its integer value. Movement carries a trailing
 * `"` (`'12"'`), Save/Leadership a trailing `+` (`'3+'`/`'6+'`), the rest are
 * bare digits. A non-numeric stat (`'-'`, `'N/A'`, empty) is unrepresentable in
 * the schema's integer fields, so it raises SeedSkip rather than emit garbage.
 */
function statInt(raw: string | undefined, field: string, name: string): number {
  const s = String(raw ?? "")
    .trim()
    .replace(/["+]$/, "");
  if (!/^\d+$/.test(s)) {
    throw new SeedSkip(`${name}: non-numeric ${field} "${raw ?? ""}"`);
  }
  return parseInt(s, 10);
}

/**
 * One profile per distinct VISIBLE statline. Hidden-statline miniatures
 * (`statlineHidden`, e.g. a sergeant sharing the trooper line) introduce no new
 * profile. Profiles are deduped on the full stat tuple and ordered by the
 * miniature `displayOrder`.
 */
function buildProfiles(
  dump: MfmDump,
  datasheetId: string,
  unitName: string,
): Profile[] {
  const minis = (
    dump.groupBy("miniature", "datasheetId").get(datasheetId) ?? []
  )
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder);
  const visible = minis.filter((m) => !m.statlineHidden);
  const src = visible.length ? visible : minis; // all-hidden is anomalous; fall back so we never emit zero profiles silently
  const seen = new Set<string>();
  const profiles: Profile[] = [];
  for (const m of src) {
    const M = statInt(m.movement, "M", unitName);
    const T = statInt(m.toughness, "T", unitName);
    const W = statInt(m.wounds, "W", unitName);
    const Sv = statInt(m.save, "Sv", unitName);
    const Ld = statInt(m.leadership, "Ld", unitName);
    const OC = statInt(m.objectiveControl, "OC", unitName);
    const key = `${M}:${T}:${W}:${Sv}:${Ld}:${OC}`;
    if (seen.has(key)) continue;
    seen.add(key);
    profiles.push({
      name: dump.enName(m) ?? unitName,
      M,
      T,
      W,
      Sv,
      invuln_sv: null,
      Ld,
      OC,
    });
  }
  if (!profiles.length)
    throw new SeedSkip(`${unitName}: no visible statline in dump`);
  return profiles;
}

/**
 * Dump `miniature_keyword` names that are model-build / kit tags, not datasheet
 * game keywords — a GW datasheet's KEYWORDS line never lists them (e.g. "Frame",
 * the sprue designation shared by the Land Raider Crusader/Redeemer builds).
 * Filtered out so they never land in a unit's `keywords`.
 */
const NON_GAME_KEYWORDS = new Set(["Frame"]);

/** Union of keyword names across the datasheet's miniatures, deduped, in display order. */
function buildKeywords(dump: MfmDump, datasheetId: string): string[] {
  const minis = (
    dump.groupBy("miniature", "datasheetId").get(datasheetId) ?? []
  )
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder);
  const mkByMini = dump.groupBy("miniature_keyword", "miniatureId");
  const kwById = dump.byId("keyword");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of minis) {
    const mks = (mkByMini.get(m.id!) ?? [])
      .slice()
      .sort((a, b) => a.displayOrder - b.displayOrder);
    for (const mk of mks) {
      const nm = dump.enName(kwById.get(mk.keywordId));
      if (!nm || seen.has(nm) || NON_GAME_KEYWORDS.has(nm)) continue;
      seen.add(nm);
      out.push(nm);
    }
  }
  return out;
}

/**
 * faction_keywords. For the single-token Chaos factions in FACTION_HOME_KEYWORD,
 * the integrity check requires the set to be exactly `{home}` (shared-template
 * datasheets carry contaminant multi-legion lines), so we emit only `[home]`.
 * Every other faction takes the dump's list, deduped in display order.
 */
function buildFactionKeywords(
  dump: MfmDump,
  datasheetId: string,
  dir: string,
): string[] {
  const home = FACTION_HOME_KEYWORD[dir];
  if (home) return [home];
  const rows = (
    dump.groupBy("datasheet_faction_keyword", "datasheetId").get(datasheetId) ??
    []
  )
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder);
  const fkById = dump.byId("faction_keyword");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const nm = dump.enName(fkById.get(r.factionKeywordId));
    if (!nm || seen.has(nm)) continue;
    seen.add(nm);
    out.push(nm);
  }
  return out;
}

/** Battlefield role derived from keywords; absent when none of the role keywords apply. */
function deriveRole(keywords: string[]): string | undefined {
  const kw = new Set(keywords);
  if (kw.has("Epic Hero")) return "epic-hero";
  if (kw.has("Character")) return "character";
  if (kw.has("Battleline")) return "battleline";
  if (kw.has("Dedicated Transport")) return "dedicated-transport";
  if (kw.has("Fortification")) return "fortification";
  return undefined;
}

/**
 * model_count from compositions: smallest composition's total min, largest
 * composition's total max (Σ over its miniature rows). Choice-based comps can
 * overcount the max; the composition-tiers subcommand re-syncs it precisely
 * later — here we only need a schema-valid (≥1, max≥min) placeholder.
 */
function buildModelCount(
  dump: MfmDump,
  datasheetId: string,
): { min: number; max: number } {
  const comps =
    dump.groupBy("unit_composition", "datasheetId").get(datasheetId) ?? [];
  const miniByComp = dump.groupBy(
    "unit_composition_miniature",
    "unitCompositionId",
  );
  let min = Infinity;
  let max = 0;
  for (const c of comps) {
    const rows = miniByComp.get(c.id!) ?? [];
    const cmin = rows.reduce((n, r) => n + r.min, 0);
    const cmax = rows.reduce((n, r) => n + r.max, 0);
    if (cmin > 0) min = Math.min(min, cmin);
    if (cmax > 0) max = Math.max(max, cmax);
  }
  if (!Number.isFinite(min) || min < 1) min = 1;
  if (max < min) max = min;
  return { min, max };
}

/** Assemble one skeleton unit from a dump datasheet. Throws SeedSkip on unusable data. */
export function buildSeedUnit(
  dump: MfmDump,
  ds: DatasheetRow,
  dir: string,
): SeedUnit {
  const name = dump.enName(ds);
  if (!name) throw new SeedSkip(`<${ds.id}>: datasheet has no English name`);
  let id: string;
  try {
    id = nameToId(name);
  } catch {
    throw new SeedSkip(`${name}: name does not slug to a valid entity-id`);
  }
  const profiles = buildProfiles(dump, ds.id!, name);
  const keywords = buildKeywords(dump, ds.id!);
  const faction_keywords = buildFactionKeywords(dump, ds.id!, dir);
  const role = deriveRole(keywords);
  const model_count = buildModelCount(dump, ds.id!);
  // Combat-Patrol-box datasheets are stamped with the combat-patrol game mode so
  // they are tracked on the non-competitive coverage dimension, not matched-play.
  const cp = isCombatPatrolPublication(dump, ds.publicationId);

  // Points come straight from the dump (it IS the MFM). deriveDatasheet returns the
  // same native + allied tiers the `points` reconcile subcommand uses; the reconcile
  // path skips brand-new units (it only corrects existing tiers), so the seeder fills
  // them here. Ambiguous pricing (a model count costed two ways) can't be resolved
  // from the dump, so those are left provisional and unpriced for a manual follow-up.
  const { native, allied, ambiguous } = deriveDatasheet(dump, ds.id!);
  const priced = native.length > 0 && !ambiguous;
  const points = priced ? native.map(cleanTier) : undefined;
  const allied_points =
    priced && allied.length ? allied.map(cleanTier) : undefined;

  // Emit fields in the repo's established key order (see data/core/*/units.json).
  // weapon_ids / ability_ids / base_size_mm stay absent — loadout authoring (wargear)
  // and ability authoring fill those in follow-ups.
  const unit: SeedUnit = {
    id,
    external_refs: [{ namespace: "mfm", id: ds.id! }],
    name,
    faction_id: dir,
    ...(role ? { role } : {}),
    profiles,
    ...(points ? { points } : {}),
    ...(allied_points ? { allied_points } : {}),
    ...(keywords.length ? { keywords } : {}),
    ...(faction_keywords.length ? { faction_keywords } : {}),
    model_count,
    game_version: { ...CONFIRMED },
    ...(cp ? { game_modes: [...COMBAT_PATROL_ONLY] } : {}),
    is_legend: false,
    points_provisional: !priced,
  };
  return unit;
}

export interface SeedUnitsOptions {
  onlyDir?: string;
  /**
   * Include units whose only dump datasheet comes from a "Combat Patrol: X"
   * publication. OFF by default: those are bespoke Combat-Patrol-mode units, a
   * product category the matched-play repo does not carry.
   */
  includeCombatPatrol?: boolean;
}

export interface DirSeedResult {
  /** The dump's source faction dir (by publication faction keyword). */
  dir: string;
  /** Where the units were actually filed, when ≠ dir (shared-roster parent, e.g. adeptus-astartes). */
  routedTo?: string;
  created: { id: string; name: string; combatPatrolOnly: boolean }[];
  /** Combat-Patrol-only units held back (default behavior). */
  cpExcluded: { id: string; name: string }[];
  skipped: { name: string; reason: string }[];
}
export interface SeedUnitsReport {
  dirs: DirSeedResult[];
  staged: StagedWrite[];
}

function unitsPath(dir: string): string {
  return path.join(CORE_DIR, dir, "units.json");
}

/**
 * Where a source dir's units actually live: the dir itself if it has a
 * units.json; otherwise its shared-roster parent that does (SM chapters file
 * under adeptus-astartes). Null when no home exists (a unit-less dir).
 */
export function effectiveDir(dir: string): string | null {
  if (fs.existsSync(unitsPath(dir))) return dir;
  for (const parent of SHARED_ROSTERS[dir] ?? []) {
    if (fs.existsSync(unitsPath(parent))) return parent;
  }
  return null;
}

export function runSeedUnits(
  dump: MfmDump,
  opts: SeedUnitsOptions = {},
): SeedUnitsReport {
  const { onlyDir, includeCombatPatrol = false } = opts;
  const allDirs = repoDirs();
  const pub = dump.byId("publication");
  const fkName = dump.byId("faction_keyword");

  // Bucket live (non-Legends) datasheets by source dir (publication faction
  // keyword → repo dir) — the same routing coverage/points use.
  const byDir = new Map<string, DatasheetRow[]>();
  for (const ds of dump.table("datasheet")) {
    if (ds.isLegends) continue;
    const fkId = pub.get(ds.publicationId)?.factionKeywordId ?? null;
    const dir = repoDirForFactionName(
      fkId ? dump.enName(fkName.get(fkId)) : undefined,
    );
    if (!dir || !allDirs.has(dir)) continue;
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(ds);
  }

  // repo unit-id set per dir (read once); the effective dir's set grows as we append.
  const repoIdsOf = new Map<string, Set<string>>();
  const idsFor = (dir: string): Set<string> => {
    let s = repoIdsOf.get(dir);
    if (!s) {
      const p = unitsPath(dir);
      s = new Set(readJsonArray<UnitRecord>(p).map((unit) => unit.id));
      repoIdsOf.set(dir, s);
    }
    return s;
  };
  // Loaded-and-mutated units array per effective dir (so several source dirs that
  // route to the same parent append to one array).
  const filesByEffDir = new Map<string, UnitRecord[]>();
  const loadEff = (dir: string): UnitRecord[] => {
    let arr = filesByEffDir.get(dir);
    if (!arr) {
      arr = JSON.parse(fs.readFileSync(unitsPath(dir), "utf8")) as UnitRecord[];
      filesByEffDir.set(dir, arr);
    }
    return arr;
  };

  const results: DirSeedResult[] = [];

  for (const dir of [...byDir.keys()].sort()) {
    if (onlyDir && dir !== onlyDir) continue;
    const effDir = effectiveDir(dir);
    if (!effDir) continue; // dir has no units home (parent-less, unit-less)

    // Shared-roster exclusion: a datasheet whose slug already lives in a parent
    // roster dir is a republished duplicate, not a new unit (coverage's "shared-skip").
    const sharedIds = new Set(
      (SHARED_ROSTERS[dir] ?? []).flatMap((p) => [...idsFor(p)]),
    );
    const effIds = idsFor(effDir);

    // Dedupe candidate datasheets by slug, preferring a non-Combat-Patrol row and
    // then the lowest displayOrder, so a slug with both CP and matched-play rows
    // seeds from the matched-play statline.
    const bySlug = new Map<
      string,
      { ds: DatasheetRow; name: string; cp: boolean }
    >();
    for (const ds of byDir.get(dir) ?? []) {
      const name = dump.enName(ds);
      if (!name) continue;
      let id: string;
      try {
        id = nameToId(name);
      } catch {
        continue;
      }
      if (effIds.has(id) || sharedIds.has(id)) continue; // matched, or a shared-roster dup
      const cp = pub.get(ds.publicationId)?.isCombatPatrol ?? false;
      const prev = bySlug.get(id);
      if (
        !prev ||
        (prev.cp && !cp) ||
        (prev.cp === cp && (ds.displayOrder ?? 0) < (prev.ds.displayOrder ?? 0))
      ) {
        bySlug.set(id, { ds, name, cp });
      }
    }

    const res: DirSeedResult = {
      dir,
      created: [],
      cpExcluded: [],
      skipped: [],
    };
    if (effDir !== dir) res.routedTo = effDir;
    const arr = loadEff(effDir);

    for (const [id, { ds, name, cp }] of [...bySlug].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      // A slug already created this run (e.g. two chapters routing the same id to a
      // parent) is caught by effIds, which we keep updated as we append.
      if (effIds.has(id)) {
        res.skipped.push({
          name,
          reason: `slug "${id}" already filed in ${effDir}`,
        });
        continue;
      }
      // Combat-Patrol-only units are held back unless explicitly requested.
      if (cp && !includeCombatPatrol) {
        res.cpExcluded.push({ id, name });
        continue;
      }
      try {
        const unit = buildSeedUnit(dump, ds, effDir);
        arr.push(unit as unknown as UnitRecord);
        effIds.add(id);
        res.created.push({ id, name, combatPatrolOnly: cp });
      } catch (e) {
        if (e instanceof SeedSkip)
          res.skipped.push({ name, reason: e.message });
        else throw e;
      }
    }

    if (res.created.length || res.cpExcluded.length || res.skipped.length)
      results.push(res);
  }

  const staged: StagedWrite[] = [...filesByEffDir.entries()]
    .filter(([dir]) =>
      results.some((r) => (r.routedTo ?? r.dir) === dir && r.created.length),
    )
    .map(([dir, value]) => ({ path: unitsPath(dir), value }));

  return { dirs: results, staged };
}

export function buildSeedUnitsReport(
  report: SeedUnitsReport,
  write: boolean,
): string {
  const { dirs } = report;
  const created = dirs.reduce((a, d) => a + d.created.length, 0);
  const skipped = dirs.reduce((a, d) => a + d.skipped.length, 0);
  const cpExcluded = dirs.reduce((a, d) => a + d.cpExcluded.length, 0);
  const L: string[] = [];
  L.push(`# MFM seed-units — ${write ? "APPLIED" : "DRY RUN"}`);
  L.push("");
  L.push("Skeleton units created for dump datasheets that had no repo entity.");
  L.push(
    "Points/wargear/composition/abilities are left empty for the enrichment passes.",
  );
  L.push(
    "Shared-roster children (SM chapters) file into their parent dir, shown as `→`.",
  );
  L.push(
    "Combat-Patrol-only units (from `Combat Patrol: X` publications) are held back " +
      "by default; pass `--include-combat-patrol` to seed them too.",
  );
  L.push("");
  L.push(
    `**Created: ${created}** | **CP-only excluded: ${cpExcluded}** | **Skipped: ${skipped}**`,
  );
  L.push("");
  L.push("| Source dir | → Filed in | Created | CP-only excluded | Skipped |");
  L.push("|---|---|--:|--:|--:|");
  for (const d of dirs) {
    L.push(
      `| ${d.dir} | ${d.routedTo ?? d.dir} | ${d.created.length} | ${d.cpExcluded.length} | ${d.skipped.length} |`,
    );
  }
  L.push(
    `| **TOTAL** | | **${created}** | **${cpExcluded}** | **${skipped}** |`,
  );
  L.push("");
  for (const d of dirs) {
    if (!d.created.length && !d.cpExcluded.length && !d.skipped.length)
      continue;
    L.push(`## ${d.dir}${d.routedTo ? ` → ${d.routedTo}` : ""}`);
    if (d.created.length) {
      L.push("", "**Created:**");
      d.created.forEach((c) => L.push(`- ${c.id} (${c.name})`));
    }
    if (d.cpExcluded.length) {
      L.push(
        "",
        "**Combat-Patrol-only — held back (pass `--include-combat-patrol` to seed):**",
      );
      d.cpExcluded.forEach((c) => L.push(`- ${c.id} (${c.name})`));
    }
    if (d.skipped.length) {
      L.push("", "**Skipped (unusable dump data / duplicate — review):**");
      d.skipped.forEach((s) => L.push(`- ${s.name}: ${s.reason}`));
    }
    L.push("");
  }
  return L.join("\n") + "\n";
}
