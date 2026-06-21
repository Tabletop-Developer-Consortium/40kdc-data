"""Single-weapon flat ``wargear_budgets`` clamp on the loadout maths.

A 1-model unit with two independent swap slots that can each add the same weapon
(cf. the Knight Destrier: chastiser gatling cannon AND frag bombard can each
become a bellatus reaper chainsword) would otherwise sum to an illegal count. The
"max one" rule is modelled as a single-item per-unit budget, and
:func:`maximal_loadout`/:func:`weapon_bounds` must honour it so a count consumer
(the salvo calculator) never seeds an over-cap value. Mirrors the TS/Rust/Go
loadout tests.
"""

from __future__ import annotations

from wh40kdc.data.loadout import clamp_weapon_count, maximal_loadout, weapon_bounds

_UNIT = {
    "weapon_ids": ["gun-a", "gun-b"],
    "wargear_budgets": [{"items": ["sword"], "count": 1, "per_models": 0}],
}
_OPTS = [
    {"id": "o1", "unit_id": "u", "replaces": ["gun-a"], "replacement": ["sword"], "model_constraint": {"any_number": True}},
    {"id": "o2", "unit_id": "u", "replaces": ["gun-b"], "replacement": ["sword"], "model_constraint": {"any_number": True}},
]


def test_bounds_capped_at_budget_not_sum_of_slots() -> None:
    assert weapon_bounds(_UNIT, 1, _OPTS)["sword"] == {"min": 0, "max": 1}


def test_maximal_loadout_capped_at_budget() -> None:
    assert maximal_loadout(_UNIT, 1, _OPTS)["sword"] == 1


def test_user_input_clamped_to_budget() -> None:
    assert clamp_weapon_count(weapon_bounds(_UNIT, 1, _OPTS), "sword", 2) == 1


def test_shared_budget_left_to_validate() -> None:
    # Two distinct weapons sharing one allowance must not be clamped per-id here.
    shared = {
        "weapon_ids": ["gun-a", "gun-b"],
        "wargear_budgets": [{"items": ["sword", "spear"], "count": 1, "per_models": 0}],
    }
    opts = [
        {"id": "o1", "unit_id": "u", "replaces": ["gun-a"], "replacement": ["sword"], "model_constraint": {"any_number": True}},
        {"id": "o2", "unit_id": "u", "replaces": ["gun-b"], "replacement": ["spear"], "model_constraint": {"any_number": True}},
    ]
    bounds = weapon_bounds(shared, 1, opts)
    assert bounds["sword"] == {"min": 0, "max": 1}
    assert bounds["spear"] == {"min": 0, "max": 1}
