"""Unit tests for the ordinal-aware pricing + base-loadout package API."""

from __future__ import annotations

from typing import Any

from wh40kdc import base_loadout, base_unit_points, points_tier_missing


def _we_chaos_terminators(dataset: Any) -> dict[str, Any]:
    # Shared id with Emperor's Children, so resolve the World Eaters copy.
    return dataset.units.get_in_faction("chaos-terminators", "world-eaters").raw


def test_ordinal_bands(dataset: Any) -> None:
    ct = _we_chaos_terminators(dataset)
    # 1st-2nd army copy: lower band.
    assert base_unit_points(ct, 5, 1) == 175
    assert base_unit_points(ct, 5, 2) == 175
    assert base_unit_points(ct, 10, 1) == 350
    # 3rd+ copy: higher band (open-ended top).
    assert base_unit_points(ct, 5, 3) == 185
    assert base_unit_points(ct, 10, 3) == 360
    assert base_unit_points(ct, 5, 7) == 185
    # Defaults to the 1st copy.
    assert base_unit_points(ct, 5) == 175


def test_unbanded_unit_ignores_ordinal(dataset: Any) -> None:
    bz = dataset.units.get("khorne-berzerkers").raw
    assert base_unit_points(bz, 10, 1) == base_unit_points(bz, 10, 99)


def test_points_tier_missing(dataset: Any) -> None:
    ct = _we_chaos_terminators(dataset)
    assert not points_tier_missing(ct, 5, 1)
    assert not points_tier_missing(ct, 5, 3)
    assert points_tier_missing(ct, 4, 1)


def test_range_priced_tier_venatari(dataset: Any) -> None:
    # 3 models @160, or 4-6 models @320 (a GW range-priced tier, models_max=6).
    ven = dataset.units.get_in_faction("venatari-custodians", "adeptus-custodes").raw
    assert ven["points"] == [
        {"models": 3, "cost": 160},
        {"models": 4, "models_max": 6, "cost": 320},
    ]
    assert base_unit_points(ven, 3) == 160
    assert base_unit_points(ven, 4) == 320
    assert base_unit_points(ven, 5) == 320
    assert base_unit_points(ven, 6) == 320
    # Outside every tier range → missing (below floor, above ceiling).
    assert points_tier_missing(ven, 2)
    assert not points_tier_missing(ven, 4)
    assert not points_tier_missing(ven, 6)
    assert points_tier_missing(ven, 7)


def test_base_loadout_is_legal_default(dataset: Any) -> None:
    bz = dataset.units.get("khorne-berzerkers")
    options = dataset.wargear_options_of(bz.raw)
    assert base_loadout(bz.raw, 10, options) == {
        "bolt-pistol-khorne-berzerkers": 10,
        "chainblade": 10,
    }
