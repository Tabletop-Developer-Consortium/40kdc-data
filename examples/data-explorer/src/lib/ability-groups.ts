import type { AbilityView } from "@alpaca-software/40kdc-data";

/**
 * Datasheet reading order for abilities, bucketed by `ability_type`. Shared by
 * the datacard (one unit) and the roundtrip collation (a whole faction) so both
 * surfaces group and order abilities identically.
 */
export const ABILITY_GROUPS: { label: string; types: string[] }[] = [
  { label: "Core", types: ["core"] },
  { label: "Faction", types: ["faction"] },
  { label: "Datasheet", types: ["unit"] },
  { label: "Other", types: ["detachment", "enhancement", "stratagem"] },
];

export interface AbilityGroup {
  label: string;
  abilities: AbilityView[];
}

/** Bucket abilities into the datasheet groups, dropping empty groups. An ability
 *  with no `ability_type` is treated as a datasheet ("unit") ability. */
export function groupAbilities(abilities: AbilityView[]): AbilityGroup[] {
  return ABILITY_GROUPS.map((g) => ({
    label: g.label,
    abilities: abilities.filter((a) => {
      const t = a.raw.ability_type ?? "unit";
      return g.types.includes(t);
    }),
  })).filter((g) => g.abilities.length > 0);
}
