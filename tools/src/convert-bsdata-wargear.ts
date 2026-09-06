/**
 * convert-bsdata-wargear.ts — regenerate a faction's wargear-options.json from the
 * BattleScribe (BSData) 10e catalogs in `_private/wh40k-10e/`.
 *
 * Why: the MFM dump models loadouts across ~5 prose-dependent table systems (no
 * clean structural `replaces`/count), so wargear is sourced from BSData instead.
 * `import-catalog.ts` already parses `.cat` XML + resolves entryLinks but
 * deliberately stubs out the loadout tree ("a wrong swap rule is worse than none").
 * This tool builds exactly that extractor, with a global cross-`.cat` id index
 * (faction catalogs link a shared library via `<catalogueLink>`).
 *
 * BattleScribe encodes a model's loadout options at FOUR structural levels, and
 * this extractor handles each:
 *   1. WEAPON-CHOICE GROUP — a `selectionEntryGroup` (inline OR reached via an
 *      `entryLink type="selectionEntryGroup"` to a shared group) with a
 *      `defaultSelectionEntryId` and ≥2 weapon children. The default → `replaces`,
 *      the rest → `replacement` / `replacement_choice`. (e.g. Immortals.)
 *   2. MODEL-VARIANT SWAP — a squad group whose children are ≥2 `type="model"`
 *      entries that differ only by loadout ("Warrior w/ gauss flayer" vs
 *      "…gauss reaper"). The swap is the symmetric weapon-id difference between the
 *      default model and each alternative. (e.g. Necron Warriors.)
 *   3. PURE-ADDON CHOICE — a group with no default (max 1, no min) whose children
 *      are optional add-ons → `replacement_choice` with no `replaces`. A single
 *      optional child → `replacement`. (e.g. Tomb Blades' "Wargear".)
 *   4. STANDALONE ADDON — an optional `selectionEntry`/`entryLink` (min 0, max ≥1)
 *      directly on a model or squad group → a pure add-on, with `per_n_models` /
 *      `max_count` from its constraints + model-count decrement. (e.g. Plasmacyte.)
 *
 * model_constraint:
 *   - any_number     — a per-model option in a multi-model unit that is NOT forced
 *                      "equipped identically" by a unit-wide error modifier.
 *   - per_n_models   — an addon capped by a model-count `decrement` (max N over a
 *                      `unitMaxModels`-model unit ⇒ per_n = unitMaxModels / N).
 *   - max_count      — a within-model count cap (group max > 1) or a single-model
 *                      unit's max=1.
 *   - model_name     — only when the unit has ≥2 genuinely distinct model types
 *                      (a sergeant + troopers), not for uniform squads.
 *
 * Anything that can't be reduced to a faithful option — a swap group with no
 * identifiable default, a variant delta that isn't a clean weapon-for-weapon
 * swap, a weapon BSData has that the repo lacks — is collected in the triage
 * report and NEVER fabricated. Non-weapon loadout items (shields, scopes, …)
 * resolve to existing `wargear.json` ids or are minted as clean wargear entities.
 *
 * IP: imports only structural option data + points. No rules/lore prose.
 *
 * Usage:
 *   npx tsx tools/src/convert-bsdata-wargear.ts <faction-id> [--write] [--report-only]
 *   npx tsx tools/src/convert-bsdata-wargear.ts --all [--write]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { nameToId } from "./converters/id-generator.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
// The catalogs live in the gitignored _private/. Allow an override so the tool
// can run from a jj workspace that doesn't materialize _private (symlink-free).
const BSDATA_DIR = process.env.BSDATA_DIR ?? join(REPO_ROOT, "_private", "wh40k-10e");
const CORE_DIR = join(REPO_ROOT, "data", "core");
const REPORT_DIR = join(CORE_DIR, "_reports");
const GAME_VERSION = { edition: "10th", dataslate: "2025-q3" };

// deno-lint-ignore no-explicit-any
type Node = Record<string, any>;

function asArray<T>(x: T | T[] | undefined | null): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}
function cleanText(s: string): string {
  return String(s).replace(/^[➤•]\s*/, "").trim();
}
/** Normalize a model name for matching BSData models ↔ unit-composition rows:
 *  lowercased, with a "w/ <loadout>" / "with <loadout>" suffix stripped. */
export function normModelName(s: string): string {
  return cleanText(s)
    .toLowerCase()
    .replace(/\s+(?:w\/(?=\s)|with\b).*$/, "")
    .trim();
}
function collectByKey(node: unknown, key: string, out: Node[] = []): Node[] {
  if (Array.isArray(node)) {
    for (const v of node) collectByKey(v, key, out);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) for (const e of asArray(v)) out.push(e as Node);
      collectByKey(v, key, out);
    }
  }
  return out;
}
function readJSON<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

interface ModelConstraint {
  model_name?: string;
  per_n_models?: number;
  max_count?: number;
  any_number?: boolean;
}
interface WargearOption {
  id: string;
  unit_id: string;
  model_constraint?: ModelConstraint;
  replaces?: string[];
  replacement?: string[];
  replacement_choice?: string[][];
  is_free?: boolean;
  additional_cost?: number | null;
  game_version: { edition: string; dataslate: string };
}
interface WargearEntity {
  id: string;
  name: string;
  category?: string;
  game_version: { edition: string; dataslate: string };
}

// ─────────────────────────── global catalog index ───────────────────────────

interface Catalogs {
  /** id → selectionEntry node, across every .cat (entryLink targetId resolution). */
  entryById: Map<string, Node>;
  /** id → selectionEntryGroup node, across every .cat. */
  groupById: Map<string, Node>;
  /** repo faction dir → that faction's non-library catalogue root node(s). */
  catByFaction: Map<string, Node[]>;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "#text",
  parseAttributeValue: false,
  trimValues: true,
});

// Explicit BSData `.cat` → repo faction-dir map. The repo consolidates every
// Space Marines chapter into `adeptus-astartes`, while BSData splits them into a
// shared "Space Marines" library plus per-chapter catalogues — all of which we
// attribute to `adeptus-astartes`. Library/game-system/unsupported files → null.
const CAT_TO_FACTION: Record<string, string> = {
  "Aeldari - Craftworlds": "aeldari",
  "Aeldari - Ynnari": "aeldari",
  "Aeldari - Drukhari": "drukhari",
  "Chaos - Chaos Daemons": "chaos-daemons",
  "Chaos - Chaos Knights": "chaos-knights",
  "Chaos - Chaos Space Marines": "chaos-space-marines",
  "Chaos - Death Guard": "death-guard",
  "Chaos - Emperor's Children": "emperors-children",
  "Chaos - Thousand Sons": "thousand-sons",
  "Chaos - World Eaters": "world-eaters",
  "Genestealer Cults": "genestealer-cults",
  "Imperium - Adepta Sororitas": "adepta-sororitas",
  "Imperium - Adeptus Custodes": "adeptus-custodes",
  "Imperium - Adeptus Mechanicus": "adeptus-mechanicus",
  "Imperium - Agents of the Imperium": "agents-of-the-imperium",
  "Imperium - Astra Militarum": "astra-militarum",
  "Imperium - Grey Knights": "grey-knights",
  "Imperium - Imperial Knights": "imperial-knights",
  "Leagues of Votann": "leagues-of-votann",
  "Necrons": "necrons",
  "Orks": "orks",
  "T'au Empire": "tau-empire",
  "Tyranids": "tyranids",
  // Space Marines + every chapter → adeptus-astartes
  "Imperium - Space Marines": "adeptus-astartes",
  "Imperium - Black Templars": "adeptus-astartes",
  "Imperium - Blood Angels": "adeptus-astartes",
  "Imperium - Dark Angels": "adeptus-astartes",
  "Imperium - Deathwatch": "adeptus-astartes",
  "Imperium - Imperial Fists": "adeptus-astartes",
  "Imperium - Iron Hands": "adeptus-astartes",
  "Imperium - Raven Guard": "adeptus-astartes",
  "Imperium - Salamanders": "adeptus-astartes",
  "Imperium - Space Wolves": "adeptus-astartes",
  "Imperium - Ultramarines": "adeptus-astartes",
  "Imperium - White Scars": "adeptus-astartes",
};

/** Map a `.cat` filename to a repo faction dir, or null for a library / unmapped. */
function factionForCat(file: string, repoDirs: Set<string>): string | null {
  const base = file.replace(/\.(cat|gst)$/i, "");
  const dir = CAT_TO_FACTION[base];
  return dir && repoDirs.has(dir) ? dir : null;
}

function loadCatalogs(repoDirs: Set<string>): Catalogs {
  const entryById = new Map<string, Node>();
  const groupById = new Map<string, Node>();
  const catById = new Map<string, Node>(); // catalogue id → root node
  const parsed: { root: Node; faction: string | null; links: string[] }[] = [];

  const files = readdirSync(BSDATA_DIR).filter((f) => /\.(cat|gst)$/i.test(f));
  for (const file of files) {
    const doc = parser.parse(readFileSync(join(BSDATA_DIR, file), "utf-8"));
    for (const e of collectByKey(doc, "selectionEntry")) if (e.id) entryById.set(String(e.id), e);
    for (const sharedE of collectByKey(doc, "sharedSelectionEntries")) {
      for (const e of asArray<Node>(sharedE.selectionEntry)) if (e.id) entryById.set(String(e.id), e);
    }
    for (const g of collectByKey(doc, "selectionEntryGroup")) if (g.id) groupById.set(String(g.id), g);
    const root = doc.catalogue ?? doc.gameSystem;
    if (!root) continue;
    if (root.id) catById.set(String(root.id), root);
    const links = collectByKey(doc, "catalogueLink")
      .map((l) => String(l.targetId ?? ""))
      .filter(Boolean);
    parsed.push({ root, faction: factionForCat(file, repoDirs), links });
  }

  // A faction's datasheets may live in a shared library it references via
  // `<catalogueLink>` (e.g. Craftworlds + Drukhari both draw from the Aeldari
  // Library; every Space Marine chapter from the Space Marines library). Attribute
  // the faction's own catalogue PLUS each linked library to it; the per-faction
  // repo-unit-id filter later keeps only that faction's units out of a shared lib.
  const catByFaction = new Map<string, Node[]>();
  for (const { root, faction, links } of parsed) {
    if (!faction) continue;
    const roots = catByFaction.get(faction) ?? catByFaction.set(faction, []).get(faction)!;
    roots.push(root);
    for (const tid of links) {
      const lib = catById.get(tid);
      if (lib) roots.push(lib);
    }
  }
  // Dedup roots by catalogue id (a shared library reached via several chapters).
  for (const [faction, roots] of catByFaction) {
    const seen = new Set<string>();
    catByFaction.set(
      faction,
      roots.filter((r) => {
        const id = String(r.id ?? "");
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      }),
    );
  }
  return { entryById, groupById, catByFaction };
}

// ─────────────────────────── small node helpers ───────────────────────────

/** Resolve an entryLink/selectionEntry to its display name (following targetId). */
function entryName(node: Node, cats: Catalogs): string | undefined {
  if (node.name && String(node.type) !== "selectionEntryGroup") return cleanText(String(node.name));
  if (node.targetId) {
    const t = cats.entryById.get(String(node.targetId)) ?? cats.groupById.get(String(node.targetId));
    if (t?.name) return cleanText(String(t.name));
  }
  return node.name ? cleanText(String(node.name)) : undefined;
}

/** The "pts" cost on an entry, or 0. */
function ptsCost(node: Node): number {
  for (const c of asArray<Node>(node.costs?.cost)) {
    if (String(c.name).toLowerCase() === "pts") return parseInt(String(c.value), 10) || 0;
  }
  return 0;
}
function constraintVal(node: Node, type: "min" | "max"): number | undefined {
  for (const c of asArray<Node>(node.constraints?.constraint)) {
    if (String(c.type) === type) {
      const v = parseInt(String(c.value), 10);
      if (Number.isFinite(v)) return v;
    }
  }
  return undefined;
}

/** A min/max constraint on a node, falling back to its entryLink target's (a
 * link often carries no constraint of its own — the cap lives on the target). */
function nodeConstraint(node: Node, type: "min" | "max", cats: Catalogs): number | undefined {
  const own = constraintVal(node, type);
  if (own !== undefined) return own;
  if (node.targetId) {
    const t = cats.entryById.get(String(node.targetId));
    if (t) return constraintVal(t, type);
  }
  return undefined;
}

/** An `<association max>` cap (e.g. a 1-per-unit icon/banner), if present. */
function associationMax(node: Node): number | undefined {
  for (const a of asArray<Node>(node.associations?.association)) {
    const v = parseInt(String(a.max), 10);
    if (Number.isFinite(v)) return v;
  }
  return undefined;
}

function childGroups(node: Node): Node[] {
  return asArray<Node>(node.selectionEntryGroups?.selectionEntryGroup);
}
function childEntries(node: Node): Node[] {
  return asArray<Node>(node.selectionEntries?.selectionEntry);
}
function entryLinksOf(node: Node): Node[] {
  return asArray<Node>(node.entryLinks?.entryLink);
}

/** All `type="model"` selectionEntries beneath a unit (models nest in groups). */
function modelsOf(unit: Node): Node[] {
  return collectByKey(unit, "selectionEntry").filter((e) => String(e.type) === "model");
}
/** Direct `type="model"` children of a group (model-variant detection). */
function directModelChildren(group: Node): Node[] {
  return childEntries(group).filter((e) => String(e.type) === "model");
}

// Shared campaign/bookkeeping groups that never describe weapon loadout.
const NOISE_GROUP_TARGET_IDS = new Set<string>([
  "f9da-852a-d7f0-92e9", // "Weapon Modifications" (Crusade weapon mods)
]);
// Matched anywhere in a group name — campaign/ability lists are never weapon
// loadout (e.g. "Nachmund Gauntlet Crusade Abilities", "Cryptek Abilities").
const NOISE_GROUP_NAME_RE =
  /crusade|modifications|battle (tallies|honours?|scars?|traits?)|relic|enhancement|warlord|requisition|\bagenda|abilit|abilt|\bpowers?\b|discipline|reanimation system|translocation system|command system|codex /i;
// Names that must never be minted as a wargear item even if profiled — they are
// ability/power selectors, not equipment.
const NOISE_ITEM_NAME_RE =
  /\bpowers?\b|abilit|abilt|discipline|warlord|requisition|protocol|trademark weapon/i;

/** Display name of a group node (following an entryLink to a shared group). */
function groupName(node: Node, cats: Catalogs): string {
  if (node.name) return cleanText(String(node.name));
  if (node.targetId) {
    const t = cats.groupById.get(String(node.targetId));
    if (t?.name) return cleanText(String(t.name));
  }
  return "";
}
function isNoiseGroup(node: Node, cats: Catalogs): boolean {
  if (node.targetId && NOISE_GROUP_TARGET_IDS.has(String(node.targetId))) return true;
  return NOISE_GROUP_NAME_RE.test(groupName(node, cats));
}
/** A hidden entry/link (or one whose target is hidden) is not player-selectable. */
function isHidden(node: Node, cats: Catalogs): boolean {
  if (String(node.hidden) === "true") return true;
  if (node.targetId) {
    const t = cats.entryById.get(String(node.targetId)) ?? cats.groupById.get(String(node.targetId));
    if (t && String(t.hidden) === "true") return true;
  }
  return false;
}

/** A group node directly, or the shared group an entryLink points to. */
function resolveGroup(node: Node, cats: Catalogs): Node | null {
  if (String(node.type) === "selectionEntryGroup") {
    return node.targetId ? cats.groupById.get(String(node.targetId)) ?? null : node;
  }
  return node;
}

/** Largest model max-constraint in a unit (squad size), else 1. */
function unitMaxModels(unit: Node): number {
  let max = 1;
  for (const m of modelsOf(unit)) {
    const mx = constraintVal(m, "max");
    if (mx && mx > max) max = mx;
  }
  for (const g of collectByKey(unit, "selectionEntryGroup")) {
    if (directModelChildren(g).length > 0) {
      const mx = constraintVal(g, "max");
      if (mx && mx > max) max = mx;
    }
  }
  return max;
}

/** A unit-wide error modifier forcing all models to share a loadout (no any_number). */
function hasEquipIdentically(unit: Node): boolean {
  for (const m of collectByKey(unit, "modifier")) {
    if (String(m.field) === "error" && /equipped identically/i.test(String(m.value ?? ""))) return true;
  }
  return false;
}

/** Distinct model "base" names (stripping a "w/ <weapon>" loadout suffix). */
function distinctModelBases(unit: Node): number {
  const bases = new Set<string>();
  for (const m of modelsOf(unit)) {
    const base = cleanText(String(m.name ?? "")).replace(/\s+(w\/|with)\b.*$/i, "").trim().toLowerCase();
    if (base) bases.add(base);
  }
  return bases.size;
}

/**
 * per_n_models from a max constraint + a model-count `decrement` modifier
 * (Plasmacyte: max 2, decrement 1 when <6 models, over a 6-model unit ⇒ per 3).
 * Only when the ratio is integral; otherwise null (caller reports / uses max_count).
 */
function perNFromDecrement(node: Node, unitMax: number): number | null {
  const max = constraintVal(node, "max");
  if (!max || max < 1 || unitMax <= 1) return null;
  for (const mod of asArray<Node>(node.modifiers?.modifier)) {
    if (String(mod.type) !== "decrement") continue;
    for (const c of asArray<Node>(mod.conditions?.condition)) {
      if (String(c.childId) === "model" && /selections/i.test(String(c.field))) {
        if (unitMax % max === 0) return unitMax / max;
      }
    }
  }
  return null;
}

/** Whether a node (or its entryLink target) carries a weapon or wargear profile. */
function profileType(node: Node, cats: Catalogs): "weapon" | "wargear" | null {
  const host = node.targetId ? cats.entryById.get(String(node.targetId)) ?? node : node;
  const profiles = asArray<Node>(host.profiles?.profile);
  if (profiles.some((p) => /Ranged Weapons|Melee Weapons/i.test(String(p.typeName ?? "")))) return "weapon";
  if (profiles.some((p) => /Abilities|Wargear/i.test(String(p.typeName ?? "")))) return "wargear";
  return null;
}

// ─────────────────────────── faction extraction ───────────────────────────

interface ReportRow {
  unit: string;
  context: string;
  reason: string;
}
/** Per-model default loadout for a matched unit, for unit-composition population. */
export interface CompDefaults {
  unitId: string;
  /** normalized (lowercased, suffix-stripped) BSData model name → default weapon ids. */
  byModel: Record<string, string[]>;
  /** The squad default-model loadout, used for bulk model rows with no name match. */
  squadDefault: string[];
}
export interface FactionResult {
  faction: string;
  options: WargearOption[];
  wargear: WargearEntity[]; // clean wargear entities minted for non-weapon items
  matchedUnits: number;
  skippedUnits: string[]; // BSData unit names with no repo match
  reports: ReportRow[]; // triage — never fabricated
  compDefaults: CompDefaults[]; // per-model default loadouts → unit-compositions.json
}

export function extractFaction(faction: string, cats: Catalogs): FactionResult {
  const res: FactionResult = {
    faction,
    options: [],
    wargear: [],
    matchedUnits: 0,
    skippedUnits: [],
    reports: [],
    compDefaults: [],
  };
  const roots = cats.catByFaction.get(faction);
  if (!roots) return res;

  const weaponsPath = join(CORE_DIR, faction, "weapons.json");
  const wargearPath = join(CORE_DIR, faction, "wargear.json");
  const unitsPath = join(CORE_DIR, faction, "units.json");
  const weaponIds = new Set(
    (existsSync(weaponsPath) ? readJSON<{ id: string }[]>(weaponsPath) : []).map((w) => w.id)
  );
  const wargearIds = new Set(
    (existsSync(wargearPath) ? readJSON<{ id: string }[]>(wargearPath) : []).map((w) => w.id)
  );
  for (const id of wargearIds) weaponIds.add(id);
  const repoUnitIds = new Set(
    (existsSync(unitsPath) ? readJSON<{ id: string }[]>(unitsPath) : []).map((u) => u.id)
  );
  const minted = new Map<string, WargearEntity>();

  /** Resolve a weapon/wargear name to a known repo id, or null. */
  const resolveWeapon = (name: string): string | null => {
    let id: string;
    try {
      id = nameToId(name);
    } catch {
      return null;
    }
    if (weaponIds.has(id)) return id;
    if (id.endsWith("s") && weaponIds.has(id.slice(0, -1))) return id.slice(0, -1);
    return null;
  };

  /** Mint (or reuse) a clean wargear entity for a non-weapon loadout item. */
  const mintWargear = (name: string): string | null => {
    let id: string;
    try {
      id = nameToId(name);
    } catch {
      return null;
    }
    if (id.length > 128 || name.length > 128) return null;
    if (!minted.has(id)) {
      const n = name.toLowerCase();
      const category = n.includes("icon")
        ? "icon"
        : n.includes("standard") || n.includes("banner")
          ? "standard"
          : undefined;
      minted.set(id, { id, name, ...(category ? { category } : {}), game_version: GAME_VERSION });
    }
    return id;
  };

  /**
   * Resolve a single option node to its constituent loadout-item ids — itself if
   * it is a known weapon/wargear, the weapons nested under it for a compound
   * ("Overlord's blade and tachyon arrow"), or a freshly-minted wargear entity
   * for a profiled non-weapon item the repo lacks. null ⇒ unresolved (reported).
   */
  const resolveOption = (node: Node, name: string): string[] | null => {
    const direct = resolveWeapon(name);
    if (direct) return [direct];
    const host = node.targetId ? cats.entryById.get(String(node.targetId)) ?? node : node;
    const ids = new Set<string>();
    for (const link of collectByKey(host, "entryLink")) {
      if (String(link.type) !== "selectionEntry") continue;
      const nm = entryName(link, cats);
      const wid = nm ? resolveWeapon(nm) : null;
      if (wid) ids.add(wid);
    }
    for (const e of collectByKey(host, "selectionEntry")) {
      const nm = e.name ? cleanText(String(e.name)) : undefined;
      const wid = nm ? resolveWeapon(nm) : null;
      if (wid) ids.add(wid);
    }
    // A compound option carries multiple weapon profiles directly on the entry
    // ("Particle caster and voidblade" → particle-caster + voidblade) rather than
    // as nested entries; map each weapon profile by name (sans firing-mode suffix).
    for (const p of asArray<Node>(host.profiles?.profile)) {
      if (!/Ranged Weapons|Melee Weapons/i.test(String(p.typeName ?? ""))) continue;
      const nm = cleanText(String(p.name ?? "")).replace(/\s*-\s*.*$/, "").trim();
      const wid = nm ? resolveWeapon(nm) : null;
      if (wid) ids.add(wid);
    }
    if (ids.size) return [...ids];
    // Not a known weapon and no nested weapons: a profiled non-weapon item → mint
    // a clean wargear entity — unless its name marks it as an ability/power
    // selector rather than equipment (those are reported, never fabricated).
    const pt = profileType(node, cats);
    if (pt === "wargear" && !NOISE_ITEM_NAME_RE.test(name)) {
      const id = mintWargear(name);
      return id ? [id] : null;
    }
    return null;
  };

  /** Every loadout item id equipped by a model (its base + nested loadout). */
  const modelWeaponSet = (model: Node): Set<string> => {
    const ids = new Set<string>();
    for (const got of resolveOption(model, cleanText(String(model.name ?? ""))) ?? []) ids.add(got);
    return ids;
  };

  /** The weapon sub-choice groups nested directly under a model (inline child
   *  groups + entryLinks to shared groups), excluding model containers + noise. */
  const nestedGroups = (model: Node): Node[] => {
    const out: Node[] = [];
    for (const g of childGroups(model)) {
      if (directModelChildren(g).length === 0 && !isNoiseGroup(g, cats)) out.push(g);
    }
    for (const link of entryLinksOf(model)) {
      if (String(link.type) === "selectionEntryGroup" && !isNoiseGroup(link, cats)) {
        const g = resolveGroup(link, cats);
        if (g && directModelChildren(g).length === 0) out.push(g);
      }
    }
    return out;
  };

  /** A group's selectable entries (inline + weapon entryLinks) resolved to id
   *  lists — one choice per entry. Hidden / ability-selector entries are dropped. */
  const groupChoices = (group: Node): string[][] => {
    const choices: string[][] = [];
    for (const e of [...childEntries(group), ...entryLinksOf(group)]) {
      if (String(e.type) === "selectionEntryGroup" || isHidden(e, cats)) continue;
      const n = entryName(e, cats);
      if (!n || NOISE_ITEM_NAME_RE.test(n)) continue;
      const ids = resolveOption(e, n);
      if (ids) choices.push(ids);
    }
    return choices;
  };

  /** A model's representative *fixed* loadout: its flat weapon set with every
   *  nested sub-choice group reduced to just its default (a defaulted group) or
   *  removed entirely (a no-default mandatory choice — those become slots). Used
   *  to decompose a variant model that carries an inner pick (e.g. a Terminator's
   *  "Heavy weapon" slot) which the flat {@link modelWeaponSet} union would render
   *  as an un-attributable multi-axis delta. */
  const modelFixedSet = (model: Node): Set<string> => {
    const ids = new Set<string>(resolveOption(model, cleanText(String(model.name ?? ""))) ?? []);
    for (const g of nestedGroups(model)) {
      const defaultId = g.defaultSelectionEntryId ? String(g.defaultSelectionEntryId) : undefined;
      for (const e of [...childEntries(g), ...entryLinksOf(g)]) {
        if (String(e.type) === "selectionEntryGroup") continue;
        const n = entryName(e, cats);
        const eids = n ? resolveOption(e, n) : null;
        if (!eids) continue;
        const isDefault =
          !!defaultId && (String(e.id) === defaultId || String(e.targetId) === defaultId);
        if (!isDefault) for (const id of eids) ids.delete(id);
      }
    }
    return ids;
  };

  /** No-default mandatory (min ≥ 1) nested choice sub-groups as choice-lists — e.g.
   *  a Terminator's heavy-weapon pick `[[reaper-autocannon],[heavy-flamer]]`. */
  const modelChoiceSlots = (model: Node): string[][][] => {
    const slots: string[][][] = [];
    for (const g of nestedGroups(model)) {
      if (g.defaultSelectionEntryId) continue; // defaulted → folded into the fixed set
      if ((constraintVal(g, "min") ?? 0) < 1) continue; // optional add-on, not a slot
      const choices = groupChoices(g);
      if (choices.length >= 2) slots.push(choices);
    }
    return slots;
  };

  // A datasheet is a `type="unit"` entry OR a top-level `type="model"` entry that
  // carries its own "Unit" stat profile (single-model characters/vehicles like the
  // Overlord are modelled this way, with no surrounding unit wrapper). Nested squad
  // models carry their statline on the parent unit, so they are NOT datasheets.
  const isDatasheet = (e: Node): boolean => {
    const t = String(e.type);
    if (t === "unit") return true;
    if (t === "model") {
      return asArray<Node>(e.profiles?.profile).some((p) => /^Unit$/i.test(String(p.typeName ?? "")));
    }
    return false;
  };
  // Process `type="unit"` wrappers before bare model datasheets so a squad wins
  // the id over any same-named nested model.
  const units = roots
    .flatMap((root) => collectByKey(root, "selectionEntry").filter(isDatasheet))
    .sort((a, b) => (String(a.type) === "unit" ? 0 : 1) - (String(b.type) === "unit" ? 0 : 1));
  const seenUnit = new Set<string>();
  let counter = 0;

  for (const unit of units) {
    const rawName = String(unit.name ?? "");
    if (/\[Legends\]/i.test(rawName)) continue;
    const unitName = cleanText(rawName);
    let unitId: string;
    try {
      unitId = nameToId(unitName);
    } catch {
      continue;
    }
    if (seenUnit.has(unitId)) continue;
    seenUnit.add(unitId);
    if (!repoUnitIds.has(unitId)) {
      res.skippedUnits.push(`${unitName} (${unitId})`);
      continue;
    }
    res.matchedUnits++;

    // For a bare model datasheet the unit IS its own (sole) model; for a unit
    // wrapper, its models are the nested `type="model"` entries.
    const ownModels = String(unit.type) === "model" ? [unit, ...modelsOf(unit)] : modelsOf(unit);
    const maxModels = unitMaxModels(unit);
    const multiModel = maxModels > 1;
    const equipIdentically = hasEquipIdentically(unit);
    const perModel = multiModel && !equipIdentically; // ⇒ any_number unless overridden
    const nameModels = distinctModelBases(unit) > 1;
    const report = (context: string, reason: string) =>
      res.reports.push({ unit: unitName, context, reason });

    // Track entry/group ids consumed by variant-swap or weapon-choice handling so
    // the standalone-addon pass doesn't re-emit them.
    const consumed = new Set<string>();

    /** Assemble a model_constraint from the unit-level signals + a node's caps. */
    const constraintFor = (
      node: Node | undefined,
      modelName: string | undefined,
      groupMax: number | undefined,
      modelMax?: number,
    ): ModelConstraint | undefined => {
      const mc: ModelConstraint = {};
      if (nameModels && modelName) mc.model_name = modelName;
      const perN = node ? perNFromDecrement(node, maxModels) : null;
      if (perN) {
        mc.per_n_models = perN;
      } else if (groupMax && groupMax > 1) {
        mc.max_count = groupMax;
      } else if (modelName && modelMax === 1) {
        // An option scoped to a single named model (a champion/sergeant) is taken
        // by that one model — never any_number.
        mc.max_count = 1;
      } else if (perModel) {
        mc.any_number = true;
      } else if (!multiModel && node && constraintVal(node, "max") === 1) {
        mc.max_count = 1;
      }
      return Object.keys(mc).length ? mc : undefined;
    };

    const pushOption = (
      opt: Omit<WargearOption, "id" | "unit_id" | "game_version">,
      pts: number,
    ): void => {
      const option: WargearOption = {
        id: `${unitId}-wgo-${++counter}`,
        unit_id: unitId,
        game_version: GAME_VERSION,
        ...opt,
      };
      if (pts > 0) {
        option.additional_cost = pts;
        option.is_free = false;
      } else {
        option.is_free = true;
      }
      res.options.push(option);
    };

    // ── 1. Model-variant swaps (single- AND multi-axis cross-products) ───────
    // The unit's base loadout: the weapon set of every model that is the
    // defaultSelectionEntryId of some group (the squad's default build). This is
    // the reference that fixes swap DIRECTION when a variant group has no default
    // of its own — decomposing against a wrong base would invert the swap.
    const defaultModelIds = new Set<string>();
    for (const g of collectByKey(unit, "selectionEntryGroup")) {
      if (g.defaultSelectionEntryId) defaultModelIds.add(String(g.defaultSelectionEntryId));
    }
    const unitBaseSet = new Set<string>();
    for (const m of modelsOf(unit)) {
      if (defaultModelIds.has(String(m.id))) for (const id of modelWeaponSet(m)) unitBaseSet.add(id);
    }
    // Max squad size = bulk models + leaders. The bulk count cap lives on the squad
    // GROUP (e.g. "9-19 Berzerkers" max 19, default = the base model); a leader
    // (Champion) is a standalone model with no count cap (always 1). Summing both
    // gives the denominator for the per-N rule (20 ⇒ "1 per 5" from a flat max 4).
    const ownModelIds = new Set(ownModels.map((m) => String(m.id)));
    const variantModelIds = new Set<string>();
    for (const g of collectByKey(unit, "selectionEntryGroup")) {
      const kids = directModelChildren(g);
      if (kids.length >= 2 && new Set(kids.map((k) => cleanText(String(k.name ?? "")))).size === kids.length) {
        for (const k of kids) variantModelIds.add(String(k.id));
      }
    }
    let maxSquadModels = 0;
    for (const g of collectByKey(unit, "selectionEntryGroup")) {
      const did = g.defaultSelectionEntryId ? String(g.defaultSelectionEntryId) : undefined;
      if (!did || !ownModelIds.has(did)) continue;
      const dm = ownModels.find((m) => String(m.id) === did)!;
      maxSquadModels += constraintVal(g, "max") ?? constraintVal(dm, "max") ?? 1;
    }
    // Standalone leader models (not a group default, not a loadout variant).
    for (const m of ownModels) {
      const id = String(m.id);
      if (!defaultModelIds.has(id) && !variantModelIds.has(id)) maxSquadModels += constraintVal(m, "max") ?? 1;
    }
    if (maxSquadModels === 0) maxSquadModels = maxModels;

    for (const group of collectByKey(unit, "selectionEntryGroup")) {
      const variants = directModelChildren(group);
      if (variants.length < 2) continue;
      const ctx = groupName(group, cats) || "(variant group)";
      const names = variants.map((v) => cleanText(String(v.name ?? "")));
      // Identical names ⇒ a squad of N identical models ("take 2 Tomb Crawlers"),
      // NOT a loadout choice. Leave it for the per-model weapon-group pass.
      if (new Set(names).size < variants.length) continue;
      for (const v of variants) consumed.add(String(v.id));

      const defaultId = group.defaultSelectionEntryId ? String(group.defaultSelectionEntryId) : undefined;
      const sets = variants.map((v) => ({ node: v, ids: modelWeaponSet(v), max: constraintVal(v, "max") }));
      const baseEntry = defaultId ? sets.find((s) => String(s.node.id) === defaultId) : undefined;
      const baseSet = baseEntry ? baseEntry.ids : unitBaseSet;
      if (baseSet.size === 0) {
        report(ctx, "model-variant group has no resolvable base loadout (no default model)");
        continue;
      }

      // Decompose each variant against the base into independent axes: a single
      // weapon swapped (removed↔added) is one slot; a single weapon added (no
      // removal) is an add-on. Multi-axis variants are handled in a second pass.
      const swapSlots = new Map<string, { alts: Set<string>; max: number | undefined }>();
      const addonAlts = new Set<string>();
      const leftover: typeof sets = [];
      for (const s of sets) {
        if (s === baseEntry) continue;
        const removed = [...baseSet].filter((id) => !s.ids.has(id));
        const added = [...s.ids].filter((id) => !baseSet.has(id));
        if (removed.length === 1 && added.length === 1) {
          const slot = swapSlots.get(removed[0]) ?? { alts: new Set<string>(), max: undefined };
          slot.alts.add(added[0]);
          if (s.max !== undefined) slot.max = Math.max(slot.max ?? 0, s.max);
          swapSlots.set(removed[0], slot);
        } else if (removed.length === 0 && added.length === 1) {
          addonAlts.add(added[0]);
        } else {
          leftover.push(s);
        }
      }
      // A multi-axis variant flattens to an un-attributable delta. It is one of:
      //   1. a variant carrying a nested mandatory sub-choice (e.g. a heavy-weapon
      //      slot) — recover it as its own option (`replaces` the freed weapon);
      //   2. redundant with the single-axis variants of a cross-product (every new
      //      weapon already appears as a swap/add-on alt) — safely skipped;
      //   3. a genuine loss — TRIAGED, never dropped silently (the bug that lost
      //      Chaos Terminators' reaper/heavy-flamer slot).
      const slotOptions: { replaces?: string[]; choices: string[][]; max: number | undefined }[] = [];
      const knownAdds = new Set<string>(addonAlts);
      for (const slot of swapSlots.values()) for (const a of slot.alts) knownAdds.add(a);
      for (const s of leftover) {
        const slots = modelChoiceSlots(s.node);
        if (slots.length === 1) {
          const fixed = modelFixedSet(s.node);
          const fRemoved = [...baseSet].filter((id) => !fixed.has(id));
          const fAdded = [...fixed].filter((id) => !baseSet.has(id));
          if (fAdded.length === 0 && fRemoved.length <= 1) {
            slotOptions.push({
              replaces: fRemoved.length ? fRemoved : undefined,
              choices: slots[0],
              max: s.max,
            });
            continue;
          }
        }
        const added = [...s.ids].filter((id) => !baseSet.has(id));
        const removed = [...baseSet].filter((id) => !s.ids.has(id));
        // A single weapon that frees several base weapons (a two-hander taking
        // both hands, e.g. paired accursed weapons replacing combi-bolter +
        // accursed weapon) is a clean multi-replace swap.
        if (added.length === 1 && removed.length >= 1) {
          slotOptions.push({ replaces: removed, choices: [[added[0]]], max: s.max });
          continue;
        }
        if (added.length === 0) continue; // introduces no new weapon — nothing lost
        if (added.every((id) => knownAdds.has(id))) continue; // redundant cross-product
        report(
          ctx,
          `model-variant "${cleanText(String(s.node.name ?? ""))}" introduces weapons not ` +
            `reducible to a clean swap/slot (added ${JSON.stringify(added)})`,
        );
      }
      if (swapSlots.size === 0 && addonAlts.size === 0 && slotOptions.length === 0) {
        report(ctx, "model-variant group could not be decomposed into clean swaps");
        continue;
      }
      // BSData states a variant's cap as a FLAT max — the count allowed at the
      // unit's MAX model size. The real rule scales: "1 per N models", where
      // N = maxSquadModels / flatMax (e.g. 4 eviscerators at 20 models ⇒ 1 per 5).
      // Recover per_n_models from that ratio; a ratio of 1 (or an uncapped max) is
      // every model ⇒ any_number.
      const capFor = (max: number | undefined): ModelConstraint | undefined => {
        if (max === undefined || max >= maxSquadModels) {
          return perModel ? { any_number: true } : undefined;
        }
        if (maxSquadModels % max === 0) {
          const per = maxSquadModels / max;
          return per <= 1 ? (perModel ? { any_number: true } : undefined) : { per_n_models: per };
        }
        return { max_count: max };
      };
      for (const [removed, slot] of swapSlots) {
        const alts = [...slot.alts];
        const opt: Omit<WargearOption, "id" | "unit_id" | "game_version"> = { replaces: [removed] };
        if (alts.length === 1) opt.replacement = alts;
        else opt.replacement_choice = alts.map((a) => [a]);
        const mc = capFor(slot.max);
        if (mc) opt.model_constraint = mc;
        pushOption(opt, 0);
      }
      if (addonAlts.size > 0) {
        const alts = [...addonAlts];
        const opt: Omit<WargearOption, "id" | "unit_id" | "game_version"> = {};
        if (alts.length === 1) opt.replacement = alts;
        else opt.replacement_choice = alts.map((a) => [a]);
        if (perModel) opt.model_constraint = { any_number: true };
        pushOption(opt, 0);
      }
      // Recovered nested-choice slots (e.g. the heavy-weapon pick): each replaces
      // the weapon its model frees, offering the choice as replacement(s).
      for (const so of slotOptions) {
        const opt: Omit<WargearOption, "id" | "unit_id" | "game_version"> = {};
        if (so.replaces) opt.replaces = so.replaces;
        if (so.choices.length === 1) opt.replacement = so.choices[0];
        else opt.replacement_choice = so.choices;
        const mc = capFor(so.max);
        if (mc) opt.model_constraint = mc;
        pushOption(opt, 0);
      }
    }

    // ── 2. Weapon-choice + pure-addon groups under each model ────────────────
    for (const model of ownModels) {
      if (consumed.has(String(model.id))) continue;
      const modelName = cleanText(String(model.name ?? ""));
      const modelMax = constraintVal(model, "max");

      // gather slot groups: inline child groups + entryLinks to shared groups,
      // descending through non-model entries, skipping noise + model containers.
      const slotGroups: Node[] = [];
      const visit = (node: Node) => {
        for (const g of childGroups(node)) {
          if (directModelChildren(g).length === 0 && !isNoiseGroup(g, cats)) slotGroups.push(g);
          visit(g);
        }
        for (const link of entryLinksOf(node)) {
          if (String(link.type) === "selectionEntryGroup" && !isNoiseGroup(link, cats)) {
            const g = resolveGroup(link, cats);
            if (g && directModelChildren(g).length === 0) {
              slotGroups.push(g);
              visit(g);
            }
          }
        }
        for (const e of childEntries(node)) if (String(e.type) !== "model") visit(e);
      };
      visit(model);

      for (const group of slotGroups) {
        if (consumed.has(String(group.id))) continue;
        consumed.add(String(group.id));
        const ctx = groupName(group, cats) || "(group)";
        const defaultId = group.defaultSelectionEntryId ? String(group.defaultSelectionEntryId) : undefined;
        const groupMax = constraintVal(group, "max");
        const groupMin = constraintVal(group, "min");

        // option nodes: inline entries + weapon entryLinks
        const opts: { node: Node; name: string }[] = [];
        for (const e of childEntries(group)) {
          if (isHidden(e, cats)) continue;
          const n = entryName(e, cats);
          if (n && !NOISE_ITEM_NAME_RE.test(n)) opts.push({ node: e, name: n });
        }
        for (const link of entryLinksOf(group)) {
          if (String(link.type) !== "selectionEntry" || isHidden(link, cats)) continue;
          const n = entryName(link, cats);
          if (n && !NOISE_ITEM_NAME_RE.test(n)) opts.push({ node: link, name: n });
        }
        if (opts.length === 0) continue;
        for (const o of opts) consumed.add(String(o.node.id));

        const resolved: { ids: string[]; pts: number; isDefault: boolean; min: number; max?: number }[] = [];
        let bad = false;
        for (const o of opts) {
          const ids = resolveOption(o.node, o.name);
          if (!ids) {
            report(ctx, `unresolved option "${o.name}"`);
            bad = true;
            continue;
          }
          const isDefault =
            (defaultId && (String(o.node.id) === defaultId || String(o.node.targetId) === defaultId)) || false;
          resolved.push({
            ids,
            pts: ptsCost(o.node),
            isDefault,
            min: nodeConstraint(o.node, "min", cats) ?? 0,
            max: nodeConstraint(o.node, "max", cats),
          });
        }
        if (bad || resolved.length === 0) continue;
        void groupMin;

        if (defaultId) {
          // A group with a default option is a swap: default → replaces.
          const defaults = resolved.filter((r) => r.isDefault);
          const alternatives = resolved.filter((r) => !r.isDefault);
          if (defaults.length !== 1 || alternatives.length === 0) {
            report(ctx, `default present but ${defaults.length} default / ${alternatives.length} alt — not a clean swap`);
            continue;
          }
          const altCost = alternatives.every((a) => a.pts === alternatives[0].pts) ? alternatives[0].pts : 0;
          const opt: Omit<WargearOption, "id" | "unit_id" | "game_version"> = { replaces: defaults[0].ids };
          if (alternatives.length === 1) opt.replacement = alternatives[0].ids;
          else opt.replacement_choice = alternatives.map((a) => a.ids);
          const mc = constraintFor(group, modelName, groupMax, modelMax);
          if (mc) opt.model_constraint = mc;
          pushOption(opt, altCost);
        } else {
          // No default: separate base loadout (min ≥ 1, always equipped) from
          // optional add-ons (min 0). A group capped at one optional pick is a
          // "choose one of"; an uncapped group is a set of independent add-ons.
          const optional = resolved.filter((r) => r.min === 0);
          if (optional.length === 0) continue;
          if (groupMax === 1 && optional.length >= 2) {
            const mc = constraintFor(group, modelName, undefined, modelMax);
            const opt: Omit<WargearOption, "id" | "unit_id" | "game_version"> = {
              replacement_choice: optional.map((r) => r.ids),
            };
            if (mc) opt.model_constraint = mc;
            const cost = optional.every((a) => a.pts === optional[0].pts) ? optional[0].pts : 0;
            pushOption(opt, cost);
          } else {
            // Independent add-ons need an explicit max cap; an item with no max
            // constraint is fixed base loadout (e.g. a vehicle's built-in weapon),
            // not a selectable option.
            for (const r of optional.filter((o) => o.max !== undefined)) {
              const mc = constraintFor(group, modelName, undefined, modelMax);
              const opt: Omit<WargearOption, "id" | "unit_id" | "game_version"> = { replacement: r.ids };
              if (mc) opt.model_constraint = mc;
              pushOption(opt, r.pts);
            }
          }
        }
      }
    }

    // ── 3. Standalone optional add-ons (entryLinks / inline upgrades) ────────
    // An optional (min 0, max ≥1) profiled item attached directly to a model or
    // squad group — e.g. Plasmacyte (group-level entryLink), Shieldvanes (inline
    // model upgrade). Skip base loadout (min ≥ 1) and anything already consumed.
    // Scan the unit, its models, and every non-noise group (where a group-level
    // add-on like Plasmacyte lives). Crusade/ability sub-groups are excluded as
    // noise; weapon/wargear groups are already consumed by the pass above.
    const addonHosts = [
      unit,
      ...ownModels,
      ...collectByKey(unit, "selectionEntryGroup").filter((g) => !isNoiseGroup(g, cats)),
    ];
    const seenAddon = new Set<string>();
    for (const host of addonHosts) {
      if (directModelChildren(host).length >= 2) continue; // variant group, handled
      const candidates = [...entryLinksOf(host), ...childEntries(host)];
      for (const node of candidates) {
        const id = String(node.id ?? "");
        if (!id || consumed.has(id) || seenAddon.has(id)) continue;
        if (String(node.type) === "model" || isHidden(node, cats)) continue;
        if (String(node.type) === "selectionEntryGroup") continue;
        if (String(node.type) === "selectionEntry" && node.targetId === undefined) {
          // inline entry: only optional ones (min 0) with a profile are add-ons
        }
        const min = nodeConstraint(node, "min", cats) ?? 0;
        // A 1-per-unit item (icon/banner) is capped by an `<association max>`, not
        // a constraint; fall back to it so such add-ons cap at their real count.
        const max = nodeConstraint(node, "max", cats) ?? associationMax(node) ?? 0;
        if (min >= 1 || max < 1) continue; // base loadout or not selectable
        const pt = profileType(node, cats);
        if (!pt) continue;
        const name = entryName(node, cats);
        if (!name || NOISE_ITEM_NAME_RE.test(name)) continue;
        const ids = resolveOption(node, name);
        if (!ids) {
          report(name, "unresolved standalone add-on");
          continue;
        }
        seenAddon.add(id);
        consumed.add(id);
        // A sub-squad cap → max_count; an uncapped per-model add-on → any_number.
        const mc: ModelConstraint | undefined =
          max < maxModels ? { max_count: max } : perModel ? { any_number: true } : undefined;
        const opt: Omit<WargearOption, "id" | "unit_id" | "game_version"> = { replacement: ids };
        if (mc) opt.model_constraint = mc;
        pushOption(opt, ptsCost(node));
      }
    }

    // ── Per-model default loadouts (for unit-composition population) ──────────
    // Each BSData model's default = its fixed loadout (nested sub-choices reduced
    // to their default). The squad default — the group default-variant's fixed set
    // — covers bulk composition rows whose generic name ("Chaos Terminator")
    // matches no BSData variant. Leaders ("Terminator Champion") name-match.
    const byModel: Record<string, string[]> = {};
    for (const m of ownModels) {
      const nm = normModelName(String(m.name ?? ""));
      if (!nm || byModel[nm]) continue;
      const ids = [...modelFixedSet(m)]; // datasheet order (set insertion order)
      if (ids.length) byModel[nm] = ids;
    }
    const squadIds = new Set<string>();
    for (const m of ownModels) {
      if (defaultModelIds.has(String(m.id))) for (const id of modelFixedSet(m)) squadIds.add(id);
    }
    if (squadIds.size === 0) for (const id of unitBaseSet) squadIds.add(id);
    if (squadIds.size === 0 && ownModels.length === 1) {
      for (const id of modelFixedSet(ownModels[0])) squadIds.add(id);
    }
    res.compDefaults.push({ unitId, byModel, squadDefault: [...squadIds] });
  }

  // Emit only minted wargear actually referenced by a surviving option — a later
  // option that minted an item and then failed to resolve must not leave an orphan.
  const referenced = new Set<string>();
  for (const o of res.options) {
    for (const id of [...(o.replaces ?? []), ...(o.replacement ?? []), ...(o.replacement_choice ?? []).flat()]) {
      referenced.add(id);
    }
  }
  res.wargear = [...minted.values()].filter((w) => referenced.has(w.id));
  return res;
}

// ─────────────────────────── CLI ───────────────────────────

function repoDirSet(): Set<string> {
  return new Set(
    readdirSync(CORE_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
      .map((d) => d.name)
  );
}

/** Mint-merge clean wargear entities into a faction's existing wargear.json. */
function mergeWargear(faction: string, minted: WargearEntity[]): void {
  if (minted.length === 0) return;
  const path = join(CORE_DIR, faction, "wargear.json");
  const existing = existsSync(path) ? readJSON<WargearEntity[]>(path) : [];
  const byId = new Map(existing.map((w) => [w.id, w]));
  for (const w of minted) if (!byId.has(w.id)) byId.set(w.id, w);
  writeFileSync(path, JSON.stringify([...byId.values()], null, 2) + "\n");
}

/**
 * Populate `default_weapon_ids` on a faction's unit-composition model rows from the
 * BSData per-model defaults. Additive: only matched units are touched, only when the
 * computed value differs, and all other fields/compositions are preserved. A bulk
 * row whose generic name matches no BSData model falls back to the squad default.
 */
function mergeCompDefaults(faction: string, compDefaults: CompDefaults[]): void {
  if (compDefaults.length === 0) return;
  const cpath = join(CORE_DIR, faction, "unit-compositions.json");
  if (!existsSync(cpath)) return;
  const comps = readJSON<Record<string, unknown>[]>(cpath);

  // Reachability per unit: every weapon a wargear option can swap in/out. A
  // weapon in `weapon_ids` that is NOT reachable is an always-on base weapon
  // (e.g. a vehicle's built-in heavy bolter / armoured tracks).
  const upath = join(CORE_DIR, faction, "units.json");
  const wpath = join(CORE_DIR, faction, "wargear-options.json");
  const weaponIdsByUnit = new Map<string, string[]>(
    (existsSync(upath) ? readJSON<{ id: string; weapon_ids?: string[] }[]>(upath) : []).map((u) => [
      u.id,
      u.weapon_ids ?? [],
    ]),
  );
  const reachableByUnit = new Map<string, Set<string>>();
  for (const o of existsSync(wpath) ? readJSON<WargearOption[]>(wpath) : []) {
    const set = reachableByUnit.get(o.unit_id) ?? new Set<string>();
    for (const id of o.replaces ?? []) set.add(id);
    for (const id of o.replacement ?? []) set.add(id);
    for (const g of o.replacement_choice ?? []) for (const id of g) set.add(id);
    reachableByUnit.set(o.unit_id, set);
  }

  const byUnit = new Map(compDefaults.map((c) => [c.unitId, c]));
  let changed = false;
  for (const comp of comps) {
    const cd = byUnit.get(String(comp.unit_id));
    if (!cd) continue;
    const models = (comp.models as Record<string, unknown>[]) ?? [];
    const idsFor = (m: Record<string, unknown>): string[] =>
      cd.byModel[normModelName(String(m.name ?? ""))] ?? cd.squadDefault;

    // SAFETY GATE: only populate when the computed defaults cover every weapon
    // that isn't reachable via an option. Otherwise writing the field would drop a
    // real always-on weapon (the extractor's per-model resolution is incomplete for
    // many vehicles/characters), regressing the unit — so leave it to the loadout
    // layer's correct orphan→base derivation instead.
    const covered = new Set<string>();
    for (const m of models) for (const id of idsFor(m)) covered.add(id);
    const reachable = reachableByUnit.get(String(comp.unit_id)) ?? new Set<string>();
    const orphanWeapons = (weaponIdsByUnit.get(String(comp.unit_id)) ?? []).filter(
      (id) => !reachable.has(id),
    );
    if (!orphanWeapons.every((id) => covered.has(id))) continue; // would regress → skip

    for (const m of models) {
      const ids = idsFor(m);
      if (!ids.length) continue;
      // Set-compare: preserve an already-correct row's order (no churn); only fill
      // empties or fix genuine content drift.
      const cur = Array.isArray(m.default_weapon_ids) ? (m.default_weapon_ids as string[]) : [];
      const sameSet = cur.length === ids.length && ids.every((id) => cur.includes(id));
      if (!sameSet) {
        m.default_weapon_ids = ids;
        changed = true;
      }
    }
  }
  if (changed) writeFileSync(cpath, JSON.stringify(comps, null, 2) + "\n");
}

function writeReport(faction: string, r: FactionResult): void {
  if (!existsSync(REPORT_DIR)) return;
  // Underscore-prefixed so validate/integrity globs treat it as a scratch report,
  // not a dataset file needing a schema (see validate.ts).
  const path = join(REPORT_DIR, `_bsdata-wargear-unresolved.${faction}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      { faction, matchedUnits: r.matchedUnits, skippedUnits: r.skippedUnits, reports: r.reports },
      null,
      2,
    ) + "\n",
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  const reportOnly = argv.includes("--report-only");
  const all = argv.includes("--all");
  const targets = argv.filter((a) => !a.startsWith("--"));

  const repoDirs = repoDirSet();
  const cats = loadCatalogs(repoDirs);
  const factions = all ? [...repoDirs].sort() : targets;
  if (factions.length === 0) {
    console.error("Usage: convert-bsdata-wargear <faction-id…> | --all  [--write] [--report-only]");
    process.exit(2);
  }

  for (const faction of factions) {
    const r = extractFaction(faction, cats);
    console.log(
      `${faction}: ${r.options.length} options (+${r.wargear.length} wargear) from ` +
        `${r.matchedUnits} matched units (skipped ${r.skippedUnits.length} unmatched, ` +
        `${r.reports.length} reported for triage)`,
    );
    if (r.matchedUnits > 0 || r.reports.length > 0) writeReport(faction, r);
    if (write && !reportOnly && r.matchedUnits > 0) {
      const outPath = join(CORE_DIR, faction, "wargear-options.json");
      writeFileSync(outPath, JSON.stringify(r.options, null, 2) + "\n");
      mergeWargear(faction, r.wargear);
      mergeCompDefaults(faction, r.compDefaults);
    }
  }
  if (!write || reportOnly) {
    console.log(`\n${reportOnly ? "REPORT-ONLY" : "DRY RUN"} — no data files written. Triage reports in ${REPORT_DIR}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
