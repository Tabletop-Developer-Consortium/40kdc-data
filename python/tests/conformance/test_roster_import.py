"""Import pipeline against the shared roster conformance corpus.

Mirrors ``tools/test/conformance.test.ts``: every ``input.*`` fixture
auto-detects to the right format and imports to ``expected.roster.json``
(canonical seeds exactly; derived text inputs after stripping ``source`` and
``diagnostics``), and the canonical seed's parsed stage matches
``expected.parsed.json``.
"""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any

import pytest

from wh40kdc.data.bundle import empty_raw_data
from wh40kdc.data.dataset import Dataset
from wh40kdc.imports import ADAPTERS, import_roster, select_adapter, try_import_roster
from wh40kdc.imports.resolve import resolve
from wh40kdc.imports.rosterizer import rosterizer_adapter

from ..conftest import CORPUS

_ROSTER_DIR = CORPUS / "roster"
_CASES = sorted(p.name for p in _ROSTER_DIR.iterdir() if p.is_dir()) if _ROSTER_DIR.exists() else []

#: Ordered by seed-pick priority (mirrors gen-conformance's decodeCanonicalSeed).
_CANONICAL_SEEDS = (
    "input.json",
    "input.newrecruit-json.json",
    "input.gw.txt",
    "input.listforge-text.txt",
    "input.newrecruit-wtc-full.txt",
    "input.roster-json.json",
)


def _is_canonical(inputs: list[str], filename: str) -> bool:
    """A WTC-full text file is the hand-authored canonical seed unless the case
    is NewRecruit-seeded (then it's a derived round-trip input)."""
    if filename == "input.newrecruit-wtc-full.txt":
        return "input.newrecruit-json.json" not in inputs
    return filename in _CANONICAL_SEEDS


_NEWRECRUIT_INPUT = re.compile(r"^input\.(newrecruit-[a-z-]+)\.[a-z]+$")


def _inputs_for(case_dir: Path) -> list[str]:
    return sorted(p.name for p in case_dir.iterdir() if p.name.startswith("input."))


def _expected_format_for(filename: str) -> str:
    """Expected detected format for an ``input.*`` fixture, by filename
    convention: ``input.json`` is always the bare ListForge BattleScribe
    payload; ``input.<format>.<ext>`` carries the format id."""
    if filename == "input.json":
        return "listforge"
    if filename == "input.rosterizer.json":
        return "rosterizer"
    if filename == "input.gw.txt":
        return "gw"
    if filename == "input.listforge-text.txt":
        return "listforge-text"
    if filename == "input.roster-json.json":
        return "roster-json"
    match = _NEWRECRUIT_INPUT.match(filename)
    if not match:
        raise AssertionError(f"unrecognised input fixture filename: {filename}")
    return match.group(1)


def _decoded_input(case_dir: Path, filename: str) -> Any:
    raw = (case_dir / filename).read_text(encoding="utf-8")
    return json.loads(raw) if filename.endswith(".json") else raw


def _stable(roster: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(roster)
    out.pop("source", None)
    out.pop("diagnostics", None)
    return out


@pytest.mark.skipif(not _CASES, reason="conformance corpus not available")
@pytest.mark.parametrize("case", _CASES)
def test_try_import_detects_every_input(dataset: Any, case: str) -> None:
    case_dir = _ROSTER_DIR / case
    inputs = _inputs_for(case_dir)
    assert inputs
    for filename in inputs:
        raw = (case_dir / filename).read_text(encoding="utf-8")
        result = try_import_roster(raw, dataset)
        assert result["ok"], f"{case} {filename}: {result.get('reason')}: {result.get('message')}"
        assert result["format"] == _expected_format_for(filename), f"{case} {filename}"


@pytest.mark.skipif(not _CASES, reason="conformance corpus not available")
@pytest.mark.parametrize("case", _CASES)
def test_every_input_parses_to_the_same_roster(dataset: Any, case: str) -> None:
    case_dir = _ROSTER_DIR / case
    expected = json.loads((case_dir / "expected.roster.json").read_text(encoding="utf-8"))
    inputs = _inputs_for(case_dir)
    for filename in inputs:
        actual = import_roster(_decoded_input(case_dir, filename), dataset)
        if _is_canonical(inputs, filename):
            # Canonical seed must reproduce the golden exactly.
            assert actual == expected, f"{case} input {filename}"
        else:
            # Derived text inputs are round-trips of the seed through an
            # exporter; format-only fields reshape, but the resolved roster
            # shape must still match.
            assert _stable(actual) == _stable(expected), f"{case} input {filename}"


@pytest.mark.skipif(not _CASES, reason="conformance corpus not available")
@pytest.mark.parametrize("case", _CASES)
def test_roster_json_golden_reimports_to_roster_golden(dataset: Any, case: str) -> None:
    """The corpus-wide round-trip contract for the canonical format: every
    case's roster-json export golden comes back through ``try_import_roster``
    (the adapter path, not the canonical passthrough) and lands on the roster
    golden (``source``/``diagnostics`` excluded). Mirrors the TS/Rust
    ``roster_json_goldens_reimport_to_roster_goldens``."""
    case_dir = _ROSTER_DIR / case
    golden = case_dir / "expected.roster-json.json"
    if not golden.exists():
        pytest.skip("no expected.roster-json.json for this case")
    expected = json.loads((case_dir / "expected.roster.json").read_text(encoding="utf-8"))
    result = try_import_roster(golden.read_text(encoding="utf-8"), dataset)
    assert result["ok"], f"{case}: {result.get('reason')}: {result.get('message')}"
    assert result["format"] == "roster-json", f"{case}: mis-detected as {result['format']}"
    assert _stable(result["roster"]) == _stable(expected), case


@pytest.mark.skipif(not _CASES, reason="conformance corpus not available")
@pytest.mark.parametrize("case", _CASES)
def test_canonical_seed_parsed_stage(case: str) -> None:
    case_dir = _ROSTER_DIR / case
    parsed_golden = case_dir / "expected.parsed.json"
    if not parsed_golden.exists():
        pytest.skip("no expected.parsed.json for this case")
    seed = next((n for n in _CANONICAL_SEEDS if (case_dir / n).exists()), None)
    assert seed is not None, f"{case}: no canonical seed"
    decoded = _decoded_input(case_dir, seed)
    adapter = select_adapter(decoded, list(ADAPTERS))
    parsed = adapter.parse(decoded)
    expected = json.loads(parsed_golden.read_text(encoding="utf-8"))
    assert parsed == expected


def test_adapter_disjointness(dataset: Any) -> None:
    """At most one adapter matches any corpus input (the greedy first-match
    dispatch relies on it)."""
    for case in _CASES:
        case_dir = _ROSTER_DIR / case
        for filename in _inputs_for(case_dir):
            decoded = _decoded_input(case_dir, filename)
            matched = [a.id for a in ADAPTERS if a.matches(decoded)]
            assert len(matched) == 1, f"{case} {filename}: matched {matched}"


def test_rosterizer_parses_attachment_keywords_and_per_model_counts() -> None:
    payload = {
        "rulebook": {"name": "Fabricated Rulebook"},
        "snapshot": {
            "item": "Roster§Fabricated Roster",
            "assets": {
                "included": [
                    {"item": "Faction§Fabricated Faction"},
                    {
                        "item": "Unit§Guide",
                        "quantity": 1,
                        "assets": {
                            "included": [
                                {
                                    "item": (
                                        "Attachment§Attachment: leader -> Fabricated Squad "
                                        "[provisional]"
                                    )
                                },
                                {"item": "Weapon§Tool", "quantity": 1},
                            ],
                            "traits": [{"item": "40kdc Keyword§Character"}],
                        },
                    },
                    {
                        "item": "Unit§Fabricated Squad",
                        "quantity": 1,
                        "assets": {
                            "included": [
                                {
                                    "item": "Model§Trooper",
                                    "quantity": 6,
                                    "assets": {
                                        "included": [{"item": "Weapon§Rifle", "quantity": 6}]
                                    },
                                },
                                {
                                    "item": "Model§Sergeant",
                                    "quantity": 1,
                                    "assets": {
                                        "included": [{"item": "Weapon§Sidearm", "quantity": 1}]
                                    },
                                },
                            ]
                        },
                    },
                ]
            },
        },
    }
    parsed = rosterizer_adapter.parse(payload)
    guide, squad = parsed["units"]

    assert guide["is_character"] is True
    assert guide["keyword_overrides"] == ["Character"]
    assert guide["leader_attachment"] == {
        "role": "leader",
        "bodyguard_raw_name": "Fabricated Squad",
        "provisional": True,
    }
    assert squad["model_count"] == 7
    assert squad["loadout_groups"] == [
        {"model_name": "Trooper", "count": 6, "wargear": [{"raw_name": "Rifle", "count": 1}]},
        {"model_name": "Sergeant", "count": 1, "wargear": [{"raw_name": "Sidearm", "count": 1}]},
    ]


def test_resolver_handles_source_aliases_profile_names_abilities_and_all_parts() -> None:
    raw = empty_raw_data()
    raw["factions"] = [{"id": "fabricated", "name": "Fabricated Faction"}]
    raw["units"] = [
        {
            "id": "fabricated-squad",
            "name": "Fabricated Squad",
            "faction_id": "fabricated",
            "weapon_ids": ["kombi-weapon"],
            "ability_ids": ["special-ritual"],
        }
    ]
    raw["weapons"] = [
        {
            "id": "kombi-weapon",
            "name": "Kombi-weapon",
            "faction_id": "fabricated",
            "profiles": [],
        }
    ]
    raw["abilities"] = [
        {"ability_id": "special-ritual", "name": "Special Ritual", "faction_id": "fabricated"}
    ]
    raw["unit_compositions"] = [
        {
            "unit_id": "fabricated-squad",
            "faction_id": "fabricated",
            "models": [{"profile_name": "Runner Profile", "min": 2, "max": 2}],
        }
    ]
    parsed = {
        "name": "Fabricated roster",
        "generated_by": None,
        "faction_raw_name": "Fabricated Faction",
        "detachment_raw_names": [],
        "force_disposition_raw_name": None,
        "battle_size_raw": None,
        "declared_limit": None,
        "total_reported": 0,
        "total_computed": 0,
        "units": [
            {
                "raw_name": "Fabricated Squad",
                "is_character": False,
                "model_count": 1,
                "points": 0,
                "is_warlord": False,
                "enhancement_raw_name": None,
                "enhancement_points": None,
                "wargear": [
                    {"raw_name": "Runner Profile", "count": 2},
                    {"raw_name": "Kombi rokkit and Special Ritual", "count": 2},
                ],
                "leader_attachment": None,
            }
        ],
    }

    roster = resolve(parsed, Dataset(raw))
    unit = roster["units"][0]
    assert unit["model_count"] == 2
    assert [(item["ref"]["id"], item["count"]) for item in unit["wargear"]] == [
        ("kombi-weapon", 2),
        ("special-ritual", 1),
    ]
