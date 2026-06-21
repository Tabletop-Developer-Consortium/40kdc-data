/**
 * points.ts — Phase 4: reconcile unit point costs against the GW MFM dump.
 *
 * Derivation per datasheet:
 *   - A unit_composition's tier size = Σ of its unit_composition_miniature `max`;
 *     its cost = composition.points.
 *   - datasheet_points_step {stepAt:N, stepPoints:P} is PER-ARMY-ORDINAL pricing:
 *     "from your Nth copy onward, add P to every tier" → expands to the schema's
 *     unit_count_min/max bands (verified to reproduce the MFM banded pricing).
 *   - Compositions tagged with a referenceGroupingKeywordId (only "Imperium" today)
 *     are ALLIED prices — the unit's cost when included in a host army of that
 *     faction — and feed `allied_points`, keyed by host_faction. The untagged
 *     (native) compositions feed `points`.
 *
 * Matching is PER FACTION: the same unit name has a separate datasheet per faction
 * (Chaos Spawn costs differently in each Chaos army), so a datasheet is matched to
 * the repo unit in its own faction dir — never globally.
 *
 * Ambiguity guard: a few datasheets carry multiple native compositions at the same
 * model count with different points (different default builds, e.g. Bladeguard 80/85).
 * The dump can't tell us which is the matched-play cost, and the repo's confirmed
 * value is always one of them — so such units are LEFT UNTOUCHED and reported, never
 * overwritten with an arbitrary pick.
 */
import * as fs from "fs";
import * as path from "path";
import { nameToId } from "../converters/id-generator.js";
import {
  MfmDump,
  REPO_ROOT,
  type DatasheetRow,
  type PublicationRow,
  type UnitCompositionRow,
  type UnitCompositionMiniatureRow,
  type DatasheetPointsStepRow,
} from "./loader.js";
import { repoDirForFactionName, repoDirs } from "./faction-map.js";
import type { StagedWrite } from "./apply.js";

const CORE_DIR = path.join(REPO_ROOT, "data", "core");
const CONFIRMED = { edition: "11th", dataslate: "launch" };

export interface Tier {
  models: number;
  cost: number;
  unit_count_min?: number;
  unit_count_max?: number | null;
}
export interface AlliedTier extends Tier {
  host_faction: string;
}
interface UnitRecord {
  id: string;
  name: string;
  points?: Tier[];
  allied_points?: AlliedTier[];
  points_provisional?: boolean;
  game_version?: { edition: string; dataslate: string };
  [k: string]: unknown;
}

export interface Derived {
  native: Tier[];
  allied: AlliedTier[];
  ambiguous: boolean;
}

function readJson<T>(p: string): T[] {
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as T[]) : [];
}

/** Expand base (models→cost) tiers by a single ordinal step, if present. */
function applyStep<T extends Tier>(
  base: { models: number; cost: number }[],
  step: DatasheetPointsStepRow | undefined,
  extra: (t: Tier) => T
): T[] {
  if (!step) return base.map((b) => extra({ models: b.models, cost: b.cost }));
  return [
    ...base.map((b) =>
      extra({ models: b.models, cost: b.cost, unit_count_min: 1, unit_count_max: step.stepAt - 1 })
    ),
    ...base.map((b) =>
      extra({
        models: b.models,
        cost: b.cost + step.stepPoints,
        unit_count_min: step.stepAt,
        unit_count_max: null,
      })
    ),
  ];
}

/** Derive native + allied tiers for one datasheet from the dump. */
export function deriveDatasheet(dump: MfmDump, datasheetId: string): Derived {
  const comps = (
    dump.groupBy<UnitCompositionRow>("unit_composition", "datasheetId").get(datasheetId) ?? []
  )
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder);
  const miniByComp = dump.groupBy<UnitCompositionMiniatureRow>(
    "unit_composition_miniature",
    "unitCompositionId"
  );
  const step = dump
    .groupBy<DatasheetPointsStepRow>("datasheet_points_step", "datasheetId")
    .get(datasheetId)?.[0];

  const sizeOf = (compId: string) =>
    (miniByComp.get(compId) ?? []).reduce((n, m) => n + m.max, 0);

  // Native (untagged) base tiers, de-duplicated on (models, cost).
  const nativeSeen = new Set<string>();
  const nativeBase: { models: number; cost: number }[] = [];
  const byModel = new Map<number, Set<number>>();
  for (const c of comps) {
    if (c.referenceGroupingKeywordId || c.points == null) continue;
    const models = sizeOf(c.id!);
    const cost = c.points;
    (byModel.get(models) ?? byModel.set(models, new Set()).get(models)!).add(cost);
    const k = `${models}:${cost}`;
    if (!nativeSeen.has(k)) {
      nativeSeen.add(k);
      nativeBase.push({ models, cost });
    }
  }
  // Ambiguous: a model count priced more than one way by distinct native comps.
  const ambiguous = [...byModel.values()].some((costs) => costs.size > 1);

  // Allied (grouped) tiers, keyed by host faction keyword.
  const alliedBaseByHost = new Map<string, { models: number; cost: number }[]>();
  for (const c of comps) {
    if (!c.referenceGroupingKeywordId || c.points == null) continue;
    const kwName = dump.enName(dump.byId("keyword").get(c.referenceGroupingKeywordId));
    if (!kwName) continue;
    let host: string;
    try {
      host = nameToId(kwName);
    } catch {
      continue;
    }
    const arr = alliedBaseByHost.get(host) ?? alliedBaseByHost.set(host, []).get(host)!;
    const models = sizeOf(c.id!);
    if (!arr.some((b) => b.models === models && b.cost === c.points))
      arr.push({ models, cost: c.points });
  }

  const native = applyStep(nativeBase, step, (t) => t);
  const allied: AlliedTier[] = [];
  for (const [host, base] of alliedBaseByHost) {
    allied.push(...applyStep(base, step, (t) => ({ ...t, host_faction: host })));
  }
  return { native, allied, ambiguous };
}

/** Strip band keys when absent, to keep the simple case clean (mirrors MFM applyUnit). */
export function cleanTier<T extends Tier>(t: T): T {
  if (t.unit_count_min === undefined) {
    const { unit_count_min, unit_count_max, ...rest } = t;
    return rest as T;
  }
  return { ...t, unit_count_max: t.unit_count_max ?? null };
}

function normNative(ts: Tier[] = []): string {
  return JSON.stringify(
    ts
      .map((t) => [t.models, t.cost, t.unit_count_min ?? null, t.unit_count_max ?? null])
      .sort((a, b) => a[0]! - b[0]! || (a[2] ?? 0)! - (b[2] ?? 0)! || a[1]! - b[1]!)
  );
}
function normAllied(ts: AlliedTier[] = []): string {
  return JSON.stringify(
    ts
      .map((t) => [t.host_faction, t.models, t.cost, t.unit_count_min ?? null, t.unit_count_max ?? null])
      .sort()
  );
}

export interface DirPointsResult {
  dir: string;
  matched: number;
  pointsChanged: { id: string; from: Tier[]; to: Tier[] }[];
  alliedAdded: { id: string; allied: AlliedTier[] }[];
  ambiguousSkipped: string[];
  /** Derived size-set differs from repo (choice-based comps, or a genuine size add) — needs review. */
  structureSkipped: { id: string; repo: number[]; derived: number[] }[];
  repoOnly: string[]; // repo unit absent from dump (Legends/FW → BSData)
}
export interface PointsReport {
  dirs: DirPointsResult[];
  newInDump: { dir: string; id: string }[];
  staged: StagedWrite[];
}

export function runPoints(dump: MfmDump, write: boolean): PointsReport {
  const dirs = new Set(repoDirs());
  const pubFk = dump.byId<PublicationRow>("publication");
  const fkName = dump.byId("faction_keyword");

  // datasheet → repo dir (per faction), live (non-Legends) only.
  const byDir = new Map<string, DatasheetRow[]>();
  for (const ds of dump.table<DatasheetRow>("datasheet")) {
    if (ds.isLegends) continue;
    const fkId = pubFk.get(ds.publicationId)?.factionKeywordId ?? null;
    const dir = repoDirForFactionName(fkId ? dump.enName(fkName.get(fkId)) : undefined);
    if (!dir || !dirs.has(dir)) continue;
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(ds);
  }

  const results: DirPointsResult[] = [];
  const staged: StagedWrite[] = [];
  const newInDump: { dir: string; id: string }[] = [];

  for (const dir of [...dirs].sort()) {
    const p = path.join(CORE_DIR, dir, "units.json");
    if (!fs.existsSync(p)) continue;
    const units = readJson<UnitRecord>(p);
    const byId = new Map(units.map((u) => [u.id, u]));
    const res: DirPointsResult = {
      dir,
      matched: 0,
      pointsChanged: [],
      alliedAdded: [],
      ambiguousSkipped: [],
      structureSkipped: [],
      repoOnly: [],
    };
    const matchedRepoIds = new Set<string>();

    for (const ds of byDir.get(dir) ?? []) {
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
        newInDump.push({ dir, id });
        continue;
      }
      matchedRepoIds.add(id);
      res.matched++;
      const { native, allied, ambiguous } = deriveDatasheet(dump, ds.id!);
      if (!native.length) continue; // no dump price (e.g. data-only datasheet)

      if (ambiguous) {
        res.ambiguousSkipped.push(id);
        continue; // multiple same-size base comps differ in cost — can't pick
      }

      // Model count isn't reliably derivable for choice-based compositions
      // (Σ of miniature max overcounts mutually-exclusive model choices). Only
      // reconcile when the derived size set matches the repo's known-good sizes;
      // that covers all cost/band corrections safely. Genuine size additions
      // (and the over/undercount cases) are reported for manual review instead.
      const repoSizes = new Set((rec.points ?? []).map((t) => t.models));
      const derivedSizes = new Set(native.map((t) => t.models));
      const sizesMatch =
        repoSizes.size > 0 &&
        repoSizes.size === derivedSizes.size &&
        [...derivedSizes].every((s) => repoSizes.has(s));
      if (!sizesMatch) {
        res.structureSkipped.push({
          id,
          repo: [...repoSizes].sort((a, b) => a - b),
          derived: [...derivedSizes].sort((a, b) => a - b),
        });
        continue;
      }

      const nativeClean = native.map(cleanTier);
      // Allied tiers are trusted only at sizes the repo already knows.
      const alliedClean = allied.map(cleanTier).filter((a) => repoSizes.has(a.models));
      if (normNative(rec.points) !== normNative(nativeClean)) {
        res.pointsChanged.push({ id, from: rec.points ?? [], to: nativeClean });
      }
      if (alliedClean.length && normAllied(rec.allied_points) !== normAllied(alliedClean)) {
        res.alliedAdded.push({ id, allied: alliedClean });
      }
      // Mutate in-memory in BOTH modes; the dry-run rehearsal validates the result.
      rec.points = nativeClean;
      if (alliedClean.length) rec.allied_points = alliedClean;
      rec.points_provisional = false;
      if (rec.game_version) {
        rec.game_version.edition = CONFIRMED.edition;
        rec.game_version.dataslate = CONFIRMED.dataslate;
      }
    }

    for (const u of units) if (!matchedRepoIds.has(u.id)) res.repoOnly.push(u.id);
    res.repoOnly.sort();
    // Stage every processed dir unconditionally — matching the prior `--write`
    // semantics, which rewrote units.json for each dir regardless of a tracked diff
    // (the provisional/game_version bumps above are not counter-tracked). A byte
    // -identical rewrite is a no-op to jj; applyWrites validates before persisting.
    staged.push({ path: p, value: units });
    results.push(res);
  }
  return { dirs: results, newInDump, staged };
}

export function buildPointsReport(report: PointsReport, write: boolean): string {
  const { dirs, newInDump } = report;
  const sum = (f: (d: DirPointsResult) => number) => dirs.reduce((a, d) => a + f(d), 0);
  const fmt = (t: Tier[]) =>
    t.length
      ? t
          .map((x) =>
            x.unit_count_min === undefined
              ? `${x.models}m=${x.cost}`
              : `${x.models}m=${x.cost}[#${x.unit_count_min}-${x.unit_count_max ?? "+"}]`
          )
          .join(", ")
      : "(none)";
  const L: string[] = [];
  L.push(`# MFM unit points — ${write ? "APPLIED" : "DRY RUN"}`);
  L.push("");
  L.push("Per-faction reconciliation of `points` (+ `allied_points` for host-army pricing).");
  L.push("Ambiguous units (multiple same-size base comps) are preserved, not overwritten.");
  L.push("");
  L.push(
    "| Dir | Matched | Points changed | Allied added | Ambiguous (kept) | Structure (review) | Repo-only (Legends/FW) |"
  );
  L.push("|---|--:|--:|--:|--:|--:|--:|");
  for (const d of dirs.filter((d) => d.matched || d.repoOnly.length)) {
    L.push(
      `| ${d.dir} | ${d.matched} | ${d.pointsChanged.length} | ${d.alliedAdded.length} | ${d.ambiguousSkipped.length} | ${d.structureSkipped.length} | ${d.repoOnly.length} |`
    );
  }
  L.push(
    `| **TOTAL** | **${sum((d) => d.matched)}** | **${sum((d) => d.pointsChanged.length)}** | **${sum((d) => d.alliedAdded.length)}** | **${sum((d) => d.ambiguousSkipped.length)}** | **${sum((d) => d.structureSkipped.length)}** | **${sum((d) => d.repoOnly.length)}** |`
  );
  L.push("");
  for (const d of dirs) {
    if (
      !d.pointsChanged.length &&
      !d.alliedAdded.length &&
      !d.ambiguousSkipped.length &&
      !d.structureSkipped.length
    )
      continue;
    L.push(`## ${d.dir}`);
    if (d.pointsChanged.length) {
      L.push("", "**Points changes** (old → new):");
      d.pointsChanged.forEach((c) => L.push(`- ${c.id}: ${fmt(c.from)} → ${fmt(c.to)}`));
    }
    if (d.alliedAdded.length) {
      L.push("", "**Allied pricing added:**");
      d.alliedAdded.forEach((c) =>
        L.push(`- ${c.id}: ${c.allied.map((a) => `${a.host_faction}:${a.models}m=${a.cost}`).join(", ")}`)
      );
    }
    if (d.ambiguousSkipped.length) {
      L.push("", "**Ambiguous (multiple same-size base comps — kept repo value):**");
      d.ambiguousSkipped.forEach((id) => L.push(`- ${id}`));
    }
    if (d.structureSkipped.length) {
      L.push("", "**Size structure differs — review (kept repo value):**");
      d.structureSkipped.forEach((c) =>
        L.push(`- ${c.id}: repo sizes [${c.repo.join(", ")}] vs dump [${c.derived.join(", ")}]`)
      );
    }
    L.push("");
  }
  if (newInDump.length) {
    L.push(`## New units in dump (no repo entity — author in a follow-up): ${newInDump.length}`);
    L.push("");
    newInDump.slice(0, 200).forEach((n) => L.push(`- ${n.dir}/${n.id}`));
    if (newInDump.length > 200) L.push(`- …and ${newInDump.length - 200} more`);
    L.push("");
  }
  return L.join("\n") + "\n";
}
