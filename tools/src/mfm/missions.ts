/**
 * missions.ts — reconcile mission scoring-card numeric/structural fields against
 * the GW MFM dump (the `missions` ingest subcommand).
 *
 * The dump models scoring relationally: a `*_mission` row has ordered
 * `*_mission_objective`s, each with ordered `*_mission_objective_scoring` rows
 * carrying `victoryPoints`, `victoryPointsCap`, `isCumulative`,
 * `isMutuallyExclusive`, and (secondary only) a `scoringType`
 * (standard/fixed/tactical). The repo models the same cards in
 * `data/core/secondary-cards.json` as an `awards[]` array of DSL-triggered VP
 * blocks. This ingest pulls the dump-authoritative numbers into those awards.
 *
 * MATCH: both `card_type:"secondary"` (all 18 dump `secondary_mission`s) and
 * `card_type:"primary"` (the 25 generic `primary_mission`s — those with no
 * `detachmentId`; the detachment-scoped primaries are crusade/narrative reskins
 * the repo doesn't carry, so they're excluded). Repo id == `nameToId(en-name)`,
 * which already strips apostrophes, so "Destroyer's Wrath" → `destroyers-wrath`
 * with no alias table needed.
 *
 * APPLIED from the dump (numeric/structural only — never prose):
 *   - vp / vp_per ← `victoryPoints` (the award's existing form is preserved).
 *   - vp_max     ← `victoryPointsCap` (set when present; removed when the dump
 *                  has no cap, so a stale repo ceiling can't survive). Primary
 *                  scoring rows carry no cap, so primaries never gain one.
 *   - cumulative ← `isCumulative` (added when true, removed when false).
 *   - exclusive_group: ADDITIVE GUARD. Scoring rows under one objective+mode
 *     where any row is `isMutuallyExclusive` form one "score the highest, not the
 *     sum" group. If such awards already carry an (authored) group key it is left
 *     untouched; a missing key is filled with a derived one. An existing key the
 *     dump does NOT corroborate is reported for review, never removed
 *     (additive-not-destructive — removing one would change scoring to summing).
 *
 * SHAPE GUARD: awards are aligned to rows per scoring track (mode), in array
 * order. If a card's award count and dump row count differ within any track, the
 * alignment is ambiguous, so the whole card is left untouched and reported as a
 * shape mismatch (e.g. the repo splits a tier into more/fewer awards than the
 * dump prints).
 *
 * Like every MFM subcommand, mutations are applied in BOTH dry-run and write
 * modes and routed through {@link applyWrites}, which validates the projected
 * dataset (AJV + integrity) and only persists on --write — a clean dry run
 * guarantees a clean write.
 */
import * as fs from "fs";
import * as path from "path";
import { nameToId } from "../converters/id-generator.js";
import { formatCompact } from "../compact-json.js";
import { MfmDump, REPO_ROOT, type DumpRow } from "./loader.js";
import type { StagedWrite } from "./apply.js";

const CORE_DIR = path.join(REPO_ROOT, "data", "core");
const CARDS_PATH = path.join(CORE_DIR, "secondary-cards.json");

/** Scoring-track tag on an award; `undefined` is the flat "scores either way" track. */
export type AwardMode = "fixed" | "tactical" | undefined;

/** One dump scoring row, flattened with its parent objective and resolved mode. */
export interface DumpScoring {
  mode: AwardMode;
  vp: number;
  cap: number | null;
  cumulative: boolean;
  mutex: boolean;
  /** Stable per-card key for the parent mission-objective (its displayOrder). */
  objKey: string;
}

interface Award {
  vp?: number;
  vp_per?: number;
  per?: string;
  vp_max?: number;
  cumulative?: boolean;
  exclusive_group?: string;
  mode?: "fixed" | "tactical";
  [k: string]: unknown;
}
interface Card {
  id: string;
  card_type?: "secondary" | "primary";
  awards?: Award[];
  [k: string]: unknown;
}

interface ScoringRow extends DumpRow {
  scoringType?: string;
  victoryPoints: number;
  victoryPointsCap?: number | null;
  isCumulative?: boolean;
  isMutuallyExclusive?: boolean;
  displayOrder?: number;
}
interface ObjectiveRow extends DumpRow {
  displayOrder?: number;
}

function readJson<T>(p: string): T[] {
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as T[]) : [];
}

const byDisplayOrder = (a: { displayOrder?: number }, b: { displayOrder?: number }): number =>
  (a.displayOrder ?? 0) - (b.displayOrder ?? 0);

/** Secondary rows carry a scoringType; primary rows are all the flat track. */
function modeFromScoringType(st: string | undefined): AwardMode {
  if (st === "fixed") return "fixed";
  if (st === "tactical") return "tactical";
  return undefined; // "standard" or absent
}

const modeKey = (m: AwardMode): string => m ?? "none";

interface AssembleConfig {
  mission: string;
  objective: string;
  scoring: string;
  missionFk: string;
  objectiveFk: string;
}
const SECONDARY_CFG: AssembleConfig = {
  mission: "secondary_mission",
  objective: "secondary_mission_objective",
  scoring: "secondary_mission_objective_scoring",
  missionFk: "secondaryMissionId",
  objectiveFk: "secondaryMissionObjectiveId",
};
const PRIMARY_CFG: AssembleConfig = {
  mission: "primary_mission",
  objective: "primary_mission_objective",
  scoring: "primary_mission_objective_scoring",
  missionFk: "primaryMissionId",
  objectiveFk: "primaryMissionObjectiveId",
};

function assembleInto(out: Map<string, DumpScoring[]>, dump: MfmDump, cfg: AssembleConfig, kind: "secondary" | "primary"): void {
  const objByMission = dump.groupBy<ObjectiveRow>(cfg.objective, cfg.missionFk);
  const scoreByObj = dump.groupBy<ScoringRow>(cfg.scoring, cfg.objectiveFk);
  for (const m of dump.table(cfg.mission)) {
    // Detachment-scoped primaries are crusade/narrative reskins the repo omits.
    if (kind === "primary" && (m as { detachmentId?: string | null }).detachmentId) continue;
    const name = dump.enName(m);
    if (!name || !m.id) continue;
    let id: string;
    try {
      id = nameToId(name);
    } catch {
      continue;
    }
    const objs = [...(objByMission.get(m.id) ?? [])].sort(byDisplayOrder);
    const rows: DumpScoring[] = [];
    for (const o of objs) {
      const scores = [...(scoreByObj.get(o.id!) ?? [])].sort(byDisplayOrder);
      for (const s of scores) {
        rows.push({
          mode: modeFromScoringType(s.scoringType),
          vp: s.victoryPoints,
          cap: s.victoryPointsCap ?? null,
          cumulative: !!s.isCumulative,
          mutex: !!s.isMutuallyExclusive,
          objKey: String(o.displayOrder ?? o.id),
        });
      }
    }
    if (rows.length) out.set(id, rows);
  }
}

/** repo card-id → ordered dump scoring rows, for both secondary and generic primary missions. */
export function buildMissionScoringCanon(dump: MfmDump): Map<string, DumpScoring[]> {
  const out = new Map<string, DumpScoring[]>();
  assembleInto(out, dump, SECONDARY_CFG, "secondary");
  assembleInto(out, dump, PRIMARY_CFG, "primary");
  return out;
}

export interface AwardChange {
  cardId: string;
  index: number;
  field: "vp" | "vp_per" | "vp_max" | "cumulative" | "exclusive_group";
  from: unknown;
  to: unknown;
}

export interface CardReconcileResult {
  changes: AwardChange[];
  /** Per-track award/row count mismatch — when present, the card was left untouched. */
  shapeMismatch?: { mode: string; repo: number; dump: number }[];
  /** Awards carrying a group the dump does not corroborate (reported, not removed). */
  exclusiveReview: { index: number; key: string }[];
}

/** Derived exclusive-group key for an objective+mode the dump marks mutually exclusive. */
function exclusiveKey(cardId: string, mode: string, objKey: string): string {
  const base = mode === "none" ? cardId : `${cardId}-${mode}`;
  return `${base}-grp${objKey}`;
}

/**
 * Reconcile one card's awards against its dump rows, mutating the card in place.
 * Pure w.r.t. the dump (no I/O) so it is directly unit-testable. Returns the
 * field-level changes, any shape mismatch (in which case nothing was mutated),
 * and exclusive-group review items.
 */
export function reconcileCard(card: Card, rows: DumpScoring[]): CardReconcileResult {
  const awards = card.awards ?? [];

  const awByMode = new Map<string, { a: Award; idx: number }[]>();
  awards.forEach((a, idx) => {
    const k = modeKey(a.mode);
    (awByMode.get(k) ?? awByMode.set(k, []).get(k)!).push({ a, idx });
  });
  const rowByMode = new Map<string, DumpScoring[]>();
  rows.forEach((r) => {
    const k = modeKey(r.mode);
    (rowByMode.get(k) ?? rowByMode.set(k, []).get(k)!).push(r);
  });

  const shapeMismatch: { mode: string; repo: number; dump: number }[] = [];
  for (const k of new Set([...awByMode.keys(), ...rowByMode.keys()])) {
    const repo = awByMode.get(k)?.length ?? 0;
    const dumpN = rowByMode.get(k)?.length ?? 0;
    if (repo !== dumpN) shapeMismatch.push({ mode: k, repo, dump: dumpN });
  }
  if (shapeMismatch.length) return { changes: [], shapeMismatch, exclusiveReview: [] };

  const changes: AwardChange[] = [];
  const exclusiveReview: { index: number; key: string }[] = [];
  for (const [k, list] of awByMode) {
    const rws = rowByMode.get(k)!;
    // objectives (within this track) that the dump marks mutually exclusive
    const exclObjs = new Set(rws.filter((r) => r.mutex).map((r) => r.objKey));
    list.forEach(({ a, idx }, i) => {
      const r = rws[i];

      // vp / vp_per — keep the authored form, only update the number.
      if (a.vp != null && a.vp !== r.vp) {
        changes.push({ cardId: card.id, index: idx, field: "vp", from: a.vp, to: r.vp });
        a.vp = r.vp;
      } else if (a.vp_per != null && a.vp_per !== r.vp) {
        changes.push({ cardId: card.id, index: idx, field: "vp_per", from: a.vp_per, to: r.vp });
        a.vp_per = r.vp;
      }

      // vp_max — set when the dump caps; remove when it doesn't.
      const curMax = a.vp_max ?? null;
      if (curMax !== r.cap) {
        changes.push({ cardId: card.id, index: idx, field: "vp_max", from: curMax, to: r.cap });
        if (r.cap == null) delete a.vp_max;
        else a.vp_max = r.cap;
      }

      // cumulative — add true / drop false (matches the omit-when-false convention).
      const curCum = !!a.cumulative;
      if (curCum !== r.cumulative) {
        changes.push({ cardId: card.id, index: idx, field: "cumulative", from: curCum, to: r.cumulative });
        if (r.cumulative) a.cumulative = true;
        else delete a.cumulative;
      }

      // exclusive_group — additive guard. Fill a missing key; never overwrite or
      // remove an authored one. A key the dump doesn't corroborate is flagged.
      const dumpExclusive = exclObjs.has(r.objKey);
      if (dumpExclusive && a.exclusive_group == null) {
        const key = exclusiveKey(card.id, k, r.objKey);
        changes.push({ cardId: card.id, index: idx, field: "exclusive_group", from: null, to: key });
        a.exclusive_group = key;
      } else if (!dumpExclusive && a.exclusive_group != null) {
        exclusiveReview.push({ index: idx, key: a.exclusive_group });
      }
    });
  }
  return { changes, exclusiveReview };
}

export interface MissionsReport {
  matched: number;
  cardsChanged: number;
  vpChanged: AwardChange[];
  vpMaxChanged: AwardChange[];
  cumulativeChanged: AwardChange[];
  exclusiveAdded: AwardChange[];
  exclusiveReview: { cardId: string; index: number; key: string }[];
  shapeMismatch: { cardId: string; details: { mode: string; repo: number; dump: number }[] }[];
  /** Dump card-ids (in canon) with no repo card — none expected. */
  dumpOnly: string[];
  /** Repo cards with no dump canon — none expected (would signal a rename). */
  repoOnly: string[];
  /** Detachment-scoped primary missions excluded by design (crusade/narrative reskins). */
  primaryReskinsExcluded: number;
  staged: StagedWrite[];
}

export function runMissions(dump: MfmDump, _write: boolean): MissionsReport {
  const canon = buildMissionScoringCanon(dump);
  const cards = readJson<Card>(CARDS_PATH);

  const report: MissionsReport = {
    matched: 0,
    cardsChanged: 0,
    vpChanged: [],
    vpMaxChanged: [],
    cumulativeChanged: [],
    exclusiveAdded: [],
    exclusiveReview: [],
    shapeMismatch: [],
    dumpOnly: [],
    repoOnly: [],
    primaryReskinsExcluded: dump
      .table<{ detachmentId?: string | null }>("primary_mission")
      .filter((m) => !!m.detachmentId).length,
    staged: [],
  };

  const matchedIds = new Set<string>();
  let dirty = false;
  for (const card of cards) {
    const rows = canon.get(card.id);
    if (!rows) {
      report.repoOnly.push(card.id);
      continue;
    }
    matchedIds.add(card.id);
    report.matched++;

    const res = reconcileCard(card, rows);
    if (res.shapeMismatch) {
      report.shapeMismatch.push({ cardId: card.id, details: res.shapeMismatch });
      continue;
    }
    for (const c of res.changes) {
      if (c.field === "vp" || c.field === "vp_per") report.vpChanged.push(c);
      else if (c.field === "vp_max") report.vpMaxChanged.push(c);
      else if (c.field === "cumulative") report.cumulativeChanged.push(c);
      else if (c.field === "exclusive_group") report.exclusiveAdded.push(c);
    }
    for (const r of res.exclusiveReview)
      report.exclusiveReview.push({ cardId: card.id, index: r.index, key: r.key });
    if (res.changes.length) {
      report.cardsChanged++;
      dirty = true;
    }
  }

  report.dumpOnly = [...canon.keys()].filter((id) => !matchedIds.has(id)).sort();
  // Persist in the file's hand-authored compact style so the diff is only the
  // changed values, not a full reflow.
  if (dirty) report.staged.push({ path: CARDS_PATH, value: cards, text: formatCompact(cards) });
  return report;
}

export function buildMissionsReport(report: MissionsReport, write: boolean): string {
  const L: string[] = [];
  L.push(`# MFM missions — ${write ? "APPLIED" : "DRY RUN"}`);
  L.push("");
  L.push("Reconciles mission scoring-card numbers (vp/vp_per, vp_max, cumulative) from the");
  L.push("GW MFM dump for both secondary cards and the 25 generic primary missions.");
  L.push("`exclusive_group` is an additive guard (filled only when missing). Primary");
  L.push("`vp_per_game_cap`/`vp_per_round_cap` are NOT reconciled — the dump carries no");
  L.push("per-mission cap (those are mission-pack-global rules). Prose is never touched.");
  L.push("");
  L.push("| Metric | Count |");
  L.push("|---|--:|");
  L.push(`| Cards matched | ${report.matched} |`);
  L.push(`| Cards changed | ${report.cardsChanged} |`);
  L.push(`| vp / vp_per changes | ${report.vpChanged.length} |`);
  L.push(`| vp_max changes | ${report.vpMaxChanged.length} |`);
  L.push(`| cumulative changes | ${report.cumulativeChanged.length} |`);
  L.push(`| exclusive_group added | ${report.exclusiveAdded.length} |`);
  L.push(`| exclusive_group review (dump-uncorroborated) | ${report.exclusiveReview.length} |`);
  L.push(`| Shape mismatches (skipped) | ${report.shapeMismatch.length} |`);
  L.push(`| Repo cards with no dump match | ${report.repoOnly.length} |`);
  L.push(`| Dump cards with no repo match | ${report.dumpOnly.length} |`);
  L.push(`| Primary reskins excluded (by design) | ${report.primaryReskinsExcluded} |`);
  L.push("");

  const list = (title: string, items: AwardChange[]) => {
    if (!items.length) return;
    L.push(`## ${title}`, "");
    for (const c of items) L.push(`- ${c.cardId}[${c.index}] ${c.field}: ${fmt(c.from)} → ${fmt(c.to)}`);
    L.push("");
  };
  list("vp / vp_per changes", report.vpChanged);
  list("vp_max changes", report.vpMaxChanged);
  list("cumulative changes", report.cumulativeChanged);
  list("exclusive_group added (additive guard)", report.exclusiveAdded);

  if (report.exclusiveReview.length) {
    L.push("## exclusive_group — repo key not corroborated by the dump (review, NOT changed)", "");
    for (const r of report.exclusiveReview) L.push(`- ${r.cardId}[${r.index}] keeps "${r.key}"`);
    L.push("");
  }
  if (report.shapeMismatch.length) {
    L.push("## Shape mismatches — award/row counts differ, card left untouched", "");
    for (const s of report.shapeMismatch)
      L.push(`- ${s.cardId}: ${s.details.map((d) => `${d.mode} repo ${d.repo} vs dump ${d.dump}`).join(", ")}`);
    L.push("");
  }
  if (report.repoOnly.length) {
    L.push("## Repo cards with no dump match (possible rename)", "");
    report.repoOnly.forEach((id) => L.push(`- ${id}`));
    L.push("");
  }
  return L.join("\n") + "\n";
}

function fmt(v: unknown): string {
  return v == null ? "—" : String(v);
}
