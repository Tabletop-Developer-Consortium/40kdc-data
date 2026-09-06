#!/usr/bin/env node
/**
 * Dangling-reference audit for the Ability DSL.
 *
 * Two DSL positions carry values that name something defined elsewhere in the
 * dataset, yet are structurally just strings, so AJV cannot check them and the
 * semantic integrity pass does not own them:
 *
 *  - `unit-has-keyword` / `target-has-keyword` conditions, whose
 *    `parameters.keyword` operand must name a keyword some unit, faction, or
 *    keyword catalog actually defines. An unresolvable operand is dead data: the
 *    gate can never become true, and nothing reports it.
 *  - `cp-refund` / `stratagem-cost-modifier` effects, whose `modifier.stratagem`
 *    value must name a core Stratagem id. An unresolvable value points at no
 *    entity, and the translators still title-case it into readable prose.
 *
 * This module is deliberately separate from `validate-all`: the repository
 * currently contains unresolved game-state markers (`"SPOTTED"`, `"RILED UP"`)
 * used as pseudo-keywords, and classifying those is a maintainer decision rather
 * than a data defect. The audit is a zero-tolerance check that runs only when
 * invoked explicitly (`npm run audit:dangling-refs`), so it can exit nonzero on
 * every unresolved value without breaking the normal validation gates.
 */
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "glob";

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));

/** Default data root: the repository's `data/` tree. */
export const DATA_ROOT = resolve(currentDirectory, "../../data");

/** Which vocabulary a reference failed to resolve against. */
export type DanglingReferenceKind = "keyword" | "stratagem";

/**
 * The DSL node type that produced the reference. Retained on every finding so a
 * reviewer can tell an attacker gate from a target gate, and a CP refund from a
 * cost modifier, without re-reading the source record.
 */
export type DanglingReferenceType =
  | "unit-has-keyword"
  | "target-has-keyword"
  | "cp-refund"
  | "stratagem-cost-modifier";

/** One unresolved reference, located precisely enough to fix by hand. */
export interface DanglingReference {
  kind: DanglingReferenceKind;
  reference_type: DanglingReferenceType;
  /** POSIX path of the ability file, relative to the audited data root. */
  source_file: string;
  ability_id: string;
  /** JSON Pointer to the offending value, rooted at the file's top-level array. */
  path: string;
  value: string;
}

/** The core vocabularies each reference class resolves against. */
export interface ReferenceVocabularies {
  /** Keyword labels, ids, and catalog names, each passed through {@link normalizeKeyword}. */
  keywords: Set<string>;
  /** Core stratagem ids, compared exactly. */
  stratagems: Set<string>;
}

/**
 * Effect types whose `modifier.stratagem` names a core Stratagem.
 *
 * Deliberately a closed list: other effects carry a `stratagem` property as
 * display text, so matching on the property name alone would invent references
 * the schemas never promised.
 */
const STRATAGEM_EFFECT_TYPES = new Set<DanglingReferenceType>([
  "cp-refund",
  "stratagem-cost-modifier",
]);

/** Condition types whose `parameters.keyword` names a gameplay keyword. */
const KEYWORD_CONDITION_TYPES = new Set<DanglingReferenceType>([
  "unit-has-keyword",
  "target-has-keyword",
]);

/**
 * Narrow keyword normalization: trim, drop all whitespace, lowercase.
 *
 * This matches how the runtime cruncher compares keyword operands and absorbs
 * the spelling variation the sources actually contain (`VEHICLE` vs `Vehicle`,
 * `Feel No Pain` vs `feelnopain`). It deliberately stops short of the
 * display-name normalizer in `data/normalize.ts`: folding punctuation and
 * diacritics would merge distinct free-form markers and hide real defects.
 */
export function normalizeKeyword(value: string): string {
  return value.trim().replace(/\s+/gu, "").toLowerCase();
}

/** Escape one object key for use as a JSON Pointer segment (RFC 6901). */
function pointerSegment(key: string): string {
  return key.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function readArray<T>(file: string): T[] {
  return JSON.parse(readFileSync(file, "utf-8")) as T[];
}

/**
 * Discover data files under `root`, sorted for deterministic output.
 *
 * `skipUnderscoreDirs` excludes `_example`-style scratch directories. Vocabulary
 * sources use it so fixture data cannot silently widen the accepted vocabulary;
 * the enrichment scan does not, because `enrichment/_core/abilities.json` is
 * production data shared by every faction.
 */
async function dataFiles(
  root: string,
  pattern: string,
  skipUnderscoreDirs: boolean,
): Promise<string[]> {
  const matches = await glob(pattern, { cwd: root, absolute: true });
  const files = skipUnderscoreDirs
    ? matches.filter(
        (file) =>
          !relativePosix(root, file)
            .split("/")
            .slice(0, -1)
            .some((segment) => segment.startsWith("_")),
      )
    : matches;
  return files.sort();
}

/** Path of `file` relative to `root`, always with `/` separators. */
function relativePosix(root: string, file: string): string {
  const normalizedRoot = resolve(root);
  const normalizedFile = resolve(file);
  const relative = normalizedFile.startsWith(normalizedRoot + sep)
    ? normalizedFile.slice(normalizedRoot.length + sep.length)
    : normalizedFile;
  return relative.split(sep).join("/");
}

function addKeyword(into: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const normalized = normalizeKeyword(value);
  if (normalized.length > 0) into.add(normalized);
}

/**
 * Build the vocabularies every reference is resolved against.
 *
 * Keywords come from all three of the repository's keyword models: free-form
 * unit/faction display labels, the universal unit-keyword catalog, and the
 * weapon-keyword catalog (both ids and names, since authored operands use
 * either spelling). Without the catalogs, common operands such as `VEHICLE` or
 * `Lethal Hits` produce hundreds of false positives.
 *
 * Unreadable or non-array files are skipped: structural problems belong to the
 * AJV pass, and this audit must not turn a malformed file into a wall of
 * spurious dangling references.
 */
export async function buildReferenceVocabularies(
  dataRoot: string = DATA_ROOT,
): Promise<ReferenceVocabularies> {
  const root = resolve(dataRoot);
  const keywords = new Set<string>();
  const stratagems = new Set<string>();

  for (const file of await dataFiles(root, "core/**/units.json", true)) {
    let units: Array<{ keywords?: unknown; faction_keywords?: unknown }>;
    try {
      units = readArray(file);
    } catch {
      continue;
    }
    if (!Array.isArray(units)) continue;
    for (const unit of units) {
      if (unit === null || typeof unit !== "object") continue;
      for (const label of Array.isArray(unit.keywords) ? unit.keywords : []) {
        addKeyword(keywords, label);
      }
      for (const label of Array.isArray(unit.faction_keywords)
        ? unit.faction_keywords
        : []) {
        addKeyword(keywords, label);
      }
    }
  }

  for (const file of await dataFiles(root, "core/**/factions.json", true)) {
    let factions: Array<{ keywords?: unknown }>;
    try {
      factions = readArray(file);
    } catch {
      continue;
    }
    if (!Array.isArray(factions)) continue;
    for (const faction of factions) {
      if (faction === null || typeof faction !== "object") continue;
      for (const label of Array.isArray(faction.keywords)
        ? faction.keywords
        : []) {
        addKeyword(keywords, label);
      }
    }
  }

  for (const catalog of ["core/unit-keywords.json", "core/weapon-keywords.json"]) {
    let records: Array<{ id?: unknown; name?: unknown }>;
    try {
      records = readArray(resolve(root, catalog));
    } catch {
      continue;
    }
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      if (record === null || typeof record !== "object") continue;
      addKeyword(keywords, record.id);
      addKeyword(keywords, record.name);
    }
  }

  for (const file of await dataFiles(root, "core/**/stratagems.json", true)) {
    let records: Array<{ id?: unknown }>;
    try {
      records = readArray(file);
    } catch {
      continue;
    }
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      if (record === null || typeof record !== "object") continue;
      if (typeof record.id === "string" && record.id.length > 0) {
        stratagems.add(record.id);
      }
    }
  }

  return { keywords, stratagems };
}

/**
 * Visit every object in a value tree, carrying its JSON Pointer.
 *
 * The Ability DSL nests conditions and effects under triggers, conditionals,
 * sequences, choices, selectors, and resource actions, so a generic walk is the
 * only way to reach every reference site. Type-awareness lives in the visitor,
 * not the traversal.
 */
function visitObjects(
  node: unknown,
  path: string,
  visit: (node: Record<string, unknown>, path: string) => void,
): void {
  if (Array.isArray(node)) {
    node.forEach((child, index) => visitObjects(child, `${path}/${index}`, visit));
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  visit(record, path);
  for (const [key, value] of Object.entries(record)) {
    visitObjects(value, `${path}/${pointerSegment(key)}`, visit);
  }
}

/** Order findings so repeated runs and diffed reports stay byte-stable. */
function compareFindings(
  left: DanglingReference,
  right: DanglingReference,
): number {
  return (
    left.source_file.localeCompare(right.source_file) ||
    left.ability_id.localeCompare(right.ability_id) ||
    left.path.localeCompare(right.path) ||
    left.kind.localeCompare(right.kind) ||
    left.value.localeCompare(right.value)
  );
}

/**
 * Collect every enrichment ability reference that resolves to nothing.
 *
 * Keyword operands are compared after {@link normalizeKeyword}; stratagem values
 * are compared exactly, because stratagem ids are canonical kebab-case
 * identifiers rather than display labels.
 */
export async function collectDanglingAbilityReferences(
  dataRoot: string = DATA_ROOT,
): Promise<DanglingReference[]> {
  const root = resolve(dataRoot);
  const vocabularies = await buildReferenceVocabularies(root);
  const findings: DanglingReference[] = [];

  for (const file of await dataFiles(root, "enrichment/**/abilities.json", false)) {
    let abilities: Array<Record<string, unknown>>;
    try {
      abilities = readArray(file);
    } catch {
      continue; // structural problems are the AJV pass's job
    }
    if (!Array.isArray(abilities)) continue;

    const sourceFile = relativePosix(root, file);
    abilities.forEach((ability, index) => {
      if (ability === null || typeof ability !== "object") return;
      const abilityId =
        typeof ability.ability_id === "string"
          ? ability.ability_id
          : typeof ability.id === "string"
            ? ability.id
            : "";

      visitObjects(ability, `/${index}`, (node, path) => {
        const type = node.type;
        if (typeof type !== "string") return;

        if (KEYWORD_CONDITION_TYPES.has(type as DanglingReferenceType)) {
          const parameters = node.parameters;
          if (parameters !== null && typeof parameters === "object") {
            const keyword = (parameters as Record<string, unknown>).keyword;
            if (
              typeof keyword === "string" &&
              !vocabularies.keywords.has(normalizeKeyword(keyword))
            ) {
              findings.push({
                kind: "keyword",
                reference_type: type as DanglingReferenceType,
                source_file: sourceFile,
                ability_id: abilityId,
                path: `${path}/parameters/keyword`,
                value: keyword,
              });
            }
          }
        }

        if (STRATAGEM_EFFECT_TYPES.has(type as DanglingReferenceType)) {
          const modifier = node.modifier;
          if (modifier !== null && typeof modifier === "object") {
            const stratagem = (modifier as Record<string, unknown>).stratagem;
            if (
              typeof stratagem === "string" &&
              !vocabularies.stratagems.has(stratagem)
            ) {
              findings.push({
                kind: "stratagem",
                reference_type: type as DanglingReferenceType,
                source_file: sourceFile,
                ability_id: abilityId,
                path: `${path}/modifier/stratagem`,
                value: stratagem,
              });
            }
          }
        }
      });
    });
  }

  return findings.sort(compareFindings);
}

/** Render findings as the deterministic lines the command prints. */
export function formatDanglingRefs(
  findings: DanglingReference[],
  dataRoot: string = DATA_ROOT,
): string[] {
  const lines = [
    "40kdc Dangling Ability References",
    `Data root: ${resolve(dataRoot)}`,
    "",
  ];

  let currentFile = "";
  for (const finding of findings) {
    if (finding.source_file !== currentFile) {
      if (currentFile !== "") lines.push("");
      currentFile = finding.source_file;
      lines.push(currentFile);
    }
    lines.push(
      `  ${finding.ability_id || "(no ability_id)"} ${finding.path} ` +
        `${finding.kind} (${finding.reference_type}) → ${JSON.stringify(finding.value)}`,
    );
  }

  const keywordCount = findings.filter((f) => f.kind === "keyword").length;
  const stratagemCount = findings.length - keywordCount;
  if (findings.length > 0) lines.push("");
  lines.push(
    findings.length === 0
      ? "No dangling ability references."
      : `${findings.length} dangling ability reference(s): ${keywordCount} keyword, ${stratagemCount} stratagem.`,
  );
  return lines;
}

/**
 * Print every unresolved reference and fail the process when any exist.
 *
 * Zero tolerance is intentional and is why this is not wired into `build`,
 * `validate-all`, `just preflight`, or CI: it answers "does every reference
 * resolve today?", not "did we regress against a baseline?".
 */
export async function runDanglingRefsAudit(
  dataRoot: string = DATA_ROOT,
): Promise<void> {
  const findings = await collectDanglingAbilityReferences(dataRoot);
  for (const line of formatDanglingRefs(findings, dataRoot)) console.log(line);
  if (findings.length > 0) process.exitCode = 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  runDanglingRefsAudit().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
