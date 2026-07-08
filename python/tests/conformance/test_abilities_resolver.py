"""Abilities resolver + DSL→Buff translation against the abilities-resolver
conformance corpus.

The eligible-abilities cases compare ability-id sets grouped by source kind
(order within kinds is unpinned); the from-dsl cases pin applied-buff list
order, unsupported-reason strings, and activatable levers.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from wh40kdc.cruncher import effect_to_buffs

from ..conftest import CORPUS

_DIR = CORPUS / "abilities-resolver"
_RESOLVER_CASES = (
    sorted(
        p.name
        for p in _DIR.glob("*.json")
        if not p.name.endswith("from-dsl.json")
    )
    if _DIR.exists()
    else []
)


@pytest.mark.skipif(not _RESOLVER_CASES, reason="conformance corpus not available")
@pytest.mark.parametrize("case_file", _RESOLVER_CASES)
def test_eligible_abilities(dataset: Any, case_file: str) -> None:
    case = json.loads((_DIR / case_file).read_text(encoding="utf-8"))
    grouped: dict[str, list[str]] = {}
    for entry in dataset.eligible_abilities(case["input"], case["phase"]):
        grouped.setdefault(entry["source"]["kind"], []).append(entry["ability"].id)
    for ids in grouped.values():
        ids.sort()
    assert grouped == case["expected"]


def _run_dsl_corpus(dataset: Any, filename: str) -> None:
    dsl = json.loads((_DIR / filename).read_text(encoding="utf-8"))
    for c in dsl["cases"]:
        ability = dataset.abilities.get_any(c["abilityId"])
        assert ability is not None, f"unknown ability {c['abilityId']}"
        perspective = c.get("perspective", "attacker")
        result = effect_to_buffs(ability.raw.get("effect"), c["source"], c["context"], perspective)
        applied_contribs = [b["contribution"] for b in result["applied"]]
        assert applied_contribs == c["expected"]["applied"], f"{c['abilityId']} ({perspective})"
        reasons = [u["reason"] for u in result["unsupported"]]
        assert reasons == c["expected"]["unsupportedReasons"], f"{c['abilityId']} ({perspective})"
        if "activatable" in c["expected"]:
            acts = [
                {
                    "id": a["id"],
                    "label": a["label"],
                    "group": a.get("group"),
                    "buffs": [b["contribution"] for b in a["buffs"]],
                }
                for a in result["activatable"]
            ]
            expected_acts = [
                {**e, "group": e.get("group")} for e in c["expected"]["activatable"]
            ]
            assert acts == expected_acts, f"{c['abilityId']} ({perspective})"


@pytest.mark.skipif(not _DIR.exists(), reason="conformance corpus not available")
def test_from_dsl_corpus(dataset: Any) -> None:
    _run_dsl_corpus(dataset, "from-dsl.json")


@pytest.mark.skipif(not _DIR.exists(), reason="conformance corpus not available")
def test_defensive_from_dsl_corpus(dataset: Any) -> None:
    _run_dsl_corpus(dataset, "defensive-from-dsl.json")
