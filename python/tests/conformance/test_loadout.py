"""Loadout totals against the `loadout` conformance corpus.

Pins the damage-level totaling (sum after-FNP across weapons → kills once).
±5e-4 on both fields; the ts↔py differ enforces the same goldens cross-impl.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from wh40kdc.compare import LoadoutLine, loadout_cell

from ..conftest import CORPUS

_DIR = CORPUS / "loadout"
_CASES = sorted(p.name for p in _DIR.glob("*.json")) if _DIR.exists() else []

TOLERANCE = 5e-4


@pytest.mark.skipif(not _CASES, reason="conformance corpus not available")
@pytest.mark.parametrize("case_file", _CASES)
def test_loadout_case(dataset: Any, case_file: str) -> None:
    case = json.loads((_DIR / case_file).read_text(encoding="utf-8"))
    lines = [
        LoadoutLine(
            weapon_id=line["weaponId"],
            count=line["count"],
            profile_index=line.get("profileIndex", 0),
        )
        for line in case["lines"]
    ]
    cell = loadout_cell(
        dataset,
        lines=lines,
        target_profile_id=case["targetProfileId"],
        distance=case["distance"],
        phase=case["phase"],
    )
    assert cell["damage"] == pytest.approx(case["expected"]["damage"], abs=TOLERANCE), case_file
    assert cell["kills"] == pytest.approx(case["expected"]["kills"], abs=TOLERANCE), case_file


def test_completion_relaxes_a_repeated_co_item_after_strict_counts_fail() -> None:
    """A source may count a shared part once per printed choice branch."""
    from wh40kdc.data.loadout import complete_loadout

    completed = complete_loadout(
        {"id": "fabricated-unit", "weapon_ids": ["rifle"]},
        2,
        [
            {
                "replaces": ["rifle"],
                "replacement_choice": [
                    ["shared-part", "blade"],
                    ["shared-part", "lance"],
                ],
                "model_constraint": {"any_number": True},
            }
        ],
        [{"name": "Trooper", "min": 2, "max": 2, "default_weapon_ids": ["rifle"]}],
        # The importer has accumulated the shared printed part from both
        # branches. It cannot be carried four times by two models.
        {"shared-part": 4, "blade": 1, "lance": 1},
    )

    assert completed is not None
    assert completed["counts"] == {"shared-part": 2, "blade": 1, "lance": 1}


def test_grouping_prefers_the_same_candidate_order_for_ambiguous_models() -> None:
    from wh40kdc.data.loadout import group_loadout

    groups = group_loadout(
        {"id": "fabricated-unit", "weapon_ids": ["rifle"]},
        2,
        [
            {
                "replaces": ["rifle"],
                "replacement_choice": [["alpha"], ["beta"]],
                "model_constraint": {"any_number": True},
            }
        ],
        [{"name": "Trooper", "min": 2, "max": 2, "default_weapon_ids": ["rifle"]}],
        {"alpha": 1, "beta": 1},
    )

    assert groups == [
        {"model_name": "Trooper", "count": 1, "weapons": [{"id": "alpha", "count": 1}]},
        {"model_name": "Trooper", "count": 1, "weapons": [{"id": "beta", "count": 1}]},
    ]
