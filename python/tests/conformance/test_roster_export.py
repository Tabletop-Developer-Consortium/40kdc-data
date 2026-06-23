"""Export serializers against the byte-equal goldens in conformance/roster/."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

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


@pytest.mark.skipif(not _CASES, reason="conformance corpus not available")
@pytest.mark.parametrize("fmt", sorted(_FORMAT_GOLDENS))
@pytest.mark.parametrize("case", _CASES)
def test_export_golden(case: str, fmt: str) -> None:
    case_dir = _ROSTER_DIR / case
    roster = json.loads((case_dir / "expected.roster.json").read_text(encoding="utf-8"))
    golden = Path(case_dir / _FORMAT_GOLDENS[fmt]).read_text(encoding="utf-8")
    assert export_roster(roster, fmt) == golden


def test_unknown_format_raises() -> None:
    with pytest.raises(ValueError, match="unknown export format"):
        export_roster({"units": []}, "not-a-format")
