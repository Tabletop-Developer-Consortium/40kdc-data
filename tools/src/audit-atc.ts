/**
 * Audit the ATC event corpus: run every real tournament list in
 * `examples/atc-viewer/src/data/atc-{2026,5s}.json` through the importer, the
 * roster legality checker, and the loadout-grouping solver, and write a ranked
 * triage report. The corpus is the package's accuracy baseline — these lists
 * were accepted by a real event, so they are "by and large accurate": legality
 * violations should be rare and real, and every cluster (the same `code:unitId`
 * across many independent players) is a data or checker bug, not mass cheating.
 *
 * Reports:
 *   - `data/_audit/atc-legality.md`   — human triage report
 *   - `data/_audit/atc-legality.json` — machine-readable, doubles as the
 *     committed baseline for `--check`
 *
 * Sections:
 *   - headline counts (parse failures, warnings by code, violating units,
 *     grouping outcomes by reason)
 *   - legality violations ranked by `code:unitId`
 *   - unresolved names ranked per warning code
 *   - loadout-grouping failures classified by reason; per-unit ranking for the
 *     `solver-null` bucket (the genuinely-indivisible loadouts — the signal)
 *   - dataset composition-integrity drift: units whose composition
 *     `default_weapon_ids` reference ids unreachable from `weapon_ids` ∪ the
 *     unit's wargear-option grants (e.g. a 10e default lingering under an 11e
 *     loadout)
 *
 * Usage:
 *   npx tsx tools/src/audit-atc.ts             # write reports
 *   npx tsx tools/src/audit-atc.ts --dry-run   # print summary only
 *   npx tsx tools/src/audit-atc.ts --check     # exit 1 if any headline count
 *                                              # increased over the committed
 *                                              # baseline (report-only gate)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { tryImportRoster } from "./import/index.js";
import type { Roster, RosterUnit } from "./import/types.js";
import { Dataset, checkRosterLegality, resolveRosterUnit } from "./data/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "../..");

const CORPUS_FILES = [
  "examples/atc-viewer/src/data/atc-2026.json",
  "examples/atc-viewer/src/data/atc-5s.json",
];

// ─── Corpus shape (the atc-viewer event-pull snapshots) ─────────────────

interface CorpusPlayer {
  faction?: string | null;
  armyListText?: string | null;
}
interface CorpusTeam {
  players?: CorpusPlayer[];
}
interface CorpusFile {
  teams?: CorpusTeam[];
}

// ─── Report shape ────────────────────────────────────────────────────────

/** Why a unit did (not) receive `loadout_groups`, mirroring the gates in
 * `buildLoadoutGroups` (import/resolve.ts) and `groupLoadout` (data/loadout.ts). */
export type GroupingOutcome =
  | "grouped"
  | "unit-unresolved"
  | "wargear-unresolved"
  | "single-model"
  | "no-recorded-defaults"
  | "solver-null";

const GROUPING_OUTCOMES: GroupingOutcome[] = [
  "grouped",
  "unit-unresolved",
  "wargear-unresolved",
  "single-model",
  "no-recorded-defaults",
  "solver-null",
];

export interface RankedCount {
  key: string;
  count: number;
}

export interface CompositionDrift {
  faction: string;
  unit_id: string;
  /** Composition default_weapon_ids not reachable from weapon_ids ∪ option grants. */
  unreachable: string[];
}

export interface AtcAuditReport {
  generatedFrom: string;
  corpus: { file: string; lists: number; skipped_no_text: number }[];
  headline: {
    lists: number;
    parse_failures: number;
    lists_with_violations: number;
    violating_units: number;
    warnings_by_code: Record<string, number>;
    violations_by_code: Record<string, number>;
    grouping_by_outcome: Record<GroupingOutcome, number>;
    composition_drift_units: number;
  };
  parse_failures: { file: string; list: string; faction: string; reason: string }[];
  violations: RankedCount[]; // `${code}:${unitId}` ranked
  unresolved_names: Record<string, RankedCount[]>; // warning code → ranked raw names
  solver_null_units: RankedCount[]; // unit ids ranked
  composition_drift: CompositionDrift[];
}

// ─── Audit ───────────────────────────────────────────────────────────────

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function ranked(map: Map<string, number>): RankedCount[] {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function toRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(ranked(map).map((r) => [r.key, r.count]));
}

/** First non-empty line of the list text — the army name — to locate a list
 * in the corpus without carrying player names into the report. */
function listLabel(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !/^\++$/.test(t)) return t.length > 60 ? `${t.slice(0, 57)}…` : t;
  }
  return "(unnamed)";
}

/** Classify why a roster unit did (not) get `loadout_groups`, mirroring the
 * gates of `buildLoadoutGroups` → `groupLoadout` in order. */
function classifyGrouping(unit: RosterUnit, roster: Roster, ds: Dataset): GroupingOutcome {
  if (unit.loadout_groups) return "grouped";
  const view = unit.ref.id ? resolveRosterUnit(unit, ds, roster.faction_id) : undefined;
  if (!view) return "unit-unresolved";
  if (unit.wargear.some((w) => w.ref.id === null)) return "wargear-unresolved";
  if (unit.model_count <= 1) return "single-model";
  const models = ds.unitCompositionOf(view.raw)?.models;
  const recorded =
    !!models && models.length > 0 && models.every((m) => (m.default_weapon_ids?.length ?? 0) > 0);
  if (!recorded) return "no-recorded-defaults";
  return "solver-null";
}

/** Dataset-wide composition drift: default_weapon_ids a model can't actually
 * reach from the unit's `weapon_ids` or any wargear-option grant. */
function auditCompositionDrift(ds: Dataset): CompositionDrift[] {
  const out: CompositionDrift[] = [];
  for (const unit of ds.units.all) {
    const comp = ds.unitCompositionOf(unit.raw);
    if (!comp?.models?.length) continue;
    const reachable = new Set<string>(unit.raw.weapon_ids ?? []);
    for (const o of ds.wargearOptionsOf(unit.raw)) {
      for (const id of o.replacement ?? []) reachable.add(id);
      for (const group of o.replacement_choice ?? []) for (const id of group) reachable.add(id);
    }
    const unreachable = new Set<string>();
    for (const m of comp.models) {
      for (const id of m.default_weapon_ids ?? []) {
        if (!reachable.has(id)) unreachable.add(id);
      }
    }
    if (unreachable.size > 0) {
      out.push({
        faction: unit.raw.faction_id,
        unit_id: unit.id,
        unreachable: [...unreachable].sort(),
      });
    }
  }
  return out.sort(
    (a, b) => a.faction.localeCompare(b.faction) || a.unit_id.localeCompare(b.unit_id),
  );
}

export function auditAtcCorpus(opts: { rootDir?: string } = {}): AtcAuditReport {
  const root = opts.rootDir ?? DEFAULT_ROOT;
  const ds = Dataset.embedded();

  const corpus: AtcAuditReport["corpus"] = [];
  const parseFailures: AtcAuditReport["parse_failures"] = [];
  const warningsByCode = new Map<string, number>();
  const violationsByKey = new Map<string, number>();
  const violationsByCode = new Map<string, number>();
  const unresolvedByCode = new Map<string, Map<string, number>>();
  const solverNullUnits = new Map<string, number>();
  const groupingByOutcome = new Map<GroupingOutcome, number>(
    GROUPING_OUTCOMES.map((o) => [o, 0]),
  );

  let lists = 0;
  let listsWithViolations = 0;
  let violatingUnits = 0;

  for (const rel of CORPUS_FILES) {
    const path = resolve(root, rel);
    if (!existsSync(path)) {
      throw new Error(`corpus file missing: ${rel} (run from the repo root checkout)`);
    }
    const data = JSON.parse(readFileSync(path, "utf-8")) as CorpusFile;
    let fileLists = 0;
    let skipped = 0;

    for (const team of data.teams ?? []) {
      for (const player of team.players ?? []) {
        const text = player.armyListText;
        if (!text || !text.trim()) {
          skipped += 1;
          continue;
        }
        lists += 1;
        fileLists += 1;
        const faction = player.faction ?? "(unknown)";

        const res = tryImportRoster(text);
        if (!res.ok) {
          parseFailures.push({
            file: rel,
            list: listLabel(text),
            faction,
            reason: `${res.reason}: ${res.message}`,
          });
          continue;
        }
        const roster = res.roster;

        for (const w of roster.diagnostics.warnings) {
          bump(warningsByCode, w.code);
          if (w.raw_name) {
            const names = unresolvedByCode.get(w.code) ?? new Map<string, number>();
            bump(names, w.raw_name);
            unresolvedByCode.set(w.code, names);
          }
        }

        for (const unit of roster.units) {
          const outcome = classifyGrouping(unit, roster, ds);
          groupingByOutcome.set(outcome, (groupingByOutcome.get(outcome) ?? 0) + 1);
          if (outcome === "solver-null" && unit.ref.id) bump(solverNullUnits, unit.ref.id);
        }

        const legality = checkRosterLegality(roster, ds);
        let listViolated = false;
        for (const entry of legality) {
          if (entry.violations.length === 0) continue;
          violatingUnits += 1;
          listViolated = true;
          for (const v of entry.violations) {
            bump(violationsByKey, `${v.code}:${entry.unitId}`);
            bump(violationsByCode, v.code);
          }
        }
        if (listViolated) listsWithViolations += 1;
      }
    }
    corpus.push({ file: rel, lists: fileLists, skipped_no_text: skipped });
  }

  const compositionDrift = auditCompositionDrift(ds);

  return {
    generatedFrom: "tools/src/audit-atc.ts",
    corpus,
    headline: {
      lists,
      parse_failures: parseFailures.length,
      lists_with_violations: listsWithViolations,
      violating_units: violatingUnits,
      warnings_by_code: toRecord(warningsByCode),
      violations_by_code: toRecord(violationsByCode),
      grouping_by_outcome: Object.fromEntries(groupingByOutcome) as Record<
        GroupingOutcome,
        number
      >,
      composition_drift_units: compositionDrift.length,
    },
    parse_failures: parseFailures,
    violations: ranked(violationsByKey),
    unresolved_names: Object.fromEntries(
      [...unresolvedByCode.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([code, names]) => [code, ranked(names)]),
    ),
    solver_null_units: ranked(solverNullUnits),
    composition_drift: compositionDrift,
  };
}

// ─── Baseline check ──────────────────────────────────────────────────────

/**
 * Compare a fresh report's headline against the committed baseline; returns the
 * list of regressions (counts that increased — including codes/outcomes that
 * newly appeared). Decreases and disappearances are improvements, never flagged.
 */
export function findRegressions(baseline: AtcAuditReport, fresh: AtcAuditReport): string[] {
  const out: string[] = [];
  const scalar = (key: "parse_failures" | "violating_units" | "lists_with_violations") => {
    if (fresh.headline[key] > baseline.headline[key]) {
      out.push(`${key}: ${baseline.headline[key]} → ${fresh.headline[key]}`);
    }
  };
  scalar("parse_failures");
  scalar("violating_units");
  scalar("lists_with_violations");
  const table = (
    label: string,
    base: Record<string, number>,
    now: Record<string, number>,
    skip?: string,
  ) => {
    for (const [key, count] of Object.entries(now)) {
      if (key === skip) continue;
      const before = base[key] ?? 0;
      if (count > before) out.push(`${label}.${key}: ${before} → ${count}`);
    }
  };
  table("warnings", baseline.headline.warnings_by_code, fresh.headline.warnings_by_code);
  table("violations", baseline.headline.violations_by_code, fresh.headline.violations_by_code);
  table(
    "grouping",
    baseline.headline.grouping_by_outcome,
    fresh.headline.grouping_by_outcome,
    "grouped", // more grouped units is the goal, not a regression
  );
  if (fresh.headline.composition_drift_units > baseline.headline.composition_drift_units) {
    out.push(
      `composition_drift_units: ${baseline.headline.composition_drift_units} → ${fresh.headline.composition_drift_units}`,
    );
  }
  return out;
}

// ─── Markdown rendering ──────────────────────────────────────────────────

function countTable(rows: RankedCount[], keyHeader: string, limit?: number): string[] {
  const lines = [`| ${keyHeader} | count |`, "|---|--:|"];
  const shown = limit ? rows.slice(0, limit) : rows;
  for (const r of shown) lines.push(`| \`${r.key}\` | ${r.count} |`);
  if (limit && rows.length > limit) lines.push(`| … ${rows.length - limit} more | |`);
  return lines;
}

function renderMarkdown(report: AtcAuditReport): string {
  const h = report.headline;
  const lines: string[] = [];
  lines.push("# ATC-corpus legality audit");
  lines.push("");
  lines.push("Generated by `tools/src/audit-atc.ts` (`npm run audit:atc`).");
  lines.push("");
  lines.push(
    "Every ATC event list is run through `tryImportRoster`, `checkRosterLegality`, and",
    "the loadout-grouping classifier. The corpus is the accuracy baseline: violations",
    "should be rare and real — a `code:unitId` cluster across many independent players",
    "is a data or checker bug, not mass cheating.",
  );
  lines.push("");
  lines.push("## Headline");
  lines.push("");
  for (const c of report.corpus) {
    lines.push(`- \`${c.file}\`: ${c.lists} lists (${c.skipped_no_text} without text skipped)`);
  }
  lines.push(`- **Lists**: ${h.lists}, parse failures: ${h.parse_failures}`);
  lines.push(
    `- **Legality**: ${h.violating_units} violating units across ${h.lists_with_violations} lists`,
  );
  lines.push(`- **Composition drift**: ${h.composition_drift_units} dataset units`);
  lines.push("");
  lines.push("### Warnings by code");
  lines.push("");
  lines.push(
    ...countTable(
      Object.entries(h.warnings_by_code).map(([key, count]) => ({ key, count })),
      "code",
    ),
  );
  lines.push("");
  lines.push("### Loadout grouping by outcome");
  lines.push("");
  lines.push(
    ...countTable(
      Object.entries(h.grouping_by_outcome).map(([key, count]) => ({ key, count })),
      "outcome",
    ),
  );
  lines.push("");
  lines.push("## Legality violations (ranked `code:unitId`)");
  lines.push("");
  lines.push(...countTable(report.violations, "violation", 100));
  lines.push("");
  lines.push("## `solver-null` grouping failures (ranked unit)");
  lines.push("");
  lines.push(
    "Fully-resolved multi-model units with recorded defaults whose loadout the exact-",
    "partition solver could not decompose — bad `replaces` data or genuinely illegal lists.",
  );
  lines.push("");
  lines.push(...countTable(report.solver_null_units, "unit", 60));
  lines.push("");
  for (const [code, names] of Object.entries(report.unresolved_names)) {
    lines.push(`## Unresolved names: \`${code}\``);
    lines.push("");
    lines.push(...countTable(names, "raw name", 60));
    lines.push("");
  }
  lines.push("## Composition drift (dataset-wide)");
  lines.push("");
  lines.push(
    "Units whose composition `default_weapon_ids` reference ids unreachable from",
    "`weapon_ids` ∪ wargear-option grants (stale defaults under a newer loadout).",
  );
  lines.push("");
  for (const d of report.composition_drift) {
    lines.push(`- \`${d.faction}/${d.unit_id}\` — unreachable: ${d.unreachable.join(", ")}`);
  }
  lines.push("");
  if (report.parse_failures.length > 0) {
    lines.push("## Parse failures");
    lines.push("");
    for (const p of report.parse_failures) {
      lines.push(`- [${p.faction}] “${p.list}” (\`${p.file}\`) — ${p.reason}`);
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

// ─── CLI ────────────────────────────────────────────────────────────────

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]).replace(/\.\w+$/, "") ===
    fileURLToPath(import.meta.url).replace(/\.\w+$/, "");

if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npx tsx tools/src/audit-atc.ts [--dry-run | --check]");
    process.exit(0);
  }

  const report = auditAtcCorpus();
  const h = report.headline;
  const auditDir = resolve(DEFAULT_ROOT, "data/_audit");
  const jsonPath = join(auditDir, "atc-legality.json");

  console.log(`Lists: ${h.lists} (parse failures: ${h.parse_failures})`);
  console.log(
    `Violating units: ${h.violating_units} across ${h.lists_with_violations} lists`,
  );
  console.log(`Warnings: ${JSON.stringify(h.warnings_by_code)}`);
  console.log(`Grouping: ${JSON.stringify(h.grouping_by_outcome)}`);
  console.log(`Composition drift units: ${h.composition_drift_units}`);

  if (args.includes("--check")) {
    if (!existsSync(jsonPath)) {
      console.error(`\n--check: no committed baseline at ${jsonPath}; run without --check first.`);
      process.exit(1);
    }
    const baseline = JSON.parse(readFileSync(jsonPath, "utf-8")) as AtcAuditReport;
    const regressions = findRegressions(baseline, report);
    if (regressions.length > 0) {
      console.error("\n--check: headline counts regressed over the committed baseline:");
      for (const r of regressions) console.error(`  ${r}`);
      process.exit(1);
    }
    console.log("\n--check: no regressions over the committed baseline.");
  } else if (!args.includes("--dry-run")) {
    writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
    writeFileSync(join(auditDir, "atc-legality.md"), renderMarkdown(report));
    console.log(`\nWrote data/_audit/atc-legality.json and data/_audit/atc-legality.md`);
  } else {
    console.log("\n(dry-run; no files written)");
  }
}
