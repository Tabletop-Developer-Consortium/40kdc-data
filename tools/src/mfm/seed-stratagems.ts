/**
 * seed-stratagems.ts — create repo stratagem entities for dump stratagems that have
 * no repo entity yet (the "unseeded" competitive set).
 *
 * Structural fields come straight from the dump and are reliable:
 *   - id            ← stratagemRepoId (detachment-scoped, or bare for the coreless few)
 *   - name          ← localised dump name (verbatim RAW)
 *   - cp_cost       ← cpCost
 *   - category      ← detachmentId presence (core vs detachment)
 *   - type          ← category enum (omitted when the pack prints no type)
 *   - detachment_id ← resolved detachment slug
 *   - player_turn   ← key (yourTurn/eitherPlayer/opponentsTurn); prose corroborates
 *
 * REQUIRED fields the dump does not cleanly supply, seeded provisionally:
 *   - phases  ← parsed from whenRules prose (every unseeded row yields ≥1 phase; a
 *              lone ["command"] guard covers the theoretical empty case). The
 *              structured stratagem_phase table is NOT used — it is the buggy index
 *              the reconcile deliberately rejects (see stratagems.ts header).
 *   - timing  ← no dump source at all; defaults to `once-per-phase`, the repo's
 *              near-universal value (2123/2125 authored rows).
 *
 * Every seed is stamped `pre-launch-provisional` so phases/timing are flagged for
 * review, mirroring how seed-units emits a skeleton. Combat-Patrol publications are
 * held back by default (the competitive set is matched-play), like seed-units /
 * seed-detachments. Prose (whenRules/targetRules/effectRules/restrictionRules) routes
 * to the out-of-repo store via mfm-backfill-store, never into this repo.
 */
import * as fs from "fs";
import * as path from "path";
import { nameToId } from "../converters/id-generator.js";
import { MfmDump, type StratagemRow } from "./loader.js";
import { readJsonArray, CORE_DIR } from "./repo-files.js";
import { repoDirs, repoDirForFactionName } from "./faction-map.js";
import type { StagedWrite } from "./apply.js";
import { modeOfPublication } from "./game-mode.js";
import {
  stratagemRepoId,
  buildStratCanon,
  deriveTrigger,
} from "./stratagems.js";
import { acceptedGapIds } from "./accepted-gaps.js";

const PROVISIONAL = { edition: "11th", dataslate: "pre-launch-provisional" };
const DEFAULT_TIMING = "once-per-phase";

interface SeedStratRecord {
  id: string;
  external_refs: { namespace: string; id: string }[];
  name: string;
  category: "core" | "detachment";
  type?: string;
  detachment_id?: string;
  cp_cost: number;
  phases: string[];
  player_turn: string;
  timing: string;
  target_restrictions: null;
  ability_id: string;
  game_version: { edition: string; dataslate: string };
}

export interface StratSeedReport {
  staged: StagedWrite[];
  seeded: { dir: string; id: string; name: string }[];
  /** Held back because the source publication is a Combat-Patrol box (default). */
  heldBackCombatPatrol: string[];
  /** Detachment-scoped but the detachment faction resolves to no repo dir. */
  skippedNoDir: string[];
  /** No canon row (unsluggable / missing name). */
  skippedNoCanon: string[];
  /** Dump rows excluded by an existing detachment's exact current roster. */
  skippedOutsideRoster: string[];
  /** Coreless (no detachment) dump stratagems, held for manual review — the 12
   *  universal core stratagems are already complete in the repo, so a coreless
   *  "new-in-dump" is a spelling/scoping mismatch with an existing core entity
   *  (e.g. dump "Counteroffensive" vs repo "counter-offensive"), not a real gap. */
  skippedCoreless: string[];
}

type DetachmentRoster = Map<string, Set<string>>;

function readDetachmentRosters(dir: string): DetachmentRoster {
  const detachmentPath = path.join(CORE_DIR, dir, "detachments.json");
  const rosters: DetachmentRoster = new Map();
  if (!fs.existsSync(detachmentPath)) return rosters;

  for (const detachment of readJsonArray<{
    id: string;
    stratagem_ids?: string[];
  }>(detachmentPath)) {
    if (detachment.stratagem_ids) {
      rosters.set(detachment.id, new Set(detachment.stratagem_ids));
    }
  }
  return rosters;
}

function rosterFor(
  rostersByDirectory: Map<string, DetachmentRoster>,
  dir: string,
  detachmentId: string,
): Set<string> | undefined {
  let rosters = rostersByDirectory.get(dir);
  if (!rosters) {
    rosters = readDetachmentRosters(dir);
    rostersByDirectory.set(dir, rosters);
  }
  return rosters.get(detachmentId);
}

export function seedStratagems(
  dump: MfmDump,
  opts: { includeCombatPatrol?: boolean } = {},
): StratSeedReport {
  const rostersByDirectory = new Map<string, DetachmentRoster>();
  const acceptedStratagemsByDirectory = new Map<string, ReadonlySet<string>>();
  const canon = buildStratCanon(dump);
  const detById = dump.byId("detachment");

  const rootPath = path.join(CORE_DIR, "stratagems.json");
  const dirPaths = new Map<string, string>();
  for (const dir of repoDirs())
    dirPaths.set(dir, path.join(CORE_DIR, dir, "stratagems.json"));

  // Lazily-loaded live arrays keyed by file path; appended in place, staged once.
  const arrays = new Map<string, SeedStratRecord[]>();
  const load = (p: string): SeedStratRecord[] => {
    if (!arrays.has(p))
      arrays.set(p, fs.existsSync(p) ? readJsonArray<SeedStratRecord>(p) : []);
    return arrays.get(p)!;
  };

  const repoIds = new Set<string>();
  for (const p of [rootPath, ...dirPaths.values()]) {
    if (fs.existsSync(p)) for (const s of load(p)) repoIds.add(s.id);
  }

  const report: StratSeedReport = {
    staged: [],
    seeded: [],
    heldBackCombatPatrol: [],
    skippedNoDir: [],
    skippedNoCanon: [],
    skippedCoreless: [],
    skippedOutsideRoster: [],
  };
  const touched = new Set<string>();

  for (const s of dump.table("stratagem")) {
    const id = stratagemRepoId(dump, s);
    if (!id || repoIds.has(id)) continue;

    const c = canon.get(id);
    if (!c) {
      report.skippedNoCanon.push(id);
      continue;
    }

    // Coreless stratagems are held for manual review: the repo's universal core
    // set is complete, so a coreless new-in-dump is a spelling/scoping mismatch.
    if (!s.detachmentId) {
      report.skippedCoreless.push(id);
      continue;
    }

    let targetPath: string;
    let dirLabel: string;
    let detachment_id: string | undefined;
    {
      const fkId = dump.factionKeywordOfDetachment(s.detachmentId);
      const fkName = fkId
        ? dump.enName(dump.byId("faction_keyword").get(fkId))
        : undefined;
      const dir = repoDirForFactionName(fkName);
      if (!dir) {
        report.skippedNoDir.push(id);
        continue;
      }
      targetPath =
        dirPaths.get(dir) ?? path.join(CORE_DIR, dir, "stratagems.json");
      dirLabel = dir;
      const dn = dump.enName(detById.get(s.detachmentId));
      detachment_id = dn ? nameToId(dn) : undefined;
      let acceptedStratagems = acceptedStratagemsByDirectory.get(dir);
      if (!acceptedStratagems) {
        acceptedStratagems = acceptedGapIds("stratagems", dir);
        acceptedStratagemsByDirectory.set(dir, acceptedStratagems);
      }
      if (acceptedStratagems.has(id)) {
        report.skippedOutsideRoster.push(id);
        continue;
      }
      if (
        !opts.includeCombatPatrol &&
        modeOfPublication(dump, s.publicationId) === "combat-patrol"
      ) {
        report.heldBackCombatPatrol.push(id);
        continue;
      }
      if (
        detachment_id &&
        rosterFor(rostersByDirectory, dir, detachment_id)?.has(id) === false
      ) {
        report.skippedOutsideRoster.push(id);
        continue;
      }
    }

    const en = (s.localisations?.en ?? {}) as { whenRules?: string };
    const derived = deriveTrigger(en.whenRules);
    const rec: SeedStratRecord = {
      id,
      external_refs: [{ namespace: "mfm", id: s.id! }],
      name: dump.enName(s)!,
      category: c.category,
      ...(c.type ? { type: c.type } : {}),
      ...(detachment_id ? { detachment_id } : {}),
      cp_cost: c.cp_cost ?? 1,
      phases: derived.phases ?? ["command"],
      player_turn: c.player_turn ?? derived.player_turn ?? "either",
      timing: DEFAULT_TIMING,
      target_restrictions: null,
      ability_id: id,
      game_version: { ...PROVISIONAL },
    };
    load(targetPath).push(rec);
    touched.add(targetPath);
    report.seeded.push({ dir: dirLabel, id, name: rec.name });
  }

  for (const p of touched) {
    const arr = load(p);
    arr.sort((a, b) => a.id.localeCompare(b.id));
    report.staged.push({ path: p, value: arr });
  }
  return report;
}
