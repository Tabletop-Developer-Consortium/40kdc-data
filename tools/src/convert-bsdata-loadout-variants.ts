import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { nameToId } from "./converters/id-generator.js";
import { applyWrites, type StagedWrite } from "./mfm/apply.js";
import { REPO_ROOT } from "./mfm/repo-files.js";
import { normModelName } from "./convert-bsdata-wargear.js";
import { JjRevisionTree, parseRevision, resolveLinks } from "./mfm/bsdata-backstop.js";

export type JsonNode = Record<string, unknown>;
export interface LoadoutVariant { name: string; weapon_ids: string[]; max_count?: number }
export interface LoadoutVariantBudget { variant_names: string[]; count: number; per_models: number; scope: "unit" | "model-row" }
export interface VariantIssue { unit: string; model_row: string; variant: string; item: string; reason: string }

const arr = (value: unknown): JsonNode[] => Array.isArray(value) ? value.filter((v): v is JsonNode => !!v && typeof v === "object" && !Array.isArray(v)) : [];
const str = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const constraints = (node: JsonNode, type: string): JsonNode[] => arr(node.constraints).filter((c) => c.type === type && c.field === "selections");
const constraint = (node: JsonNode, type: string): number | undefined => constraints(node, type).map((c) => c.value).find((v): v is number => typeof v === "number");
const children = (node: JsonNode): JsonNode[] => [
  ...arr(node.selectionEntries),
  ...arr(node.sharedSelectionEntries),
  ...arr(node.selectionEntryGroups),
  ...arr(node.sharedSelectionEntryGroups),
  ...arr(node.entryLinks),
];

export function collectPeerGroups(unit: JsonNode): JsonNode[] {
  const found: JsonNode[] = [];
  const visit = (node: JsonNode): void => {
    const peers = arr(node.selectionEntries).filter((entry) => entry.type === "model");
    const sameModel = new Set(peers.map((entry) => normModelName(str(entry.name) ?? ""))).size === 1;
    const allOptional = peers.every((entry) => (constraint(entry, "min") ?? 0) === 0);
    if (peers.length >= 2 && (sameModel || allOptional)) found.push(node);
    for (const child of [...arr(node.selectionEntries), ...arr(node.selectionEntryGroups)]) visit(child);
  };
  visit(unit);
  return found;
}

function externalId(entity: JsonNode): string | undefined {
  return arr(entity.external_refs).find((ref) => ref.namespace === "bsdata")?.id as string | undefined;
}

export function makeEquipmentResolver(entities: JsonNode[], unitId: string, factionUnitIds: readonly string[] = []): (link: JsonNode) => string | undefined {
  const byExternal = new Map<string, string[]>();
  for (const entity of entities) {
    const sourceId = externalId(entity);
    const entityId = str(entity.id);
    if (sourceId && entityId) byExternal.set(sourceId, [...(byExternal.get(sourceId) ?? []), entityId]);
  }
  const ids = new Set(entities.map((entity) => str(entity.id)).filter((id): id is string => !!id));
  const owner = (id: string): string | undefined => factionUnitIds
    .filter((candidate) => id.endsWith(`-${candidate}`))
    .sort((left, right) => right.length - left.length)[0];
  return (link) => {
    const sourceId = str(link.targetId) ?? str(link.id);
    const exactCandidates = sourceId ? byExternal.get(sourceId) ?? [] : [];
    const exact = exactCandidates.find((id) => owner(id) === unitId)
      ?? exactCandidates.find((id) => owner(id) === undefined);
    if (exact) return exact;
    const name = str(link.name);
    if (!name) return undefined;
    let slug: string;
    try { slug = nameToId(name); } catch { return undefined; }
    if (ids.has(`${slug}-${unitId}`)) return `${slug}-${unitId}`;
    return ids.has(slug) && owner(slug) === undefined ? slug : undefined;
  };
}

function fixedEquipment(peer: JsonNode): JsonNode[] {
  const result: JsonNode[] = [];
  const visit = (node: JsonNode): void => {
    for (const link of arr(node.entryLinks)) {
      const min = constraint(link, "min");
      if (link.type === "selectionEntry" && (min === undefined || min > 0) && !/ upgrade$/i.test(str(link.name) ?? "")) result.push(link);
    }
    for (const entry of arr(node.selectionEntries)) {
      if ((constraint(entry, "min") ?? 1) <= 0) continue;
      if (arr(entry.profiles).some((profile) => / weapons$/i.test(str(profile.typeName) ?? ""))) result.push(entry);
      visit(entry);
    }
    for (const group of arr(node.selectionEntryGroups)) {
      const defaultId = str(group.defaultSelectionEntryId);
      const selected = defaultId ? children(group).find((item) => item.id === defaultId) : undefined;
      if (selected) visit(selected);
    }
  };
  visit(peer);
  return result;
}

export function projectBudget(group: JsonNode, names: string[]): LoadoutVariantBudget | undefined {
  const count = constraint(group, "max");
  if (!count || names.length < 2) return undefined;
  const increments = arr(group.modifiers).filter((m) => m.type === "increment" && typeof m.value === "number");
  if (!increments.length) return { variant_names: names, count, per_models: 0, scope: "model-row" };
  if (increments.length !== 1 || increments[0].value !== count) return undefined;
  const condition = arr(increments[0].conditions)[0];
  const threshold = condition?.value;
  if (condition?.type !== "atLeast" || condition?.childId !== "model" || typeof threshold !== "number") return undefined;
  const perModels = threshold / 2;
  if (!Number.isInteger(perModels) || perModels < count) return undefined;
  return { variant_names: names, count, per_models: perModels, scope: "unit" };
}

export function projectUnit(unit: JsonNode, rows: JsonNode[], equipment: JsonNode[], unitId: string, factionUnitIds: readonly string[] = []): VariantIssue[] {
  const issues: VariantIssue[] = [];
  const resolve = makeEquipmentResolver(equipment, unitId, factionUnitIds);
  const grouped = new Map<string, { rowName: string; variants: LoadoutVariant[]; budgets: LoadoutVariantBudget[] }>();
  for (const group of collectPeerGroups(unit)) {
    const peers = arr(group.selectionEntries).filter((entry) => entry.type === "model");
    const base = normModelName(str(peers[0]?.name) ?? "");
    const bucket = grouped.get(base) ?? { rowName: str(peers[0]?.name) ?? "", variants: [], budgets: [] };
    const names: string[] = [];
    for (const peer of peers) {
      const name = str(peer.name) ?? "unnamed";
      const links = fixedEquipment(peer);
      const ids = links.map(resolve);
      const unresolved = ids.findIndex((id) => !id);
      if (unresolved >= 0 || ids.length === 0) {
        issues.push({ unit: unitId, model_row: base, variant: name, item: str(links[unresolved]?.name) ?? "(no fixed equipment)", reason: "unresolved equipment" });
        continue;
      }
      const max = constraint(peer, "max");
      const variant = { name, weapon_ids: ids as string[], ...(max ? { max_count: max } : {}) };
      const existing = bucket.variants.find((item) => item.name === name);
      if (!existing) bucket.variants.push(variant);
      else if (JSON.stringify(existing.weapon_ids) === JSON.stringify(variant.weapon_ids)) {
        const mergedMax = Math.max(existing.max_count ?? 0, variant.max_count ?? 0);
        if (mergedMax > 0) existing.max_count = mergedMax;
      } else {
        issues.push({ unit: unitId, model_row: base, variant: name, item: name, reason: "conflicting duplicate variant" });
      }
      names.push(name);
    }
    const budget = projectBudget(group, names);
    if (budget) bucket.budgets.push(budget);
    grouped.set(base, bucket);
  }
  for (const projected of grouped.values()) {
    if (!projected.variants.length) continue;
    const row = rows.find((candidate) => str(candidate.name)?.toLocaleLowerCase("en") === projected.rowName.toLocaleLowerCase("en"))
      ?? rows.find((candidate) => normModelName(str(candidate.name) ?? "") === normModelName(projected.rowName));
    if (!row) continue;
    row.loadout_variants = projected.variants;
    if (projected.budgets.length) row.loadout_variant_budgets = projected.budgets;
    else delete row.loadout_variant_budgets;
  }
  return issues;
}

function walk(root: JsonNode, visitor: (node: JsonNode) => void): void { visitor(root); for (const child of children(root)) walk(child, visitor); }
export function collectSourceNodes(catalogues: JsonNode[]): Map<string, JsonNode> {
  const nodes = new Map<string, JsonNode>();
  for (const doc of catalogues) {
    walk((doc.catalogue ?? doc.gameSystem) as JsonNode, (node) => {
      const id = str(node.id);
      if (id) nodes.set(id, node);
    });
  }
  return nodes;
}
function readJson(file: string): unknown { return JSON.parse(fs.readFileSync(file, "utf8")); }

export async function run(argv: readonly string[]): Promise<void> {
  const cmd = new Command().option("--bsdata <path>", "11e BSData directory", path.join(REPO_ROOT, "_private", "bsdata-wh40k-11e")).option("--source-ref <rev>").option("--faction <id>").option("--write").exitOverride();
  cmd.parse(argv, { from: "user" });
  const opts = cmd.opts<{ bsdata: string; sourceRef?: string; faction?: string; write?: boolean }>();
  const core = path.join(REPO_ROOT, "data", "core");
  const factions = opts.faction ? [opts.faction] : fs.readdirSync(core).filter((name) => fs.existsSync(path.join(core, name, "units.json")));
  let catalogues: JsonNode[];
  if (opts.sourceRef) {
    const tree = new JjRevisionTree(opts.bsdata);
    const revision = tree.resolveRevision(opts.sourceRef);
    const parsed = parseRevision(tree, revision);
    resolveLinks(parsed);
    catalogues = parsed.documents.map((document) => ({ [document.kind === "catalogue" ? "catalogue" : "gameSystem"]: document.root }));
  } else {
    catalogues = fs.readdirSync(opts.bsdata).filter((name) => name.endsWith(".json")).map((name) => readJson(path.join(opts.bsdata, name)) as JsonNode);
  }
  const allNodes = collectSourceNodes(catalogues);
  const staged: StagedWrite[] = [];
  let projectedUnits = 0;
  let projectedVariants = 0;
  let discoveredUnits = 0;
  let discoveredVariants = 0;
  let unresolvedVariants = 0;
  for (const faction of factions) {
    const dir = path.join(core, faction);
    const units = readJson(path.join(dir, "units.json")) as JsonNode[];
    const compositionsPath = path.join(dir, "unit-compositions.json");
    if (!fs.existsSync(compositionsPath)) continue;
    const compositions = readJson(compositionsPath) as JsonNode[];
    for (const composition of compositions) {
      for (const row of arr(composition.models)) {
        delete row.loadout_variants;
        delete row.loadout_variant_budgets;
      }
    }
    const equipment = ["weapons.json", "wargear.json"].flatMap((file) => fs.existsSync(path.join(dir, file)) ? readJson(path.join(dir, file)) as JsonNode[] : []);
    const issues: VariantIssue[] = [];
    for (const repoUnit of units) {
      const source = externalId(repoUnit) ? allNodes.get(externalId(repoUnit)!) : undefined;
      const composition = compositions.find((item) => item.unit_id === repoUnit.id);
      if (source && composition) {
        const rows = arr(composition.models);
        const peerGroups = collectPeerGroups(source).filter((group) => {
          const firstPeer = arr(group.selectionEntries).find((entry) => entry.type === "model");
          return rows.some((row) => normModelName(str(row.name) ?? "") === normModelName(str(firstPeer?.name) ?? ""));
        });
        const sourceVariantCount = peerGroups.reduce(
          (sum, group) => sum + arr(group.selectionEntries).filter((entry) => entry.type === "model").length,
          0,
        );
        if (sourceVariantCount > 0) discoveredUnits += 1;
        discoveredVariants += sourceVariantCount;
        issues.push(...projectUnit(source, rows, equipment, str(repoUnit.id)!, units.map((item) => str(item.id)).filter((id): id is string => !!id)));
        const variantCount = rows.reduce((sum, row) => sum + arr(row.loadout_variants).length, 0);
        if (variantCount > 0) projectedUnits += 1;
        projectedVariants += variantCount;
      }
    }
    const original = fs.readFileSync(compositionsPath, "utf8");
    const text = `${JSON.stringify(compositions, null, 2)}\n`;
    if (text !== original) staged.push({ path: compositionsPath, value: compositions, text });
    staged.push({
      path: path.join(core, "_reports", `_bsdata-loadout-variants-unresolved.${faction}.json`),
      value: issues,
    });
    console.log(`[bsdata-loadout-variants] ${faction}: ${issues.length} unresolved`);
    unresolvedVariants += issues.length;
  }
  console.log(`[bsdata-loadout-variants] discovered ${discoveredVariants} source variants across ${discoveredUnits} units; projected ${projectedVariants} variants across ${projectedUnits} units; ${unresolvedVariants} unresolved`);
  await applyWrites(staged, { write: !!opts.write, label: "bsdata-loadout-variants" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
