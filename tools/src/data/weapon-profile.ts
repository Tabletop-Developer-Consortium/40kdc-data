/**
 * Per-profile melee/ranged classification.
 *
 * 11e weapons can carry both ranged and melee profiles under a single weapon
 * record (e.g. the Avatar of Khaine's The Wailing Doom: one ranged profile plus
 * two melee profiles). Melee-vs-ranged is therefore a property of the
 * individual *profile*, not of the weapon — the weapon-level `type` field is a
 * coarse default only. A melee profile carries the literal `range: "Melee"`
 * (and a WS rather than a BS); every other profile is ranged.
 *
 * Consumers — the cruncher engine (cover/hit-stat selection), the salvo matrix,
 * and downstream UIs (shooting-vs-fight bucketing) — MUST classify per profile
 * via {@link isMeleeProfile} so a dual-profile weapon contributes its ranged
 * profiles to shooting and its melee profiles to the fight phase.
 *
 * @packageDocumentation
 */
import type { Unit, Weapon } from "../generated.js";

/** One stat profile of a unit. */
export type UnitProfile = Unit["profiles"][number];

/** One stat profile of a weapon. */
export type WeaponProfile = Weapon["profiles"][number];

/**
 * Whether a weapon profile is a melee profile (`range === "Melee"`).
 *
 * @example
 * isMeleeProfile({ range: "Melee", ... }); // true
 * isMeleeProfile({ range: 24, ... });      // false
 */
export function isMeleeProfile(profile: Pick<WeaponProfile, "range">): boolean {
  return profile.range === "Melee";
}
