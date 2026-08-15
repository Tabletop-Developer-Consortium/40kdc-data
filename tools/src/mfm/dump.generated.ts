/* Generated from dump.catalog.json and _private/dump.json by 'npm run mfm:contract -- --write'. DO NOT EDIT BY HAND. */

export interface MfmDumpPayload {
  metadata: MfmMetadata;
  data: MfmTableMap;
}
/**
 * Contains snapshot metadata for the dump.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "MfmMetadata".
 */
export interface MfmMetadata {
  /**
   * Identifies the numeric source snapshot version.
   */
  data_version: number;
}
/**
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "MfmTableMap".
 */
export interface MfmTableMap {
  all_model_wargear_choice: AllModelWargearChoiceRow[];
  all_model_wargear_choice_set: AllModelWargearChoiceSetRow[];
  all_model_wargear_choice_wargear_item: AllModelWargearChoiceWargearItemRow[];
  allegiance_ability: AllegianceAbilityRow[];
  allegiance_ability_group: AllegianceAbilityGroupRow[];
  allied_faction: AlliedFactionRow[];
  /**
   * @maxItems 0
   */
  allied_faction_allegiance_ability: [];
  /**
   * @maxItems 0
   */
  allied_faction_allowed_warlord_miniature: [];
  allied_faction_datasheet: AlliedFactionDatasheetRow[];
  allied_faction_keyword: AlliedFactionKeywordRow[];
  allied_faction_keyword_slotless_keyword_group: AlliedFactionKeywordSlotlessKeywordGroupRow[];
  allied_faction_keyword_slotless_keyword_group_donor_keyword: AlliedFactionKeywordSlotlessKeywordGroupDonorKeywordRow[];
  allied_faction_keyword_slotless_keyword_group_receiver_keyword: AlliedFactionKeywordSlotlessKeywordGroupReceiverKeywordRow[];
  allied_faction_parent_faction_keyword: AlliedFactionParentFactionKeywordRow[];
  allied_faction_points_limit: AlliedFactionPointsLimitRow[];
  allied_faction_required_detachment: AlliedFactionRequiredDetachmentRow[];
  /**
   * @maxItems 0
   */
  amendment: [];
  army_rule: ArmyRuleRow[];
  /**
   * @maxItems 0
   */
  army_rule_behaviour_type: [];
  army_rule_excluded_from_command_bunker_faction_keyword: ArmyRuleExcludedFromCommandBunkerFactionKeywordRow[];
  army_rule_faction_keyword: ArmyRuleFactionKeywordRow[];
  base_miniature_loadout: BaseMiniatureLoadoutRow[];
  base_miniature_loadout_wargear_option: BaseMiniatureLoadoutWargearOptionRow[];
  battle_size: BattleSizeRow[];
  behaviour_type: BehaviourTypeRow[];
  bullet_point: BulletPointRow[];
  conditional_keyword: ConditionalKeywordRow[];
  datasheet: DatasheetRow[];
  datasheet_ability: DatasheetAbilityRow[];
  datasheet_bodyguard_group: DatasheetBodyguardGroupRow[];
  datasheet_bodyguard_group_datasheet: DatasheetBodyguardGroupDatasheetRow[];
  datasheet_bodyguard_group_keyword: DatasheetBodyguardGroupKeywordRow[];
  datasheet_damage: DatasheetDamageRow[];
  datasheet_datasheet_ability: DatasheetDatasheetAbilityRow[];
  datasheet_faction_keyword: DatasheetFactionKeywordRow[];
  datasheet_points_step: DatasheetPointsStepRow[];
  datasheet_rule: DatasheetRuleRow[];
  datasheet_sub_ability: DatasheetSubAbilityRow[];
  detachment: DetachmentRow[];
  detachment_detail: DetachmentDetailRow[];
  detachment_detail_bullet_point: DetachmentDetailBulletPointRow[];
  detachment_excluded_datasheet: DetachmentExcludedDatasheetRow[];
  detachment_faction_detachment_points_cost: DetachmentFactionDetachmentPointsCostRow[];
  detachment_faction_keyword: DetachmentFactionKeywordRow[];
  detachment_force_disposition: DetachmentForceDispositionRow[];
  detachment_granted_warlord_miniature: DetachmentGrantedWarlordMiniatureRow[];
  detachment_linked_datasheet: DetachmentLinkedDatasheetRow[];
  detachment_mandatory_warlord_miniature: DetachmentMandatoryWarlordMiniatureRow[];
  /**
   * @maxItems 0
   */
  detachment_required_datasheet: [];
  detachment_rule: DetachmentRuleRow[];
  detachment_unique_keyword: DetachmentUniqueKeywordRow[];
  enhancement: EnhancementRow[];
  enhancement_bodyguard_group: EnhancementBodyguardGroupRow[];
  enhancement_bodyguard_group_datasheet: EnhancementBodyguardGroupDatasheetRow[];
  /**
   * @maxItems 0
   */
  enhancement_bodyguard_group_keyword: [];
  enhancement_datasheet_ability: EnhancementDatasheetAbilityRow[];
  enhancement_excluded_keyword: EnhancementExcludedKeywordRow[];
  /**
   * @maxItems 0
   */
  enhancement_keyword_points_cost: [];
  enhancement_required_keyword_group: EnhancementRequiredKeywordGroupRow[];
  enhancement_required_keyword_group_faction_keyword: EnhancementRequiredKeywordGroupFactionKeywordRow[];
  enhancement_required_keyword_group_keyword: EnhancementRequiredKeywordGroupKeywordRow[];
  enhancement_required_wargear_item: EnhancementRequiredWargearItemRow[];
  enhancement_wargear_item_profile: EnhancementWargearItemProfileRow[];
  faction_keyword: FactionKeywordRow[];
  faction_keyword_allied_faction: FactionKeywordAlliedFactionRow[];
  faction_keyword_excluded_datasheet: FactionKeywordExcludedDatasheetRow[];
  /**
   * @maxItems 0
   */
  faction_keyword_mandatory_allegiance_ability: [];
  faq: FaqRow[];
  faq_config: FaqConfigRow[];
  force_disposition: ForceDispositionRow[];
  force_disposition_mission: ForceDispositionMissionRow[];
  force_disposition_mission_recommended_preset: ForceDispositionMissionRecommendedPresetRow[];
  invulnerable_save: InvulnerableSaveRow[];
  keyword: KeywordRow[];
  keyword_restriction_group: KeywordRestrictionGroupRow[];
  keyword_restriction_group_keyword: KeywordRestrictionGroupKeywordRow[];
  limited_wargear_choice: LimitedWargearChoiceRow[];
  limited_wargear_choice_set: LimitedWargearChoiceSetRow[];
  limited_wargear_choice_wargear_item: LimitedWargearChoiceWargearItemRow[];
  loadout_choice: LoadoutChoiceRow[];
  loadout_choice_set: LoadoutChoiceSetRow[];
  loadout_choice_wargear_item: LoadoutChoiceWargearItemRow[];
  miniature: MiniatureRow[];
  miniature_keyword: MiniatureKeywordRow[];
  mission_deployment: MissionDeploymentRow[];
  mission_layout: MissionLayoutRow[];
  mission_layout_linked_deployment: MissionLayoutLinkedDeploymentRow[];
  mission_pack: MissionPackRow[];
  /**
   * @maxItems 0
   */
  mission_pack_agenda_achieved: [];
  /**
   * @maxItems 0
   */
  mission_pack_briefing: [];
  /**
   * @maxItems 0
   */
  mission_pack_briefing_narrative_point: [];
  /**
   * @maxItems 0
   */
  mission_pack_location: [];
  /**
   * @maxItems 0
   */
  mission_pack_location_location_bonus: [];
  /**
   * @maxItems 0
   */
  mission_pack_location_warzone_rule: [];
  /**
   * @maxItems 0
   */
  mission_pack_upgrade: [];
  mission_preset: MissionPresetRow[];
  mission_twist: MissionTwistRow[];
  /**
   * @maxItems 0
   */
  objective: [];
  primary_mission: PrimaryMissionRow[];
  primary_mission_action: PrimaryMissionActionRow[];
  primary_mission_objective: PrimaryMissionObjectiveRow[];
  primary_mission_objective_scorable_period: PrimaryMissionObjectiveScorablePeriodRow[];
  primary_mission_objective_scoring: PrimaryMissionObjectiveScoringRow[];
  publication: PublicationRow[];
  restriction_group_detachment_limit: RestrictionGroupDetachmentLimitRow[];
  rule_container: RuleContainerRow[];
  rule_container_component: RuleContainerComponentRow[];
  rule_section: RuleSectionRow[];
  secondary_mission: SecondaryMissionRow[];
  secondary_mission_action: SecondaryMissionActionRow[];
  secondary_mission_objective: SecondaryMissionObjectiveRow[];
  /**
   * @maxItems 0
   */
  secondary_mission_objective_scorable_period: [];
  secondary_mission_objective_scoring: SecondaryMissionObjectiveScoringRow[];
  /**
   * @maxItems 0
   */
  secondary_mission_restricted_secondary_mission: [];
  /**
   * @maxItems 0
   */
  secondary_objective: [];
  stratagem: StratagemRow[];
  stratagem_phase: StratagemPhaseRow[];
  unit_composition: UnitCompositionRow[];
  unit_composition_miniature: UnitCompositionMiniatureRow[];
  unit_composition_required_detachment: UnitCompositionRequiredDetachmentRow[];
  unit_composition_required_faction_keyword: UnitCompositionRequiredFactionKeywordRow[];
  wargear_ability: WargearAbilityRow[];
  wargear_item: WargearItemRow[];
  wargear_item_profile: WargearItemProfileRow[];
  wargear_item_profile_wargear_ability: WargearItemProfileWargearAbilityRow[];
  wargear_limit: WargearLimitRow[];
  wargear_option: WargearOptionRow[];
  wargear_option_group: WargearOptionGroupRow[];
  wargear_rule: WargearRuleRow[];
}
/**
 * Defines one selectable alternative within an all-model wargear choice set.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "AllModelWargearChoiceRow".
 */
export interface AllModelWargearChoiceRow {
  /**
   * Links the choice to the set that contains it.
   */
  allModelWargearChoiceSetId: string;
  /**
   * Identifies this all-model wargear choice.
   */
  id: string;
  /**
   * Indicates whether this choice replaces an existing loadout.
   */
  substitute: boolean;
}
/**
 * Defines a set of wargear choices that applies across a datasheet or a specified miniature.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "AllModelWargearChoiceSetRow".
 */
export interface AllModelWargearChoiceSetRow {
  /**
   * Links the choice set to its owning datasheet.
   */
  datasheetId: string;
  /**
   * Identifies this all-model wargear choice set.
   */
  id: string;
  /**
   * Optionally limits the choice set to a particular miniature.
   */
  miniatureId: null | string;
}
/**
 * Associates an all-model choice with a selectable wargear item and its quantity.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "AllModelWargearChoiceWargearItemRow".
 */
export interface AllModelWargearChoiceWargearItemRow {
  /**
   * Links the association to the choice that includes the wargear item.
   */
  allModelWargearChoiceId: string;
  /**
   * Specifies how many instances of the linked wargear item the choice provides.
   */
  count: number;
  /**
   * Identifies this choice-to-wargear association.
   */
  id: string;
  /**
   * Links the association to a selectable wargear item.
   */
  wargearItemId: string;
}
/**
 * Defines an allegiance ability within an allegiance ability group.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "AllegianceAbilityRow".
 */
export interface AllegianceAbilityRow {
  /**
   * Identifies the allegiance ability group containing this ability.
   */
  allegianceAbilityGroupId: string;
  /**
   * Orders abilities within the allegiance ability group.
   */
  displayOrder: number;
  /**
   * Identifies this allegiance ability.
   */
  id: string;
  /**
   * Maps locale identifiers to localized payloads for this row.
   */
  localisations: {
    [k: string]: AllegianceAbilityLocalisation;
  };
  /**
   * Identifies the optional wargear item required for this ability eligibility.
   */
  requiresWargearItemId: null | string;
}
/**
 * Contains the localized payload observed for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "AllegianceAbilityLocalisation".
 */
export interface AllegianceAbilityLocalisation {
  /**
   * Provides the localized allegiance ability display name.
   */
  name: string;
  /**
   * Carries localized source prose for the allegiance ability.
   */
  rules: string;
}
/**
 * Groups allegiance abilities, optionally within a detachment.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "AllegianceAbilityGroupRow".
 */
export interface AllegianceAbilityGroupRow {
  /**
   * Identifies the optional detachment containing this allegiance ability group.
   */
  detachmentId: null | string;
  /**
   * Identifies this allegiance ability group.
   */
  id: string;
  /**
   * Marks whether the allegiance ability group is mandatory.
   */
  isMandatory: boolean;
  /**
   * Maps locale identifiers to localized payloads for this row.
   */
  localisations: {
    [k: string]: AllegianceAbilityGroupLocalisation;
  };
  /**
   * Sets the optional maximum roster limit for the allegiance ability group.
   */
  maxRosterLimit: null | number;
  /**
   * Sets the optional minimum roster limit for the allegiance ability group.
   */
  minRosterLimit: null | number;
}
/**
 * Contains the localized payload observed for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "AllegianceAbilityGroupLocalisation".
 */
export interface AllegianceAbilityGroupLocalisation {
  /**
   * Provides the localized allegiance ability group display name.
   */
  name: string;
}
/**
 * Defines an allied-faction rule and its construction flags.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "AlliedFactionRow".
 */
export interface AlliedFactionRow {
  /**
   * Indicates whether the allied faction may use enhancements.
   */
  canTakeEnhancements: boolean;
  /**
   * Identifies the allied-faction rule.
   */
  id: string;
  /**
   * Indicates whether its keyword limit is mutually exclusive.
   */
  isMutuallyExclusiveKeywordLimit: boolean;
  /**
   * Indicates whether the allied faction is treated as a sibling faction.
   */
  isSiblingFaction: boolean;
  /**
   * Indicates whether the allied faction replaces a roster faction keyword.
   */
  replacesRosterFactionKeyword: boolean;
  /**
   * Identifies the miniature required as warlord by the allied-faction rule.
   */
  requiredWarlordMiniatureId: null;
}
/**
 * Associates allied-faction rules with datasheets to which they apply.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "AlliedFactionDatasheetRow".
 */
export interface AlliedFactionDatasheetRow {
  /**
   * Identifies the allied-faction rule participating in this association.
   */
  alliedFactionId: string;
  /**
   * Identifies the datasheet participating in this association.
   */
  datasheetId: string;
}
/**
 * Defines a keyword-based eligibility limit for an allied-faction rule.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "AlliedFactionKeywordRow".
 */
export interface AlliedFactionKeywordRow {
  /**
   * Identifies the allied-faction rule constrained by this keyword rule.
   */
  alliedFactionId: string;
  /**
   * Identifies the battle size for which this keyword rule applies.
   */
  battleSizeId: string;
  /**
   * Identifies the allied-faction keyword rule.
   */
  id: string;
  /**
   * Identifies the keyword constrained by this allied-faction rule.
   */
  keywordId: string;
  /**
   * Sets the numeric limit for the keyword rule.
   */
  limitCount: number;
  /**
   * Identifies the miniature required as warlord for the keyword rule.
   */
  requiredWarlordMiniatureId: null;
}
/**
 * Groups donor and receiver keywords for a slotless-keyword eligibility rule.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "AlliedFactionKeywordSlotlessKeywordGroupRow".
 */
export interface AlliedFactionKeywordSlotlessKeywordGroupRow {
  /**
   * Identifies the allied-faction keyword rule that owns this slotless-keyword group.
   */
  alliedFactionKeywordId: string;
  /**
   * Identifies the slotless-keyword group.
   */
  id: string;
}
/**
 * Associates a slotless-keyword group with keywords that donate a slotless keyword.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "AlliedFactionKeywordSlotlessKeywordGroupDonorKeywordRow".
 */
export interface AlliedFactionKeywordSlotlessKeywordGroupDonorKeywordRow {
  /**
   * Identifies the slotless-keyword group participating in this association.
   */
  alliedFactionKeywordSlotlessKeywordGroupId: string;
  /**
   * Identifies the keyword participating in this association.
   */
  keywordId: string;
}
/**
 * Associates a slotless-keyword group with keywords that receive a slotless keyword.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "AlliedFactionKeywordSlotlessKeywordGroupReceiverKeywordRow".
 */
export interface AlliedFactionKeywordSlotlessKeywordGroupReceiverKeywordRow {
  /**
   * Identifies the slotless-keyword group participating in this association.
   */
  alliedFactionKeywordSlotlessKeywordGroupId: string;
  /**
   * Identifies the keyword participating in this association.
   */
  keywordId: string;
}
/**
 * Associates allied-faction rules with parent faction keywords to which they apply.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "AlliedFactionParentFactionKeywordRow".
 */
export interface AlliedFactionParentFactionKeywordRow {
  /**
   * Identifies the allied-faction rule participating in this association.
   */
  alliedFactionId: string;
  /**
   * Identifies the faction keyword participating in this association.
   */
  factionKeywordId: string;
}
/**
 * Sets an allied-faction points limit for each applicable battle size.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "AlliedFactionPointsLimitRow".
 */
export interface AlliedFactionPointsLimitRow {
  /**
   * Identifies the allied-faction rule limited by this row.
   */
  alliedFactionId: string;
  /**
   * Identifies the battle size at which this limit applies.
   */
  battleSizeId: string;
  /**
   * Sets the numeric points limit for the allied-faction rule at the battle size.
   */
  pointsLimit: number;
}
/**
 * Associates allied-faction rules with detachments required for eligibility.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "AlliedFactionRequiredDetachmentRow".
 */
export interface AlliedFactionRequiredDetachmentRow {
  /**
   * Identifies the allied-faction rule participating in this association.
   */
  alliedFactionId: string;
  /**
   * Identifies the detachment participating in this association.
   */
  detachmentId: string;
}
/**
 * Defines a publication-owned army rule.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "ArmyRuleRow".
 */
export interface ArmyRuleRow {
  /**
   * Orders the army rule within its presentation context.
   */
  displayOrder: number;
  /**
   * Marks whether the army rule is hidden from the command-bunker presentation.
   */
  hiddenFromCommandBunker: boolean;
  /**
   * Identifies the army rule.
   */
  id: string;
  /**
   * Groups locale-specific army-rule presentation fields.
   */
  localisations: {
    [k: string]: ArmyRuleLocalisation;
  };
  /**
   * References the publication that owns the army rule.
   */
  publicationId: string;
}
/**
 * Contains one locale-specific army-rule presentation payload.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "ArmyRuleLocalisation".
 */
export interface ArmyRuleLocalisation {
  /**
   * Provides the localized army-rule label.
   */
  name: string;
}
/**
 * Associates army rules with faction keywords excluded from command-bunker eligibility.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "ArmyRuleExcludedFromCommandBunkerFactionKeywordRow".
 */
export interface ArmyRuleExcludedFromCommandBunkerFactionKeywordRow {
  /**
   * References the army rule in the exclusion association.
   */
  armyRuleId: string;
  /**
   * References the faction keyword in the exclusion association.
   */
  factionKeywordId: string;
}
/**
 * Associates army rules with faction keywords to define applicability.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "ArmyRuleFactionKeywordRow".
 */
export interface ArmyRuleFactionKeywordRow {
  /**
   * References the army rule in the applicability association.
   */
  armyRuleId: string;
  /**
   * References the faction keyword in the applicability association.
   */
  factionKeywordId: string;
}
/**
 * Associates a datasheet miniature with its baseline loadout.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "BaseMiniatureLoadoutRow".
 */
export interface BaseMiniatureLoadoutRow {
  /**
   * Links the baseline loadout to its owning datasheet.
   */
  datasheetId: string;
  /**
   * Identifies this baseline loadout record.
   */
  id: string;
  /**
   * Links the baseline loadout to the miniature receiving it.
   */
  miniatureId: string;
}
/**
 * Associates a baseline miniature loadout with one included wargear option.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "BaseMiniatureLoadoutWargearOptionRow".
 */
export interface BaseMiniatureLoadoutWargearOptionRow {
  /**
   * Links the association to the baseline loadout containing the option.
   */
  baseMiniatureLoadoutId: string;
  /**
   * Specifies how many instances of the linked option are included.
   */
  count: number;
  /**
   * Identifies this baseline-loadout option association.
   */
  id: string;
  /**
   * Links the association to an included wargear option.
   */
  wargearOptionId: string;
}
/**
 * Defines a roster-scale configuration and its numeric limits.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "BattleSizeRow".
 */
export interface BattleSizeRow {
  /**
   * Sets the detachment points limit for the configuration.
   */
  detachmentPointsLimit: number;
  /**
   * Sets the duplicate-unit limit for the configuration.
   */
  duplicateUnitLimit: number;
  /**
   * Sets the enhancement limit for the configuration.
   */
  enhancementLimit: number;
  /**
   * Identifies the battle-size configuration.
   */
  id: string;
  /**
   * Groups locale-specific battle-size presentation fields.
   */
  localisations: {
    [k: string]: BattleSizeLocalisation;
  };
  /**
   * Sets the total points limit for the configuration.
   */
  pointsLimit: number;
}
/**
 * Contains one locale-specific battle-size presentation payload.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "BattleSizeLocalisation".
 */
export interface BattleSizeLocalisation {
  /**
   * Provides the localized battle-size label.
   */
  name: string;
}
/**
 * Defines reusable structured behaviour parameters for rules.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "BehaviourTypeRow".
 */
export interface BehaviourTypeRow {
  /**
   * Identifies the behaviour definition.
   */
  id: string;
  /**
   * Groups locale-specific behaviour presentation fields.
   */
  localisations: {
    [k: string]: BehaviourTypeLocalisation;
  };
  /**
   * Classifies the behaviour definition variant.
   */
  type: string;
}
/**
 * Contains one locale-specific behaviour presentation payload.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "BehaviourTypeLocalisation".
 */
export interface BehaviourTypeLocalisation {
  /**
   * Provides localized after-fighting timing text.
   */
  afterFighting: null;
  /**
   * Provides localized after-moving timing text.
   */
  afterMoving: null | string;
  /**
   * Provides localized after-shooting timing text.
   */
  afterShooting: null | string;
  /**
   * Provides localized before-fighting timing text.
   */
  beforeFighting: null;
  /**
   * Provides localized before-moving timing text.
   */
  beforeMoving: null | string;
  /**
   * Provides localized before-shooting timing text.
   */
  beforeShooting: null;
  /**
   * Provides localized behaviour effect text.
   */
  effect: string;
  /**
   * Provides localized behaviour eligibility text.
   */
  eligibleIf: string;
  /**
   * Provides localized maximum-distance parameter text.
   */
  maximumDistance: null | string;
  /**
   * Provides the localized behaviour label.
   */
  name: string;
  /**
   * Provides localized rule-reference text for the behaviour.
   */
  ruleReference: string;
  /**
   * Provides localized setup-distance parameter text.
   */
  setupDistance: null | string;
  /**
   * Provides localized while-fighting timing text.
   */
  whileFighting: null;
  /**
   * Provides localized while-moving timing text.
   */
  whileMoving: null | string;
  /**
   * Provides localized while-shooting timing text.
   */
  whileShooting: null | string;
}
/**
 * Stores ordered bullet entries attached to a rule container component.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "BulletPointRow".
 */
export interface BulletPointRow {
  /**
   * Orders bullet entries within their component.
   */
  displayOrder: number;
  /**
   * Identifies the bullet entry row.
   */
  id: string;
  /**
   * Records the visual nesting level of the bullet entry.
   */
  indent: number;
  /**
   * Maps locale identifiers to bullet payloads.
   */
  localisations: {
    [k: string]: BulletPointLocalisation;
  };
  /**
   * References the rule container component that owns the bullet entry.
   */
  ruleContainerComponentId: string;
}
/**
 * Contains the bullet payload for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "BulletPointLocalisation".
 */
export interface BulletPointLocalisation {
  /**
   * Carries localized bullet rules or explanatory prose.
   */
  text: string;
}
/**
 * Defines a datasheet keyword whose availability depends on roster conditions.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "ConditionalKeywordRow".
 */
export interface ConditionalKeywordRow {
  /**
   * References the datasheet receiving the conditional keyword.
   */
  datasheetId: string;
  /**
   * Identifies the conditional keyword record.
   */
  id: string;
  /**
   * References the keyword made conditionally available.
   */
  keywordId: string;
  /**
   * References an allegiance-ability requirement when configured.
   */
  requiredAllegianceAbilityId: null | string;
  /**
   * References a detachment requirement when configured.
   */
  requiredDetachmentId: null | string;
  /**
   * References a roster faction-keyword requirement when configured.
   */
  requiredRosterFactionKeywordId: null | string;
  /**
   * References a warlord miniature requirement when configured.
   */
  requiredWarlordMiniatureId: null | string;
}
/**
 * Defines a unit datasheet and its publication-owned source record.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DatasheetRow".
 */
export interface DatasheetRow {
  /**
   * Optionally identifies the allegiance ability group associated with this datasheet.
   */
  allegianceAbilityGroupId: null | string;
  /**
   * References banner artwork associated with the datasheet.
   */
  bannerImage: string;
  /**
   * Orders the datasheet within source presentation.
   */
  displayOrder: number;
  /**
   * Identifies this datasheet.
   */
  id: string;
  /**
   * Indicates whether the datasheet bypasses entitlement gating.
   */
  isFreeFromEntitlements: boolean;
  /**
   * Indicates whether the datasheet is categorized as Legends content.
   */
  isLegends: boolean;
  /**
   * Indicates whether the datasheet is categorized for successor chapters.
   */
  isSuccessorChapter: boolean;
  /**
   * Maps locale codes to datasheet presentation payloads.
   */
  localisations: {
    [k: string]: DatasheetLocalisation;
  };
  /**
   * Optionally records an upper model-count constraint.
   */
  maxModelCount: null | number;
  /**
   * Identifies the publication that owns this datasheet.
   */
  publicationId: string;
  /**
   * References row artwork associated with the datasheet.
   */
  rowImage: string;
}
/**
 * Contains one locale-specific datasheet presentation payload.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DatasheetLocalisation".
 */
export interface DatasheetLocalisation {
  /**
   * Describes the categorical base or hull presentation for the datasheet.
   */
  baseSize: null | string;
  /**
   * Contains localized background prose for the datasheet.
   */
  lore: null | string;
  /**
   * Contains the localized datasheet display name.
   */
  name: string;
  /**
   * Contains localized unit-composition prose.
   */
  unitComposition: string;
}
/**
 * Defines a reusable ability record that can be associated with datasheets and rule records.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DatasheetAbilityRow".
 */
export interface DatasheetAbilityRow {
  /**
   * Classifies the mechanical kind of the ability.
   */
  abilityType: string;
  /**
   * References the army-rule record associated with this ability.
   */
  armyRuleId: null | string;
  /**
   * References the detachment-rule record associated with this ability.
   */
  detachmentRuleId: null | string;
  /**
   * Identifies this ability record.
   */
  id: string;
  /**
   * Indicates whether the ability has aura behavior.
   */
  isAura: boolean;
  /**
   * Indicates whether the ability has bondsman behavior.
   */
  isBondsman: boolean;
  /**
   * Indicates whether the ability has pain-related behavior.
   */
  isPain: boolean;
  /**
   * Indicates whether the ability has psychic behavior.
   */
  isPsychic: boolean;
  /**
   * Maps locale identifiers to localized ability payloads.
   */
  localisations: {
    [k: string]: DatasheetAbilityLocalisation;
  };
}
/**
 * Contains the localized payload for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DatasheetAbilityLocalisation".
 */
export interface DatasheetAbilityLocalisation {
  /**
   * Contains localized background prose for the ability.
   */
  lore: null | string;
  /**
   * Provides the localized display name of the ability.
   */
  name: string;
  /**
   * Contains localized rules prose for the ability.
   */
  rules: string;
  /**
   * Provides the localized display heading for subordinate abilities.
   */
  subAbilityHeader: null | string;
}
/**
 * Defines an eligibility group linking a leader datasheet to permitted bodyguards and restrictions.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DatasheetBodyguardGroupRow".
 */
export interface DatasheetBodyguardGroupRow {
  /**
   * Classifies the bodyguard eligibility group.
   */
  bodyguardType: string;
  /**
   * Identifies the leader datasheet for this eligibility group.
   */
  datasheetId: string;
  /**
   * Optionally identifies a detachment excluded from this eligibility group.
   */
  excludedDetachmentId: null | string;
  /**
   * Reserves an optional faction-keyword restriction for this eligibility group.
   */
  factionKeywordId: null;
  /**
   * Identifies this bodyguard eligibility group.
   */
  id: string;
  /**
   * Optionally identifies a detachment required by this eligibility group.
   */
  requiredDetachmentId: null | string;
  /**
   * Optionally identifies a keyword every participating unit must have.
   */
  requiresAllUnitsHaveKeywordId: null | string;
}
/**
 * Connects a bodyguard eligibility group to a permitted datasheet.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DatasheetBodyguardGroupDatasheetRow".
 */
export interface DatasheetBodyguardGroupDatasheetRow {
  /**
   * Identifies the bodyguard eligibility group.
   */
  datasheetBodyguardGroupId: string;
  /**
   * Identifies a datasheet permitted by the eligibility group.
   */
  datasheetId: string;
}
/**
 * Connects a bodyguard eligibility group to a required keyword.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DatasheetBodyguardGroupKeywordRow".
 */
export interface DatasheetBodyguardGroupKeywordRow {
  /**
   * Identifies the bodyguard eligibility group.
   */
  datasheetBodyguardGroupId: string;
  /**
   * Identifies a keyword required by the eligibility group.
   */
  keywordId: string;
}
/**
 * Associates damage-state presentation with a datasheet.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DatasheetDamageRow".
 */
export interface DatasheetDamageRow {
  /**
   * Reserves the threshold at which this damage state applies.
   */
  damagedAt: null;
  /**
   * Identifies the datasheet receiving this damage state.
   */
  datasheetId: string;
  /**
   * Orders the damage state within source presentation.
   */
  displayOrder: number;
  /**
   * Identifies this datasheet damage row.
   */
  id: string;
  /**
   * Maps locale codes to damage-state presentation payloads.
   */
  localisations: {
    [k: string]: DatasheetDamageLocalisation;
  };
}
/**
 * Contains one locale-specific damage-state presentation payload.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DatasheetDamageLocalisation".
 */
export interface DatasheetDamageLocalisation {
  /**
   * Contains the localized damage-state display name.
   */
  name: string;
  /**
   * Contains localized damage-state rule prose.
   */
  rules: string;
}
/**
 * Associates a datasheet with an ability that applies to it.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DatasheetDatasheetAbilityRow".
 */
export interface DatasheetDatasheetAbilityRow {
  /**
   * References the ability that applies through this association.
   */
  datasheetAbilityId: string;
  /**
   * References the datasheet to which the ability applies.
   */
  datasheetId: string;
  /**
   * Orders this ability within the datasheet presentation.
   */
  displayOrder: number;
  /**
   * Identifies this datasheet-ability association.
   */
  id: string;
  /**
   * Maps locale identifiers to localized association payloads.
   */
  localisations: {
    [k: string]: DatasheetDatasheetAbilityLocalisation;
  };
}
/**
 * Contains the localized payload for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DatasheetDatasheetAbilityLocalisation".
 */
export interface DatasheetDatasheetAbilityLocalisation {
  /**
   * Contains localized prose describing the association restriction.
   */
  restriction: null | string;
}
/**
 * Associates a datasheet with a faction keyword for applicability.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DatasheetFactionKeywordRow".
 */
export interface DatasheetFactionKeywordRow {
  /**
   * Identifies the datasheet to which this faction applicability applies.
   */
  datasheetId: string;
  /**
   * Orders the association within source presentation.
   */
  displayOrder: number;
  /**
   * Identifies the applicable faction keyword.
   */
  factionKeywordId: string;
  /**
   * Identifies this datasheet-faction applicability row.
   */
  id: string;
}
/**
 * Associates a model-count point step with a datasheet.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DatasheetPointsStepRow".
 */
export interface DatasheetPointsStepRow {
  /**
   * Identifies the datasheet receiving this points step.
   */
  datasheetId: string;
  /**
   * Identifies this datasheet points-step row.
   */
  id: string;
  /**
   * Records the model-count threshold for the step.
   */
  stepAt: number;
  /**
   * Records the points value at the step.
   */
  stepPoints: number;
}
/**
 * Associates a localized rule record with a datasheet.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DatasheetRuleRow".
 */
export interface DatasheetRuleRow {
  /**
   * Identifies the datasheet receiving this rule.
   */
  datasheetId: string;
  /**
   * Orders the rule within source presentation.
   */
  displayOrder: number;
  /**
   * Identifies this datasheet rule row.
   */
  id: string;
  /**
   * Optionally references artwork associated with the rule.
   */
  image: null | string;
  /**
   * Maps locale codes to rule presentation payloads.
   */
  localisations: {
    [k: string]: DatasheetRuleLocalisation;
  };
}
/**
 * Contains one locale-specific rule presentation payload.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DatasheetRuleLocalisation".
 */
export interface DatasheetRuleLocalisation {
  /**
   * Contains the localized rule display name.
   */
  name: string;
  /**
   * Contains localized rule prose.
   */
  rules: string;
}
/**
 * Defines an ordered subordinate ability associated with a parent datasheet ability.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DatasheetSubAbilityRow".
 */
export interface DatasheetSubAbilityRow {
  /**
   * References the parent datasheet ability.
   */
  datasheetAbilityId: string;
  /**
   * Orders subordinate abilities within their parent ability.
   */
  displayOrder: number;
  /**
   * Identifies this subordinate ability record.
   */
  id: string;
  /**
   * Maps locale identifiers to localized subordinate-ability payloads.
   */
  localisations: {
    [k: string]: DatasheetSubAbilityLocalisation;
  };
}
/**
 * Contains the localized payload for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DatasheetSubAbilityLocalisation".
 */
export interface DatasheetSubAbilityLocalisation {
  /**
   * Provides the localized display name of the subordinate ability.
   */
  name: string;
  /**
   * Contains localized rules prose for the subordinate ability.
   */
  rules: string;
}
/**
 * Defines a detachment available from an owning publication.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DetachmentRow".
 */
export interface DetachmentRow {
  /**
   * References a detachment banner artwork asset that is not publishable entity data.
   */
  bannerImage: string;
  /**
   * Sets the base point cost for selecting the detachment.
   */
  detachmentPointsCost: number;
  /**
   * Orders detachments for presentation within their source context.
   */
  displayOrder: number;
  /**
   * Identifies this detachment.
   */
  id: string;
  /**
   * Marks whether the detachment is for the Combat Patrol mode.
   */
  isCombatPatrol: boolean;
  /**
   * Marks whether entitlement restrictions are waived for the detachment.
   */
  isFreeFromEntitlements: boolean;
  /**
   * Maps locale identifiers to localized payloads for this row.
   */
  localisations: {
    [k: string]: DetachmentLocalisation;
  };
  /**
   * Provides an alternate point-cost representation.
   */
  pointsCost: null;
  /**
   * Links the detachment to its owning publication.
   */
  publicationId: string;
  /**
   * References a detachment row artwork asset that is not publishable entity data.
   */
  rowImage: string;
}
/**
 * Contains the localized payload observed for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DetachmentLocalisation".
 */
export interface DetachmentLocalisation {
  /**
   * Provides the localized detachment display name.
   */
  name: string;
}
/**
 * Defines a titled detachment detail section.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DetachmentDetailRow".
 */
export interface DetachmentDetailRow {
  /**
   * Identifies the detachment that contains this detail section.
   */
  detachmentId: string;
  /**
   * Orders detail sections within the detachment.
   */
  displayOrder: number;
  /**
   * Identifies this detachment detail section.
   */
  id: string;
  /**
   * Maps locale identifiers to localized payloads for this row.
   */
  localisations: {
    [k: string]: DetachmentDetailLocalisation;
  };
}
/**
 * Contains the localized payload observed for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DetachmentDetailLocalisation".
 */
export interface DetachmentDetailLocalisation {
  /**
   * Provides the localized detail-section display title.
   */
  title: string;
}
/**
 * Defines an ordered prose bullet within a detachment detail section.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DetachmentDetailBulletPointRow".
 */
export interface DetachmentDetailBulletPointRow {
  /**
   * Identifies the detachment detail section containing this bullet.
   */
  detachmentDetailId: string;
  /**
   * Orders bullets within the detachment detail section.
   */
  displayOrder: number;
  /**
   * Identifies this detachment detail bullet.
   */
  id: string;
  /**
   * Maps locale identifiers to localized payloads for this row.
   */
  localisations: {
    [k: string]: DetachmentDetailBulletPointLocalisation;
  };
}
/**
 * Contains the localized payload observed for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DetachmentDetailBulletPointLocalisation".
 */
export interface DetachmentDetailBulletPointLocalisation {
  /**
   * Carries localized source prose for this detail bullet.
   */
  text: string;
}
/**
 * Records a datasheet excluded from detachment eligibility.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DetachmentExcludedDatasheetRow".
 */
export interface DetachmentExcludedDatasheetRow {
  /**
   * Identifies the datasheet excluded by this detachment eligibility rule.
   */
  datasheetId: string;
  /**
   * Identifies the detachment imposing this datasheet eligibility exclusion.
   */
  detachmentId: string;
}
/**
 * Associates a faction context with an overriding detachment point cost.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DetachmentFactionDetachmentPointsCostRow".
 */
export interface DetachmentFactionDetachmentPointsCostRow {
  /**
   * Identifies the detachment whose point cost is overridden.
   */
  detachmentId: string;
  /**
   * Sets the point cost for this detachment and faction association.
   */
  detachmentPointsCost: number;
  /**
   * Identifies the faction context for this detachment point-cost association.
   */
  factionKeywordId: string;
}
/**
 * Associates a detachment with a faction keyword to which it applies.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DetachmentFactionKeywordRow".
 */
export interface DetachmentFactionKeywordRow {
  /**
   * Identifies the detachment in this applicability association.
   */
  detachmentId: string;
  /**
   * Identifies the faction keyword to which the detachment applies.
   */
  factionKeywordId: string;
}
/**
 * Associates a detachment with an available force disposition.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DetachmentForceDispositionRow".
 */
export interface DetachmentForceDispositionRow {
  /**
   * Identifies the detachment in this force-disposition association.
   */
  detachmentId: string;
  /**
   * Identifies the force disposition associated with the detachment.
   */
  forceDispositionId: string;
}
/**
 * Associates a detachment with a miniature granted warlord eligibility.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DetachmentGrantedWarlordMiniatureRow".
 */
export interface DetachmentGrantedWarlordMiniatureRow {
  /**
   * Identifies the detachment granting this warlord eligibility.
   */
  detachmentId: string;
  /**
   * Identifies the miniature granted warlord eligibility by the detachment.
   */
  miniatureId: string;
}
/**
 * Associates a detachment with a datasheet and its linked selection conditions.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DetachmentLinkedDatasheetRow".
 */
export interface DetachmentLinkedDatasheetRow {
  /**
   * Sets the linked datasheet count associated with the detachment.
   */
  count: number;
  /**
   * Identifies the datasheet linked for detachment eligibility.
   */
  datasheetId: string;
  /**
   * Identifies the detachment with this linked datasheet eligibility condition.
   */
  detachmentId: string;
  /**
   * Marks whether the linked datasheet condition concerns a warlord.
   */
  isWarlord: boolean;
}
/**
 * Associates a detachment with a miniature that is mandatory for warlord eligibility.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DetachmentMandatoryWarlordMiniatureRow".
 */
export interface DetachmentMandatoryWarlordMiniatureRow {
  /**
   * Identifies the detachment imposing this warlord eligibility requirement.
   */
  detachmentId: string;
  /**
   * Identifies the miniature required by this detachment warlord eligibility rule.
   */
  miniatureId: string;
}
/**
 * Defines a named rule associated with a detachment.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DetachmentRuleRow".
 */
export interface DetachmentRuleRow {
  /**
   * Identifies the detachment associated with this rule.
   */
  detachmentId: string;
  /**
   * Orders rules within the detachment.
   */
  displayOrder: number;
  /**
   * Marks whether the rule is hidden in the command-bunker presentation.
   */
  hiddenFromCommandBunker: boolean;
  /**
   * Identifies this detachment rule.
   */
  id: string;
  /**
   * Maps locale identifiers to localized payloads for this row.
   */
  localisations: {
    [k: string]: DetachmentRuleLocalisation;
  };
}
/**
 * Contains the localized payload observed for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DetachmentRuleLocalisation".
 */
export interface DetachmentRuleLocalisation {
  /**
   * Provides the localized rule display name.
   */
  name: string;
}
/**
 * Associates a detachment with a keyword used for its uniqueness restriction.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "DetachmentUniqueKeywordRow".
 */
export interface DetachmentUniqueKeywordRow {
  /**
   * Identifies the detachment imposing the uniqueness restriction.
   */
  detachmentId: string;
  /**
   * Identifies the keyword subject to the detachment uniqueness restriction.
   */
  keywordId: string;
}
/**
 * Defines an enhancement and its configuration, detachment association, publication source, and localized presentation.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "EnhancementRow".
 */
export interface EnhancementRow {
  /**
   * Stores the base points cost applied by the enhancement.
   */
  basePointsCost: null | number;
  /**
   * Indicates whether the enhancement prevents its bearer from being a warlord.
   */
  cannotBeWarlord: boolean;
  /**
   * References the detachment context in which the enhancement is available.
   */
  detachmentId: string;
  /**
   * Stores the ordering position used when presenting the enhancement.
   */
  displayOrder: number;
  /**
   * Classifies the enhancement variant for rule handling.
   */
  enhancementType: string;
  /**
   * Uniquely identifies the enhancement.
   */
  id: string;
  /**
   * Indicates whether the enhancement is available in the Combat Patrol context.
   */
  isCombatPatrol: boolean;
  /**
   * Indicates whether the enhancement is the default selection in the Combat Patrol context.
   */
  isCombatPatrolDefault: boolean;
  /**
   * Indicates whether an Epic Hero bearer is eligible to receive the enhancement.
   */
  isEquipableByEpicHero: boolean;
  /**
   * Indicates whether a non-Character unit bearer is eligible to receive the enhancement.
   */
  isEquipableByNonCharacterUnit: boolean;
  /**
   * Indicates whether the enhancement contributes to the applicable enhancement limit.
   */
  isIncludedInEnhancementLimit: boolean;
  /**
   * Stores the maximum permitted selections of the enhancement.
   */
  limit: number;
  /**
   * Maps locale identifiers to localized enhancement presentation payloads.
   */
  localisations: {
    [k: string]: EnhancementLocalisation;
  };
  /**
   * References the publication that owns the enhancement record.
   */
  publicationId: string;
}
/**
 * Contains one locale-specific enhancement presentation payload.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "EnhancementLocalisation".
 */
export interface EnhancementLocalisation {
  /**
   * Contains localized descriptive lore for the enhancement.
   */
  lore: string;
  /**
   * Provides the localized display name of the enhancement.
   */
  name: string;
  /**
   * Contains localized rules prose for the enhancement.
   */
  rules: string;
}
/**
 * Defines a bodyguard-based eligibility condition for receiving an enhancement.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "EnhancementBodyguardGroupRow".
 */
export interface EnhancementBodyguardGroupRow {
  /**
   * Specifies the bodyguard condition mode used to evaluate eligibility.
   */
  bodyguardType: string;
  /**
   * References the enhancement whose bearer eligibility this bodyguard condition constrains.
   */
  enhancementId: string;
  /**
   * Optionally references a faction keyword used to further scope the bodyguard eligibility condition.
   */
  factionKeywordId: null;
  /**
   * Uniquely identifies the bodyguard eligibility condition.
   */
  id: string;
}
/**
 * Associates a bodyguard eligibility condition with datasheets that satisfy its enhancement constraint.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "EnhancementBodyguardGroupDatasheetRow".
 */
export interface EnhancementBodyguardGroupDatasheetRow {
  /**
   * References a datasheet admitted by the bodyguard eligibility condition.
   */
  datasheetId: string;
  /**
   * References the bodyguard eligibility condition being satisfied by the datasheet.
   */
  enhancementBodyguardGroupId: string;
}
/**
 * Associates enhancements with datasheet abilities relevant to their application.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "EnhancementDatasheetAbilityRow".
 */
export interface EnhancementDatasheetAbilityRow {
  /**
   * References the datasheet ability associated with the enhancement.
   */
  datasheetAbilityId: string;
  /**
   * References the enhancement associated with the datasheet ability.
   */
  enhancementId: string;
}
/**
 * Associates enhancements with keywords that exclude a bearer from eligibility.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "EnhancementExcludedKeywordRow".
 */
export interface EnhancementExcludedKeywordRow {
  /**
   * References the enhancement whose bearer eligibility is restricted.
   */
  enhancementId: string;
  /**
   * References the keyword that excludes a bearer from the enhancement.
   */
  keywordId: string;
}
/**
 * Defines a group of keyword or datasheet conditions required for enhancement eligibility.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "EnhancementRequiredKeywordGroupRow".
 */
export interface EnhancementRequiredKeywordGroupRow {
  /**
   * Optionally references a datasheet that satisfies the enhancement eligibility group.
   */
  datasheetId: null | string;
  /**
   * References the enhancement whose eligibility is constrained by the group.
   */
  enhancementId: string;
  /**
   * Uniquely identifies the enhancement eligibility group.
   */
  id: string;
}
/**
 * Associates an enhancement eligibility group with required faction keywords.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "EnhancementRequiredKeywordGroupFactionKeywordRow".
 */
export interface EnhancementRequiredKeywordGroupFactionKeywordRow {
  /**
   * References the enhancement eligibility group requiring a faction keyword.
   */
  enhancementRequiredKeywordGroupId: string;
  /**
   * References a faction keyword required by the enhancement eligibility group.
   */
  factionKeywordId: string;
}
/**
 * Associates an enhancement eligibility group with required keywords.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "EnhancementRequiredKeywordGroupKeywordRow".
 */
export interface EnhancementRequiredKeywordGroupKeywordRow {
  /**
   * References the enhancement eligibility group requiring a keyword.
   */
  enhancementRequiredKeywordGroupId: string;
  /**
   * References a keyword required by the enhancement eligibility group.
   */
  keywordId: string;
}
/**
 * Associates an enhancement with a wargear item required for bearer eligibility.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "EnhancementRequiredWargearItemRow".
 */
export interface EnhancementRequiredWargearItemRow {
  /**
   * References the enhancement whose bearer eligibility requires a wargear item.
   */
  enhancementId: string;
  /**
   * References the wargear item required for the enhancement.
   */
  wargearItemId: string;
}
/**
 * Associates an enhancement with a wargear-item profile affected by its application.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "EnhancementWargearItemProfileRow".
 */
export interface EnhancementWargearItemProfileRow {
  /**
   * References the enhancement associated with the wargear-item profile.
   */
  enhancementId: string;
  /**
   * References the wargear-item profile associated with the enhancement.
   */
  wargearItemProfileId: string;
}
/**
 * Defines a faction keyword and its hierarchy and presentation metadata.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "FactionKeywordRow".
 */
export interface FactionKeywordRow {
  /**
   * References artwork used when selecting the faction for an army.
   */
  armySelectionImage: string;
  /**
   * Indicates whether the faction keyword is excluded from army construction.
   */
  excludedFromArmyBuilder: boolean;
  /**
   * Identifies the faction keyword.
   */
  id: string;
  /**
   * Maps locale codes to translated payloads.
   */
  localisations: {
    [k: string]: FactionKeywordLocalisation;
  };
  /**
   * Identifies the miniature required as a warlord by the faction keyword.
   */
  mandatoryWarlordId: null;
  /**
   * References artwork used for supplementary faction information.
   */
  moreInfoImage: string;
  /**
   * Identifies the parent faction keyword in the faction hierarchy.
   */
  parentFactionKeywordId: null | string;
  /**
   * References artwork used for faction presentation in a roster.
   */
  rosterFactionImage: string;
  /**
   * References artwork used for the faction roster header.
   */
  rosterHeaderImage: string;
}
/**
 * Contains one localized payload selected by locale code.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "FactionKeywordLocalisation".
 */
export interface FactionKeywordLocalisation {
  /**
   * Provides an optional shorter display label for the faction keyword.
   */
  commonName: null | string;
  /**
   * Provides localized descriptive lore for the faction keyword.
   */
  lore: string;
  /**
   * Provides the localized display name for the faction keyword.
   */
  name: string;
}
/**
 * Associates faction keywords with permitted allied-faction rules.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "FactionKeywordAlliedFactionRow".
 */
export interface FactionKeywordAlliedFactionRow {
  /**
   * Identifies the allied-faction rule participating in this association.
   */
  alliedFactionId: string;
  /**
   * Identifies the faction keyword participating in this association.
   */
  factionKeywordId: string;
}
/**
 * Associates faction keywords with datasheets excluded from that faction context.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "FactionKeywordExcludedDatasheetRow".
 */
export interface FactionKeywordExcludedDatasheetRow {
  /**
   * Identifies the datasheet participating in this association.
   */
  datasheetId: string;
  /**
   * Identifies the faction keyword participating in this association.
   */
  factionKeywordId: string;
}
/**
 * Defines a publication-owned frequently asked question or erratum entry.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "FaqRow".
 */
export interface FaqRow {
  /**
   * Orders the FAQ entry within its publication presentation.
   */
  displayOrder: number;
  /**
   * Identifies the FAQ entry.
   */
  id: string;
  /**
   * Groups locale-specific FAQ presentation fields.
   */
  localisations: {
    [k: string]: FaqLocalisation;
  };
  /**
   * References the publication that owns the FAQ entry.
   */
  publicationId: string;
}
/**
 * Contains one locale-specific FAQ presentation payload.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "FaqLocalisation".
 */
export interface FaqLocalisation {
  /**
   * Provides localized FAQ answer text.
   */
  answer: null | string;
  /**
   * Provides localized erratum heading text.
   */
  errataHeader: null | string;
  /**
   * Provides localized erratum text.
   */
  errataText: null | string;
  /**
   * Provides localized FAQ question text.
   */
  question: null | string;
}
/**
 * Configures the structured scopes in which a publication FAQ applies.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "FaqConfigRow".
 */
export interface FaqConfigRow {
  /**
   * References the army-rule scope when configured.
   */
  armyRuleId: null | string;
  /**
   * References the datasheet scope when configured.
   */
  datasheetId: null | string;
  /**
   * References the detachment scope when configured.
   */
  detachmentId: null | string;
  /**
   * References the enhancement scope when configured.
   */
  enhancementId: null | string;
  /**
   * References the FAQ configured for the scope.
   */
  faqId: string;
  /**
   * Identifies the FAQ configuration.
   */
  id: string;
  /**
   * References the publication that owns the FAQ configuration.
   */
  publicationId: string;
  /**
   * References the rule-container scope when configured.
   */
  ruleContainerId: null | string;
  /**
   * References the stratagem scope when configured.
   */
  stratagemId: null | string;
}
/**
 * Defines a force disposition usable on either side of a mission matchup.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "ForceDispositionRow".
 */
export interface ForceDispositionRow {
  /**
   * Identifies this force disposition.
   */
  id: string;
  /**
   * Maps locale identifiers to localized force-disposition payloads.
   */
  localisations: {
    [k: string]: ForceDispositionLocalisation;
  };
}
/**
 * Contains the localized payload for one force-disposition locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "ForceDispositionLocalisation".
 */
export interface ForceDispositionLocalisation {
  /**
   * Provides the localized display label for the force disposition.
   */
  name: string;
}
/**
 * Defines a primary-mission matchup between friendly and opposition force dispositions.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "ForceDispositionMissionRow".
 */
export interface ForceDispositionMissionRow {
  /**
   * Identifies the force disposition applicable to the friendly side of this matchup.
   */
  friendlyForceDispositionId: string;
  /**
   * Identifies this force-disposition mission matchup.
   */
  id: string;
  /**
   * Identifies the force disposition applicable to the opposition side of this matchup.
   */
  oppositionForceDispositionId: string;
  /**
   * Identifies the primary mission applicable to this disposition matchup.
   */
  primaryMissionId: string;
}
/**
 * Associates recommended mission presets with force-disposition mission matchups.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "ForceDispositionMissionRecommendedPresetRow".
 */
export interface ForceDispositionMissionRecommendedPresetRow {
  /**
   * Identifies the disposition mission matchup for which a preset is recommended.
   */
  forceDispositionMissionId: string;
  /**
   * Identifies the mission preset recommended for the disposition matchup.
   */
  missionPresetId: string;
}
/**
 * Associates invulnerable-save characteristics with a datasheet and optionally a model profile.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "InvulnerableSaveRow".
 */
export interface InvulnerableSaveRow {
  /**
   * Identifies the datasheet receiving this invulnerable-save record.
   */
  datasheetId: string;
  /**
   * Identifies this invulnerable-save row.
   */
  id: string;
  /**
   * Maps locale codes to invulnerable-save presentation payloads.
   */
  localisations: {
    [k: string]: InvulnerableSaveLocalisation;
  };
  /**
   * Optionally records the invulnerable save applying in melee.
   */
  meleeSave: null | string;
  /**
   * Optionally identifies the model profile receiving this invulnerable save.
   */
  miniatureId: null | string;
  /**
   * Optionally records the invulnerable save applying at range.
   */
  rangedSave: null | string;
  /**
   * Optionally records the general invulnerable save.
   */
  save: null | string;
}
/**
 * Contains one locale-specific invulnerable-save presentation payload.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "InvulnerableSaveLocalisation".
 */
export interface InvulnerableSaveLocalisation {
  /**
   * Contains localized invulnerable-save rule prose.
   */
  rules: null | string;
}
/**
 * Defines a keyword available to faction and datasheet rules.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "KeywordRow".
 */
export interface KeywordRow {
  /**
   * Identifies the faction keyword that limits this keyword in allied use.
   */
  allyRestrictingFactionKeywordId: null | string;
  /**
   * Identifies the keyword that limits this keyword in allied use.
   */
  allyRestrictingKeywordId: null | string;
  /**
   * Identifies the keyword.
   */
  id: string;
  /**
   * Maps locale codes to translated payloads.
   */
  localisations: {
    [k: string]: KeywordLocalisation;
  };
}
/**
 * Contains one localized payload selected by locale code.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "KeywordLocalisation".
 */
export interface KeywordLocalisation {
  /**
   * Provides the localized display name for the keyword.
   */
  name: string;
}
/**
 * Defines a faction-scoped keyword restriction with optional exclusion, limit, and warlord requirements.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "KeywordRestrictionGroupRow".
 */
export interface KeywordRestrictionGroupRow {
  /**
   * Optionally identifies a faction keyword excluded by this restriction.
   */
  excludedFactionKeywordId: null | string;
  /**
   * Identifies the faction keyword to which this restriction applies.
   */
  factionKeywordId: string;
  /**
   * Identifies this keyword restriction group.
   */
  id: string;
  /**
   * Provides the numeric limit imposed by this restriction when present.
   */
  limit: null | number;
  /**
   * Optionally identifies the warlord miniature required by this restriction.
   */
  requiresWarlordMiniatureId: null;
}
/**
 * Associates keyword requirements with keyword restriction groups.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "KeywordRestrictionGroupKeywordRow".
 */
export interface KeywordRestrictionGroupKeywordRow {
  /**
   * Identifies a keyword required or restricted by the group association.
   */
  keywordId: string;
  /**
   * Identifies the restriction group carrying this keyword association.
   */
  keywordRestrictionGroupId: string;
}
/**
 * Defines one selectable alternative within a limited wargear choice set.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "LimitedWargearChoiceRow".
 */
export interface LimitedWargearChoiceRow {
  /**
   * Identifies this limited wargear choice.
   */
  id: string;
  /**
   * Links the choice to the set that contains it.
   */
  limitedWargearChoiceSetId: string;
}
/**
 * Defines a limited wargear-choice set for a datasheet or specified miniature.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "LimitedWargearChoiceSetRow".
 */
export interface LimitedWargearChoiceSetRow {
  /**
   * Links the choice set to its owning datasheet.
   */
  datasheetId: string;
  /**
   * Identifies this limited wargear choice set.
   */
  id: string;
  /**
   * Indicates whether a choice from this set is required.
   */
  mandatory: boolean;
  /**
   * Optionally limits the choice set to a particular miniature.
   */
  miniatureId: null | string;
}
/**
 * Associates a limited choice with a selectable wargear item and its quantity.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "LimitedWargearChoiceWargearItemRow".
 */
export interface LimitedWargearChoiceWargearItemRow {
  /**
   * Specifies how many instances of the linked wargear item the choice provides.
   */
  count: number;
  /**
   * Identifies this choice-to-wargear association.
   */
  id: string;
  /**
   * Links the association to the choice that includes the wargear item.
   */
  limitedWargearChoiceId: string;
  /**
   * Links the association to a selectable wargear item.
   */
  wargearItemId: string;
}
/**
 * Defines one selectable alternative within a loadout choice set.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "LoadoutChoiceRow".
 */
export interface LoadoutChoiceRow {
  /**
   * Identifies this loadout choice.
   */
  id: string;
  /**
   * Links the choice to the set that contains it.
   */
  loadoutChoiceSetId: string;
}
/**
 * Defines a selectable loadout choice set for a datasheet or specified miniature.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "LoadoutChoiceSetRow".
 */
export interface LoadoutChoiceSetRow {
  /**
   * Indicates whether repeated selections are permitted.
   */
  allowDuplicates: boolean;
  /**
   * Indicates whether this set represents an alternate loadout path.
   */
  alternate: boolean;
  /**
   * Links the choice set to its owning datasheet.
   */
  datasheetId: string;
  /**
   * Identifies this loadout choice set.
   */
  id: string;
  /**
   * Specifies the maximum selections allowed from this set.
   */
  limit: number;
  /**
   * Optionally limits the choice set to a particular miniature.
   */
  miniatureId: null | string;
}
/**
 * Associates a loadout choice with a selectable wargear item and its quantity.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "LoadoutChoiceWargearItemRow".
 */
export interface LoadoutChoiceWargearItemRow {
  /**
   * Specifies how many instances of the linked wargear item the choice provides.
   */
  count: number;
  /**
   * Identifies this choice-to-wargear association.
   */
  id: string;
  /**
   * Links the association to the choice that includes the wargear item.
   */
  loadoutChoiceId: string;
  /**
   * Links the association to a selectable wargear item.
   */
  wargearItemId: string;
}
/**
 * Defines a model profile belonging to a datasheet.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "MiniatureRow".
 */
export interface MiniatureRow {
  /**
   * Indicates whether this model may be a non-character warlord.
   */
  canBeNonCharacterWarlord: boolean;
  /**
   * Indicates whether this model is barred from being a warlord.
   */
  cannotBeWarlord: boolean;
  /**
   * Identifies the datasheet containing this model profile.
   */
  datasheetId: string;
  /**
   * Orders the model profile within source presentation.
   */
  displayOrder: number;
  /**
   * Indicates whether this model is excluded from enhancements.
   */
  excludedFromEnhancements: boolean;
  /**
   * Identifies this model profile.
   */
  id: string;
  /**
   * Indicates whether models are treated individually.
   */
  isIndividualModels: boolean;
  /**
   * Indicates whether this model has supreme-command classification.
   */
  isSupremeCommander: boolean;
  /**
   * Records the leadership characteristic.
   */
  leadership: string;
  /**
   * Maps locale codes to model presentation payloads.
   */
  localisations: {
    [k: string]: MiniatureLocalisation;
  };
  /**
   * Records the number of model slots represented by this profile.
   */
  miniatureSlots: number;
  /**
   * Records the movement characteristic.
   */
  movement: string;
  /**
   * Records the objective-control characteristic.
   */
  objectiveControl: string;
  /**
   * Records the save characteristic.
   */
  save: string;
  /**
   * Indicates whether the profile statline is hidden.
   */
  statlineHidden: boolean;
  /**
   * Records the toughness characteristic.
   */
  toughness: string;
  /**
   * Records the wounds characteristic.
   */
  wounds: string;
}
/**
 * Contains one locale-specific model presentation payload.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "MiniatureLocalisation".
 */
export interface MiniatureLocalisation {
  /**
   * Contains the localized model display name.
   */
  name: string;
}
/**
 * Associates a model profile with a keyword.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "MiniatureKeywordRow".
 */
export interface MiniatureKeywordRow {
  /**
   * Orders the keyword association within source presentation.
   */
  displayOrder: number;
  /**
   * Identifies this miniature-keyword association row.
   */
  id: string;
  /**
   * Identifies the associated keyword.
   */
  keywordId: string;
  /**
   * Identifies the model profile receiving the keyword.
   */
  miniatureId: string;
}
/**
 * Defines a mission deployment belonging to a mission pack.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "MissionDeploymentRow".
 */
export interface MissionDeploymentRow {
  /**
   * Identifies the mission-deployment record.
   */
  id: string;
  /**
   * Contains locale-keyed display payloads for the mission deployment.
   */
  localisations: {
    [k: string]: MissionDeploymentLocalisation;
  };
  /**
   * Identifies the mission pack that owns this deployment.
   */
  missionPackId: string;
}
/**
 * Contains a display payload for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "MissionDeploymentLocalisation".
 */
export interface MissionDeploymentLocalisation {
  /**
   * Provides the localized display label for the mission deployment.
   */
  name: string;
}
/**
 * Defines a mission layout belonging to a mission pack.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "MissionLayoutRow".
 */
export interface MissionLayoutRow {
  /**
   * Identifies the mission-layout record.
   */
  id: string;
  /**
   * Contains locale-keyed display payloads for the mission layout.
   */
  localisations: {
    [k: string]: MissionLayoutLocalisation;
  };
  /**
   * Identifies the mission pack that owns this layout.
   */
  missionPackId: string;
}
/**
 * Contains a display payload for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "MissionLayoutLocalisation".
 */
export interface MissionLayoutLocalisation {
  /**
   * Provides the localized display label for the mission layout.
   */
  name: string;
}
/**
 * Associates a mission layout with a deployment it may use.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "MissionLayoutLinkedDeploymentRow".
 */
export interface MissionLayoutLinkedDeploymentRow {
  /**
   * Identifies a deployment linked for layout applicability.
   */
  missionDeploymentId: string;
  /**
   * Identifies a layout linked to an applicable deployment.
   */
  missionLayoutId: string;
}
/**
 * Defines a mission-pack ruleset and its scoring limits.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "MissionPackRow".
 */
export interface MissionPackRow {
  /**
   * Provides the numeric army-point adjustment for battle-ready forces.
   */
  battleReadyArmyPointModifier: number;
  /**
   * Sets the numeric cap for fixed secondary missions.
   */
  fixedSecondaryMissionCapLimit: number;
  /**
   * Identifies the mission-pack record.
   */
  id: string;
  /**
   * Contains locale-keyed display payloads for the mission pack.
   */
  localisations: {
    [k: string]: MissionPackLocalisation;
  };
  /**
   * Sets the numeric per-battle-round primary-mission score limit.
   */
  primaryMissionScoreBattleRoundLimit: number;
  /**
   * Sets the numeric total primary-mission score limit.
   */
  primaryMissionScoreGameLimit: number;
  /**
   * Sets the numeric per-battle-round secondary-mission score limit.
   */
  secondaryMissionScoreBattleRoundLimit: number;
  /**
   * Sets the numeric total secondary-mission score limit.
   */
  secondaryMissionScoreGameLimit: number;
}
/**
 * Contains a display payload for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "MissionPackLocalisation".
 */
export interface MissionPackLocalisation {
  /**
   * Provides the localized display label for the mission pack.
   */
  name: string;
}
/**
 * Defines a mission-pack preset that selects a layout and deployment.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "MissionPresetRow".
 */
export interface MissionPresetRow {
  /**
   * Identifies the mission-preset record.
   */
  id: string;
  /**
   * Contains locale-keyed display payloads for the mission preset.
   */
  localisations: {
    [k: string]: MissionPresetLocalisation;
  };
  /**
   * Identifies the deployment selected by this preset.
   */
  missionDeploymentId: string;
  /**
   * Identifies the layout selected by this preset.
   */
  missionLayoutId: string;
  /**
   * Identifies the mission pack that owns this preset.
   */
  missionPackId: string;
}
/**
 * Contains a display payload for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "MissionPresetLocalisation".
 */
export interface MissionPresetLocalisation {
  /**
   * Provides the localized display label for the mission preset.
   */
  name: string;
}
/**
 * Defines a mission modifier associated with a mission pack.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "MissionTwistRow".
 */
export interface MissionTwistRow {
  /**
   * Identifies the mission-twist record.
   */
  id: string;
  /**
   * Contains locale-keyed content payloads for the mission modifier.
   */
  localisations: {
    [k: string]: MissionTwistLocalisation;
  };
  /**
   * Identifies the mission pack that owns this mission modifier.
   */
  missionPackId: string;
}
/**
 * Contains a content payload for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "MissionTwistLocalisation".
 */
export interface MissionTwistLocalisation {
  /**
   * Provides localized narrative text for the mission modifier.
   */
  lore: string;
  /**
   * Provides the localized display label for the mission modifier.
   */
  name: string;
  /**
   * Provides localized rules text for the mission modifier.
   */
  rules: string;
}
/**
 * Defines primary mission records within mission packs, with an optional detachment applicability scope.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "PrimaryMissionRow".
 */
export interface PrimaryMissionRow {
  /**
   * Optionally identifies the detachment to which this primary mission applies.
   */
  detachmentId: null | string;
  /**
   * Identifies this primary mission record.
   */
  id: string;
  /**
   * Maps locale identifiers to localized primary-mission payloads.
   */
  localisations: {
    [k: string]: PrimaryMissionLocalisation;
  };
  /**
   * Identifies the mission pack containing this primary mission.
   */
  missionPackId: string;
}
/**
 * Contains the localized payload for one primary-mission locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "PrimaryMissionLocalisation".
 */
export interface PrimaryMissionLocalisation {
  /**
   * Carries localized agenda-completion prose for this primary mission.
   */
  agendaAchievedText: null;
  /**
   * Carries localized explanatory prose for this primary mission.
   */
  description: null | string;
  /**
   * Carries localized narrative prose for this primary mission.
   */
  lore: string;
  /**
   * Carries the localized display name for this primary mission.
   */
  name: string;
}
/**
 * Defines action mechanics associated with primary missions.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "PrimaryMissionActionRow".
 */
export interface PrimaryMissionActionRow {
  /**
   * Identifies this primary-mission action record.
   */
  id: string;
  /**
   * Maps locale identifiers to localized primary-mission action payloads.
   */
  localisations: {
    [k: string]: PrimaryMissionActionLocalisation;
  };
  /**
   * Identifies the primary mission associated with this action.
   */
  primaryMissionId: string;
}
/**
 * Contains the localized payload for one primary-mission action locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "PrimaryMissionActionLocalisation".
 */
export interface PrimaryMissionActionLocalisation {
  /**
   * Carries localized prose describing action completion.
   */
  completesText: string;
  /**
   * Carries localized prose describing the action effect.
   */
  effectText: string;
  /**
   * Carries the localized display name for this action.
   */
  name: string;
  /**
   * Carries localized prose describing action restrictions.
   */
  restrictionText: null | string;
  /**
   * Carries localized prose describing action start conditions.
   */
  startsText: string;
  /**
   * Carries localized prose describing units involved in the action.
   */
  unitsText: string;
  /**
   * Carries localized prose describing action use limits.
   */
  useLimitText: string;
}
/**
 * Defines ordered objectives associated with primary missions.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "PrimaryMissionObjectiveRow".
 */
export interface PrimaryMissionObjectiveRow {
  /**
   * Orders this objective within its primary mission.
   */
  displayOrder: number;
  /**
   * Identifies this primary-mission objective record.
   */
  id: string;
  /**
   * Maps locale identifiers to localized primary-mission objective payloads.
   */
  localisations: {
    [k: string]: PrimaryMissionObjectiveLocalisation;
  };
  /**
   * Identifies the primary mission associated with this objective.
   */
  primaryMissionId: string;
}
/**
 * Contains the localized payload for one primary-mission objective locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "PrimaryMissionObjectiveLocalisation".
 */
export interface PrimaryMissionObjectiveLocalisation {
  /**
   * Carries the localized display name for this objective.
   */
  name: string;
  /**
   * Carries localized prose describing when this objective applies.
   */
  whenText: null | string;
}
/**
 * Associates primary-mission objectives with scoreable timing periods.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "PrimaryMissionObjectiveScorablePeriodRow".
 */
export interface PrimaryMissionObjectiveScorablePeriodRow {
  /**
   * Identifies the primary-mission objective associated with this timing period.
   */
  primaryMissionObjectiveId: string;
  /**
   * Specifies the scoreable timing period associated with the objective.
   */
  scorablePeriod: string;
}
/**
 * Defines ordered score rules for primary-mission objectives.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "PrimaryMissionObjectiveScoringRow".
 */
export interface PrimaryMissionObjectiveScoringRow {
  /**
   * Orders this score rule within its objective.
   */
  displayOrder: number;
  /**
   * Identifies this primary-mission objective scoring record.
   */
  id: string;
  /**
   * Classifies the input structure used by this score rule.
   */
  inputType: string;
  /**
   * Indicates whether score results accumulate.
   */
  isCumulative: boolean;
  /**
   * Indicates whether this score rule excludes concurrent score rules.
   */
  isMutuallyExclusive: boolean;
  /**
   * Maps locale identifiers to localized primary-mission scoring payloads.
   */
  localisations: {
    [k: string]: PrimaryMissionObjectiveScoringLocalisation;
  };
  /**
   * Identifies the primary-mission objective scored by this rule.
   */
  primaryMissionObjectiveId: string;
  /**
   * Specifies the numerical score awarded by this rule.
   */
  victoryPoints: number;
}
/**
 * Contains the localized payload for one primary-mission scoring locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "PrimaryMissionObjectiveScoringLocalisation".
 */
export interface PrimaryMissionObjectiveScoringLocalisation {
  /**
   * Carries localized prose describing scoring criteria.
   */
  scoringCriteria: string;
}
/**
 * Defines a publication context that owns released game content and its faction association.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "PublicationRow".
 */
export interface PublicationRow {
  /**
   * Orders publications for presentation.
   */
  displayOrder: number;
  /**
   * Records the publication's errata revision date when supplied.
   */
  errataDate: null | string;
  /**
   * References faction-associated artwork for the publication.
   */
  factionBackgroundImage: string;
  /**
   * References the faction keyword that owns the publication context.
   */
  factionKeywordId: null | string;
  /**
   * Identifies the publication row.
   */
  id: string;
  /**
   * Marks whether the publication belongs to the Combat Patrol mode.
   */
  isCombatPatrol: boolean;
  /**
   * Marks whether the publication supplies core rules.
   */
  isCoreRules: boolean;
  /**
   * Marks whether the publication is in the Legends classification.
   */
  isLegends: boolean;
  /**
   * Maps locale identifiers to publication display payloads.
   */
  localisations: {
    [k: string]: PublicationLocalisation;
  };
  /**
   * Carries the publication's external product-system identifier when supplied.
   */
  productId: null | string;
}
/**
 * Contains the publication display payload for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "PublicationLocalisation".
 */
export interface PublicationLocalisation {
  /**
   * Provides the localized Combat Patrol display name when applicable.
   */
  combatPatrolName: null | string;
  /**
   * Provides the localized publication display name.
   */
  name: string;
}
/**
 * Applies a keyword restriction group to a detachment with optional roster bounds.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "RestrictionGroupDetachmentLimitRow".
 */
export interface RestrictionGroupDetachmentLimitRow {
  /**
   * Identifies the detachment to which the restriction-group limit applies.
   */
  detachmentId: string;
  /**
   * Identifies this restriction-group detachment limit.
   */
  id: string;
  /**
   * Provides the optional maximum roster limit for this application.
   */
  maxRosterLimit: null | number;
  /**
   * Provides the optional minimum roster limit for this application.
   */
  minRosterLimit: null | number;
  /**
   * Identifies the keyword restriction group applied by this limit.
   */
  restrictionGroupId: string;
}
/**
 * Groups ordered rule presentation components under a rule section, optionally for a stratagem.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "RuleContainerRow".
 */
export interface RuleContainerRow {
  /**
   * References the optional behaviour classification used by the rule container.
   */
  behaviourTypeId: null | string;
  /**
   * Classifies the structural presentation kind of the container.
   */
  containerType: string;
  /**
   * Orders containers within their rule section.
   */
  displayOrder: number;
  /**
   * Identifies the rule container row.
   */
  id: string;
  /**
   * Maps locale identifiers to container display payloads.
   */
  localisations: {
    [k: string]: RuleContainerLocalisation;
  };
  /**
   * References the rule section that owns the container placement.
   */
  ruleSectionId: string;
  /**
   * References the optional stratagem to which the container applies.
   */
  stratagemId: null | string;
}
/**
 * Contains the container display payload for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "RuleContainerLocalisation".
 */
export interface RuleContainerLocalisation {
  /**
   * Provides the localized container subtitle when supplied.
   */
  subtitle: null | string;
  /**
   * Provides the localized container title.
   */
  title: string;
}
/**
 * Defines an ordered component of a rule container or a rule-specific presentation attachment.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "RuleContainerComponentRow".
 */
export interface RuleContainerComponentRow {
  /**
   * References the optional army rule represented by the component.
   */
  armyRuleId: null | string;
  /**
   * Provides an optional structural presentation color token.
   */
  backgroundColor: null | string;
  /**
   * References the optional detachment rule represented by the component.
   */
  detachmentRuleId: null | string;
  /**
   * Orders components within their presentation context.
   */
  displayOrder: number;
  /**
   * Identifies the rule container component row.
   */
  id: string;
  /**
   * References optional component artwork.
   */
  imageUrl: null | string;
  /**
   * Maps locale identifiers to component presentation payloads.
   */
  localisations: {
    [k: string]: RuleContainerComponentLocalisation;
  };
  /**
   * Reserves an optional reference to a mission twist represented by the component.
   */
  missionTwistId: null;
  /**
   * Reserves an optional reference to an objective represented by the component.
   */
  objectiveId: null;
  /**
   * References the optional rule container that owns the component placement.
   */
  ruleContainerId: null | string;
  /**
   * Reserves an optional reference to a secondary objective represented by the component.
   */
  secondaryObjectiveId: null;
  /**
   * Classifies the structural component kind.
   */
  type: string;
}
/**
 * Contains the component presentation payload for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "RuleContainerComponentLocalisation".
 */
export interface RuleContainerComponentLocalisation {
  /**
   * Carries localized alternative-text prose for component artwork.
   */
  altText: null | string;
  /**
   * Carries localized rules-effect prose.
   */
  effect: null | string;
  /**
   * Provides the localized component subtitle when supplied.
   */
  subtitle: null | string;
  /**
   * Carries localized rules or explanatory prose.
   */
  textContent: null | string;
  /**
   * Provides the localized component title when supplied.
   */
  title: null | string;
  /**
   * Carries localized rules-trigger prose.
   */
  trigger: null | string;
}
/**
 * Defines an ordered publication-owned section that organizes rule containers.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "RuleSectionRow".
 */
export interface RuleSectionRow {
  /**
   * Orders rule sections within their publication context.
   */
  displayOrder: number;
  /**
   * Identifies the rule section row.
   */
  id: string;
  /**
   * Maps locale identifiers to section display payloads.
   */
  localisations: {
    [k: string]: RuleSectionLocalisation;
  };
  /**
   * Stores the structural path used to organize the section.
   */
  mpath: string;
  /**
   * Reserves an optional parent rule section for hierarchy.
   */
  parentId: null;
  /**
   * References the publication that owns the rule section.
   */
  publicationId: string;
}
/**
 * Contains the section display payload for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "RuleSectionLocalisation".
 */
export interface RuleSectionLocalisation {
  /**
   * Provides the localized rule section display name.
   */
  name: string;
}
/**
 * Defines secondary mission records within mission packs.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "SecondaryMissionRow".
 */
export interface SecondaryMissionRow {
  /**
   * Identifies this secondary mission record.
   */
  id: string;
  /**
   * Indicates whether this secondary mission is fixed rather than selected dynamically.
   */
  isFixedSecondary: boolean;
  /**
   * Indicates whether this secondary mission can be scored during the first turn.
   */
  isScorableFirstTurn: boolean;
  /**
   * Maps locale identifiers to localized secondary-mission payloads.
   */
  localisations: {
    [k: string]: SecondaryMissionLocalisation;
  };
  /**
   * Identifies the mission pack containing this secondary mission.
   */
  missionPackId: string;
}
/**
 * Contains the localized payload for one secondary-mission locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "SecondaryMissionLocalisation".
 */
export interface SecondaryMissionLocalisation {
  /**
   * Carries localized explanatory prose for this secondary mission.
   */
  description: null | string;
  /**
   * Carries localized narrative prose for this secondary mission.
   */
  lore: string;
  /**
   * Carries the localized display name for this secondary mission.
   */
  name: string;
}
/**
 * Defines action mechanics associated with secondary missions.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "SecondaryMissionActionRow".
 */
export interface SecondaryMissionActionRow {
  /**
   * Identifies this secondary-mission action record.
   */
  id: string;
  /**
   * Maps locale identifiers to localized secondary-mission action payloads.
   */
  localisations: {
    [k: string]: SecondaryMissionActionLocalisation;
  };
  /**
   * Identifies the secondary mission associated with this action.
   */
  secondaryMissionId: string;
}
/**
 * Contains the localized payload for one secondary-mission action locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "SecondaryMissionActionLocalisation".
 */
export interface SecondaryMissionActionLocalisation {
  /**
   * Carries localized prose describing action completion.
   */
  completesText: string;
  /**
   * Carries localized prose describing the action effect.
   */
  effectText: string;
  /**
   * Carries the localized display name for this action.
   */
  name: string;
  /**
   * Carries localized prose describing action restrictions.
   */
  restrictionText: null;
  /**
   * Carries localized prose describing action start conditions.
   */
  startsText: string;
  /**
   * Carries localized prose describing units involved in the action.
   */
  unitsText: string;
  /**
   * Carries localized prose describing action use limits.
   */
  useLimitText: string;
}
/**
 * Defines ordered objectives associated with secondary missions.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "SecondaryMissionObjectiveRow".
 */
export interface SecondaryMissionObjectiveRow {
  /**
   * Orders this objective within its secondary mission.
   */
  displayOrder: number;
  /**
   * Identifies this secondary-mission objective record.
   */
  id: string;
  /**
   * Maps locale identifiers to localized secondary-mission objective payloads.
   */
  localisations: {
    [k: string]: SecondaryMissionObjectiveLocalisation;
  };
  /**
   * Identifies the secondary mission associated with this objective.
   */
  secondaryMissionId: string;
}
/**
 * Contains the localized payload for one secondary-mission objective locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "SecondaryMissionObjectiveLocalisation".
 */
export interface SecondaryMissionObjectiveLocalisation {
  /**
   * Carries the localized display name for this objective.
   */
  name: string;
  /**
   * Carries localized prose describing when this objective applies.
   */
  whenText: string;
}
/**
 * Defines ordered score rules for secondary-mission objectives.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "SecondaryMissionObjectiveScoringRow".
 */
export interface SecondaryMissionObjectiveScoringRow {
  /**
   * Orders this score rule within its objective.
   */
  displayOrder: number;
  /**
   * Identifies this secondary-mission objective scoring record.
   */
  id: string;
  /**
   * Classifies the input structure used by this score rule.
   */
  inputType: string;
  /**
   * Indicates whether score results accumulate.
   */
  isCumulative: boolean;
  /**
   * Indicates whether this score rule excludes concurrent score rules.
   */
  isMutuallyExclusive: boolean;
  /**
   * Maps locale identifiers to localized secondary-mission scoring payloads.
   */
  localisations: {
    [k: string]: SecondaryMissionObjectiveScoringLocalisation;
  };
  /**
   * Classifies the scoring mechanism used by this rule.
   */
  scoringType: string;
  /**
   * Identifies the secondary-mission objective scored by this rule.
   */
  secondaryMissionObjectiveId: string;
  /**
   * Specifies the numerical score awarded by this rule.
   */
  victoryPoints: number;
  /**
   * Optionally specifies the numerical cap for score awarded by this rule.
   */
  victoryPointsCap: null | number;
}
/**
 * Contains the localized payload for one secondary-mission scoring locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "SecondaryMissionObjectiveScoringLocalisation".
 */
export interface SecondaryMissionObjectiveScoringLocalisation {
  /**
   * Carries localized prose describing scoring criteria.
   */
  scoringCriteria: string;
}
/**
 * Defines a tactical ability record, its publication ownership, optional detachment applicability, resource cost, ordering, and localized rule text.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "StratagemRow".
 */
export interface StratagemRow {
  /**
   * Classifies the tactical ability for structural grouping.
   */
  category: null | string;
  /**
   * States the command-point cost to use the tactical ability.
   */
  cpCost: string;
  /**
   * References the detachment to which this tactical ability applies when restricted to one.
   */
  detachmentId: null | string;
  /**
   * Orders the tactical ability within its source presentation.
   */
  displayOrder: number;
  /**
   * Uniquely identifies the tactical ability record.
   */
  id: string;
  /**
   * Supplies a stable structural key for the tactical ability.
   */
  key: string;
  /**
   * Maps locale identifiers to localized tactical-ability payloads.
   */
  localisations: {
    [k: string]: StratagemLocalisation;
  };
  /**
   * References the publication that owns this tactical ability.
   */
  publicationId: string;
  /**
   * States the additional command-point cost for the alternate effect when present.
   */
  secondaryEffectAdditionalCPCost: null | number;
  /**
   * Indicates whether the alternate effect excludes the standard effect.
   */
  secondaryEffectIsMutuallyExclusive: boolean;
}
/**
 * Contains the localized tactical-ability payload for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "StratagemLocalisation".
 */
export interface StratagemLocalisation {
  /**
   * Contains prose describing the tactical ability's effect.
   */
  effectRules: string;
  /**
   * Contains explanatory or narrative prose for the tactical ability.
   */
  lore: string;
  /**
   * Provides the localized display name for the tactical ability.
   */
  name: string;
  /**
   * Contains prose describing restrictions on use of the tactical ability.
   */
  restrictionRules: null | string;
  /**
   * Contains prose describing an alternate tactical-ability effect.
   */
  secondaryEffect: null | string;
  /**
   * Contains prose describing eligible targets for the tactical ability.
   */
  targetRules: string;
  /**
   * Contains prose describing the timing for use of the tactical ability.
   */
  whenRules: string;
}
/**
 * Associates a tactical ability with a phase in which it may be used.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "StratagemPhaseRow".
 */
export interface StratagemPhaseRow {
  /**
   * Names the phase to which the tactical ability's availability applies.
   */
  phase: string;
  /**
   * References the tactical ability available in this phase.
   */
  stratagemId: string;
}
/**
 * Defines a selectable model-count and points composition for a datasheet.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "UnitCompositionRow".
 */
export interface UnitCompositionRow {
  /**
   * Links the composition to its owning datasheet.
   */
  datasheetId: string;
  /**
   * Specifies the presentation order of this composition.
   */
  displayOrder: number;
  /**
   * Identifies this unit composition.
   */
  id: string;
  /**
   * Indicates whether this composition is the default selection.
   */
  isDefault: boolean;
  /**
   * Specifies the points cost for this composition.
   */
  points: number;
  /**
   * Optionally links the composition to a keyword used for reference grouping.
   */
  referenceGroupingKeywordId: null | string;
}
/**
 * Associates a unit composition with a model profile and its allowed count range.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "UnitCompositionMiniatureRow".
 */
export interface UnitCompositionMiniatureRow {
  /**
   * Identifies this unit-composition model row.
   */
  id: string;
  /**
   * Records the maximum count allowed for the model profile.
   */
  max: number;
  /**
   * Records the minimum count required for the model profile.
   */
  min: number;
  /**
   * Identifies the model profile counted by this composition row.
   */
  miniatureId: string;
  /**
   * Identifies the unit composition containing this model count.
   */
  unitCompositionId: string;
}
/**
 * Associates a unit composition with a required detachment.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "UnitCompositionRequiredDetachmentRow".
 */
export interface UnitCompositionRequiredDetachmentRow {
  /**
   * Links the requirement to the detachment needed for the composition.
   */
  detachmentId: string;
  /**
   * Links the requirement to the constrained unit composition.
   */
  unitCompositionId: string;
}
/**
 * Associates a unit composition with a required faction keyword.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "UnitCompositionRequiredFactionKeywordRow".
 */
export interface UnitCompositionRequiredFactionKeywordRow {
  /**
   * Links the requirement to the faction keyword needed for the composition.
   */
  factionKeywordId: string;
  /**
   * Links the requirement to the constrained unit composition.
   */
  unitCompositionId: string;
}
/**
 * Defines a reusable wargear ability that may apply to weapon profiles.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "WargearAbilityRow".
 */
export interface WargearAbilityRow {
  /**
   * Identifies this wargear ability.
   */
  id: string;
  /**
   * Maps locale identifiers to localized wargear-ability payloads.
   */
  localisations: {
    [k: string]: WargearAbilityLocalisation;
  };
}
/**
 * Contains the localized payload for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "WargearAbilityLocalisation".
 */
export interface WargearAbilityLocalisation {
  /**
   * Contains localized background prose for the wargear ability.
   */
  lore: null | string;
  /**
   * Provides the localized display name of the wargear ability.
   */
  name: string;
  /**
   * Contains localized rules prose for the wargear ability.
   */
  rules: string;
}
/**
 * Defines a named wargear item that may have one or more profiles.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "WargearItemRow".
 */
export interface WargearItemRow {
  /**
   * Identifies this wargear item.
   */
  id: string;
  /**
   * Maps locale identifiers to localized wargear-item payloads.
   */
  localisations: {
    [k: string]: WargearItemLocalisation;
  };
  /**
   * Indicates the presentation treatment for multiple profiles.
   */
  noMultiProfileIcon: boolean;
  /**
   * Classifies the kind of wargear item.
   */
  wargearType: string;
}
/**
 * Contains the localized payload for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "WargearItemLocalisation".
 */
export interface WargearItemLocalisation {
  /**
   * Provides the localized display name of the wargear item.
   */
  name: string;
  /**
   * Contains localized rules prose for the wargear item.
   */
  ruleText: null | string;
}
/**
 * Defines an ordered mechanical profile associated with a wargear item.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "WargearItemProfileRow".
 */
export interface WargearItemProfileRow {
  /**
   * Provides the profile's armour-penetration characteristic.
   */
  armourPenetration: string;
  /**
   * Provides the profile's attacks characteristic.
   */
  attacks: string;
  /**
   * Provides the profile's ballistic-skill characteristic when applicable.
   */
  ballisticSkill: null | string;
  /**
   * Provides the profile's damage characteristic.
   */
  damage: string;
  /**
   * Orders profiles within the associated wargear item.
   */
  displayOrder: number;
  /**
   * Identifies this wargear-item profile.
   */
  id: string;
  /**
   * Maps locale identifiers to localized profile payloads.
   */
  localisations: {
    [k: string]: WargearItemProfileLocalisation;
  };
  /**
   * Provides the profile's range characteristic.
   */
  range: string;
  /**
   * Provides the profile's strength characteristic.
   */
  strength: string;
  /**
   * Classifies the profile presentation or mechanical mode.
   */
  type: string;
  /**
   * References the wargear item associated with this profile.
   */
  wargearItemId: string;
  /**
   * Provides the profile's weapon-skill characteristic when applicable.
   */
  weaponSkill: null | string;
}
/**
 * Contains the localized payload for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "WargearItemProfileLocalisation".
 */
export interface WargearItemProfileLocalisation {
  /**
   * Reserves a localized profile-keyword field that is null in the observed shape.
   */
  hunterProfileKeyword: null;
  /**
   * Provides the localized display name of the profile.
   */
  name: string;
}
/**
 * Associates a wargear profile with an ability that applies to that profile.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "WargearItemProfileWargearAbilityRow".
 */
export interface WargearItemProfileWargearAbilityRow {
  /**
   * Orders abilities within the associated profile presentation.
   */
  displayOrder: number;
  /**
   * Identifies this profile-ability association.
   */
  id: string;
  /**
   * References the ability that applies through this association.
   */
  wargearAbilityId: string;
  /**
   * References the wargear profile to which the ability applies.
   */
  wargearItemProfileId: string;
}
/**
 * Defines quantity and duplication caps for a limited wargear choice set.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "WargearLimitRow".
 */
export interface WargearLimitRow {
  /**
   * Specifies the maximum number of choices permitted by this cap.
   */
  choiceLimit: number;
  /**
   * Specifies an optional maximum repetition count within the constrained choices.
   */
  duplicateLimit: null | number;
  /**
   * Identifies this cap record.
   */
  id: string;
  /**
   * Links this cap to the limited wargear choice set it constrains.
   */
  limitedWargearChoiceSetId: string;
  /**
   * Specifies the model-count condition for this cap.
   */
  modelCount: number;
}
/**
 * Defines an ordered selectable wargear entry within a wargear choice group.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "WargearOptionRow".
 */
export interface WargearOptionRow {
  /**
   * States the default selection quantity or value for this wargear entry.
   */
  defaultValue: number;
  /**
   * Orders the wargear entry within its choice group.
   */
  displayOrder: number;
  /**
   * Uniquely identifies the wargear choice entry.
   */
  id: string;
  /**
   * Classifies the selection control or value shape for this wargear entry.
   */
  inputType: string;
  /**
   * States the points adjustment associated with selecting this wargear entry.
   */
  points: number;
  /**
   * References the wargear item represented by this selectable entry.
   */
  wargearItemId: string;
  /**
   * References the wargear choice group that owns this entry.
   */
  wargearOptionGroupId: string;
}
/**
 * Defines an ordered group of wargear choices owned by a datasheet and optionally scoped to a miniature.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "WargearOptionGroupRow".
 */
export interface WargearOptionGroupRow {
  /**
   * References the datasheet that owns this wargear choice group.
   */
  datasheetId: string;
  /**
   * Orders the wargear choice group within its datasheet.
   */
  displayOrder: number;
  /**
   * Uniquely identifies the wargear choice group.
   */
  id: string;
  /**
   * Indicates whether the group describes fixed rather than selectable wargear.
   */
  isStaticWargear: boolean;
  /**
   * Maps locale identifiers to localized wargear-choice instructions.
   */
  localisations: {
    [k: string]: WargearOptionGroupLocalisation;
  };
  /**
   * References the miniature to which this choice group is scoped when it is model-specific.
   */
  miniatureId: null | string;
}
/**
 * Contains the localized wargear-choice instruction payload for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "WargearOptionGroupLocalisation".
 */
export interface WargearOptionGroupLocalisation {
  /**
   * Contains prose instructing how to apply the wargear choices.
   */
  instructionText: string;
}
/**
 * Defines an ordered localized wargear rule owned by a datasheet.
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "WargearRuleRow".
 */
export interface WargearRuleRow {
  /**
   * References the datasheet that owns this wargear rule.
   */
  datasheetId: string;
  /**
   * Orders the wargear rule within its datasheet.
   */
  displayOrder: number;
  /**
   * Uniquely identifies the wargear rule.
   */
  id: string;
  /**
   * Maps locale identifiers to localized wargear-rule payloads.
   */
  localisations: {
    [k: string]: WargearRuleLocalisation;
  };
}
/**
 * Contains the localized wargear-rule payload for one locale.
 *
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z]{2}(?:-[A-Z]{2})?$".
 *
 * This interface was referenced by `MfmDumpPayload`'s JSON-Schema
 * via the `definition` "WargearRuleLocalisation".
 */
export interface WargearRuleLocalisation {
  /**
   * Contains prose defining the wargear rule.
   */
  rulesText: string;
}

export type MfmTableName = keyof MfmTableMap;
export type MfmRow<N extends MfmTableName> = MfmTableMap[N][number];
export type MfmIdTableName = "all_model_wargear_choice" | "all_model_wargear_choice_set" | "all_model_wargear_choice_wargear_item" | "allegiance_ability" | "allegiance_ability_group" | "allied_faction" | "allied_faction_keyword" | "allied_faction_keyword_slotless_keyword_group" | "army_rule" | "base_miniature_loadout" | "base_miniature_loadout_wargear_option" | "battle_size" | "behaviour_type" | "bullet_point" | "conditional_keyword" | "datasheet" | "datasheet_ability" | "datasheet_bodyguard_group" | "datasheet_damage" | "datasheet_datasheet_ability" | "datasheet_faction_keyword" | "datasheet_points_step" | "datasheet_rule" | "datasheet_sub_ability" | "detachment" | "detachment_detail" | "detachment_detail_bullet_point" | "detachment_rule" | "enhancement" | "enhancement_bodyguard_group" | "enhancement_required_keyword_group" | "faction_keyword" | "faq" | "faq_config" | "force_disposition" | "force_disposition_mission" | "invulnerable_save" | "keyword" | "keyword_restriction_group" | "limited_wargear_choice" | "limited_wargear_choice_set" | "limited_wargear_choice_wargear_item" | "loadout_choice" | "loadout_choice_set" | "loadout_choice_wargear_item" | "miniature" | "miniature_keyword" | "mission_deployment" | "mission_layout" | "mission_pack" | "mission_preset" | "mission_twist" | "primary_mission" | "primary_mission_action" | "primary_mission_objective" | "primary_mission_objective_scoring" | "publication" | "restriction_group_detachment_limit" | "rule_container" | "rule_container_component" | "rule_section" | "secondary_mission" | "secondary_mission_action" | "secondary_mission_objective" | "secondary_mission_objective_scoring" | "stratagem" | "unit_composition" | "unit_composition_miniature" | "wargear_ability" | "wargear_item" | "wargear_item_profile" | "wargear_item_profile_wargear_ability" | "wargear_limit" | "wargear_option" | "wargear_option_group" | "wargear_rule";
export type MfmStringKey<N extends MfmTableName> = {
  [K in keyof MfmRow<N>]-?: Exclude<MfmRow<N>[K], null | undefined> extends string ? K : never;
}[keyof MfmRow<N>] & string;

export const MFM_RELATIONS = {
  "all_model_wargear_choice_set.datasheetId": {
    "sourceTable": "all_model_wargear_choice_set",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "all_model_wargear_choice_set.miniatureId": {
    "sourceTable": "all_model_wargear_choice_set",
    "sourceField": "miniatureId",
    "targetTable": "miniature",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "applicability"
  },
  "all_model_wargear_choice_wargear_item.allModelWargearChoiceId": {
    "sourceTable": "all_model_wargear_choice_wargear_item",
    "sourceField": "allModelWargearChoiceId",
    "targetTable": "all_model_wargear_choice",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "all_model_wargear_choice_wargear_item.wargearItemId": {
    "sourceTable": "all_model_wargear_choice_wargear_item",
    "sourceField": "wargearItemId",
    "targetTable": "wargear_item",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "all_model_wargear_choice.allModelWargearChoiceSetId": {
    "sourceTable": "all_model_wargear_choice",
    "sourceField": "allModelWargearChoiceSetId",
    "targetTable": "all_model_wargear_choice_set",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "allegiance_ability_group.detachmentId": {
    "sourceTable": "allegiance_ability_group",
    "sourceField": "detachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "general"
  },
  "allegiance_ability.allegianceAbilityGroupId": {
    "sourceTable": "allegiance_ability",
    "sourceField": "allegianceAbilityGroupId",
    "targetTable": "allegiance_ability_group",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "allegiance_ability.requiresWargearItemId": {
    "sourceTable": "allegiance_ability",
    "sourceField": "requiresWargearItemId",
    "targetTable": "wargear_item",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "eligibility"
  },
  "allied_faction_allowed_warlord_miniature.alliedFactionId": {
    "sourceTable": "allied_faction_allowed_warlord_miniature",
    "sourceField": "alliedFactionId",
    "targetTable": "allied_faction",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "allied_faction_allowed_warlord_miniature.miniatureId": {
    "sourceTable": "allied_faction_allowed_warlord_miniature",
    "sourceField": "miniatureId",
    "targetTable": "miniature",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "allied_faction_datasheet.alliedFactionId": {
    "sourceTable": "allied_faction_datasheet",
    "sourceField": "alliedFactionId",
    "targetTable": "allied_faction",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "allied_faction_datasheet.datasheetId": {
    "sourceTable": "allied_faction_datasheet",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "allied_faction_keyword_slotless_keyword_group_donor_keyword.alliedFactionKeywordSlotlessKeywordGroupId": {
    "sourceTable": "allied_faction_keyword_slotless_keyword_group_donor_keyword",
    "sourceField": "alliedFactionKeywordSlotlessKeywordGroupId",
    "targetTable": "allied_faction_keyword_slotless_keyword_group",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "allied_faction_keyword_slotless_keyword_group_donor_keyword.keywordId": {
    "sourceTable": "allied_faction_keyword_slotless_keyword_group_donor_keyword",
    "sourceField": "keywordId",
    "targetTable": "keyword",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "allied_faction_keyword_slotless_keyword_group_receiver_keyword.alliedFactionKeywordSlotlessKeywordGroupId": {
    "sourceTable": "allied_faction_keyword_slotless_keyword_group_receiver_keyword",
    "sourceField": "alliedFactionKeywordSlotlessKeywordGroupId",
    "targetTable": "allied_faction_keyword_slotless_keyword_group",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "allied_faction_keyword_slotless_keyword_group_receiver_keyword.keywordId": {
    "sourceTable": "allied_faction_keyword_slotless_keyword_group_receiver_keyword",
    "sourceField": "keywordId",
    "targetTable": "keyword",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "allied_faction_keyword_slotless_keyword_group.alliedFactionKeywordId": {
    "sourceTable": "allied_faction_keyword_slotless_keyword_group",
    "sourceField": "alliedFactionKeywordId",
    "targetTable": "allied_faction_keyword",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "eligibility"
  },
  "allied_faction_keyword.alliedFactionId": {
    "sourceTable": "allied_faction_keyword",
    "sourceField": "alliedFactionId",
    "targetTable": "allied_faction",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "eligibility"
  },
  "allied_faction_keyword.battleSizeId": {
    "sourceTable": "allied_faction_keyword",
    "sourceField": "battleSizeId",
    "targetTable": "battle_size",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "eligibility"
  },
  "allied_faction_keyword.keywordId": {
    "sourceTable": "allied_faction_keyword",
    "sourceField": "keywordId",
    "targetTable": "keyword",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "eligibility"
  },
  "allied_faction_parent_faction_keyword.alliedFactionId": {
    "sourceTable": "allied_faction_parent_faction_keyword",
    "sourceField": "alliedFactionId",
    "targetTable": "allied_faction",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "allied_faction_parent_faction_keyword.factionKeywordId": {
    "sourceTable": "allied_faction_parent_faction_keyword",
    "sourceField": "factionKeywordId",
    "targetTable": "faction_keyword",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "allied_faction_points_limit.alliedFactionId": {
    "sourceTable": "allied_faction_points_limit",
    "sourceField": "alliedFactionId",
    "targetTable": "allied_faction",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "applicability"
  },
  "allied_faction_points_limit.battleSizeId": {
    "sourceTable": "allied_faction_points_limit",
    "sourceField": "battleSizeId",
    "targetTable": "battle_size",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "applicability"
  },
  "allied_faction_required_detachment.alliedFactionId": {
    "sourceTable": "allied_faction_required_detachment",
    "sourceField": "alliedFactionId",
    "targetTable": "allied_faction",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "allied_faction_required_detachment.detachmentId": {
    "sourceTable": "allied_faction_required_detachment",
    "sourceField": "detachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "army_rule_excluded_from_command_bunker_faction_keyword.armyRuleId": {
    "sourceTable": "army_rule_excluded_from_command_bunker_faction_keyword",
    "sourceField": "armyRuleId",
    "targetTable": "army_rule",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "army_rule_excluded_from_command_bunker_faction_keyword.factionKeywordId": {
    "sourceTable": "army_rule_excluded_from_command_bunker_faction_keyword",
    "sourceField": "factionKeywordId",
    "targetTable": "faction_keyword",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "army_rule_faction_keyword.armyRuleId": {
    "sourceTable": "army_rule_faction_keyword",
    "sourceField": "armyRuleId",
    "targetTable": "army_rule",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "army_rule_faction_keyword.factionKeywordId": {
    "sourceTable": "army_rule_faction_keyword",
    "sourceField": "factionKeywordId",
    "targetTable": "faction_keyword",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "army_rule.publicationId": {
    "sourceTable": "army_rule",
    "sourceField": "publicationId",
    "targetTable": "publication",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "base_miniature_loadout_wargear_option.baseMiniatureLoadoutId": {
    "sourceTable": "base_miniature_loadout_wargear_option",
    "sourceField": "baseMiniatureLoadoutId",
    "targetTable": "base_miniature_loadout",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "base_miniature_loadout_wargear_option.wargearOptionId": {
    "sourceTable": "base_miniature_loadout_wargear_option",
    "sourceField": "wargearOptionId",
    "targetTable": "wargear_option",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "base_miniature_loadout.datasheetId": {
    "sourceTable": "base_miniature_loadout",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "base_miniature_loadout.miniatureId": {
    "sourceTable": "base_miniature_loadout",
    "sourceField": "miniatureId",
    "targetTable": "miniature",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "applicability"
  },
  "bullet_point.ruleContainerComponentId": {
    "sourceTable": "bullet_point",
    "sourceField": "ruleContainerComponentId",
    "targetTable": "rule_container_component",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "conditional_keyword.datasheetId": {
    "sourceTable": "conditional_keyword",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "applicability"
  },
  "conditional_keyword.keywordId": {
    "sourceTable": "conditional_keyword",
    "sourceField": "keywordId",
    "targetTable": "keyword",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "applicability"
  },
  "conditional_keyword.requiredAllegianceAbilityId": {
    "sourceTable": "conditional_keyword",
    "sourceField": "requiredAllegianceAbilityId",
    "targetTable": "allegiance_ability",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "eligibility"
  },
  "conditional_keyword.requiredDetachmentId": {
    "sourceTable": "conditional_keyword",
    "sourceField": "requiredDetachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "eligibility"
  },
  "conditional_keyword.requiredRosterFactionKeywordId": {
    "sourceTable": "conditional_keyword",
    "sourceField": "requiredRosterFactionKeywordId",
    "targetTable": "faction_keyword",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "eligibility"
  },
  "conditional_keyword.requiredWarlordMiniatureId": {
    "sourceTable": "conditional_keyword",
    "sourceField": "requiredWarlordMiniatureId",
    "targetTable": "miniature",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "eligibility"
  },
  "datasheet_ability.armyRuleId": {
    "sourceTable": "datasheet_ability",
    "sourceField": "armyRuleId",
    "targetTable": "army_rule",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "general"
  },
  "datasheet_ability.detachmentRuleId": {
    "sourceTable": "datasheet_ability",
    "sourceField": "detachmentRuleId",
    "targetTable": "detachment_rule",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "general"
  },
  "datasheet_bodyguard_group_datasheet.datasheetBodyguardGroupId": {
    "sourceTable": "datasheet_bodyguard_group_datasheet",
    "sourceField": "datasheetBodyguardGroupId",
    "targetTable": "datasheet_bodyguard_group",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "datasheet_bodyguard_group_datasheet.datasheetId": {
    "sourceTable": "datasheet_bodyguard_group_datasheet",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "datasheet_bodyguard_group_keyword.datasheetBodyguardGroupId": {
    "sourceTable": "datasheet_bodyguard_group_keyword",
    "sourceField": "datasheetBodyguardGroupId",
    "targetTable": "datasheet_bodyguard_group",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "datasheet_bodyguard_group_keyword.keywordId": {
    "sourceTable": "datasheet_bodyguard_group_keyword",
    "sourceField": "keywordId",
    "targetTable": "keyword",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "datasheet_bodyguard_group.datasheetId": {
    "sourceTable": "datasheet_bodyguard_group",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "eligibility"
  },
  "datasheet_bodyguard_group.excludedDetachmentId": {
    "sourceTable": "datasheet_bodyguard_group",
    "sourceField": "excludedDetachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "eligibility"
  },
  "datasheet_bodyguard_group.requiredDetachmentId": {
    "sourceTable": "datasheet_bodyguard_group",
    "sourceField": "requiredDetachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "eligibility"
  },
  "datasheet_bodyguard_group.requiresAllUnitsHaveKeywordId": {
    "sourceTable": "datasheet_bodyguard_group",
    "sourceField": "requiresAllUnitsHaveKeywordId",
    "targetTable": "keyword",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "eligibility"
  },
  "datasheet_damage.datasheetId": {
    "sourceTable": "datasheet_damage",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "datasheet_datasheet_ability.datasheetAbilityId": {
    "sourceTable": "datasheet_datasheet_ability",
    "sourceField": "datasheetAbilityId",
    "targetTable": "datasheet_ability",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "datasheet_datasheet_ability.datasheetId": {
    "sourceTable": "datasheet_datasheet_ability",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "datasheet_faction_keyword.datasheetId": {
    "sourceTable": "datasheet_faction_keyword",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "datasheet_faction_keyword.factionKeywordId": {
    "sourceTable": "datasheet_faction_keyword",
    "sourceField": "factionKeywordId",
    "targetTable": "faction_keyword",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "datasheet_points_step.datasheetId": {
    "sourceTable": "datasheet_points_step",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "datasheet_rule.datasheetId": {
    "sourceTable": "datasheet_rule",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "datasheet_sub_ability.datasheetAbilityId": {
    "sourceTable": "datasheet_sub_ability",
    "sourceField": "datasheetAbilityId",
    "targetTable": "datasheet_ability",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "datasheet.allegianceAbilityGroupId": {
    "sourceTable": "datasheet",
    "sourceField": "allegianceAbilityGroupId",
    "targetTable": "allegiance_ability_group",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "general"
  },
  "datasheet.publicationId": {
    "sourceTable": "datasheet",
    "sourceField": "publicationId",
    "targetTable": "publication",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "detachment_detail_bullet_point.detachmentDetailId": {
    "sourceTable": "detachment_detail_bullet_point",
    "sourceField": "detachmentDetailId",
    "targetTable": "detachment_detail",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "detachment_detail.detachmentId": {
    "sourceTable": "detachment_detail",
    "sourceField": "detachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "detachment_excluded_datasheet.datasheetId": {
    "sourceTable": "detachment_excluded_datasheet",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "detachment_excluded_datasheet.detachmentId": {
    "sourceTable": "detachment_excluded_datasheet",
    "sourceField": "detachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "detachment_faction_detachment_points_cost.detachmentId": {
    "sourceTable": "detachment_faction_detachment_points_cost",
    "sourceField": "detachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "detachment_faction_detachment_points_cost.factionKeywordId": {
    "sourceTable": "detachment_faction_detachment_points_cost",
    "sourceField": "factionKeywordId",
    "targetTable": "faction_keyword",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "detachment_faction_keyword.detachmentId": {
    "sourceTable": "detachment_faction_keyword",
    "sourceField": "detachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "detachment_faction_keyword.factionKeywordId": {
    "sourceTable": "detachment_faction_keyword",
    "sourceField": "factionKeywordId",
    "targetTable": "faction_keyword",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "detachment_force_disposition.detachmentId": {
    "sourceTable": "detachment_force_disposition",
    "sourceField": "detachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "general"
  },
  "detachment_force_disposition.forceDispositionId": {
    "sourceTable": "detachment_force_disposition",
    "sourceField": "forceDispositionId",
    "targetTable": "force_disposition",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "general"
  },
  "detachment_granted_warlord_miniature.detachmentId": {
    "sourceTable": "detachment_granted_warlord_miniature",
    "sourceField": "detachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "detachment_granted_warlord_miniature.miniatureId": {
    "sourceTable": "detachment_granted_warlord_miniature",
    "sourceField": "miniatureId",
    "targetTable": "miniature",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "detachment_linked_datasheet.datasheetId": {
    "sourceTable": "detachment_linked_datasheet",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "detachment_linked_datasheet.detachmentId": {
    "sourceTable": "detachment_linked_datasheet",
    "sourceField": "detachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "detachment_mandatory_warlord_miniature.detachmentId": {
    "sourceTable": "detachment_mandatory_warlord_miniature",
    "sourceField": "detachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "detachment_mandatory_warlord_miniature.miniatureId": {
    "sourceTable": "detachment_mandatory_warlord_miniature",
    "sourceField": "miniatureId",
    "targetTable": "miniature",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "detachment_rule.detachmentId": {
    "sourceTable": "detachment_rule",
    "sourceField": "detachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "detachment_unique_keyword.detachmentId": {
    "sourceTable": "detachment_unique_keyword",
    "sourceField": "detachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "detachment_unique_keyword.keywordId": {
    "sourceTable": "detachment_unique_keyword",
    "sourceField": "keywordId",
    "targetTable": "keyword",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "detachment.publicationId": {
    "sourceTable": "detachment",
    "sourceField": "publicationId",
    "targetTable": "publication",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "enhancement_bodyguard_group_datasheet.datasheetId": {
    "sourceTable": "enhancement_bodyguard_group_datasheet",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "enhancement_bodyguard_group_datasheet.enhancementBodyguardGroupId": {
    "sourceTable": "enhancement_bodyguard_group_datasheet",
    "sourceField": "enhancementBodyguardGroupId",
    "targetTable": "enhancement_bodyguard_group",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "enhancement_bodyguard_group.enhancementId": {
    "sourceTable": "enhancement_bodyguard_group",
    "sourceField": "enhancementId",
    "targetTable": "enhancement",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "eligibility"
  },
  "enhancement_datasheet_ability.datasheetAbilityId": {
    "sourceTable": "enhancement_datasheet_ability",
    "sourceField": "datasheetAbilityId",
    "targetTable": "datasheet_ability",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "enhancement_datasheet_ability.enhancementId": {
    "sourceTable": "enhancement_datasheet_ability",
    "sourceField": "enhancementId",
    "targetTable": "enhancement",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "enhancement_excluded_keyword.enhancementId": {
    "sourceTable": "enhancement_excluded_keyword",
    "sourceField": "enhancementId",
    "targetTable": "enhancement",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "enhancement_excluded_keyword.keywordId": {
    "sourceTable": "enhancement_excluded_keyword",
    "sourceField": "keywordId",
    "targetTable": "keyword",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "enhancement_required_keyword_group_faction_keyword.enhancementRequiredKeywordGroupId": {
    "sourceTable": "enhancement_required_keyword_group_faction_keyword",
    "sourceField": "enhancementRequiredKeywordGroupId",
    "targetTable": "enhancement_required_keyword_group",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "enhancement_required_keyword_group_faction_keyword.factionKeywordId": {
    "sourceTable": "enhancement_required_keyword_group_faction_keyword",
    "sourceField": "factionKeywordId",
    "targetTable": "faction_keyword",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "enhancement_required_keyword_group_keyword.enhancementRequiredKeywordGroupId": {
    "sourceTable": "enhancement_required_keyword_group_keyword",
    "sourceField": "enhancementRequiredKeywordGroupId",
    "targetTable": "enhancement_required_keyword_group",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "enhancement_required_keyword_group_keyword.keywordId": {
    "sourceTable": "enhancement_required_keyword_group_keyword",
    "sourceField": "keywordId",
    "targetTable": "keyword",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "enhancement_required_keyword_group.datasheetId": {
    "sourceTable": "enhancement_required_keyword_group",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "eligibility"
  },
  "enhancement_required_keyword_group.enhancementId": {
    "sourceTable": "enhancement_required_keyword_group",
    "sourceField": "enhancementId",
    "targetTable": "enhancement",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "eligibility"
  },
  "enhancement_required_wargear_item.enhancementId": {
    "sourceTable": "enhancement_required_wargear_item",
    "sourceField": "enhancementId",
    "targetTable": "enhancement",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "enhancement_required_wargear_item.wargearItemId": {
    "sourceTable": "enhancement_required_wargear_item",
    "sourceField": "wargearItemId",
    "targetTable": "wargear_item",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "enhancement_wargear_item_profile.enhancementId": {
    "sourceTable": "enhancement_wargear_item_profile",
    "sourceField": "enhancementId",
    "targetTable": "enhancement",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "enhancement_wargear_item_profile.wargearItemProfileId": {
    "sourceTable": "enhancement_wargear_item_profile",
    "sourceField": "wargearItemProfileId",
    "targetTable": "wargear_item_profile",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "enhancement.detachmentId": {
    "sourceTable": "enhancement",
    "sourceField": "detachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "enhancement.publicationId": {
    "sourceTable": "enhancement",
    "sourceField": "publicationId",
    "targetTable": "publication",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "faction_keyword_allied_faction.alliedFactionId": {
    "sourceTable": "faction_keyword_allied_faction",
    "sourceField": "alliedFactionId",
    "targetTable": "allied_faction",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "faction_keyword_allied_faction.factionKeywordId": {
    "sourceTable": "faction_keyword_allied_faction",
    "sourceField": "factionKeywordId",
    "targetTable": "faction_keyword",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "faction_keyword_excluded_datasheet.datasheetId": {
    "sourceTable": "faction_keyword_excluded_datasheet",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "faction_keyword_excluded_datasheet.factionKeywordId": {
    "sourceTable": "faction_keyword_excluded_datasheet",
    "sourceField": "factionKeywordId",
    "targetTable": "faction_keyword",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "faction_keyword.parentFactionKeywordId": {
    "sourceTable": "faction_keyword",
    "sourceField": "parentFactionKeywordId",
    "targetTable": "faction_keyword",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "general"
  },
  "faq_config.armyRuleId": {
    "sourceTable": "faq_config",
    "sourceField": "armyRuleId",
    "targetTable": "army_rule",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "applicability"
  },
  "faq_config.datasheetId": {
    "sourceTable": "faq_config",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "applicability"
  },
  "faq_config.detachmentId": {
    "sourceTable": "faq_config",
    "sourceField": "detachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "applicability"
  },
  "faq_config.enhancementId": {
    "sourceTable": "faq_config",
    "sourceField": "enhancementId",
    "targetTable": "enhancement",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "applicability"
  },
  "faq_config.faqId": {
    "sourceTable": "faq_config",
    "sourceField": "faqId",
    "targetTable": "faq",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "faq_config.publicationId": {
    "sourceTable": "faq_config",
    "sourceField": "publicationId",
    "targetTable": "publication",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "faq_config.ruleContainerId": {
    "sourceTable": "faq_config",
    "sourceField": "ruleContainerId",
    "targetTable": "rule_container",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "applicability"
  },
  "faq_config.stratagemId": {
    "sourceTable": "faq_config",
    "sourceField": "stratagemId",
    "targetTable": "stratagem",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "applicability"
  },
  "faq.publicationId": {
    "sourceTable": "faq",
    "sourceField": "publicationId",
    "targetTable": "publication",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "force_disposition_mission_recommended_preset.forceDispositionMissionId": {
    "sourceTable": "force_disposition_mission_recommended_preset",
    "sourceField": "forceDispositionMissionId",
    "targetTable": "force_disposition_mission",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "force_disposition_mission_recommended_preset.missionPresetId": {
    "sourceTable": "force_disposition_mission_recommended_preset",
    "sourceField": "missionPresetId",
    "targetTable": "mission_preset",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "force_disposition_mission.friendlyForceDispositionId": {
    "sourceTable": "force_disposition_mission",
    "sourceField": "friendlyForceDispositionId",
    "targetTable": "force_disposition",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "applicability"
  },
  "force_disposition_mission.oppositionForceDispositionId": {
    "sourceTable": "force_disposition_mission",
    "sourceField": "oppositionForceDispositionId",
    "targetTable": "force_disposition",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "applicability"
  },
  "force_disposition_mission.primaryMissionId": {
    "sourceTable": "force_disposition_mission",
    "sourceField": "primaryMissionId",
    "targetTable": "primary_mission",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "applicability"
  },
  "invulnerable_save.datasheetId": {
    "sourceTable": "invulnerable_save",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "invulnerable_save.miniatureId": {
    "sourceTable": "invulnerable_save",
    "sourceField": "miniatureId",
    "targetTable": "miniature",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "general"
  },
  "keyword_restriction_group_keyword.keywordId": {
    "sourceTable": "keyword_restriction_group_keyword",
    "sourceField": "keywordId",
    "targetTable": "keyword",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "keyword_restriction_group_keyword.keywordRestrictionGroupId": {
    "sourceTable": "keyword_restriction_group_keyword",
    "sourceField": "keywordRestrictionGroupId",
    "targetTable": "keyword_restriction_group",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "keyword_restriction_group.excludedFactionKeywordId": {
    "sourceTable": "keyword_restriction_group",
    "sourceField": "excludedFactionKeywordId",
    "targetTable": "faction_keyword",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "eligibility"
  },
  "keyword_restriction_group.factionKeywordId": {
    "sourceTable": "keyword_restriction_group",
    "sourceField": "factionKeywordId",
    "targetTable": "faction_keyword",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "applicability"
  },
  "keyword.allyRestrictingFactionKeywordId": {
    "sourceTable": "keyword",
    "sourceField": "allyRestrictingFactionKeywordId",
    "targetTable": "faction_keyword",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "eligibility"
  },
  "keyword.allyRestrictingKeywordId": {
    "sourceTable": "keyword",
    "sourceField": "allyRestrictingKeywordId",
    "targetTable": "keyword",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "eligibility"
  },
  "limited_wargear_choice_set.datasheetId": {
    "sourceTable": "limited_wargear_choice_set",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "limited_wargear_choice_set.miniatureId": {
    "sourceTable": "limited_wargear_choice_set",
    "sourceField": "miniatureId",
    "targetTable": "miniature",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "applicability"
  },
  "limited_wargear_choice_wargear_item.limitedWargearChoiceId": {
    "sourceTable": "limited_wargear_choice_wargear_item",
    "sourceField": "limitedWargearChoiceId",
    "targetTable": "limited_wargear_choice",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "limited_wargear_choice_wargear_item.wargearItemId": {
    "sourceTable": "limited_wargear_choice_wargear_item",
    "sourceField": "wargearItemId",
    "targetTable": "wargear_item",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "limited_wargear_choice.limitedWargearChoiceSetId": {
    "sourceTable": "limited_wargear_choice",
    "sourceField": "limitedWargearChoiceSetId",
    "targetTable": "limited_wargear_choice_set",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "loadout_choice_set.datasheetId": {
    "sourceTable": "loadout_choice_set",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "loadout_choice_set.miniatureId": {
    "sourceTable": "loadout_choice_set",
    "sourceField": "miniatureId",
    "targetTable": "miniature",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "applicability"
  },
  "loadout_choice_wargear_item.loadoutChoiceId": {
    "sourceTable": "loadout_choice_wargear_item",
    "sourceField": "loadoutChoiceId",
    "targetTable": "loadout_choice",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "loadout_choice_wargear_item.wargearItemId": {
    "sourceTable": "loadout_choice_wargear_item",
    "sourceField": "wargearItemId",
    "targetTable": "wargear_item",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "eligibility"
  },
  "loadout_choice.loadoutChoiceSetId": {
    "sourceTable": "loadout_choice",
    "sourceField": "loadoutChoiceSetId",
    "targetTable": "loadout_choice_set",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "miniature_keyword.keywordId": {
    "sourceTable": "miniature_keyword",
    "sourceField": "keywordId",
    "targetTable": "keyword",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "general"
  },
  "miniature_keyword.miniatureId": {
    "sourceTable": "miniature_keyword",
    "sourceField": "miniatureId",
    "targetTable": "miniature",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "general"
  },
  "miniature.datasheetId": {
    "sourceTable": "miniature",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "mission_deployment.missionPackId": {
    "sourceTable": "mission_deployment",
    "sourceField": "missionPackId",
    "targetTable": "mission_pack",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "mission_layout_linked_deployment.missionDeploymentId": {
    "sourceTable": "mission_layout_linked_deployment",
    "sourceField": "missionDeploymentId",
    "targetTable": "mission_deployment",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "mission_layout_linked_deployment.missionLayoutId": {
    "sourceTable": "mission_layout_linked_deployment",
    "sourceField": "missionLayoutId",
    "targetTable": "mission_layout",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "mission_layout.missionPackId": {
    "sourceTable": "mission_layout",
    "sourceField": "missionPackId",
    "targetTable": "mission_pack",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "mission_preset.missionDeploymentId": {
    "sourceTable": "mission_preset",
    "sourceField": "missionDeploymentId",
    "targetTable": "mission_deployment",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "mission_preset.missionLayoutId": {
    "sourceTable": "mission_preset",
    "sourceField": "missionLayoutId",
    "targetTable": "mission_layout",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "mission_preset.missionPackId": {
    "sourceTable": "mission_preset",
    "sourceField": "missionPackId",
    "targetTable": "mission_pack",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "mission_twist.missionPackId": {
    "sourceTable": "mission_twist",
    "sourceField": "missionPackId",
    "targetTable": "mission_pack",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "primary_mission_action.primaryMissionId": {
    "sourceTable": "primary_mission_action",
    "sourceField": "primaryMissionId",
    "targetTable": "primary_mission",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "primary_mission_objective_scorable_period.primaryMissionObjectiveId": {
    "sourceTable": "primary_mission_objective_scorable_period",
    "sourceField": "primaryMissionObjectiveId",
    "targetTable": "primary_mission_objective",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "primary_mission_objective_scoring.primaryMissionObjectiveId": {
    "sourceTable": "primary_mission_objective_scoring",
    "sourceField": "primaryMissionObjectiveId",
    "targetTable": "primary_mission_objective",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "primary_mission_objective.primaryMissionId": {
    "sourceTable": "primary_mission_objective",
    "sourceField": "primaryMissionId",
    "targetTable": "primary_mission",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "primary_mission.detachmentId": {
    "sourceTable": "primary_mission",
    "sourceField": "detachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "applicability"
  },
  "primary_mission.missionPackId": {
    "sourceTable": "primary_mission",
    "sourceField": "missionPackId",
    "targetTable": "mission_pack",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "publication.factionKeywordId": {
    "sourceTable": "publication",
    "sourceField": "factionKeywordId",
    "targetTable": "faction_keyword",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "ownership"
  },
  "restriction_group_detachment_limit.detachmentId": {
    "sourceTable": "restriction_group_detachment_limit",
    "sourceField": "detachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "applicability"
  },
  "restriction_group_detachment_limit.restrictionGroupId": {
    "sourceTable": "restriction_group_detachment_limit",
    "sourceField": "restrictionGroupId",
    "targetTable": "keyword_restriction_group",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "eligibility"
  },
  "rule_container_component.armyRuleId": {
    "sourceTable": "rule_container_component",
    "sourceField": "armyRuleId",
    "targetTable": "army_rule",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "ownership"
  },
  "rule_container_component.detachmentRuleId": {
    "sourceTable": "rule_container_component",
    "sourceField": "detachmentRuleId",
    "targetTable": "detachment_rule",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "ownership"
  },
  "rule_container_component.ruleContainerId": {
    "sourceTable": "rule_container_component",
    "sourceField": "ruleContainerId",
    "targetTable": "rule_container",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "ownership"
  },
  "rule_container.behaviourTypeId": {
    "sourceTable": "rule_container",
    "sourceField": "behaviourTypeId",
    "targetTable": "behaviour_type",
    "targetField": "id",
    "cardinality": "one-to-one",
    "nullable": true,
    "meaning": "general"
  },
  "rule_container.ruleSectionId": {
    "sourceTable": "rule_container",
    "sourceField": "ruleSectionId",
    "targetTable": "rule_section",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "rule_container.stratagemId": {
    "sourceTable": "rule_container",
    "sourceField": "stratagemId",
    "targetTable": "stratagem",
    "targetField": "id",
    "cardinality": "one-to-one",
    "nullable": true,
    "meaning": "applicability"
  },
  "rule_section.publicationId": {
    "sourceTable": "rule_section",
    "sourceField": "publicationId",
    "targetTable": "publication",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "secondary_mission_action.secondaryMissionId": {
    "sourceTable": "secondary_mission_action",
    "sourceField": "secondaryMissionId",
    "targetTable": "secondary_mission",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "secondary_mission_objective_scoring.secondaryMissionObjectiveId": {
    "sourceTable": "secondary_mission_objective_scoring",
    "sourceField": "secondaryMissionObjectiveId",
    "targetTable": "secondary_mission_objective",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "secondary_mission_objective.secondaryMissionId": {
    "sourceTable": "secondary_mission_objective",
    "sourceField": "secondaryMissionId",
    "targetTable": "secondary_mission",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "secondary_mission.missionPackId": {
    "sourceTable": "secondary_mission",
    "sourceField": "missionPackId",
    "targetTable": "mission_pack",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "stratagem_phase.stratagemId": {
    "sourceTable": "stratagem_phase",
    "sourceField": "stratagemId",
    "targetTable": "stratagem",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "applicability"
  },
  "stratagem.detachmentId": {
    "sourceTable": "stratagem",
    "sourceField": "detachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "applicability"
  },
  "stratagem.publicationId": {
    "sourceTable": "stratagem",
    "sourceField": "publicationId",
    "targetTable": "publication",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "unit_composition_miniature.miniatureId": {
    "sourceTable": "unit_composition_miniature",
    "sourceField": "miniatureId",
    "targetTable": "miniature",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "general"
  },
  "unit_composition_miniature.unitCompositionId": {
    "sourceTable": "unit_composition_miniature",
    "sourceField": "unitCompositionId",
    "targetTable": "unit_composition",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "general"
  },
  "unit_composition_required_detachment.detachmentId": {
    "sourceTable": "unit_composition_required_detachment",
    "sourceField": "detachmentId",
    "targetTable": "detachment",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "eligibility"
  },
  "unit_composition_required_detachment.unitCompositionId": {
    "sourceTable": "unit_composition_required_detachment",
    "sourceField": "unitCompositionId",
    "targetTable": "unit_composition",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "eligibility"
  },
  "unit_composition_required_faction_keyword.factionKeywordId": {
    "sourceTable": "unit_composition_required_faction_keyword",
    "sourceField": "factionKeywordId",
    "targetTable": "faction_keyword",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "eligibility"
  },
  "unit_composition_required_faction_keyword.unitCompositionId": {
    "sourceTable": "unit_composition_required_faction_keyword",
    "sourceField": "unitCompositionId",
    "targetTable": "unit_composition",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "eligibility"
  },
  "unit_composition.datasheetId": {
    "sourceTable": "unit_composition",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "unit_composition.referenceGroupingKeywordId": {
    "sourceTable": "unit_composition",
    "sourceField": "referenceGroupingKeywordId",
    "targetTable": "keyword",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "applicability"
  },
  "wargear_item_profile_wargear_ability.wargearAbilityId": {
    "sourceTable": "wargear_item_profile_wargear_ability",
    "sourceField": "wargearAbilityId",
    "targetTable": "wargear_ability",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "wargear_item_profile_wargear_ability.wargearItemProfileId": {
    "sourceTable": "wargear_item_profile_wargear_ability",
    "sourceField": "wargearItemProfileId",
    "targetTable": "wargear_item_profile",
    "targetField": "id",
    "cardinality": "many-to-many-edge",
    "nullable": false,
    "meaning": "applicability"
  },
  "wargear_item_profile.wargearItemId": {
    "sourceTable": "wargear_item_profile",
    "sourceField": "wargearItemId",
    "targetTable": "wargear_item",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "wargear_limit.limitedWargearChoiceSetId": {
    "sourceTable": "wargear_limit",
    "sourceField": "limitedWargearChoiceSetId",
    "targetTable": "limited_wargear_choice_set",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "wargear_option_group.datasheetId": {
    "sourceTable": "wargear_option_group",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "wargear_option_group.miniatureId": {
    "sourceTable": "wargear_option_group",
    "sourceField": "miniatureId",
    "targetTable": "miniature",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": true,
    "meaning": "applicability"
  },
  "wargear_option.wargearItemId": {
    "sourceTable": "wargear_option",
    "sourceField": "wargearItemId",
    "targetTable": "wargear_item",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "general"
  },
  "wargear_option.wargearOptionGroupId": {
    "sourceTable": "wargear_option",
    "sourceField": "wargearOptionGroupId",
    "targetTable": "wargear_option_group",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  },
  "wargear_rule.datasheetId": {
    "sourceTable": "wargear_rule",
    "sourceField": "datasheetId",
    "targetTable": "datasheet",
    "targetField": "id",
    "cardinality": "many-to-one",
    "nullable": false,
    "meaning": "ownership"
  }
} as const;

export type MfmRelationName = keyof typeof MFM_RELATIONS;
export type MfmRelationSource<R extends MfmRelationName> = MfmRow<(typeof MFM_RELATIONS)[R]["sourceTable"]>;
export type MfmRelationTarget<R extends MfmRelationName> = MfmRow<(typeof MFM_RELATIONS)[R]["targetTable"]>;
