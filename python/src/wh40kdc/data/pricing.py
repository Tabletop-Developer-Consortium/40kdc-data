"""Unit point-cost maths shared by every consumer of the dataset.

Given a unit, a model count, and the unit's army ordinal, which ``points`` tier
applies.

11e prices some datasheets by **army ordinal** — how many copies of that
datasheet you have already taken. The schema models this with optional
``unit_count_min``/``unit_count_max`` bands on each ``points`` tier (1-based,
inclusive; an open-ended top band has ``unit_count_max: null``). Selecting a cost
is a two-step filter: keep the tiers whose ordinal band contains this copy, then
pick the highest model-count tier the count reaches. A tier with no
``unit_count_min`` is unbanded and applies to every copy (the common case). Only
native ``points`` are handled here; ``allied_points`` is a separate concern.

Python mirror of ``tools/src/data/pricing.ts`` /
``crates/wh40kdc/src/data/pricing.rs``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

Unit = dict[str, Any]
PointsTier = dict[str, Any]


def _tier_covers_ordinal(tier: PointsTier, ordinal: int) -> bool:
    """True when ``ordinal`` (1-based army copy) falls within ``tier``'s band."""
    minimum = tier.get("unit_count_min")
    if minimum is None:
        return True  # unbanded: applies to every copy
    if ordinal < minimum:
        return False
    maximum = tier.get("unit_count_max")
    return maximum is None or ordinal <= maximum


def base_unit_points(unit: Unit, model_count: int, ordinal: int = 1) -> int:
    """Base point cost for a unit of ``model_count`` models as its ``ordinal``-th copy.

    Among the tiers whose ordinal band covers this copy (1-based; defaults to the
    1st copy), returns the cost of the highest ``models`` threshold the count
    reaches (lowest tier when none is reached). ``models`` is the tier's range
    floor (a range-priced tier spans ``models``..``models_max`` at one cost, e.g.
    Venatari 4–6 @320), so a count inside a range resolves to that range's cost.
    Returns 0 when no tier applies — the caller surfaces a violation rather than
    guessing.
    """
    tiers = sorted(
        (t for t in unit.get("points") or [] if _tier_covers_ordinal(t, ordinal)),
        key=lambda t: t["models"],
    )
    if not tiers:
        return 0
    chosen = tiers[0]
    for t in tiers:
        if model_count >= t["models"]:
            chosen = t
    return chosen["cost"]


def points_tier_missing(unit: Unit, model_count: int, ordinal: int = 1) -> bool:
    """True when no points tier covers ``model_count`` for this ``ordinal``.

    The count falls outside every tier's ``[models, models_max]`` range (below the
    smallest tier, above the largest, or in a gap between non-contiguous tiers),
    or the ordinal has no banded price. A single-size tier (no ``models_max``)
    covers only ``models``. Mirrors the band filter of :func:`base_unit_points`.
    """
    tiers = [t for t in unit.get("points") or [] if _tier_covers_ordinal(t, ordinal)]
    if not tiers:
        return True
    return not any(
        t["models"] <= model_count <= (t.get("models_max") or t["models"]) for t in tiers
    )


def wargear_points(unit: Unit, counts: Mapping[str, int]) -> int:
    """Per-item MFM wargear surcharge for a unit whose final loadout has ``counts``
    copies of each weapon/wargear id.

    Each ``wargear_costs`` entry charges ``cost`` for every copy of ``item_id``
    present — a Terminator Assault Squad's five thunder hammers add 25, a Chapter
    Ancient's Banner of Macragge adds 10. Items with no cost entry are free; absent
    ``wargear_costs`` contributes 0, so a unit's total is
    ``base_unit_points + wargear_points + enhancement``. Mirror of
    ``tools/src/data/pricing.ts`` ``wargearPoints``.
    """
    total = 0
    for wc in unit.get("wargear_costs") or []:
        total += wc["cost"] * max(0, counts.get(wc["item_id"], 0))
    return total
