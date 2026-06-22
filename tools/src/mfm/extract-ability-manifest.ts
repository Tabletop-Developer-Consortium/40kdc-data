/**
 * extract-ability-manifest.ts — build an author-ability ingest manifest of a
 * skeleton unit's DATASHEET abilities, straight from the GW MFM dump.
 *
 * The `author-ability` pipeline ingests a JSON manifest (one record per ability,
 * SKILL.md §3) whose `raw_text` lands ONLY in the out-of-repo `40kdc-abilities`
 * store; the committed repo gets community DSL, never the prose. This tool produces
 * that manifest for the freshly-seeded units whose `ability_ids` are still empty:
 *
 *   - It emits only `abilityType === "datasheet"` rows (the unit-specific abilities).
 *     `core` (USRs: Deep Strike, Lone Operative …) and `faction` rows are shared and
 *     already authored — the pipeline would merge them by name, but they are out of
 *     scope here and add noise, so they are skipped.
 *   - `raw_text` is the dump's `localisations.en.rules`, HTML-stripped (the store
 *     wants verbatim prose; the `<b>/<u>` tags are presentation only).
 *
 * Output: `_private/manifests/<faction>.manifest.json` (git-ignored — it carries GW
 * text). IP: nothing this tool writes goes into committed `data/**`.
 *
 * Usage:
 *   npx tsx src/mfm/extract-ability-manifest.ts --dir <faction> (--unit <id> ... | --all-skeletons)
 */
import * as fs from "fs";
import * as path from "path";
import { loadDump, MfmDump, REPO_ROOT, type DatasheetRow } from "./loader.js";
import { repoDirForFactionName } from "./faction-map.js";
import { nameToId } from "../converters/id-generator.js";

const DATA_CORE = path.join(REPO_ROOT, "data", "core");
const MANIFEST_DIR = path.join(REPO_ROOT, "_private", "manifests");

/** Strip HTML tags + collapse whitespace; decode the handful of entities GW uses. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&rsquo;|&#39;/g, "'")
    .replace(/&ldquo;|&rdquo;|&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function findDatasheet(dump: MfmDump, unitId: string, dir: string): DatasheetRow | null {
  const matches: DatasheetRow[] = [];
  for (const ds of dump.table<DatasheetRow>("datasheet")) {
    if (ds.isLegends) continue;
    const name = dump.enName(ds);
    if (!name) continue;
    let slug: string;
    try {
      slug = nameToId(name);
    } catch {
      continue;
    }
    if (slug === unitId) matches.push(ds);
  }
  if (matches.length <= 1) return matches[0] ?? null;
  const scoped = matches.filter((ds) => {
    const fkId = dump.factionKeywordOfDatasheet(ds.id!);
    const fk = fkId ? dump.byId("faction_keyword").get(fkId) : undefined;
    return repoDirForFactionName(dump.enName(fk)) === dir;
  });
  return scoped.length === 1 ? scoped[0] : null;
}

interface ManifestRecord {
  faction: string;
  name: string;
  raw_text: string;
  unit_ids: string[];
  ability_type: "unit" | "core" | "faction";
  behavior: "passive" | "aura";
  phases: string[];
  source_ref: string;
  source_kind: "json";
}

/** Existing authored ability ids in a faction's enrichment, for merge-vs-stub decisions. */
function existingAbilityIds(dir: string): Set<string> {
  const p = path.join(REPO_ROOT, "data", "enrichment", dir, "abilities.json");
  if (!fs.existsSync(p)) return new Set();
  return new Set(JSON.parse(fs.readFileSync(p, "utf8")).map((a: any) => a.ability_id));
}

function main() {
  const argv = process.argv.slice(2);
  const dirFlag = argv.indexOf("--dir");
  const dir = dirFlag >= 0 ? argv[dirFlag + 1] : undefined;
  const allSkeletons = argv.includes("--all-skeletons");
  const unitIds: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--unit") unitIds.push(argv[i + 1]);
  if (!dir) {
    console.error("Usage: extract-ability-manifest --dir <faction> (--unit <id> ... | --all-skeletons)");
    process.exit(2);
  }

  const units = JSON.parse(fs.readFileSync(path.join(DATA_CORE, dir, "units.json"), "utf8"));
  let targets = unitIds;
  if (allSkeletons) {
    targets = units
      .filter((u: any) => !u.is_legend && (u.weapon_ids?.length ?? 0) === 0 && (u.ability_ids?.length ?? 0) === 0)
      .map((u: any) => u.id);
  }
  // Also include any seeded unit whose ability_ids is still empty (loadout may be done).
  if (!allSkeletons && targets.length === 0) {
    console.error("no --unit ids and no --all-skeletons");
    process.exit(2);
  }

  const dump = loadDump();
  const dda = dump.groupBy<any>("datasheet_datasheet_ability", "datasheetId");
  const daById = dump.byId<any>("datasheet_ability");
  const existing = existingAbilityIds(dir);

  const records: ManifestRecord[] = [];
  const skipped: string[] = [];
  const missingShared: string[] = [];
  for (const unitId of targets) {
    const ds = findDatasheet(dump, unitId, dir);
    if (!ds) {
      skipped.push(`${unitId}: no dump datasheet`);
      continue;
    }
    const links = (dda.get(ds.id!) ?? []).slice().sort((a: any, b: any) => a.displayOrder - b.displayOrder);
    let dsCount = 0;
    let mergeCount = 0;
    for (const link of links) {
      const ab = daById.get(link.datasheetAbilityId);
      if (!ab) continue;
      const loc = ab.localisations?.en ?? {};
      const name = (loc.name ?? "").trim();
      const rules = stripHtml(loc.rules ?? "");
      if (!name) continue;
      const behavior: "passive" | "aura" = ab.isAura ? "aura" : "passive";

      if (ab.abilityType === "datasheet") {
        // Unit-specific → a new stub for the pipeline to author.
        records.push({
          faction: dir,
          name,
          raw_text: rules,
          unit_ids: [unitId],
          ability_type: "unit",
          behavior,
          phases: [],
          source_ref: "mfm-dump",
          source_kind: "json",
        });
        dsCount++;
      } else if (ab.abilityType === "core" || ab.abilityType === "faction") {
        // Shared (USRs / faction rule). Emit ONLY when the derived id already
        // exists in the enrichment — then author:ingest merges this unit into the
        // existing entry's unit_ids (no new stub). A non-matching shared ability is
        // a genuine gap (e.g. a value-variant USR not yet authored) — report it,
        // don't fabricate a duplicate.
        let id: string;
        try {
          id = nameToId(name);
        } catch {
          continue;
        }
        if (existing.has(id)) {
          records.push({
            faction: dir,
            name,
            raw_text: rules,
            unit_ids: [unitId],
            ability_type: ab.abilityType,
            behavior,
            phases: [],
            source_ref: "mfm-dump",
            source_kind: "json",
          });
          mergeCount++;
        } else {
          missingShared.push(`${unitId}: ${ab.abilityType} "${name}" (${id}) not in enrichment`);
        }
      }
    }
    console.log(`  ${unitId}: ${dsCount} datasheet stub(s), ${mergeCount} shared link(s)`);
  }
  for (const s of skipped) console.log(`  ⚠ ${s}`);
  for (const s of missingShared) console.log(`  ⚠ ${s}`);

  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  const out = path.join(MANIFEST_DIR, `${dir}.manifest.json`);
  fs.writeFileSync(out, JSON.stringify(records, null, 2) + "\n");
  console.log(`\nWrote ${records.length} record(s) → ${path.relative(REPO_ROOT, out)}`);
}

main();
