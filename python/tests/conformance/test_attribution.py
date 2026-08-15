"""Leave-one-out attribution against the attribution conformance corpus.

Values compare within ±5e-4; lift order (first-seen group order) is
load-bearing and compared exactly.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from wh40kdc.cruncher import attribute_stages

from ..conftest import load_corpus_json
from .test_cruncher import _CRUNCHER_DIR, TOLERANCE, build_engine_input


def _cases() -> list[dict[str, Any]]:
    return load_corpus_json("attribution", "cases.json")


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["name"][:50])
def test_attribution_case(dataset: Any, case: dict[str, Any]) -> None:
    cruncher_case = json.loads((_CRUNCHER_DIR / case["cruncher_case"]).read_text(encoding="utf-8"))
    stages = attribute_stages(build_engine_input(dataset, cruncher_case), dataset)
    expected = case["expected"]
    assert len(stages) == len(expected)
    for actual_stage, expected_stage in zip(stages, expected, strict=True):
        assert actual_stage["name"] == expected_stage["name"]
        for field in ("expected", "baseline", "residual"):
            assert actual_stage[field] == pytest.approx(expected_stage[field], abs=TOLERANCE), (
                f"{expected_stage['name']}.{field}"
            )
        assert actual_stage["intrinsics"] == expected_stage["intrinsics"]
        assert len(actual_stage["lifts"]) == len(expected_stage["lifts"])
        # Lift order is load-bearing (first-seen group order).
        for actual_lift, expected_lift in zip(
            actual_stage["lifts"], expected_stage["lifts"], strict=True
        ):
            assert actual_lift["source"] == expected_lift["source"]
            assert actual_lift["delta"] == pytest.approx(expected_lift["delta"], abs=TOLERANCE)
