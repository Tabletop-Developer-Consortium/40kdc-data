/**
 * Rosterizer serializer — emits a Rosterizer-shaped roster JSON skeleton that
 * round-trips through {@link rosterizerAdapter}.
 *
 * The shape carries only fields the importer reads: `rulebook` (envelope),
 * `snapshot` (an `Asset` tree rooted at `Roster§Roster`), and per-unit
 * `item`/`name`/`quantity`/`stats.Points.value`/`assets.included`/`assets.traits`.
 * No `text`, `description`, `rules`, `lineage`, `_layers`, `classIdentity`,
 * `processed`, or `bareResourceKey` ever appear — they aren't stored in the
 * Roster and emitting them could leak prose.
 *
 * Faction display names come from {@link titleCaseId}; detachment display
 * names come from their resolved references.
 *
 * @packageDocumentation
 */
import type { Roster, RosterUnit, RosterWargear } from "../import/types.js";
import { prettyJson, titleCaseId, totalArmyPoints } from "./helpers.js";
import type { RosterSerializer } from "./serializer.js";

// Mirror the importer's constants (kept inline rather than imported so the
// exporter stays decoupled — the seams are the `item` keys themselves).
const CLS_ROSTER = "Roster";
const CLS_FACTION = "Faction";
const CLS_DETACHMENT = "Detachment";
const CLS_UNIT = "Unit";
const CLS_MODEL = "Model";
const CLS_WEAPON = "Weapon";
const CLS_ENHANCEMENT = "Enhancement";
const CLS_BATTLE_SIZE = "Battle Size";
const CLS_TRAIT = "Trait";
const CLS_FORCE_DISPOSITION = "Force Disposition";
const CLS_ATTACHMENT = "Attachment";
const CLS_CHARACTER = "Character";
const CLS_KEYWORD_OVERRIDE = "40kdc Keyword";
const DSG_WARLORD = "Warlord";

const RULEBOOK_NAME = "40kdc";
const RULEBOOK_GAME = "Warhammer 40,000";
const RULEBOOK_PUBLISHER = "Alpaca Software";
const RULEBOOK_URL = "https://40kdc.dev";
const RULEBOOK_GENRE = "wargame";

interface Asset {
  item: string;
  name?: string;
  quantity?: number;
  stats?: Record<string, { value: number }>;
  assets?: {
    included?: Asset[];
    traits?: Asset[];
  };
}

interface Envelope {
  slug: string;
  key: string;
  visible: "hidden" | "public" | "friends";
  locked: boolean;
  rulebook: {
    name: string;
    game: string;
    publisher: string;
    url: string;
    genre: string;
  };
  snapshot: Asset;
}

function key(classification: string, designation: string): string {
  return `${classification}§${designation}`; // §
}

function pointsStat(value: number | null | undefined): Record<string, { value: number }> | undefined {
  if (value === null || value === undefined) return undefined;
  return { Points: { value } };
}

function wargearAsset(w: RosterWargear): Asset {
  return {
    item: key(CLS_WEAPON, w.ref.raw_name),
    name: w.ref.raw_name,
    quantity: w.count,
  };
}

function enhancementAsset(u: RosterUnit): Asset | null {
  if (!u.enhancement) return null;
  return {
    item: key(CLS_ENHANCEMENT, u.enhancement.raw_name),
    name: u.enhancement.raw_name,
    quantity: 1,
    ...(u.enhancement_points !== null
      ? { stats: pointsStat(u.enhancement_points) }
      : {}),
  };
}

function warlordTraitAsset(): Asset {
  return {
    item: key(CLS_TRAIT, DSG_WARLORD),
    name: DSG_WARLORD,
    quantity: 1,
  };
}
function attachmentAsset(u: RosterUnit): Asset | null {
  const attachment = u.leader_attachment;
  if (!attachment) return null;
  const provisional = attachment.provisional ? " [provisional]" : "";
  const display = `Attachment: ${attachment.role} -> ${attachment.bodyguard_ref.raw_name}${provisional}`;
  return { item: key(CLS_ATTACHMENT, display), name: display, quantity: 1 };
}


function keywordTraitAsset(keyword: string): Asset {
  return {
    item: key(
      keyword === "Character" ? CLS_CHARACTER : CLS_KEYWORD_OVERRIDE,
      keyword === "Character" ? "Detachment Character" : keyword,
    ),
    name: keyword === "Character" ? "Detachment Character" : keyword,
    quantity: 1,
  };
}

function loadoutGroupAssets(unit: RosterUnit): Asset[] | null {
  if (!unit.loadout_groups || unit.loadout_groups.length === 0) return null;
  return unit.loadout_groups.map((group) => ({
    item: key(CLS_MODEL, group.model_name ?? unit.ref.raw_name),
    name: group.model_name ?? unit.ref.raw_name,
    quantity: group.count,
    assets: {
      included: group.wargear.map((item) =>
        wargearAsset({
          ...item,
          count: item.count * group.count,
        }),
      ),
    },
  }));
}
function unitAsset(u: RosterUnit): Asset {
  const included: Asset[] = [];
  const enh = enhancementAsset(u);
  const attachment = attachmentAsset(u);
  if (attachment !== null) included.push(attachment);
  if (enh !== null) included.push(enh);
  const loadoutGroups = loadoutGroupAssets(u);
  if (loadoutGroups) included.push(...loadoutGroups);
  else for (const w of u.wargear) included.push(wargearAsset(w));

  const traits: Asset[] = [];
  if (u.is_warlord) traits.push(warlordTraitAsset());
  for (const keyword of u.keyword_overrides ?? []) {
    traits.push(keywordTraitAsset(keyword));
  }

  const asset: Asset = {
    item: key(CLS_UNIT, u.ref.raw_name),
    name: u.ref.raw_name,
    quantity: u.model_count,
  };
  const stats = pointsStat(u.points);
  if (stats !== undefined) asset.stats = stats;
  if (included.length > 0 || traits.length > 0) {
    asset.assets = {};
    if (included.length > 0) asset.assets.included = included;
    if (traits.length > 0) asset.assets.traits = traits;
  }
  return asset;
}

function factionAsset(roster: Roster): Asset | null {
  const display = titleCaseId(roster.faction_id);
  if (display === null) return null;
  return { item: key(CLS_FACTION, display), name: display, quantity: 1 };
}

function detachmentAssets(roster: Roster): Asset[] {
  return roster.detachments.map((d) => {
    const display = d.ref.raw_name;
    return { item: key(CLS_DETACHMENT, display), name: display, quantity: 1 };
  });
}
function forceDispositionAsset(roster: Roster): Asset | null {
  const display = titleCaseId(roster.force_disposition);
  if (display === null) return null;
  return { item: key(CLS_FORCE_DISPOSITION, display), name: display, quantity: 1 };
}


function battleSizeAsset(roster: Roster): Asset | null {
  if (roster.battle_size === "strike-force") {
    const limit = roster.points.declared_limit ?? 2000;
    const label = `Strike Force (${limit} Point limit)`;
    return { item: key(CLS_BATTLE_SIZE, label), name: label, quantity: 1 };
  }
  if (roster.battle_size === "incursion") {
    const limit = roster.points.declared_limit ?? 1000;
    const label = `Incursion (${limit} Point limit)`;
    return { item: key(CLS_BATTLE_SIZE, label), name: label, quantity: 1 };
  }
  return null;
}

export const rosterizerSerializer: RosterSerializer = {
  id: "rosterizer",

  serialize(roster: Roster): string {
    const included: Asset[] = [];
    const faction = factionAsset(roster);
    if (faction) included.push(faction);
    for (const detachment of detachmentAssets(roster)) included.push(detachment);
    const forceDisposition = forceDispositionAsset(roster);
    if (forceDisposition) included.push(forceDisposition);
    const battleSize = battleSizeAsset(roster);
    if (battleSize) included.push(battleSize);
    for (const u of roster.units) included.push(unitAsset(u));

    const total = totalArmyPoints(roster);
    const snapshot: Asset = {
      item: key(CLS_ROSTER, CLS_ROSTER),
      name: roster.name,
      quantity: 1,
      ...(total > 0 ? { stats: pointsStat(total) } : {}),
      assets: { included },
    };

    const envelope: Envelope = {
      slug: "",
      key: "",
      visible: "hidden",
      locked: false,
      rulebook: {
        name: RULEBOOK_NAME,
        game: RULEBOOK_GAME,
        publisher: RULEBOOK_PUBLISHER,
        url: RULEBOOK_URL,
        genre: RULEBOOK_GENRE,
      },
      snapshot,
    };

    return prettyJson(envelope);
  },
};
