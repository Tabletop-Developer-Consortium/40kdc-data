import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CoreExternalRefStore,
  type ExternalRefEntityType,
} from "./core-external-refs.js";
import { detachmentScopedId, nameToId } from "./converters/id-generator.js";
import {
  GAME_DATACARDS_FACTION_FILES,
  GAME_DATACARDS_FACTION_IDENTITY_FILES,
  GAME_DATACARDS_IDENTITY_BASE,
} from "./game-datacards-source.js";
import { applyWrites } from "./mfm/apply.js";
import {
  analyzeBsdataRevision,
  classifyBsdataFact,
  JjRevisionTree,
  type BsdataBackstopReport,
} from "./mfm/bsdata-backstop.js";
import { effectiveDir } from "./mfm/seed-units.js";
import { repoDirForFactionName } from "./mfm/faction-map.js";
import { REPO_ROOT } from "./mfm/repo-files.js";

interface SourceStats {
  added: Record<ExternalRefEntityType, number>;
  unmatched: Record<ExternalRefEntityType, number>;
}

interface GameDatacardsDocument {
  id?: string;
  name?: string;
  datasheets?: unknown[];
  enhancements?: unknown[];
  stratagems?: unknown[];
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

function emptyStats(): SourceStats {
  return { added: emptyCounts(), unmatched: emptyCounts() };
}

function safeId(name: unknown): string | null {
  if (typeof name !== "string" || !name.trim()) return null;
  try {
    return nameToId(name);
  } catch {
    return null;
  }
}

function add(
  store: CoreExternalRefStore,
  stats: SourceStats,
  entityType: ExternalRefEntityType,
  dir: string,
  entityId: string,
  namespace: string,
  sourceId: unknown,
): void {
  if (typeof sourceId !== "string" || !sourceId) return;
  const result = store.add(entityType, dir, entityId, namespace, sourceId);
  if (result === "added") stats.added[entityType]++;
  else if (result === "unmatched") stats.unmatched[entityType]++;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function englishText(value: unknown): string | null {
  if (typeof value === "string") return value;
  const localized = record(value);
  return typeof localized?.en === "string" ? localized.en : null;
}

function sourceDirForBsdataFile(file: string): string | null {
  const base = path.basename(file, path.extname(file));
  const explicit: Readonly<Record<string, string>> = {
    "Aeldari - Aeldari Library": "aeldari",
    "Aeldari - Craftworlds": "aeldari",
    "Aeldari - Drukhari": "drukhari",
    "Chaos - Chaos Daemons Library": "chaos-daemons",
    "Chaos - Chaos Knights Library": "chaos-knights",
    "Imperium - Astra Militarum - Library": "astra-militarum",
    "Imperium - Imperial Knights - Library": "imperial-knights",
    "Imperium - Space Marines": "adeptus-astartes",
    "Library - Tyranids": "tyranids",
    "Library - Astartes Heresy Legends": "adeptus-astartes",
  };
  if (explicit[base]) return explicit[base];
  if (/^(?:Library - Titans|Unaligned Forces|Warhammer 40,000)$/.test(base))
    return null;
  const label = base
    .replace(/^(?:Chaos|Imperium|Aeldari) - /, "")
    .replace(/ Library$/, "");
  return repoDirForFactionName(label);
}

function pointerContains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/** Backfill exact selection-entry and entry-link ids from one pinned BSData revision. */
export function syncBsdataExternalRefs(
  store: CoreExternalRefStore,
  report: BsdataBackstopReport,
): SourceStats {
  const stats = emptyStats();
  const ownershipRoots = new Map<string, { pointer: string; dir: string }[]>();
  const unitRoots = new Map<
    string,
    { pointer: string; dir: string; unitId: string }[]
  >();
  const targetIdsByLocation = new Map<string, string[]>();

  for (const fact of report.facts) {
    if (classifyBsdataFact(fact) !== "unit") continue;
    const sourceDir = sourceDirForBsdataFile(fact.source_file);
    const dir = sourceDir ? effectiveDir(sourceDir) : null;
    const unitId = safeId(fact.name);
    if (!dir || !unitId || !store.get("unit", dir, unitId)) continue;
    const roots = unitRoots.get(fact.source_file) ?? [];
    roots.push({ pointer: fact.pointer, dir, unitId });
    unitRoots.set(fact.source_file, roots);
  }

  for (const link of report.links) {
    const sourceDir = sourceDirForBsdataFile(link.source_file);
    if (!sourceDir) continue;
    const dir = effectiveDir(sourceDir);
    if (!dir) continue;
    const roots = ownershipRoots.get(link.target_file) ?? [];
    roots.push({ pointer: link.target_pointer, dir });
    ownershipRoots.set(link.target_file, roots);
    const key = `${link.source_file}\0${link.pointer}`;
    const ids = targetIdsByLocation.get(key) ?? [];
    ids.push(link.target_id);
    targetIdsByLocation.set(key, ids);

    const owner = (unitRoots.get(link.source_file) ?? [])
      .filter((root) => pointerContains(root.pointer, link.pointer))
      .sort((left, right) => right.pointer.length - left.pointer.length)[0];
    if (owner) {
      const targetRoots = unitRoots.get(link.target_file) ?? [];
      targetRoots.push({
        pointer: link.target_pointer,
        dir: owner.dir,
        unitId: owner.unitId,
      });
      unitRoots.set(link.target_file, targetRoots);
    }
  }

  for (const fact of report.facts) {
    const entityType = classifyBsdataFact(fact);
    if (!entityType) continue;
    const baseId = safeId(fact.name);
    if (!baseId) continue;
    const sourceIds = [
      fact.id,
      ...(targetIdsByLocation.get(`${fact.source_file}\0${fact.pointer}`) ??
        []),
    ];
    const owners = new Map<string, { dir: string; unitId?: string }>();

    if (entityType === "unit") {
      const direct = sourceDirForBsdataFile(fact.source_file);
      const dir = direct ? effectiveDir(direct) : null;
      if (dir) owners.set(dir, { dir });
      for (const root of ownershipRoots.get(fact.source_file) ?? []) {
        if (pointerContains(root.pointer, fact.pointer)) {
          owners.set(root.dir, { dir: root.dir });
        }
      }
    } else {
      for (const root of unitRoots.get(fact.source_file) ?? []) {
        if (pointerContains(root.pointer, fact.pointer)) {
          owners.set(`${root.dir}\0${root.unitId}`, {
            dir: root.dir,
            unitId: root.unitId,
          });
        }
      }
    }
    if (owners.size === 0) {
      stats.unmatched[entityType] += sourceIds.length;
      continue;
    }

    for (const owner of owners.values()) {
      let entityId = baseId;
      if (entityType === "weapon") {
        if (!owner.unitId) continue;
        const variantId = `${baseId}-${owner.unitId}`;
        entityId = store.get("weapon", owner.dir, variantId)
          ? variantId
          : store.get("weapon", owner.dir, baseId)
            ? baseId
            : "";
      }
      if (!entityId) {
        stats.unmatched[entityType] += sourceIds.length;
        continue;
      }
      for (const sourceId of sourceIds) {
        add(store, stats, entityType, owner.dir, entityId, "bsdata", sourceId);
      }
    }
  }
  return stats;
}

/** Backfill only game-datacards nodes carrying their own stable id. */
export function syncGameDatacardsExternalRefs(
  store: CoreExternalRefStore,
  documents: ReadonlyMap<string, GameDatacardsDocument>,
): SourceStats {
  const stats = emptyStats();
  for (const [faction, files] of Object.entries(GAME_DATACARDS_FACTION_FILES)) {
    for (const basename of files) {
      const document = documents.get(basename);
      if (!document) continue;

      // Shared-content fallbacks do not identify their consuming faction.
      if (
        GAME_DATACARDS_FACTION_IDENTITY_FILES[faction] === basename &&
        document.id
      ) {
        add(
          store,
          stats,
          "faction",
          faction,
          faction,
          "game-datacards",
          document.id,
        );
      }

      const unitDir = effectiveDir(faction);
      if (unitDir) {
        for (const value of document.datasheets ?? []) {
          const node = record(value);
          if (!node) continue;
          const id = safeId(englishText(node.name));
          if (id)
            add(store, stats, "unit", unitDir, id, "game-datacards", node.id);
        }
      }

      for (const [entityType, values] of [
        ["enhancement", document.enhancements ?? []],
        ["stratagem", document.stratagems ?? []],
      ] as const) {
        for (const value of values) {
          const node = record(value);
          if (!node || typeof node.detachment !== "string") continue;
          const name = englishText(node.name);
          if (!name) continue;
          let id: string;
          try {
            id = detachmentScopedId(name, node.detachment);
          } catch {
            continue;
          }
          add(store, stats, entityType, faction, id, "game-datacards", node.id);
        }
      }
    }
  }
  return stats;
}

async function fetchGameDatacardsDocuments(): Promise<
  Map<string, GameDatacardsDocument>
> {
  const basenames = new Set(Object.values(GAME_DATACARDS_FACTION_FILES).flat());
  // The 11e feed folded the legacy Leviathan snapshot into space_marines.
  basenames.delete("marines_leviathan");
  const documents = new Map<string, GameDatacardsDocument>();
  await Promise.all(
    [...basenames].map(async (basename) => {
      const response = await fetch(
        `${GAME_DATACARDS_IDENTITY_BASE}/${basename}.json`,
      );
      if (!response.ok)
        throw new Error(`game-datacards ${basename}: HTTP ${response.status}`);
      documents.set(basename, (await response.json()) as GameDatacardsDocument);
    }),
  );
  return documents;
}

function printStats(label: string, stats: SourceStats): void {
  const added = Object.values(stats.added).reduce(
    (sum, count) => sum + count,
    0,
  );
  const unmatched = Object.values(stats.unmatched).reduce(
    (sum, count) => sum + count,
    0,
  );
  console.log(
    `${label}: added ${added}, exact source relationships without a core entity ${unmatched}.`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const bsdataFlag = args.indexOf("--bsdata");
  const refFlag = args.indexOf("--bsdata-ref");
  const checkout = path.resolve(
    REPO_ROOT,
    bsdataFlag >= 0 ? args[bsdataFlag + 1] : "_private/bsdata-wh40k-11e",
  );
  const sourceRef = refFlag >= 0 ? args[refFlag + 1] : "main";

  const store = new CoreExternalRefStore();
  const bsdata = analyzeBsdataRevision(new JjRevisionTree(checkout), sourceRef);
  const bsdataStats = syncBsdataExternalRefs(store, bsdata);
  printStats(`BSData ${bsdata.source.resolved_commit}`, bsdataStats);

  const gameDatacardsDocuments = await fetchGameDatacardsDocuments();
  const removedGameDatacardsRefs = store.removeNamespace("game-datacards");
  console.log(
    `game-datacards: removed ${removedGameDatacardsRefs} stale source relationships.`,
  );
  const gameDatacardsStats = syncGameDatacardsExternalRefs(
    store,
    gameDatacardsDocuments,
  );
  printStats("game-datacards", gameDatacardsStats);

  store.synchronizeReplicated();
  await applyWrites(store.stagedWrites(), {
    write,
    label: "external-source-refs",
  });
  if (!write)
    console.log("DRY RUN — no files written. Re-run with --write to apply.");
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
