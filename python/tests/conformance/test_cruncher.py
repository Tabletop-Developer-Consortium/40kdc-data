"""Damage-projection engine against the cruncher conformance corpus.

Per-stage tolerance is ±5e-4 (CONFORMANCE.md); the seven-stage order and the
left-to-right reduction order are contracts.
"""

from __future__ import annotations

from typing import Any

import pytest

from wh40kdc.cruncher import crunch

from ..conftest import CORPUS

_CRUNCHER_DIR = CORPUS / "cruncher"
_CASES = sorted(p.name for p in _CRUNCHER_DIR.glob("*.json")) if _CRUNCHER_DIR.exists() else []

TOLERANCE = 5e-4


def build_engine_input(ds: Any, case: dict[str, Any]) -> dict[str, Any]:
    """Assemble an EngineInput from a corpus case's wire shape (weapon/unit by
    id). Mirrors the runner's ``buildEngineInput``."""
    weapon = ds.weapons.get_any(case["attacker"]["weaponId"])
    assert weapon is not None, f"unknown weapon {case['attacker']['weaponId']}"
    unit = ds.units.get_any(case["target"]["unitId"])
    assert unit is not None, f"unknown unit {case['target']['unitId']}"
    target: dict[str, Any] = {
        "unit": unit.raw,
        "profileIndex": case["target"]["profileIndex"],
    }
    if case["target"].get("modelCount") is not None:
        target["modelCount"] = case["target"]["modelCount"]
    return {
        "attacker": {"weapon": weapon.raw, "profileIndex": case["attacker"]["profileIndex"]},
        "target": target,
        "modelsFiring": case["modelsFiring"],
        "buffs": case.get("buffs") or [],
        "context": case["context"],
    }


@pytest.mark.skipif(not _CASES, reason="conformance corpus not available")
@pytest.mark.parametrize("case_file", _CASES)
def test_cruncher_case(dataset: Any, case_file: str) -> None:
    import json

    case = json.loads((_CRUNCHER_DIR / case_file).read_text(encoding="utf-8"))
    out = crunch(build_engine_input(dataset, case), dataset)
    expected_stages = case["expected"]["stages"]
    actual = {s["name"]: s["expected"] for s in out["stages"]}
    assert list(actual) == [
        "attacks",
        "hits",
        "wounds",
        "unsaved",
        "damage",
        "after-fnp",
        "models-killed",
    ]
    for name, expected in expected_stages.items():
        assert actual[name] == pytest.approx(expected, abs=TOLERANCE), f"{case_file} {name}"
