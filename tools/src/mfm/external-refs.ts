import {
  CoreExternalRefStore,
  EXTERNAL_REF_ENTITY_FILES,
  type ExternalRefEntityType,
} from "../core-external-refs.js";
import { detachmentScopedId, nameToId } from "../converters/id-generator.js";
import type { StagedWrite } from "./apply.js";
import { collectSeedDetachments } from "./seed-detachments.js";
import { effectiveDir } from "./seed-units.js";
import { repoDirForFactionName } from "./faction-map.js";
import type { MfmDump } from "./loader.js";
import { stratagemRepoId } from "./stratagems.js";
import { wargearItemsForDatasheet } from "./wargear.js";
import {
  resolveMfmWeaponEntityId,
  type CoreWeapon,
} from "./weapon-variants.js";
import type { GameVersion } from "./gear-projection.js";
import { findDatasheet } from "./project-loadout.js";

export interface MfmExternalRefsReport {
  added: Record<ExternalRefEntityType, number>;
  unmatched: Record<ExternalRefEntityType, number>;
  staged: StagedWrite[];
}

function emptyCounts(): Record<ExternalRefEntityType, number> {
  return {
    faction: 0,
    unit: 0,
    detachment: 0,
    enhancement: 0,
    stratagem: 0,
    weapon: 0,
    wargear: 0,
  };
}

function safeId(name: string | undefined): string | null {
  if (!name) return null;
  try {
    return nameToId(name);
  } catch {
    return null;
  }
}

/** Project exact MFM row identities onto already-resolved core entities. */
export function runMfmExternalRefs(
  dump: MfmDump,
  onlyDir?: string,
): MfmExternalRefsReport {
  const store = new CoreExternalRefStore();
  const added = emptyCounts();
  const unmatched = emptyCounts();
  const attach = (
    entityType: ExternalRefEntityType,
    dir: string,
    id: string,
    sourceId: string,
  ): boolean => {
    const result = store.add(entityType, dir, id, "mfm", sourceId);
    if (result === "unmatched") {
      unmatched[entityType]++;
      return false;
    }
    if (result === "added") added[entityType]++;
    return true;
  };

  // Factions: use only the home keyword (exact slug match), avoiding aliases that
  // happen to route to the same repository directory.
  for (const row of dump.table("faction_keyword")) {
    if (!row.id) continue;
    const name = dump.enName(row);
    const dir = repoDirForFactionName(name);
    if (!dir || (onlyDir && dir !== onlyDir) || safeId(name) !== dir) continue;
    attach("faction", dir, dir, row.id);
  }

  const datasheetHomes = new Map<string, { dir: string; unitId: string }>();
  for (const datasheet of dump.table("datasheet")) {
    if (!datasheet.id || datasheet.isLegends) continue;
    const factionKeywordId = dump.factionKeywordOfDatasheet(datasheet.id);
    const factionName = factionKeywordId
      ? dump.enName(dump.byId("faction_keyword").get(factionKeywordId))
      : undefined;
    const sourceDir = repoDirForFactionName(factionName);
    const homeDir = sourceDir ? effectiveDir(sourceDir) : null;
    if (!sourceDir || !homeDir || (onlyDir && homeDir !== onlyDir)) continue;
    const unitId = safeId(dump.enName(datasheet));
    const matched = unitId ? findDatasheet(dump, unitId, sourceDir) : null;
    if (!matched || matched.id !== datasheet.id) {
      unmatched.unit++;
      continue;
    }
    if (unitId && attach("unit", homeDir, unitId, datasheet.id)) {
      datasheetHomes.set(datasheet.id, { dir: homeDir, unitId });
    }
  }

  const detachmentDirs = new Map<string, Set<string>>();
  for (const candidate of collectSeedDetachments(dump)) {
    if (onlyDir && candidate.dir !== onlyDir) continue;
    const sourceId = candidate.source_id;
    const candidateDirs = detachmentDirs.get(sourceId) ?? new Set<string>();
    candidateDirs.add(candidate.dir);
    detachmentDirs.set(sourceId, candidateDirs);
    attach("detachment", candidate.dir, candidate.id, sourceId);
  }

  for (const source of dump.table("enhancement")) {
    if (!source.id) continue;
    const name = dump.enName(source);
    const detachmentName = dump.enName(
      dump.byId("detachment").get(source.detachmentId),
    );
    if (!name || !detachmentName) continue;
    let id: string;
    try {
      id = detachmentScopedId(name, detachmentName);
    } catch {
      continue;
    }
    for (const dir of detachmentDirs.get(source.detachmentId) ?? []) {
      attach("enhancement", dir, id, source.id);
    }
  }

  for (const source of dump.table("stratagem")) {
    if (!source.id) continue;
    const id = stratagemRepoId(dump, source);
    if (!id) continue;
    if (!source.detachmentId) {
      attach("stratagem", "", id, source.id);
      continue;
    }
    for (const dir of detachmentDirs.get(source.detachmentId) ?? []) {
      attach("stratagem", dir, id, source.id);
    }
  }

  // Wargear-item ownership is structural: each item is reached through a
  // datasheet's loadout graph, then resolved to that datasheet's repository home.
  const weaponsByDir = new Map<string, CoreWeapon[]>();
  for (const location of store.locations("weapon")) {
    const weapons = weaponsByDir.get(location.dir) ?? [];
    weapons.push(location.record as CoreWeapon);
    weaponsByDir.set(location.dir, weapons);
  }
  for (const datasheet of dump.table("datasheet")) {
    if (!datasheet.id) continue;
    const home = datasheetHomes.get(datasheet.id);
    if (!home) continue;
    const gameVersion = (store.get("unit", home.dir, home.unitId)
      ?.game_version as GameVersion | undefined) ?? {
      edition: "11th",
      dataslate: "launch",
    };
    for (const item of wargearItemsForDatasheet(dump, datasheet.id)) {
      if (!item.id) continue;
      if (item.wargearType === "weapon") {
        const entityId = resolveMfmWeaponEntityId(
          dump,
          item,
          home.unitId,
          weaponsByDir.get(home.dir) ?? [],
          gameVersion,
        );
        if (entityId) attach("weapon", home.dir, entityId, item.id);
        else unmatched.weapon++;
        continue;
      }
      const entityId = safeId(dump.enName(item));
      if (entityId) attach("wargear", home.dir, entityId, item.id);
    }
  }

  store.synchronizeReplicated();
  return { added, unmatched, staged: store.stagedWrites() };
}

export function buildMfmExternalRefsReport(
  report: MfmExternalRefsReport,
  write: boolean,
): string {
  const lines = [
    `# MFM external references — ${write ? "APPLIED" : "DRY RUN"}`,
    "",
  ];
  lines.push(
    "| Entity | References added | Source relationships without a matching entity |",
  );
  lines.push("|---|---:|---:|");
  for (const entityType of Object.keys(
    EXTERNAL_REF_ENTITY_FILES,
  ) as ExternalRefEntityType[]) {
    lines.push(
      `| ${entityType} | ${report.added[entityType]} | ${report.unmatched[entityType]} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}
