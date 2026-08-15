"""normalize_name against the shared conformance corpus."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from wh40kdc.data.normalize import normalize_name

from ..conftest import CORPUS

_CASES_PATH = CORPUS / "normalize.json"
_CASES = json.loads(Path(_CASES_PATH).read_text(encoding="utf-8")) if _CASES_PATH.exists() else []


@pytest.mark.skipif(not _CASES, reason="conformance corpus not available")
@pytest.mark.parametrize("case", _CASES, ids=lambda c: repr(c["input"])[:40])
def test_normalize_corpus(case: dict[str, str]) -> None:
    assert normalize_name(case["input"]) == case["expected"]


def test_turkish_dotted_i_folds_to_plain_i() -> None:
    # NFD decomposes İ (U+0130) to I + combining dot above; the mark-strip
    # removes the dot, then lowercasing yields plain "i" (the CONFORMANCE.md
    # pinned behavior — no Turkish-locale special casing).
    assert normalize_name("İ") == "i"


def test_zero_width_joiner_passes_through() -> None:
    assert normalize_name("a‍b") == "a‍b"
