/**
 * Unit point-cost maths shared by every consumer of the dataset: given a unit,
 * a model count, and the unit's army ordinal, which `points` tier applies.
 *
 * 11e prices some datasheets by **army ordinal** — how many copies of that
 * datasheet you have already taken. The schema models this with optional
 * `unit_count_min`/`unit_count_max` bands on each `points` tier (1-based,
 * inclusive; an open-ended top band has `unit_count_max: null`). Every band
 * repeats across each model-count tier, e.g. World Eaters Chaos Terminators:
 *
 *   5m=175 [#1-2], 10m=350 [#1-2], 5m=185 [#3+], 10m=360 [#3+]
 *
 * Selecting a cost is therefore a two-step filter: keep the tiers whose ordinal
 * band contains this copy, then pick the highest model-count tier the count
 * reaches. A tier with no `unit_count_min` is unbanded and applies to every copy
 * (the common case). Only native `points` are handled here; `allied_points`
 * (host-army pricing) is a separate concern. Mirror of
 * `crates/wh40kdc/src/data/pricing.rs`.
 *
 * @packageDocumentation
 */
import type { Unit } from "../generated.js";

type PointsTier = NonNullable<Unit["points"]>[number];

/** True when `ordinal` (1-based army copy) falls within `tier`'s ordinal band. */
function tierCoversOrdinal(tier: PointsTier, ordinal: number): boolean {
  const min = tier.unit_count_min;
  if (min == null) return true; // unbanded: applies to every copy
  if (ordinal < min) return false;
  const max = tier.unit_count_max;
  return max == null || ordinal <= max;
}

/**
 * Base point cost for a unit of `modelCount` models taken as its `ordinal`-th
 * army copy (1-based; defaults to the 1st copy). Among the tiers whose ordinal
 * band covers this copy, returns the cost of the highest `models` threshold the
 * count reaches (lowest tier when none is reached). `models` is the tier's range
 * floor (a range-priced tier spans `models`..`models_max` at one cost, e.g.
 * Venatari 4–6 @320), so a count inside a range resolves to that range's cost.
 * Returns 0 when no tier applies — the caller surfaces a violation rather than
 * guessing.
 */
export function baseUnitPoints(unit: Unit, modelCount: number, ordinal = 1): number {
  const tiers = (unit.points ?? [])
    .filter((t) => tierCoversOrdinal(t, ordinal))
    .slice()
    .sort((a, b) => a.models - b.models);
  if (tiers.length === 0) return 0;
  let chosen = tiers[0];
  for (const t of tiers) {
    if (modelCount >= t.models) chosen = t;
  }
  return chosen.cost;
}

/**
 * True when no points tier covers `modelCount` for this `ordinal` — the count
 * falls outside every tier's `[models, models_max]` range (below the smallest
 * tier, above the largest, or in a gap between non-contiguous tiers), or the
 * ordinal has no banded price. A single-size tier (no `models_max`) covers only
 * `models`. Mirrors the band filter of {@link baseUnitPoints}.
 */
export function pointsTierMissing(unit: Unit, modelCount: number, ordinal = 1): boolean {
  const tiers = (unit.points ?? []).filter((t) => tierCoversOrdinal(t, ordinal));
  if (tiers.length === 0) return true;
  return !tiers.some((t) => t.models <= modelCount && modelCount <= (t.models_max ?? t.models));
}
