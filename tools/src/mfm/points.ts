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
 *   - A shared-roster TWIN (a chapter section's reprint of a parent-dir unit,
 *     e.g. Blood Angels' Assault Intercessors) prices the same datasheet for
 *     its own army. Where its table differs from the reconciled native one,
 *     it also feeds `allied_points`, keyed by the twin's home faction dir —
 *     see {@link routeChapterTwin}. Identically-priced twins (exclude-and-
 *     replace reprints) contribute nothing.
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
import { MfmDump, type DatasheetRow,
type UnitCompositionRow,
type UnitCompositionMiniatureRow,
type DatasheetPointsStepRow, } from "./loader.js";
import { readJsonArray, CORE_DIR } from "./repo-files.js";
import { repoDirForFactionName, repoDirs } from "./faction-map.js";
import { candidateDirs, homeScore } from "./wargear.js";
import type { StagedWrite } from "./apply.js";


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
    dump.groupBy("unit_composition", "datasheetId").get(datasheetId) ?? []
  )
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder);
  const miniByComp = dump.groupBy("unit_composition_miniature", "unitCompositionId");
  const step = dump.groupBy("datasheet_points_step", "datasheetId")
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

/**
 * Route a chapter twin's derived native tiers into a unit's `allied_points`.
 *
 * The MFM prints a chapter section's copy of a shared Space Marine datasheet
 * with the chapter's OWN price table (Blood Angels' Assault Intercessors cost
 * more than the generic entry; four chapters run the Repulsor Executioner
 * cheaper). The repo holds the unit once, in the shared parent roster, so a
 * reprint's tiers are host-army pricing — the same concept as
 * referenceGrouping (Imperium) compositions — keyed by the twin's home
 * faction dir.
 *
 * Returns the unit's next `allied_points`: this host's entries replaced by
 * the twin's tiers, every other host untouched. A twin that prices
 * identically to the reconciled native table (an exclude-and-replace twin,
 * not a reprice) contributes nothing and clears stale entries for its host.
 * Twin tiers at sizes the native table doesn't price (optional-attachment
 * builds) are dropped, mirroring the native-ranges trust rule.
 */
export function routeChapterTwin(
  rec: Pick<UnitRecord, "points" | "allied_points">,
  host: string,
  twinNative: Tier[]
): AlliedTier[] {
  const nativeRanges = new Set(
    (rec.points ?? []).map((t) => `${t.models}:${t.models_max ?? t.models}`)
  );
  const clean = twinNative
    .map(cleanTier)
    .filter((t) => nativeRanges.has(`${t.models}:${t.models_max ?? t.models}`));
  const others = (rec.allied_points ?? []).filter((a) => a.host_faction !== host);
  if (!clean.length || normNative(clean) === normNative(rec.points ?? [])) return others;
  return [...others, ...clean.map((t) => ({ ...t, host_faction: host }))];
}

/** The datasheet's own home faction dir (`blood-angels` for a BA reprint), or null. */
function homeDir(dump: MfmDump, ds: DatasheetRow): string | null {
  const pub = dump.byId("publication").get(ds.publicationId);
  const name = pub?.factionKeywordId
    ? dump.enName(dump.byId("faction_keyword").get(pub.factionKeywordId))
    : undefined;
  return repoDirForFactionName(name);
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
  for (const ds of dump.table("datasheet")) {
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
    const units = readJsonArray<UnitRecord>(p);
    const byId = new Map(units.map((u) => [u.id, u]));
    const res: DirPointsResult = {
      dir,
      matched: 0,
      pointsChanged: [],
      alliedAdded: [],
      ambiguousSkipped: [],
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
      const rec = byId.get(id);
      if (!rec) continue; // not in this dir — may still match in another candidate dir
      if (matchedRepoIds.has(id)) {
        // Shared-roster TWIN of an already-priced unit: a chapter section's
        // reprint of a parent-dir datasheet. Where the reprint carries its own
        // price table (Blood Angels' Assault Intercessors cost more than the
        // generic Space Marines entry), that table is host-army pricing for
        // the twin's home faction — route it to `allied_points` instead of
        // dropping it (the old behaviour, which silently lost every chapter
        // reprice).
        const host = homeDir(dump, ds);
        if (!host || host === dir) continue;
        const twin = deriveDatasheet(dump, ds.id!);
        // Underivable twin (ambiguous / priceless): leave existing entries
        // for this host alone rather than guessing or wiping them.
        if (twin.ambiguous || !twin.native.length) continue;
        const next = routeChapterTwin(rec, host, twin.native);
        if (normAllied(rec.allied_points) !== normAllied(next)) {
          res.alliedAdded.push({
            id,
            allied: next.filter((a) => a.host_faction === host),
          });
        }
        if (next.length) rec.allied_points = next;
        else delete rec.allied_points;
        continue;
      }
      matchedRepoIds.add(id);
      matchedDatasheets.add(ds.id!);
      res.matched++;
      const { native, allied, ambiguous } = deriveDatasheet(dump, ds.id!);
      if (!native.length) continue; // no dump price (e.g. data-only datasheet)

      if (ambiguous) {
        res.ambiguousSkipped.push(id);
        continue; // multiple same-size base comps differ in cost — can't pick
      }

      // Composition rows and their points are the authoritative matched-play
      // size contract. The previous model-count envelope guard preserved stale
      // repo tiers whenever the dump introduced an intermediate composition
      // (for example 20 Gretchin + 1 Runtherd). Apply every unambiguous native
      // tier; `composition-tiers` subsequently synchronizes `model_count` and
      // the per-miniature envelopes from the same source rows.

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
  for (const ds of dump.table("datasheet")) {
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
    "| Dir | Matched | Points changed | Allied added | Ambiguous (kept) | Repo-only (Legends/FW) |"
  );
  L.push("|---|--:|--:|--:|--:|--:|");
  for (const d of dirs.filter((d) => d.matched || d.repoOnly.length)) {
    L.push(
      `| ${d.dir} | ${d.matched} | ${d.pointsChanged.length} | ${d.alliedAdded.length} | ${d.ambiguousSkipped.length} | ${d.repoOnly.length} |`
    );
  }
  L.push(
    `| **TOTAL** | **${sum((d) => d.matched)}** | **${sum((d) => d.pointsChanged.length)}** | **${sum((d) => d.alliedAdded.length)}** | **${sum((d) => d.ambiguousSkipped.length)}** | **${sum((d) => d.repoOnly.length)}** |`
  );
  L.push("");
  for (const d of dirs) {
    if (
      !d.pointsChanged.length &&
      !d.alliedAdded.length &&
      !d.ambiguousSkipped.length
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
