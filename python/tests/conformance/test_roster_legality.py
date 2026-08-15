"""Tier-aware whole-unit loadout legality against the roster_legality corpus.

Mirrors the runner's ``check_unit_legality`` op: resolve the unit (faction-scoped
when pinned), look up its faction's composition, and compare the sorted
``"code:id"`` violation strings exactly. Ties out with the TS reference and the
Rust/Go ports via ``conformance/roster_legality/cases.json``.
"""

from __future__ import annotations

from typing import Any

import pytest

from wh40kdc.data.bundle import empty_raw_data
from wh40kdc.data.dataset import Dataset
from wh40kdc.data.loadout import check_unit_legality
from wh40kdc.data.roster import validate_roster_core

from ..conftest import load_corpus_json


def _cases() -> list[dict[str, Any]]:
    return load_corpus_json("roster_legality", "cases.json")


def run_case(ds: Any, args: dict[str, Any]) -> list[str]:
    faction_id = args.get("factionId")
    unit = (
        ds.units.get_in_faction(args["unitId"], faction_id)
        if isinstance(faction_id, str)
        else ds.units.get_any(args["unitId"])
    )
    assert unit is not None, f"unknown unit {args['unitId']}"
    comp = next(
        (
            c
            for c in ds.unit_compositions
            if c.get("unit_id") == args["unitId"]
            and c.get("faction_id") == unit.raw.get("faction_id")
        ),
        None,
    )
    violations = check_unit_legality(
        unit.raw,
        args["modelCount"],
        ds.wargear_options_of(unit.raw),
        {k: int(v) for k, v in (args.get("counts") or {}).items()},
        (comp or {}).get("models"),
        (comp or {}).get("tiers"),
    )
    return sorted(f"{v['code']}:{v['id']}" for v in violations)


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["name"])
def test_roster_legality_case(dataset: Any, case: dict[str, Any]) -> None:
    assert run_case(dataset, case["args"]) == case["expected"]


def test_conditional_and_name_keywords_satisfy_enhancement_eligibility() -> None:
    raw = empty_raw_data()
    raw["factions"] = [{"id": "fabricated", "name": "Fabricated", "keywords": []}]
    raw["detachments"] = [
        {"id": "fabricated-detachment", "name": "Formation", "faction_id": "fabricated"}
    ]
    raw["units"] = [
        {
            "id": "named-bearer",
            "name": "Named Bearer",
            "faction_id": "fabricated",
            "role": "character",
            "conditional_keywords": [
                {"keyword": "Granted", "required_detachment_id": "fabricated-detachment"}
            ],
        }
    ]
    raw["enhancements"] = [
        {
            "id": "named-relic",
            "name": "Named Relic",
            "detachment_id": "fabricated-detachment",
            "keyword_restriction_groups": [["Granted"], ["Named Bearer"]],
        }
    ]
    result = validate_roster_core(
        {
            "faction_id": "fabricated",
            "detachment_ids": ["fabricated-detachment"],
            "units": [
                {
                    "unit_id": "named-bearer",
                    "model_count": 1,
                    "is_warlord": True,
                    "enhancement_id": "named-relic",
                    "counts": {},
                }
            ],
        },
        Dataset(raw),
    )
    assert "enhancement-keyword-mismatch" not in [v["code"] for v in result["army"]]


def test_enhancement_grants_an_additional_legal_bodyguard() -> None:
    raw = empty_raw_data()
    raw["factions"] = [{"id": "fabricated", "name": "Fabricated", "keywords": []}]
    raw["detachments"] = [
        {"id": "fabricated-detachment", "name": "Formation", "faction_id": "fabricated"}
    ]
    raw["units"] = [
        {"id": "leader", "name": "Leader", "faction_id": "fabricated", "role": "character"},
        {"id": "granted-bodyguard", "name": "Granted Bodyguard", "faction_id": "fabricated"},
    ]
    raw["enhancements"] = [
        {
            "id": "attachment-relic",
            "name": "Attachment Relic",
            "detachment_id": "fabricated-detachment",
            "attachment_bodyguard_ids": ["granted-bodyguard"],
        }
    ]
    result = validate_roster_core(
        {
            "faction_id": "fabricated",
            "detachment_ids": ["fabricated-detachment"],
            "units": [
                {
                    "unit_id": "leader",
                    "model_count": 1,
                    "is_warlord": True,
                    "enhancement_id": "attachment-relic",
                    "leader_bodyguard_id": "granted-bodyguard",
                    "counts": {},
                },
                {
                    "unit_id": "granted-bodyguard",
                    "model_count": 1,
                    "is_warlord": False,
                    "counts": {},
                },
            ],
        },
        Dataset(raw),
    )
    assert "leader-attachment-illegal" not in [v["code"] for v in result["army"]]
