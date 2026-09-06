import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { loadDump, type MfmDump } from "./loader.js";
import { REPO_ROOT } from "./repo-files.js";

export type BsdataProfileType =
  | "unit"
  | "ranged-weapon"
  | "melee-weapon"
  | "transport";

const SAFE_SCALAR =
  /^(?:-?\d+(?:\.\d+)?(?:\+|")?|(?:\d+)?D(?:3|6)(?:[+-]\d+)?|Melee|N\/?A|-)$/i;
const ALLOWED_PROFILE_TYPES: ReadonlyMap<string, BsdataProfileType> = new Map([
  ["unit", "unit"],
  ["ranged weapons", "ranged-weapon"],
  ["melee weapons", "melee-weapon"],
  ["transport", "transport"],
] as const);
const ALLOWED_CHARACTERISTICS: ReadonlyMap<string, string> = new Map([
  ["m", "movement"],
  ["movement", "movement"],
  ["t", "toughness"],
  ["toughness", "toughness"],
  ["sv", "save"],
  ["save", "save"],
  ["insv", "invulnerable-save"],
  ["invulnerable save", "invulnerable-save"],
  ["w", "wounds"],
  ["wounds", "wounds"],
  ["ld", "leadership"],
  ["leadership", "leadership"],
  ["oc", "objective-control"],
  ["objective control", "objective-control"],
  ["range", "range"],
  ["a", "attacks"],
  ["attacks", "attacks"],
  ["bs", "ballistic-skill"],
  ["ballistic skill", "ballistic-skill"],
  ["ws", "weapon-skill"],
  ["weapon skill", "weapon-skill"],
  ["s", "strength"],
  ["strength", "strength"],
  ["ap", "armour-penetration"],
  ["armour penetration", "armour-penetration"],
  ["d", "damage"],
  ["damage", "damage"],
  ["capacity", "capacity"],
] as const);

export interface RevisionTree {
  resolveRevision(ref: string): string;
  listFiles(commit: string): readonly string[];
  readFile(commit: string, file: string): string;
}

export interface BsdataWarning {
  kind: string;
  source_file?: string;
  pointer?: string;
  id?: string;
  target_id?: string;
  evidence?: readonly { source_file: string; pointer: string; id: string }[];
}

export interface BsdataProfileFact {
  name: string;
  type: BsdataProfileType;
  characteristics: Readonly<Record<string, number | string>>;
}

export interface BsdataEntryFact {
  source_file: string;
  pointer: string;
  id: string;
  name: string;
  entry_type?: string;
  hidden: boolean;
  points?: number;
  category_hints: readonly string[];
  profiles: readonly BsdataProfileFact[];
}

export interface BsdataResolutionHop {
  kind: "catalogue-link" | "game-system" | "entry-link";
  source_file: string;
  pointer: string;
  target_file: string;
  target_pointer?: string;
  target_id: string;
}

export interface BsdataLinkResolution {
  source_file: string;
  pointer: string;
  id: string;
  target_id: string;
  target_file: string;
  target_pointer: string;
  chain: readonly BsdataResolutionHop[];
}

export interface MechanicalDifference {
  kind: string;
  key: string;
  mfm?: readonly (number | string)[];
  bsdata?: readonly (number | string)[];
}

export interface BsdataBackstopReport {
  schema_version: 1;
  source: {
    requested_ref: string;
    resolved_commit: string;
    files: number;
  };
  mfm: {
    data_version: number | null;
  };
  summary: {
    entries: number;
    profiles: number;
    resolved_links: number;
    mechanical_differences: number;
    heuristic_warnings: number;
    parser_warnings: number;
  };
  facts: readonly BsdataEntryFact[];
  links: readonly BsdataLinkResolution[];
  mechanical_differences: readonly MechanicalDifference[];
  heuristic_warnings: readonly BsdataWarning[];
  parser_warnings: readonly BsdataWarning[];
}

interface SourceImport {
  targetId: string;
  pointer: string;
}

export interface SourceDocument {
  file: string;
  kind: "game-system" | "catalogue";
  id: string;
  root: Record<string, unknown>;
  imports: readonly SourceImport[];
}

interface NodeReference {
  source: SourceDocument;
  pointer: string;
  id: string;
  node: Record<string, unknown>;
}

interface LinkReference {
  source: SourceDocument;
  pointer: string;
  id: string;
  targetId: string;
}

export interface ParsedRevision {
  documents: readonly SourceDocument[];
  gameSystem: SourceDocument;
  facts: readonly BsdataEntryFact[];
  nodes: readonly NodeReference[];
  links: readonly LinkReference[];
  parserWarnings: BsdataWarning[];
  heuristicWarnings: BsdataWarning[];
}

interface ProfileContract {
  profileTypes: ReadonlyMap<string, BsdataProfileFact["type"]>;
  characteristics: ReadonlyMap<string, string>;
  pointsCostTypeIds: ReadonlySet<string>;
}

interface MfmComparisonFacts {
  units: ReadonlyMap<string, string>;
  weapons: ReadonlyMap<string, string>;
  wargear: ReadonlyMap<string, string>;
  points: ReadonlyMap<string, readonly number[]>;
  profiles: ReadonlyMap<string, readonly Readonly<Record<string, string>>[]>;
  keywordHints: ReadonlySet<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeLabel(value: unknown): string | undefined {
  const candidate = text(value);
  if (
    !candidate ||
    candidate.length > 128 ||
    /(?:https?:\/\/|www\.|[\r\n])/i.test(candidate)
  ) {
    return undefined;
  }
  return candidate;
}

function pointerToken(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function normalizeLabel(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function safeScalar(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return SAFE_SCALAR.test(trimmed) ? trimmed : undefined;
}

function parseJsonRoot(file: string, content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Malformed BSData JSON in ${file}`);
  }
  if (!isRecord(parsed)) throw new Error(`Malformed BSData root in ${file}`);
  return parsed;
}

function readDocuments(tree: RevisionTree, commit: string): SourceDocument[] {
  const documents: SourceDocument[] = [];
  for (const file of [...tree.listFiles(commit)]
    .filter((item) => item.endsWith(".json"))
    .sort()) {
    const parsed = parseJsonRoot(file, tree.readFile(commit, file));
    const gameSystem = parsed.gameSystem;
    const catalogue = parsed.catalogue;
    if (isRecord(gameSystem) === isRecord(catalogue)) {
      throw new Error(`Expected exactly one BSData root in ${file}`);
    }
    const kind = isRecord(gameSystem) ? "game-system" : "catalogue";
    const root = (isRecord(gameSystem) ? gameSystem : catalogue) as Record<
      string,
      unknown
    >;
    const id = text(root.id);
    if (!id) throw new Error(`Missing BSData root id in ${file}`);
    const imports =
      kind === "catalogue"
        ? records(root.catalogueLinks)
            .map((item, index): SourceImport | undefined => {
              const targetId = text(item.targetId);
              return targetId
                ? { targetId, pointer: `/catalogue/catalogueLinks/${index}` }
                : undefined;
            })
            .filter((item): item is SourceImport => item !== undefined)
        : [];
    documents.push({ file, kind, id, root, imports });
  }
  return documents;
}

function profileContract(gameSystem: SourceDocument): ProfileContract {
  const profileTypes = new Map<string, BsdataProfileFact["type"]>();
  const characteristics = new Map<string, string>();
  for (const profileType of records(gameSystem.root.profileTypes)) {
    const id = text(profileType.id);
    const normalized = normalizeLabel(text(profileType.name) ?? "");
    const allowed = ALLOWED_PROFILE_TYPES.get(normalized);
    if (!id || !allowed) continue;
    profileTypes.set(id, allowed);
    for (const characteristic of records(profileType.characteristicTypes)) {
      const characteristicId = text(characteristic.id);
      const characteristicName = normalizeLabel(
        text(characteristic.name) ?? "",
      );
      const canonical = ALLOWED_CHARACTERISTICS.get(characteristicName);
      if (characteristicId && canonical)
        characteristics.set(characteristicId, canonical);
    }
  }
  const pointsCostTypeIds = new Set<string>();
  for (const costType of records(gameSystem.root.costTypes)) {
    const id = text(costType.id);
    if (id && normalizeLabel(text(costType.name) ?? "") === "pts")
      pointsCostTypeIds.add(id);
  }
  return { profileTypes, characteristics, pointsCostTypeIds };
}

function extractProfiles(
  node: Record<string, unknown>,
  pointer: string,
  contract: ProfileContract,
  warnings: BsdataWarning[],
  sourceFile: string,
): BsdataProfileFact[] {
  const result: BsdataProfileFact[] = [];
  for (const [profileIndex, profile] of records(node.profiles).entries()) {
    const profileTypeId = text(profile.typeId);
    const profileType = profileTypeId
      ? contract.profileTypes.get(profileTypeId)
      : undefined;
    if (!profileType) continue;
    const characteristics: Record<string, number | string> = {};
    for (const [characteristicIndex, characteristic] of records(
      profile.characteristics,
    ).entries()) {
      const characteristicId = text(characteristic.typeId);
      const canonical = characteristicId
        ? contract.characteristics.get(characteristicId)
        : undefined;
      if (!canonical) continue;
      const value = safeScalar(characteristic.$text);
      if (value === undefined) {
        warnings.push({
          kind: "rejected-characteristic-value",
          source_file: sourceFile,
          pointer: `${pointer}/profiles/${profileIndex}/characteristics/${characteristicIndex}/$text`,
          id: characteristicId,
        });
        continue;
      }
      characteristics[canonical] = value;
    }
    const profileName = safeLabel(profile.name);
    if (text(profile.name) && !profileName) {
      warnings.push({
        kind: "rejected-profile-name",
        source_file: sourceFile,
        pointer: `${pointer}/profiles/${profileIndex}/name`,
        id: text(profile.id),
      });
    }
    result.push({
      name: profileName ?? safeLabel(node.name) ?? text(node.id) ?? "unnamed",
      type: profileType,
      characteristics,
    });
  }
  return result;
}

function extractPoints(
  node: Record<string, unknown>,
  contract: ProfileContract,
): number | undefined {
  const values = records(node.costs)
    .filter((cost) => {
      const typeId = text(cost.typeId);
      return typeId !== undefined && contract.pointsCostTypeIds.has(typeId);
    })
    .map((cost) => cost.value)
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );
  return values.length
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined;
}

function walkDocument(
  source: SourceDocument,
  contract: ProfileContract,
  parserWarnings: BsdataWarning[],
  heuristicWarnings: BsdataWarning[],
): {
  facts: BsdataEntryFact[];
  nodes: NodeReference[];
  links: LinkReference[];
} {
  const facts: BsdataEntryFact[] = [];
  const nodes: NodeReference[] = [];
  const links: LinkReference[] = [];
  const rootPointer =
    source.kind === "game-system" ? "/gameSystem" : "/catalogue";
  const entryKeys = ["selectionEntries", "sharedSelectionEntries"] as const;
  const groupKeys = [
    "selectionEntryGroups",
    "sharedSelectionEntryGroups",
  ] as const;

  const recordFact = (
    node: Record<string, unknown>,
    pointer: string,
    id: string,
  ): void => {
    const categoryHints: string[] = [];
    for (const [categoryIndex, category] of records(
      node.categoryLinks,
    ).entries()) {
      const label = safeLabel(category.name);
      if (label) categoryHints.push(label);
      else if (text(category.name)) {
        parserWarnings.push({
          kind: "rejected-category-label",
          source_file: source.file,
          pointer: `${pointer}/categoryLinks/${categoryIndex}/name`,
          id: text(category.id),
        });
      }
    }
    categoryHints.sort((left, right) => left.localeCompare(right));
    const profiles = extractProfiles(
      node,
      pointer,
      contract,
      parserWarnings,
      source.file,
    );
    const name = safeLabel(node.name);
    if (text(node.name) && !name) {
      parserWarnings.push({
        kind: "rejected-entry-name",
        source_file: source.file,
        pointer,
        id,
      });
    }
    const points = extractPoints(node, contract);
    const fact: BsdataEntryFact = {
      source_file: source.file,
      pointer,
      id,
      name: name ?? id,
      ...(text(node.type) ? { entry_type: text(node.type) } : {}),
      hidden: node.hidden === true,
      ...(points !== undefined ? { points } : {}),
      category_hints: categoryHints,
      profiles,
    };
    facts.push(fact);
    if (fact.hidden) {
      heuristicWarnings.push({
        kind: "hidden-entry",
        source_file: source.file,
        pointer,
        id,
      });
    }
    if (
      [fact.name, ...categoryHints].some((value) =>
        normalizeLabel(value).includes("crusade"),
      )
    ) {
      heuristicWarnings.push({
        kind: "crusade-entry",
        source_file: source.file,
        pointer,
        id,
      });
    }
  };

  const visitContainer = (
    container: Record<string, unknown>,
    pointer: string,
  ): void => {
    for (const key of entryKeys) {
      for (const [index, node] of records(container[key]).entries()) {
        visitNode(node, `${pointer}/${key}/${index}`);
      }
    }
    for (const key of groupKeys) {
      for (const [index, node] of records(container[key]).entries()) {
        visitNode(node, `${pointer}/${key}/${index}`);
      }
    }
    for (const [index, link] of records(container.entryLinks).entries()) {
      const id = text(link.id);
      const targetId = text(link.targetId);
      const linkPointer = `${pointer}/entryLinks/${index}`;
      if (id && targetId) {
        links.push({ source, pointer: linkPointer, id, targetId });
        recordFact(link, linkPointer, id);
      } else {
        parserWarnings.push({
          kind: "malformed-entry-link",
          source_file: source.file,
          pointer: linkPointer,
        });
      }
      visitContainer(link, linkPointer);
    }
  };

  const visitNode = (node: Record<string, unknown>, pointer: string): void => {
    const id = text(node.id);
    if (!id) {
      parserWarnings.push({
        kind: "entry-without-id",
        source_file: source.file,
        pointer,
      });
      visitContainer(node, pointer);
      return;
    }
    nodes.push({ source, pointer, id, node });
    recordFact(node, pointer, id);
    visitContainer(node, pointer);
  };

  visitContainer(source.root, rootPointer);
  return { facts, nodes, links };
}

function warningSort(left: BsdataWarning, right: BsdataWarning): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

export function parseRevision(tree: RevisionTree, commit: string): ParsedRevision {
  const documents = readDocuments(tree, commit);
  const gameSystems = documents.filter(
    (document) => document.kind === "game-system",
  );
  if (gameSystems.length !== 1)
    throw new Error(
      `Expected one BSData game system, found ${gameSystems.length}`,
    );
  const gameSystem = gameSystems[0];
  for (const document of documents) {
    if (document.kind !== "catalogue") continue;
    const gameSystemId = text(document.root.gameSystemId);
    if (gameSystemId !== gameSystem.id) {
      throw new Error(
        `Catalogue ${document.file} targets an unexpected game system`,
      );
    }
  }

  const contract = profileContract(gameSystem);
  const parserWarnings: BsdataWarning[] = [];
  const heuristicWarnings: BsdataWarning[] = [];
  const facts: BsdataEntryFact[] = [];
  const nodes: NodeReference[] = [];
  const links: LinkReference[] = [];
  for (const document of documents) {
    const walked = walkDocument(
      document,
      contract,
      parserWarnings,
      heuristicWarnings,
    );
    facts.push(...walked.facts);
    nodes.push(...walked.nodes);
    links.push(...walked.links);
  }

  const byId = new Map<string, NodeReference[]>();
  for (const node of nodes) {
    const group = byId.get(node.id) ?? [];
    group.push(node);
    byId.set(node.id, group);
  }
  for (const [id, duplicates] of byId) {
    const files = new Set(duplicates.map((item) => item.source.file));
    if (files.size < 2) continue;
    parserWarnings.push({
      kind: "duplicate-entry-id",
      id,
      evidence: duplicates
        .map((item) => ({
          source_file: item.source.file,
          pointer: item.pointer,
          id,
        }))
        .sort((left, right) =>
          `${left.source_file}${left.pointer}`.localeCompare(
            `${right.source_file}${right.pointer}`,
          ),
        ),
    });
  }

  return {
    documents,
    gameSystem,
    facts: facts.sort((left, right) =>
      `${left.source_file}${left.pointer}`.localeCompare(
        `${right.source_file}${right.pointer}`,
      ),
    ),
    nodes,
    links,
    parserWarnings: parserWarnings.sort(warningSort),
    heuristicWarnings: heuristicWarnings.sort(warningSort),
  };
}

function importPath(
  source: SourceDocument,
  target: SourceDocument,
  documentsById: ReadonlyMap<string, readonly SourceDocument[]>,
  gameSystem: SourceDocument,
): BsdataResolutionHop[] | undefined {
  if (source.file === target.file) return [];
  if (target.file === gameSystem.file) {
    return [
      {
        kind: "game-system",
        source_file: source.file,
        pointer:
          source.kind === "game-system"
            ? "/gameSystem"
            : "/catalogue/gameSystemId",
        target_file: gameSystem.file,
        target_id: gameSystem.id,
      },
    ];
  }
  const queue: Array<{
    document: SourceDocument;
    chain: BsdataResolutionHop[];
  }> = [{ document: source, chain: [] }];
  const visited = new Set([source.file]);
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of current.document.imports) {
      const candidates = documentsById.get(edge.targetId) ?? [];
      if (candidates.length !== 1) continue;
      const next = candidates[0];
      const hop: BsdataResolutionHop = {
        kind: "catalogue-link",
        source_file: current.document.file,
        pointer: edge.pointer,
        target_file: next.file,
        target_id: edge.targetId,
      };
      const chain = [...current.chain, hop];
      if (next.file === target.file) return chain;
      if (!visited.has(next.file)) {
        visited.add(next.file);
        queue.push({ document: next, chain });
      }
    }
  }
  return undefined;
}

export function resolveLinks(parsed: ParsedRevision): BsdataLinkResolution[] {
  const documentsById = new Map<string, SourceDocument[]>();
  for (const document of parsed.documents) {
    const group = documentsById.get(document.id) ?? [];
    group.push(document);
    documentsById.set(document.id, group);
  }
  for (const source of parsed.documents.filter(
    (document) => document.kind === "catalogue",
  )) {
    for (const imported of source.imports) {
      const candidates = documentsById.get(imported.targetId) ?? [];
      if (candidates.length === 0) {
        parsed.parserWarnings.push({
          kind: "unresolved-catalogue-import",
          source_file: source.file,
          pointer: imported.pointer,
          target_id: imported.targetId,
        });
      } else if (candidates.length > 1) {
        parsed.parserWarnings.push({
          kind: "ambiguous-catalogue-import",
          source_file: source.file,
          pointer: imported.pointer,
          target_id: imported.targetId,
        });
      }
    }
  }

  const nodesById = new Map<string, NodeReference[]>();
  for (const node of parsed.nodes) {
    const group = nodesById.get(node.id) ?? [];
    group.push(node);
    nodesById.set(node.id, group);
  }
  const result: BsdataLinkResolution[] = [];
  for (const link of parsed.links) {
    const candidates = (nodesById.get(link.targetId) ?? [])
      .map((target) => ({
        target,
        chain: importPath(
          link.source,
          target.source,
          documentsById,
          parsed.gameSystem,
        ),
      }))
      .filter(
        (
          item,
        ): item is { target: NodeReference; chain: BsdataResolutionHop[] } =>
          item.chain !== undefined,
      );
    if (candidates.length !== 1) {
      parsed.parserWarnings.push({
        kind: candidates.length
          ? "ambiguous-entry-link"
          : "unresolved-entry-link",
        source_file: link.source.file,
        pointer: link.pointer,
        id: link.id,
        target_id: link.targetId,
      });
      continue;
    }
    const { target, chain } = candidates[0];
    result.push({
      source_file: link.source.file,
      pointer: link.pointer,
      id: link.id,
      target_id: link.targetId,
      target_file: target.source.file,
      target_pointer: target.pointer,
      chain: [
        ...chain,
        {
          kind: "entry-link",
          source_file: link.source.file,
          pointer: link.pointer,
          target_file: target.source.file,
          target_pointer: target.pointer,
          target_id: link.targetId,
        },
      ],
    });
  }
  parsed.parserWarnings.sort(warningSort);
  return result.sort((left, right) =>
    `${left.source_file}${left.pointer}`.localeCompare(
      `${right.source_file}${right.pointer}`,
    ),
  );
}

function associateLinkFacts(
  facts: readonly BsdataEntryFact[],
  links: readonly BsdataLinkResolution[],
): BsdataEntryFact[] {
  const byLocation = new Map(
    facts.map((fact) => [`${fact.source_file}\0${fact.pointer}`, fact]),
  );
  const resolvedByLink = new Map(
    links.map((link) => [
      `${link.source_file}\0${link.pointer}`,
      byLocation.get(`${link.target_file}\0${link.target_pointer}`),
    ]),
  );
  return facts.map((fact) => {
    const target = resolvedByLink.get(`${fact.source_file}\0${fact.pointer}`);
    if (!target) return fact;
    return {
      ...fact,
      name: target.name,
      ...(fact.entry_type
        ? {}
        : target.entry_type
          ? { entry_type: target.entry_type }
          : {}),
      category_hints: [
        ...new Set([...fact.category_hints, ...target.category_hints]),
      ].sort((left, right) => left.localeCompare(right)),
    };
  });
}

export function classifyBsdataFact(
  fact: BsdataEntryFact,
): "unit" | "weapon" | "wargear" | null {
  const profileTypes = new Set(fact.profiles.map((profile) => profile.type));
  const normalizedType = normalizeLabel(fact.entry_type ?? "");
  const categories = fact.category_hints.map(normalizeLabel);
  if (
    profileTypes.has("unit") ||
    normalizedType === "unit" ||
    normalizedType === "model"
  ) {
    return "unit";
  }
  if (profileTypes.has("ranged-weapon") || profileTypes.has("melee-weapon"))
    return "weapon";
  if (
    categories.some(
      (value) => value.includes("wargear") || value.includes("equipment"),
    )
  ) {
    return "wargear";
  }
  return null;
}

function normalizedNames(
  facts: readonly BsdataEntryFact[],
  kind: "unit" | "weapon" | "wargear",
): Map<string, string> {
  const result = new Map<string, string>();
  for (const fact of facts) {
    if (classifyBsdataFact(fact) === kind) {
      result.set(normalizeLabel(fact.name), fact.name);
    }
  }
  return result;
}

function mfmComparisonFacts(dump: MfmDump): MfmComparisonFacts {
  const units = new Map<string, string>();
  for (const row of dump.table("datasheet")) {
    const name = dump.enName(row);
    if (name) units.set(normalizeLabel(name), name);
  }
  const weapons = new Map<string, string>();
  const wargear = new Map<string, string>();
  for (const row of dump.table("wargear_item")) {
    const name = dump.enName(row);
    if (!name) continue;
    (row.wargearType === "weapon" ? weapons : wargear).set(
      normalizeLabel(name),
      name,
    );
  }
  const points = new Map<string, number[]>();
  const datasheets = dump.byId("datasheet");
  for (const row of dump.table("datasheet_points_step")) {
    const name = dump.enName(datasheets.get(row.datasheetId));
    if (!name) continue;
    const key = normalizeLabel(name);
    const values = points.get(key) ?? [];
    values.push(row.stepPoints);
    points.set(key, values);
  }
  for (const values of points.values())
    values.sort((left, right) => left - right);

  const profiles = new Map<string, Readonly<Record<string, string>>[]>();
  const addProfile = (
    name: string,
    profile: Readonly<Record<string, string>>,
  ): void => {
    const key = normalizeLabel(name);
    const values = profiles.get(key) ?? [];
    values.push(profile);
    profiles.set(key, values);
  };
  for (const row of dump.table("miniature")) {
    const name = dump.enName(row);
    if (!name) continue;
    addProfile(name, {
      movement: row.movement,
      toughness: row.toughness,
      save: row.save,
      wounds: row.wounds,
      leadership: row.leadership,
      "objective-control": row.objectiveControl,
    });
  }
  for (const row of dump.table("wargear_item_profile")) {
    const name = dump.enName(row);
    if (!name) continue;
    addProfile(name, {
      range: row.range,
      attacks: row.attacks,
      ...(row.ballisticSkill ? { "ballistic-skill": row.ballisticSkill } : {}),
      ...(row.weaponSkill ? { "weapon-skill": row.weaponSkill } : {}),
      strength: row.strength,
      "armour-penetration": row.armourPenetration,
      damage: row.damage,
    });
  }
  const keywordHints = new Set<string>();
  for (const row of dump.table("keyword")) {
    const name = dump.enName(row);
    if (name) keywordHints.add(normalizeLabel(name));
  }
  return { units, weapons, wargear, points, profiles, keywordHints };
}

function onlyIn(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
  kind: string,
  side: "mfm" | "bsdata",
): MechanicalDifference[] {
  return [...left]
    .filter(([key]) => !right.has(key))
    .map(([key, name]) => ({ kind, key, [side]: [name] }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function compareToMfm(
  facts: readonly BsdataEntryFact[],
  dump: MfmDump | undefined,
): MechanicalDifference[] {
  if (!dump) return [];
  const mfm = mfmComparisonFacts(dump);
  const bsUnits = normalizedNames(facts, "unit");
  const bsWeapons = normalizedNames(facts, "weapon");
  const bsWargear = normalizedNames(facts, "wargear");
  const differences: MechanicalDifference[] = [
    ...onlyIn(mfm.units, bsUnits, "unit-only-in-mfm", "mfm"),
    ...onlyIn(bsUnits, mfm.units, "unit-only-in-bsdata", "bsdata"),
    ...onlyIn(mfm.weapons, bsWeapons, "weapon-only-in-mfm", "mfm"),
    ...onlyIn(bsWeapons, mfm.weapons, "weapon-only-in-bsdata", "bsdata"),
    ...onlyIn(mfm.wargear, bsWargear, "wargear-only-in-mfm", "mfm"),
    ...onlyIn(bsWargear, mfm.wargear, "wargear-only-in-bsdata", "bsdata"),
  ];

  const bsPoints = new Map<string, number[]>();
  const bsProfiles = new Map<
    string,
    Readonly<Record<string, number | string>>[]
  >();
  const bsHints = new Set<string>();
  for (const fact of facts) {
    const key = normalizeLabel(fact.name);
    if (fact.points !== undefined) {
      const values = bsPoints.get(key) ?? [];
      values.push(fact.points);
      bsPoints.set(key, values);
    }
    for (const profile of fact.profiles) {
      const key = normalizeLabel(profile.name);
      const values = bsProfiles.get(key) ?? [];
      values.push(profile.characteristics);
      bsProfiles.set(key, values);
    }
    for (const hint of fact.category_hints) bsHints.add(normalizeLabel(hint));
  }
  for (const values of bsPoints.values())
    values.sort((left, right) => left - right);
  for (const [key, mfmValues] of mfm.points) {
    const bsValues = bsPoints.get(key);
    if (bsValues && JSON.stringify(mfmValues) !== JSON.stringify(bsValues)) {
      differences.push({
        kind: "points-mismatch",
        key,
        mfm: mfmValues,
        bsdata: bsValues,
      });
    }
  }
  for (const [key, mfmProfiles] of mfm.profiles) {
    const matchingBsProfiles = bsProfiles.get(key);
    if (!matchingBsProfiles) continue;
    const characteristics = new Set(
      mfmProfiles.flatMap((profile) => Object.keys(profile)),
    );
    for (const characteristic of [...characteristics].sort()) {
      const mfmValues = mfmProfiles
        .map((profile) => profile[characteristic])
        .filter((value): value is string => value !== undefined)
        .sort();
      const bsValues = matchingBsProfiles
        .map((profile) => profile[characteristic])
        .filter((value): value is number | string => value !== undefined)
        .map(String)
        .sort();
      const normalizedMfmValues = mfmValues.map(normalizeLabel);
      const normalizedBsValues = bsValues.map(normalizeLabel);
      if (
        bsValues.length &&
        JSON.stringify(normalizedMfmValues) !==
          JSON.stringify(normalizedBsValues)
      ) {
        differences.push({
          kind: "profile-characteristic-mismatch",
          key: `${key}/${characteristic}`,
          mfm: mfmValues,
          bsdata: bsValues,
        });
      }
    }
  }
  for (const hint of [...mfm.keywordHints].sort()) {
    if (!bsHints.has(hint))
      differences.push({ kind: "keyword-hint-only-in-mfm", key: hint });
  }
  return differences.sort((left, right) =>
    `${left.kind}/${left.key}`.localeCompare(`${right.kind}/${right.key}`),
  );
}

function heuristicClassificationWarnings(
  facts: readonly BsdataEntryFact[],
): BsdataWarning[] {
  const result: BsdataWarning[] = [];
  for (const fact of facts) {
    const labels = [fact.name, ...fact.category_hints].map(normalizeLabel);
    for (const kind of ["detachment", "enhancement", "stratagem"] as const) {
      if (labels.some((label) => label.includes(kind))) {
        result.push({
          kind: `heuristic-${kind}-classification`,
          source_file: fact.source_file,
          pointer: fact.pointer,
          id: fact.id,
        });
        break;
      }
    }
  }
  return result;
}

function sourceComparisonWarnings(
  facts: readonly BsdataEntryFact[],
  dump: MfmDump | undefined,
): BsdataWarning[] {
  const result: BsdataWarning[] = [
    {
      kind: "snapshot-skew-review",
      id: dump ? String(dump.version ?? "unknown") : "unknown",
    },
  ];
  if (!dump) return result;
  const mfm = mfmComparisonFacts(dump);
  const names = new Map([...mfm.units, ...mfm.weapons, ...mfm.wargear]);
  for (const fact of facts) {
    const mfmName = names.get(normalizeLabel(fact.name));
    if (mfmName && mfmName !== fact.name) {
      result.push({
        kind: "punctuation-or-rename-mismatch",
        source_file: fact.source_file,
        pointer: fact.pointer,
        id: fact.id,
      });
    }
  }
  return result;
}

/** Analyze one immutable BSData revision. Warnings never alter MFM-derived data. */
export function analyzeBsdataRevision(
  tree: RevisionTree,
  sourceRef: string,
  dump?: MfmDump,
): BsdataBackstopReport {
  const commit = tree.resolveRevision(sourceRef);
  if (!/^[0-9a-f]{40}$/.test(commit))
    throw new Error(
      `Revision did not resolve to one full commit: ${sourceRef}`,
    );
  const parsed = parseRevision(tree, commit);
  const links = resolveLinks(parsed);
  const facts = associateLinkFacts(parsed.facts, links);
  const mechanicalDifferences = compareToMfm(facts, dump);
  const heuristicWarnings = [
    ...parsed.heuristicWarnings,
    ...heuristicClassificationWarnings(facts),
    ...sourceComparisonWarnings(facts, dump),
  ].sort(warningSort);
  const profileCount = facts.reduce(
    (count, fact) => count + fact.profiles.length,
    0,
  );
  return {
    schema_version: 1,
    source: {
      requested_ref: sourceRef,
      resolved_commit: commit,
      files: parsed.documents.length,
    },
    mfm: { data_version: dump?.version ?? null },
    summary: {
      entries: facts.length,
      profiles: profileCount,
      resolved_links: links.length,
      mechanical_differences: mechanicalDifferences.length,
      heuristic_warnings: heuristicWarnings.length,
      parser_warnings: parsed.parserWarnings.length,
    },
    facts,
    links,
    mechanical_differences: mechanicalDifferences,
    heuristic_warnings: heuristicWarnings,
    parser_warnings: parsed.parserWarnings,
  };
}

export type BsdataCommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => string;

const runCommand: BsdataCommandRunner = (command, args, options) =>
  execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

export class JjRevisionTree implements RevisionTree {
  constructor(
    private readonly checkout: string,
    private readonly commandRunner: BsdataCommandRunner = runCommand,
  ) {
    if (!existsSync(checkout) || !statSync(checkout).isDirectory()) {
      throw new Error(`BSData checkout is not a directory: ${checkout}`);
    }
  }

  private jj(args: readonly string[]): string {
    return this.commandRunner("jj", args, { cwd: this.checkout });
  }

  private revision(ref: string): string {
    return /^[0-9a-f]{40}$/.test(ref) ? `commit_id(${ref})` : ref;
  }

  resolveRevision(ref: string): string {
    const output = this.jj([
      "log",
      "-r",
      this.revision(ref),
      "--no-graph",
      "-T",
      'commit_id ++ "\\n"',
    ]);
    const commits = output.split(/\r?\n/).filter(Boolean);
    if (commits.length !== 1 || !/^[0-9a-f]{40}$/.test(commits[0])) {
      throw new Error(
        `BSData source ref must resolve to exactly one commit: ${ref}`,
      );
    }
    return commits[0];
  }

  listFiles(commit: string): readonly string[] {
    return this.jj(["file", "list", "-r", this.revision(commit)])
      .split(/\r?\n/)
      .filter(Boolean);
  }

  readFile(commit: string, file: string): string {
    return this.jj([
      "file",
      "show",
      "-r",
      this.revision(commit),
      JSON.stringify(file),
    ]);
  }
}

/**
 * realpath that tolerates a not-yet-existing leaf: resolve the nearest existing
 * ancestor through symlinks, then re-append the missing trailing segments. Used
 * for both the requested output and `_private` itself, so this never throws when
 * `_private` is absent (e.g. in CI, where the gitignored dir does not exist).
 */
function realpathAllowingMissing(target: string): string {
  let existing = target;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing)
      throw new Error(`No existing ancestor for path: ${target}`);
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...suffix);
}

/** Resolve an output path through symlinks and require it to stay under `_private`. */
export function resolvePrivateOutputPath(output: string): string {
  const requested = path.isAbsolute(output)
    ? path.normalize(output)
    : path.resolve(REPO_ROOT, output);
  const resolved = realpathAllowingMissing(requested);
  const privateRoot = realpathAllowingMissing(path.join(REPO_ROOT, "_private"));
  const relative = path.relative(privateRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (!relative) return resolved;
    throw new Error(
      "BSData report output must remain under the repository _private directory",
    );
  }
  return resolved;
}

export interface BsdataCliOptions {
  bsdata: string;
  sourceRef: string;
  output: string;
}

export function parseBsdataCli(argv: readonly string[]): BsdataCliOptions {
  const command = new Command()
    .name("mfm:bsdata")
    .description(
      "Compare a pinned BSData revision to the authoritative MFM snapshot",
    )
    .requiredOption("--bsdata <checkout-directory>")
    .requiredOption("--source-ref <revision>")
    .option(
      "--output <path>",
      "private JSON report path",
      "_private/mfm/bsdata-backstop.json",
    )
    .exitOverride();
  command.parse(argv, { from: "user" });
  const options = command.opts<{
    bsdata: string;
    sourceRef: string;
    output: string;
  }>();
  return options;
}

export function runBsdataCli(argv: readonly string[]): void {
  const options = parseBsdataCli(argv);
  const checkout = realpathSync(path.resolve(process.cwd(), options.bsdata));
  const output = resolvePrivateOutputPath(options.output);
  const report = analyzeBsdataRevision(
    new JjRevisionTree(checkout),
    options.sourceRef,
    loadDump(),
  );
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `BSData backstop: ${report.summary.mechanical_differences} mechanical differences, ` +
      `${report.summary.heuristic_warnings + report.summary.parser_warnings} warnings; wrote ${output}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    runBsdataCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
