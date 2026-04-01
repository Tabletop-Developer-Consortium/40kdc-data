/**
 * Weapon profile merging and cross-unit deduplication.
 *
 * Source data splits multi-profile weapons into separate rows using an
 * en-dash delimiter: "Plasma pistol – Standard" / "Plasma pistol – Supercharge".
 * These become a single weapon entity with a profiles array.
 *
 * Cross-unit dedup: weapons with identical (name, type, all profile stats)
 * across different units are the same entity, referenced by a shared ID.
 */

import { nameToId } from "./id-generator.js";
import {
  parseRange,
  parseBSWS,
  parseStatValue,
  parseAP,
  parseWeaponKeywords,
} from "./stat-parser.js";

export interface SourceWargear {
  datasheet_id: string;
  line: string;
  line_in_wargear: string;
  dice: string;
  name: string;
  description: string;
  range: string;
  type: string;
  A: string;
  BS_WS: string;
  S: string;
  AP: string;
  D: string;
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
  keywords: string[];
}

export interface WeaponEntity {
  id: string;
  name: string;
  type: "ranged" | "melee";
  profiles: WeaponProfile[];
  game_version: { edition: string; dataslate: string };
}

// EN-DASH (U+2013) and regular hyphen used as profile separators
const PROFILE_SEPARATOR = /\s*[\u2013\u2014-]\s+/;

/** Split "Plasma pistol – Standard" into { baseName: "Plasma pistol", profileName: "Standard" } */
function splitProfileName(fullName: string): {
  baseName: string;
  profileName: string;
} {
  const parts = fullName.split(PROFILE_SEPARATOR);
  if (parts.length >= 2) {
    return {
      baseName: parts[0].trim(),
      profileName: parts.slice(1).join(" – ").trim(),
    };
  }
  return { baseName: fullName.trim(), profileName: fullName.trim() };
}

/** Build a single weapon profile from a source wargear row. */
function buildProfile(row: SourceWargear, profileName: string): WeaponProfile {
  const range = parseRange(row.range);
  const isMelee = row.type === "Melee" || range === "Melee";

  const stats: WeaponProfile["stats"] = {
    A: parseStatValue(row.A),
    S: parseStatValue(row.S),
    AP: parseAP(row.AP),
    D: parseStatValue(row.D),
  };

  if (isMelee) {
    stats.WS = parseBSWS(row.BS_WS);
  } else {
    stats.BS = parseBSWS(row.BS_WS);
  }

  return {
    name: profileName,
    range,
    stats,
    keywords: parseWeaponKeywords(row.description),
  };
}

/** Hash a weapon entity for cross-unit deduplication. */
function weaponHash(name: string, type: string, profiles: WeaponProfile[]): string {
  const profileParts = profiles
    .map(
      (p) =>
        `${p.name}|${p.range}|${JSON.stringify(p.stats)}|${p.keywords.sort().join(",")}`
    )
    .sort();
  return `${name.toLowerCase()}|${type}|${profileParts.join(";")}`;
}

/**
 * Merge wargear rows for a single unit into weapon entities,
 * then deduplicate across all units.
 */
export function buildWeaponRegistry(
  allUnitWargear: Map<string, SourceWargear[]>,
  gameVersion: { edition: string; dataslate: string }
): {
  weapons: WeaponEntity[];
  /** Maps (datasheetId) → Set of weapon entity IDs for that unit */
  unitWeaponIds: Map<string, Set<string>>;
} {
  // Global dedup registry: hash → WeaponEntity
  const registry = new Map<string, WeaponEntity>();
  const unitWeaponIds = new Map<string, Set<string>>();

  for (const [datasheetId, rows] of allUnitWargear) {
    const weaponIds = new Set<string>();
    unitWeaponIds.set(datasheetId, weaponIds);

    // Group rows by base weapon name for profile merging
    const groups = new Map<string, { baseName: string; rows: SourceWargear[]; profileNames: string[] }>();

    for (const row of rows) {
      const { baseName, profileName } = splitProfileName(row.name);
      const key = baseName.toLowerCase();
      if (!groups.has(key)) {
        groups.set(key, { baseName, rows: [], profileNames: [] });
      }
      const group = groups.get(key)!;
      group.rows.push(row);
      group.profileNames.push(profileName);
    }

    for (const [, group] of groups) {
      const { baseName, rows: groupRows, profileNames } = group;
      const type = groupRows[0].type === "Melee" ? "melee" : "ranged";

      // If there's only one profile and its name matches the base name, use base name as profile name
      const profiles = groupRows.map((row, i) => {
        const pName =
          groupRows.length === 1 ? baseName : profileNames[i];
        return buildProfile(row, pName);
      });

      const hash = weaponHash(baseName, type, profiles);

      if (!registry.has(hash)) {
        const id = nameToId(baseName);
        registry.set(hash, {
          id,
          name: baseName,
          type: type as "ranged" | "melee",
          profiles,
          game_version: gameVersion,
        });
      }

      weaponIds.add(registry.get(hash)!.id);
    }
  }

  return {
    weapons: [...registry.values()],
    unitWeaponIds,
  };
}
