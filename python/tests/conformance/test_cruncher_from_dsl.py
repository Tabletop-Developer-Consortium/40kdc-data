"""Ability DSL to cruncher-buff translation contracts."""

from __future__ import annotations

from typing import Any

from wh40kdc.cruncher import effect_to_buffs


def _named_region(
    keywords: list[str],
    operator: str = "or",
    default_effect: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "type": "named-region-state",
        "target": "all-friendly",
        "modifier": {
            "consumer": {
                "beneficiary_gate": {"operator": operator, "keywords": keywords},
                "default_branch": {
                    "effect": default_effect
                    or {
                        "type": "re-roll",
                        "target": "attacker",
                        "modifier": {"roll": "hit", "subset": "ones"},
                    }
                },
                "qualified_branch": {
                    "effect": {
                        "type": "re-roll",
                        "target": "attacker",
                        "modifier": {"roll": "hit", "result_scope": "any-result"},
                    }
                },
            }
        },
    }


def _source() -> dict[str, Any]:
    return {"kind": "ability", "abilityId": "named-region-test", "abilityKind": "unit"}


def test_named_region_matching_or_applies_default_and_reports_qualified() -> None:
    result = effect_to_buffs(
        _named_region(["CRYPTEK", "CANOPTEK"]),
        _source(),
        {"phase": "shooting", "attackerKeywords": ["canoptek"]},
    )
    assert [buff["contribution"] for buff in result["applied"]] == [
        {"type": "reroll", "roll": "hit", "subset": "ones"}
    ]
    assert "qualified replacement" in result["unsupported"][0]["reason"]


def test_named_region_nonmatching_gate_applies_neither_branch() -> None:
    result = effect_to_buffs(
        _named_region(["CRYPTEK", "CANOPTEK"]),
        _source(),
        {"phase": "shooting", "attackerKeywords": ["WARRIOR"]},
    )
    assert result["applied"] == []
    assert result["unsupported"] == []


def test_named_region_qualified_branch_is_explicitly_unsupported() -> None:
    result = effect_to_buffs(
        _named_region(["CRYPTEK"]),
        _source(),
        {"phase": "shooting", "attackerKeywords": ["CRYPTEK"]},
    )
    assert any("qualified replacement" in item["reason"] for item in result["unsupported"])


def test_named_region_weapon_keyword_narrowing_is_not_applied_broadly() -> None:
    result = effect_to_buffs(
        _named_region(
            ["THOUSAND SONS"],
            "and",
            {
                "type": "re-roll",
                "target": "attacker",
                "modifier": {"roll": "wound", "subset": "ones", "weapon_keyword": "Psychic"},
            },
        ),
        _source(),
        {"phase": "shooting", "attackerKeywords": ["thousand sons"]},
    )
    assert result["applied"] == []
    assert any(
        "weapon_keyword\" which the cruncher can't resolve here" in item["reason"]
        for item in result["unsupported"]
    )
