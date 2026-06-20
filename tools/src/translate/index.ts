/**
 * Plain-English translation of structured game data — the `secondary-card`
 * scoring `awards` (mission "how to play" readouts), the shared Ability-DSL
 * condition humanizer, and the Ability-DSL effect describer ("ability.print()").
 * Output is ASCII-only and pinned across language ports by the
 * `conformance/scoring-translation` and `conformance/effect-translation`
 * corpora.
 */
export { describeCondition, dekebab, type Condition } from "./condition.js";
export {
  describeTrigger,
  describeAward,
  describeScoringCard,
  type ScoringTrigger,
  type ScoringAward,
  type ScoringMode,
} from "./scoring.js";
export {
  describeEffect,
  describeEffectInline,
  describeAbility,
  describeAppliesTo,
  describeScope,
  type Effect,
  type AbilityScope,
  type AbilityAppliesTo,
  type AbilityUsage,
  type AbilityLike,
} from "./effect.js";
