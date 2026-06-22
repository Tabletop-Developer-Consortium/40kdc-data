/**
 * dispositions.ts — Phase 2: reconcile detachment force-dispositions and
 * detachment-point costs against the GW MFM dump.
 *
 * The repo already carries provisional `force_dispositions` + `detachment_points`
 * on every detachment (authored pre-launch at dataslate "pre-launch-provisional").
 * This pass treats the dump as authoritative: it compares each repo detachment to
 * the dump's value, reports diffs, corrects them on --write, and stamps the
 * confirmed launch dataslate.
 *
 * Dump shape:
 *   force_disposition                 5 rows; UUID → name → repo disposition id
 *   detachment.detachmentPointsCost   base DP (1–3)
 *   detachment_force_disposition      detachment UUID → disposition UUID (1:1)
 *   detachment_faction_detachment_points_cost   per-faction DP override (rare)
 *
 * Repo detachments are duplicated per chapter dir, which lets us honor a
 * per-faction DP override dir-by-dir (e.g. Stormlance Task Force costs 2 for some
 * chapters, 3 otherwise).
 */
import * as fs from "fs";
import * as path from "path";
import { nameToId } from "../converters/id-generator.js";
import {
  MfmDump,
  REPO_ROOT,
  type DetachmentRow,
  type DetachmentForceDispositionRow,
  type DetachmentFactionDpCostRow,
  type ForceDispositionRow,
} from "./loader.js";
import { repoDirForFactionName, repoDirs } from "./faction-map.js";
import type { StagedWrite } from "./apply.js";

const CORE_DIR = path.join(REPO_ROOT, "data", "core");

interface DetRecord {
  id: string;
  name: string;
  faction_id: string;
  detachment_points?: number | null;
  force_dispositions?: string[];
  game_version?: { edition: string; dataslate: string };
  [k: string]: unknown;
}

interface Canon {
  dp: number | null;
  disposition: string | null;
}

export interface DirDispResult {
  dir: string;
  matched: number;
  dpChanged: { id: string; from: number | null | undefined; to: number | null }[];
  dispChanged: { id: string; from: string[]; to: string[] }[];
  unmatchedRepo: string[]; // repo detachment id absent from the dump
}

export interface DispReport {
  dirs: DirDispResult[];
  newInDump: string[]; // dump detachment slugs with no repo entity anywhere
  cpExcluded: string[]; // CP-only dump slugs held back from newInDump (default)
  staged: StagedWrite[];
}

function readJson<T>(p: string): T[] {
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as T[]) : [];
}

/** UUID → repo disposition id (nameToId of the English name). */
export function dispositionIdMap(dump: MfmDump): Map<string, string> {
  const m = new Map<string, string>();
  for (const fd of dump.table<ForceDispositionRow>("force_disposition")) {
    const n = dump.enName(fd);
    if (fd.id && n) m.set(fd.id, nameToId(n));
  }
  return m;
}

/**
 * Build the canon lookups: detachment slug → base {dp, disposition}, and a
 * per-(slug, dir) DP override map. Returns the set of slugs the dump defines.
 */
export function buildCanon(dump: MfmDump): {
  bySlug: Map<string, Canon>;
  overrideBySlugDir: Map<string, number>;
} {
  const dispOf = dispositionIdMap(dump);
  const detDisp = dump.groupBy<DetachmentForceDispositionRow>(
    "detachment_force_disposition",
    "detachmentId"
  );
  const bySlug = new Map<string, Canon>();
  const uuidToSlug = new Map<string, string>();
  for (const det of dump.table<DetachmentRow>("detachment")) {
    const name = dump.enName(det);
    if (!det.id || !name) continue;
    let slug: string;
    try {
      slug = nameToId(name);
    } catch {
      continue;
    }
    uuidToSlug.set(det.id, slug);
    const dispUuid = detDisp.get(det.id)?.[0]?.forceDispositionId;
    bySlug.set(slug, {
      dp: det.detachmentPointsCost,
      disposition: dispUuid ? (dispOf.get(dispUuid) ?? null) : null,
    });
  }

  // Per-faction DP overrides → keyed by `${slug}@@${dir}`.
  const overrideBySlugDir = new Map<string, number>();
  for (const row of dump.table<DetachmentFactionDpCostRow>(
    "detachment_faction_detachment_points_cost"
  )) {
    const slug = uuidToSlug.get(row.detachmentId);
    const fkName = dump.enName(dump.byId("faction_keyword").get(row.factionKeywordId));
    const dir = repoDirForFactionName(fkName);
    if (slug && dir) overrideBySlugDir.set(`${slug}@@${dir}`, row.detachmentPointsCost);
  }
  return { bySlug, overrideBySlugDir };
}

/**
 * Slugs of the dump's Combat-Patrol-box detachments. These are detachments the
 * repo intentionally does not author (mirroring how `seed-units` holds back
 * Combat-Patrol datasheets), so they are filtered out of `newInDump` by default.
 * Slugged exactly as `buildCanon` slugs detachment names so the ids line up.
 */
export function combatPatrolDetSlugs(dump: MfmDump): Set<string> {
  const slugs = new Set<string>();
  for (const det of dump.table<DetachmentRow>("detachment")) {
    if (!det.isCombatPatrol) continue;
    const name = dump.enName(det);
    if (!name) continue;
    try {
      slugs.add(nameToId(name));
    } catch {
      continue;
    }
  }
  return slugs;
}

function dispEqual(a: string[] = [], b: string[] = []): boolean {
  return a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
}

export function runDispositions(
  dump: MfmDump,
  write: boolean,
  opts: { includeCombatPatrol?: boolean } = {}
): DispReport {
  const { bySlug, overrideBySlugDir } = buildCanon(dump);
  const matchedSlugs = new Set<string>();
  const dirs: DirDispResult[] = [];
  const staged: StagedWrite[] = [];

  for (const dir of [...repoDirs()].sort()) {
    const p = path.join(CORE_DIR, dir, "detachments.json");
    if (!fs.existsSync(p)) continue;
    const dets = readJson<DetRecord>(p);
    const res: DirDispResult = {
      dir,
      matched: 0,
      dpChanged: [],
      dispChanged: [],
      unmatchedRepo: [],
    };
    for (const det of dets) {
      const canon = bySlug.get(det.id);
      if (!canon) {
        res.unmatchedRepo.push(det.id);
        continue;
      }
      matchedSlugs.add(det.id);
      res.matched++;
      const targetDp = overrideBySlugDir.get(`${det.id}@@${dir}`) ?? canon.dp;
      const targetDisp = canon.disposition ? [canon.disposition] : [];

      if (det.detachment_points !== targetDp) {
        res.dpChanged.push({ id: det.id, from: det.detachment_points, to: targetDp });
      }
      if (!dispEqual(det.force_dispositions, targetDisp)) {
        res.dispChanged.push({
          id: det.id,
          from: det.force_dispositions ?? [],
          to: targetDisp,
        });
      }
      // Reconcile only the two fields the dump is authoritative for here, in BOTH
      // modes (the dry-run rehearsal validates the result). The detachment's
      // game_version dataslate is left untouched — bumping it to "launch" would
      // over-claim, since its rule/enhancement/stratagem references aren't
      // reconciled until later phases.
      det.detachment_points = targetDp;
      det.force_dispositions = targetDisp;
    }
    staged.push({ path: p, value: dets });
    dirs.push(res);
  }

  const unmatched = [...bySlug.keys()].filter((s) => !matchedSlugs.has(s));
  const cp = combatPatrolDetSlugs(dump);
  const cpExcluded: string[] = [];
  const newInDump: string[] = [];
  for (const s of unmatched) {
    if (!opts.includeCombatPatrol && cp.has(s)) cpExcluded.push(s);
    else newInDump.push(s);
  }
  newInDump.sort();
  cpExcluded.sort();
  return { dirs, newInDump, cpExcluded, staged };
}

export function buildDispReport(report: DispReport, write: boolean): string {
  const { dirs, newInDump, cpExcluded } = report;
  const sum = (f: (d: DirDispResult) => number) => dirs.reduce((a, d) => a + f(d), 0);
  const L: string[] = [];
  L.push(`# MFM dispositions + detachment points — ${write ? "APPLIED" : "DRY RUN"}`);
  L.push("");
  L.push("Reconciles `force_dispositions` and `detachment_points` against the dump.");
  L.push("Only those two fields change; `game_version` is left for a later confirm pass.");
  L.push("");
  L.push("| Dir | Matched | DP changed | Disposition changed | Repo-only (not in dump) |");
  L.push("|---|--:|--:|--:|--:|");
  for (const d of dirs.filter((d) => d.matched || d.unmatchedRepo.length)) {
    L.push(
      `| ${d.dir} | ${d.matched} | ${d.dpChanged.length} | ${d.dispChanged.length} | ${d.unmatchedRepo.length} |`
    );
  }
  L.push(
    `| **TOTAL** | **${sum((d) => d.matched)}** | **${sum((d) => d.dpChanged.length)}** | **${sum((d) => d.dispChanged.length)}** | **${sum((d) => d.unmatchedRepo.length)}** |`
  );
  L.push("");
  for (const d of dirs) {
    if (!d.dpChanged.length && !d.dispChanged.length && !d.unmatchedRepo.length) continue;
    L.push(`## ${d.dir}`);
    if (d.dpChanged.length) {
      L.push("", "**Detachment-point changes** (old → new):");
      d.dpChanged.forEach((c) => L.push(`- ${c.id}: ${c.from ?? "∅"} → ${c.to ?? "∅"}`));
    }
    if (d.dispChanged.length) {
      L.push("", "**Disposition changes** (old → new):");
      d.dispChanged.forEach((c) =>
        L.push(`- ${c.id}: [${c.from.join(", ")}] → [${c.to.join(", ")}]`)
      );
    }
    if (d.unmatchedRepo.length) {
      L.push("", "**Repo detachments absent from dump** (left provisional):");
      d.unmatchedRepo.forEach((id) => L.push(`- ${id}`));
    }
    L.push("");
  }
  if (newInDump.length) {
    L.push("## New detachments in dump (no repo entity — author in a follow-up)");
    L.push("");
    newInDump.forEach((s) => L.push(`- ${s}`));
    L.push("");
  }
  if (cpExcluded.length) {
    L.push(
      `## Combat-Patrol detachments held back (${cpExcluded.length} — pass --include-combat-patrol to author)`
    );
    L.push("");
    cpExcluded.forEach((s) => L.push(`- ${s}`));
    L.push("");
  }
  return L.join("\n") + "\n";
}
