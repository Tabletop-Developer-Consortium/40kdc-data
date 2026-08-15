"""Helpers shared by the NewRecruit text adapters (wtc-compact, wtc-full,
simple) and the GW adapter.

These are pure string-massage utilities: they take format-specific tokens and
turn them into the format-agnostic ``ParsedRoster`` pieces. No business
knowledge of dataset entities lives here — name resolution is still
``resolve``'s job downstream.

Python mirror of ``tools/src/import/newrecruit-text.ts``.
"""

from __future__ import annotations

import re
from typing import Any

#: Tournament-standard battle sizes by points ceiling (10th ed).
_BATTLE_SIZES: list[tuple[int, str]] = [
    (500, "Combat Patrol (500 Point limit)"),
    (1000, "Incursion (1000 Point limit)"),
    (2000, "Strike Force (2000 Point limit)"),
    (3000, "Onslaught (3000 Point limit)"),
]


def infer_battle_size_raw(limit: int | None) -> str | None:
    """Synthesize a ``battle_size_raw`` from a points limit.

    The wtc/simple formats don't carry the battle-size label explicitly —
    they only report the total army points — so we map the limit to its
    standard label (the same one ``map_battle_size`` expects).
    """
    if limit is None:
        return None
    for upper, label in _BATTLE_SIZES:
        if limit <= upper:
            return label
    return _BATTLE_SIZES[-1][1]  # beyond Onslaught: cap at Onslaught


_NX_PREFIX = re.compile(r"^(\d+)x\s+(.+)$")
_INLINE_PTS = re.compile(r"^(.+?)\s*\[\s*(\d+)\s*pts?\s*\]\s*$", re.IGNORECASE)
_CHARACTER_SUFFIX = " Character"
_INLINE_ENHANCEMENT = re.compile(r"^Enhancement:\s*(.+)$", re.IGNORECASE)
_INLINE_KEYWORD = re.compile(r"^40kdc\s+keywords?:\s*(.+)$", re.IGNORECASE)
_WARLORD_MARKER = "Warlord"


def classify_wargear_list(tokens: list[str]) -> dict[str, Any]:
    """Classify each token in a comma-separated wargear list.

    Strips the markers that aren't real wargear — ``Warlord``, the detachment
    "<Name> Character" keyword, and the inline ``Name [N pts]`` enhancement
    (simple format) — and collects everything else as parsed wargear with an
    optional ``Nx`` count. Tokens are pre-split.
    """
    wargear: list[dict[str, Any]] = []
    is_warlord = False
    is_character = False
    keyword_overrides: list[str] = []
    seen_keyword_overrides: set[str] = set()
    enhancement_raw_name: str | None = None
    enhancement_points: int | None = None

    for raw in tokens:
        token = raw.strip()
        if not token:
            continue

        if token == _WARLORD_MARKER:
            is_warlord = True
            continue
        if token.endswith(_CHARACTER_SUFFIX):
            is_character = True
            if "Character" not in seen_keyword_overrides:
                keyword_overrides.append("Character")
                seen_keyword_overrides.add("Character")
            continue
        keyword = _INLINE_KEYWORD.match(token)
        if keyword:
            value = keyword.group(1).strip()
            if value not in seen_keyword_overrides:
                keyword_overrides.append(value)
                seen_keyword_overrides.add(value)
            continue

        # Simple format inlines the enhancement as `Name [15 pts]`.
        pts = _INLINE_PTS.match(token)
        if pts:
            if enhancement_raw_name is None:
                enhancement_raw_name = pts.group(1).strip()
                enhancement_points = int(pts.group(2))
            continue
        enhancement = _INLINE_ENHANCEMENT.match(token)
        if enhancement:
            if enhancement_raw_name is None:
                enhancement_raw_name = enhancement.group(1).strip()
                enhancement_points = None
            continue

        nx = _NX_PREFIX.match(token)
        if nx:
            count = int(nx.group(1))
            wargear.append({"raw_name": nx.group(2).strip(), "count": count if count > 0 else 1})
        else:
            wargear.append({"raw_name": token, "count": 1})

    return {
        "wargear": wargear,
        "is_warlord": is_warlord,
        "is_character": is_character,
        "keyword_overrides": keyword_overrides,
        "enhancement_raw_name": enhancement_raw_name,
        "enhancement_points": enhancement_points,
    }


def split_wargear_list(text: str) -> list[str]:
    """Split a wargear list on top-level commas. (No nested parentheses with
    commas are produced by NewRecruit, so a plain split is enough.)"""
    return [s for s in (part.strip() for part in text.split(",")) if s]


def strip_parenthetical(name: str) -> str:
    """Strip a trailing parenthetical
    (e.g. "Houndpack Lance (Marked Prey)" → "Houndpack Lance")."""
    idx = name.find("(")
    return name[:idx].strip() if idx >= 0 else name.strip()


def faction_from_keyword(value: str) -> str:
    """Pull the primary faction out of a "Super - Sub" keyword, e.g.
    "Chaos - Chaos Knights" → "Chaos Knights". Shared by the wtc and GW
    headers."""
    parts = value.split(" - ")
    return (parts[-1] if parts else value).strip()


_POINTS_FROM = re.compile(r"\(\s*(\d+)\s*pts?\s*\)|\[\s*(\d+)\s*pts?\s*\]", re.IGNORECASE)


def points_from(token: str) -> int | None:
    """Parse a ``(N pts)`` or ``[N pts]`` suffix from a unit header line."""
    m = _POINTS_FROM.search(token)
    if not m:
        return None
    return int(m.group(1) or m.group(2))
