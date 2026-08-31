/**
 * seed-detachments.ts — create source-backed skeleton detachments that the GW
 * MFM dump defines but the repo has not authored yet.
 *
 * Matched-play detachments are seeded by default so downstream disposition,
 * detachment-field, and enhancement passes can enrich them in the same ordered
 * ingest. Combat Patrol detachments remain opt-in via
 * `--include-combat-patrol`; their cost-0 enhancements are seeded alongside the
 * parent because the matched-play enhancement producer intentionally excludes
 * them.
 *
 * Values come from the same dump fields as the reconcilers:
 *   - detachment id      = nameToId(name)
 *   - detachment_points  = detachmentPointsCost (+ per-faction override)
 *   - force_dispositions = detachment_force_disposition → disposition slug
 *   - CP enhancement id  = detachmentScopedId(name, detachment name)
 *
 * IP: reads only numeric, identity, and localized entity-name fields. It never
 * dereferences GW rules or lore prose.
 */
import * as path from "path";
import { nameToId, detachmentScopedId } from "../converters/id-generator.js";
import {
  MfmDump,
  type DetachmentRow,
  type EnhancementRow,
  type DetachmentForceDispositionRow,
} from "./loader.js";
import { readJsonArray, CORE_DIR } from "./repo-files.js";
import { repoDirForFactionName, repoDirs } from "./faction-map.js";
import { buildCanon, dispositionIdMap } from "./dispositions.js";
import type { StagedWrite } from "./apply.js";
import { acceptedGapIds } from "./accepted-gaps.js";

const CONFIRMED = { edition: "11th", dataslate: "launch" } as const;
/** Combat-Patrol-only entities carry this so the golden files them on the
 *  combat-patrol coverage dimension instead of inflating competitive gaps. */
const COMBAT_PATROL_ONLY: readonly string[] = ["combat-patrol"];

interface SeedDetachment {
  id: string;
  external_refs: { namespace: string; id: string }[];
  name: string;
  faction_id: string;
  enhancement_ids: string[];
  game_version: { edition: string; dataslate: string };
  game_modes?: string[];
  detachment_points: number;
  force_dispositions: string[];
}

interface SeedEnhancement {
  id: string;
  external_refs: { namespace: string; id: string }[];
  name: string;
  detachment_id: string;
  cost: number;
  is_unique: boolean;
  game_version: { edition: string; dataslate: string };
  game_modes: string[];
  points_provisional: boolean;
}

interface IdRecord {
  id: string;
  [k: string]: unknown;
}

export interface SeedDetachmentsOptions {
  onlyDir?: string;
  includeCombatPatrol?: boolean;
}

export interface DirSeedDetResult {
  dir: string;
  createdDetachments: { id: string; name: string }[];
  createdEnhancements: { id: string; name: string }[];
  /** CP detachments held back because --include-combat-patrol was not passed. */
  cpExcluded: { id: string; name: string }[];
  /** CP detachments/enhancements already present in the repo (idempotent skip). */
  skipped: { id: string; reason: string }[];
}

export interface SeedDetachmentsReport {
  dirs: DirSeedDetResult[];
  staged: StagedWrite[];
}

function detachmentsPath(dir: string): string {
  return path.join(CORE_DIR, dir, "detachments.json");
}
function enhancementsPath(dir: string): string {
  return path.join(CORE_DIR, dir, "enhancements.json");
}

/** One dump CP detachment resolved to its dir + derived skeleton facts. */
export interface CandidateDet {
  dir: string;
  source_id: string;
  id: string;
  name: string;
  dp: number;
  disposition: string;
  combatPatrol: boolean;
  enhancements: SeedEnhancement[];
}

/**
 * Resolve every supported detachment in the dump to a repo directory and its
 * source-backed skeleton facts. Unsupported faction directories are ignored;
 * incomplete rows for supported factions fail loudly.
 */
export function collectSeedDetachments(dump: MfmDump): CandidateDet[] {
  const { overrideBySlugDir } = buildCanon(dump);
  const dispOf = dispositionIdMap(dump);
  const detDisp = dump.groupBy("detachment_force_disposition", "detachmentId");
  const knownDirs = repoDirs();

  // Combat Patrol enhancements are seeded with their parent. Matched-play
  // enhancements are authored by the richer enhancement producer after the
  // parent detachment exists.
  const enhByDet = new Map<string, EnhancementRow[]>();
  for (const e of dump.table("enhancement")) {
    if (!e.isCombatPatrol) continue;
    (
      enhByDet.get(e.detachmentId) ??
      enhByDet.set(e.detachmentId, []).get(e.detachmentId)!
    ).push(e);
  }

  const out: CandidateDet[] = [];
  for (const det of dump.table("detachment")) {
    if (!det.id) continue;
    const name = dump.enName(det);
    if (!name) throw new Error(`detachment <${det.id}> has no English name`);
    const id = nameToId(name);
    const applicableDirs = new Set<string>();
    for (const edge of dump.children(
      "detachment_faction_keyword.detachmentId",
      det.id,
    )) {
      const label = dump.enName(
        dump.byId("faction_keyword").get(edge.factionKeywordId),
      );
      const dir = repoDirForFactionName(label);
      if (dir && knownDirs.has(dir)) applicableDirs.add(dir);
    }
    if (applicableDirs.size === 0) {
      const fkId = dump.factionKeywordOfDetachment(det.id);
      const fkName = fkId
        ? dump.enName(dump.byId("faction_keyword").get(fkId))
        : undefined;
      const ownedDir = repoDirForFactionName(fkName);
      if (ownedDir && knownDirs.has(ownedDir)) applicableDirs.add(ownedDir);
    }
    if (applicableDirs.size === 0) {
      if (det.isCombatPatrol) {
        throw new Error(
          `Combat Patrol detachment "${name}" has no supported faction directory`,
        );
      }
      continue;
    }

    const dispUuid = detDisp.get(det.id)?.[0]?.forceDispositionId;
    const disposition = dispUuid ? dispOf.get(dispUuid) : undefined;
    if (!disposition)
      throw new Error(
        `detachment "${name}" has no force disposition in the dump`,
      );

    const enhancements: SeedEnhancement[] = [];
    for (const e of enhByDet.get(det.id) ?? []) {
      const en = dump.enName(e);
      if (!en)
        throw new Error(
          `CP enhancement <${e.id}> of "${name}" has no English name`,
        );
      // Seed the RAW GW name + id (keep any trailing " (Upgrade)"/" (Aura)" tag) —
      // the import-correct canon, matching the golden (enhIdsByDir) and buildEnhCanon.
      const enhId = detachmentScopedId(en, name);
      enhancements.push({
        id: enhId,
        name: en,
        external_refs: [{ namespace: "mfm", id: e.id! }],
        detachment_id: id,
        cost: 0,
        is_unique: true,
        game_version: { ...CONFIRMED },
        game_modes: [...COMBAT_PATROL_ONLY],
        points_provisional: false,
      });
    }
    enhancements.sort((a, b) => a.id.localeCompare(b.id));
    for (const dir of [...applicableDirs].sort()) {
      const dp =
        overrideBySlugDir.get(`${id}@@${dir}`) ?? det.detachmentPointsCost;
      if (dp == null) {
        throw new Error(
          `detachment "${name}" has no detachment_points for ${dir}`,
        );
      }
      out.push({
        source_id: det.id,
        dir,
        id,
        name,
        dp,
        disposition,
        enhancements,
        combatPatrol: det.isCombatPatrol,
      });
    }
  }
  return out;
}

export function runSeedDetachments(
  dump: MfmDump,
  opts: SeedDetachmentsOptions = {},
): SeedDetachmentsReport {
  const { onlyDir, includeCombatPatrol = false } = opts;
  const candidates = collectSeedDetachments(dump);

  // dir → mutated detachment/enhancement arrays (loaded once, appended in place).
  const detsByDir = new Map<string, IdRecord[]>();
  const enhsByDir = new Map<string, IdRecord[]>();
  const loadDets = (dir: string): IdRecord[] => {
    let a = detsByDir.get(dir);
    if (!a)
      detsByDir.set(dir, (a = readJsonArray<IdRecord>(detachmentsPath(dir))));
    return a;
  };
  const loadEnhs = (dir: string): IdRecord[] => {
    let a = enhsByDir.get(dir);
    if (!a)
      enhsByDir.set(dir, (a = readJsonArray<IdRecord>(enhancementsPath(dir))));
    return a;
  };

  const resultByDir = new Map<string, DirSeedDetResult>();
  const result = (dir: string): DirSeedDetResult => {
    let r = resultByDir.get(dir);
    if (!r) {
      resultByDir.set(
        dir,
        (r = {
          dir,
          createdDetachments: [],
          createdEnhancements: [],
          cpExcluded: [],
          skipped: [],
        }),
      );
    }
    return r;
  };
  const touchedDets = new Set<string>();
  const touchedEnhs = new Set<string>();
  const acceptedDetachmentsByDir = new Map<string, ReadonlySet<string>>();

  for (const c of candidates.sort(
    (a, b) => a.dir.localeCompare(b.dir) || a.id.localeCompare(b.id),
  )) {
    if (onlyDir && c.dir !== onlyDir) continue;
    const res = result(c.dir);
    let acceptedDetachments = acceptedDetachmentsByDir.get(c.dir);
    if (!acceptedDetachments) {
      acceptedDetachments = acceptedGapIds("detachments", c.dir);
      acceptedDetachmentsByDir.set(c.dir, acceptedDetachments);
    }
    if (acceptedDetachments.has(c.id)) {
      res.skipped.push({
        id: c.id,
        reason: `detachment "${c.id}" is an accepted MFM gap in ${c.dir}`,
      });
      continue;
    }

    const dets = loadDets(c.dir);

    // Existing rows are enriched by subsequent ordered passes.
    if (dets.some((d) => d.id === c.id)) {
      res.skipped.push({
        id: c.id,
        reason: `detachment "${c.id}" already in ${c.dir}`,
      });
      continue;
    }
    if (c.combatPatrol && !includeCombatPatrol) {
      res.cpExcluded.push({ id: c.id, name: c.name });
      continue;
    }

    const enhs = loadEnhs(c.dir);
    const enhIds = new Set(enhs.map((e) => e.id));
    const enhancementIds: string[] = [];
    for (const enh of c.enhancements) {
      enhancementIds.push(enh.id);
      if (enhIds.has(enh.id)) {
        res.skipped.push({
          id: enh.id,
          reason: `enhancement "${enh.id}" already in ${c.dir}`,
        });
        continue;
      }
      enhs.push(enh as unknown as IdRecord);
      enhIds.add(enh.id);
      touchedEnhs.add(c.dir);
      res.createdEnhancements.push({ id: enh.id, name: enh.name });
    }

    const detachment: SeedDetachment = {
      id: c.id,
      external_refs: [{ namespace: "mfm", id: c.source_id }],
      name: c.name,
      faction_id: c.dir,
      enhancement_ids: enhancementIds,
      game_version: { ...CONFIRMED },
      detachment_points: c.dp,
      force_dispositions: [c.disposition],
    };
    if (c.combatPatrol) detachment.game_modes = [...COMBAT_PATROL_ONLY];
    dets.push(detachment as unknown as IdRecord);
    touchedDets.add(c.dir);
    res.createdDetachments.push({ id: c.id, name: c.name });
  }

  const staged: StagedWrite[] = [];
  for (const dir of [...touchedDets].sort())
    staged.push({ path: detachmentsPath(dir), value: detsByDir.get(dir) });
  for (const dir of [...touchedEnhs].sort())
    staged.push({ path: enhancementsPath(dir), value: enhsByDir.get(dir) });

  return {
    dirs: [...resultByDir.values()].sort((a, b) => a.dir.localeCompare(b.dir)),
    staged,
  };
}

export function buildSeedDetachmentsReport(
  report: SeedDetachmentsReport,
  write: boolean,
): string {
  const { dirs } = report;
  const L: string[] = [];
  L.push(`# MFM seed-detachments — ${write ? "APPLIED" : "DRY RUN"}`);
  L.push("");
  L.push(
    "Source-backed matched-play detachment skeletons are created by default.",
  );
  L.push("Combat Patrol parents and their cost-0 enhancements remain opt-in.");
  L.push("");
  L.push(
    "| Dir | Detachments created | Enhancements created | Held back (CP) | Skipped (exist) |",
  );
  L.push("| --- | --- | --- | --- | --- |");
  for (const d of dirs) {
    L.push(
      `| ${d.dir} | ${d.createdDetachments.length} | ${d.createdEnhancements.length} | ${d.cpExcluded.length} | ${d.skipped.length} |`,
    );
  }
  const sum = (f: (d: DirSeedDetResult) => number): number =>
    dirs.reduce((a, d) => a + f(d), 0);
  L.push("");
  L.push(
    `Total: ${sum((d) => d.createdDetachments.length)} detachment(s), ` +
      `${sum((d) => d.createdEnhancements.length)} enhancement(s) created; ` +
      `${sum((d) => d.cpExcluded.length)} held back; ${sum((d) => d.skipped.length)} skipped.`,
  );
  L.push("");
  for (const d of dirs) {
    if (!d.createdDetachments.length && !d.cpExcluded.length) continue;
    L.push(`## ${d.dir}`);
    for (const c of d.createdDetachments)
      L.push(`- created detachment \`${c.id}\` (${c.name})`);
    for (const c of d.createdEnhancements)
      L.push(`  - enhancement \`${c.id}\` (${c.name})`);
    for (const c of d.cpExcluded) L.push(`- held back \`${c.id}\` (${c.name})`);
    L.push("");
  }
  return L.join("\n") + "\n";
}
