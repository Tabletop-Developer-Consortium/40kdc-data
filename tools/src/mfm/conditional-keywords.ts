import * as fs from "fs";
import * as path from "path";
import { nameToId } from "../converters/id-generator.js";
import type { StagedWrite } from "./apply.js";
import { candidateDirs, homeScore } from "./wargear.js";
import { CORE_DIR, readJsonArray } from "./repo-files.js";
import { repoDirs } from "./faction-map.js";
import { factionKeywordLabel, keywordLabel } from "./keywords.js";
import type { DatasheetRow } from "./dump.generated.js";
import type { MfmDump } from "./loader.js";

interface ConditionalKeyword {
  keyword: string;
  required_detachment_id?: string | null;
  required_faction_keyword?: string | null;
}

interface UnitRecord {
  id: string;
  conditional_keywords?: ConditionalKeyword[];
  [key: string]: unknown;
}

export interface ConditionalKeywordDirResult {
  dir: string;
  matched: number;
  changed: number;
}

export interface ConditionalKeywordReport {
  dirs: ConditionalKeywordDirResult[];
  unsupported: { unit_id: string; source_id: string; condition: string }[];
  unresolved: { unit_id: string; source_id: string; field: string }[];
  staged: StagedWrite[];
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function sortEntries(entries: Iterable<ConditionalKeyword>): ConditionalKeyword[] {
  const unique = new Map<string, ConditionalKeyword>();
  for (const entry of entries) unique.set(JSON.stringify(entry), entry);
  return [...unique.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** Reconcile source-owned conditional keyword grants onto every matched repo unit. */
export function runConditionalKeywords(dump: MfmDump, onlyDir?: string): ConditionalKeywordReport {
  const dirs = repoDirs();
  const byDir = new Map<string, DatasheetRow[]>();
  for (const datasheet of dump.table("datasheet")) {
    if (datasheet.isLegends) continue;
    for (const dir of candidateDirs(dump, datasheet)) {
      if (!dirs.has(dir)) continue;
      (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(datasheet);
    }
  }

  const conditionsByDatasheet = dump.groupBy("conditional_keyword", "datasheetId");
  const detachments = dump.byId("detachment");
  const staged: StagedWrite[] = [];
  const results: ConditionalKeywordDirResult[] = [];
  const unsupported: ConditionalKeywordReport["unsupported"] = [];
  const unresolved: ConditionalKeywordReport["unresolved"] = [];

  for (const dir of [...dirs].sort()) {
    if (onlyDir && dir !== onlyDir) continue;
    const unitPath = path.join(CORE_DIR, dir, "units.json");
    if (!fs.existsSync(unitPath)) continue;
    const units = readJsonArray<UnitRecord>(unitPath);
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    const grantsByUnit = new Map<string, ConditionalKeyword[]>();
    const matched = new Set<string>();

    const datasheets = (byDir.get(dir) ?? [])
      .slice()
      .sort((a, b) => homeScore(dump, a, dir) - homeScore(dump, b, dir));
    for (const datasheet of datasheets) {
      const name = dump.enName(datasheet);
      if (!name) continue;
      let unitId: string;
      try {
        unitId = nameToId(name);
      } catch {
        continue;
      }
      if (!byId.has(unitId)) continue;
      matched.add(unitId);

      for (const source of conditionsByDatasheet.get(datasheet.id) ?? []) {
        if (source.requiredAllegianceAbilityId || source.requiredWarlordMiniatureId) {
          unsupported.push({
            unit_id: unitId,
            source_id: source.id,
            condition: source.requiredAllegianceAbilityId
              ? "requiredAllegianceAbilityId"
              : "requiredWarlordMiniatureId",
          });
          continue;
        }
        const keyword = keywordLabel(dump, source.keywordId);
        if (!keyword) {
          unresolved.push({ unit_id: unitId, source_id: source.id, field: "keywordId" });
          continue;
        }
        const entry: ConditionalKeyword = { keyword };
        if (source.requiredDetachmentId) {
          const detachmentName = dump.enName(detachments.get(source.requiredDetachmentId));
          if (!detachmentName) {
            unresolved.push({ unit_id: unitId, source_id: source.id, field: "requiredDetachmentId" });
            continue;
          }
          entry.required_detachment_id = nameToId(detachmentName);
        }
        if (source.requiredRosterFactionKeywordId) {
          const factionKeyword = factionKeywordLabel(dump, source.requiredRosterFactionKeywordId);
          if (!factionKeyword) {
            unresolved.push({ unit_id: unitId, source_id: source.id, field: "requiredRosterFactionKeywordId" });
            continue;
          }
          entry.required_faction_keyword = factionKeyword;
        }
        (grantsByUnit.get(unitId) ?? grantsByUnit.set(unitId, []).get(unitId)!).push(entry);
      }
    }

    let changed = 0;
    for (const unitId of matched) {
      const unit = byId.get(unitId)!;
      const next = sortEntries(grantsByUnit.get(unitId) ?? []);
      if (same(unit.conditional_keywords, next)) continue;
      if (next.length) unit.conditional_keywords = next;
      else delete unit.conditional_keywords;
      changed += 1;
    }
    if (changed) staged.push({ path: unitPath, value: units });
    if (matched.size || changed) results.push({ dir, matched: matched.size, changed });
  }

  unsupported.sort((a, b) => `${a.unit_id}:${a.source_id}`.localeCompare(`${b.unit_id}:${b.source_id}`));
  unresolved.sort((a, b) => `${a.unit_id}:${a.source_id}`.localeCompare(`${b.unit_id}:${b.source_id}`));
  return { dirs: results, unsupported, unresolved, staged };
}

export function buildConditionalKeywordReport(
  report: ConditionalKeywordReport,
  write: boolean,
): string {
  const lines = [
    `# MFM conditional-keywords — ${write ? "APPLIED" : "DRY RUN"}`,
    "",
    "Source-owned conditional unit keywords from `conditional_keyword`.",
    "Allegiance-ability and warlord-miniature conditions remain source choices at import time and are reported, not flattened.",
    "",
    "| Dir | Matched | Changed |",
    "|---|--:|--:|",
    ...report.dirs.map((entry) => `| ${entry.dir} | ${entry.matched} | ${entry.changed} |`),
    "",
    `Unsupported source conditions: ${report.unsupported.length}`,
    `Unresolved source references: ${report.unresolved.length}`,
    "",
  ];
  return lines.join("\n");
}
