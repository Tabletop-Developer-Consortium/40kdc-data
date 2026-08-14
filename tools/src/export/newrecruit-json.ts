/**
 * NewRecruit JSON exporter — emits a BattleScribe-shaped roster skeleton that
 * round-trips through {@link newRecruitJsonAdapter}.
 *
 * The shape carries only fields the importer reads: `name`, `type`, `number`,
 * `costs[]`, `categories[].name`, `group`, and `catalogueName`. No `rules` /
 * `profiles` / `description` ever appear — we don't store them, and emitting
 * them would be an IP violation.
 *
 * Faction and detachment display names come from
 * {@link titleCaseId}(faction_id) — the Roster doesn't carry the source's raw
 * faction name, so we reconstruct it from the kebab-case id. This is the only
 * lossy hop in the JSON round-trip (e.g. `tau-empire` → "Tau Empire" rather
 * than the canonical "T'au Empire").
 *
 * @packageDocumentation
 */
import type { Roster, RosterUnit, RosterWargear } from "../import/types.js";
import { prettyJson, titleCaseId, totalArmyPoints } from "./helpers.js";
import type { RosterSerializer } from "./serializer.js";

const PTS_TYPE_ID = "pts-type";
const NEWRECRUIT_XMLNS = "http://www.battlescribe.net/schema/rosterSchema";
const NEWRECRUIT_GENERATED_BY = "https://newrecruit.eu";
const ATTACHMENT_GROUP_PREFIX = "40kdc Attachment";

interface JsonSelection {
  id: string;
  name: string;
  type: "model" | "unit" | "upgrade";
  number: number;
  group?: string;
  categories?: { name: string; primary: boolean }[];
  costs?: { name: string; typeId: string; value: number }[];
  selections?: JsonSelection[];
}

interface JsonForce {
  id: string;
  name: string;
  catalogueName: string;
  selections: JsonSelection[];
}

interface JsonRoster {
  name: string;
  xmlns: string;
  generatedBy: string;
  costs: { name: string; typeId: string; value: number }[];
  forces: JsonForce[];
}

interface JsonPayload {
  name: string;
  generatedBy: string;
  roster: JsonRoster;
}

/** Build a "Faction: <name>" category from the unit's roster context. */
function factionCategory(roster: Roster): { name: string; primary: boolean } | null {
  const display = titleCaseId(roster.faction_id);
  if (display === null) return null;
  return { name: `Faction: ${display}`, primary: false };
}

function wargearSelection(idx: number, w: RosterWargear): JsonSelection {
  return {
    id: `w-${idx}`,
    name: w.ref.raw_name,
    type: "upgrade",
    number: w.count,
    // The NewRecruit importer recognises a wargear selection by a category
    // ending in " Weapon" — emit a generic "Ranged Weapon" so we don't have
    // to track ranged-vs-melee separation the Roster doesn't model.
    categories: [{ name: "Ranged Weapon", primary: false }],
  };
}

function unitSelection(idx: number, u: RosterUnit, faction: { name: string; primary: boolean } | null): JsonSelection {
  const inner: JsonSelection[] = [];
  if (u.is_warlord) {
    inner.push({ id: `u${idx}-warlord`, name: "Warlord", type: "upgrade", number: 1 });
  }
  if (u.leader_attachment) {
    const attachment = u.leader_attachment;
    inner.push({
      id: `u${idx}-attachment`,
      name: attachment.bodyguard_ref.raw_name,
      type: "upgrade",
      number: 1,
      group: `${ATTACHMENT_GROUP_PREFIX}:${attachment.role}:${
        attachment.provisional ? "provisional" : "confirmed"
      }`,
    });
  }
  if (u.enhancement) {
    const enhCost =
      u.enhancement_points === null
        ? undefined
        : [{ name: "pts", typeId: PTS_TYPE_ID, value: u.enhancement_points }];
    inner.push({
      id: `u${idx}-enh`,
      name: u.enhancement.raw_name,
      type: "upgrade",
      number: 1,
      group: "Enhancements",
      ...(enhCost ? { costs: enhCost } : {}),
    });
  }

  const wargearSelections = u.wargear.map((w, wi) => wargearSelection(wi, w));
  const modelSelections: JsonSelection[] =
    u.loadout_groups && u.loadout_groups.length > 0
      ? u.loadout_groups.map((group, groupIndex) => ({
          id: `u${idx}-model-${groupIndex}`,
          name: group.model_name ?? u.ref.raw_name,
          type: "model",
          number: group.count,
          selections: group.wargear.map((item, itemIndex) =>
            wargearSelection(itemIndex, {
              ...item,
              count: item.count * group.count,
            }),
          ),
        }))
      : [
          {
            id: `u${idx}-model`,
            name: u.ref.raw_name,
            type: "model",
            number: u.model_count,
            selections: wargearSelections,
          },
        ];

  const ownCategories = [
    ...(faction ? [faction] : []),
    ...(u.keyword_overrides ?? []).map((keyword, index) => ({
      id: `40kdc-keyword-${index}`,
      name: keyword,
      primary: false,
    })),
  ];

  if (u.model_count <= 1 && (!u.loadout_groups || u.loadout_groups.length === 0)) {
    return {
      id: `u-${idx}`,
      name: u.ref.raw_name,
      type: "model",
      number: 1,
      categories: ownCategories,
      ...(u.points === null ? {} : { costs: [{ name: "pts", typeId: PTS_TYPE_ID, value: u.points }] }),
      selections: [...inner, ...wargearSelections],
    };
  }

  // Preserve exact groups under a unit wrapper. Multi-model units need this
  // shape for counts; single-model units need it to retain the model name.
  return {
    id: `u-${idx}`,
    name: u.ref.raw_name,
    type: "unit",
    number: 1,
    categories: ownCategories,
    ...(u.points === null ? {} : { costs: [{ name: "pts", typeId: PTS_TYPE_ID, value: u.points }] }),
    selections: [
      ...inner,
      ...modelSelections,
    ],
  };
}

function configSelection(name: string, value: string, idx: string): JsonSelection {
  return {
    id: `cfg-${idx}`,
    name,
    type: "upgrade",
    number: 1,
    categories: [{ name: "Configuration", primary: true }],
    selections: [
      {
        id: `cfg-${idx}-val`,
        name: value,
        type: "upgrade",
        number: 1,
      },
    ],
  };
}

function battleSizeLabel(roster: Roster): string | null {
  if (roster.battle_size === "strike-force") {
    const limit = roster.points.declared_limit ?? 2000;
    return `Strike Force (${limit} Point limit)`;
  }
  if (roster.battle_size === "incursion") {
    const limit = roster.points.declared_limit ?? 1000;
    return `Incursion (${limit} Point limit)`;
  }
  return null;
}

export const newRecruitJsonSerializer: RosterSerializer = {
  id: "newrecruit-json",

  serialize(roster: Roster): string {
    const faction = factionCategory(roster);
    const factionDisplay = titleCaseId(roster.faction_id) ?? "Unknown";
    const battleSize = battleSizeLabel(roster);

    const config: JsonSelection[] = [];
    if (battleSize) config.push(configSelection("Battle Size", battleSize, "battle-size"));
    for (const d of roster.detachments) {
      config.push(configSelection("Detachment", d.ref.raw_name, "detachment"));
    }
    if (roster.force_disposition !== null) {
      config.push(
        configSelection(
          "Force Disposition",
          titleCaseId(roster.force_disposition)!,
          "force-disposition",
        ),
      );
    }

    const force: JsonForce = {
      id: "force-1",
      name: "Army Roster",
      catalogueName: factionDisplay,
      selections: [
        ...config,
        ...roster.units.map((u, i) => unitSelection(i, u, faction)),
      ],
    };

    const total = totalArmyPoints(roster);

    const payload: JsonPayload = {
      name: roster.name,
      generatedBy: NEWRECRUIT_GENERATED_BY,
      roster: {
        name: roster.name,
        xmlns: NEWRECRUIT_XMLNS,
        generatedBy: NEWRECRUIT_GENERATED_BY,
        costs: [{ name: "pts", typeId: PTS_TYPE_ID, value: total }],
        forces: [force],
      },
    };

    return prettyJson(payload);
  },
};
