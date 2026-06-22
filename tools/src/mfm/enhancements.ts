/**
 * enhancements.ts — Phase 3A: reconcile enhancement point costs against the
 * GW MFM dump.
 *
 * The repo enhancement id is `detachmentScopedId(name, detachment-name)`, which
 * is exactly how the dump's (enhancement, detachment) pair slugs — so matching is
 * a direct id lookup. For each matched enhancement we set the canon `cost`, clear
 * `points_provisional`, and stamp the confirmed launch dataslate (cost is the
 * provisional field here, so confirming it is precisely what those flags record —
 * unlike Phase 2 dispositions, where touching game_version would over-claim).
 *
 * Prose (`localisations.en.rules`/`lore`) is NOT handled here — it routes to the
 * out-of-repo store in a dedicated unified pass (3B), never into this repo.
 */
import * as fs from "fs";
import * as path from "path";
import { detachmentScopedId } from "../converters/id-generator.js";
import {
  MfmDump,
  REPO_ROOT,
  type DetachmentRow,
  type EnhancementRow,
} from "./loader.js";
import { repoDirs } from "./faction-map.js";
import type { StagedWrite } from "./apply.js";

const CORE_DIR = path.join(REPO_ROOT, "data", "core");
const CONFIRMED = { edition: "11th", dataslate: "launch" };

interface EnhRecord {
  id: string;
  name: string;
  cost: number;
  points_provisional?: boolean;
  game_version?: { edition: string; dataslate: string };
  [k: string]: unknown;
}

export interface DirEnhResult {
  dir: string;
  matched: number;
  costChanged: { id: string; from: number; to: number }[];
  confirmed: number; // matched enhancements whose provisional/slate flags flipped
  unmatchedRepo: string[];
}

export interface EnhReport {
  dirs: DirEnhResult[];
  newInDump: string[];
  cpExcluded: string[]; // CP-only dump enhancement ids held back from newInDump (default)
  staged: StagedWrite[];
}

function readJson<T>(p: string): T[] {
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as T[]) : [];
}

/**
 * Strip a trailing parenthetical tag the dump appends to enhancement names
 * (" (Upgrade)", " (Aura)") but the repo entity name (and thus its id) omits.
 */
function cleanEnhName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** Enhancement repo-id → canon base points cost, from the dump. */
export function buildEnhCanon(dump: MfmDump): Map<string, number> {
  const detName = dump.byId<DetachmentRow>("detachment");
  const m = new Map<string, number>();
  for (const e of dump.table<EnhancementRow>("enhancement")) {
    const en = dump.enName(e);
    const dn = dump.enName(detName.get(e.detachmentId));
    if (!en || !dn) continue;
    try {
      m.set(detachmentScopedId(cleanEnhName(en), dn), e.basePointsCost);
    } catch {
      /* unsluggable — skip */
    }
  }
  return m;
}

/**
 * Repo-ids of the dump's Combat-Patrol-box enhancements. These are intentionally
 * not authored in the repo (mirroring how `seed-units`/`dispositions` hold back
 * Combat-Patrol content), so they are filtered out of `newInDump` by default.
 * Id'd exactly as `buildEnhCanon` keys its canon so the ids line up.
 */
export function combatPatrolEnhIds(dump: MfmDump): Set<string> {
  const detName = dump.byId<DetachmentRow>("detachment");
  const ids = new Set<string>();
  for (const e of dump.table<EnhancementRow>("enhancement")) {
    if (!e.isCombatPatrol) continue;
    const en = dump.enName(e);
    const dn = dump.enName(detName.get(e.detachmentId));
    if (!en || !dn) continue;
    try {
      ids.add(detachmentScopedId(cleanEnhName(en), dn));
    } catch {
      /* unsluggable — skip */
    }
  }
  return ids;
}

export function runEnhancements(
  dump: MfmDump,
  write: boolean,
  opts: { includeCombatPatrol?: boolean } = {}
): EnhReport {
  const canon = buildEnhCanon(dump);
  const matchedIds = new Set<string>();
  const dirs: DirEnhResult[] = [];
  const staged: StagedWrite[] = [];

  for (const dir of [...repoDirs()].sort()) {
    const p = path.join(CORE_DIR, dir, "enhancements.json");
    if (!fs.existsSync(p)) continue;
    const enhs = readJson<EnhRecord>(p);
    const res: DirEnhResult = { dir, matched: 0, costChanged: [], confirmed: 0, unmatchedRepo: [] };
    for (const e of enhs) {
      const cost = canon.get(e.id);
      if (cost === undefined) {
        res.unmatchedRepo.push(e.id);
        continue;
      }
      matchedIds.add(e.id);
      res.matched++;
      if (e.cost !== cost) res.costChanged.push({ id: e.id, from: e.cost, to: cost });
      const needsConfirm =
        e.points_provisional !== false ||
        e.game_version?.dataslate !== CONFIRMED.dataslate ||
        e.game_version?.edition !== CONFIRMED.edition;
      if (needsConfirm) res.confirmed++;
      // Mutate in-memory in BOTH modes; the dry-run rehearsal validates the result.
      e.cost = cost;
      e.points_provisional = false;
      if (e.game_version) {
        e.game_version.edition = CONFIRMED.edition;
        e.game_version.dataslate = CONFIRMED.dataslate;
      }
    }
    staged.push({ path: p, value: enhs });
    dirs.push(res);
  }

  const unmatched = [...canon.keys()].filter((id) => !matchedIds.has(id));
  const cp = combatPatrolEnhIds(dump);
  const cpExcluded: string[] = [];
  const newInDump: string[] = [];
  for (const id of unmatched) {
    if (!opts.includeCombatPatrol && cp.has(id)) cpExcluded.push(id);
    else newInDump.push(id);
  }
  newInDump.sort();
  cpExcluded.sort();
  return { dirs, newInDump, cpExcluded, staged };
}

export function buildEnhReport(report: EnhReport, write: boolean): string {
  const { dirs, newInDump, cpExcluded } = report;
  const sum = (f: (d: DirEnhResult) => number) => dirs.reduce((a, d) => a + f(d), 0);
  const L: string[] = [];
  L.push(`# MFM enhancement costs — ${write ? "APPLIED" : "DRY RUN"}`);
  L.push("");
  L.push("Reconciles enhancement `cost` against the dump; matched entries are");
  L.push("confirmed (`points_provisional: false`, launch dataslate). Prose untouched.");
  L.push("");
  L.push("| Dir | Matched | Cost changed | Confirmed | Repo-only (not in dump) |");
  L.push("|---|--:|--:|--:|--:|");
  for (const d of dirs.filter((d) => d.matched || d.unmatchedRepo.length)) {
    L.push(
      `| ${d.dir} | ${d.matched} | ${d.costChanged.length} | ${d.confirmed} | ${d.unmatchedRepo.length} |`
    );
  }
  L.push(
    `| **TOTAL** | **${sum((d) => d.matched)}** | **${sum((d) => d.costChanged.length)}** | **${sum((d) => d.confirmed)}** | **${sum((d) => d.unmatchedRepo.length)}** |`
  );
  L.push("");
  for (const d of dirs) {
    if (!d.costChanged.length && !d.unmatchedRepo.length) continue;
    L.push(`## ${d.dir}`);
    if (d.costChanged.length) {
      L.push("", "**Cost changes** (old → new):");
      d.costChanged.forEach((c) => L.push(`- ${c.id}: ${c.from} → ${c.to}`));
    }
    if (d.unmatchedRepo.length) {
      L.push("", "**Repo enhancements absent from dump** (left as-is):");
      d.unmatchedRepo.forEach((id) => L.push(`- ${id}`));
    }
    L.push("");
  }
  if (newInDump.length) {
    L.push("## New enhancements in dump (no repo entity — author in a follow-up)");
    L.push("");
    newInDump.slice(0, 200).forEach((s) => L.push(`- ${s}`));
    if (newInDump.length > 200) L.push(`- …and ${newInDump.length - 200} more`);
    L.push("");
  }
  if (cpExcluded.length) {
    L.push(
      `## Combat-Patrol enhancements held back (${cpExcluded.length} — pass --include-combat-patrol to author)`
    );
    L.push("");
    cpExcluded.slice(0, 200).forEach((s) => L.push(`- ${s}`));
    if (cpExcluded.length > 200) L.push(`- …and ${cpExcluded.length - 200} more`);
    L.push("");
  }
  return L.join("\n") + "\n";
}
