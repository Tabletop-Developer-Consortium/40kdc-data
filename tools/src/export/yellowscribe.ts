/**
 * Yellowscribe serializer (`yellowscribe`) — emits a BattleScribe-compatible
 * `.ros` XML document that Yellowscribe (github.com/ThePants999/Yellowscribe)
 * ingests to build an army in Tabletop Simulator.
 *
 * Unlike every other exporter this one is **Dataset-backed**: the {@link Roster}
 * carries only entity ids, counts, and points, but Yellowscribe needs full
 * datasheet stat lines, weapon profiles, keywords, and ability text for its TTS
 * tooltips and mini-datasheets. So this serializer resolves each unit against
 * the {@link Dataset} (via {@link resolveRosterUnit}) and reads the stats /
 * weapons / abilities off the linked views. It implements
 * {@link DatasetSerializer} rather than the Dataset-free `RosterSerializer`, so
 * the other formats are untouched.
 *
 * **IP boundary.** No GW rules prose is ever emitted. Ability descriptions come
 * from the conformance-pinned DSL describer ({@link AbilityView.describe}); the
 * dataset stores no rules text. Everything else is a numeric fact (stat lines,
 * points-free profiles) or a community-authored name.
 *
 * **The Yellowscribe `.ros` contract** (reverse-engineered from `bin/roszParser.js`):
 * - Root `<roster gameSystemId="sys-352e-adc2-7639-d6a9">` (the BattleScribe 40K
 *   10e system id — required; 40kdc's 10e-structured stats map straight onto it).
 * - Path `roster > forces > force > selections > selection[]`.
 * - `selection type="unit"` wraps `type="model"` selections, each wrapping
 *   `type="upgrade"` weapon selections.
 * - Unit stat line: `<profile typeName="Unit">` with `M T SV W LD OC`.
 * - Weapons: `<profile typeName="Ranged Weapons"|"Melee Weapons">` with
 *   `Range A BS WS S AP D Keywords`.
 * - Abilities: `<profile typeName="Abilities">` with a `Description` characteristic.
 * - Keywords: `<categories>` — `"Faction: "`-prefixed names are faction keywords.
 * - **Weapon counts are TOTALS**: Yellowscribe divides by the model count, so we
 *   emit `perModelCount × modelCount`.
 *
 * **Determinism** (byte-identical across the TS/Rust/Python/Go ports for
 * conformance): no sorting — units in `roster.units` order, models in
 * `loadout_groups` order, weapons/keywords/abilities in their stored array
 * order; fixed attribute order; fixed 2-space indent + LF; deterministic
 * synthetic ids (`entityId + index`, never random/UUID); integer stats plain,
 * string stats verbatim; one shared XML escaper.
 *
 * @packageDocumentation
 */
import type { Dataset } from "../data/dataset.js";
import type { UnitView, WeaponView } from "../data/entities.js";
import { resolveRosterUnit } from "../data/roster-resolve.js";
import type { RosterLoadoutGroup, RosterUnit, Roster, RosterWargear } from "../import/types.js";
import type { StatValue } from "../generated.js";
import { titleCaseId } from "./helpers.js";
import type { DatasetSerializer } from "./serializer.js";

/** BattleScribe's Warhammer 40,000 10th-edition game-system id — Yellowscribe
 * rejects a roster whose `gameSystemId` isn't this. */
const GAME_SYSTEM_ID = "sys-352e-adc2-7639-d6a9";
const GAME_SYSTEM_NAME = "Warhammer 40,000";

// ---------------------------------------------------------------------------
// Minimal deterministic XML tree + renderer (no library — a library would
// reorder attributes or normalise whitespace, breaking byte-parity).
// ---------------------------------------------------------------------------

interface XmlEl {
  tag: string;
  /** Attributes in fixed emission order — never from a map/hash. */
  attrs: [string, string][];
  /** Child elements, or a single text body (mutually exclusive with children). */
  children: XmlEl[];
  text?: string;
}

function el(tag: string, attrs: [string, string][], children: XmlEl[]): XmlEl {
  return { tag, attrs, children };
}

function leaf(tag: string, attrs: [string, string][], text: string): XmlEl {
  return { tag, attrs, children: [], text };
}

/** Escape text content: `& < >`. */
function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape an attribute value: `& < > "`. */
function escAttr(s: string): string {
  return escText(s).replace(/"/g, "&quot;");
}

function renderAttrs(attrs: [string, string][]): string {
  return attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("");
}

function render(node: XmlEl, depth: number): string {
  const indent = "  ".repeat(depth);
  const open = `<${node.tag}${renderAttrs(node.attrs)}`;
  if (node.text !== undefined) {
    return `${indent}${open}>${escText(node.text)}</${node.tag}>`;
  }
  if (node.children.length === 0) {
    return `${indent}${open}/>`;
  }
  const inner = node.children.map((c) => render(c, depth + 1)).join("\n");
  return `${indent}${open}>\n${inner}\n${indent}</${node.tag}>`;
}

// ---------------------------------------------------------------------------
// Stat-line rendering (datasheet conventions; deterministic across ports).
// ---------------------------------------------------------------------------

/** Movement: append the inch mark unless the stored value already carries one. */
function fmtMove(m: StatValue): string {
  const s = String(m);
  return s.endsWith('"') ? s : `${s}"`;
}

/** A "target-number" stat (Sv, Ld, BS, WS): append `+`. */
function fmtTarget(v: number): string {
  return `${v}+`;
}

/** A weapon keyword's display label: `Anti-Infantry 4+`, `Rapid Fire 1`, or a
 * bare `Devastating Wounds`. Mirrors the datasheet convention. */
function keywordLabel(
  name: string,
  parameters: Record<string, unknown> | undefined,
): string {
  if (parameters) {
    const tk = parameters.target_keyword;
    const th = parameters.threshold;
    if (typeof tk === "string" && (typeof th === "number" || typeof th === "string")) {
      return `${name}-${tk} ${th}+`;
    }
    const value = parameters.value;
    if (value !== undefined && value !== null) {
      return `${name} ${String(value)}`;
    }
  }
  return name;
}

// ---------------------------------------------------------------------------
// Profile builders.
// ---------------------------------------------------------------------------

/** The `<profile typeName="Unit">` stat line(s). Emits one profile per unit
 * stat profile (degrading/wound-track units carry several). */
function unitStatProfiles(view: UnitView): XmlEl[] {
  return view.raw.profiles.map((p, i) => {
    const name = p.name ?? (i === 0 ? view.name : `${view.name} (${i + 1})`);
    return el("profile", [["name", name], ["typeName", "Unit"]], [
      el("characteristics", [], [
        leaf("characteristic", [["name", "M"]], fmtMove(p.M)),
        leaf("characteristic", [["name", "T"]], String(p.T)),
        leaf("characteristic", [["name", "SV"]], fmtTarget(p.Sv)),
        leaf("characteristic", [["name", "W"]], String(p.W)),
        leaf("characteristic", [["name", "LD"]], fmtTarget(p.Ld)),
        leaf("characteristic", [["name", "OC"]], String(p.OC)),
      ]),
    ]);
  });
}

/** `<profile typeName="Abilities">` entries: the invuln save (a numeric fact)
 * followed by each ability's describer-rendered text. */
function abilityProfiles(view: UnitView): XmlEl[] {
  const out: XmlEl[] = [];
  const invuln = view.profileAt(0).invuln_sv;
  if (invuln !== undefined && invuln !== null) {
    out.push(abilityProfile("Invulnerable Save", `${invuln}+ invulnerable save`));
  }
  for (const ability of view.abilities) {
    out.push(abilityProfile(ability.name, ability.describe()));
  }
  return out;
}

function abilityProfile(name: string, description: string): XmlEl {
  return el("profile", [["name", name], ["typeName", "Abilities"]], [
    el("characteristics", [], [
      leaf("characteristic", [["name", "Description"]], description),
    ]),
  ]);
}

/** A weapon's `<profile>` list — one per weapon stat profile (e.g. a plasma
 * gun's standard / supercharge). Ranged weapons carry `BS`, melee carry `WS`
 * and a `Melee` range. */
function weaponProfiles(weapon: WeaponView): XmlEl[] {
  const ranged = weapon.raw.type === "ranged";
  const typeName = ranged ? "Ranged Weapons" : "Melee Weapons";
  return weapon.raw.profiles.map((p, i) => {
    const stats = p.stats;
    const range = ranged ? fmtMove(p.range ?? 0) : "Melee";
    const skillName = ranged ? "BS" : "WS";
    const skill = ranged ? stats.BS : stats.WS;
    const keywords = weapon
      .keywordsAt(i)
      .map((k) => keywordLabel(k.keyword.name, k.parameters))
      .join(", ");
    return el("profile", [["name", p.name], ["typeName", typeName]], [
      el("characteristics", [], [
        leaf("characteristic", [["name", "Range"]], range),
        leaf("characteristic", [["name", "A"]], String(stats.A)),
        leaf(
          "characteristic",
          [["name", skillName]],
          typeof skill === "number" ? fmtTarget(skill) : "N/A",
        ),
        leaf("characteristic", [["name", "S"]], String(stats.S)),
        leaf("characteristic", [["name", "AP"]], String(stats.AP)),
        leaf("characteristic", [["name", "D"]], String(stats.D)),
        leaf("characteristic", [["name", "Keywords"]], keywords),
      ]),
    ]);
  });
}

// ---------------------------------------------------------------------------
// Selection tree.
// ---------------------------------------------------------------------------

/** Resolve a wargear ref to its weapon view, faction-first (matching how a
 * `UnitView` resolves its own weapon ids). */
function resolveWeapon(w: RosterWargear, dataset: Dataset, factionId: string | null): WeaponView | undefined {
  const id = w.ref.id;
  if (id === null) return undefined;
  return (factionId ? dataset.weapons.getInFaction(id, factionId) : undefined) ?? dataset.weapons.getAny(id);
}

/** One weapon `<selection type="upgrade">`. `number` is the TOTAL across the
 * group's models (`perModel × groupModelCount`) — Yellowscribe divides it back
 * out by the model count. */
function upgradeSelection(
  id: string,
  weapon: WeaponView,
  totalCount: number,
): XmlEl {
  return el(
    "selection",
    [["id", id], ["name", weapon.name], ["type", "upgrade"], ["number", String(totalCount)]],
    [el("profiles", [], weaponProfiles(weapon))],
  );
}

/** One `<selection type="model">` for a loadout group, with its per-model
 * weapons nested as upgrade selections. */
function modelSelection(
  idBase: string,
  modelName: string,
  modelCount: number,
  wargear: RosterWargear[],
  dataset: Dataset,
  factionId: string | null,
): XmlEl {
  const upgrades: XmlEl[] = [];
  wargear.forEach((w, wi) => {
    const weapon = resolveWeapon(w, dataset, factionId);
    if (!weapon) return; // unresolved weapon — skip (already flagged in diagnostics)
    upgrades.push(upgradeSelection(`${idBase}-w${wi}`, weapon, w.count * modelCount));
  });
  const children: XmlEl[] = [];
  if (upgrades.length > 0) children.push(el("selections", [], upgrades));
  return el(
    "selection",
    [["id", idBase], ["name", modelName], ["type", "model"], ["number", String(modelCount)]],
    children,
  );
}

/** The nested `<selection type="model">` list for a unit — one per loadout
 * group, falling back to a single group over the flat `wargear[]` (whose counts
 * are already unit totals, so per-model = total / model_count, as Yellowscribe
 * expects). */
function modelSelections(unit: RosterUnit, unitId: string, view: UnitView, dataset: Dataset, factionId: string | null): XmlEl[] {
  const groups: RosterLoadoutGroup[] =
    unit.loadout_groups && unit.loadout_groups.length > 0
      ? unit.loadout_groups
      : [{ model_name: null, count: unit.model_count, wargear: unit.wargear }];
  return groups.map((g, gi) =>
    modelSelection(
      `${unitId}-m${gi}`,
      g.model_name ?? view.name,
      g.count,
      g.wargear,
      dataset,
      factionId,
    ),
  );
}

/** The unit categories (`<category>`): faction keywords (prefixed `"Faction: "`)
 * then general keywords, in stored order. */
function categoriesEl(view: UnitView): XmlEl | null {
  const cats: XmlEl[] = [];
  for (const k of view.raw.faction_keywords ?? []) {
    cats.push(leaf("category", [["name", `Faction: ${k}`]], ""));
  }
  for (const k of view.raw.keywords ?? []) {
    cats.push(leaf("category", [["name", k]], ""));
  }
  // `<category>` carries no body — emit as self-closing rather than `></>`.
  const selfClosing = cats.map((c) => el(c.tag, c.attrs, []));
  return selfClosing.length > 0 ? el("categories", [], selfClosing) : null;
}

/** One unit `<selection type="unit">`. Returns null for a unit that doesn't
 * resolve against the dataset (no datasheet to emit stats from). */
function unitSelection(unit: RosterUnit, index: number, dataset: Dataset, factionId: string | null): XmlEl | null {
  const view = resolveRosterUnit(unit, dataset, factionId);
  if (!view) return null;
  const unitId = `unit${index}`;

  const profiles = [...unitStatProfiles(view), ...abilityProfiles(view)];
  const children: XmlEl[] = [el("profiles", [], profiles)];

  const cats = categoriesEl(view);
  if (cats) children.push(cats);

  const models = modelSelections(unit, unitId, view, dataset, factionId);
  children.push(el("selections", [], models));

  return el(
    "selection",
    [["id", unitId], ["name", unit.ref.raw_name], ["type", "unit"], ["number", "1"]],
    children,
  );
}

export const yellowscribeSerializer: DatasetSerializer = {
  id: "yellowscribe",

  serialize(roster: Roster, dataset: Dataset): string {
    const factionId = roster.faction_id;
    const factionName = titleCaseId(factionId) ?? "Unknown";

    const unitSelections: XmlEl[] = [];
    roster.units.forEach((unit, i) => {
      const sel = unitSelection(unit, i, dataset, factionId);
      if (sel) unitSelections.push(sel);
    });

    const force = el(
      "force",
      [
        ["id", "force0"],
        ["name", factionName],
        ["catalogueName", factionName],
      ],
      [el("selections", [], unitSelections)],
    );

    const rosterEl = el(
      "roster",
      [
        ["id", "roster0"],
        ["name", roster.name],
        ["gameSystemId", GAME_SYSTEM_ID],
        ["gameSystemName", GAME_SYSTEM_NAME],
      ],
      [el("forces", [], [force])],
    );

    return `<?xml version="1.0" encoding="utf-8"?>\n${render(rosterEl, 0)}\n`;
  },
};
