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
LOADOUT_CANDIDATES_DEFAULT_LIMIT = 256
LOADOUT_CANDIDATES_TRUNCATED = "…truncated"


def _js_locale_key(value: str) -> str:
    """The ordering domain here is canonical entity ids: lowercase ASCII letters,
    digits, and hyphens. In that domain the repository's Node ``localeCompare``
    ordering is ordinal, and Python compares ``str`` by code point, so the string
    is its own sort key. Kept as a named function to mark the ``localeCompare``
    mirror points in the solver. Entity ids are schema-normalized before reaching
    loadout solving."""
    return value


def option_cap(
    option: WargearOption,
    model_count: int,
    models: list[LoadoutModel] | None = None,
) -> int:
    """Maximum number of TIMES ``option`` may be taken in a unit of ``model_count``.

    ``any_number`` alone → once per model; ``any_number`` WITH ``max_count: L``
    → up to L per model (a multi-take mount: "up to 2 seeker missiles", "up to
    three of the following, and can take duplicates"); else ``per_n_models`` →
    floor(n / per), clamped by ``max_count`` when set; else ``max_count ?? 1``
    (a flat allowance). A null constraint is treated as unrestricted (every
    model). Never negative.
    """
    c = option.get("model_constraint")
    if not c:
        return max(0, model_count)
    # Per-model multiplicity: >1 only for the any_number+max_count multi-take
    # shape; every other shape takes an option at most once per model.
    max_count = c.get("max_count")
    per_model = (max_count if max_count is not None else 1) if c.get("any_number") else 1
    if c.get("any_number"):
        cap = model_count * per_model
    elif c.get("per_n_models"):
        cap = math.floor(model_count / c["per_n_models"])
    else:
        cap = max_count if max_count is not None else 1
    if not c.get("any_number") and max_count is not None:
        cap = min(cap, max_count)
    # Eligible-model clamp: an option scoped to a named model profile can be taken
    # by no more models than exist of that profile (× the per-model multiplicity) —
    # a lone champion caps the swap at 1 even when per_n_models would allow more.
    # A name with no matching row leaves the cap unclamped.
    if c.get("model_name") and models:
        eligible = _eligible_model_count(models, model_count, c["model_name"])
        if eligible is not None:
            cap = min(cap, eligible * per_model)
    # At most per_model takes per model, so never more than model_count × per_model —
    # a flat max_count larger than the current squad size must not drive a swapped
    # weapon count negative.
    return max(0, min(cap, model_count * per_model))


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


# A loadout group: ``{"model_name": str|None, "count": int, "weapons": [{"id", "count"}]}``.
# ``weapons[].count`` is per model in the group. Mirror of the TS ``LoadoutGroup``.
LoadoutGroup = dict[str, Any]


def _to_multiset(ids: list[str]) -> dict[str, int]:
    m: dict[str, int] = {}
    for id_ in ids:
        m[id_] = m.get(id_, 0) + 1
    return m


def _sorted_group_weapons(m: dict[str, int]) -> list[dict[str, Any]]:
    """Group weapons in a stable, language-agnostic order (by id) for cross-impl parity."""
    return [
        {"id": id_, "count": c}
        for id_, c in sorted(m.items(), key=lambda item: _js_locale_key(item[0]))
        if c > 0
    ]


def _option_bundles(option: WargearOption) -> list[list[str]]:
    """The bundles (added-id sets) an option offers: a fixed ``replacement``, else
    each ``replacement_choice`` branch."""
    if option.get("replacement"):
        return [list(option["replacement"])]
    return [list(b) for b in (option.get("replacement_choice") or [])]


def _assign_row_counts(
    models: list[LoadoutModel],
    model_count: int,
    counts: dict[str, int],
) -> list[int]:
    """Assign each composition row a model count summing to ``model_count``.

    Rows seed at ``min``; a row with a *distinctive* default weapon (one carried by
    no other row) present in ``counts`` grows toward that weapon's implied count
    (recovers opt-in weapon-variant rows at ``min: 0``); the leftover budget pours
    into the bulk row. Deterministic. Mirror of the TS ``assignRowCounts``.
    """
    row_defaults = [_to_multiset(m.get("default_weapon_ids") or []) for m in models]
    rows_with: dict[str, int] = {}
    for def_ in row_defaults:
        for id_ in def_:
            rows_with[id_] = rows_with.get(id_, 0) + 1

    def min_of(i: int) -> int:
        value = models[i].get("min")
        return max(0, value if value is not None else 0)

    def max_of(i: int) -> int:
        value = models[i].get("max")
        return max(min_of(i), value if value is not None else min_of(i))

    out = [min_of(i) for i in range(len(models))]
    total = sum(out)
    budget = max(0, model_count - total)
    if total > model_count:
        over = total - model_count
        for i in range(len(out) - 1, -1, -1):
            if over == 0:
                break
            cut = min(over, out[i])
            out[i] -= cut
            over -= cut
        budget = 0

    distinctive = [False] * len(models)
    for i in range(len(models)):
        if budget == 0:
            break
        cap: int | None = None
        saw = False
        for id_, mult in row_defaults[i].items():
            if rows_with.get(id_, 0) == 1 and mult > 0 and counts.get(id_, 0) > 0:
                saw = True
                v = counts[id_] // mult
                cap = v if cap is None else min(cap, v)
        if not saw or cap is None:
            continue
        distinctive[i] = True
        add = max(0, min(min(cap, max_of(i)) - out[i], budget))
        out[i] += add
        budget -= add

    def headroom(i: int) -> int:
        return max_of(i) - out[i]

    while budget > 0:
        pick: int | None = None
        for i in range(len(models)):
            if headroom(i) <= 0 or models[i].get("is_leader_model") or distinctive[i]:
                continue
            if pick is None or headroom(i) > headroom(pick):
                pick = i
        if pick is None:
            for i in range(len(models)):
                if headroom(i) <= 0:
                    continue
                if pick is None or headroom(i) > headroom(pick):
                    pick = i
        if pick is None:
            break
        add = min(budget, headroom(pick))
        out[pick] += add
        budget -= add
    return out


def _candidate_row_counts(
    models: list[LoadoutModel],
    model_count: int,
    counts: dict[str, int],
) -> list[list[int]]:
    """Return every bounded row allocation, with the historical heuristic first."""
    preferred = _assign_row_counts(models, model_count, counts)
    mins = [max(0, model["min"] if model.get("min") is not None else 0) for model in models]
    maxs = [
        max(mins[i], model["max"] if model.get("max") is not None else mins[i])
        for i, model in enumerate(models)
    ]
    suffix_min = [0] * (len(models) + 1)
    suffix_max = [0] * (len(models) + 1)
    for i in range(len(models) - 1, -1, -1):
        suffix_min[i] = suffix_min[i + 1] + mins[i]
        suffix_max[i] = suffix_max[i + 1] + maxs[i]

    generated: list[list[int]] = []
    current = [0] * len(models)

    def visit(i: int, remaining: int) -> None:
        if i == len(models):
            if remaining == 0:
                generated.append(list(current))
            return
        if remaining < suffix_min[i] or remaining > suffix_max[i]:
            return
        lo = max(mins[i], remaining - suffix_max[i + 1])
        hi = min(maxs[i], remaining - suffix_min[i + 1])
        for count in range(hi, lo - 1, -1):
            current[i] = count
            visit(i + 1, remaining - count)

    visit(0, max(0, model_count))
    out: list[list[int]] = []
    seen: set[tuple[int, ...]] = set()
    for allocation in [preferred, *generated]:
        key = tuple(allocation)
        if sum(allocation) == model_count and key not in seen:
            seen.add(key)
            out.append(allocation)
    return out


def _multiset_key(m: dict[str, int]) -> str:
    """A stable key for a weapon multiset: ``count:id`` parts in id order, joined by
    ``|``; zero/negative entries dropped. Mirror of the TS ``multisetKey``."""
    return "|".join(
        f"{c}:{id_}"
        for id_, c in sorted(m.items(), key=lambda item: _js_locale_key(item[0]))
        if c > 0
    )


def _enumerate_row_candidates(
    base: dict[str, int],
    row_name: str | None,
    options: list[WargearOption],
) -> list[dict[str, Any]]:
    """Enumerate every legal single-model loadout for one composition row: from the
    row's base defaults, apply any compatible subset of the options scoping to this
    row (unscoped, or matching ``row_name``). An option applies only when all its
    ``replaces`` weapons are present (a slot swapped at most once), used at most once
    per model; each ``replacement_choice`` branch is a distinct transformation. Caps
    are charged globally by the assignment search, so two derivations of the same
    weapon set with different option usage are kept distinct. Mirror of the TS
    ``enumerateRowCandidates``."""
    applicable: list[int] = []
    for i, option in enumerate(options):
        c = option.get("model_constraint")
        name = c.get("model_name") if c else None
        if name is None or name == row_name:
            applicable.append(i)

    def state_key(w: dict[str, int], used: list[int]) -> str:
        return f"{_multiset_key(w)}#{','.join(str(u) for u in used)}"

    result: list[dict[str, Any]] = []
    seen: set[str] = {state_key(base, [])}
    queue: list[tuple[dict[str, int], list[int]]] = [(dict(base), [])]
    head = 0
    while head < len(queue):
        weapons, used = queue[head]
        head += 1
        result.append({"weapons": weapons, "used_options": used, "key": _multiset_key(weapons)})
        for oi in applicable:
            option = options[oi]
            replaces = list(option.get("replaces") or [])
            uses = used.count(oi)
            constraint = option.get("model_constraint") or {}
            max_count = constraint.get("max_count")
            per_model_limit = (max_count if max_count is not None else 1) if not replaces else 1
            if uses >= per_model_limit:
                continue
            if not all(weapons.get(id_, 0) >= 1 for id_ in replaces):
                continue
            for bundle in _option_bundles(options[oi]):
                if not bundle:
                    continue
                w = dict(weapons)
                for id_ in replaces:
                    w[id_] = w.get(id_, 0) - 1
                for id_ in bundle:
                    w[id_] = w.get(id_, 0) + 1
                w = {id_: n for id_, n in w.items() if n > 0}
                new_used = sorted([*used, oi])
                k = state_key(w, new_used)
                if k in seen:
                    continue
                seen.add(k)
                queue.append((w, new_used))
    return result


def _options_with_printed_unit_abilities(
    unit: Unit, options: list[WargearOption], counts: dict[str, int]
) -> list[WargearOption]:
    reachable = {
        id_
        for option in options
        for ids in (
            option.get("replaces") or [],
            option.get("replacement") or [],
            *(option.get("replacement_choice") or []),
        )
        for id_ in ids
    }
    additions = [
        {
            "id": f"{unit['id']}-printed-ability-{id_}",
            "unit_id": unit["id"],
            "faction_id": unit.get("faction_id"),
            "game_version": unit.get("game_version"),
            "is_free": True,
            "replacement": [id_],
            "model_constraint": {"max_count": counts[id_]},
        }
        for id_ in (unit.get("ability_ids") or [])
        if counts.get(id_, 0) > 0 and id_ not in reachable
    ]
    return list(options) if not additions else [*options, *additions]


def _solve_assignment(
    rows: list[dict[str, Any]],
    lower: dict[str, int],
    upper: dict[str, int],
    option_caps: list[int],
) -> list[dict[str, Any]] | None:
    """Deterministically distribute row models within item lower and upper bounds."""
    remaining_lower = dict(lower)
    remaining_upper = dict(upper)
    usage = [0] * len(option_caps)
    picks: list[tuple[int, int, int]] = []

    def assign_row(ri: int) -> bool:
        if ri == len(rows):
            return all(count <= 0 for count in remaining_lower.values())
        return distribute(ri, 0, rows[ri]["count"])

    def distribute(ri: int, ci: int, left: int) -> bool:
        row = rows[ri]
        candidates = row["candidates"]
        if ci == len(candidates):
            return left == 0 and assign_row(ri + 1)
        candidate = candidates[ci]
        hi = left
        for id_, per in candidate["weapons"].items():
            if per > 0:
                hi = min(hi, remaining_upper.get(id_, 0) // per)
        option_uses: dict[int, int] = {}
        for oi in candidate["used_options"]:
            option_uses[oi] = option_uses.get(oi, 0) + 1
        for oi, per_model in option_uses.items():
            hi = min(hi, (option_caps[oi] - usage[oi]) // per_model)
        for take in range(max(0, hi), -1, -1):
            for id_, per in candidate["weapons"].items():
                remaining_lower[id_] = remaining_lower.get(id_, 0) - per * take
                remaining_upper[id_] = remaining_upper.get(id_, 0) - per * take
            for oi in candidate["used_options"]:
                usage[oi] += take
            if take > 0:
                picks.append((ri, ci, take))
            if distribute(ri, ci + 1, left - take):
                return True
            if take > 0:
                picks.pop()
            for oi in candidate["used_options"]:
                usage[oi] -= take
            for id_, per in candidate["weapons"].items():
                remaining_lower[id_] = remaining_lower.get(id_, 0) + per * take
                remaining_upper[id_] = remaining_upper.get(id_, 0) + per * take
        return False

    if not assign_row(0):
        return None
    return [
        {
            "ri": ri,
            "name": rows[ri]["name"],
            "weapons": rows[ri]["candidates"][ci]["weapons"],
            "count": count,
        }
        for ri, ci, count in picks
    ]


def _groups_from_solution(solution: list[dict[str, Any]]) -> list[LoadoutGroup]:
    by_group: dict[str, dict[str, Any]] = {}
    for item in solution:
        key = _multiset_key(item["weapons"])
        group_key = f"{item['name'] or ''}##{key}"
        current = by_group.get(group_key)
        if current is not None:
            current["count"] += item["count"]
        else:
            by_group[group_key] = {
                "ri": item["ri"],
                "name": item["name"],
                "weapons": item["weapons"],
                "count": item["count"],
                "key": key,
            }
    live = [group for group in by_group.values() if group["count"] > 0]
    live.sort(key=lambda group: (group["ri"], -group["count"], _js_locale_key(group["key"])))
    return [
        {
            "model_name": group["name"],
            "count": group["count"],
            "weapons": _sorted_group_weapons(group["weapons"]),
        }
        for group in live
    ]


def complete_loadout(
    unit: Unit,
    model_count: int,
    options: list[WargearOption],
    models: list[LoadoutModel] | None,
    explicit_counts: dict[str, int],
) -> dict[str, Any] | None:
    n = max(0, int(model_count))
    if n == 0 or not _has_recorded_defaults(models):
        return None
    assert models is not None

    strict_lower = {id_: count for id_, count in explicit_counts.items() if count > 0}
    lower_variants = [strict_lower]
    default_ids = {id_ for model in models for id_ in (model.get("default_weapon_ids") or [])}
    repeated_co_items: set[str] = set()
    for option in options:
        occurrences: dict[str, int] = {}
        for branch in option.get("replacement_choice") or []:
            if len(branch) < 2:
                continue
            for id_ in dict.fromkeys(branch):
                occurrences[id_] = occurrences.get(id_, 0) + 1
        for id_, count in occurrences.items():
            if count >= 2 and id_ not in default_ids:
                repeated_co_items.add(id_)
    relaxed_lower = dict(strict_lower)
    for id_ in repeated_co_items:
        relaxed_lower.pop(id_, None)
    if len(relaxed_lower) != len(strict_lower):
        lower_variants.append(relaxed_lower)

    effective_options = _options_with_printed_unit_abilities(unit, options, explicit_counts)
    for lower in lower_variants:
        for row_counts in _candidate_row_counts(models, n, lower):
            fixed_models = [
                {**model, "min": row_counts[index], "max": row_counts[index]}
                for index, model in enumerate(models)
            ]
            default_counts: dict[str, int] = {}
            for index, model in enumerate(fixed_models):
                count = row_counts[index]
                if count <= 0:
                    continue
                for id_ in model.get("default_weapon_ids") or []:
                    default_counts[id_] = default_counts.get(id_, 0) + count
            upper = dict(default_counts)
            for id_, explicit in explicit_counts.items():
                upper[id_] = max(explicit, upper.get(id_, 0))

            option_caps = [option_cap(option, n, fixed_models) for option in effective_options]
            rows: list[dict[str, Any]] = []
            for index, model in enumerate(fixed_models):
                count = row_counts[index]
                if count <= 0:
                    continue
                candidates = [
                    candidate
                    for candidate in _enumerate_row_candidates(
                        _to_multiset(model.get("default_weapon_ids") or []),
                        model.get("name"),
                        effective_options,
                    )
                    if all(
                        per <= 0 or upper.get(id_, 0) >= per
                        for id_, per in candidate["weapons"].items()
                    )
                    and all(option_caps[oi] >= 1 for oi in candidate["used_options"])
                ]
                candidates.sort(
                    key=lambda candidate: (
                        len(candidate["used_options"]),
                        _js_locale_key(candidate["key"]),
                        _js_locale_key(",".join(map(str, candidate["used_options"]))),
                    )
                )
                rows.append(
                    {
                        "name": model.get("name"),
                        "count": count,
                        "candidates": candidates,
                    }
                )
            solution = _solve_assignment(rows, lower, upper, option_caps)
            if solution is None:
                continue
            groups = _groups_from_solution(solution)
            counts: dict[str, int] = {}
            for group in groups:
                for weapon in group["weapons"]:
                    counts[weapon["id"]] = (
                        counts.get(weapon["id"], 0) + weapon["count"] * group["count"]
                    )
            return {"counts": counts, "groups": groups if n > 1 else None}
    return None


def group_loadout(
    unit: Unit,
    model_count: int,
    options: list[WargearOption],
    models: list[LoadoutModel] | None,
    counts: dict[str, int],
) -> list[LoadoutGroup] | None:
    """Prove and decompose a flat loadout across every feasible model allocation."""
    n = max(0, int(model_count))
    if n <= 1 or not _has_recorded_defaults(models):
        return None
    assert models is not None

    bag = {id_: count for id_, count in counts.items() if count > 0}
    effective_options = _options_with_printed_unit_abilities(unit, options, bag)
    for row_counts in _candidate_row_counts(models, n, bag):
        fixed_models = [
            {**model, "min": row_counts[index], "max": row_counts[index]}
            for index, model in enumerate(models)
        ]
        option_caps = [option_cap(option, n, fixed_models) for option in effective_options]
        rows: list[dict[str, Any]] = []
        for index, model in enumerate(models):
            count = row_counts[index]
            if count <= 0:
                continue
            candidates = [
                candidate
                for candidate in _enumerate_row_candidates(
                    _to_multiset(model.get("default_weapon_ids") or []),
                    model.get("name"),
                    effective_options,
                )
                if all(
                    per <= 0 or bag.get(id_, 0) >= per for id_, per in candidate["weapons"].items()
                )
                and all(option_caps[oi] >= 1 for oi in candidate["used_options"])
            ]
            candidates.sort(
                key=lambda candidate: (
                    _js_locale_key(candidate["key"]),
                    len(candidate["used_options"]),
                    _js_locale_key(",".join(map(str, candidate["used_options"]))),
                )
            )
            rows.append(
                {
                    "name": model.get("name"),
                    "count": count,
                    "candidates": candidates,
                }
            )

        solution = _solve_assignment(rows, bag, bag, option_caps)
        if solution is None:
            continue
        groups = _groups_from_solution(solution)
        if groups:
            return groups
    return None


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
        # Within one branch, multiplicity counts: a twin-mount swap authored
        # ['lascannon', 'lascannon'] adds TWO per take (maximal_loadout already
        # honors this — collapsing to a set here capped every paired sponson,
        # Forgefiend ectoplasma, and 2-particle-beamer Spyder at half its legal
        # count). Across branches an id's ceiling uses its largest single branch.
        add_mult: dict[str, int] = {}
        branches = (
            [option["replacement"]]
            if option.get("replacement")
            else (option.get("replacement_choice") or [])
        )
        for group in branches:
            per: dict[str, int] = {}
            for id_ in group:
                per[id_] = per.get(id_, 0) + 1
            for id_, n in per.items():
                add_mult[id_] = max(add_mult.get(id_, 0), n)
        for id_, n in add_mult.items():
            b = bounds.get(id_, {"min": 0, "max": 0})
            bounds[id_] = {"min": b["min"], "max": b["max"] + cap * n}
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
    budgets = _budget_violations(unit, model_count, counts)
    if models is not None and len(models) > 1:
        if group_loadout(unit, model_count, options, models, counts) is not None:
            return budgets
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
    out.extend(budgets)
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
        # Per-item sub-cap: at most ``duplicate_limit`` copies of any ONE item, on
        # top of the shared allowance. Mirror of the TS reference.
        dup = budget.get("duplicate_limit")
        if dup is not None:
            if per_models:
                dup_cap = math.floor(model_count * dup / per_models)
                dup_limit = f"{dup} per {per_models} models"
            else:
                dup_cap = dup
                dup_limit = f"{dup} per unit"
            for id_ in sorted(items):
                n = counts.get(id_, 0)
                if n > dup_cap:
                    out.append(
                        {
                            "id": id_,
                            "code": "exceeds-allowance",
                            "message": (
                                f"{id_}: {n} exceeds per-item duplicate cap {dup_cap} ({dup_limit})"
                            ),
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


def loadout_candidates(
    unit: Unit,
    model_count: int,
    options: list[WargearOption],
    models: list[LoadoutModel] | None = None,
    tiers: list[dict[str, Any]] | None = None,
    limit: int | None = None,
) -> list[str]:
    """Enumerate variant-aware, tier-legal model allocations in canonical order."""
    total = max(0, int(model_count))
    cap = max(0, int(limit if limit is not None else LOADOUT_CANDIDATES_DEFAULT_LIMIT))
    base = models or []
    row_sets: list[list[LoadoutModel]] = []
    if tiers:
        for tier in tiers:
            rows = _tier_models(tier, base)
            if sum(max(0, m.get("min") or 0) for m in rows) <= total <= sum(
                max(m.get("min") or 0, m.get("max") or 0) for m in rows
            ):
                row_sets.append(rows)
    elif base:
        row_sets.append(base)

    encoded: set[str] = set()
    for rows in row_sets:
        for allocation in _candidate_row_counts(rows, total, {}):
            if any(row.get("loadout_variants") for row in rows):
                selections = [
                    _variant_selections(row, allocation[index], total)
                    for index, row in enumerate(rows)
                ]

                def combine(index: int, witness: list[str], counts: dict[str, int]) -> None:
                    if index == len(selections):
                        count_text = ",".join(
                            f"{id_}:{count}"
                            for id_, count in sorted(counts.items())
                            if count > 0
                        )
                        encoded.add(f"{';'.join(witness)} => {count_text}")
                        return
                    for selection in selections[index]:
                        next_counts = dict(counts)
                        for id_, count in selection["counts"].items():
                            next_counts[id_] = next_counts.get(id_, 0) + count
                        combine(index + 1, [*witness, *selection["witness"]], next_counts)

                combine(0, [], {})
                continue
            witness = ";".join(
                f"{rows[i].get('name') or ''}×{count}"
                for i, count in enumerate(allocation)
                if count
            )
            counts: dict[str, int] = {}
            if _has_recorded_defaults(rows):
                for i, count in enumerate(allocation):
                    for id_ in rows[i].get("default_weapon_ids") or []:
                        counts[id_] = counts.get(id_, 0) + count
            else:
                for id_ in _base_weapon_ids(unit, options):
                    counts[id_] = counts.get(id_, 0) + total
            count_text = ",".join(f"{id_}:{count}" for id_, count in sorted(counts.items()) if count > 0)
            encoded.add(f"{witness} => {count_text}")
    out = sorted(encoded)
    return out if len(out) <= cap else [*out[:cap], LOADOUT_CANDIDATES_TRUNCATED]


def _variant_budget_cap(budget: dict[str, Any], unit_count: int, row_count: int) -> int:
    if budget["per_models"] == 0:
        return budget["count"]
    models = unit_count if budget["scope"] == "unit" else row_count
    return math.floor(models * budget["count"] / budget["per_models"])


def _variant_selections(row: LoadoutModel, row_count: int, unit_count: int) -> list[dict[str, Any]]:
    if row_count == 0:
        return [{"witness": [], "counts": {}}]
    variants = row.get("loadout_variants") or []
    if not variants:
        counts: dict[str, int] = {}
        for id_ in row.get("default_weapon_ids") or []:
            counts[id_] = counts.get(id_, 0) + row_count
        return [{"witness": [f"{row.get('name') or ''}×{row_count}"], "counts": counts}]

    out: list[dict[str, Any]] = []
    selected = [0] * len(variants)

    def visit(index: int, remaining: int) -> None:
        if index == len(variants):
            if remaining:
                return
            for budget in row.get("loadout_variant_budgets") or []:
                names = set(budget["variant_names"])
                used = sum(
                    selected[i] for i, variant in enumerate(variants) if variant["name"] in names
                )
                if used > _variant_budget_cap(budget, unit_count, row_count):
                    return
            witness: list[str] = []
            counts: dict[str, int] = {}
            for i, variant in enumerate(variants):
                if selected[i] == 0:
                    continue
                witness.append(f"{variant['name']}×{selected[i]}")
                for id_ in variant["weapon_ids"]:
                    counts[id_] = counts.get(id_, 0) + selected[i]
            out.append({"witness": witness, "counts": counts})
            return
        maximum = min(remaining, variants[index].get("max_count", remaining))
        for count in range(maximum, -1, -1):
            selected[index] = count
            visit(index + 1, remaining - count)

    visit(0, row_count)
    return out


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
    base weapon swapped out by plain (non-choice), single-item options that
    replace it alone, whose replacement ids are unique within this unit's option
    set and aren't themselves base weapons, and where the base weapon is not
    itself addable by another option. A 1→N bundle swap (one item out, several
    in) and a base weapon that another option can add both defeat the
    single-slot pool, so they stay on the looser per-id bounds. Mirror of
    ``tools/src/data/loadout.ts``.
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
            # Only a plain, single-target, single-item swap of this exact base
            # weapon is unambiguous. A 1→N bundle (Lychguard warscythe → shield +
            # sword) yields TWO added copies per freed slot — summing each against
            # the slot pool double-counts every bundle swap, so it stays on the
            # looser bounds.
            if (
                len(replaces) != 1
                or (o.get("replacement_choice") or [])
                or len(o.get("replacement") or []) > 1
            ):
                messy = True
                break
            for b in o.get("replacement") or []:
                if b in base_ids or added_by.get(b, 0) > 1:
                    messy = True
                    break
                clean_adds.add(b)
            if messy:
                break
        # A base weapon that is itself ADDABLE by another option lives on several
        # models' slots at once (the Krieg power weapon: the Commissar's default
        # AND a Veteran's chainsword upgrade) — the single-slot pool can't
        # attribute its copies, so it too stays on the per-id bounds.
        if messy or not clean_adds or added_by.get(base, 0) > 0:
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
