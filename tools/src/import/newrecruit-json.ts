/**
 * NewRecruit JSON adapter: lower a decoded NewRecruit roster export (a
 * BattleScribe-derived tree, same outer shape as ListForge) to a {@link ParsedRoster}.
 *
 * NewRecruit-specific signals used to detect the format:
 * - `generatedBy` reports the NewRecruit URL ("https://newrecruit.eu"), and/or
 * - `roster.xmlns` is set to the BattleScribe rosterSchema namespace.
 *
 * The primary faction surfaces in `forces[].catalogueName` (e.g.
 * "Chaos - Chaos Knights") — we take the segment after the final " - ". Falls
 * back to the first `"Faction: X"` category if no catalogueName is present.
 *
 * The walk reads the same ALLOWLIST as the ListForge adapter — `name`,
 * `number`, `type`, `categories[].name`, `group`, `costs` point values, and
 * `catalogueName`. `rules[].description`, ability `profiles[].characteristics[].$text`,
 * and every other prose field are never touched, so the importer's output is
 * free of copyrighted prose by construction.
 *
 * Selection-tree shape (recursive `selections`) is identical to ListForge:
 * - Configuration nodes (`type: "upgrade"`) named "Detachment" / "Battle Size"
 *   carry the chosen value as their first child selection.
 * - Unit nodes (`type: "model" | "unit"`) carry role categories, a points cost,
 *   and — nested anywhere beneath them — their wargear (weapon-category
 *   selections), enhancement (a selection whose `group` starts "Enhancements"),
 *   the "Warlord" marker, and model sub-selections.
 *
 * @packageDocumentation
 */
import type { FormatAdapter } from "./adapter.js";
import type {
  ParsedLeaderAttachment,
  ParsedRoster,
  ParsedUnit,
  ParsedWargear,
} from "./types.js";

const PTS_COST_NAME = "pts";
const FACTION_CATEGORY = /^Faction:\s*(.+)$/;
const POINTS_LIMIT = /(\d[\d,]*)\s*Point/i;
const ENHANCEMENT_GROUP_PREFIX = "Enhancements";
const ATTACHMENT_GROUP =
  /^40kdc Attachment:(leader|support):(confirmed|provisional)$/;
const CHARACTER_CATEGORIES = new Set(["Character", "Epic Hero"]);
const WEAPON_CATEGORY_SUFFIX = " Weapon"; // "Ranged Weapon", "Melee Weapon", "Psychic Weapon"
const NEWRECRUIT_XMLNS = "http://www.battlescribe.net/schema/rosterSchema";
const NEWRECRUIT_HOST_PREFIX = "https://newrecruit";

// --- Minimal structural views of the parts of the payload we read. ----------

interface RawCategory {
  name?: unknown;
  id?: unknown;
}
interface RawCost {
  name?: unknown;
  value?: unknown;
}
interface RawSelection {
  name?: unknown;
  type?: unknown;
  number?: unknown;
  group?: unknown;
  categories?: unknown;
  costs?: unknown;
  selections?: unknown;
  catalogueName?: unknown;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function selectionName(sel: RawSelection): string {
  return asString(sel.name) ?? "";
}

function selectionType(sel: RawSelection): string {
  return asString(sel.type) ?? "";
}

function selectionCount(sel: RawSelection): number {
  return typeof sel.number === "number" && sel.number > 0 ? sel.number : 1;
}

function pointsOf(sel: RawSelection): number | null {
  for (const raw of asArray(sel.costs)) {
    const cost = raw as RawCost;
    if (asString(cost.name) === PTS_COST_NAME && typeof cost.value === "number") {
      return cost.value;
    }
  }
  return null;
}

function categoryNames(sel: RawSelection): string[] {
  return asArray(sel.categories)
    .map((c) => asString((c as RawCategory).name))
    .filter((n): n is string => n !== null);
}

function childSelections(sel: RawSelection): RawSelection[] {
  return asArray(sel.selections) as RawSelection[];
}

function walk(sel: RawSelection, visit: (s: RawSelection) => void): void {
  visit(sel);
  for (const child of childSelections(sel)) walk(child, visit);
}

function isUnitSelection(sel: RawSelection): boolean {
  const type = selectionType(sel);
  return type === "model" || type === "unit";
}

function isCharacter(sel: RawSelection): boolean {
  return categoryNames(sel).some((n) => CHARACTER_CATEGORIES.has(n));
}
function keywordOverrides(sel: RawSelection): string[] {
  return asArray(sel.categories)
    .map((category) => category as RawCategory)
    .filter((category) => asString(category.id)?.startsWith("40kdc-keyword-"))
    .map((category) => asString(category.name))
    .filter((name): name is string => name !== null);
}


function isWeaponSelection(sel: RawSelection): boolean {
  return categoryNames(sel).some((n) => n.endsWith(WEAPON_CATEGORY_SUFFIX));
}

function isEnhancementSelection(sel: RawSelection): boolean {
  const group = asString(sel.group);
  return group !== null && group.startsWith(ENHANCEMENT_GROUP_PREFIX);
}

function modelCount(unit: RawSelection): number {
  let total = 0;
  walk(unit, (s) => {
    if (selectionType(s) === "model") total += selectionCount(s);
  });
  return total > 0 ? total : selectionCount(unit);
}

function parseUnit(unit: RawSelection): ParsedUnit {
  const wargear: ParsedWargear[] = [];
  let enhancement_raw_name: string | null = null;
  let enhancement_points: number | null = null;
  let is_warlord = false;
  let leader_attachment: ParsedLeaderAttachment | null = null;

  for (const node of childSelections(unit)) {
    walk(node, (s) => {
      const attachment = ATTACHMENT_GROUP.exec(asString(s.group) ?? "");
      if (attachment) {
        leader_attachment = {
          bodyguard_raw_name: selectionName(s),
          role: attachment[1] as "leader" | "support",
          provisional: attachment[2] === "provisional",
        };
        return;
      }
      if (isEnhancementSelection(s)) {
        if (enhancement_raw_name === null) {
          enhancement_raw_name = selectionName(s);
          enhancement_points = pointsOf(s);
        }
        return;
      }
      if (selectionName(s) === "Warlord") {
        is_warlord = true;
        return;
      }
      if (isWeaponSelection(s)) {
        wargear.push({ raw_name: selectionName(s), count: selectionCount(s) });
      }
    });
  }
  const loadout_groups = childSelections(unit)
    .filter((selection) => selectionType(selection) === "model")
    .flatMap((model) => {
      const count = selectionCount(model);
      const totals: ParsedWargear[] = [];
      walk(model, (selection) => {
        if (!isWeaponSelection(selection)) return;
        totals.push({
          raw_name: selectionName(selection),
          count: selectionCount(selection),
        });
      });
      if (count <= 0 || totals.some((item) => item.count % count !== 0)) return [];
      return [{
        model_name: selectionName(model),
        count,
        wargear: totals.map((item) => ({ ...item, count: item.count / count })),
      }];
    });

  return {
    raw_name: selectionName(unit),
    is_character: isCharacter(unit),
    keyword_overrides: keywordOverrides(unit),
    model_count: modelCount(unit),
    points: pointsOf(unit),
    is_warlord,
    enhancement_raw_name,
    enhancement_points,
    leader_attachment,
    wargear,
    ...(loadout_groups.length > 0 ? { loadout_groups } : {}),
  };
}

function configValue(
  selections: RawSelection[],
  configName: string,
): string | null {
  const node = selections.find((s) => selectionName(s) === configName);
  if (!node) return null;
  const child = childSelections(node)[0];
  return child ? selectionName(child) : null;
}

/**
 * Every value selected under a named config — across repeated config nodes
 * (one `Detachment` block per detachment) and multiple children of a single
 * block. Source order is preserved. Used for multi-detachment 11e lists.
 */
function configValues(selections: RawSelection[], configName: string): string[] {
  const out: string[] = [];
  for (const node of selections) {
    if (selectionName(node) !== configName) continue;
    for (const child of childSelections(node)) {
      const name = selectionName(child);
      if (name) out.push(name);
    }
  }
  return out;
}

function parseLimit(label: string | null): number | null {
  if (!label) return null;
  const match = POINTS_LIMIT.exec(label);
  if (!match) return null;
  return Number.parseInt(match[1].replace(/,/g, ""), 10);
}

function collectFactions(forces: RawSelection[]): string[] {
  const seen = new Set<string>();
  for (const force of forces) {
    for (const sel of childSelections(force)) {
      walk(sel, (s) => {
        for (const name of categoryNames(s)) {
          const match = FACTION_CATEGORY.exec(name);
          if (match) seen.add(match[1].trim());
        }
      });
    }
  }
  return [...seen];
}

/** Primary faction from a force's `catalogueName` (e.g. "Chaos - Chaos Knights"
 * → "Chaos Knights"). Returns null when no force has a catalogueName. */
function primaryFactionFromCatalogue(forces: RawSelection[]): string | null {
  for (const force of forces) {
    const name = asString(force.catalogueName);
    if (!name) continue;
    const parts = name.split(" - ");
    const last = parts[parts.length - 1]?.trim();
    if (last) return last;
  }
  return null;
}

interface RawRoster {
  name?: unknown;
  costs?: unknown;
  forces?: unknown;
  xmlns?: unknown;
  generatedBy?: unknown;
}
interface RawPayload {
  name?: unknown;
  generatedBy?: unknown;
  roster?: unknown;
}

function rosterOf(decoded: unknown): RawRoster | null {
  if (!decoded || typeof decoded !== "object") return null;
  const roster = (decoded as RawPayload).roster;
  if (!roster || typeof roster !== "object") return null;
  if (!Array.isArray((roster as RawRoster).forces)) return null;
  return roster as RawRoster;
}

/** Detect a NewRecruit payload: BattleScribe `rosterSchema` xmlns or a
 * `generatedBy` URL pointing at newrecruit.eu. */
function hasNewRecruitSignature(decoded: unknown, roster: RawRoster): boolean {
  const payload = decoded as RawPayload;
  const xmlns = asString(roster.xmlns);
  if (xmlns === NEWRECRUIT_XMLNS) return true;
  const genBy =
    asString(payload.generatedBy) ?? asString(roster.generatedBy);
  if (genBy && genBy.toLowerCase().startsWith(NEWRECRUIT_HOST_PREFIX)) {
    return true;
  }
  return false;
}

export const newRecruitJsonAdapter: FormatAdapter = {
  id: "newrecruit-json",

  matches(decoded: unknown): boolean {
    const roster = rosterOf(decoded);
    if (!roster) return false;
    return hasNewRecruitSignature(decoded, roster);
  },

  parse(decoded: unknown): ParsedRoster {
    const payload = decoded as RawPayload;
    const roster = rosterOf(decoded);
    if (!roster) {
      throw new Error("newrecruit-json: payload has no roster.forces array");
    }

    const forces = asArray(roster.forces) as RawSelection[];

    const detachment_raw_names: string[] = [];
    let battle_size_raw: string | null = null;
    let force_disposition_raw_name: string | null = null;
    const units: ParsedUnit[] = [];
    for (const force of forces) {
      const top = childSelections(force);
      detachment_raw_names.push(...configValues(top, "Detachment"));
      battle_size_raw ??= configValue(top, "Battle Size");
      force_disposition_raw_name ??= configValue(top, "Force Disposition");
      for (const sel of top) {
        if (isUnitSelection(sel)) units.push(parseUnit(sel));
      }
    }

    const factions = collectFactions(forces);
    const primaryFaction = primaryFactionFromCatalogue(forces) ?? factions[0] ?? null;
    const total_reported = pointsOf(roster as RawSelection);

    let total_computed = 0;
    for (const force of forces) {
      for (const sel of childSelections(force)) {
        walk(sel, (s) => {
          const pts = pointsOf(s);
          if (pts) total_computed += pts;
        });
      }
    }

    const generated_by =
      asString(payload.generatedBy) ?? asString(roster.generatedBy);

    return {
      name: asString(payload.name) ?? asString(roster.name) ?? "Imported roster",
      generated_by,
      faction_raw_name: primaryFaction,
      detachment_raw_names,
      battle_size_raw,
      force_disposition_raw_name,
      declared_limit: parseLimit(battle_size_raw),
      total_reported,
      total_computed,
      units,
      multi_force: factions.length > 1,
    };
  },
};
