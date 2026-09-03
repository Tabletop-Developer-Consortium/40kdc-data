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
const children = (node: JsonNode): JsonNode[] => [...arr(node.selectionEntries), ...arr(node.selectionEntryGroups), ...arr(node.entryLinks)];

export function collectPeerGroups(unit: JsonNode): JsonNode[] {
  const found: JsonNode[] = [];
  const visit = (node: JsonNode): void => {
    if (arr(node.selectionEntries).filter((entry) => entry.type === "model").length >= 2) found.push(node);
    for (const child of [...arr(node.selectionEntries), ...arr(node.selectionEntryGroups)]) visit(child);
  };
  visit(unit);
  return found;
}

function externalId(entity: JsonNode): string | undefined {
  return arr(entity.external_refs).find((ref) => ref.namespace === "bsdata")?.id as string | undefined;
}

export function makeEquipmentResolver(entities: JsonNode[], unitId: string): (link: JsonNode) => string | undefined {
  const byExternal = new Map(entities.map((entity) => [externalId(entity), str(entity.id)]).filter((pair): pair is [string, string] => !!pair[0] && !!pair[1]));
  const ids = new Set(entities.map((entity) => str(entity.id)).filter((id): id is string => !!id));
  return (link) => {
    const exact = str(link.targetId) ? byExternal.get(str(link.targetId)!) : undefined;
    if (exact) return exact;
    const name = str(link.name);
    if (!name) return undefined;
    let slug: string;
    try { slug = nameToId(name); } catch { return undefined; }
    if (ids.has(`${slug}-${unitId}`)) return `${slug}-${unitId}`;
    return ids.has(slug) ? slug : undefined;
  };
}

function fixedEquipment(peer: JsonNode): JsonNode[] {
  const result: JsonNode[] = [];
  const visit = (node: JsonNode): void => {
    for (const link of arr(node.entryLinks)) {
      const min = constraint(link, "min");
      if (link.type === "selectionEntry" && (min === undefined || min > 0)) result.push(link);
    }
    for (const entry of arr(node.selectionEntries)) if ((constraint(entry, "min") ?? 1) > 0) visit(entry);
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

export function projectUnit(unit: JsonNode, rows: JsonNode[], equipment: JsonNode[], unitId: string): VariantIssue[] {
  const issues: VariantIssue[] = [];
  const resolve = makeEquipmentResolver(equipment, unitId);
  const grouped = new Map<string, { variants: LoadoutVariant[]; budgets: LoadoutVariantBudget[] }>();
  for (const group of collectPeerGroups(unit)) {
    const peers = arr(group.selectionEntries).filter((entry) => entry.type === "model");
    const base = normModelName(str(peers[0]?.name) ?? "");
    const bucket = grouped.get(base) ?? { variants: [], budgets: [] };
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
      bucket.variants.push({ name, weapon_ids: ids as string[], ...(max ? { max_count: max } : {}) });
      names.push(name);
    }
    const budget = projectBudget(group, names);
    if (budget) bucket.budgets.push(budget);
    grouped.set(base, bucket);
  }
  for (const row of rows) {
    const projected = grouped.get(normModelName(str(row.name) ?? ""));
    if (!projected?.variants.length) continue;
    row.loadout_variants = projected.variants;
    if (projected.budgets.length) row.loadout_variant_budgets = projected.budgets;
    else delete row.loadout_variant_budgets;
  }
  return issues;
}

function walk(root: JsonNode, visitor: (node: JsonNode) => void): void { visitor(root); for (const child of children(root)) walk(child, visitor); }
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
  const allNodes = new Map<string, JsonNode>();
  for (const doc of catalogues) walk((doc.catalogue ?? doc.gameSystem) as JsonNode, (node) => { const id = str(node.id); if (id) allNodes.set(id, node); });
  const staged: StagedWrite[] = [];
  for (const faction of factions) {
    const dir = path.join(core, faction);
    const units = readJson(path.join(dir, "units.json")) as JsonNode[];
    const compositionsPath = path.join(dir, "unit-compositions.json");
    if (!fs.existsSync(compositionsPath)) continue;
    const compositions = readJson(compositionsPath) as JsonNode[];
    const equipment = ["weapons.json", "wargear.json"].flatMap((file) => fs.existsSync(path.join(dir, file)) ? readJson(path.join(dir, file)) as JsonNode[] : []);
    const issues: VariantIssue[] = [];
    for (const repoUnit of units) {
      const source = externalId(repoUnit) ? allNodes.get(externalId(repoUnit)!) : undefined;
      const composition = compositions.find((item) => item.unit_id === repoUnit.id);
      if (source && composition) issues.push(...projectUnit(source, arr(composition.models), equipment, str(repoUnit.id)!));
    }
    const original = fs.readFileSync(compositionsPath, "utf8");
    const text = `${JSON.stringify(compositions, null, 2)}\n`;
    if (text !== original) staged.push({ path: compositionsPath, value: compositions, text });
    staged.push({
      path: path.join(core, "_reports", `_bsdata-loadout-variants-unresolved.${faction}.json`),
      value: issues,
    });
    console.log(`[bsdata-loadout-variants] ${faction}: ${issues.length} unresolved`);
  }
  await applyWrites(staged, { write: !!opts.write, label: "bsdata-loadout-variants" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
