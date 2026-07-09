/**
 * The linked, typed 40kdc dataset.
 *
 * The default {@link dataset} is built once from the data embedded in this
 * package; the top-level collections below are its accessors, re-exported for
 * the ergonomic one-liner form.
 *
 * @packageDocumentation
 *
 * @example
 * import { units } from "@alpaca-software/40kdc-data";
 *
 * units.find("Kharn")!.abilities
 *   .filter(a => a.phases.includes("shooting"))
 *   .map(a => a.id); // ["berzerker-frenzy"]
 *
 * @example
 * import { factions } from "@alpaca-software/40kdc-data";
 *
 * factions.find("World Eaters")!.units.length;
 */
export { Dataset } from "./dataset.js";
export type { StackableBuff, StackableBuffGroup, ReactiveTrigger } from "./dataset.js";
export { Collection } from "./collection.js";
export type { CollectionConfig } from "./collection.js";
export {
  UnitView,
  AbilityView,
  WeaponView,
  WeaponKeywordView,
  FactionView,
} from "./entities.js";
export { normalizeName, stripLeadingThe } from "./normalize.js";
export { isMeleeProfile } from "./weapon-profile.js";
export type { WeaponProfile } from "./weapon-profile.js";
export { emptyRawData } from "./types.js";
export type { RawData } from "./types.js";

// Wargear-loadout maths: base/maximal loadout, per-weapon bounds, validation.
export {
  optionCap,
  baseLoadout,
  maximalLoadout,
  weaponBounds,
  clampWeaponCount,
  validateLoadout,
  groupLoadout,
} from "./loadout.js";
export type {
  Loadout,
  WeaponBound,
  Violation,
  LoadoutModel,
  LoadoutGroup,
  LoadoutGroupWeapon,
} from "./loadout.js";

// Unit point-cost maths: ordinal-aware tier selection over `points` bands.
export { baseUnitPoints, pointsTierMissing, wargearPoints } from "./pricing.js";

// The cruncher surface — buff types + the engine — re-exported from the data
// package so downstream callers can import their whole 40kdc API from
// `@alpaca-software/40kdc-data` without reaching into subpaths.
export * from "../cruncher/index.js";

// The DSL→Buff translator that powers AbilityView.getBuffs / describeBuffs.
export { effectToBuffs, parseKeywordGrant } from "../cruncher/from-dsl.js";
export type {
  ActivatableBuff,
  ActivatableGroupRef,
  EffectTranslation,
  TranslationPerspective,
  UnsupportedFragment,
} from "../cruncher/from-dsl.js";

// The eligible-abilities resolver (also reachable as Dataset.eligibleAbilities).
export * from "../abilities-resolver/index.js";

// Compact, URL-safe list sharing (registry-indexed `share-v1` tokens).
export {
  encodeShareToken,
  decodeShareToken,
  rosterToShareList,
  shareRegistryVersion,
  ShareRegistryIndex,
  SHARE_FORMAT_VERSION,
  SHARE_KINDS,
} from "../share/index.js";
export type {
  DecodeResult,
  ShareBattleSize,
  ShareList,
  ShareLoadoutEntry,
  ShareUnit,
  ShareKind,
  ShareRegistry,
} from "../share/index.js";

// Bridge helpers from the importer's RosterUnit → linked views.
export {
  resolveRosterUnit,
  resolveRosterWargear,
  resolveAttachedLeader,
  resolveAttachmentPartners,
  primaryDetachment,
  primaryDetachmentId,
  checkRosterLegality,
  checkRoster,
  validateRosterCore,
} from "./roster-resolve.js";
export type {
  UnitLegality,
  RosterLegality,
  RosterViolation,
  RosterViolationCode,
  NormRoster,
} from "./roster-resolve.js";
export { pointsLimitForBattleSize, detachmentCapForBattleSize } from "./battle-sizes.js";
export { candidateAffordability } from "./affordability.js";
export type { AffordabilitySpec, AffordabilityUnit, CandidateCost } from "./affordability.js";

import { Dataset } from "./dataset.js";

/** The dataset built from this package's embedded data. */
export const dataset = Dataset.embedded();

/** All units, linked to their faction, weapons, and abilities. */
export const units = dataset.units;
/** Named target archetypes referencing real units (faction_id + unit_id). */
export const targetProfiles = dataset.targetProfiles;
/** All weapons, linked to the units that carry them. */
export const weapons = dataset.weapons;
/** Catalog of weapon keywords (Lethal Hits, Sustained Hits N, Anti-X N+, ...). */
export const weaponKeywords = dataset.weaponKeywords;
/** Catalog of universal unit abilities (Deep Strike, Scouts X", Feel No Pain X+, ...). */
export const unitKeywords = dataset.unitKeywords;
/** All factions, linked to their units, abilities, and weapons. */
export const factions = dataset.factions;
/** All abilities, linked to their phases and the units that have them. */
export const abilities = dataset.abilities;
/** All detachments. */
export const detachments = dataset.detachments;
/** All allied-detachment / 'soup' rules. */
export const alliedRules = dataset.alliedRules;
/** All enhancements. */
export const enhancements = dataset.enhancements;
/** All stratagems. */
export const stratagems = dataset.stratagems;
/** All wargear options. */
export const wargearOptions = dataset.wargearOptions;
/** All non-weapon wargear items (icons, attachments). */
export const wargear = dataset.wargear;
/** All missions. */
export const missions = dataset.missions;
/** All mission matchups. */
export const missionMatchups = dataset.missionMatchups;
/** All secondary mission cards. */
export const missionCards = dataset.missionCards;
/** All deployment patterns. */
export const deploymentPatterns = dataset.deploymentPatterns;
/** All force dispositions. */
export const forceDispositions = dataset.forceDispositions;
/** Reusable terrain catalog: standard areas and scenery features. */
export const terrainTemplates = dataset.terrainTemplates;
/** All terrain layouts. */
export const terrainLayouts = dataset.terrainLayouts;
/** Reusable model collision hulls (polygon footprints) referenced by id. */
export const hullShapes = dataset.hullShapes;
/** All resource pools. */
export const resourcePools = dataset.resourcePools;
