/**
 * ingest-mfm.ts — ingest the GW MFM data dump (_private/dump.json)
 * into data/core/, one entity category at a time.
 *
 * The dump is authoritative for the live game (it IS the MFM); it supersedes the
 * army-assist → convert-faction path as the upstream source. The Legends/Forge-World
 * tail the dump omits is dropped from the repo (see the cull-legends subcommand), not
 * backfilled. Numeric/structural fields land here; GW prose routes to the out-of-repo
 * store (never committed here).
 *
 * Subcommands (more land in later phases):
 *   coverage      Report dump-vs-repo coverage; writes no data. (phase 1)
 *   dispositions  (phase 2)  enhancements (phase 3)  points (phase 4)
 *   wargear       (phase 5)  stratagems (phase 6)
 *   missions      Reconcile mission scoring-card numbers (vp/vp_max/cumulative)
 *                 + exclusive_group guard, for secondary + generic primary cards
 *   chapter-scope Reconcile Space Marine chapter access in the shared
 *                 adeptus-astartes pool: collapse Black Templars exclude-and-replace
 *                 twins to generic faction_keywords (#36) + stamp
 *                 excluded_faction_keywords for genuine chapter bars (e.g. Librarians)
 *   cull-legends  Drop dump-absent Legends/Forge-World units + prune refs
 *   attachment-role  Dump-authoritative leader/support role + leader-attachments
 *                    (supersedes the 10e known-support-10e.ts scrape)
 *   seed-units    Create skeleton units for dump datasheets with no repo entity
 *                 (stats/points/keywords/role/model_count). The other subcommands
 *                 only reconcile existing units; this is the one that adds new ones.
 *                 Combat-Patrol-only datasheets are held back unless
 *                 --include-combat-patrol is passed.
 *
 * Every mutating subcommand is DRY RUN by default; pass --write to apply.
 *
 * Usage:
 *   npx tsx tools/src/ingest-mfm.ts coverage
 *   npx tsx tools/src/ingest-mfm.ts coverage --dump /path/to/dump.json
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { nameToId, detachmentScopedId } from "./converters/id-generator.js";
import {
  DEFAULT_DUMP_PATH,
  loadDump,
  MfmDump,
  type DatasheetRow,
  type DetachmentRow,
  type EnhancementRow,
} from "./mfm/loader.js";
import { REPO_ROOT, readJsonArray, CORE_DIR } from "./mfm/repo-files.js";
import { repoDirForFactionName, SHARED_ROSTERS, repoDirs } from "./mfm/faction-map.js";
import { runDispositions, buildDispReport } from "./mfm/dispositions.js";
import { runEnhancements, buildEnhReport, normalizeEnhancementNames } from "./mfm/enhancements.js";
import { seedStratagems } from "./mfm/seed-stratagems.js";
import { runFactionFields, buildFactionFieldsReport } from "./mfm/faction-fields.js";
import { runDetachmentFields, buildDetFieldsReport } from "./mfm/detachment-fields.js";
import { runPoints, buildPointsReport } from "./mfm/points.js";
import { runCull, buildCullReport } from "./mfm/legends-cull.js";
import { runStratagems, buildStratReport } from "./mfm/stratagems.js";
import { runMissions, buildMissionsReport } from "./mfm/missions.js";
import { runMissionMatchups, buildMatchupReport } from "./mfm/mission-matchups.js";
import { runBaseSizes, buildBaseSizeReport } from "./mfm/base-sizes.js";
import { runChapterScope, buildChapterScopeReport } from "./mfm/chapter-scope.js";
import {
  runWargear,
  buildWargearReport,
  runWargearBudgets,
  runWargearCosts,
  runCompositionNames,
  runCompositionTiers,
} from "./mfm/wargear.js";
import { runAttachmentRoles, buildAttachmentReport } from "./mfm/attachment.js";
import { runSeedUnits, buildSeedUnitsReport } from "./mfm/seed-units.js";
import { runSeedDetachments, buildSeedDetachmentsReport } from "./mfm/seed-detachments.js";
import { runAllies, buildAlliesReport } from "./mfm/allies.js";
import { runWeaponVariants, buildWeaponVariantsReport } from "./mfm/weapon-variants.js";
import {
  runConditionalKeywords,
  buildConditionalKeywordReport,
} from "./mfm/conditional-keywords.js";
import { applyWrites, type StagedWrite } from "./mfm/apply.js";
import { writeGolden } from "./mfm/golden.js";
import {
  type GoldenMode,
  mergeMode,
  modeOfPublication,
} from "./mfm/game-mode.js";


const REPORT_DIR = path.join(CORE_DIR, "_reports");
const UNMATCHED_DIR = path.join(REPO_ROOT, "_private", "mfm");


function repoIds(dir: string, file: string): Set<string> {
  return new Set(readJsonArray<{ id: string }>(path.join(CORE_DIR, dir, file)).map((e) => e.id));
}

/** Bucket dump datasheets / detachments / enhancements by their resolved repo dir. */
function bucketByDir<T extends { id?: string }>(
  rows: readonly T[],
  factionKeywordOf: (row: T) => string | null,
  dump: MfmDump
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const fkId = factionKeywordOf(row);
    const fkName = fkId ? dump.enName(dump.byId("faction_keyword").get(fkId)) : undefined;
    const dir = repoDirForFactionName(fkName);
    if (!dir) continue; // titans / unmapped — surfaced separately
    (out.get(dir) ?? out.set(dir, []).get(dir)!).push(row);
  }
  return out;
}

export interface DirCoverage {
  dir: string;
  unitsMatched: number;
  unitsNew: string[]; // in dump, no repo entity (excludes shared-roster dups)
  unitsSharedSkipped: number;
  unitsRepoOnly: string[]; // in repo, not in dump (Legends/FW → dropped by cull-legends)
  detMatched: number;
  detNew: string[];
  detRepoOnly: string[];
  enhMatched: number;
  enhNew: string[];
  enhRepoOnly: string[];
}

/** Safe slug — returns null instead of throwing on unsluggable names. */
function slug(name: string | undefined): string | null {
  if (!name) return null;
  try {
    return nameToId(name);
  } catch {
    return null;
  }
}

// ── dump → repo-id inventories (shared by coverage() and the golden command) ──
// Each derivation is the single source of truth for one category's dump→repo id
// mapping. coverage() consumes the *IdsByDir named maps (it needs display names for
// its report); the golden command consumes the Set views (unitInventory etc.).
// Keeping both on ONE derivation is what stops the golden from drifting away from
// the ids ingest actually matches against the repo.

/** A dump entity's display label plus its game mode, carried together so the
 *  golden's id derivation and its mode classification come from one pass and can
 *  never drift apart. */
interface DumpEntry {
  name: string;
  mode: GoldenMode;
}

/** dir → (unit repo-id → {name, mode}), over live (non-Legends) datasheets. */
function unitIdsByDir(dump: MfmDump): Map<string, Map<string, DumpEntry>> {
  const live = dump.table("datasheet").filter((d) => !d.isLegends);
  const byDir = bucketByDir(live, (d) => dump.factionKeywordOfDatasheet(d.id!), dump);
  const out = new Map<string, Map<string, DumpEntry>>();
  for (const [dir, rows] of byDir) {
    const m = new Map<string, DumpEntry>();
    for (const ds of rows) {
      const n = dump.enName(ds);
      if (!n) continue;
      let id: string;
      try {
        id = nameToId(n);
      } catch {
        continue; // unsluggable name — skip
      }
      const prev = m.get(id);
      m.set(id, {
        name: prev?.name ?? n,
        mode: mergeMode(prev?.mode, modeOfPublication(dump, ds.publicationId)),
      });
    }
    out.set(dir, m);
  }
  return out;
}

/** dir → (detachment repo-id → {name, mode}). */
function detIdsByDir(dump: MfmDump): Map<string, Map<string, DumpEntry>> {
  const byDir = bucketByDir(
    dump.table("detachment"),
    (d) => dump.factionKeywordOfDetachment(d.id!),
    dump
  );
  const out = new Map<string, Map<string, DumpEntry>>();
  for (const [dir, rows] of byDir) {
    const m = new Map<string, DumpEntry>();
    for (const det of rows) {
      const n = dump.enName(det);
      if (!n) continue;
      let id: string;
      try {
        id = nameToId(n);
      } catch {
        continue; // skip
      }
      const prev = m.get(id);
      m.set(id, {
        name: prev?.name ?? n,
        mode: mergeMode(prev?.mode, det.isCombatPatrol ? "combat-patrol" : "matched-play"),
      });
    }
    out.set(dir, m);
  }
  return out;
}

/** dir → (enhancement repo-id → {"enh / detachment" label, mode}). */
function enhIdsByDir(dump: MfmDump): Map<string, Map<string, DumpEntry>> {
  const byDir = bucketByDir(
    dump.table("enhancement"),
    (e) => dump.factionKeywordOfDetachment(e.detachmentId),
    dump
  );
  const out = new Map<string, Map<string, DumpEntry>>();
  for (const [dir, rows] of byDir) {
    const m = new Map<string, DumpEntry>();
    for (const enh of rows) {
      const en = dump.enName(enh);
      const det = dump.byId("detachment").get(enh.detachmentId);
      const dn = dump.enName(det);
      if (!en || !dn) continue;
      let id: string;
      try {
        id = detachmentScopedId(en, dn);
      } catch {
        continue; // skip
      }
      const prev = m.get(id);
      m.set(id, {
        name: prev?.name ?? `${en} / ${dn}`,
        mode: mergeMode(prev?.mode, enh.isCombatPatrol ? "combat-patrol" : "matched-play"),
      });
    }
    out.set(dir, m);
  }
  return out;
}

/** dir → (id → game mode) view of an id→entry inventory (drops display names). */
function modeView(m: Map<string, Map<string, DumpEntry>>): Map<string, Map<string, GoldenMode>> {
  const out = new Map<string, Map<string, GoldenMode>>();
  for (const [dir, inner] of m) {
    const mm = new Map<string, GoldenMode>();
    for (const [id, entry] of inner) mm.set(id, entry.mode);
    out.set(dir, mm);
  }
  return out;
}

/** dir → (dump-derived unit repo-id → game mode) — the golden's `units` category. */
export function unitInventory(dump: MfmDump): Map<string, Map<string, GoldenMode>> {
  return modeView(unitIdsByDir(dump));
}
/** dir → (dump-derived detachment repo-id → game mode) — the golden's `detachments` category. */
export function detachmentInventory(dump: MfmDump): Map<string, Map<string, GoldenMode>> {
  return modeView(detIdsByDir(dump));
}
/** dir → (dump-derived enhancement repo-id → game mode) — the golden's `enhancements` category. */
export function enhancementInventory(dump: MfmDump): Map<string, Map<string, GoldenMode>> {
  return modeView(enhIdsByDir(dump));
}

export function coverage(dump: MfmDump): { dirs: DirCoverage[]; unmappedFactions: string[] } {
  const liveDatasheets = dump.table("datasheet")
    .filter((d) => !d.isLegends);

  // Global dump id sets — the repo-only ("dropped by cull-legends") signal must be
  // routing-agnostic: a repo entity is a true gap only if NO dump entity anywhere
  // shares its id. The per-dir inventories (unitIdsByDir etc.) stay the routing diagnostic.
  const globalUnitIds = new Set<string>();
  for (const ds of liveDatasheets) {
    const id = slug(dump.enName(ds));
    if (id) globalUnitIds.add(id);
  }
  const globalDetIds = new Set<string>();
  for (const det of dump.table("detachment")) {
    const id = slug(dump.enName(det));
    if (id) globalDetIds.add(id);
  }
  const globalEnhIds = new Set<string>();
  for (const enh of dump.table("enhancement")) {
    const en = dump.enName(enh);
    const dn = dump.enName(dump.byId("detachment").get(enh.detachmentId));
    if (en && dn) {
      try {
        globalEnhIds.add(detachmentScopedId(en, dn));
      } catch {
        /* skip */
      }
    }
  }

  // unmapped faction keywords (e.g. titans) that own live datasheets
  const unmapped = new Set<string>();
  for (const d of liveDatasheets) {
    const fkId = dump.factionKeywordOfDatasheet(d.id!);
    const fkName = fkId ? dump.enName(dump.byId("faction_keyword").get(fkId)) : undefined;
    if (fkName && !repoDirForFactionName(fkName)) unmapped.add(fkName);
  }

  const unitsByDir = unitIdsByDir(dump);
  const detsByDir = detIdsByDir(dump);
  const enhsByDir = enhIdsByDir(dump);
  const dirs: DirCoverage[] = [];
  for (const dir of [...repoDirs()].sort()) {
    const dumpUnitIds = unitsByDir.get(dir) ?? new Map<string, DumpEntry>();
    const repoUnitIds = repoIds(dir, "units.json");
    const shared = SHARED_ROSTERS[dir] ?? [];
    const sharedIds = new Set(shared.flatMap((p) => [...repoIds(p, "units.json")]));

    const unitsNew: string[] = [];
    let unitsMatched = 0;
    let unitsSharedSkipped = 0;
    for (const [id, entry] of dumpUnitIds) {
      if (repoUnitIds.has(id)) unitsMatched++;
      else if (sharedIds.has(id)) unitsSharedSkipped++;
      else unitsNew.push(`${entry.name} (${id})`);
    }
    const unitsRepoOnly = [...repoUnitIds].filter((id) => !globalUnitIds.has(id)).sort();

    // detachments
    const dumpDetIds = detsByDir.get(dir) ?? new Map<string, DumpEntry>();
    const repoDetIds = repoIds(dir, "detachments.json");
    const detNew: string[] = [];
    let detMatched = 0;
    for (const [id, entry] of dumpDetIds) {
      if (repoDetIds.has(id)) detMatched++;
      else detNew.push(`${entry.name} (${id})`);
    }
    const detRepoOnly = [...repoDetIds].filter((id) => !globalDetIds.has(id)).sort();

    // enhancements — id is detachmentScopedId(enhName, detName)
    const dumpEnhIds = enhsByDir.get(dir) ?? new Map<string, DumpEntry>();
    const repoEnhIds = repoIds(dir, "enhancements.json");
    const enhNew: string[] = [];
    let enhMatched = 0;
    for (const [id, entry] of dumpEnhIds) {
      if (repoEnhIds.has(id)) enhMatched++;
      else enhNew.push(`${entry.name} (${id})`);
    }
    const enhRepoOnly = [...repoEnhIds].filter((id) => !globalEnhIds.has(id)).sort();

    // only emit dirs the dump actually touches, or that have repo-only gaps
    if (
      dumpUnitIds.size === 0 &&
      dumpDetIds.size === 0 &&
      dumpEnhIds.size === 0 &&
      repoUnitIds.size === 0
    )
      continue;

    dirs.push({
      dir,
      unitsMatched,
      unitsNew,
      unitsSharedSkipped,
      unitsRepoOnly,
      detMatched,
      detNew,
      detRepoOnly,
      enhMatched,
      enhNew,
      enhRepoOnly,
    });
  }
  return { dirs, unmappedFactions: [...unmapped].sort() };
}

export interface WholeDatasetCounts {
  stratagems: { repo: number; dump: number };
  missions: { repo: number; dumpPrimary: number; dumpSecondary: number };
  forceDispositions: { repo: number; dump: number };
  detachmentDispositionMap: number;
}

/** Whole-dataset repo-vs-dump counts for categories the dump dwarfs the repo on. */
export function wholeDatasetCounts(dump: MfmDump): WholeDatasetCounts {
  return {
    stratagems: {
      repo: readJsonArray<{ id: string }>(path.join(CORE_DIR, "stratagems.json")).length,
      dump: dump.table("stratagem").length,
    },
    missions: {
      repo: readJsonArray<{ id: string }>(path.join(CORE_DIR, "missions.json")).length,
      dumpPrimary: dump.table("primary_mission").length,
      dumpSecondary: dump.table("secondary_mission").length,
    },
    forceDispositions: { repo: 5, dump: dump.table("force_disposition").length },
    detachmentDispositionMap: dump.table("detachment_force_disposition").length,
  };
}

function buildReport(dump: MfmDump, cov: ReturnType<typeof coverage>): string {
  const { dirs, unmappedFactions } = cov;
  const sum = (f: (d: DirCoverage) => number) => dirs.reduce((a, d) => a + f(d), 0);
  const L: string[] = [];
  L.push(`# MFM coverage — dump data_version ${dump.version ?? "?"}`);
  L.push("");
  L.push("Dump-vs-repo coverage by faction dir. **New** = in dump, no repo entity.");
  L.push(
    "**Repo-only** = in repo, absent from the (Legends-free) dump → dropped (Legends/Forge-World; see cull-legends)."
  );
  L.push("");
  L.push(
    "| Faction dir | Units matched | Units new | Units shared-skip | Units repo-only | Det matched | Det new | Det repo-only | Enh matched | Enh new | Enh repo-only |"
  );
  L.push("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
  for (const d of dirs) {
    L.push(
      `| ${d.dir} | ${d.unitsMatched} | ${d.unitsNew.length} | ${d.unitsSharedSkipped} | ${d.unitsRepoOnly.length} | ${d.detMatched} | ${d.detNew.length} | ${d.detRepoOnly.length} | ${d.enhMatched} | ${d.enhNew.length} | ${d.enhRepoOnly.length} |`
    );
  }
  L.push(
    `| **TOTAL** | **${sum((d) => d.unitsMatched)}** | **${sum((d) => d.unitsNew.length)}** | **${sum((d) => d.unitsSharedSkipped)}** | **${sum((d) => d.unitsRepoOnly.length)}** | **${sum((d) => d.detMatched)}** | **${sum((d) => d.detNew.length)}** | **${sum((d) => d.detRepoOnly.length)}** | **${sum((d) => d.enhMatched)}** | **${sum((d) => d.enhNew.length)}** | **${sum((d) => d.enhRepoOnly.length)}** |`
  );
  L.push("");

  // Whole-dataset categories the dump dwarfs the repo on.
  const wdc = wholeDatasetCounts(dump);
  L.push("## Whole-dataset categories");
  L.push("");
  L.push("| Category | Repo | Dump |");
  L.push("|---|--:|--:|");
  L.push(`| Stratagems | ${wdc.stratagems.repo} | ${wdc.stratagems.dump} |`);
  L.push(
    `| Missions | ${wdc.missions.repo} | ${wdc.missions.dumpPrimary} primary + ${wdc.missions.dumpSecondary} secondary |`
  );
  L.push(`| Force dispositions | ${wdc.forceDispositions.repo} | ${wdc.forceDispositions.dump} |`);
  L.push(
    `| Detachment→disposition map | — | ${wdc.detachmentDispositionMap} (1:1) |`
  );
  L.push("");

  if (unmappedFactions.length) {
    L.push("## Unmapped faction keywords (own live datasheets, no repo dir)");
    L.push("");
    unmappedFactions.forEach((f) => L.push(`- ${f}`));
    L.push("");
  }

  for (const d of dirs) {
    if (!d.unitsNew.length && !d.detNew.length && !d.enhNew.length && !d.unitsRepoOnly.length)
      continue;
    L.push(`## ${d.dir}`);
    const block = (title: string, items: string[]) => {
      if (!items.length) return;
      L.push("", `**${title}** (${items.length}):`);
      items.slice(0, 100).forEach((i) => L.push(`- ${i}`));
      if (items.length > 100) L.push(`- …and ${items.length - 100} more`);
    };
    block("Units new in dump", d.unitsNew);
    block("Units repo-only (Legends/FW → dropped)", d.unitsRepoOnly);
    block("Detachments new in dump", d.detNew);
    block("Detachments repo-only", d.detRepoOnly);
    block("Enhancements new in dump", d.enhNew);
    L.push("");
  }
  return L.join("\n") + "\n";
}

function runCoverage(dump: MfmDump): void {
  const cov = coverage(dump);
  const report = buildReport(dump, cov);

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-coverage.md");
  fs.writeFileSync(reportPath, report);

  fs.mkdirSync(UNMATCHED_DIR, { recursive: true });
  const unmatched = cov.dirs
    .filter((d) => d.unitsNew.length || d.detNew.length || d.enhNew.length || d.unitsRepoOnly.length)
    .map((d) => ({
      dir: d.dir,
      unitsNew: d.unitsNew,
      unitsRepoOnly: d.unitsRepoOnly,
      detNew: d.detNew,
      enhNew: d.enhNew,
    }));
  fs.writeFileSync(
    path.join(UNMATCHED_DIR, "unmatched-coverage.json"),
    JSON.stringify({ unmappedFactions: cov.unmappedFactions, dirs: unmatched }, null, 2) + "\n"
  );

  const t = (f: (d: DirCoverage) => number) => cov.dirs.reduce((a, d) => a + f(d), 0);
  console.log(`Coverage report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `Units matched ${t((d) => d.unitsMatched)}, new ${t((d) => d.unitsNew.length)}, repo-only ${t((d) => d.unitsRepoOnly.length)} (Legends/FW).`
  );
  console.log(
    `Detachments matched ${t((d) => d.detMatched)}, new ${t((d) => d.detNew.length)}. ` +
      `Enhancements matched ${t((d) => d.enhMatched)}, new ${t((d) => d.enhNew.length)}.`
  );
  if (cov.unmappedFactions.length)
    console.log(`Unmapped factions (no repo dir): ${cov.unmappedFactions.join(", ")}`);
}

async function runDispositionsCmd(
  dump: MfmDump,
  write: boolean,
  includeCombatPatrol = false
): Promise<void> {
  const report = runDispositions(dump, write, { includeCombatPatrol });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-dispositions.md");
  fs.writeFileSync(reportPath, buildDispReport(report, write));

  fs.mkdirSync(UNMATCHED_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(UNMATCHED_DIR, "unmatched-dispositions.json"),
    JSON.stringify(
      {
        newInDump: report.newInDump,
        combatPatrolExcluded: report.cpExcluded,
        repoOnly: report.dirs
          .filter((d) => d.unmatchedRepo.length)
          .map((d) => ({ dir: d.dir, ids: d.unmatchedRepo })),
      },
      null,
      2
    ) + "\n"
  );

  const sum = (f: (d: (typeof report.dirs)[number]) => number) =>
    report.dirs.reduce((a, d) => a + f(d), 0);
  console.log(`Dispositions report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `Matched ${sum((d) => d.matched)}, DP changed ${sum((d) => d.dpChanged.length)}, ` +
      `disposition changed ${sum((d) => d.dispChanged.length)}, ` +
      `repo-only ${sum((d) => d.unmatchedRepo.length)}, new-in-dump ${report.newInDump.length}, ` +
      `held back ${report.cpExcluded.length} Combat-Patrol.`
  );
  await applyWrites(report.staged, { write, label: "dispositions" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runEnhancementsCmd(
  dump: MfmDump,
  write: boolean,
  includeCombatPatrol = false
): Promise<void> {
  const report = runEnhancements(dump, write, { includeCombatPatrol });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-enhancements.md");
  fs.writeFileSync(reportPath, buildEnhReport(report, write));

  fs.mkdirSync(UNMATCHED_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(UNMATCHED_DIR, "unmatched-enhancements.json"),
    JSON.stringify(
      {
        newInDump: report.newInDump,
        combatPatrolExcluded: report.cpExcluded,
        seeded: report.seeded,
        seedSkipped: report.seedSkipped,
        repoOnly: report.dirs
          .filter((d) => d.unmatchedRepo.length)
          .map((d) => ({ dir: d.dir, ids: d.unmatchedRepo })),
      },
      null,
      2
    ) + "\n"
  );

  const sum = (f: (d: (typeof report.dirs)[number]) => number) =>
    report.dirs.reduce((a, d) => a + f(d), 0);
  console.log(`Enhancements report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `Matched ${sum((d) => d.matched)}, seeded ${report.seeded.length}, ` +
      `cost changed ${sum((d) => d.costChanged.length)}, confirmed ${sum((d) => d.confirmed)}, ` +
      `repo-only ${sum((d) => d.unmatchedRepo.length)}, unresolved ${report.newInDump.length}, ` +
      `held back ${report.cpExcluded.length} Combat-Patrol.`
  );
  await applyWrites(report.staged, { write, label: "enhancements" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runNormalizeEnhancementsCmd(dump: MfmDump, write: boolean): Promise<void> {
  const report = normalizeEnhancementNames(dump);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-normalize-enhancements.md");
  const renameLines = Object.entries(report.renames)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([o, n]) => `| \`${o}\` | \`${n}\` |`);
  const md =
    `# MFM enhancement RAW-name normalization\n\n` +
    `Renames the authored enhancement name + id to the RAW GW form (keep the\n` +
    `\` (Upgrade)\`/\` (Aura)\`/\` (Psychic)\` tag) and rewrites detachment\n` +
    `\`enhancement_ids\` references. Import-correct: \`normalizeName\` keeps parens,\n` +
    `so a stripped repo name never matches an imported roster line.\n\n` +
    `- **Id renames (distinct):** ${Object.keys(report.renames).length}\n` +
    `- **Name changes (rows):** ${report.nameChanges.length}\n` +
    `- **Detachment refs rewritten:** ${report.refRewrites.length}\n` +
    `- **Ambiguous bases skipped:** ${report.collisions.length}\n\n` +
    (renameLines.length ? `## Id renames (share-registry alias set)\n\n| old | new |\n|---|---|\n${renameLines.join("\n")}\n\n` : "") +
    (report.collisions.length ? `## Ambiguous bases (left untouched)\n\n${report.collisions.map((c) => `- \`${c}\``).join("\n")}\n` : "");
  fs.writeFileSync(reportPath, md);

  // Sidecar the rename map for the downstream share-registry alias + store steps.
  fs.mkdirSync(UNMATCHED_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(UNMATCHED_DIR, "enh-renames.json"),
    JSON.stringify(report.renames, null, 2) + "\n"
  );

  console.log(`Normalize-enhancements report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `Id renames ${Object.keys(report.renames).length}, name changes ${report.nameChanges.length}, ` +
      `detachment refs rewritten ${report.refRewrites.length}, ambiguous skipped ${report.collisions.length}.`
  );
  if (report.collisions.length) {
    console.warn(`⚠ ${report.collisions.length} ambiguous base(s) left untouched — see report.`);
  }
  await applyWrites(report.staged, { write, label: "normalize-enhancements" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runFactionFieldsCmd(dump: MfmDump, write: boolean): Promise<void> {
  const report = runFactionFields(dump);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-faction-fields.md");
  fs.writeFileSync(reportPath, buildFactionFieldsReport(report, write));

  fs.mkdirSync(UNMATCHED_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(UNMATCHED_DIR, "unmatched-faction-fields.json"),
    JSON.stringify(
      {
        unresolvedDirs: report.unresolvedDirs,
        ruleReview: report.dirs.filter((d) => d.ruleReview).map((d) => ({ dir: d.dir, ...d.ruleReview })),
        parentReview: report.dirs.filter((d) => d.parentReview).map((d) => ({ dir: d.dir, ...d.parentReview })),
      },
      null,
      2
    ) + "\n"
  );

  const n = (f: (d: (typeof report.dirs)[number]) => unknown) =>
    report.dirs.reduce((a, d) => a + (f(d) ? 1 : 0), 0);
  console.log(`Faction fields report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `rule filled ${n((d) => d.ruleFilled)}, parent filled ${n((d) => d.parentFilled)}, ` +
      `aliases added ${report.dirs.reduce((a, d) => a + d.aliasesAdded.length, 0)}, ` +
      `reviews ${n((d) => d.ruleReview) + n((d) => d.parentReview)}, unresolved dirs ${report.unresolvedDirs.length}.`
  );
  await applyWrites(report.staged, { write, label: "faction-fields" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runDetachmentFieldsCmd(dump: MfmDump, write: boolean): Promise<void> {
  const report = runDetachmentFields(dump);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-detachment-fields.md");
  fs.writeFileSync(reportPath, buildDetFieldsReport(report, write));

  fs.mkdirSync(UNMATCHED_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(UNMATCHED_DIR, "unmatched-detachment-fields.json"),
    JSON.stringify(
      {
        tagsChanged: report.dirs.flatMap((d) => d.tagsChanged.map((r) => ({ dir: d.dir, ...r }))),
        requiredKeywordsChanged: report.dirs.flatMap((d) => d.reqChanged.map((r) => ({ dir: d.dir, ...r }))),
        ruleReview: report.dirs.flatMap((d) => d.ruleReview.map((r) => ({ dir: d.dir, ...r }))),
        ruleUnauthored: report.dirs.flatMap((d) => d.ruleUnauthored.map((r) => ({ dir: d.dir, ...r }))),
        unresolvedKeywords: report.dirs.flatMap((d) => d.unresolvedKeywords.map((r) => ({ dir: d.dir, ...r }))),
      },
      null,
      2
    ) + "\n"
  );

  const sum = (f: (d: (typeof report.dirs)[number]) => number) => report.dirs.reduce((a, d) => a + f(d), 0);
  console.log(`Detachment fields report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `tags changed ${sum((d) => d.tagsChanged.length)} (confirm ${sum((d) => d.tagsConfirmed)}), ` +
      `required_keywords changed ${sum((d) => d.reqChanged.length)} (confirm ${sum((d) => d.reqConfirmed)}), ` +
      `detachment_rule_ids filled ${sum((d) => d.ruleFilled.length)} (confirm ${sum((d) => d.ruleConfirmed)}, review ${sum((d) => d.ruleReview.length)}, unauthored ${sum((d) => d.ruleUnauthored.length)}).`
  );
  await applyWrites(report.staged, { write, label: "detachment-fields" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runPointsCmd(dump: MfmDump, write: boolean): Promise<void> {
  const report = runPoints(dump, write);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-points.md");
  fs.writeFileSync(reportPath, buildPointsReport(report, write));

  fs.mkdirSync(UNMATCHED_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(UNMATCHED_DIR, "unmatched-points.json"),
    JSON.stringify(
      {
        newInDump: report.newInDump,
        ambiguous: report.dirs
          .filter((d) => d.ambiguousSkipped.length)
          .map((d) => ({ dir: d.dir, ids: d.ambiguousSkipped })),
        repoOnly: report.dirs
          .filter((d) => d.repoOnly.length)
          .map((d) => ({ dir: d.dir, ids: d.repoOnly })),
      },
      null,
      2
    ) + "\n"
  );

  const sum = (f: (d: (typeof report.dirs)[number]) => number) =>
    report.dirs.reduce((a, d) => a + f(d), 0);
  console.log(`Points report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `Matched ${sum((d) => d.matched)}, points changed ${sum((d) => d.pointsChanged.length)}, ` +
      `allied added ${sum((d) => d.alliedAdded.length)}, ambiguous-kept ${sum((d) => d.ambiguousSkipped.length)}, ` +
      `repo-only ${sum((d) => d.repoOnly.length)}, new-in-dump ${report.newInDump.length}.`
  );
  await applyWrites(report.staged, { write, label: "points" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runCullCmd(dump: MfmDump, write: boolean): Promise<void> {
  const report = runCull(dump, write);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-cull-legends.md");
  fs.writeFileSync(reportPath, buildCullReport(report, write));

  fs.mkdirSync(UNMATCHED_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(UNMATCHED_DIR, "unmatched-cull-legends.json"),
    JSON.stringify(
      {
        totalDropped: report.totalDropped,
        aborted: report.aborted,
        dropped: report.dirs.map((d) => ({ dir: d.dir, ids: d.dropped.map((x) => x.id) })),
        suspicious: report.dirs.flatMap((d) => d.suspicious.map((s) => ({ dir: d.dir, ...s }))),
      },
      null,
      2
    ) + "\n"
  );

  console.log(`Cull report → ${path.relative(REPO_ROOT, reportPath)}`);
  if (report.aborted) {
    console.error(`ABORTED: ${report.aborted}`);
    process.exit(1);
  }
  const sum = (f: (d: (typeof report.dirs)[number]) => number) =>
    report.dirs.reduce((a, d) => a + f(d), 0);
  console.log(
    `Dropped ${report.totalDropped} units; pruned wargear-options ${sum((d) => d.wargearOptionsRemoved)}, ` +
      `compositions ${sum((d) => d.compositionsRemoved)}, leader-entries ${sum((d) => d.leaderEntriesRemoved)}, ` +
      `bodyguard-refs ${sum((d) => d.bodyguardRefsStripped)}, orphan weapons ${sum((d) => d.weaponsRemoved.length)}, ` +
      `orphan wargear ${sum((d) => d.wargearRemoved.length)}; abilities flagged ${sum((d) => d.abilitiesOrphaned.length)}.`
  );
  const susp = sum((d) => d.suspicious.length);
  if (susp) console.log(`⚠ ${susp} possible name-match bug(s) flagged for review (see report).`);
  await applyWrites(report.staged, { write, label: "cull-legends" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runStratagemsCmd(dump: MfmDump, write: boolean): Promise<void> {
  const report = runStratagems(dump, write);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-stratagems.md");
  fs.writeFileSync(reportPath, buildStratReport(report, write));

  const sum = (f: (d: (typeof report.dirs)[number]) => number) =>
    report.dirs.reduce((a, d) => a + f(d), 0);
  console.log(`Stratagems report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `Matched ${sum((d) => d.matched)}, cp applied ${sum((d) => d.cpChanged.length)}, ` +
      `turn applied ${sum((d) => d.turnApplied.length)}, type filled ${sum((d) => d.typeFilled.length)}, ` +
      `type conflict ${sum((d) => d.typeConflict.length)}, category set ${sum((d) => d.categoryChanged.length)}, ` +
      `phases (review) ${sum((d) => d.phasesReview.length)}, ` +
      `repo-only ${sum((d) => d.unmatchedRepo.length)}, new-in-dump ${report.newInDump}.`
  );
  await applyWrites(report.staged, { write, label: "stratagems" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runSeedStratagemsCmd(
  dump: MfmDump,
  write: boolean,
  includeCombatPatrol = false,
): Promise<void> {
  const report = seedStratagems(dump, { includeCombatPatrol });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-seed-stratagems.md");
  const byDir = new Map<string, { id: string; name: string }[]>();
  for (const s of report.seeded) (byDir.get(s.dir) ?? byDir.set(s.dir, []).get(s.dir)!).push(s);
  const md =
    `# MFM stratagem seeding (unseeded competitive set)\n\n` +
    `Creates repo stratagem entities for dump stratagems with no repo entity. Structural\n` +
    `fields are dump-derived; phases are prose-parsed and timing defaults to\n` +
    `\`once-per-phase\`, so every seed is stamped \`pre-launch-provisional\` for review.\n` +
    `Prose routes to the store via \`mfm-backfill-store\`, never here.\n\n` +
    `- **Seeded:** ${report.seeded.length}\n` +
    `- **Held back (Combat Patrol):** ${report.heldBackCombatPatrol.length}\n` +
    `- **Skipped (coreless — manual review):** ${report.skippedCoreless.length}${report.skippedCoreless.length ? ` (${report.skippedCoreless.map((id) => `\`${id}\``).join(", ")})` : ""}\n` +
    `- **Skipped (no repo dir):** ${report.skippedNoDir.length}\n` +
    `- **Skipped (no canon):** ${report.skippedNoCanon.length}\n\n` +
    [...byDir.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dir, ss]) => `## ${dir} (${ss.length})\n\n${ss.sort((x, y) => x.id.localeCompare(y.id)).map((s) => `- \`${s.id}\` — ${s.name}`).join("\n")}`)
      .join("\n\n") +
    "\n";
  fs.writeFileSync(reportPath, md);

  console.log(`Seed-stratagems report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `Seeded ${report.seeded.length}, held back ${report.heldBackCombatPatrol.length} Combat-Patrol, ` +
      `skipped ${report.skippedCoreless.length} coreless / ${report.skippedNoDir.length} no-dir / ${report.skippedNoCanon.length} no-canon.`,
  );
  if (write && report.seeded.length) {
    console.log(
      `Follow-through: run \`npx tsx src/mfm-backfill-store.ts --write\` to push the seeded ` +
        `stratagems' prose to the store, then rebuild index.json.`,
    );
  }
  await applyWrites(report.staged, { write, label: "seed-stratagems" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runMissionsCmd(dump: MfmDump, write: boolean): Promise<void> {
  const report = runMissions(dump, write);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-missions.md");
  fs.writeFileSync(reportPath, buildMissionsReport(report, write));

  if (report.shapeMismatch.length || report.exclusiveReview.length || report.repoOnly.length) {
    fs.mkdirSync(UNMATCHED_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(UNMATCHED_DIR, "unmatched-missions.json"),
      JSON.stringify(
        {
          shapeMismatch: report.shapeMismatch,
          exclusiveReview: report.exclusiveReview,
          repoOnly: report.repoOnly,
          dumpOnly: report.dumpOnly,
        },
        null,
        2
      ) + "\n"
    );
  }

  console.log(`Missions report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `Matched ${report.matched}, cards changed ${report.cardsChanged}, ` +
      `vp ${report.vpChanged.length}, vp_max ${report.vpMaxChanged.length}, ` +
      `cumulative ${report.cumulativeChanged.length}, exclusive_group added ${report.exclusiveAdded.length}, ` +
      `shape-mismatch ${report.shapeMismatch.length}, repo-only ${report.repoOnly.length}.`
  );
  const e = report.entities;
  console.log(
    `Mission entities: matched ${e.matched}, source filled ${e.sourceFilled.length} ` +
      `(review ${e.sourceReview.length}), VP caps confirmed ${e.capConfirmed} (review ${e.capReview.length}).`
  );
  await applyWrites(report.staged, { write, label: "missions" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runMissionMatchupsCmd(dump: MfmDump, write: boolean): Promise<void> {
  const report = runMissionMatchups(dump);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-mission-matchups.md");
  fs.writeFileSync(reportPath, buildMatchupReport(report, write));

  if (report.repoOnly.length || report.unresolvedDump.length) {
    fs.mkdirSync(UNMATCHED_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(UNMATCHED_DIR, "unmatched-mission-matchups.json"),
      JSON.stringify({ repoOnly: report.repoOnly, unresolvedDump: report.unresolvedDump }, null, 2) + "\n"
    );
  }

  console.log(`Mission-matchups report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `Matched ${report.matched}, seeded ${report.seeded.length}, corrected ${report.corrected.length}, ` +
      `repo-only ${report.repoOnly.length}, unresolved-dump ${report.unresolvedDump.length}.`
  );
  await applyWrites(report.staged, { write, label: "mission-matchups" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runBaseSizesCmd(dump: MfmDump, write: boolean): Promise<void> {
  const report = runBaseSizes(dump);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-base-sizes.md");
  fs.writeFileSync(reportPath, buildBaseSizeReport(report, write));

  if (report.review.length) {
    fs.mkdirSync(UNMATCHED_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(UNMATCHED_DIR, "unmatched-base-sizes.json"),
      JSON.stringify({ review: report.review }, null, 2) + "\n"
    );
  }

  console.log(`Base-sizes report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `Filled ${report.filled.length}, de-drafted ${report.dedrafted.length}, ` +
      `corrected ${report.corrected.length}, confirmed ${report.confirmed}, review ${report.review.length}.`
  );
  await applyWrites(report.staged, { write, label: "base-sizes" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runChapterScopeCmd(dump: MfmDump, write: boolean): Promise<void> {
  const report = runChapterScope(dump, write);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-chapter-scope.md");
  fs.writeFileSync(reportPath, buildChapterScopeReport(report, write));

  if (report.repoOnly.length || report.dumpOnly.length) {
    fs.mkdirSync(UNMATCHED_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(UNMATCHED_DIR, "unmatched-chapter-scope.json"),
      JSON.stringify({ repoOnly: report.repoOnly, dumpOnly: report.dumpOnly }, null, 2) + "\n"
    );
  }

  console.log(`Chapter-scope report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `Matched ${report.matched}, faction_keywords collapsed ${report.factionKeywordsChanged.length}, ` +
      `excluded_faction_keywords set ${report.excludedChanged.length}, ` +
      `repo-only ${report.repoOnly.length}, dump-only ${report.dumpOnly.length}.`
  );
  await applyWrites(report.staged, { write, label: "chapter-scope" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runWargearCmd(dump: MfmDump, write: boolean, onlyDir?: string): Promise<void> {
  const report = runWargear(dump, write, onlyDir);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-wargear.md");
  fs.writeFileSync(reportPath, buildWargearReport(report, write));

  const sum = (f: (d: (typeof report.dirs)[number]) => number) =>
    report.dirs.reduce((a, d) => a + f(d), 0);
  console.log(`Wargear report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `Matched ${sum((d) => d.matched)}, options ${sum((d) => d.optionsChanged)}, ` +
      `defaults Δ ${sum((d) => d.defaultsChanged)}, weapon ids Δ ${sum((d) => d.weaponIdsChanged)}, ` +
      `weapon names Δ ${sum((d) => d.weaponNamesChanged)}, weapons ${sum((d) => d.weaponsAdded)}, ` +
      `wargear ${sum((d) => d.wargearAdded)}, synth ${sum((d) => d.synthesizedRows)}, ` +
      `unresolved ${sum((d) => d.unresolvedNames.length)}, new-in-dump ${sum((d) => d.newInDump.length)}, ` +
      `repo-only ${sum((d) => d.repoOnlyFallback.length)}.`
  );
  await applyWrites(report.staged, { write, label: "wargear" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runWargearBudgetsCmd(dump: MfmDump, write: boolean, onlyDir?: string): Promise<void> {
  const report = runWargearBudgets(dump, onlyDir);
  const sum = (f: (d: (typeof report.dirs)[number]) => number) =>
    report.dirs.reduce((a, d) => a + f(d), 0);
  console.log(
    `Wargear budgets — matched ${sum((d) => d.matched)}, ` +
      `units with budgets ${sum((d) => d.unitsWithBudgets)}, total budgets ${sum((d) => d.budgets)}.`,
  );
  await applyWrites(report.staged, { write, label: "wargear-budgets" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runWargearCostsCmd(dump: MfmDump, write: boolean, onlyDir?: string): Promise<void> {
  const report = runWargearCosts(dump, onlyDir);
  const sum = (f: (d: (typeof report.dirs)[number]) => number) =>
    report.dirs.reduce((a, d) => a + f(d), 0);
  console.log(
    `Wargear costs — matched ${sum((d) => d.matched)}, ` +
      `units with costs ${sum((d) => d.unitsWithCosts)}, total priced items ${sum((d) => d.costs)}, ` +
      `additional_cost stripped ${sum((d) => d.strippedAdditionalCost)}.`,
  );
  await applyWrites(report.staged, { write, label: "wargear-costs" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runCompositionNamesCmd(dump: MfmDump, write: boolean, onlyDir?: string): Promise<void> {
  const report = runCompositionNames(dump, onlyDir);
  const sum = (f: (d: (typeof report.dirs)[number]) => number) =>
    report.dirs.reduce((a, d) => a + f(d), 0);
  console.log(
    `Composition names — matched ${sum((d) => d.matched)}, rows renamed ${sum((d) => d.rowsRenamed)}, ` +
      `units rebuilt from dump ${sum((d) => d.unitsRebuilt)}, skipped (kill-team shape) ${report.skipped.length}.`,
  );
  for (const n of report.notes) console.log(`  note [${n.dir}/${n.id}] ${n.note}`);
  if (report.skipped.length) {
    fs.mkdirSync(UNMATCHED_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(UNMATCHED_DIR, "unmatched-composition-names.json"),
      JSON.stringify(report.skipped, null, 2) + "\n",
    );
  }
  await applyWrites(report.staged, { write, label: "composition-names" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runCompositionTiersCmd(dump: MfmDump, write: boolean, onlyDir?: string): Promise<void> {
  const report = runCompositionTiers(dump, onlyDir);
  const sum = (f: (d: (typeof report.dirs)[number]) => number) =>
    report.dirs.reduce((a, d) => a + f(d), 0);
  console.log(
    `Composition tiers — matched ${sum((d) => d.matched)}, units tiered ${sum((d) => d.unitsTiered)}, ` +
      `model rows adjusted ${sum((d) => d.rowsAdjusted)}, model_count re-synced ${sum((d) => d.modelCountResynced)}, ` +
      `skipped (kill-team / structure differs) ${report.skipped.length}.`,
  );
  if (report.skipped.length) {
    fs.mkdirSync(UNMATCHED_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(UNMATCHED_DIR, "unmatched-composition-tiers.json"),
      JSON.stringify(report.skipped, null, 2) + "\n",
    );
  }
  await applyWrites(report.staged, { write, label: "composition-tiers" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runAttachmentRoleCmd(dump: MfmDump, write: boolean, onlyDir?: string): Promise<void> {
  const report = runAttachmentRoles(dump, onlyDir);
  const reportPath = path.join(REPORT_DIR, "mfm-attachment.md");
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(reportPath, buildAttachmentReport(report, write));

  const sum = (f: (d: (typeof report.dirs)[number]) => number) =>
    report.dirs.reduce((a, d) => a + f(d), 0);
  console.log(`Attachment report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `Attachment roles — matched ${sum((d) => d.matched)}, roles Δ ${sum((d) => d.rolesChanged)}, ` +
      `leaders from dump ${sum((d) => d.leadersEmitted)}, kept ${sum((d) => d.leadersPreserved)}, ` +
      `unresolved leaders ${sum((d) => d.unresolvedLeaders.length)}.`,
  );
  await applyWrites(report.staged, { write, label: "attachment-role" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runSeedUnitsCmd(
  dump: MfmDump,
  write: boolean,
  onlyDir?: string,
  includeCombatPatrol = false,
): Promise<void> {
  const report = runSeedUnits(dump, { onlyDir, includeCombatPatrol });
  const reportPath = path.join(REPORT_DIR, "mfm-seed-units.md");
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(reportPath, buildSeedUnitsReport(report, write));

  const created = report.dirs.reduce((a, d) => a + d.created.length, 0);
  const cpExcluded = report.dirs.reduce((a, d) => a + d.cpExcluded.length, 0);
  const skipped = report.dirs.reduce((a, d) => a + d.skipped.length, 0);
  if (skipped || cpExcluded) {
    fs.mkdirSync(UNMATCHED_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(UNMATCHED_DIR, "unmatched-seed-units.json"),
      JSON.stringify(
        {
          skipped: report.dirs.flatMap((d) => d.skipped.map((s) => ({ dir: d.dir, ...s }))),
          combatPatrolExcluded: report.dirs.flatMap((d) =>
            d.cpExcluded.map((c) => ({ dir: d.routedTo ?? d.dir, ...c })),
          ),
        },
        null,
        2,
      ) + "\n",
    );
  }
  console.log(`Seed-units report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `Seed-units — created ${created} skeleton unit(s), ` +
      `held back ${cpExcluded} Combat-Patrol-only, skipped ${skipped}.`,
  );
  await applyWrites(report.staged, { write, label: "seed-units" });
  if (!write) {
    console.log("DRY RUN — no files written. Re-run with --write to apply.");
  } else if (created > 0) {
    // seed-units emits skeletons only (no weapon_ids/ability_ids/composition).
    // The wargear/composition reconcile passes skip a datasheet whose unit did
    // not yet exist when they ran, so a freshly-seeded unit keeps an empty
    // loadout until those passes are re-run now that it exists. Prompt that
    // follow-through here so a seeded skeleton is not silently shipped (the gap
    // is also tracked by `npm run audit:loadout-coverage`).
    const createdIds = report.dirs.flatMap((d) => d.created.map((c) => c.id));
    console.log(
      "\nNext: these skeletons have NO loadout/abilities yet. Re-run the reconcile\n" +
        "passes now that the units exist, then author abilities:\n" +
        "  npx tsx tools/src/ingest-mfm.ts wargear --write\n" +
        "  npx tsx tools/src/ingest-mfm.ts composition-tiers --write\n" +
        "  (then author ability_ids; verify with `npm run audit:loadout-coverage`)\n" +
        `Seeded ids: ${createdIds.join(", ")}`,
    );
  }
}

async function runSeedDetachmentsCmd(
  dump: MfmDump,
  write: boolean,
  onlyDir?: string,
  includeCombatPatrol = false,
): Promise<void> {
  const report = runSeedDetachments(dump, { onlyDir, includeCombatPatrol });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-seed-detachments.md");
  fs.writeFileSync(reportPath, buildSeedDetachmentsReport(report, write));

  const dets = report.dirs.reduce((a, d) => a + d.createdDetachments.length, 0);
  const enhs = report.dirs.reduce((a, d) => a + d.createdEnhancements.length, 0);
  const cpExcluded = report.dirs.reduce((a, d) => a + d.cpExcluded.length, 0);
  const skipped = report.dirs.reduce((a, d) => a + d.skipped.length, 0);
  console.log(`Seed-detachments report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `Seed-detachments — created ${dets} detachment(s), ${enhs} enhancement(s), ` +
      `held back ${cpExcluded} Combat-Patrol, skipped ${skipped} existing.`,
  );
  await applyWrites(report.staged, { write, label: "seed-detachments" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runAlliesCmd(dump: MfmDump, write: boolean): Promise<void> {
  const report = runAllies(dump);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-allies.md");
  fs.writeFileSync(reportPath, buildAlliesReport(report, write));

  console.log(`Allies report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `Pools emitted ${report.rules.length}, skipped ${report.skipped.length}` +
      `${report.skipped.length ? ` (${report.skipped.map((s) => s.label).join(", ")})` : ""}, ` +
      `partially-unresolved ${report.unresolved.length}, new-in-dump ${report.unknownPools.length}.`,
  );
  for (const u of report.unresolved) {
    const parts = [
      u.datasheets.length ? `datasheets: ${u.datasheets.join("; ")}` : "",
      u.detachments.length ? `detachments: ${u.detachments.join("; ")}` : "",
    ].filter(Boolean);
    console.log(`  ${u.id} dropped → ${parts.join(" | ")}`);
  }
  for (const g of report.unknownPools) console.log(`  new GW pool not in overlay: ${g}`);

  await applyWrites(report.staged, { write, label: "allies" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runWeaponVariantsCmd(dump: MfmDump, write: boolean, onlyDir?: string): Promise<void> {
  const report = runWeaponVariants(dump, onlyDir);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-weapon-variants.md");
  fs.writeFileSync(reportPath, buildWeaponVariantsReport(report, write));

  const sum = (f: (d: (typeof report.dirs)[number]) => number) =>
    report.dirs.reduce((a, d) => a + f(d), 0);
  console.log(`Weapon-variant report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `Conflicting ids ${sum((d) => d.conflictingIds)}, variants +${sum((d) => d.variantsAdded)}, ` +
      `units rewired ${sum((d) => d.unitsRewired)}, duplicates dropped ${sum((d) => d.duplicatesDropped)}, ` +
      `warnings ${sum((d) => d.warnings.length)}.`,
  );
  await applyWrites(report.staged, { write, label: "weapon-variants" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runConditionalKeywordsCmd(
  dump: MfmDump,
  write: boolean,
  onlyDir?: string,
): Promise<void> {
  const report = runConditionalKeywords(dump, onlyDir);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-conditional-keywords.md");
  fs.writeFileSync(reportPath, buildConditionalKeywordReport(report, write));
  fs.mkdirSync(UNMATCHED_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(UNMATCHED_DIR, "unmatched-conditional-keywords.json"),
    JSON.stringify(
      { unsupported: report.unsupported, unresolved: report.unresolved },
      null,
      2,
    ) + "\n",
  );
  console.log(`Conditional-keyword report → ${path.relative(REPO_ROOT, reportPath)}`);
  console.log(
    `Changed ${report.dirs.reduce((sum, entry) => sum + entry.changed, 0)} units; ` +
      `${report.unsupported.length} unsupported conditions; ${report.unresolved.length} unresolved references.`,
  );
  await applyWrites(report.staged, { write, label: "conditional-keywords" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

export const INGEST_MFM_COMMANDS = [
  "coverage",
  "golden",
  "dispositions",
  "enhancements",
  "normalize-enhancements",
  "faction-fields",
  "detachment-fields",
  "conditional-keywords",
  "points",
  "cull-legends",
  "stratagems",
  "seed-stratagems",
  "missions",
  "mission-matchups",
  "base-sizes",
  "chapter-scope",
  "wargear",
  "wargear-budgets",
  "wargear-costs",
  "composition-names",
  "composition-tiers",
  "attachment-role",
  "seed-units",
  "seed-detachments",
  "allies",
  "weapon-variants",
] as const;

export type IngestMfmCommand = (typeof INGEST_MFM_COMMANDS)[number];

export type IngestMfmOptions = {
  dumpPath: string;
  write: boolean;
  onlyDir?: string;
  includeCombatPatrol?: boolean;
};

/** Run one ingest transform through its existing projected-data persistence seam. */
export async function runIngestMfmCommand(
  command: IngestMfmCommand,
  options: IngestMfmOptions,
): Promise<void> {
  const dump = loadDump(options.dumpPath);
  if (command === "coverage") runCoverage(dump);
  else if (command === "golden") writeGolden(dump);
  else if (command === "dispositions") await runDispositionsCmd(dump, options.write, options.includeCombatPatrol);
  else if (command === "enhancements") await runEnhancementsCmd(dump, options.write, options.includeCombatPatrol);
  else if (command === "normalize-enhancements") await runNormalizeEnhancementsCmd(dump, options.write);
  else if (command === "faction-fields") await runFactionFieldsCmd(dump, options.write);
  else if (command === "detachment-fields") await runDetachmentFieldsCmd(dump, options.write);
  else if (command === "conditional-keywords") await runConditionalKeywordsCmd(dump, options.write, options.onlyDir);
  else if (command === "points") await runPointsCmd(dump, options.write);
  else if (command === "cull-legends") await runCullCmd(dump, options.write);
  else if (command === "stratagems") await runStratagemsCmd(dump, options.write);
  else if (command === "seed-stratagems") await runSeedStratagemsCmd(dump, options.write, options.includeCombatPatrol);
  else if (command === "missions") await runMissionsCmd(dump, options.write);
  else if (command === "mission-matchups") await runMissionMatchupsCmd(dump, options.write);
  else if (command === "base-sizes") await runBaseSizesCmd(dump, options.write);
  else if (command === "chapter-scope") await runChapterScopeCmd(dump, options.write);
  else if (command === "wargear") await runWargearCmd(dump, options.write, options.onlyDir);
  else if (command === "wargear-budgets") await runWargearBudgetsCmd(dump, options.write, options.onlyDir);
  else if (command === "wargear-costs") await runWargearCostsCmd(dump, options.write, options.onlyDir);
  else if (command === "composition-names") await runCompositionNamesCmd(dump, options.write, options.onlyDir);
  else if (command === "composition-tiers") await runCompositionTiersCmd(dump, options.write, options.onlyDir);
  else if (command === "attachment-role") await runAttachmentRoleCmd(dump, options.write, options.onlyDir);
  else if (command === "seed-units") await runSeedUnitsCmd(dump, options.write, options.onlyDir, options.includeCombatPatrol);
  else if (command === "seed-detachments") await runSeedDetachmentsCmd(dump, options.write, options.onlyDir, options.includeCombatPatrol);
  else if (command === "allies") await runAlliesCmd(dump, options.write);
  else if (command === "weapon-variants") await runWeaponVariantsCmd(dump, options.write, options.onlyDir);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const dumpFlag = argv.indexOf("--dump");
  const dirFlag = argv.indexOf("--dir");
  if (!INGEST_MFM_COMMANDS.includes(command as IngestMfmCommand)) {
    console.error(
      `Usage: ingest-mfm <${INGEST_MFM_COMMANDS.join("|")}> [--write] [--dump <path>] [--dir <faction>] [--include-combat-patrol]`,
    );
    process.exit(2);
  }
  await runIngestMfmCommand(command as IngestMfmCommand, {
    dumpPath: dumpFlag >= 0 ? argv[dumpFlag + 1] : DEFAULT_DUMP_PATH,
    write: argv.includes("--write"),
    onlyDir: dirFlag >= 0 ? argv[dirFlag + 1] : undefined,
    includeCombatPatrol: argv.includes("--include-combat-patrol"),
  });
}

/** True only when this module is the process entrypoint — so importing it (the golden
 *  command's `golden.ts`, or the completeness test) never runs the CLI. */
function isEntrypoint(): boolean {
  try {
    const argv1 = process.argv[1];
    return !!argv1 && fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
