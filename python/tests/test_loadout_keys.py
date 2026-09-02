"""Sort keys and name folding used by the loadout solver and roster resolver.

These pin behaviour-preserving rewrites against reference implementations.
"""

from __future__ import annotations

import unicodedata
from typing import Any

from wh40kdc.data.loadout import _js_locale_key
from wh40kdc.data.normalize import normalize_name
from wh40kdc.imports.resolve import _singular


def _reference_singular(value: str) -> str:
    """The original per-character loop: drop 's' when the next char is not ASCII \\w."""
    n = normalize_name(value)
    out = []
    for i, ch in enumerate(n):
        nxt = n[i + 1] if i + 1 < len(n) else ""
        if ch == "s" and not (nxt.isascii() and (nxt.isalnum() or nxt == "_")):
            continue
        out.append(ch)
    return "".join(out)


def _vocabulary(dataset: Any) -> list[str]:
    names = ["", "s", "ss", "boyz", "Kommandos", "bikes-s", "s s", "es_s", "Bob's Boys", "İs"]
    for collection in ("units", "weapons", "abilities", "wargear", "enhancements"):
        for item in getattr(dataset, collection, ()) or ():
            raw = getattr(item, "raw", None)
            if isinstance(raw, dict):
                names.extend(
                    v for k, v in raw.items() if k in ("name", "id") and isinstance(v, str)
                )
    return names


def test_singular_matches_reference(dataset: Any) -> None:
    names = _vocabulary(dataset)
    assert len(names) > 500
    for name in names:
        assert _singular(name) == _reference_singular(name), repr(name)


def test_locale_key_order_is_code_point_order(dataset: Any) -> None:
    ids = [w.raw["id"] for w in dataset.weapons] + ["a", "ab", "a-", "a b", "z", "Z", "é", "e"]
    assert sorted(ids, key=_js_locale_key) == sorted(ids, key=lambda v: tuple(ord(c) for c in v))


def test_find_all_substring_fallback_unchanged(dataset: Any) -> None:
    # No exact match, so this exercises the precomputed-name scan.
    hits = dataset.weapons.find_all("bolt pisto")
    assert hits
    assert all("bolt pisto" in normalize_name(h.raw["name"]) for h in hits)
    assert unicodedata.normalize("NFD", "x") == "x"  # keep the import honest


def test_get_in_faction_is_first_registered_copy(dataset: Any) -> None:
    # Reference: the scan the index replaced. Shared ids must resolve to the same copy.
    for w in list(dataset.weapons)[:400]:
        fac, wid = w.raw.get("faction_id"), w.raw["id"]
        if not fac:
            continue
        expect = next(x for x in dataset.weapons.by_faction(fac) if x.raw["id"] == wid)
        assert dataset.weapons.get_in_faction(wid, fac).raw is expect.raw


def test_unit_composition_of_matches_linear_search(dataset: Any) -> None:
    for u in list(dataset.units)[:400]:
        expect = next(
            (
                c
                for c in dataset.unit_compositions
                if c.get("unit_id") == u.raw["id"]
                and c.get("faction_id") == u.raw.get("faction_id")
            ),
            None,
        )
        assert dataset.unit_composition_of(u.raw) is expect
