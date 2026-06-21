/**
 * The shape of the embedded data bundle: one named array per entity collection.
 *
 * `RawData` is the boundary between the generated JSON-Schema types and the
 * linked view layer. The codegen ({@link file://../codegen-data.ts}) emits a
 * `RAW_DATA: RawData` constant; {@link Dataset} wraps it with linked accessors.
 *
 * @packageDocumentation
 */
import type {
  AbilityDSLEntry,
  AlliedRule,
  DeploymentPattern,
  Detachment,
  Enhancement,
  Faction,
  ForceDisposition,
  GameVersion,
  HullShape,
  InteractionFlag,
  LeaderAttachment,
  Mission,
  MissionMatchup,
  PhaseMapping,
  ResourcePool,
  SecondaryCard,
  Stratagem,
  TerrainLayout,
  TargetProfile,
  TerrainTemplate,
  Unit,
  UnitComposition,
  Wargear,
  WargearOption,
  Weapon,
  WeaponKeyword,
  UnitKeyword,
} from "../generated.js";

/**
 * Every entity collection in the dataset, keyed by camelCase collection name.
 *
 * Collections with no authored data yet (e.g. `interactionFlags`) are present
 * as empty arrays so the API surface is stable and new data flows through
 * automatically once authored.
 */
export interface RawData {
  units: Unit[];
  /** Named target archetypes referencing real units (faction_id + unit_id). */
  targetProfiles: TargetProfile[];
  weapons: Weapon[];
  /** Catalog of weapon keywords (Lethal Hits, Sustained Hits N, Anti-X N+, ...). */
  weaponKeywords: WeaponKeyword[];
  /** Catalog of universal unit abilities (Deep Strike, Scouts X", Feel No Pain X+, ...). */
  unitKeywords: UnitKeyword[];
  factions: Faction[];
  /** Community-authored ability mechanics (key is `ability_id`, not `id`). */
  abilities: AbilityDSLEntry[];
  /** Phase assignments, joined to abilities/stratagems/etc. via `source_id`. */
  phaseMappings: PhaseMapping[];
  detachments: Detachment[];
  /** Allied-detachment / 'soup' rules: how units lacking the army faction keyword may be included. */
  alliedRules: AlliedRule[];
  stratagems: Stratagem[];
  enhancements: Enhancement[];
  leaderAttachments: LeaderAttachment[];
  unitCompositions: UnitComposition[];
  wargearOptions: WargearOption[];
  /** Non-weapon wargear items (icons, attachments) referenced by wargear options. */
  wargear: Wargear[];
  gameVersions: GameVersion[];
  missions: Mission[];
  missionMatchups: MissionMatchup[];
  missionCards: SecondaryCard[];
  deploymentPatterns: DeploymentPattern[];
  forceDispositions: ForceDisposition[];
  /** Reusable terrain catalog: standard areas and scenery features. */
  terrainTemplates: TerrainTemplate[];
  /** Terrain layouts: arrangements of catalog/inline pieces on the board. */
  terrainLayouts: TerrainLayout[];
  /** Reusable model collision hulls (polygon footprints) referenced by id. */
  hullShapes: HullShape[];
  resourcePools: ResourcePool[];
  interactionFlags: InteractionFlag[];
}

/** A `RawData` with every collection initialised to an empty array. */
export function emptyRawData(): RawData {
  return {
    units: [],
    targetProfiles: [],
    weapons: [],
    weaponKeywords: [],
    unitKeywords: [],
    factions: [],
    abilities: [],
    phaseMappings: [],
    detachments: [],
    alliedRules: [],
    stratagems: [],
    enhancements: [],
    leaderAttachments: [],
    unitCompositions: [],
    wargearOptions: [],
    wargear: [],
    gameVersions: [],
    missions: [],
    missionMatchups: [],
    missionCards: [],
    deploymentPatterns: [],
    forceDispositions: [],
    terrainTemplates: [],
    terrainLayouts: [],
    hullShapes: [],
    resourcePools: [],
    interactionFlags: [],
  };
}
