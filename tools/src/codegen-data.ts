/**
 * Bundles every authored data file under `data/` into a single embedded module,
 * `src/data/bundle.generated.ts`.
 *
 * The bundle is inlined as an escaped JSON *string* that is `JSON.parse`d at load
 * time (mirroring the Rust crate's `include_str!`): tsc typechecks it instantly
 * (it is just a string), it parses once at import, and it compiles into `dist`
 * with no runtime filesystem access — so the published package works in Node,
 * bundlers, and browsers alike, where `data/` is not shipped.
 *
 * Run via `npm run codegen:data`. The output is gitignored and regenerated on
 * build/test/pack.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { emptyRawData, type RawData } from "./data/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const DATA_ROOTS = [join(REPO_ROOT, "data", "core"), join(REPO_ROOT, "data", "enrichment")];
const OUT_FILE = join(__dirname, "data", "bundle.generated.ts");
/** Committed share-token id registry (authored by `npm run registry:build`). */
const REGISTRY_IN = join(REPO_ROOT, "data", "share-registry.json");
const REGISTRY_OUT = join(__dirname, "share", "registry.generated.ts");

/** Directory names that hold examples/scratch data and must never be bundled. */
const EXCLUDED_DIRS = new Set(["_example", "_port-audit"]);

/** Map a data file's base name (sans `.json`) to its `RawData` collection key. */
const FILE_TO_COLLECTION: Record<string, keyof RawData> = {
  units: "units",
  "target-profiles": "targetProfiles",
  weapons: "weapons",
  "weapon-keywords": "weaponKeywords",
  "unit-keywords": "unitKeywords",
  factions: "factions",
  abilities: "abilities",
  "phase-mappings": "phaseMappings",
  detachments: "detachments",
  allies: "alliedRules",
  stratagems: "stratagems",
  enhancements: "enhancements",
  "leader-attachments": "leaderAttachments",
  "unit-compositions": "unitCompositions",
  "wargear-options": "wargearOptions",
  wargear: "wargear",
  "game-versions": "gameVersions",
  missions: "missions",
  "mission-matchups": "missionMatchups",
  "secondary-cards": "missionCards",
  "deployment-patterns": "deploymentPatterns",
  "force-dispositions": "forceDispositions",
  "terrain-templates": "terrainTemplates",
  "terrain-layouts": "terrainLayouts",
  "hull-shapes": "hullShapes",
  "resource-pools": "resourcePools",
  "interaction-flags": "interactionFlags",
};

/** The id-bearing key for a collection, used only for duplicate-id reporting. */
const ID_KEY: Partial<Record<keyof RawData, string>> = {
  abilities: "ability_id",
};

/**
 * Collections whose records are stamped with their owning faction (the
 * `data/{core,enrichment}/<faction>/` directory) at bundle time, so ids shared
 * across factions resolve faction-scoped in the linked API instead of
 * first-wins (issue #59 generalized). The rule says when a record is eligible:
 *
 *  - `"absent"` — stamp only when the record has no `faction_id` key at all
 *    (weapons author none; an authored value, even null, is preserved
 *    verbatim for byte-stability of the existing bundle).
 *  - `"absent-or-null"` — additionally overwrite an explicit `null` (ability
 *    records author `faction_id: null` on non-faction-typed entries; the null
 *    carries no information the directory doesn't).
 *
 * Records in `_`-prefixed directories (the shared `enrichment/_core` pool)
 * are never stamped — they stay faction-less on purpose so the linked API's
 * faction-scoped lookup falls back to them via `getAny`.
 *
 * Mirrored by the Rust bundler (`xtask bundle-data`), which Python and Go
 * copy byte-for-byte — keep the two tables in sync.
 */
const STAMP_FACTION: Partial<Record<keyof RawData, "absent" | "absent-or-null">> = {
  weapons: "absent",
  abilities: "absent-or-null",
};

/** Recursively collect bundleable `.json` files, skipping excluded dirs/examples. */
function collectFiles(dir: string): string[] {
  const out: string[] = [];
  // Sort so the bundle order (and thus first-wins for any shared id) is
  // reproducible across filesystems, not dependent on readdir() enumeration.
  for (const entry of readdirSync(dir).sort()) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full));
    } else if (entry.endsWith(".json") && !entry.endsWith(".example.json")) {
      out.push(full);
    }
  }
  return out;
}

function baseName(file: string): string {
  // Use node:path basename so this works on Windows (backslash) paths too — a bare
  // lastIndexOf("/") returns the whole path on Windows, so nothing bundles.
  return basename(file, ".json");
}

/** The faction a data file belongs to: the first path segment under `root`
 *  (e.g. `.../data/core/necrons/weapons.json` → `necrons`). Undefined when the
 *  file sits directly in the root (faction-less), so the caller can skip it. */
function factionOfFile(root: string, file: string): string | undefined {
  const seg = relative(root, file).split(sep)[0];
  return seg && !seg.endsWith(".json") ? seg : undefined;
}

function build(): RawData {
  const data = emptyRawData();
  for (const root of DATA_ROOTS) {
    for (const file of collectFiles(root)) {
      const collection = FILE_TO_COLLECTION[baseName(file)];
      if (!collection) continue; // schema/scratch json we don't bundle
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error(`expected a JSON array in ${file}`);
      }
      // Stamp records with their owning faction directory so ids shared across
      // factions resolve faction-scoped rather than first-wins (see
      // STAMP_FACTION for the per-collection rules and the `_core` exclusion).
      const stampRule = STAMP_FACTION[collection];
      if (stampRule) {
        const faction = factionOfFile(root, file);
        if (faction && !faction.startsWith("_")) {
          for (const r of parsed as Record<string, unknown>[]) {
            if (!r || typeof r !== "object") continue;
            if (r.faction_id === undefined || (stampRule === "absent-or-null" && r.faction_id === null)) {
              r.faction_id = faction;
            }
          }
        }
      }
      (data[collection] as unknown[]).push(...parsed);
    }
  }
  return data;
}

/** Warn (do not fail) on duplicate primary ids — a data-hygiene signal. */
function reportDuplicateIds(data: RawData): void {
  for (const [collection, key] of Object.entries(ID_KEY) as [keyof RawData, string][]) {
    // Faction-stamped collections legitimately share bare ids across factions
    // (each faction file may define its own "close-combat-weapon" / "leader");
    // the linked API disambiguates by faction. Their TRUE duplicate is the
    // same (faction_id, id) pair — an authoring error, so that's what's
    // flagged; unstamped collections keep the bare-id check.
    if (STAMP_FACTION[collection]) continue;
    reportDupes(collection, data[collection] as Record<string, unknown>[], (item) => item[key] as string | undefined);
  }
  for (const collection of Object.keys(STAMP_FACTION) as (keyof RawData)[]) {
    const key = ID_KEY[collection] ?? "id";
    reportDupes(`${collection} (faction_id,${key})`, data[collection] as Record<string, unknown>[], (item) => {
      const id = item[key] as string | undefined;
      return id === undefined ? undefined : `${(item.faction_id as string | null | undefined) ?? ""}::${id}`;
    });
  }
}

function reportDupes(
  label: string,
  items: Record<string, unknown>[],
  keyOf: (item: Record<string, unknown>) => string | undefined,
): void {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === undefined) continue;
    if (seen.has(key)) dupes.add(key);
    else seen.add(key);
  }
  if (dupes.size > 0) {
    console.warn(`  ⚠ ${label}: ${dupes.size} duplicate id(s), e.g. ${[...dupes].slice(0, 3).join(", ")}`);
  }
}

function emit(data: RawData): string {
  // JSON.stringify of the JSON text yields a valid, fully-escaped JS string
  // literal — safe to drop straight into the generated source.
  const jsonText = JSON.stringify(data);
  const literal = JSON.stringify(jsonText);
  return `/* GENERATED by 'npm run codegen:data' from the repository's data/ tree. DO NOT EDIT BY HAND. */
import type { RawData } from "./types.js";

const JSON_TEXT = ${literal};

/** The full 40kdc dataset, embedded at build time and parsed once at load. */
export const RAW_DATA: RawData = JSON.parse(JSON_TEXT) as RawData;
`;
}

/**
 * Inline the committed share-token registry as a parsed-once module, mirroring
 * the dataset bundle so the codec stays filesystem-free. The registry itself is
 * regenerated only by `npm run registry:build`; here we just embed it verbatim.
 */
function emitRegistry(): string {
  const jsonText = readFileSync(REGISTRY_IN, "utf-8");
  const literal = JSON.stringify(jsonText);
  return `/* GENERATED by 'npm run codegen:data' from data/share-registry.json. DO NOT EDIT BY HAND. */
import type { ShareRegistry } from "./registry.js";

const JSON_TEXT = ${literal};

/** The committed share-token id registry, embedded at build time. */
export const SHARE_REGISTRY: ShareRegistry = JSON.parse(JSON_TEXT) as ShareRegistry;
`;
}

function main(): void {
  const data = build();
  reportDuplicateIds(data);
  writeFileSync(OUT_FILE, emit(data));
  writeFileSync(REGISTRY_OUT, emitRegistry());
  const counts = (Object.keys(data) as (keyof RawData)[])
    .map((k) => `${k}=${data[k].length}`)
    .join(", ");
  console.log(`Wrote ${OUT_FILE}\n  ${counts}`);
  console.log(`Wrote ${REGISTRY_OUT}`);
}

main();
