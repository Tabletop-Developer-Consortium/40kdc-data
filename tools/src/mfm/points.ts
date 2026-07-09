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
  type UnitCompositionRow,
  type UnitCompositionMiniatureRow,
  type DatasheetPointsStepRow,
} from "./loader.js";
import { repoDirs } from "./faction-map.js";
import { candidateDirs, homeScore } from "./wargear.js";
import type { StagedWrite } from "./apply.js";

const CORE_DIR = path.join(REPO_ROOT, "data", "core");
const CONFIRMED = { edition: "11th", dataslate: "launch" };

export interface Tier {
  models: number;
  /**
   * Inclusive upper model count for a range-priced tier (GW block pricing, e.g.
   * Venatari Custodians are 4–6 models for 320). `models` is the range floor;
   * every size in [models, models_max] costs `cost`. Absent (undefined) for a
   * single-size tier, where the tier prices exactly `models` models.
   */
  models_max?: number;
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
  model_count?: { min: number; max: number };
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

/** A derived base tier: a model-count *range* [models, models_max] at one cost. */
interface BaseTier {
  models: number;
  models_max: number;
  cost: number;
}

/** Expand base (range→cost) tiers by a single ordinal step, if present. */
function applyStep<T extends Tier>(
  base: BaseTier[],
  step: DatasheetPointsStepRow | undefined,
  extra: (t: Tier) => T
): T[] {
  if (!step)
    return base.map((b) => extra({ models: b.models, models_max: b.models_max, cost: b.cost }));
  return [
    ...base.map((b) =>
      extra({
        models: b.models,
        models_max: b.models_max,
        cost: b.cost,
        unit_count_min: 1,
        unit_count_max: step.stepAt - 1,
      })
    ),
    ...base.map((b) =>
      extra({
        models: b.models,
        models_max: b.models_max,
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

  // A composition prices a model-count *range* [Σmin, Σmax] over its miniature
  // rows (GW block pricing — e.g. Venatari's second build option is 4–6 models
  // for a flat 320). `models` is the range floor, `models_max` the ceiling.
  const rangeOf = (compId: string) => {
    const rows = miniByComp.get(compId) ?? [];
    return {
      min: rows.reduce((n, m) => n + m.min, 0),
      max: rows.reduce((n, m) => n + m.max, 0),
    };
  };

  // Native (untagged) base tiers, de-duplicated on (min, max, cost).
  const nativeSeen = new Set<string>();
  const nativeBase: BaseTier[] = [];
  for (const c of comps) {
    if (c.referenceGroupingKeywordId || c.points == null) continue;
    const { min, max } = rangeOf(c.id!);
    if (max <= 0) continue; // no model rows (data-only / attachment-at-0) — no size
    const cost = c.points;
    const k = `${min}:${max}:${cost}`;
    if (!nativeSeen.has(k)) {
      nativeSeen.add(k);
      nativeBase.push({ models: min, models_max: max, cost });
    }
  }
  // Ambiguous: two distinct native tiers whose model-count ranges overlap but
  // disagree on cost, so a squad of the shared size has no single price. This is
  // the choice-based / optional-attachment shape (e.g. Outrider Squad's Invader
  // ATV builds, per-build wargear prices) the flat `points` array can't model —
  // leave such datasheets untouched rather than guess a price.
  const ambiguous = nativeBase.some((a, i) =>
    nativeBase.some(
      (b, j) => i < j && a.cost !== b.cost && a.models <= b.models_max && b.models <= a.models_max
    )
  );

  // Allied (grouped) tiers, keyed by host faction keyword.
  const alliedBaseByHost = new Map<string, BaseTier[]>();
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
    const { min, max } = rangeOf(c.id!);
    if (max <= 0) continue;
    if (!arr.some((b) => b.models === min && b.models_max === max && b.cost === c.points))
      arr.push({ models: min, models_max: max, cost: c.points });
  }

  const native = applyStep(nativeBase, step, (t) => t);
  const allied: AlliedTier[] = [];
  for (const [host, base] of alliedBaseByHost) {
    allied.push(...applyStep(base, step, (t) => ({ ...t, host_faction: host })));
  }
  return { native, allied, ambiguous };
}

/**
 * Strip absent optional keys to keep the simple case clean (mirrors MFM
 * applyUnit): band keys when unbanded, and `models_max` when the tier prices a
 * single size (models_max == models).
 */
export function cleanTier<T extends Tier>(t: T): T {
  let out: T = t;
  if (out.models_max === out.models) {
    const { models_max, ...rest } = out;
    out = rest as T;
  }
  if (out.unit_count_min === undefined) {
    const { unit_count_min, unit_count_max, ...rest } = out;
    return rest as T;
  }
  return { ...out, unit_count_max: out.unit_count_max ?? null };
}

function normNative(ts: Tier[] = []): string {
  return JSON.stringify(
    ts
      .map((t) => [
        t.models,
        t.models_max ?? t.models,
        t.cost,
        t.unit_count_min ?? null,
        t.unit_count_max ?? null,
      ])
      .sort((a, b) => a[0]! - b[0]! || (a[3] ?? 0)! - (b[3] ?? 0)! || a[2]! - b[2]!)
  );
}
function normAllied(ts: AlliedTier[] = []): string {
  return JSON.stringify(
    ts
      .map((t) => [
        t.host_faction,
        t.models,
        t.models_max ?? t.models,
        t.cost,
        t.unit_count_min ?? null,
        t.unit_count_max ?? null,
      ])
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

  // datasheet → candidate repo dirs (its own faction dir PLUS any shared-roster
  // parent), live (non-Legends) only. A Space Marine chapter datasheet (Blood
  // Angels' Death Company) has no chapter-dir units.json — its unit lives in the
  // shared `adeptus-astartes` roster — so, exactly like composition-tiers, points
  // must be allowed to match it in the parent dir. Matching on the home dir alone
  // (the old behaviour) left every chapter unit's `points` un-reconciled, which is
  // how the range-tier regression survived for Death Company, Sanguinary Guard,
  // Ravenwing, Thunderwolf Cavalry, Deathwatch Veterans, etc.
  const byDir = new Map<string, DatasheetRow[]>();
  for (const ds of dump.table<DatasheetRow>("datasheet")) {
    if (ds.isLegends) continue;
    for (const dir of candidateDirs(dump, ds)) {
      if (!dirs.has(dir)) continue;
      (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(ds);
    }
  }

  const results: DirPointsResult[] = [];
  const staged: StagedWrite[] = [];
  const matchedDatasheets = new Set<string>(); // ds.id that found a repo unit somewhere

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

    // Home-faction datasheets before shared-roster imports, so a unit is priced
    // from its own datasheet where it has one; the matched-set guard keeps the
    // first (home) match and ignores the parent-dir duplicate.
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
      if (matchedRepoIds.has(id)) continue;
      const rec = byId.get(id);
      if (!rec) continue; // not in this dir — may still match in another candidate dir
      matchedRepoIds.add(id);
      matchedDatasheets.add(ds.id!);
      res.matched++;
      const { native, allied, ambiguous } = deriveDatasheet(dump, ds.id!);
      if (!native.length) continue; // no dump price (e.g. data-only datasheet)

      if (ambiguous) {
        res.ambiguousSkipped.push(id);
        continue; // multiple same-size base comps differ in cost — can't pick
      }

      // Model count isn't reliably derivable for choice-based compositions
      // (Σ of miniature max overcounts mutually-exclusive model choices). Only
      // reconcile when the derived size *envelope* — floor of the smallest tier
      // to ceiling of the largest — matches the unit's known-good model_count.
      // That admits range-priced tiers (whose floor differs from the old
      // max-keyed size) while still punting genuine over/undercount cases for
      // manual review. Records without a model_count fall back to the size-set
      // match (all single-size in practice, so floor == ceiling == the size).
      const derivedMin = Math.min(...native.map((t) => t.models));
      const derivedMax = Math.max(...native.map((t) => t.models_max ?? t.models));
      const mc = rec.model_count;
      const repoSizes = new Set((rec.points ?? []).map((t) => t.models_max ?? t.models));
      const derivedSizes = new Set(native.map((t) => t.models_max ?? t.models));
      const structureMatch = mc
        ? mc.min === derivedMin && mc.max === derivedMax
        : repoSizes.size > 0 &&
          repoSizes.size === derivedSizes.size &&
          [...derivedSizes].every((s) => repoSizes.has(s));
      if (!structureMatch) {
        res.structureSkipped.push({
          id,
          repo: mc ? [mc.min, mc.max] : [...repoSizes].sort((a, b) => a - b),
          derived: mc ? [derivedMin, derivedMax] : [...derivedSizes].sort((a, b) => a - b),
        });
        continue;
      }

      const nativeClean = native.map(cleanTier);
      // Allied tiers are trusted only at ranges the native derivation produced.
      const nativeRanges = new Set(native.map((t) => `${t.models}:${t.models_max ?? t.models}`));
      const alliedClean = allied
        .map(cleanTier)
        .filter((a) => nativeRanges.has(`${a.models}:${a.models_max ?? a.models}`));
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

  // A live datasheet with candidate dirs that matched no repo unit anywhere is
  // genuinely new (a seed-units candidate), reported once against its home dir.
  const newInDump: { dir: string; id: string }[] = [];
  const seenNew = new Set<string>();
  for (const ds of dump.table<DatasheetRow>("datasheet")) {
    if (ds.isLegends || matchedDatasheets.has(ds.id!) || seenNew.has(ds.id!)) continue;
    const cands = candidateDirs(dump, ds).filter((d) => dirs.has(d));
    if (!cands.length) continue;
    const name = dump.enName(ds);
    if (!name) continue;
    try {
      nameToId(name);
    } catch {
      continue;
    }
    seenNew.add(ds.id!);
    newInDump.push({ dir: cands[0], id: nameToId(name) });
  }
  return { dirs: results, newInDump, staged };
}

export function buildPointsReport(report: PointsReport, write: boolean): string {
  const { dirs, newInDump } = report;
  const sum = (f: (d: DirPointsResult) => number) => dirs.reduce((a, d) => a + f(d), 0);
  const size = (x: Tier) =>
    x.models_max != null && x.models_max !== x.models ? `${x.models}-${x.models_max}` : `${x.models}`;
  const fmt = (t: Tier[]) =>
    t.length
      ? t
          .map((x) =>
            x.unit_count_min === undefined
              ? `${size(x)}m=${x.cost}`
              : `${size(x)}m=${x.cost}[#${x.unit_count_min}-${x.unit_count_max ?? "+"}]`
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
        L.push(`- ${c.id}: ${c.allied.map((a) => `${a.host_faction}:${size(a)}m=${a.cost}`).join(", ")}`)
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
