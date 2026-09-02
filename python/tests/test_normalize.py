"""Memoisation and the ASCII fast path in :func:`normalize_name`.

Both are performance changes that must be behaviourally invisible, so the fast path is
pinned against a reference implementation that always takes the general route.
"""

from __future__ import annotations

import unicodedata
from typing import Any

from wh40kdc.data import normalize as _n
from wh40kdc.data.normalize import normalize_name

_PROBES = [
    "",
    " ",
    "  padded  ",
    "Intercessor Squad",
    "the   betrayer",
    "MiXeD CaSe",
    "10 Models",
    "A-B",
    "a--b",
    "hyphen-name",
    "tab\tsep",
    "Khârn the Betrayer",
    "T'au",
    "Be'lakor",
    "İ",
]


def _reference(value: str) -> str:
    """normalize_name with no fast path and no cache."""
    decomposed = unicodedata.normalize("NFD", value)
    stripped = "".join(c for c in decomposed if unicodedata.category(c) not in _n._MARK_CATEGORIES)
    no_quotes = _n._QUOTES_RE.sub("", stripped.lower())
    return _n._SPACE_HYPHEN_RE.sub(" ", no_quotes).strip()


def test_fast_path_matches_general_implementation(dataset: Any) -> None:
    names = list(_PROBES)
    for collection in ("units", "weapons", "abilities", "wargear", "enhancements", "factions"):
        for item in getattr(dataset, collection, ()) or ():
            raw = getattr(item, "raw", None)
            if not isinstance(raw, dict):
                continue
            names.extend(v for k, v in raw.items() if k in ("name", "id") and isinstance(v, str))
    assert len(names) > 500, "expected a substantial vocabulary to check against"
    for name in names:
        assert normalize_name(name) == _reference(name), repr(name)


def test_cache_is_bounded() -> None:
    # Roster text is normalised too, so an unbounded cache would grow on arbitrary input.
    assert normalize_name.cache_info().maxsize is not None
