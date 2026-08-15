"""GW adapter: lower the Games Workshop 40K app's plain-text army-list export
to a ``ParsedRoster``.

The format opens with the same ``++++…++++`` summary fence as the NewRecruit
WTC formats, then lists units grouped under ALL-CAPS battlefield-role
sections. Each unit is a header line ``Name (N pts)`` followed by
``•``-bulleted entries.

Bullet classification (the parsing crux):

- A top-level ``• Nx Thing`` *with* further-indented child bullets is a
  **model group** — ``N`` adds to the model count and the children are that
  group's wargear.
- A top-level ``• Nx Thing`` *without* children is plain **wargear**.
- A bullet *without* an ``Nx`` count is an **annotation**: ``… Character``
  flags a character, ``Warlord`` flags the warlord, ``Name (+N pts)`` is the
  enhancement.

**Disjointness from the WTC matchers**: the GW format always carries ``•``
bullets and never the WTC ``N with`` lines.

Python mirror of ``tools/src/import/gw.ts``.
"""

from __future__ import annotations

import re
from typing import Any

from wh40kdc.imports.adapter import FormatAdapter
from wh40kdc.imports.newrecruit_text import (
    faction_from_keyword,
    infer_battle_size_raw,
    strip_parenthetical,
)

_FACTION_KEYWORD_PREFIX = "+ FACTION KEYWORD:"

_HEADER_FACTION = re.compile(r"^\+\s*FACTION KEYWORD:\s*(.+?)\s*$", re.IGNORECASE)
_HEADER_DETACHMENT = re.compile(r"^\+\s*DETACHMENT:\s*(.+?)\s*$", re.IGNORECASE)
_HEADER_TOTAL_POINTS = re.compile(r"^\+\s*TOTAL ARMY POINTS:\s*(\d+)\s*pts?\s*$", re.IGNORECASE)

_FENCE = re.compile(r"^\++\s*$")
_HEADER_LINE = re.compile(r"^\+")
_SECTION_HEADER = re.compile(r"^[A-Z][A-Z0-9 \-/&]+$")  # BATTLELINE, ALLIED UNITS, …
_UNIT_HEADER = re.compile(r"^(.+?)\s*\(\s*(\d+)\s*pts?\s*\)\s*$", re.IGNORECASE)
_BULLET_LINE = re.compile(r"^(\s*)•\s*(.+?)\s*$")
_NX_PREFIX = re.compile(r"^(\d+)x\s+(.+)$")
_ENHANCEMENT_ANNOT = re.compile(r"^(.+?)\s*\(\+\s*(\d+)\s*pts?\s*\)\s*$", re.IGNORECASE)
_WITH_LINE = re.compile(r"^[\t ]*\d+\s+with\b", re.MULTILINE)
_BULLET = re.compile(r"^[\t ]*•", re.MULTILINE)
_SPLIT_LINES = re.compile(r"\r?\n")
_SERIALIZED_WTC = re.compile(r"^\+\s*LIST NAME:", re.IGNORECASE | re.MULTILINE)

_ALLIED_SECTION = "ALLIED UNITS"
_CHARACTERS_SECTION = "CHARACTERS"
_CHARACTER_SUFFIX = " Character"
_WARLORD_MARKER = "Warlord"


def _is_gw_text(decoded: Any) -> str | None:
    """Accept framed GW text, excluding WTC's competing body formats."""
    if not isinstance(decoded, str):
        return None
    if _FACTION_KEYWORD_PREFIX not in decoded:
        return None
    if _BULLET.search(decoded) is None:
        return None
    if _WITH_LINE.search(decoded) is not None:  # that's wtc-full
        return None
    if _SERIALIZED_WTC.search(decoded) is not None:
        return None
    return decoded


def _parse_header(lines: list[str]) -> tuple[dict[str, Any], int] | None:
    faction_raw_name: str | None = None
    detachment_raw_name: str | None = None
    total_reported: int | None = None

    fence_indices: list[int] = []
    for i, line in enumerate(lines):
        if len(fence_indices) >= 2:
            break
        if _FENCE.match(line):
            fence_indices.append(i)

    saw_faction_keyword = False
    for line in lines:
        if not line.startswith("+"):
            continue
        m = _HEADER_FACTION.match(line)
        if m:
            faction_raw_name = faction_from_keyword(m.group(1))
            saw_faction_keyword = True
            continue
        m = _HEADER_DETACHMENT.match(line)
        if m:
            detachment_raw_name = strip_parenthetical(m.group(1))
            continue
        m = _HEADER_TOTAL_POINTS.match(line)
        if m:
            total_reported = int(m.group(1))

    if not saw_faction_keyword:
        return None

    body_start = fence_indices[1] + 1 if len(fence_indices) >= 2 else 0
    # The GW export has no POINTS LIMIT line — only TOTAL ARMY POINTS. Use it
    # as the declared limit so the inferred battle size stays round-trippable.
    declared_limit = total_reported
    header = {
        "name": "Imported roster",
        "faction_raw_name": faction_raw_name,
        "detachment_raw_name": detachment_raw_name,
        "total_reported": total_reported,
        "declared_limit": declared_limit,
        "battle_size_raw": infer_battle_size_raw(declared_limit),
    }
    return header, body_start


def _finish_unit(acc: dict[str, Any]) -> dict[str, Any]:
    bullets: list[dict[str, Any]] = acc["bullets"]
    top_indent = min((b["indent"] for b in bullets), default=0)

    wargear: dict[str, int] = {}
    model_count = 0
    is_warlord = False
    is_character = acc["section"] == _CHARACTERS_SECTION
    enhancement_raw_name: str | None = None
    enhancement_points: int | None = None

    for i, b in enumerate(bullets):
        # A child bullet (deeper than the unit's top level) is a model group's
        # weapon — its `Nx` count is already the squad-wide total.
        if b["indent"] > top_indent:
            if b["count"] is not None:
                wargear[b["text"]] = wargear.get(b["text"], 0) + b["count"]
            continue

        # Top-level annotation (no `Nx` count): enhancement / character / warlord.
        if b["count"] is None:
            enh = _ENHANCEMENT_ANNOT.match(b["text"])
            if enh:
                if enhancement_raw_name is None:
                    enhancement_raw_name = enh.group(1).strip()
                    enhancement_points = int(enh.group(2))
                continue
            for token in (s.strip() for s in b["text"].split(",")):
                if not token:
                    continue
                if token == _WARLORD_MARKER:
                    is_warlord = True
                elif token.endswith(_CHARACTER_SUFFIX):
                    is_character = True
            continue

        # Top-level `Nx` bullet: a model group when it has child bullets
        # beneath it, otherwise plain wargear.
        next_bullet = bullets[i + 1] if i + 1 < len(bullets) else None
        if next_bullet is not None and next_bullet["indent"] > top_indent:
            model_count += b["count"]
        else:
            wargear[b["text"]] = wargear.get(b["text"], 0) + b["count"]

    if model_count == 0:
        model_count = 1

    # The GW unit header points include the enhancement; back it out to the base.
    displayed = acc["displayed_pts"]
    if displayed is None:
        points = None
    elif enhancement_points is not None:
        points = displayed - enhancement_points
    else:
        points = displayed

    return {
        "raw_name": acc["raw_name"],
        "is_character": is_character,
        "model_count": model_count,
        "points": points,
        "is_warlord": is_warlord,
        "enhancement_raw_name": enhancement_raw_name,
        "enhancement_points": enhancement_points,
        "wargear": [{"raw_name": n, "count": c} for n, c in wargear.items()],
    }


def _parse_body(lines: list[str], body_start: int) -> tuple[list[dict[str, Any]], bool]:
    units: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    section: str | None = None
    allied_units = 0

    def finalize() -> None:
        nonlocal current
        if current is not None:
            units.append(_finish_unit(current))
            current = None

    for raw in lines[body_start:]:
        line = raw.strip()
        if not line or _FENCE.match(line) or _HEADER_LINE.match(line):
            continue

        bullet_match = _BULLET_LINE.match(raw)
        if bullet_match:
            if current is not None:
                indent = len(bullet_match.group(1))
                rest = bullet_match.group(2)
                nx = _NX_PREFIX.match(rest)
                current["bullets"].append(
                    {
                        "indent": indent,
                        "count": int(nx.group(1)) if nx else None,
                        "text": (nx.group(2) if nx else rest).strip(),
                    }
                )
            continue

        # A plain `Nx …` line with no `•` bullet is still that unit's wargear:
        # the GW app bullets only the first wargear entry per unit and emits the
        # rest unbulleted. Feed it through the same top-level-bullet path. A unit
        # header also lacks a bullet but carries a `(N pts)` parenthetical, so it
        # is excluded here and handled just below.
        nx_match = _NX_PREFIX.match(line)
        if current is not None and nx_match and not _UNIT_HEADER.match(line):
            current["bullets"].append(
                {
                    "indent": 0,
                    "count": int(nx_match.group(1)),
                    "text": nx_match.group(2).strip(),
                }
            )
            continue

        unit_match = _UNIT_HEADER.match(line)
        if unit_match:
            finalize()
            current = {
                "raw_name": unit_match.group(1).strip(),
                "displayed_pts": int(unit_match.group(2)),
                "section": section,
                "bullets": [],
            }
            if section == _ALLIED_SECTION:
                allied_units += 1
            continue

        if _SECTION_HEADER.match(line):
            finalize()
            section = line

    finalize()
    return units, allied_units > 0


def _matches(decoded: Any) -> bool:
    return _is_gw_text(decoded) is not None


def _parse(decoded: Any) -> dict[str, Any]:
    text = _is_gw_text(decoded)
    if text is None:
        raise ValueError("gw: input is not a GW app text export")

    lines = _SPLIT_LINES.split(text)
    parsed = _parse_header(lines)
    if parsed is None:
        raise ValueError('gw: missing "+ FACTION KEYWORD:" header')
    header, body_start = parsed

    units, multi_force = _parse_body(lines, body_start)

    total_computed = 0
    for u in units:
        total_computed += u["points"] or 0
        total_computed += u["enhancement_points"] or 0

    return {
        "name": header["name"],
        "generated_by": None,
        "faction_raw_name": header["faction_raw_name"],
        "detachment_raw_names": (
            [header["detachment_raw_name"]] if header["detachment_raw_name"] else []
        ),
        "force_disposition_raw_name": None,
        "battle_size_raw": header["battle_size_raw"],
        "declared_limit": header["declared_limit"],
        "total_reported": header["total_reported"],
        "total_computed": total_computed,
        "units": units,
        "multi_force": multi_force,
    }


gw_adapter = FormatAdapter(id="gw", matches=_matches, parse=_parse)
