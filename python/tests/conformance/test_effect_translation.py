"""describe_ability (effect-DSL describer) against the effect-translation
corpus.

Exact string equality — the rendered text is the contract.
"""

from __future__ import annotations

from typing import Any

import pytest

from wh40kdc.translate import describe_ability

from ..conftest import load_corpus_json


def _cases() -> list[dict[str, Any]]:
    return load_corpus_json("effect-translation", "cases.json")


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["caseId"])
def test_effect_translation(case: dict[str, Any]) -> None:
    ability: dict[str, Any] = {"effect": case["effect"]}
    if case.get("scope") is not None:
        ability["scope"] = case["scope"]
    if case.get("usage") is not None:
        ability["usage"] = case["usage"]
    if case.get("applies_to") is not None:
        ability["applies_to"] = case["applies_to"]
    assert describe_ability(ability) == case["expected"]["text"]
