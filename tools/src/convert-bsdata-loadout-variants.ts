/**
 * convert-bsdata-loadout-variants.ts — derive `loadout_variants` for unit
 * composition models from the BSData (wh40k-11e) JSON catalogues.
 *
 * Why: `wargear-option` states a delta against a base loadout, which cannot
 * describe a squad that fields alternative *kinds* of model. BSData writes those
 * as a group of `type="model"` entries that differ by loadout, and the squad
 * allocates its models between them. `convert-bsdata-wargear.ts` reduces such a
 * group to swaps against a nominated default; where no member is privileged, or
 * a member differs by more than one weapon, the group is triaged instead of
 * expressed. Stating each variant whole removes the need for a base, so the
 * group survives intact.
 *
 * Scope: this tool only ever writes `models[].loadout_variants`. It does not
 * touch `default_weapon_ids`, wargear-options, or any other field, so it cannot
 * regress what the existing ingest already resolved.
 *
 * Input is the 11e JSON catalogues, not the 10e `.cat` XML the wargear converter
 * reads — the 11e repository publishes JSON, and unit identity comes from the
 * `bsdata` external reference rather than a name match.
 *
 * Usage:
 *   npx tsx tools/src/convert-bsdata-loadout-variants.ts [faction-id] [--write] [--report]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const BSDATA_DIR = process.env.BSDATA_DIR ?? join(REPO_ROOT, "_private", "bsdata-wh40k-11e");
const CORE_DIR = join(REPO_ROOT, "data", "core");

type Node = Record<string, any>;
type Variant = { name: string; weapon_ids: string[]; max_count?: number };

const readJSON = <T,>(path: string): T => JSON.parse(readFileSync(path, "utf-8")) as T;
const englishName = (value: unknown): string =>
  typeof value === "string" ? value : typeof (value as Node)?.en === "string" ? (value as Node).en : "";
const normalize = (s: string) => s.toLowerCase().replace(/ /g, " ").replace(/[’ʼ]/g, "'").replace(/\s+/g, " ").trim();
/** BSData names a variant "<model> w/ <loadout>"; the composition row keeps the bare model name. */
const baseModelName = (s: string) => normalize(s).replace(/\s+(w\/\s*|with\s+).*$/, "").trim();
const constraint = (node: Node, type: string): number | undefined => {
  for (const c of node.constraints ?? []) if (c.type === type) return c.value as number;
  return undefined;
};

/** Every selection entry in every catalogue, by id, so a `bsdata` reference resolves anywhere. */
function indexCatalogues(): Map<string, Node> {
  const byId = new Map<string, Node>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const record = node as Node;
    if (typeof record.id === "string" && typeof record.type === "string" && !byId.has(record.id)) byId.set(record.id, record);
    for (const value of Object.values(record)) walk(value);
  };
  for (const file of readdirSync(BSDATA_DIR).filter((f) => f.endsWith(".json"))) walk(readJSON(join(BSDATA_DIR, file)));
  return byId;
}

/** The weapons a variant model carries: its own mandatory entries and links. */
function loadoutOf(model: Node): string[] {
  const names: string[] = [];
  const collect = (node: Node): void => {
    for (const entry of [...(node.selectionEntries ?? []), ...(node.entryLinks ?? [])]) {
      if (entry.hidden === true || entry.type === "selectionEntryGroup") continue;
      // A nested group is a choice this model still makes, not part of its fixed loadout.
      if ((constraint(entry, "min") ?? 0) < 1) continue;
      const name = englishName(entry.name);
      if (name) names.push(name);
    }
    for (const group of node.selectionEntryGroups ?? []) if ((constraint(group, "min") ?? 0) >= 1) collect(group);
  };
  collect(model);
  return names;
}

/** Model variants under a unit, gathered through nested groups; the group tree is not flat. */
function variantsIn(unit: Node): { group: Node; models: Node[] }[] {
  const found: { group: Node; models: Node[] }[] = [];
  const walk = (node: Node): void => {
    for (const group of node.selectionEntryGroups ?? []) {
      const models = (group.selectionEntries ?? []).filter((e: Node) => e.type === "model" && e.hidden !== true);
      if (models.length) found.push({ group, models });
      walk(group);
    }
  };
  walk(unit);
  return found;
}

function main(): void {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const only = args.find((a) => !a.startsWith("--"));
  const byId = indexCatalogues();

  let unitsWithVariants = 0;
  let variantsWritten = 0;
  const unresolved: string[] = [];
  const changed: string[] = [];

  for (const faction of readdirSync(CORE_DIR).filter((f) => !f.startsWith("_"))) {
    if (only && faction !== only) continue;
    const unitsPath = join(CORE_DIR, faction, "units.json");
    const compsPath = join(CORE_DIR, faction, "unit-compositions.json");
    const weaponsPath = join(CORE_DIR, faction, "weapons.json");
    const wargearPath = join(CORE_DIR, faction, "wargear.json");
    if (!existsSync(unitsPath) || !existsSync(compsPath) || !existsSync(weaponsPath)) continue;

    const units = readJSON<Node[]>(unitsPath);
    const comps = readJSON<Node[]>(compsPath);
    // A loadout names weapons and wargear alike; both are equipment ids to the schema.
    const weapons = [...readJSON<Node[]>(weaponsPath), ...(existsSync(wargearPath) ? readJSON<Node[]>(wargearPath) : [])];

    // A weapon name resolves to this unit's own stat variant where one exists.
    const weaponIds = new Map<string, string[]>();
    for (const weapon of weapons) {
      const key = normalize(englishName(weapon.name));
      if (!key) continue;
      weaponIds.set(key, [...(weaponIds.get(key) ?? []), String(weapon.id)]);
    }
    // Names collide across units, and a suffix test alone mismatches: `choppa-beast-snagga-boyz`
    // also ends in `-boyz`. The base id is the shortest of the same-named ids, and this unit's
    // stat variant, where the weapon-variants pass minted one, is exactly `${base}-${unitId}`.
    const resolveWeapon = (name: string, unitId: string): string | null => {
      const candidates = weaponIds.get(normalize(name)) ?? [];
      if (!candidates.length) return null;
      const base = candidates.reduce((shortest, id) => (id.length < shortest.length ? id : shortest));
      const scoped = `${base}-${unitId}`;
      return candidates.includes(scoped) ? scoped : base;
    };

    for (const composition of comps) {
      const unitId = String(composition.unit_id);
      const unit = units.find((u) => String(u.id) === unitId);
      const reference = (unit?.external_refs ?? []).find((r: Node) => r.namespace === "bsdata");
      if (!reference) continue;
      const entry = byId.get(String(reference.id));
      if (!entry) continue;

      // Variants that share a base model name belong to the same composition row.
      const byModel = new Map<string, Variant[]>();
      for (const { models } of variantsIn(entry)) {
        if (models.length < 2 && !models.some((m) => /\s+(w\/|with)\b/i.test(englishName(m.name)))) continue;
        for (const model of models) {
          const name = englishName(model.name);
          const weaponNames = loadoutOf(model);
          if (!weaponNames.length) continue;
          const ids = weaponNames.map((w) => resolveWeapon(w, unitId));
          if (ids.some((id) => id === null)) {
            unresolved.push(`${faction} | ${unitId} | ${name} | ${weaponNames.filter((w, i) => ids[i] === null).join(", ")}`);
            continue;
          }
          const max = constraint(model, "max");
          const variant: Variant = { name, weapon_ids: [...new Set(ids as string[])] };
          if (max !== undefined) variant.max_count = max;
          byModel.set(baseModelName(name), [...(byModel.get(baseModelName(name)) ?? []), variant]);
        }
      }

      let touched = false;
      for (const model of composition.models ?? []) {
        const variants = byModel.get(baseModelName(englishName(model.name)));
        if (!variants || variants.length < 2) continue;
        // Distinct loadouts only: BSData repeats a model to state a count, not a choice.
        const distinct = [...new Map(variants.map((v) => [v.weapon_ids.slice().sort().join("|"), v])).values()];
        if (distinct.length < 2) continue;
        model.loadout_variants = distinct;
        variantsWritten += distinct.length;
        touched = true;
      }
      if (touched) {
        unitsWithVariants++;
        changed.push(`${faction} | ${unitId}`);
      }
    }
    if (write) writeFileSync(compsPath, `${JSON.stringify(comps, null, 2)}\n`);
  }

  console.log(`units given loadout_variants: ${unitsWithVariants}`);
  console.log(`variants written:             ${variantsWritten}`);
  console.log(`weapons that did not resolve: ${unresolved.length}`);
  if (args.includes("--report")) {
    for (const line of changed) console.log(`  changed    | ${line}`);
    for (const line of unresolved.slice(0, 40)) console.log(`  unresolved | ${line}`);
  }
  if (!write) console.log("(dry run — pass --write to update unit-compositions.json)");
}

main();
