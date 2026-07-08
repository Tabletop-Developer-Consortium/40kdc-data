"""candidate_affordability — given the units already in a list and a points
budget, price the cheapest next copy of each candidate unit and flag whether it
still fits. Powers the list-builder's "sort cheapest-first / grey out the
unaffordable" catalog affordance, and is exposed as a cross-impl primitive so
the maths is pinned by ``conformance/affordability/``.

The cost of "one more copy" is ordinal-aware: 11e prices some datasheets by army
ordinal (see :func:`base_unit_points`), so the next copy of a datasheet you
already field twice may cost more than the first. ``nextCopyCost`` is the
cheapest *entry point* — the minimum over the unit's points tiers of
``base_unit_points(unit, tier.models, next_ordinal)`` — i.e. taking it at its
smallest legal size, at the ordinal it would enter the army.

Python mirror of ``tools/src/data/affordability.ts`` /
``crates/wh40kdc/src/data/affordability.rs`` / ``go/affordability.go``.
"""

from __future__ import annotations

import math
from typing import Any

from wh40kdc.data.battle_sizes import points_limit_for_battle_size
from wh40kdc.data.dataset import Dataset
from wh40kdc.data.pricing import base_unit_points


def _cheapest_next_copy(unit: dict[str, Any], next_ordinal: int) -> int:
    """The cheapest cost to field one more copy of ``unit`` at ``next_ordinal``."""
    tiers = unit.get("points") or []
    if not tiers:
        return 0
    best = math.inf
    for t in tiers:
        cost = base_unit_points(unit, t["models"], next_ordinal)
        if cost < best:
            best = cost
    return 0 if best == math.inf else int(best)


def candidate_affordability(spec: dict[str, Any], dataset: Dataset) -> list[dict[str, Any]]:
    """Price the cheapest next copy of each candidate and flag affordability.

    ``spec`` carries ``faction_id`` (str | None), ``battle_size`` (str | None),
    ``points_limit_override`` (int | None), ``units`` (list of dicts with
    ``unit_id``/``model_count``/optional ``enhancement_id``), and optional
    ``candidate_unit_ids`` (list of ids, else every unit in ``faction_id``).

    Returns one dict ``{"unitId", "nextCopyCost", "affordable"}`` per candidate
    that resolves in the dataset, sorted ascending by ``(nextCopyCost, unitId)``
    — deterministic for conformance.
    """
    faction_id = spec.get("faction_id")

    def resolve(unit_id: str) -> Any:
        if not unit_id:
            return None
        if faction_id:
            scoped = dataset.units.get_in_faction(unit_id, faction_id)
            if scoped is not None:
                return scoped
        return dataset.units.get_any(unit_id)

    # Running total of the current list (ordinal-aware) + enhancement costs.
    ordinals: dict[str, int] = {}
    spent = 0
    for u in spec.get("units") or []:
        unit_id = u.get("unit_id") or ""
        view = resolve(unit_id)
        if view is None:
            continue
        ordinal = ordinals.get(unit_id, 0) + 1
        ordinals[unit_id] = ordinal
        spent += base_unit_points(view.raw, u.get("model_count") or 0, ordinal)
        enhancement_id = u.get("enhancement_id")
        if enhancement_id:
            enh = dataset.enhancements.get(enhancement_id)
            spent += (enh or {}).get("cost") or 0

    override = spec.get("points_limit_override")
    limit = (
        override
        if override is not None
        else points_limit_for_battle_size(spec.get("battle_size"))
    )
    remaining = math.inf if limit is None else limit - spent

    candidate_ids = spec.get("candidate_unit_ids")
    if candidate_ids is None:
        candidate_ids = (
            [v.id for v in dataset.units.by_faction(faction_id)] if faction_id else []
        )

    out: list[dict[str, Any]] = []
    for unit_id in candidate_ids:
        view = resolve(unit_id)
        if view is None:
            continue
        next_ordinal = ordinals.get(unit_id, 0) + 1
        next_copy_cost = _cheapest_next_copy(view.raw, next_ordinal)
        out.append(
            {
                "unitId": view.id,
                "nextCopyCost": next_copy_cost,
                "affordable": next_copy_cost <= remaining,
            }
        )
    out.sort(key=lambda c: (c["nextCopyCost"], c["unitId"]))
    return out
