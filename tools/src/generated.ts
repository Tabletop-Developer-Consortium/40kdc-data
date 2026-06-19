/* Generated from crates/wh40kdc/schemas/bundled.schema.json by 'npm run codegen:types'. DO NOT EDIT BY HAND. */

/**
 * Kebab-case identifier
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "entity-id".
 */
export type EntityId = string;
/**
 * Game edition, e.g. '10th' or '11'
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "edition".
 */
export type Edition = string;
/**
 * Dataslate version: a quarterly tag (e.g. '2025-q3') or a named kebab-case slug for non-quarterly slates (e.g. 'pre-launch-provisional')
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "dataslate-version".
 */
export type DataslateVersion = string;
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "keyword".
 */
export type Keyword = string;
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "keyword-list".
 */
export type KeywordList = Keyword[];
/**
 * A stat that can be a fixed number or a dice expression
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "stat-value".
 */
export type StatValue = number | string;
/**
 * GitHub handle or '40kdc-community'
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "contributor-ref".
 */
export type ContributorRef = string;
/**
 * The five official game phases. Unchanged between 10th and 11th edition — 11e reorders Pile In timing within the Fight phase but adds no top-level phase.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "phase".
 */
export type Phase = "command" | "movement" | "shooting" | "charge" | "fight";
/**
 * @minItems 1
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "phase-list".
 */
export type PhaseList = [Phase, ...Phase[]];
/**
 * Type of game element that is the source of an enrichment entry
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "source-type".
 */
export type SourceType = "ability" | "stratagem" | "enhancement" | "detachment-rule" | "faction-rule";
/**
 * Which player's turn this applies during
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "player-turn".
 */
export type PlayerTurn = "your-turn" | "opponent-turn" | "either";
/**
 * 11e battle size, which sets the army's points limit and detachment-point budget: 'incursion' = 1000 pts / 2 detachment points; 'strike-force' = 2000 pts / 3 detachment points.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "battle-size".
 */
export type BattleSize = "incursion" | "strike-force";
/**
 * One of the five confirmed 11e launch Force Dispositions. Shared by force-disposition entities and the mission-matchup matrix.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "force-disposition-id".
 */
export type ForceDispositionId =
  | "take-and-hold"
  | "disruption"
  | "purge-the-foe"
  | "priority-assets"
  | "reconnaissance";
/**
 * A terrain piece's 2D footprint in local inches (y-down): an axis-aligned rectangle with its min corner at the local origin, a right triangle with the right angle at the local origin and legs along +x/+y, or an explicit polygon (>= 3 points). The placement resolver re-centers the footprint on its polygon area centroid, so the local-origin convention does not affect where the piece lands — only its shape matters.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "footprint".
 */
export type Footprint =
  | {
      type: "rectangle";
      width: number;
      height: number;
    }
  | {
      type: "right-triangle";
      width: number;
      height: number;
    }
  | {
      type: "polygon";
      /**
       * @minItems 3
       */
      points: [Vec2, Vec2, Vec2, ...Vec2[]];
    };
/**
 * An 11e terrain-area keyword. Confirmed launch set; extend as further keywords publish on dataslate.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "terrain-area-keyword".
 */
export type TerrainAreaKeyword = "obscuring" | "hidden" | "plunging-fire";
/**
 * Army gate: every model in the army must carry at least one of these keywords for the rule to apply (e.g. ['Chaos Knights', 'Heretic Astartes'] for Daemonic Pact). Empty = no army-level gate (the rule is then gated only by `detachment_id`, whose detachment is itself faction-locked).
 */
export type KeywordList1 = Keyword[];
/**
 * A unit qualifies for this pool when it carries any of these keywords (e.g. ['Legiones Daemonica'], ['Damned'], ['Vanguard Invader']). Empty = the whole `source_faction_id` is the pool.
 */
export type KeywordList2 = Keyword[];
/**
 * Additional filter: a unit must carry ALL of these to be included via this rule (e.g. the matching god ['Khorne'] for a per-god Daemon pool).
 */
export type KeywordList3 = Keyword[];
/**
 * A unit carrying ANY of these cannot be included via this rule (e.g. Brood Brothers bans 'Aircraft', 'Epic Hero', 'Ogryn', ...).
 */
export type KeywordList4 = Keyword[];
/**
 * Per-keyword Battleline ratio constraint: for each keyword listed, the number of non-BATTLELINE units with that keyword included via this rule cannot exceed the number of BATTLELINE units with that keyword included via this rule (e.g. Daemonic Pact's per-god ['Khorne','Tzeentch','Nurgle','Slaanesh']).
 */
export type KeywordList5 = Keyword[];
/**
 * A zone footprint, expressed as an axis-aligned rectangle or an explicit polygon. Vertices/extent are relative to the owning element's position.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "zone-shape".
 */
export type ZoneShape =
  | {
      type: "rectangle";
      width: number;
      height: number;
    }
  | {
      type: "polygon";
      /**
       * @minItems 3
       */
      points: [Vec2, Vec2, Vec2, ...Vec2[]];
    };
/**
 * Which player a zone or territory belongs to.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "side".
 */
export type Side = "attacker" | "defender";
/**
 * Eligibility predicate for which units may perform the action.
 */
export type AbilityCondition = SimpleCondition | CompoundCondition;
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "condition-node".
 */
export type ConditionNode = SimpleCondition | CompoundCondition;
/**
 * Predicate for when the action is considered complete.
 */
export type AbilityCondition1 = SimpleCondition | CompoundCondition;
/**
 * Effect applied when the action completes (e.g. terrain-area-tag, objective-tag, or unit-tag to mark transient state).
 */
export type AbilityEffect =
  | SingleEffect
  | ChoiceEffect
  | SequenceEffect
  | DiceGatedEffect
  | ConditionalEffect
  | DicePoolAllocationEffect
  | SelectUnitsEffect;
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "effect-node".
 */
export type EffectNode =
  | SingleEffect
  | ChoiceEffect
  | SequenceEffect
  | DiceGatedEffect
  | ConditionalEffect
  | DicePoolAllocationEffect
  | SelectUnitsEffect;
export type AbilityCondition2 = SimpleCondition | CompoundCondition;
/**
 * Predicate that BLOCKS starting the action while it holds (Sensor Sweep: a unit cannot start this action if there is only one operation marker on the battlefield).
 */
export type AbilityCondition3 = SimpleCondition | CompoundCondition;
/**
 * AND set: the target must carry every keyword listed here.
 */
export type KeywordList6 = Keyword[];
/**
 * OR set: the target must carry at least one keyword listed here. Use for rules that target a unit with one of several keywords (e.g. Crushing Impact's MONSTER/VEHICLE, Explosives' EXPLOSIVES/GRENADES). Mirrors the `army_keywords_any` OR-gate on allied-rule.schema.json.
 */
export type KeywordList7 = Keyword[];
export type AbilityEffect1 =
  | SingleEffect
  | ChoiceEffect
  | SequenceEffect
  | DiceGatedEffect
  | ConditionalEffect
  | DicePoolAllocationEffect
  | SelectUnitsEffect;
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "condition".
 */
export type AbilityCondition4 = SimpleCondition | CompoundCondition;
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "effect".
 */
export type AbilityEffect2 =
  | SingleEffect
  | ChoiceEffect
  | SequenceEffect
  | DiceGatedEffect
  | ConditionalEffect
  | DicePoolAllocationEffect
  | SelectUnitsEffect;

/**
 * Auto-generated by tools/src/bundle-schemas.ts. Single self-contained schema for Rust codegen — do not edit by hand.
 */
export interface KdcBundledSchemas {
  [k: string]: unknown;
}
/**
 * A 2D point in board inches. Origin at a board corner; JSON uses y-down (downstream renderers may flip to y-up).
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "vec2".
 */
export interface Vec2 {
  x: number;
  y: number;
}
/**
 * A model's base. 'round' carries 'diameter'; 'oval' carries 'width'+'length'. 'flying-base' (with 'size': small/large), 'hull', and 'unique' are categories the GW base-size guide gives without standard millimetre dimensions; entries carrying such a category, or any millimetre value not taken from an authoritative source, set 'draft': true to mark them for later hand-authoring.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "base-size".
 */
export interface BaseSize {
  shape: "round" | "oval" | "flying-base" | "hull" | "unique";
  diameter?: number;
  width?: number;
  length?: number;
  /**
   * Flying-base size class, when 'shape' is 'flying-base'.
   */
  size?: "small" | "large";
  /**
   * True when the entry is provisional/guessed (e.g. a category without authoritative dimensions) and should be revisited.
   */
  draft?: boolean;
}
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "game-version-ref".
 */
export interface GameVersionReference {
  edition: Edition;
  dataslate: DataslateVersion;
  [k: string]: unknown;
}
/**
 * The combined points cap for units included via an allied rule at one battle size.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "allied-points-limit".
 */
export interface AlliedPointsLimit {
  /**
   * Battle size this cap applies at. Includes 'onslaught' (3000 pts), which ally rules reference even though the core roster battle-size enum lists only incursion/strike-force.
   */
  battle_size: "incursion" | "strike-force" | "onslaught";
  /**
   * Maximum combined points of units included via the rule at this battle size.
   */
  max_points: number;
}
/**
 * A community-authored model of an allied-detachment / 'soup' rule: the named exception by which units lacking the army's chosen Faction keyword may still be included (e.g. Daemonic Pact, Brood Brothers, Iconoclast Fiefdom's Damned access). One rule = one allied source pool; a faction that allies in several pools (the Chaos cult pattern: a Chaos Knights pool plus a matching-god Daemons pool) carries one rule per pool. The rule is gated by two optional, AND-combined conditions: an army-wide keyword condition (`army_keywords_any`) and/or a selected detachment (`detachment_id`).
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "allied-rule".
 */
export interface AlliedRule {
  id: EntityId;
  name: string;
  /**
   * Short panel/category heading a list builder groups this pool under (e.g. 'Daemons', 'Imperial Agents', 'Titanic Allies'). Defaults to `name` when omitted.
   */
  label?: string;
  army_keywords_any?: KeywordList1;
  /**
   * Detachment gate: this exact detachment must be selected for the rule to apply (e.g. 'iconoclast-fiefdom'). null = no detachment-level gate. Independent of the detachment's combat rule (`detachment_rule_id`).
   */
  detachment_id?: EntityId | null;
  /**
   * Faction the ally pool is drawn from, when scoping by faction is needed to disambiguate units whose id is shared across factions. Optional hint; `source_keywords` is the primary filter.
   */
  source_faction_id?: EntityId | null;
  source_keywords?: KeywordList2;
  required_keywords?: KeywordList3;
  excluded_keywords?: KeywordList4;
  /**
   * Optional battlefield-role filter (matched against a unit's `role`). Empty = no role restriction.
   */
  roles?: string[];
  /**
   * Absolute points cap on the combined cost of units included via this rule, per battle size. Empty = no points cap. A rule lists at most one entry per battle size.
   */
  points_limits?: AlliedPointsLimit[];
  /**
   * Optional cap on the number of units included via this rule, independent of points. null = no unit-count cap.
   */
  max_units?: number | null;
  /**
   * True when units included via this rule cannot be the army's Warlord (e.g. Daemonic Pact, Star Children's Blessings).
   */
  cannot_be_warlord?: boolean;
  /**
   * True when units included via this rule cannot be given Enhancements (e.g. Daemonic Pact).
   */
  cannot_take_enhancements?: boolean;
  /**
   * Host-Warlord requirement: a model carrying this keyword must be the army's Warlord (e.g. Brood Brothers requires a 'Genestealer Cults' Warlord). null = no such requirement.
   */
  warlord_required_keyword?: Keyword | null;
  /**
   * Abilities that included units lose under this rule (e.g. Astra Militarum units lose 'voice-of-command' under Brood Brothers). A display/effect hint, not a construction constraint.
   */
  removes_ability_ids?: EntityId[];
  battleline_ratio_keywords?: KeywordList5;
  game_version: GameVersionReference;
  notes?: string;
}
/**
 * A deployment map: per-side deployment zones, objective positions, and (11e) per-side territory polygons. Pattern geometry carries forward unchanged from 10th edition; downstream tooling (e.g. bevy-deploy-helper) consumes this as the canonical encoding.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "deployment-pattern".
 */
export interface DeploymentPattern {
  id: EntityId;
  name: string;
  /**
   * Mission pack or source the pattern originates from (e.g. 'leviathan').
   */
  source?: string;
  description?: string;
  /**
   * Per-side deployment zones.
   *
   * @minItems 1
   */
  zones: [
    {
      player: Side;
      name?: string;
      shape: ZoneShape;
      position: Vec2;
      /**
       * Hex render color for the zone overlay.
       */
      color?: string;
    },
    ...{
      player: Side;
      name?: string;
      shape: ZoneShape;
      position: Vec2;
      /**
       * Hex render color for the zone overlay.
       */
      color?: string;
    }[]
  ];
  /**
   * 11e per-side territory polygons, mirroring the deployment-zone shape (e.g. the band between a deployment zone and the midline). Empty until authored.
   */
  territories?: {
    player: Side;
    shape: ZoneShape;
    position: Vec2;
  }[];
  /**
   * Objective-marker positions on the board.
   */
  objectives?: Vec2[];
  /**
   * Ids of recommended terrain-layout entities (resolved once terrain-layout data is authored).
   */
  recommended_terrain_layout_ids?: EntityId[];
  game_version: GameVersionReference;
}
/**
 * A construction keyword a detachment grants to units matching a keyword filter. Blanket by default (every matching unit gains it); when `max_selected` is set, the keyword is instead granted to up to that many matching units of the player's choice (e.g. Houndpack Lance: 'select three WAR DOG units; they gain CHARACTER').
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "granted-keyword".
 */
export interface GrantedKeyword {
  keyword: Keyword;
  to_keywords: KeywordList;
  /**
   * When present, the grant is not blanket: the player selects up to this many matching units to receive `keyword` (e.g. 3 WAR DOG units gain CHARACTER under Houndpack Lance). Absent = every matching unit gains it.
   */
  max_selected?: number;
}
/**
 * A minimum number of units carrying a keyword that the detachment requires.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "unit-minimum".
 */
export interface UnitMinimum {
  keyword: Keyword;
  min: number;
}
/**
 * A detachment option within a faction, providing a detachment rule, enhancements, and stratagems.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "detachment".
 */
export interface Detachment {
  id: EntityId;
  name: string;
  faction_id: EntityId;
  /**
   * Deprecated single-rule link, kept for back-compat (and referenced by allied-rule). A detachment may have more than one rule ability — prefer `detachment_rule_ids`.
   */
  detachment_rule_id?: EntityId | null;
  /**
   * ability_ids of every detachment-rule ability this detachment provides (a detachment rule may have multiple named parts). These match the enrichment `abilities.json` / raw-text-store ids, so the downstream lookup `store[ability_id]` resolves. Empty/absent until linked by author:reconcile.
   */
  detachment_rule_ids?: EntityId[];
  /**
   * 11e: the detachment-point cost (1–3) charged against the army's detachment-point budget. null when not yet assigned.
   */
  detachment_points?: number | null;
  /**
   * 11e: ids of the Force Disposition entities this detachment grants. Empty until assigned.
   */
  force_dispositions?: EntityId[];
  /**
   * 11e: detachment-type tags (e.g. 'dynasty', 'kabal'). A roster may include at most one detachment per shared tag — the 'you can only take one of X type of detachment' rule. Empty when the detachment carries no UNIQUE tag.
   */
  tags?: string[];
  enhancement_ids?: EntityId[];
  stratagem_ids?: EntityId[];
  restrictions?: {
    required_keywords?: KeywordList;
    excluded_keywords?: KeywordList;
    notes?: string;
  } | null;
  /**
   * Construction keywords this detachment grants to matching units while it is selected (e.g. Houndpack Lance grants 'Battleline' to 'War Dog' units). A unit carrying any keyword in a grant's `to_keywords` gains that grant's `keyword` for army-construction purposes (datasheet-count caps, battlefield role). Empty/absent when the detachment grants no construction keywords. Distinct from combat keywords, which live in the ability DSL.
   */
  granted_keywords?: GrantedKeyword[];
  /**
   * Minimum unit counts the detachment requires while selected (e.g. Houndpack Lance: 'your army must include three or more WAR DOG units'). Each entry requires at least `min` units carrying `keyword`. Empty/absent when the detachment imposes no minimum.
   */
  unit_minimums?: UnitMinimum[];
  game_version: GameVersionReference;
}
/**
 * A purchasable upgrade for a character unit, provided by a detachment.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "enhancement".
 */
export interface Enhancement {
  id: EntityId;
  name: string;
  detachment_id: EntityId;
  cost: number;
  /**
   * True when the cost is carried over provisionally (e.g. seeded from a prior edition during migration) and not yet confirmed against the current dataslate.
   */
  points_provisional?: boolean;
  /**
   * 11e: when true, this enhancement applies to up to `max_targets` non-character units while counting as a single Enhancement choice.
   */
  upgrade_tag?: boolean;
  /**
   * Number of units this enhancement may be applied to. Only meaningful when `upgrade_tag` is true; defaults to 1.
   */
  max_targets?: number;
  keyword_restrictions?: KeywordList;
  exclusion_keywords?: KeywordList | null;
  ability_id?: EntityId | null;
  is_unique?: boolean;
  game_version: GameVersionReference;
}
/**
 * A playable faction or sub-faction.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "faction".
 */
export interface Faction {
  id: EntityId;
  name: string;
  parent_faction_id?: EntityId | null;
  game_version: GameVersionReference;
  keywords?: KeywordList;
  aliases?: string[];
  /**
   * Reference to the faction-wide ability (e.g., Oath of Moment)
   */
  faction_rule_id?: EntityId | null;
  /**
   * URL to the faction's logo/emblem image.
   */
  logo_url?: string;
}
/**
 * A 11e strategic-intent tag granted by detachments. Players compare dispositions at game start to determine the shared mission; asymmetric primary objectives result.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "force-disposition".
 */
export interface ForceDisposition {
  /**
   * One of the five confirmed launch Force Dispositions.
   */
  id: "take-and-hold" | "disruption" | "purge-the-foe" | "priority-assets" | "reconnaissance";
  name: string;
  /**
   * Community-authored description of the disposition's effect (original prose only — no reproduced rules text).
   */
  text?: string;
  game_version: GameVersionReference;
}
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "game-version".
 */
export interface GameVersion {
  edition: Edition;
  dataslate: DataslateVersion;
  effective_date: string;
  label?: string;
  supersedes?: DataslateVersion | null;
}
/**
 * A model's 2D collision footprint as an explicit polygon, used in place of a circular/oval base for vehicles and other hull-based models. Points are authored in local inches (y-down); a consumer re-centers the polygon on its area centroid before placement, so the local origin does not affect where the model lands — only its shape matters (mirrors the terrain-template footprint convention). A hull shape is faction-agnostic and reusable: one outline (e.g. a Rhino chassis) is authored once and referenced by `hull_shape_id` from every model that shares that hull, across factions. This entity stores geometry only — never an image, image URL, or any source-asset metadata.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "hull-shape".
 */
export interface HullShape {
  id: EntityId;
  name: string;
  /**
   * Polygon vertices in local inches (y-down), in order around the outline. A hull is always a polygon (never a rectangle/right-triangle), so the points are given directly rather than via the shared `footprint` oneOf.
   *
   * @minItems 3
   */
  points: [Vec2, Vec2, Vec2, ...Vec2[]];
  /**
   * Cached axis-aligned bounding-box width in inches (max x − min x). Derived from `points`; recorded so consumers can size/scale without recomputing.
   */
  bounds_width_in: number;
  /**
   * Cached axis-aligned bounding-box height in inches (max y − min y). Derived from `points`.
   */
  bounds_height_in: number;
  game_version: GameVersionReference;
}
/**
 * Defines which character units can attach to which bodyguard units.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "leader-attachment".
 */
export interface LeaderAttachment {
  leader_id: EntityId;
  /**
   * @minItems 1
   */
  eligible_bodyguard_ids: [EntityId, ...EntityId[]];
  game_version: GameVersionReference;
}
/**
 * One cell of the 11e Force Disposition matrix: given the player's own Force Disposition and their opponent's, the mission that player plays. Mirrors a single row on a physical Force Disposition card. The (disposition, opponent_disposition) pair is the conceptual key; compound uniqueness across entries is a data convention, not enforced by this schema.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "mission-matchup".
 */
export interface MissionMatchup {
  id: EntityId;
  /**
   * The player's own Force Disposition.
   */
  disposition: "take-and-hold" | "disruption" | "purge-the-foe" | "priority-assets" | "reconnaissance";
  /**
   * The opponent's Force Disposition.
   */
  opponent_disposition: "take-and-hold" | "disruption" | "purge-the-foe" | "priority-assets" | "reconnaissance";
  /**
   * Kebab-case identifier
   */
  mission_id: string;
  game_version: GameVersionReference;
}
/**
 * An 11e primary mission (the objective a player scores). Which mission a player plays is selected by the Force Disposition matchup matrix (see mission-matchup), keyed on the player's own disposition and their opponent's. Victory points are capped per game and per battle round.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "mission".
 */
export interface Mission {
  id: EntityId;
  name: string;
  /**
   * Mission pack or source the mission originates from.
   */
  source?: string;
  /**
   * Community-authored mission/objective summary (original prose only — no reproduced rules text).
   */
  description?: string;
  /**
   * Maximum primary VP scorable across the whole game. 11e default is 45.
   */
  vp_per_game_cap?: number;
  /**
   * Maximum primary VP scorable in a single battle round. 11e default is 15.
   */
  vp_per_round_cap?: number;
  /**
   * Ids of the deployment-pattern entities (maps) this mission can be played on. Empty until the per-mission maps are confirmed.
   */
  deployment_pattern_ids?: EntityId[];
  game_version: GameVersionReference;
}
/**
 * When a VP award is evaluated. A bare `phase` is the legacy shorthand for 'during this phase'; richer triggers add `timing` (the moment within a phase/turn/game), `player_turn`, and a `battle_round` window. A card's section headers map onto these: 'ANY BATTLE ROUND' omits `battle_round`; 'SECOND BATTLE ROUND ONWARDS' is { min: 2 }; 'END OF THE BATTLE' is timing: end-of-battle.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "scoring-trigger".
 */
export interface ScoringTrigger {
  /**
   * The five official game phases. Unchanged between 10th and 11th edition — 11e reorders Pile In timing within the Fight phase but adds no top-level phase.
   */
  phase?: "command" | "movement" | "shooting" | "charge" | "fight";
  /**
   * The moment the award is checked. 'End of your turn' = end-of-turn; 'End of your Command phase' = end-of-phase with phase: command; 'End of the battle' = end-of-battle.
   */
  timing?: "start-of-turn" | "end-of-turn" | "start-of-phase" | "end-of-phase" | "end-of-battle";
  player_turn?: PlayerTurn;
  /**
   * Battle-round window in which the trigger is active. Absent means any battle round (1-5). 'Second battle round onwards' is { min: 2 }.
   */
  battle_round?: {
    min?: number;
    max?: number;
  };
}
/**
 * A draw-time predicate over an army list (not runtime board state, so deliberately NOT the Ability DSL condition). Used to gate when_drawn operations such as redraws. Example: a card that is void unless the opponent fields a large unit (10e 'Cull the Horde' redrew when the opponent had no unit of 14+ models) is { subject: 'opponent', quantifier: 'none', unit_filter: { model_count_min: 14 } } with operation 'redraw'.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "army-composition-predicate".
 */
export interface ArmyCompositionPredicate {
  /**
   * Whose army list the predicate inspects.
   */
  subject: "self" | "opponent";
  /**
   * Whether the army must contain ('any') or lack ('none') a unit matching unit_filter for the predicate to hold.
   */
  quantifier: "any" | "none";
  /**
   * Criteria a unit in the army must satisfy to match. All present criteria must hold (logical AND).
   */
  unit_filter: {
    model_count_min?: number;
    model_count_max?: number;
    wounds_min?: number;
    keywords?: KeywordList;
  };
}
/**
 * An 11e mission card. The deck-level rule (draw 2 per turn, keep unscored cards) is separate and not modelled here. This is the per-card shape: an optional on-draw deck operation, an optional player action, and zero or more VP-award blocks. Primary mission cards reuse this shape via card_type. Mechanic blocks reference the Ability DSL; prose is community-authored (no reproduced rules text).
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "secondary-card".
 */
export interface SecondaryCard {
  id: EntityId;
  name: string;
  /**
   * Whether this is a secondary card or a primary mission card (which reuses this shape).
   */
  card_type?: "secondary" | "primary";
  /**
   * Finer classification within the deck (e.g. a category or tactical/fixed split). Free-form — not enum-locked until 11e categories are confirmed.
   */
  subtype?: string;
  /**
   * Optional deck operation performed when this card is drawn (e.g. redraw, swap). Distinct from combat effects — deck operations have no combat target, so they are not modelled via the Ability DSL effect language. If `condition` is present, the operation fires only when the predicate holds.
   */
  when_drawn?: {
    /**
     * The deck manipulation this card triggers on draw.
     */
    operation: "reshuffle" | "replace" | "redraw" | "draw-extra" | "swap";
    /**
     * Other cards this operation references, by id.
     */
    card_ids?: EntityId[];
    condition?: ArmyCompositionPredicate1;
    /**
     * Battle-round window in which the draw operation is eligible (e.g. { max: 1 } means 'only when drawn in the first battle round'). Absent means the operation fires regardless of round.
     */
    battle_round?: {
      min?: number;
      max?: number;
    };
  };
  /**
   * Optional player actions the card enables. Most cards have a single action; a few (e.g. Observe Enemy, with separate Baited-removal and Spotted actions) have two distinct actions on the same card.
   *
   * @minItems 1
   */
  actions?: [
    {
      /**
       * Optional kebab-case identifier used to reference this action from `action-completed` conditions in `awards[].when`.
       */
      action_id?: string;
      /**
       * The five official game phases. Unchanged between 10th and 11th edition — 11e reorders Pile In timing within the Fight phase but adds no top-level phase.
       */
      starts?: "command" | "movement" | "shooting" | "charge" | "fight";
      /**
       * Non-phase moment the action happens, for card rules that are not started in a phase (Locate and Deny's start-of-battle marker placement, Punishment's start-of-turn condemnation, Consecrate's end-of-turn objective selection). Mutually informative with `starts` — a card action uses one or the other.
       */
      timing?: "start-of-battle" | "start-of-turn" | "end-of-turn";
      /**
       * Battle-round window in which the action can be started. Absent means any battle round. 'From the second battle round onwards' (Triangulate, Extract Intelligence) is { min: 2 }.
       */
      battle_round?: {
        min?: number;
        max?: number;
      };
      player_turn?: PlayerTurn;
      units?: AbilityCondition;
      /**
       * Maximum number of times the action may be performed (per turn unless `use_limit_scope` says otherwise).
       */
      use_limit?: number;
      /**
       * Whether `use_limit` is enforced per turn or once per game (e.g. Recover the Relics / Find and Deny 'Overwhelming Force' is once per game).
       */
      use_limit_scope?: "per-turn" | "per-game";
      completes?: AbilityCondition1;
      effect?: AbilityEffect;
      restrictions?: AbilityCondition3;
    },
    ...{
      /**
       * Optional kebab-case identifier used to reference this action from `action-completed` conditions in `awards[].when`.
       */
      action_id?: string;
      /**
       * The five official game phases. Unchanged between 10th and 11th edition — 11e reorders Pile In timing within the Fight phase but adds no top-level phase.
       */
      starts?: "command" | "movement" | "shooting" | "charge" | "fight";
      /**
       * Non-phase moment the action happens, for card rules that are not started in a phase (Locate and Deny's start-of-battle marker placement, Punishment's start-of-turn condemnation, Consecrate's end-of-turn objective selection). Mutually informative with `starts` — a card action uses one or the other.
       */
      timing?: "start-of-battle" | "start-of-turn" | "end-of-turn";
      /**
       * Battle-round window in which the action can be started. Absent means any battle round. 'From the second battle round onwards' (Triangulate, Extract Intelligence) is { min: 2 }.
       */
      battle_round?: {
        min?: number;
        max?: number;
      };
      player_turn?: PlayerTurn;
      units?: AbilityCondition;
      /**
       * Maximum number of times the action may be performed (per turn unless `use_limit_scope` says otherwise).
       */
      use_limit?: number;
      /**
       * Whether `use_limit` is enforced per turn or once per game (e.g. Recover the Relics / Find and Deny 'Overwhelming Force' is once per game).
       */
      use_limit_scope?: "per-turn" | "per-game";
      completes?: AbilityCondition1;
      effect?: AbilityEffect;
      restrictions?: AbilityCondition3;
    }[]
  ];
  /**
   * VP-award blocks: each scores when `trigger` fires and the optional `when` condition holds. An award scores either a flat `vp` or a count-scaled `vp_per` (VP per instance of the thing named by `per`). Awards accrue independently and sum; a card's '+ ... CUMULATIVE' rows are modelled as separate awards flagged `cumulative` for faithful round-trip. Awards sharing the same `exclusive_group` value within a card resolve as the highest-scoring single award fires (the card's literal 'OR' rows between tier breakpoints, e.g. Record-Breaking Mission's 3-Fronts vs 4-Fronts).
   *
   * @minItems 1
   */
  awards?: [
    (
      | {
          [k: string]: unknown;
        }
      | {
          [k: string]: unknown;
        }
    ),
    ...(
      | {
          [k: string]: unknown;
        }
      | {
          [k: string]: unknown;
        }
    )[]
  ];
  /**
   * Community-authored card description (original prose only — no reproduced rules text).
   */
  text?: string;
  game_version: GameVersionReference;
}
/**
 * Draw-time army-composition predicate gating the operation (e.g. redraw when the opponent lacks a qualifying unit).
 */
export interface ArmyCompositionPredicate1 {
  /**
   * Whose army list the predicate inspects.
   */
  subject: "self" | "opponent";
  /**
   * Whether the army must contain ('any') or lack ('none') a unit matching unit_filter for the predicate to hold.
   */
  quantifier: "any" | "none";
  /**
   * Criteria a unit in the army must satisfy to match. All present criteria must hold (logical AND).
   */
  unit_filter: {
    model_count_min?: number;
    model_count_max?: number;
    wounds_min?: number;
    keywords?: KeywordList;
  };
}
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "simple-condition".
 */
export interface SimpleCondition {
  type:
    | "phase-is"
    | "timing-is"
    | "player-turn-is"
    | "unit-below-starting-strength"
    | "unit-below-half-strength"
    | "unit-has-keyword"
    | "unit-within-range-of"
    | "model-is-leader"
    | "target-has-keyword"
    | "charged-this-turn"
    | "advanced-this-turn"
    | "remained-stationary"
    | "is-battle-shocked"
    | "has-lost-wounds"
    | "wounds-remaining-at-or-below"
    | "was-hit-by-attack"
    | "opponent-unit-within-range"
    | "within-range-of-objective"
    | "attack-is-type"
    | "has-fought-this-phase"
    | "destroyed-by-attack-type"
    | "controls-objective"
    | "is-attached"
    | "terrain-area-control"
    | "engagement-state"
    | "territory-control"
    | "fights-first"
    | "disposition-matches"
    | "units-destroyed"
    | "units-destroyed-comparison"
    | "objective-majority"
    | "action-completed"
    | "objective-has-tag"
    | "unit-has-tag"
    | "terrain-has-tag"
    | "new-objective-controlled"
    | "engagement-fronts"
    | "destroyed-while-on-objective"
    | "destroyed-in-tagged-terrain"
    | "operation-markers"
    | "attack-stat-compare"
    | "made-ingress-move-this-turn"
    | "disembarked-from-transport"
    | "faction-rule-active"
    | "battle-round";
  parameters?: {
    [k: string]: unknown;
  };
  negated?: boolean;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "compound-condition".
 */
export interface CompoundCondition {
  operator: "and" | "or" | "not";
  /**
   * @minItems 1
   */
  operands: [ConditionNode, ...ConditionNode[]];
  [k: string]: unknown;
}
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "single-effect".
 */
export interface SingleEffect {
  type:
    | "stat-modifier"
    | "roll-modifier"
    | "re-roll"
    | "mortal-wounds"
    | "feel-no-pain"
    | "invulnerable-save"
    | "ward"
    | "keyword-grant"
    | "unit-keyword"
    | "movement-modifier"
    | "deep-strike"
    | "fallback-and-act"
    | "fight-first"
    | "fight-last"
    | "shoot-on-death"
    | "fight-on-death"
    | "objective-control-modifier"
    | "leadership-modifier"
    | "damage-reduction"
    | "attack-restriction"
    | "ability-grant"
    | "cp-gain"
    | "cp-refund"
    | "model-destruction"
    | "resurrection"
    | "resource-gain"
    | "resource-spend"
    | "charge-roll-modifier"
    | "terrain-area-tag"
    | "objective-tag"
    | "unit-tag"
    | "bs-modifier"
    | "engagement-passthrough"
    | "strategic-reserves-arrival"
    | "remove-battle-shock"
    | "unit-keyword-grant";
  target:
    | "self"
    | "bearer"
    | "unit"
    | "attached-unit"
    | "attacker"
    | "defender"
    | "target"
    | "friendly-within-aura"
    | "enemy-within-aura"
    | "all-friendly"
    | "all-enemy";
  modifier?: {
    [k: string]: unknown;
  };
  scaling?: Scaling;
  [k: string]: unknown;
}
/**
 * Scales the effect's numeric `modifier.value`: it applies once per `per` of `of` (rounding `round`, default down), optionally capped at `max_value`. E.g. '+2 to the Attacks characteristic for every 5 enemy models within 6\"' → modifier.value 2 with scaling { per: 5, of: 'enemy-models-in-range', within_inches: 6 }.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "scaling".
 */
export interface Scaling {
  per: number;
  of:
    | "enemy-models-in-range"
    | "friendly-models-in-range"
    | "models-in-bearer-unit"
    | "enemy-units-in-range"
    | "wounds-lost";
  within_inches?: number;
  round?: "down" | "up";
  max_value?: number;
}
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "choice-effect".
 */
export interface ChoiceEffect {
  type: "choice";
  /**
   * @minItems 2
   */
  options: [EffectNode, EffectNode, ...EffectNode[]];
  choice_label?: string;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "sequence-effect".
 */
export interface SequenceEffect {
  type: "sequence";
  /**
   * @minItems 1
   */
  steps: [EffectNode, ...EffectNode[]];
  [k: string]: unknown;
}
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "dice-gated-effect".
 */
export interface DiceGatedEffect {
  type: "dice-gated";
  /**
   * Dice expression, e.g. 'D6', '2D6'
   */
  dice: string;
  /**
   * Fixed threshold or model characteristic to compare against
   */
  threshold: number | ("leadership" | "toughness" | "save");
  comparison?: "gte" | "lte" | "gt" | "lt" | "eq";
  on_success?: EffectNode | null;
  on_fail?: EffectNode | null;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "conditional-effect".
 */
export interface ConditionalEffect {
  type: "conditional";
  condition: AbilityCondition2;
  effect: EffectNode;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "dice-pool-allocation-effect".
 */
export interface DicePoolAllocationEffect {
  type: "dice-pool-allocation";
  pool: {
    count: number;
    die: string;
    [k: string]: unknown;
  };
  max_activations: number;
  /**
   * @minItems 1
   */
  options: [
    {
      name: string;
      requirement: {
        type: "pair" | "triple" | "single" | "run";
        min_value: number;
        [k: string]: unknown;
      };
      effect: EffectNode;
      [k: string]: unknown;
    },
    ...{
      name: string;
      requirement: {
        type: "pair" | "triple" | "single" | "run";
        min_value: number;
        [k: string]: unknown;
      };
      effect: EffectNode;
      [k: string]: unknown;
    }[]
  ];
  [k: string]: unknown;
}
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "select-units-effect".
 */
export interface SelectUnitsEffect {
  type: "select-units";
  selector: {
    max_count: number;
    keywords?: string[];
    owner: "friendly" | "enemy";
  };
  effect: EffectNode;
  [k: string]: unknown;
}
/**
 * A CP-costed ability usable during specific game phases.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "stratagem".
 */
export interface Stratagem {
  id: EntityId;
  name: string;
  /**
   * Whether this is a universal core stratagem or tied to a specific detachment
   */
  category: "core" | "detachment";
  /**
   * GW-printed stratagem category from the card. Optional: 11e faction packs omit it for newly introduced detachments, and the category has no in-game effect; absent when the source does not state one.
   */
  type?: "battle-tactic" | "strategic-ploy" | "epic-deed" | "wargear";
  /**
   * Null for core stratagems
   */
  detachment_id?: EntityId | null;
  cp_cost: number;
  phases: PhaseList;
  player_turn: PlayerTurn;
  timing: "once-per-phase" | "once-per-turn" | "once-per-battle" | "unlimited";
  target_restrictions?: {
    required_keywords?: KeywordList6;
    required_keywords_any?: KeywordList7;
    excluded_keywords?: KeywordList;
    notes?: string;
  } | null;
  ability_id?: EntityId | null;
  game_version: GameVersionReference;
}
/**
 * A named target archetype for damage comparison. References a real dataset unit (faction_id + unit_id) rather than copying its stat line, so the profile stays in sync with dataset updates. Stats, keywords, and defensive abilities are resolved from the referenced unit at use time.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "target-profile".
 */
export interface TargetProfile {
  id: EntityId;
  name: string;
  description?: string;
  /**
   * Kebab-case identifier
   */
  faction_id: string;
  /**
   * Kebab-case identifier
   */
  unit_id: string;
  /**
   * Optional non-default squad size for the comparison. When null/absent, the referenced unit's model_count.min is used.
   */
  model_count_override?: number | null;
  game_version: GameVersionReference;
}
/**
 * One terrain piece placed on the board. Geometry comes from a catalog `template` or an inline `footprint` (if both are present, `footprint` is authoritative and `template` is provenance).
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "piece".
 */
export interface Piece {
  /**
   * Kebab-case identifier
   */
  id?: string;
  name?: string;
  /**
   * An `area` is a gameplay terrain zone (the 11e 'terrain area'); a `feature` is physical scenery (walls, containers, pipes) placed on an area.
   */
  piece_type?: "area" | "feature";
  /**
   * Kebab-case identifier
   */
  template?: string;
  /**
   * Inline geometry, standing in for or overriding a template footprint. Authoritative when present.
   */
  footprint?:
    | {
        type: "rectangle";
        width: number;
        height: number;
      }
    | {
        type: "right-triangle";
        width: number;
        height: number;
      }
    | {
        type: "polygon";
        /**
         * @minItems 3
         */
        points: [Vec2, Vec2, Vec2, ...Vec2[]];
      };
  position: Vec21;
  /**
   * Clockwise rotation about the centroid in the y-down board frame. Absent or 0 means the template's natural orientation.
   */
  rotation_degrees?: number;
  /**
   * Reflection applied in the centroid-local frame before rotation: `horizontal` negates local x (left-right flip), `vertical` negates local y.
   */
  mirror?: "none" | "horizontal" | "vertical";
  /**
   * Kebab-case identifier
   */
  parent_area_id?: string;
  /**
   * Ruin floor this piece occupies (0 = ground level).
   */
  floor?: number;
  /**
   * Height of the piece in inches; overrides the template default. Gates Plunging Fire (a piece 3" or taller confers +1 BS on ground-level targets).
   */
  height_inches?: number;
  /**
   * Terrain-area keywords this piece's area carries; overrides the template default.
   */
  terrain_area_keywords?: TerrainAreaKeyword[];
  /**
   * Pieces sharing a `link_group` value are linked terrain — treated as a single terrain feature (and, where an objective sits among them, a single objective).
   */
  link_group?: string;
  /**
   * Designates this terrain area — or, when `link_group`'d, the union of linked areas (one objective for the set) — as carrying an objective of the given 11e role: `home` (inside a deployment zone), `center` (board middle), or `expansion` (no-man's-land). Implies `is_objective`.
   */
  objective_role?: "home" | "expansion" | "center";
  /**
   * Whether this piece carries an objective marker.
   */
  is_objective?: boolean;
  /**
   * Objective-marker metadata. Only meaningful when `is_objective` is true.
   */
  objective?: {
    position?: Vec22;
    /**
     * Range from the marker within which models contribute to control.
     */
    control_range_inches?: number;
  };
  /**
   * Measurement keystones: the author-selected dimension lines a reference card prints so a player can place this piece with a tape measure (board edge → a feature of the placed piece). Only the selection is stored — the distance is always DERIVED from the resolved geometry by the shared keystone resolver (pinned by the conformance corpus), so a keystone can never disagree with the layout. Vertex indices follow the resolver's pinned vertex order; re-authoring a template's footprint invalidates them, so review keystones when geometry changes.
   */
  keystones?: {
    /**
     * The board edge the measurement runs from, in the y-down board frame (left/right pin x against board width; top/bottom pin y against board height).
     */
    edge: "left" | "right" | "top" | "bottom";
    /**
     * Which feature of the placed piece the measurement reaches: a footprint vertex (by resolver vertex order) or an axis-aligned bounding face of the placed footprint.
     */
    ref:
      | {
          kind: "vertex";
          index: number;
        }
      | {
          kind: "face";
          side: "min-x" | "max-x" | "min-y" | "max-y";
        };
  }[];
}
/**
 * A 2D point in board inches. Origin at a board corner; JSON uses y-down (downstream renderers may flip to y-up).
 */
export interface Vec21 {
  x: number;
  y: number;
}
/**
 * A 2D point in board inches. Origin at a board corner; JSON uses y-down (downstream renderers may flip to y-up).
 */
export interface Vec22 {
  x: number;
  y: number;
}
/**
 * A recommended arrangement of terrain pieces on the board, independent of the deployment map (a deployment-pattern references the layouts it recommends via recommended_terrain_layout_ids). Each piece draws its geometry from a catalog `template` (a terrain-template entity) or an inline `footprint`; geometry is the source of truth. Placement is template-centroid-anchored: `position` is the piece's centroid, which is invariant under rotation and mirror, so orientation and location are decoupled. Resolved board-space vertices are derived by the shared terrain resolver (pinned by the conformance corpus), never stored here. No layout data is authored yet beyond migrated examples.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "terrain-layout".
 */
export interface TerrainLayout {
  id: EntityId;
  name: string;
  /**
   * Mission pack or source the layout originates from.
   */
  source?: string;
  description?: string;
  /**
   * Kebab-case identifier
   */
  mission_matchup_id?: string;
  /**
   * The card's trailing variant number within its mission matchup (1–3 at launch, since three layouts share each pairing). No hard maximum, to avoid a breaking change if more variants ship.
   */
  variant?: number;
  /**
   * Kebab-case identifier
   */
  deployment_pattern_id?: string;
  /**
   * Terrain pieces composing the layout. May be empty while a layout is registered by name ahead of its confirmed geometry.
   */
  pieces?: Piece[];
  game_version: GameVersionReference;
}
/**
 * A feature placed on an area template, positioned in the area's centroid-local frame (y-down inches). When the area is placed, rotated, or mirrored, its composed features are carried along.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "composed-feature".
 */
export interface ComposedFeature {
  /**
   * Kebab-case identifier
   */
  id?: string;
  /**
   * Kebab-case identifier
   */
  template: string;
  position: Vec23;
  /**
   * Clockwise rotation of the feature about its own centroid, within the area-local frame.
   */
  rotation_degrees?: number;
  mirror?: "none" | "horizontal" | "vertical";
  /**
   * Ruin floor this feature occupies (0 = ground level).
   */
  floor?: number;
}
/**
 * A 2D point in board inches. Origin at a board corner; JSON uses y-down (downstream renderers may flip to y-up).
 */
export interface Vec23 {
  x: number;
  y: number;
}
/**
 * A reusable terrain piece in the standard catalog: a gameplay area (the 11e terrain-area templates) or a scenery feature (walls, containers, pipes, floor segments). Footprints are authored in natural local inches; the terrain resolver derives each footprint's polygon area centroid and re-centers on it, so a layout piece that instances a template places its centroid via the layout's `position`. An `area` template may carry an embedded `features` list — scenery placed in the area's centroid-local frame — making the template a reusable composition (e.g. a ruin with its walls). Placing such a template places all of its features, transformed by the area's own placement.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "terrain-template".
 */
export interface TerrainTemplate {
  id: EntityId;
  name: string;
  /**
   * `area` = a gameplay terrain zone; `feature` = physical scenery placed on an area.
   */
  kind: "area" | "feature";
  /**
   * Catalog or mission pack the template originates from.
   */
  source?: string;
  footprint: Footprint;
  /**
   * Default height in inches for pieces instancing this template. Gates Plunging Fire (>= 3").
   */
  default_height_inches?: number;
  /**
   * Whether the template blocks line of sight / movement by default.
   */
  default_blocking?: boolean;
  /**
   * Whether models may be placed on the ground footprint. `false` marks an elevated-only piece (a platform reachable only on its `upper_floor`, e.g. a gantry/catwalk) or a solid obstacle with no valid placement (e.g. a generator). Meaningful for `kind: "feature"`.
   */
  ground_accessible?: boolean;
  /**
   * An elevated platform carried by this feature (e.g. a ruin's second storey). Its footprint is authored in the SAME local frame as `footprint` and re-centered on the GROUND footprint's polygon area centroid, so the two floors stay registered when the piece is placed, rotated, or mirrored. Non-resolved metadata: the terrain resolver does not emit it; authoring/visualization tools render it as an overlay. Meaningful for `kind: "feature"`.
   */
  upper_floor?: {
    footprint: Footprint;
    /**
     * Ruin floor this platform occupies (1 = first floor above ground).
     */
    floor?: number;
  };
  /**
   * Terrain-area keywords areas of this template carry by default. Meaningful for `kind: "area"`.
   */
  default_terrain_area_keywords?: TerrainAreaKeyword[];
  /**
   * Composed scenery features, in the area's centroid-local frame. Only meaningful for `kind: "area"`.
   */
  features?: ComposedFeature[];
  /**
   * 11e terrain category (§13.02–13.05). Applies to kind: "feature". Dense features enable the Hidden rule; light features provide cover but not obscuring.
   */
  terrain_category?: "exposed" | "light" | "dense";
  game_version: GameVersionReference;
}
/**
 * Describes the internal model-type breakdown of a unit.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "unit-composition".
 */
export interface UnitComposition {
  unit_id: EntityId;
  /**
   * Kebab-case identifier
   */
  faction_id: string;
  /**
   * @minItems 1
   */
  models: [
    {
      name: string;
      profile_name?: string | null;
      min: number;
      max: number;
      default_weapon_ids?: EntityId[];
      is_leader_model?: boolean;
      base_size_mm?: BaseSize1;
      /**
       * Optional reference to a hull-shape entity giving this model's 2D collision polygon, used instead of the circular/oval base footprint. By convention a model carrying this should set `base_size_mm.shape` to "hull".
       */
      hull_shape_id?: EntityId | null;
    },
    ...{
      name: string;
      profile_name?: string | null;
      min: number;
      max: number;
      default_weapon_ids?: EntityId[];
      is_leader_model?: boolean;
      base_size_mm?: BaseSize1;
      /**
       * Optional reference to a hull-shape entity giving this model's 2D collision polygon, used instead of the circular/oval base footprint. By convention a model carrying this should set `base_size_mm.shape` to "hull".
       */
      hull_shape_id?: EntityId | null;
    }[]
  ];
  /**
   * The discrete buildable squad sizes (GW's per-datasheet unit-composition rows). Each tier gives a per-model count range; a legal squad must match exactly one tier. When absent, the squad is treated as a single implicit tier equal to `models[]`. The top-level `models[]` min/max are the aggregate envelope (min-of-mins / max-of-maxes) across the tiers, so consumers that read only `models[]` still see the full range.
   *
   * @minItems 1
   */
  tiers?: [
    {
      /**
       * One entry per top-level `models[]` row, matched by `name`, giving this tier's count range for that model type.
       *
       * @minItems 1
       */
      models: [
        {
          name: string;
          min: number;
          max: number;
        },
        ...{
          name: string;
          min: number;
          max: number;
        }[]
      ];
    },
    ...{
      /**
       * One entry per top-level `models[]` row, matched by `name`, giving this tier's count range for that model type.
       *
       * @minItems 1
       */
      models: [
        {
          name: string;
          min: number;
          max: number;
        },
        ...{
          name: string;
          min: number;
          max: number;
        }[]
      ];
    }[]
  ];
  game_version: GameVersionReference;
}
/**
 * This model's base. Absent when no base could be resolved for the model.
 */
export interface BaseSize1 {
  shape: "round" | "oval" | "flying-base" | "hull" | "unique";
  diameter?: number;
  width?: number;
  length?: number;
  /**
   * Flying-base size class, when 'shape' is 'flying-base'.
   */
  size?: "small" | "large";
  /**
   * True when the entry is provisional/guessed (e.g. a category without authoritative dimensions) and should be revisited.
   */
  draft?: boolean;
}
/**
 * Catalog entry for a universal unit ability (a 'Core ability' in the rulebook: Deep Strike, Scouts X", Feel No Pain X+, Deadly Demise X, etc.). These are the unit-side counterpart of weapon-keyword.schema.json — community-authored mechanic labels, not reproduced rules text. A unit references a parameterised instance from its `ability_ids` (e.g. `scouts-6`); this catalog records the value-agnostic definition keyed by base id (e.g. `scouts`). The optional `effect` describes the mechanic in the Ability DSL; null when the behaviour is modelled per-faction in enrichment data rather than here.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "unit-keyword".
 */
export interface UnitKeyword {
  id: EntityId;
  name: string;
  /**
   * Parameter keys that must be supplied at each reference site (e.g. Scouts 6" → ['value']). Empty for abilities that take no number (Deep Strike, Infiltrators, Stealth).
   *
   * @maxItems 1
   */
  required_parameters: [] | ["value"];
  /**
   * Mechanical effect of this ability. Null when the behaviour is authored per-faction in the enrichment Ability DSL rather than centrally here — engines resolve the per-faction record.
   */
  effect: AbilityEffect1 | null;
  game_version: GameVersionReference;
}
/**
 * A unit datasheet entry with stat profiles and point costs.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "unit".
 */
export interface Unit {
  id: EntityId;
  name: string;
  faction_id: EntityId;
  /**
   * Battlefield role from the datasheet header. Unit types (Infantry, Vehicle, etc.) belong in keywords.
   */
  role?: "character" | "battleline" | "dedicated-transport" | "fortification" | "allied" | "epic-hero";
  /**
   * Character attachment role (11e). 'support' implies the unit is only legal when attached to a host unit (cannot be taken solo); 'leader' is valid as a standalone list entry. null/absent for non-attaching units.
   */
  attachment_role?: ("leader" | "support") | null;
  /**
   * @minItems 1
   */
  profiles: [
    {
      /**
       * Profile name (e.g., 'Wounded' for degrading)
       */
      name?: string;
      M: StatValue;
      T: number;
      W: number;
      Sv: number;
      invuln_sv?: number | null;
      Ld: number;
      OC: number;
      [k: string]: unknown;
    },
    ...{
      /**
       * Profile name (e.g., 'Wounded' for degrading)
       */
      name?: string;
      M: StatValue;
      T: number;
      W: number;
      Sv: number;
      invuln_sv?: number | null;
      Ld: number;
      OC: number;
      [k: string]: unknown;
    }[]
  ];
  points?: {
    models: number;
    cost: number;
    /**
     * 11e per-army-ordinal pricing: the first army-copy count (1-based) this tier's cost applies to. Absent (together with unit_count_max) means the cost applies to every copy — the common case. Present only for datasheets the MFM prices by how many you have taken (e.g. 'your 1st-2nd units cost X, your 3rd+ unit costs Y').
     */
    unit_count_min?: number;
    /**
     * Inclusive upper army-copy count for this tier's band, or null for an open-ended top band ('3rd+ unit'). Absent when unit_count_min is absent.
     */
    unit_count_max?: number | null;
    [k: string]: unknown;
  }[];
  /**
   * 11e: alternate point costs that apply only when this unit is included in a host army of another faction (e.g. an Agents of the Imperium unit allied into any IMPERIUM army). Each entry mirrors a `points` tier but is scoped to a `host_faction`. Absent for the common case where the unit costs the same everywhere; consumers that don't model allied pricing read `points` (the native cost) and ignore this.
   */
  allied_points?: {
    /**
     * Kebab-case identifier
     */
    host_faction: string;
    models: number;
    cost: number;
    unit_count_min?: number;
    unit_count_max?: number | null;
  }[];
  /**
   * True when point costs are carried over provisionally (e.g. seeded from a prior edition during migration) and not yet confirmed against the current dataslate.
   */
  points_provisional?: boolean;
  keywords?: KeywordList;
  faction_keywords?: KeywordList;
  /**
   * Faction keywords whose armies are barred from taking this otherwise-generic unit. Used where the game removes a generic unit from a specific sub-faction without printing a replacement (e.g. Black Templars cannot field Librarians; Deathwatch cannot field the generic Tactical Squad). An army may take this unit only if none of its faction keywords appear here. Absent/empty = available to every keyword-eligible army. Distinct from `faction_keywords`, which is the positive access list; this is the negative one for the rare exclusions a flat shared pool cannot otherwise express.
   */
  excluded_faction_keywords?: KeywordList | null;
  /**
   * The unit's representative base (the most-numerous model's base). Mixed-model units carry the full per-model breakdown in unit-composition; this top-level value is a convenience for consumers that need a single base.
   */
  base_size_mm?: BaseSize | null;
  model_count?: {
    min: number;
    max: number;
    [k: string]: unknown;
  };
  weapon_ids?: EntityId[];
  ability_ids?: EntityId[];
  /**
   * Limited-wargear squad allowances the per-weapon bounds cannot express: a GW `limited_wargear_choice_set` that is either (a) SHARED across several weapons (a 'for every N models, one model can take one of A/B/C' line) or (b) a FLAT per-unit cap ('up to 1 per unit'). A loadout is legal only if the summed count of a budget's items is at most the cap: `floor(model_count * count / per_models)` for a ratio, or just `count` when `per_models` is 0 (a flat per-unit cap). Single-weapon per-N allowances are NOT budgets — the per-weapon bounds already model them (they correctly sum a weapon's capacity across the model types that may take it).
   */
  wargear_budgets?: {
    /**
     * @minItems 1
     */
    items: [EntityId, ...EntityId[]];
    count: number;
    /**
     * Models per `count` allowance; 0 means a flat per-unit cap of `count` (independent of squad size).
     */
    per_models: number;
  }[];
  transport_capacity?: {
    capacity: number;
    keyword_restrictions?: KeywordList | null;
    exclusion_keywords?: KeywordList | null;
  } | null;
  game_version: GameVersionReference;
  is_legend?: boolean;
}
/**
 * A wargear option available to models within a unit: a weapon/wargear swap, a pure add-on, or a choice between alternatives. Models start with the unit's base loadout; an option modifies that loadout for the number of models its `model_constraint` permits.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "wargear-option".
 */
export interface WargearOption {
  id: EntityId;
  unit_id: EntityId;
  /**
   * Kebab-case identifier
   */
  faction_id: string;
  model_constraint?: {
    model_name?: string;
    per_n_models?: number;
    max_count?: number;
    /**
     * When true, every model in the unit may take the option ('Any number of models can each ...'). Mutually exclusive in spirit with `per_n_models`.
     */
    any_number?: boolean;
  } | null;
  /**
   * Weapon or wargear IDs removed from the model. Omit for a pure add-on (the option only equips new wargear).
   *
   * @minItems 1
   */
  replaces?: [EntityId, ...EntityId[]];
  /**
   * Weapon or wargear IDs added to the model — all of them. Exactly one of `replacement` / `replacement_choice` is present.
   *
   * @minItems 1
   */
  replacement?: [EntityId, ...EntityId[]];
  /**
   * A choice of replacements ('one of the following'): pick exactly one inner group; each group's IDs are all added together. Exactly one of `replacement` / `replacement_choice` is present.
   *
   * @minItems 2
   */
  replacement_choice?: [[EntityId, ...EntityId[]], [EntityId, ...EntityId[]], ...[EntityId, ...EntityId[]][]];
  is_free?: boolean;
  additional_cost?: number | null;
  game_version: GameVersionReference;
}
/**
 * A non-weapon item a model may carry — an icon, attachment, or other piece of equipment with no weapon profile. Weapons live in weapon.schema.json; this entity exists so wargear-option swaps and add-ons can reference equipment that is not a weapon.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "wargear".
 */
export interface Wargear {
  id: EntityId;
  name: string;
  category?: string | null;
  game_version: GameVersionReference;
}
/**
 * Catalog entry for a weapon keyword (Lethal Hits, Sustained Hits N, Anti-X N+, etc.). Each weapon profile references entries here via {keyword_id, parameters?} instead of carrying free-text strings. The optional `effect` describes the keyword's game mechanic in the Ability DSL; null when the behaviour is faction-specific flavour not yet modelled.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "weapon-keyword".
 */
export interface WeaponKeyword {
  id: EntityId;
  name: string;
  /**
   * Parameter keys that must be supplied at each reference site, in the order they would appear in a printed datasheet (e.g. Anti-INFANTRY 4+ → ['target_keyword', 'threshold']).
   *
   * @maxItems 3
   */
  required_parameters:
    | []
    | ["value" | "target_keyword" | "threshold"]
    | ["value" | "target_keyword" | "threshold", "value" | "target_keyword" | "threshold"]
    | [
        "value" | "target_keyword" | "threshold",
        "value" | "target_keyword" | "threshold",
        "value" | "target_keyword" | "threshold"
      ];
  /**
   * Mechanical effect of this keyword. Null when the behaviour is faction-specific flavour not yet expressible in the DSL — engines treat such references as no-op buffs and may surface them as 'cannot auto-apply'.
   */
  effect: AbilityEffect1 | null;
  game_version: GameVersionReference;
}
/**
 * A weapon entry with one or more stat profiles (e.g., standard and overcharge modes).
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "weapon".
 */
export interface Weapon {
  id: EntityId;
  name: string;
  type: "ranged" | "melee";
  /**
   * @minItems 1
   */
  profiles: [
    {
      name: string;
      range?: number | "Melee";
      stats: {
        A: StatValue;
        BS?: number | null;
        WS?: number | null;
        S: StatValue;
        AP: number;
        D: StatValue;
        [k: string]: unknown;
      };
      /**
       * References into the weapon-keyword catalog. Each entry names the catalog id and supplies parameter values (e.g. `Sustained Hits 1` → `{keyword_id: 'sustained-hits', parameters: {value: 1}}`).
       */
      keywords?: {
        keyword_id: EntityId;
        /**
         * Reference-site parameters conforming to the catalog entry's required_parameters. Only the three documented keys are accepted; any other key is invalid.
         */
        parameters?: {
          value?: StatValue;
          target_keyword?: string;
          threshold?: number;
        };
      }[];
    },
    ...{
      name: string;
      range?: number | "Melee";
      stats: {
        A: StatValue;
        BS?: number | null;
        WS?: number | null;
        S: StatValue;
        AP: number;
        D: StatValue;
        [k: string]: unknown;
      };
      /**
       * References into the weapon-keyword catalog. Each entry names the catalog id and supplies parameter values (e.g. `Sustained Hits 1` → `{keyword_id: 'sustained-hits', parameters: {value: 1}}`).
       */
      keywords?: {
        keyword_id: EntityId;
        /**
         * Reference-site parameters conforming to the catalog entry's required_parameters. Only the three documented keys are accepted; any other key is invalid.
         */
        parameters?: {
          value?: StatValue;
          target_keyword?: string;
          threshold?: number;
        };
      }[];
    }[]
  ];
  game_version: GameVersionReference;
}
/**
 * Community-authored structured representation of what a game ability does. NOT GW text.
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "ability".
 */
export interface AbilityDSLEntry {
  ability_id: EntityId;
  name: string;
  authored_by: ContributorRef;
  game_version: GameVersionReference;
  version?: DataslateVersion;
  supersedes?: DataslateVersion | null;
  unit_ids?: EntityId[];
  /**
   * For faction-type abilities, the faction this rule belongs to
   */
  faction_id?: EntityId | null;
  /**
   * For detachment/enhancement/stratagem-type abilities, the associated detachment
   */
  detachment_id?: EntityId | null;
  ability_type?: "core" | "faction" | "detachment" | "unit" | "enhancement" | "stratagem";
  /**
   * How this ability interacts with the game flow — not a runtime predicate
   */
  behavior?: "passive" | "activated" | "reactive" | "aura";
  effect: AbilityEffect1;
  scope: AbilityScope;
  /**
   * Static, human-curated keyword filter naming which datasheet units this ability benefits, for roster-side highlighting. A unit matches when it carries every keyword in `required_keywords` (across its `keywords` + `faction_keywords`) and none in `excluded_keywords`. This is a denormalized projection distinct from the runtime `effect` condition tree (which mixes static class, runtime-granted markers, and timing gates and must not be scraped for scope). Absent/null means no resolvable unit scope — consumers render no highlight rather than guess.
   */
  applies_to?: {
    required_keywords?: KeywordList;
    excluded_keywords?: KeywordList;
  } | null;
  interactions?: {
    ability_ref: EntityId;
    type: "conflicts-with" | "combos-with" | "superseded-by" | "requires" | "replaces";
    notes?: string;
    [k: string]: unknown;
  }[];
  disputed?: boolean;
  dispute_notes?: string;
  community_notes?: string;
}
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "scope".
 */
export interface AbilityScope {
  range:
    | "self"
    | "unit"
    | "attached"
    | "aura-6"
    | "aura-9"
    | "aura-12"
    | "aura-custom"
    | "engagement-range"
    | "any-visible"
    | "any-on-battlefield"
    | "terrain-within-range";
  duration: "phase" | "turn" | "battle-round" | "battle" | "until-next-command-phase" | "one-use" | "permanent";
  range_inches?: number;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "interaction-flag".
 */
export interface InteractionFlag {
  ability_a: EntityId;
  ability_b: EntityId;
  interaction_type: "conflicts" | "combos" | "sequencing-dependent" | "stacks" | "does-not-stack" | "replaces";
  resolution?: string;
  faq_reference?: string;
  disputed?: boolean;
  game_version: GameVersionReference;
  authored_by?: ContributorRef;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "phase-mapping".
 */
export interface PhaseMapping {
  source_id: EntityId;
  source_type: SourceType;
  phases: PhaseList;
  game_version: GameVersionReference;
  authored_by?: ContributorRef;
  [k: string]: unknown;
}
/**
 * A faction's resource system (Miracle Dice, Pain tokens, Blessings dice pool, etc.).
 *
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "resource-pool".
 */
export interface ResourcePool {
  id: EntityId;
  name: string;
  faction_id: EntityId;
  pool_type: "token" | "dice-pool" | "counter";
  generation?: {
    condition: AbilityCondition2;
    amount: StatValue;
    [k: string]: unknown;
  }[];
  max_size?: number | null;
  game_version: GameVersionReference;
}
/**
 * This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
 * via the `definition` "timing-flag".
 */
export interface TimingFlag {
  source_id: EntityId;
  source_type: SourceType;
  timing:
    | "start-of-phase"
    | "end-of-phase"
    | "before-hit-roll"
    | "after-hit-roll"
    | "before-wound-roll"
    | "after-wound-roll"
    | "before-save-roll"
    | "after-save-roll"
    | "before-damage-roll"
    | "after-damage-roll"
    | "before-charge-roll"
    | "after-charge-roll"
    | "before-advance-roll"
    | "after-advance-roll"
    | "before-battle-shock"
    | "after-battle-shock"
    | "on-unit-selected"
    | "on-unit-destroyed"
    | "on-model-destroyed"
    | "on-damage-allocated"
    | "before-this-model-removed";
  game_version: GameVersionReference;
  authored_by?: ContributorRef;
  [k: string]: unknown;
}
