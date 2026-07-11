"""Export serializers against the byte-equal goldens in conformance/roster/."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from wh40kdc.data.dataset import Dataset
from wh40kdc.export import export_roster

from ..conftest import CORPUS

_ROSTER_DIR = CORPUS / "roster"
_CASES = sorted(p.name for p in _ROSTER_DIR.iterdir() if p.is_dir()) if _ROSTER_DIR.exists() else []

_FORMAT_GOLDENS = {
    "newrecruit-json": "expected.newrecruit-json.json",
    "newrecruit-wtc-compact": "expected.newrecruit-wtc-compact.txt",
    "newrecruit-wtc-full": "expected.newrecruit-wtc-full.txt",
    "newrecruit-simple": "expected.newrecruit-simple.txt",
    "roster-json": "expected.roster-json.json",
    "rosterizer": "expected.rosterizer.json",
    # ATC 2026 — export-only (no importer, no derived round-trip input).
    "atc-2026-compact": "expected.atc-2026-compact.txt",
    "atc-2026-full": "expected.atc-2026-full.txt",
}

#: Dataset-backed export-only formats — resolved against the embedded dataset,
#: so ``export_roster`` takes the extra dataset argument. Text goldens.
_DATASET_FORMAT_GOLDENS = {
    "yellowscribe": "expected.yellowscribe.ros",
}


@pytest.mark.skipif(not _CASES, reason="conformance corpus not available")
@pytest.mark.parametrize("fmt", sorted(_FORMAT_GOLDENS))
@pytest.mark.parametrize("case", _CASES)
def test_export_golden(case: str, fmt: str) -> None:
    case_dir = _ROSTER_DIR / case
    roster = json.loads((case_dir / "expected.roster.json").read_text(encoding="utf-8"))
    golden = Path(case_dir / _FORMAT_GOLDENS[fmt]).read_text(encoding="utf-8")
    assert export_roster(roster, fmt) == golden


@pytest.mark.skipif(not _CASES, reason="conformance corpus not available")
@pytest.mark.parametrize("fmt", sorted(_DATASET_FORMAT_GOLDENS))
@pytest.mark.parametrize("case", _CASES)
def test_dataset_export_golden(case: str, fmt: str) -> None:
    case_dir = _ROSTER_DIR / case
    roster = json.loads((case_dir / "expected.roster.json").read_text(encoding="utf-8"))
    golden = Path(case_dir / _DATASET_FORMAT_GOLDENS[fmt]).read_text(encoding="utf-8")
    assert export_roster(roster, fmt, Dataset.embedded()) == golden


def test_unknown_format_raises() -> None:
    with pytest.raises(ValueError, match="unknown export format"):
        export_roster({"units": []}, "not-a-format")


# --- ATC LEADER/SUPPORT wording (no conformance roster carries an attachment,
# so the populated line is exercised here against hand-built rosters) ---


def _ref(id_: str | None, raw_name: str) -> dict:
    return {"id": id_, "raw_name": raw_name, "resolved": id_ is not None, "candidates": []}


def _unit(over: dict) -> dict:
    base = {
        "model_count": 1,
        "points": 100,
        "is_warlord": False,
        "enhancement": None,
        "enhancement_points": None,
        "wargear": [],
        "leader_attachment": None,
    }
    base.update(over)
    return base


def _roster(units: list[dict]) -> dict:
    return {
        "name": "Test List",
        "source": {"format": "roster-json", "generated_by": None},
        "faction_id": "adeptus-astartes",
        "detachments": [{"ref": _ref("gladius-task-force", "Gladius Task Force"), "dp_cost": None}],
        "battle_size": None,
        "force_disposition": None,
        "points": {
            "declared_limit": 2000,
            "detachment_cap": None,
            "total_reported": 500,
            "total_computed": 500,
        },
        "units": units,
        "game_version": {"edition": "10", "dataslate": "test"},
        "diagnostics": {
            "resolved_units": 0,
            "unresolved_units": 0,
            "resolved_weapons": 0,
            "unresolved_weapons": 0,
            "warnings": [],
        },
    }


def _leader_support_line(out: str) -> str:
    return next(line for line in out.split("\n") if line.startswith("+ LEADER/SUPPORT:"))


def test_atc_leader_renders_leading() -> None:
    units = [
        _unit(
            {
                "ref": _ref("captain", "Captain"),
                "is_warlord": True,
                "leader_attachment": {
                    "bodyguard_ref": _ref("assault-intercessor-squad", "Assault Squad"),
                    "role": "leader",
                    "provisional": False,
                },
            }
        ),
        _unit({"ref": _ref("assault-intercessor-squad", "Assault Squad"), "model_count": 5}),
    ]
    out = export_roster(_roster(units), "atc-2026-compact")
    assert _leader_support_line(out) == "+ LEADER/SUPPORT: Captain leading Assault Squad"


def test_atc_support_renders_supported_by() -> None:
    units = [
        _unit(
            {
                "ref": _ref("master-of-executions", "Master of Executions"),
                "leader_attachment": {
                    "bodyguard_ref": _ref("chaos-terminator-squad", "Chaos Terminators"),
                    "role": "support",
                    "provisional": True,
                },
            }
        ),
        _unit({"ref": _ref("chaos-terminator-squad", "Chaos Terminators"), "model_count": 5}),
    ]
    out = export_roster(_roster(units), "atc-2026-compact")
    assert _leader_support_line(out) == (
        "+ LEADER/SUPPORT: Chaos Terminators supported by Master of Executions"
    )


def test_atc_leader_and_support_on_same_bodyguard_compound() -> None:
    bg = _ref("eightbound", "Eightbound")
    units = [
        _unit(
            {
                "ref": _ref("slaughterbound", "Slaughterbound"),
                "is_warlord": True,
                "leader_attachment": {"bodyguard_ref": bg, "role": "leader", "provisional": False},
            }
        ),
        _unit(
            {
                "ref": _ref("support-char", "Support Char"),
                "leader_attachment": {"bodyguard_ref": bg, "role": "support", "provisional": True},
            }
        ),
        _unit({"ref": bg, "model_count": 3}),
    ]
    out = export_roster(_roster(units), "atc-2026-compact")
    assert _leader_support_line(out) == (
        "+ LEADER/SUPPORT: Slaughterbound leading Eightbound, supported by Support Char"
    )
