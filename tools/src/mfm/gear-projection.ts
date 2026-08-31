import { MfmDump, type WargearItemRow } from "./loader.js";

export interface GameVersion {
  edition: string;
  dataslate: string;
}

export interface WeaponProfile {
  name: string;
  range: number | "Melee";
  stats: {
    A: number | string;
    BS?: number | null;
    WS?: number | null;
    S: number | string;
    AP: number;
    D: number | string;
  };
  keywords?: { keyword_id: string; parameters?: Record<string, unknown> }[];
}

export interface WeaponRecord {
  id: string;
  external_refs: { namespace: string; id: string }[];
  name: string;
  type: "ranged" | "melee";
  profiles: WeaponProfile[];
  game_version: GameVersion;
}

export interface WargearRecord {
  id: string;
  external_refs: { namespace: string; id: string }[];
  name: string;
  game_version: GameVersion;
  category?: string;
}

export interface MintContext {
  dump: MfmDump;
  gv: GameVersion;
  warnings: string[];
}

/** Parse one dump wargear ability display name into repo keyword references. */
function mapWeaponKeyword(
  raw: string,
): { keyword_id: string; parameters?: Record<string, unknown> }[] | null {
  const name = raw.trim();
  const lower = name.toLowerCase();
  const anti = lower.match(/^anti-([a-z/ ]+?)\s*(\d)\+$/);
  if (anti) {
    const threshold = Number(anti[2]);
    return anti[1]
      .split("/")
      .map((target) => target.trim())
      .filter(Boolean)
      .map((target) => ({
        keyword_id: "anti",
        parameters: {
          target_keyword: target.replace(/\b\w/g, (character) =>
            character.toUpperCase(),
          ),
          threshold,
        },
      }));
  }

  const valued = name.match(
    /^([A-Za-z\- ]+?)\s+(\d+|D\d+(?:\+\d+)?|\d*[dD]\d+(?:\+\d+)?)$/,
  );
  if (valued) {
    const base = valued[1].trim().toLowerCase();
    const rawValue = valued[2];
    const value: number | string = /^\d+$/.test(rawValue)
      ? Number(rawValue)
      : rawValue.toUpperCase();
    const byBase: Record<string, string> = {
      melta: "melta",
      "rapid fire": "rapid-fire",
      "sustained hits": "sustained-hits",
      cleave: "cleave",
    };
    if (byBase[base])
      return [{ keyword_id: byBase[base], parameters: { value } }];
    if (base === "blast") return [{ keyword_id: "blast" }];
  }

  const flat: Record<string, string> = {
    "lethal hits": "lethal-hits",
    "devastating wounds": "devastating-wounds",
    "twin-linked": "twin-linked",
    "rapid fire": "rapid-fire",
    heavy: "heavy",
    assault: "assault",
    pistol: "pistol",
    torrent: "torrent",
    blast: "blast",
    melta: "melta",
    anti: "anti",
    "ignores cover": "ignores-cover",
    precision: "precision",
    hazardous: "hazardous",
    "indirect fire": "indirect-fire",
    "extra attacks": "extra-attacks",
    psychic: "psychic",
    "one shot": "one-shot",
    lance: "lance",
    cleave: "cleave",
    "close-quarters": "close-quarters",
    overcharge: "overcharge",
    conversion: "conversion",
    "linked fire": "linked-fire",
    "plasma warhead": "plasma-warhead",
    "psychic assassin": "psychic-assassin",
    "reverberating summons": "reverberating-summons",
    bubblechukka: "bubblechukka",
    "dead choppy": "dead-choppy",
    harpooned: "harpooned",
    hooked: "hooked",
    impaled: "impaled",
    snagged: "snagged",
    sustained: "sustained-hits",
  };
  const id = flat[lower];
  if (
    !id ||
    ["anti", "melta", "cleave", "rapid-fire", "sustained-hits"].includes(id)
  )
    return null;
  return [{ keyword_id: id }];
}

function parseStatValue(value: string | null | undefined): number | string {
  const normalized = (value ?? "").trim();
  if (/^\d+$/.test(normalized)) return Number(normalized);
  const dice = normalized.match(/^(\d*)[dD](\d+)(\+\d+)?$/);
  if (dice) return `${dice[1]}D${dice[2]}${dice[3] ?? ""}`;
  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) return numeric;
  throw new Error(`unparseable stat-value "${value}"`);
}

export function parseSkill(value: string | null | undefined): number | null {
  const match = (value ?? "").trim().match(/^(\d)\+?$/);
  if (!match) return null;
  const numeric = Number(match[1]);
  return numeric >= 2 && numeric <= 6 ? numeric : null;
}

function parseArmourPenetration(value: string | null | undefined): number {
  const numeric = Number.parseInt((value ?? "0").trim(), 10);
  return Number.isFinite(numeric) ? numeric : 0;
}

function parseRange(
  value: string | null | undefined,
  type: string,
): number | "Melee" {
  if (type === "melee") return "Melee";
  const normalized = (value ?? "").trim();
  if (/melee/i.test(normalized)) return "Melee";
  const numeric = Number.parseInt(normalized.replace(/["”]/g, ""), 10);
  if (!Number.isFinite(numeric))
    throw new Error(`unparseable range "${value}"`);
  return numeric;
}

/** Build a repo weapon record from one dump wargear item and its profiles. */
export function mintWeapon(
  ctx: MintContext,
  item: WargearItemRow,
  id: string,
  name: string,
): WeaponRecord {
  const { dump } = ctx;
  const profiles = (
    dump.groupBy("wargear_item_profile", "wargearItemId").get(item.id!) ?? []
  )
    .slice()
    .sort((left, right) => left.displayOrder - right.displayOrder);
  if (profiles.length === 0)
    throw new Error(`weapon "${name}" has no profile rows in the dump`);

  const abilitiesByProfile = dump.groupBy(
    "wargear_item_profile_wargear_ability",
    "wargearItemProfileId",
  );
  const abilitiesById = dump.byId("wargear_ability");
  const built: WeaponProfile[] = profiles.map((profile) => {
    const ranged = profile.type !== "melee";
    const stats: WeaponProfile["stats"] = {
      A: parseStatValue(profile.attacks),
      S: parseStatValue(profile.strength),
      AP: parseArmourPenetration(profile.armourPenetration),
      D: parseStatValue(profile.damage),
    };
    if (ranged) stats.BS = parseSkill(profile.ballisticSkill);
    else stats.WS = parseSkill(profile.weaponSkill);

    const keywords: NonNullable<WeaponProfile["keywords"]> = [];
    for (const link of abilitiesByProfile.get(profile.id) ?? []) {
      const abilityName = dump.enName(abilitiesById.get(link.wargearAbilityId));
      if (!abilityName) continue;
      const mapped = mapWeaponKeyword(abilityName);
      if (!mapped) {
        ctx.warnings.push(
          `weapon "${name}": unmapped keyword "${abilityName}" (skipped)`,
        );
        continue;
      }
      keywords.push(...mapped);
    }

    const profileName =
      profiles.length > 1
        ? (dump.enName(profile) ?? profile.localisations?.en?.name ?? name)
        : name;
    return {
      name: profileName,
      range: parseRange(profile.range, profile.type),
      stats,
      ...(keywords.length > 0 ? { keywords } : {}),
    };
  });

  return {
    id,
    external_refs: [{ namespace: "mfm", id: item.id! }],
    name,
    type: profiles[0].type === "melee" ? "melee" : "ranged",
    profiles: built,
    game_version: ctx.gv,
  };
}

/** Build a repo record for selectable non-weapon equipment. */
export function mintWargear(
  ctx: MintContext,
  item: WargearItemRow,
  id: string,
  name: string,
): WargearRecord {
  return {
    id,
    external_refs: [{ namespace: "mfm", id: item.id! }],
    name,
    game_version: ctx.gv,
  };
}
