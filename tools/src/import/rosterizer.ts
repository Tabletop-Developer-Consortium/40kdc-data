/**
 * Rosterizer adapter: lower a Rosterizer roster JSON payload to a
 * {@link ParsedRoster}.
 *
 * Rosterizer (https://rosterizer.com) stores a roster as a `Roster` envelope
 * with a recursive `Asset` tree under `snapshot` (or `history.present.roster`
 * as a fallback). Every entity — faction, detachment, unit, weapon, ability,
 * enhancement — is an `Asset` keyed by `Classification§Designation` (e.g.
 * `"Unit§Tactical Squad"`). Children sit under `assets.included` (game pieces)
 * and `assets.traits` (modifiers, abilities, markers).
 *
 * The schema is rulebook-agnostic, so the actual `Classification` strings come
 * from whichever Rosterizer rulebook authored the roster. The constants below
 * encode the 40K convention used by the 40kdc reference rulebook; tune
 * them here without touching parser logic if a real export disagrees.
 *
 * **IP safety**: the walk reads an ALLOWLIST — `item`, `designation`, `name`,
 * `classification`, `quantity`, `meta.points`, `stats.Points.value`,
 * `aspects.Visibility`, and the recursive `assets.included`/`assets.traits`
 * children. Prose-bearing fields — `text`, `description`, `rules`, ability
 * `stats`, `_layers`, `lineage`, `processed`, `classIdentity`, `bareResourceKey`
 * — are never touched, so the importer's output is free of copyrighted prose
 * by construction.
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

// --- 40K rulebook Classification§Designation conventions. -------------------
// These pin the strings the adapter looks for. Tune them in one place if a
// real Rosterizer export uses different labels.

const CLS_ROSTER = "Roster";
const CLS_FACTION = "Faction";
const CLS_DETACHMENT = "Detachment";
const CLS_UNIT = "Unit";
const CLS_SQUAD = "Squad"; // alternative unit class some rulebooks use
const CLS_MODEL = "Model";
const CLS_WEAPON = "Weapon";
const CLS_ENHANCEMENT = "Enhancement";
const CLS_BATTLE_SIZE = "Battle Size";
const CLS_TRAIT = "Trait";
const CLS_FORCE_DISPOSITION = "Force Disposition";
const CLS_ATTACHMENT = "Attachment";
const CLS_KEYWORD_OVERRIDE = "40kdc Keyword";
const DSG_WARLORD = "Warlord";
const CHAR_CLASSIFICATIONS: Record<string, true> = { Character: true, "Epic Hero": true };
const ATTACHMENT =
  /^Attachment:\s*(leader|support)\s*->\s*(.+?)(\s+\[provisional\])?\s*$/i;

const POINTS_STAT_KEYS = ["Points", "Pts"];
const POINTS_LIMIT = /(\d[\d,]*)\s*Point/i;

// --- Structural views ------------------------------------------------------

interface RawStat {
  value?: unknown;
}
interface RawAspects {
  Visibility?: unknown;
}
interface RawAssetChildren {
  included?: unknown;
  traits?: unknown;
}
interface RawAsset {
  item?: unknown;
  name?: unknown;
  designation?: unknown;
  classification?: unknown;
  quantity?: unknown;
  aspects?: unknown;
  assets?: unknown;
  meta?: unknown;
  stats?: unknown;
  keywords?: unknown;
}
interface RawRulebook {
  name?: unknown;
  game?: unknown;
  publisher?: unknown;
  url?: unknown;
}
interface RawHistoryItem {
  roster?: unknown;
  note?: unknown;
}
interface RawHistory {
  present?: unknown;
}
interface RawEnvelope {
  rulebook?: unknown;
  snapshot?: unknown;
  history?: unknown;
  slug?: unknown;
  authors?: unknown;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Split `Classification§Designation` into its two halves. Falls back to the
 * raw `classification`/`designation` fields when `item` is absent. */
function splitItem(asset: RawAsset): { classification: string; designation: string } {
  const item = asString(asset.item);
  if (item !== null) {
    const idx = item.indexOf("§"); // §
    if (idx >= 0) {
      return {
        classification: item.slice(0, idx),
        designation: item.slice(idx + 1),
      };
    }
  }
  return {
    classification: asString(asset.classification) ?? "",
    designation: asString(asset.designation) ?? "",
  };
}

/** A user-facing display name for an asset: `name` override beats the
 * designation parsed out of the `item` key. */
function displayName(asset: RawAsset): string {
  return asString(asset.name) ?? splitItem(asset).designation;
}

function quantity(asset: RawAsset): number {
  const n = asNumber(asset.quantity);
  return n !== null && n > 0 ? Math.trunc(n) : 1;
}

function included(asset: RawAsset): RawAsset[] {
  const a = asset.assets as RawAssetChildren | undefined;
  return asArray(a?.included) as RawAsset[];
}

function traits(asset: RawAsset): RawAsset[] {
  const a = asset.assets as RawAssetChildren | undefined;
  return asArray(a?.traits) as RawAsset[];
}

/** Points cost from `stats.Points.value` (or aliases) / `meta.points`, or null. */
function pointsOf(asset: RawAsset): number | null {
  const stats = asObject(asset.stats);
  if (stats) {
    for (const key of POINTS_STAT_KEYS) {
      const stat = asObject(stats[key]) as RawStat | null;
      if (stat) {
        const v = asNumber(stat.value);
        if (v !== null) return Math.trunc(v);
      }
    }
  }
  const meta = asObject(asset.meta);
  if (meta) {
    const v = asNumber(meta.points);
    if (v !== null) return Math.trunc(v);
  }
  return null;
}

/** Depth-first visit of an asset and every included/trait descendant. */
function walk(asset: RawAsset, visit: (a: RawAsset) => void): void {
  visit(asset);
  for (const child of included(asset)) walk(child, visit);
  for (const child of traits(asset)) walk(child, visit);
}

function classOf(asset: RawAsset): string {
  return splitItem(asset).classification;
}

function isUnitAsset(asset: RawAsset): boolean {
  const cls = classOf(asset);
  return cls === CLS_UNIT || cls === CLS_SQUAD;
}

function isWeaponAsset(asset: RawAsset): boolean {
  const cls = classOf(asset);
  // Match exact "Weapon", or any "<X> Weapon" classification (e.g. "Ranged Weapon").
  return cls === CLS_WEAPON || cls.endsWith(` ${CLS_WEAPON}`);
}

function isEnhancementAsset(asset: RawAsset): boolean {
  return classOf(asset) === CLS_ENHANCEMENT;
}

function isCharacterAsset(asset: RawAsset): boolean {
  const keywords = asObject(asset.keywords);
  if (keywords) {
    for (const list of Object.values(keywords)) {
      for (const kw of asArray(list)) {
        if (typeof kw === "string" && CHAR_CLASSIFICATIONS[kw]) return true;
      }
    }
  }
  // Any nested trait classified as Character also flags the unit.
  for (const t of traits(asset)) {
    if (CHAR_CLASSIFICATIONS[classOf(t)]) return true;
    const dsg = displayName(t);
    if (CHAR_CLASSIFICATIONS[dsg]) return true;
  }
  return false;
}

function isWarlordTrait(asset: RawAsset): boolean {
  const { classification, designation } = splitItem(asset);
  if (designation === DSG_WARLORD) return true;
  return classification === CLS_TRAIT && designation === DSG_WARLORD;
}

/** Sum every Weapon/Enhancement-bearing leaf quantity to derive the unit's
 * model count. Falls back to `quantity(unit)` when the tree has no per-model
 * markers (single-model entries). */
function modelCount(unit: RawAsset): number {
  // Rosterizer doesn't carve "model" out separately from "unit" the way
  // BattleScribe does; the unit's own quantity is the model count for
  // squads. For multi-model squads with explicit per-model children, each
  // child unit-class asset's quantity contributes.
  let nested = 0;
  for (const child of included(unit)) {
    if (isUnitAsset(child) || classOf(child) === CLS_MODEL) nested += quantity(child);
  }
  return nested > 0 ? nested : quantity(unit);
}

function parseUnit(unit: RawAsset): ParsedUnit {
  const wargear: ParsedWargear[] = [];
  let enhancement_raw_name: string | null = null;
  let enhancement_points: number | null = null;
  let is_warlord = false;
  let leader_attachment: ParsedLeaderAttachment | null = null;
  const keyword_overrides = new Set<string>();

  for (const child of included(unit)) {
    walk(child, (a) => {
      if (classOf(a) === CLS_ATTACHMENT) {
        const match = ATTACHMENT.exec(displayName(a));
        if (match) {
          leader_attachment = {
            role: match[1].toLowerCase() as "leader" | "support",
            bodyguard_raw_name: match[2],
            provisional: match[3] !== undefined,
          };
        }
        return;
      }
      if (isEnhancementAsset(a)) {
        if (enhancement_raw_name === null) {
          enhancement_raw_name = displayName(a);
          enhancement_points = pointsOf(a);
        }
        return;
      }
      if (isWeaponAsset(a)) {
        wargear.push({ raw_name: displayName(a), count: quantity(a) });
      }
    });
  }
  const loadout_groups = included(unit)
    .filter((child) => classOf(child) === CLS_MODEL)
    .map((model) => {
      const count = quantity(model);
      const groupWargear: ParsedWargear[] = [];
      walk(model, (asset) => {
        if (!isWeaponAsset(asset)) return;
        const total = quantity(asset);
        groupWargear.push({
          raw_name: displayName(asset),
          count: count > 0 && total % count === 0 ? total / count : total,
        });
      });
      return {
        model_name: displayName(model),
        count,
        wargear: groupWargear,
      };
    });
  for (const t of traits(unit)) {
    walk(t, (a) => {
      if (isWarlordTrait(a)) is_warlord = true;
      const { classification, designation } = splitItem(a);
      if (classification === CLS_KEYWORD_OVERRIDE) {
        keyword_overrides.add(designation);
      } else if (CHAR_CLASSIFICATIONS[classification]) {
        keyword_overrides.add("Character");
      }
    });
  }

  return {
    raw_name: displayName(unit),
    is_character: isCharacterAsset(unit),
    ...(keyword_overrides.size ? { keyword_overrides: [...keyword_overrides] } : {}),
    model_count: modelCount(unit),
    points: pointsOf(unit),
    is_warlord,
    enhancement_raw_name,
    enhancement_points,
    wargear,
    leader_attachment,
    ...(loadout_groups.length > 0 ? { loadout_groups } : {}),
  };
}

/** Resolve the snapshot Asset tree from an envelope, preferring the explicit
 * `snapshot` field but falling through to the history-present roster. */
function snapshotOf(env: RawEnvelope): RawAsset | null {
  const snap = asObject(env.snapshot);
  if (snap) return snap as RawAsset;
  const history = asObject(env.history) as RawHistory | null;
  const present = history && asObject(history.present);
  if (present) {
    const present_roster = asObject((present as RawHistoryItem).roster);
    if (present_roster) return present_roster as RawAsset;
  }
  return null;
}

function isRosterizerEnvelope(decoded: unknown): decoded is RawEnvelope {
  const env = asObject(decoded) as RawEnvelope | null;
  if (!env) return false;
  if (!asObject(env.rulebook)) return false;
  return snapshotOf(env) !== null;
}

/** Find the first child Asset with the given classification, if any. */
function findChildByClass(asset: RawAsset, cls: string): RawAsset | null {
  for (const c of included(asset)) {
    if (classOf(c) === cls) return c;
  }
  return null;
}

function parseLimit(label: string | null): number | null {
  if (!label) return null;
  const match = POINTS_LIMIT.exec(label);
  if (!match) return null;
  return Number.parseInt(match[1].replace(/,/g, ""), 10);
}

export const rosterizerAdapter: FormatAdapter = {
  id: "rosterizer",

  matches(decoded: unknown): boolean {
    return isRosterizerEnvelope(decoded);
  },

  parse(decoded: unknown): ParsedRoster {
    if (!isRosterizerEnvelope(decoded)) {
      throw new Error("rosterizer: payload is not a Rosterizer roster envelope");
    }
    const snapshot = snapshotOf(decoded);
    if (snapshot === null) {
      throw new Error("rosterizer: envelope has no snapshot or history.present.roster");
    }

    // Treat the snapshot as the roster root regardless of its `item` value —
    // some exports root at `Roster§Roster`, others at the faction itself.
    const root = snapshot;

    // Roster-level metadata children. Faction and detachment come from the
    // first child Asset of their respective classification; battle size the
    // same way. Walk the whole tree (rather than just root.assets.included)
    // so nested-force shapes still pick up the markers.
    let faction_raw_name: string | null = null;
    const detachment_raw_names: string[] = [];
    let battle_size_raw: string | null = null;
    let force_disposition_raw_name: string | null = null;
    const factions: string[] = [];
    walk(root, (a) => {
      const cls = classOf(a);
      if (cls === CLS_FACTION) {
        const name = displayName(a);
        if (!factions.includes(name)) factions.push(name);
        faction_raw_name ??= name;
      } else if (cls === CLS_DETACHMENT) {
        detachment_raw_names.push(displayName(a));
      } else if (cls === CLS_BATTLE_SIZE) {
        battle_size_raw ??= displayName(a);
      } else if (cls === CLS_FORCE_DISPOSITION) {
        force_disposition_raw_name ??= displayName(a);
      }
    });

    // Allow the rulebook envelope to carry a battle-size override (e.g.
    // `rulebook.notes: "2000 Point limit"`) — strictly optional.
    if (battle_size_raw === null) {
      const rulebook = asObject((decoded as RawEnvelope).rulebook) as RawRulebook | null;
      // Intentionally not reading rulebook.notes — it may carry prose.
      void rulebook;
    }

    // Collect units: any Unit/Squad asset anywhere in the tree, excluding
    // ones nested under another unit (those are attached leaders we'll fold
    // into leader_attachment via the resolver — but ParsedUnit doesn't model
    // them yet, so for v1 every Unit asset becomes a top-level ParsedUnit).
    const units: ParsedUnit[] = [];
    const collectUnits = (a: RawAsset, underUnit: boolean): void => {
      if (isUnitAsset(a) && !underUnit) {
        units.push(parseUnit(a));
        for (const c of included(a)) collectUnits(c, true);
        for (const c of traits(a)) collectUnits(c, true);
        return;
      }
      if (isUnitAsset(a) && underUnit) {
        // Nested unit (leader on a body, body on a leader, etc.) — emit it as
        // its own top-level ParsedUnit so the resolver can match its id and
        // the leader-attachment inference pass can link the two.
        units.push(parseUnit(a));
        return;
      }
      for (const c of included(a)) collectUnits(c, underUnit);
      for (const c of traits(a)) collectUnits(c, underUnit);
    };
    collectUnits(root, false);

    // Roster-level total: prefer an explicit Points stat on the root, else
    // sum every unit's (base + enhancement) contribution.
    const total_reported = pointsOf(root);
    let total_computed = 0;
    for (const u of units) {
      total_computed += u.points ?? 0;
      total_computed += u.enhancement_points ?? 0;
    }

    const env = decoded as RawEnvelope;
    const rulebook = asObject(env.rulebook) as RawRulebook | null;
    const generated_by = rulebook ? asString(rulebook.name) ?? asString(rulebook.url) : null;
    const name = displayName(root) || asString(rulebook?.name) || "Imported roster";

    return {
      name,
      generated_by,
      faction_raw_name,
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

// Internals re-exported for the symmetric exporter and unit tests.
export const _internals = {
  CLS_ROSTER,
  CLS_FACTION,
  CLS_DETACHMENT,
  CLS_UNIT,
  CLS_WEAPON,
  CLS_ENHANCEMENT,
  CLS_BATTLE_SIZE,
  CLS_TRAIT,
  DSG_WARLORD,
  POINTS_STAT_KEYS,
  splitItem,
  displayName,
  classOf,
  findChildByClass,
};
