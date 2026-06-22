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
import { nameToId, detachmentScopedId } from "./converters/id-generator.js";
import {
  loadDump,
  MfmDump,
  REPO_ROOT,
  type DatasheetRow,
  type DetachmentRow,
  type EnhancementRow,
} from "./mfm/loader.js";
import { repoDirForFactionName, SHARED_ROSTERS, repoDirs } from "./mfm/faction-map.js";
import { runDispositions, buildDispReport } from "./mfm/dispositions.js";
import { runEnhancements, buildEnhReport } from "./mfm/enhancements.js";
import { runPoints, buildPointsReport } from "./mfm/points.js";
import { runCull, buildCullReport } from "./mfm/legends-cull.js";
import { runStratagems, buildStratReport } from "./mfm/stratagems.js";
import { runMissions, buildMissionsReport } from "./mfm/missions.js";
import { runChapterScope, buildChapterScopeReport } from "./mfm/chapter-scope.js";
import {
  runWargear,
  buildWargearReport,
  runWargearBudgets,
  runCompositionNames,
  runCompositionTiers,
} from "./mfm/wargear.js";
import { runAttachmentRoles, buildAttachmentReport } from "./mfm/attachment.js";
import { runSeedUnits, buildSeedUnitsReport } from "./mfm/seed-units.js";
import { applyWrites, type StagedWrite } from "./mfm/apply.js";

const CORE_DIR = path.join(REPO_ROOT, "data", "core");
const REPORT_DIR = path.join(CORE_DIR, "_reports");
const UNMATCHED_DIR = path.join(REPO_ROOT, "_private", "mfm");

function readJson<T>(p: string): T[] {
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as T[]) : [];
}
function repoIds(dir: string, file: string): Set<string> {
  return new Set(readJson<{ id: string }>(path.join(CORE_DIR, dir, file)).map((e) => e.id));
}

/** Bucket dump datasheets / detachments / enhancements by their resolved repo dir. */
function bucketByDir<T extends { id?: string }>(
  rows: T[],
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

interface DirCoverage {
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

function coverage(dump: MfmDump): { dirs: DirCoverage[]; unmappedFactions: string[] } {
  const liveDatasheets = dump
    .table<DatasheetRow>("datasheet")
    .filter((d) => !d.isLegends);
  const dsByDir = bucketByDir(
    liveDatasheets,
    (d) => dump.factionKeywordOfDatasheet(d.id!),
    dump
  );
  const detByDir = bucketByDir(
    dump.table<DetachmentRow>("detachment"),
    (d) => dump.factionKeywordOfDetachment(d.id!),
    dump
  );
  const enhByDir = bucketByDir(
    dump.table<EnhancementRow>("enhancement"),
    (e) => dump.factionKeywordOfDetachment(e.detachmentId),
    dump
  );

  // Global dump id sets — the repo-only ("dropped by cull-legends") signal must be
  // routing-agnostic: a repo entity is a true gap only if NO dump entity anywhere
  // shares its id. Per-dir buckets above stay as the routing diagnostic.
  const globalUnitIds = new Set<string>();
  for (const ds of liveDatasheets) {
    const id = slug(dump.enName(ds));
    if (id) globalUnitIds.add(id);
  }
  const globalDetIds = new Set<string>();
  for (const det of dump.table<DetachmentRow>("detachment")) {
    const id = slug(dump.enName(det));
    if (id) globalDetIds.add(id);
  }
  const globalEnhIds = new Set<string>();
  for (const enh of dump.table<EnhancementRow>("enhancement")) {
    const en = dump.enName(enh);
    const dn = dump.enName(dump.byId<DetachmentRow>("detachment").get(enh.detachmentId));
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

  const dirs: DirCoverage[] = [];
  for (const dir of [...repoDirs()].sort()) {
    const dumpUnitIds = new Map<string, string>(); // id → display name
    for (const ds of dsByDir.get(dir) ?? []) {
      const n = dump.enName(ds);
      if (!n) continue;
      try {
        dumpUnitIds.set(nameToId(n), n);
      } catch {
        /* unsluggable name — skip */
      }
    }
    const repoUnitIds = repoIds(dir, "units.json");
    const shared = SHARED_ROSTERS[dir] ?? [];
    const sharedIds = new Set(shared.flatMap((p) => [...repoIds(p, "units.json")]));

    const unitsNew: string[] = [];
    let unitsMatched = 0;
    let unitsSharedSkipped = 0;
    for (const [id, name] of dumpUnitIds) {
      if (repoUnitIds.has(id)) unitsMatched++;
      else if (sharedIds.has(id)) unitsSharedSkipped++;
      else unitsNew.push(`${name} (${id})`);
    }
    const unitsRepoOnly = [...repoUnitIds].filter((id) => !globalUnitIds.has(id)).sort();

    // detachments
    const dumpDetIds = new Map<string, string>();
    for (const det of detByDir.get(dir) ?? []) {
      const n = dump.enName(det);
      if (!n) continue;
      try {
        dumpDetIds.set(nameToId(n), n);
      } catch {
        /* skip */
      }
    }
    const repoDetIds = repoIds(dir, "detachments.json");
    const detNew: string[] = [];
    let detMatched = 0;
    for (const [id, name] of dumpDetIds) {
      if (repoDetIds.has(id)) detMatched++;
      else detNew.push(`${name} (${id})`);
    }
    const detRepoOnly = [...repoDetIds].filter((id) => !globalDetIds.has(id)).sort();

    // enhancements — id is detachmentScopedId(enhName, detName)
    const dumpEnhIds = new Map<string, string>();
    for (const enh of enhByDir.get(dir) ?? []) {
      const en = dump.enName(enh);
      const det = dump.byId<DetachmentRow>("detachment").get((enh as EnhancementRow).detachmentId);
      const dn = dump.enName(det);
      if (!en || !dn) continue;
      try {
        dumpEnhIds.set(detachmentScopedId(en, dn), `${en} / ${dn}`);
      } catch {
        /* skip */
      }
    }
    const repoEnhIds = repoIds(dir, "enhancements.json");
    const enhNew: string[] = [];
    let enhMatched = 0;
    for (const [id, label] of dumpEnhIds) {
      if (repoEnhIds.has(id)) enhMatched++;
      else enhNew.push(`${label} (${id})`);
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
  const repoStrat = readJson<{ id: string }>(path.join(CORE_DIR, "stratagems.json")).length;
  const repoMiss = readJson<{ id: string }>(path.join(CORE_DIR, "missions.json")).length;
  L.push("## Whole-dataset categories");
  L.push("");
  L.push("| Category | Repo | Dump |");
  L.push("|---|--:|--:|");
  L.push(`| Stratagems | ${repoStrat} | ${dump.table("stratagem").length} |`);
  L.push(
    `| Missions | ${repoMiss} | ${dump.table("primary_mission").length} primary + ${dump.table("secondary_mission").length} secondary |`
  );
  L.push(`| Force dispositions | 5 | ${dump.table("force_disposition").length} |`);
  L.push(
    `| Detachment→disposition map | — | ${dump.table("detachment_force_disposition").length} (1:1) |`
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

async function runDispositionsCmd(dump: MfmDump, write: boolean): Promise<void> {
  const report = runDispositions(dump, write);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-dispositions.md");
  fs.writeFileSync(reportPath, buildDispReport(report, write));

  fs.mkdirSync(UNMATCHED_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(UNMATCHED_DIR, "unmatched-dispositions.json"),
    JSON.stringify(
      {
        newInDump: report.newInDump,
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
      `repo-only ${sum((d) => d.unmatchedRepo.length)}, new-in-dump ${report.newInDump.length}.`
  );
  await applyWrites(report.staged, { write, label: "dispositions" });
  if (!write) console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

async function runEnhancementsCmd(dump: MfmDump, write: boolean): Promise<void> {
  const report = runEnhancements(dump, write);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "mfm-enhancements.md");
  fs.writeFileSync(reportPath, buildEnhReport(report, write));

  fs.mkdirSync(UNMATCHED_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(UNMATCHED_DIR, "unmatched-enhancements.json"),
    JSON.stringify(
      {
        newInDump: report.newInDump,
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
    `Matched ${sum((d) => d.matched)}, cost changed ${sum((d) => d.costChanged.length)}, ` +
      `confirmed ${sum((d) => d.confirmed)}, repo-only ${sum((d) => d.unmatchedRepo.length)}, ` +
      `new-in-dump ${report.newInDump.length}.`
  );
  await applyWrites(report.staged, { write, label: "enhancements" });
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
        structure: report.dirs
          .filter((d) => d.structureSkipped.length)
          .map((d) => ({ dir: d.dir, units: d.structureSkipped })),
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
      `phases (review) ${sum((d) => d.phasesChanged.length)}, turn (review) ${sum((d) => d.turnChanged.length)}, ` +
      `repo-only ${sum((d) => d.unmatchedRepo.length)}, new-in-dump ${report.newInDump}.`
  );
  await applyWrites(report.staged, { write, label: "stratagems" });
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
  await applyWrites(report.staged, { write, label: "missions" });
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
      `defaults Δ ${sum((d) => d.defaultsChanged)}, synth ${sum((d) => d.synthesizedRows)}, ` +
      `unresolved ${sum((d) => d.unresolvedNames.length)}, ` +
      `new-in-dump ${sum((d) => d.newInDump.length)}, repo-only ${sum((d) => d.repoOnlyFallback.length)}.`
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

async function runCompositionNamesCmd(dump: MfmDump, write: boolean, onlyDir?: string): Promise<void> {
  const report = runCompositionNames(dump, onlyDir);
  const sum = (f: (d: (typeof report.dirs)[number]) => number) =>
    report.dirs.reduce((a, d) => a + f(d), 0);
  console.log(
    `Composition names — matched ${sum((d) => d.matched)}, rows renamed ${sum((d) => d.rowsRenamed)}, ` +
      `skipped (structure differs) ${report.skipped.length}.`,
  );
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const write = argv.includes("--write");
  const dumpFlag = argv.indexOf("--dump");
  const dumpPath = dumpFlag >= 0 ? argv[dumpFlag + 1] : undefined;
  const dirFlag = argv.indexOf("--dir");
  const onlyDir = dirFlag >= 0 ? argv[dirFlag + 1] : undefined;
  const includeCombatPatrol = argv.includes("--include-combat-patrol");

  const commands = [
    "coverage",
    "dispositions",
    "enhancements",
    "points",
    "cull-legends",
    "stratagems",
    "missions",
    "chapter-scope",
    "wargear",
    "wargear-budgets",
    "composition-names",
    "composition-tiers",
    "attachment-role",
    "seed-units",
  ];
  if (!commands.includes(cmd)) {
    console.error(
      `Usage: ingest-mfm <${commands.join("|")}> [--write] [--dump <path>] [--dir <faction>] [--include-combat-patrol]`
    );
    process.exit(2);
  }

  const dump = loadDump(dumpPath);
  if (cmd === "coverage") runCoverage(dump);
  else if (cmd === "dispositions") await runDispositionsCmd(dump, write);
  else if (cmd === "enhancements") await runEnhancementsCmd(dump, write);
  else if (cmd === "points") await runPointsCmd(dump, write);
  else if (cmd === "cull-legends") await runCullCmd(dump, write);
  else if (cmd === "stratagems") await runStratagemsCmd(dump, write);
  else if (cmd === "missions") await runMissionsCmd(dump, write);
  else if (cmd === "chapter-scope") await runChapterScopeCmd(dump, write);
  else if (cmd === "wargear") await runWargearCmd(dump, write, onlyDir);
  else if (cmd === "wargear-budgets") await runWargearBudgetsCmd(dump, write, onlyDir);
  else if (cmd === "composition-names") await runCompositionNamesCmd(dump, write, onlyDir);
  else if (cmd === "composition-tiers") await runCompositionTiersCmd(dump, write, onlyDir);
  else if (cmd === "attachment-role") await runAttachmentRoleCmd(dump, write, onlyDir);
  else if (cmd === "seed-units")
    await runSeedUnitsCmd(dump, write, onlyDir, includeCombatPatrol);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
