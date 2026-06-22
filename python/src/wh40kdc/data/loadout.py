"""Wargear-loadout maths shared by every consumer of the dataset.

How many models may take an option, what the maximal (take-every-swap) loadout
looks like, the valid count range for each weapon, and whether an edited
loadout is legal.

The base loadout is derived, not stored: a weapon in ``unit.weapon_ids`` that
never appears as the *replacement* of any option is a **base** weapon, carried
by every model; a weapon that does appear as a replacement is **optional**,
carried only by the models that took the swap.

Python mirror of ``tools/src/data/loadout.ts`` /
``crates/wh40kdc/src/data/loadout.rs``.
"""

from __future__ import annotations

import math
from typing import Any

WargearOption = dict[str, Any]
Unit = dict[str, Any]
# A unit-composition model row, as far as loadout maths cares: ``min``, ``max``,
# optional ``default_weapon_ids`` (list, may be empty/absent), and
# ``is_leader_model`` (bool). Pass the unit's ``unit_composition.models`` here.
LoadoutModel = dict[str, Any]


def option_cap(
    option: WargearOption,
    model_count: int,
    models: list[LoadoutModel] | None = None,
) -> int:
    """Maximum number of models that may take ``option`` in a unit of ``model_count``.

    ``any_number`` → all models; else ``per_n_models`` → floor(n / per); else
    ``max_count ?? 1``; then clamped by ``max_count`` when set. A null
    constraint is treated as unrestricted (every model). Never negative.
    """
    c = option.get("model_constraint")
    if not c:
        return max(0, model_count)
    if c.get("any_number"):
        cap = model_count
    elif c.get("per_n_models"):
        cap = math.floor(model_count / c["per_n_models"])
    else:
        max_count = c.get("max_count")
        cap = max_count if max_count is not None else 1
    if c.get("max_count") is not None:
        cap = min(cap, c["max_count"])
    # Eligible-model clamp: an option scoped to a named model profile can be taken by
    # no more models than exist of that profile — a lone champion caps the swap at 1
    # even when per_n_models would allow more. A name with no matching row leaves the
    # cap unclamped.
    if c.get("model_name") and models:
        eligible = _eligible_model_count(models, model_count, c["model_name"])
        if eligible is not None:
            cap = min(cap, eligible)
    # A swap is per-model: at most one per model, so never more than model_count —
    # a max_count larger than the current squad size must not drive a weapon count
    # negative.
    return max(0, min(cap, model_count))


def _eligible_model_count(
    models: list[LoadoutModel],
    model_count: int,
    name: str,
) -> int | None:
    """How many models of profile ``name`` a unit of ``model_count`` fields, per
    :func:`_allocate_models`. ``None`` when no row carries that name."""
    if not any(m.get("name") == name for m in models):
        return None
    n = 0
    for model, count in _allocate_models(models, model_count):
        if model.get("name") == name:
            n += count
    return n


def _added_ids(option: WargearOption, choice_index: int = 0) -> list[str]:
    """The ids a single option can add, given the chosen choice branch (default 0)."""
    if option.get("replacement"):
        return option["replacement"]
    choices = option.get("replacement_choice") or []
    if 0 <= choice_index < len(choices):
        return choices[choice_index]
    return []


def _all_replacement_ids(options: list[WargearOption]) -> set[str]:
    """Every id that any option can add — across all choice branches."""
    out: set[str] = set()
    for o in options:
        out.update(o.get("replacement") or [])
        for group in o.get("replacement_choice") or []:
            out.update(group)
    return out


def _all_replaced_ids(options: list[WargearOption]) -> set[str]:
    """Every id that any option swaps OUT (the base weapon a swap replaces)."""
    out: set[str] = set()
    for o in options:
        out.update(o.get("replaces") or [])
    return out


def _base_weapon_ids(unit: Unit, options: list[WargearOption]) -> list[str]:
    """Derived base (always-carried) weapon ids — the fallback when a unit has no
    recorded ``default_weapon_ids``.

    A ``weapon_id`` is base iff it is swapped out by some option (``replaces``) OR
    it never appears on any option's *added* side. The ``replaces`` clause is
    load-bearing: a base weapon can also be re-added inside another option's choice
    branch and is still base. An *orphan* weapon (in ``weapon_ids``, touched by no
    option) stays base.
    """
    added = _all_replacement_ids(options)
    replaced = _all_replaced_ids(options)
    return [id_ for id_ in unit.get("weapon_ids") or [] if id_ in replaced or id_ not in added]


def _has_recorded_defaults(models: list[LoadoutModel] | None) -> bool:
    """True when every model row records a non-empty default loadout."""
    if not models:
        return False
    return all((m.get("default_weapon_ids") or []) for m in models)


def _allocate_models(
    models: list[LoadoutModel],
    model_count: int,
) -> list[tuple[LoadoutModel, int]]:
    """Allocate ``model_count`` models across the composition's model-types.

    Each leader is taken at its ``min`` (in declared order, never exceeding the
    remaining count), then the non-leader "bulk" types absorb the rest — each its
    ``min`` first, then any leftover to the bulk type with the largest ``max``.
    Deterministic; mirrored across implementations and pinned by the conformance
    corpus.
    """
    out: list[list[Any]] = [[model, 0] for model in models]
    remaining = max(0, model_count)
    # Leaders first, at their declared minimum.
    for row in out:
        if not row[0].get("is_leader_model"):
            continue
        c = min(row[0].get("min") or 0, remaining)
        row[1] += c
        remaining -= c
    bulk = [row for row in out if not row[0].get("is_leader_model")]
    if not bulk:
        # No non-leader type: pour any remainder onto the leaders (largest max first).
        bulk = list(out)
    # Each bulk type takes its min, then the remainder lands on the largest-max type.
    for row in bulk:
        c = min(row[0].get("min") or 0, remaining)
        row[1] += c
        remaining -= c
    if remaining > 0 and bulk:
        sink = bulk[0]
        for row in bulk:
            if (row[0].get("max") or 0) > (sink[0].get("max") or 0):
                sink = row
        sink[1] += remaining
    return [(row[0], row[1]) for row in out]


def _base_counts(
    unit: Unit,
    model_count: int,
    options: list[WargearOption],
    models: list[LoadoutModel] | None = None,
) -> dict[str, int]:
    """The base loadout counts: id → count across the unit with no swaps applied.

    When the composition records per-model ``default_weapon_ids``, those are
    authoritative — base = Σ over model-types of (allocated count × default
    weapons). Otherwise it falls back to :func:`_base_weapon_ids` × ``model_count``.
    """
    counts: dict[str, int] = {}
    if _has_recorded_defaults(models):
        assert models is not None
        for model, count in _allocate_models(models, model_count):
            if count == 0:
                continue
            for id_ in model.get("default_weapon_ids") or []:
                counts[id_] = counts.get(id_, 0) + count
        return counts
    for id_ in _base_weapon_ids(unit, options):
        counts[id_] = counts.get(id_, 0) + model_count
    return counts


def base_loadout(
    unit: Unit,
    model_count: int,
    options: list[WargearOption],
    models: list[LoadoutModel] | None = None,
) -> dict[str, int]:
    """The base loadout: id → count, every base weapon on every model, no swaps.

    This is the legal default a freshly-added unit ships with — each model in
    its out-of-the-box configuration. Reads the composition's recorded
    ``default_weapon_ids`` when present (authoritative), otherwise derives the
    base set. :func:`maximal_loadout` starts from this set and then applies every
    option at full cap.
    """
    return _base_counts(unit, model_count, options, models)


def maximal_loadout(
    unit: Unit,
    model_count: int,
    options: list[WargearOption],
    models: list[LoadoutModel] | None = None,
) -> dict[str, int]:
    """The maximal loadout: id → count across the unit.

    Every base weapon on every model, then each option applied at its full
    :func:`option_cap` (choices take their first branch). Swaps move count
    from the replaced id to the added id; add-ons only add.
    """
    counts: dict[str, int] = _base_counts(unit, model_count, options, models)
    for option in options:
        cap = option_cap(option, model_count, models)
        if cap == 0:
            continue
        for id_ in option.get("replaces") or []:
            counts[id_] = counts.get(id_, 0) - cap
        for id_ in _added_ids(option):
            counts[id_] = counts.get(id_, 0) + cap
    _clamp_flat_budgets(unit, counts)
    # Drop any id that nets to zero so the loadout reads cleanly.
    return {id_: n for id_, n in counts.items() if n != 0}


def _clamp_flat_budgets(unit: Unit, counts: dict[str, int]) -> None:
    """Cap each weapon's count by any single-weapon flat ``wargear_budgets`` entry.

    A "this model takes at most N of weapon X" line is modelled as ``items`` of
    length 1 with ``per_models == 0``. A weapon reachable through several swap
    slots — e.g. a Knight Destrier whose chastiser gatling cannon AND frag
    bombard can each be swapped for a bellatus reaper chainsword — would
    otherwise sum to an illegal count; clamping here makes
    :func:`maximal_loadout`/:func:`weapon_bounds` agree with the same
    invalid-loadout prevention the editor enforces. Shared (multi-item) and ratio
    (``per_models > 0``) budgets stay policed by :func:`validate_loadout`.
    """
    for budget in unit.get("wargear_budgets") or []:
        items = budget.get("items") or []
        if len(items) != 1 or budget.get("per_models", 0) != 0:
            continue
        id_ = items[0]
        cap = budget["count"]
        if id_ in counts and counts[id_] > cap:
            counts[id_] = cap


def weapon_bounds(
    unit: Unit,
    model_count: int,
    options: list[WargearOption],
    models: list[LoadoutModel] | None = None,
) -> dict[str, dict[str, int]]:
    """Inclusive valid count range (``{"min", "max"}``) for each weapon/wargear id.

    A base weapon ranges ``[model_count − max swaps away, model_count]``; an
    optional (replacement) id ranges ``[0, Σ caps that add it]``.
    """
    bounds: dict[str, dict[str, int]] = {}
    for id_, count in _base_counts(unit, model_count, options, models).items():
        bounds[id_] = {"min": count, "max": count}
    for option in options:
        cap = option_cap(option, model_count, models)
        for id_ in option.get("replaces") or []:
            b = bounds.get(id_, {"min": 0, "max": 0})
            bounds[id_] = {"min": max(0, b["min"] - cap), "max": b["max"]}
        # A replacement id can appear in multiple options / both choice
        # branches; sum the caps so its ceiling reflects every way to add it.
        adds: set[str] = set(option.get("replacement") or [])
        for group in option.get("replacement_choice") or []:
            adds.update(group)
        for id_ in adds:
            b = bounds.get(id_, {"min": 0, "max": 0})
            bounds[id_] = {"min": b["min"], "max": b["max"] + cap}
    # A single-weapon flat budget caps the weapon's ceiling regardless of how
    # many swap slots can add it (see :func:`_clamp_flat_budgets`), so an
    # editor/salvo input clamped against these bounds can never reach an
    # over-cap, illegal count.
    for budget in unit.get("wargear_budgets") or []:
        items = budget.get("items") or []
        if len(items) != 1 or budget.get("per_models", 0) != 0:
            continue
        entry = bounds.get(items[0])
        cap = budget["count"]
        if entry is not None and entry["max"] > cap:
            bounds[items[0]] = {"min": min(entry["min"], cap), "max": cap}
    return bounds


def clamp_weapon_count(
    bounds: dict[str, dict[str, int]],
    id: str,
    requested: float,
) -> int:
    """Clamp a single weapon's requested count into its valid range.

    Ids with no bound (not part of this unit's loadout) are returned unchanged
    but floored at zero.
    """
    try:
        n = max(0, math.floor(requested))
    except (ValueError, OverflowError):
        n = 0
    b = bounds.get(id)
    if b is None:
        return n
    return min(b["max"], max(b["min"], n))


def validate_loadout(
    unit: Unit,
    model_count: int,
    options: list[WargearOption],
    counts: dict[str, int],
    models: list[LoadoutModel] | None = None,
) -> list[dict[str, str]]:
    """Report every weapon/wargear count that falls outside its valid range."""
    bounds = weapon_bounds(unit, model_count, options, models)
    out: list[dict[str, str]] = []
    # Items governed by a shared-allowance budget are policed solely by
    # :func:`_budget_violations`; their per-id ``weapon_bounds`` max is derived
    # from the dump's cross-product loadout branches (the unreliable signal the
    # budget replaces), so skip the per-id check for them.
    budgeted: set[str] = set()
    for b in unit.get("wargear_budgets") or []:
        budgeted.update(b.get("items") or [])
    for id_, n in counts.items():
        if id_ in budgeted:
            continue
        b = bounds.get(id_)
        if b is None:
            continue
        if n > b["max"]:
            out.append(
                {"id": id_, "code": "exceeds-max", "message": f"{id_}: {n} exceeds max {b['max']}"}
            )
        elif n < b["min"]:
            out.append(
                {"id": id_, "code": "below-min", "message": f"{id_}: {n} below min {b['min']}"}
            )
    out.extend(_swap_conflicts(unit, model_count, options, counts, models))
    out.extend(_budget_violations(unit, model_count, counts))
    # Deterministic order so the result is stable for cross-impl comparison.
    out.sort(key=lambda v: (v["id"], v["code"]))
    return out


def _budget_violations(
    unit: Unit,
    model_count: int,
    counts: dict[str, int],
) -> list[dict[str, str]]:
    """Shared-allowance violations: each ``wargear_budgets`` entry lets its listed
    items take at most ``floor(model_count * count / per_models)`` copies between
    them (``per_models == 0`` is a flat per-unit cap of ``count``). The violation
    ``id`` is the budget's sorted items joined by ``+``. Mirror of the TS reference.
    """
    out: list[dict[str, str]] = []
    for budget in unit.get("wargear_budgets") or []:
        items = budget.get("items") or []
        if not items:
            continue
        used = sum(counts.get(id_, 0) for id_ in items)
        per_models = budget.get("per_models") or 0
        count = budget.get("count")
        if per_models:
            cap = math.floor(model_count * count / per_models)
            limit = f"{count} per {per_models} models"
        else:
            cap = count
            limit = f"{count} per unit"
        if used > cap:
            id_ = "+".join(sorted(items))
            out.append(
                {
                    "id": id_,
                    "code": "exceeds-allowance",
                    "message": f"{id_}: {used} exceeds shared allowance {cap} ({limit})",
                }
            )
    return out


def _tier_models(tier: dict[str, Any], base: list[LoadoutModel]) -> list[LoadoutModel]:
    """Merge a tier's per-model count ranges onto the composition's ``models``
    metadata by name, producing the model list the loadout maths consume."""
    by_name = {m.get("name"): m for m in base}
    out: list[LoadoutModel] = []
    for tm in tier.get("models") or []:
        b = by_name.get(tm.get("name"))
        merged = dict(b) if b else {}
        merged["name"] = tm.get("name")
        merged["min"] = tm.get("min")
        merged["max"] = tm.get("max")
        out.append(merged)
    return out


def check_unit_legality(
    unit: Unit,
    model_count: int,
    options: list[WargearOption],
    counts: dict[str, int],
    models: list[LoadoutModel] | None = None,
    tiers: list[dict[str, Any]] | None = None,
) -> list[dict[str, str]]:
    """Whole-unit legality, tier-aware — the building block for a roster check.

    A roster records only the *total* ``model_count``, so select every tier whose
    total range ``[Σmin, Σmax]`` contains it and run :func:`validate_loadout`
    against each tier's allocation; the unit is legal iff **some** containing tier
    validates clean. Deterministic reporting: the empty result of the first clean
    tier (in tier order), else the violations of the first containing tier; an
    ``invalid-model-count`` violation when the size matches no tier. With no tiers
    it falls back to a plain :func:`validate_loadout`. Mirror of the TS reference.
    """
    if not tiers:
        return validate_loadout(unit, model_count, options, counts, models)
    base = models or []
    candidates: list[list[LoadoutModel]] = []
    for tier in tiers:
        tm = _tier_models(tier, base)
        lo = sum((m.get("min") or 0) for m in tm)
        hi = sum((m.get("max") or 0) for m in tm)
        if lo <= model_count <= hi:
            candidates.append(tm)
    if not candidates:
        uid = unit["id"]
        return [
            {
                "id": uid,
                "code": "invalid-model-count",
                "message": f"{uid}: {model_count} models matches no composition tier",
            }
        ]
    first: list[dict[str, str]] | None = None
    for tm in candidates:
        violations = validate_loadout(unit, model_count, options, counts, tm)
        if not violations:
            return []
        if first is None:
            first = violations
    return first or []


def _swap_conflicts(
    unit: Unit,
    model_count: int,
    options: list[WargearOption],
    counts: dict[str, int],
    models: list[LoadoutModel] | None = None,
) -> list[dict[str, str]]:
    """Swap-conservation violations the per-id :func:`weapon_bounds` can't see.

    A model's replaceable slot holds the base weapon OR one of its swap
    replacements, never both, so ``count(base) + sum(count(replacements))``
    cannot exceed its base count. Enforced only for the unambiguous shape — a
    base weapon swapped out by plain (non-choice) options that replace it alone,
    whose replacement ids are unique within this unit's option set and aren't
    themselves base weapons. Mirror of ``tools/src/data/loadout.ts``.
    """
    base_map = _base_counts(unit, model_count, options, models)
    base_ids = set(base_map.keys())
    added_by: dict[str, int] = {}
    for o in options:
        for id_ in o.get("replacement") or []:
            added_by[id_] = added_by.get(id_, 0) + 1
        for group in o.get("replacement_choice") or []:
            for id_ in group:
                added_by[id_] = added_by.get(id_, 0) + 1
    out: list[dict[str, str]] = []
    for base in base_ids:
        clean_adds: set[str] = set()
        messy = False
        for o in options:
            replaces = o.get("replaces") or []
            if base not in replaces:
                continue
            if len(replaces) != 1 or (o.get("replacement_choice") or []):
                messy = True
                break
            for b in o.get("replacement") or []:
                if b in base_ids or added_by.get(b, 0) > 1:
                    messy = True
                    break
                clean_adds.add(b)
            if messy:
                break
        if messy or not clean_adds:
            continue
        # The slot can hold at most as many weapons as there are models carrying
        # this base weapon by default — its base count (model_count when not
        # per-model).
        cap = base_map.get(base, model_count)
        total = counts.get(base, 0) + sum(counts.get(b, 0) for b in clean_adds)
        if total > cap:
            out.append(
                {
                    "id": base,
                    "code": "swap-conflict",
                    "message": (
                        f"{base} and its swap replacement(s) total {total}, "
                        f"exceeding {cap} (a model takes the base weapon "
                        f"or a swap, not both)"
                    ),
                }
            )
    return out
