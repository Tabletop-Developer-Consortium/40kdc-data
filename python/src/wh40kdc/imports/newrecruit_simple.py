"""NewRecruit "simple" markdown-ish text adapter.

Shape::

    <breadcrumb> - <faction> - <list name> - [N pts]

    # ++ Army Roster ++ [N pts]
    ## Configuration
    Battle Size: <Label>
    Detachment: <Name>

    ## <Section> [N pts]
    <Unit> [N pts]: <wargear>
    <Unit> [N pts]:
    • <count>x <ModelType>[ [N pts]]: <wargear>

Enhancements are inlined in the wargear list as ``<Name> [N pts]`` — the only
wargear token wearing a ``[…]`` pts suffix. ``Warlord`` and the detachment
"<X> Character" keyword are also stripped from the list and set as flags.
Per-model-type breakdowns under ``•`` lines are collapsed onto the parent
unit.

Python mirror of ``tools/src/import/newrecruit-simple.ts``.
"""

from __future__ import annotations

import re
from typing import Any

from wh40kdc.imports.adapter import FormatAdapter
from wh40kdc.imports.newrecruit_text import (
    classify_wargear_list,
    split_wargear_list,
    strip_parenthetical,
)

# Point brackets may carry comma-separated faction resources after the pts
# figure (e.g. `[4485pts, 29Cabal Points]`); the tail is recognized and
# discarded — only the pts figure is consumed.
_FIRST_LINE = re.compile(r"^(.+)\s-\s\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\]\s*$", re.IGNORECASE)
_ROSTER_HEADER = re.compile(
    r"^#\s*\+\+\s*Army Roster\s*\+\+\s*\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\]\s*$",
    re.IGNORECASE,
)
_ROSTER_HEADER_ANYWHERE = re.compile(r"^#\s*\+\+\s*Army Roster\s*\+\+", re.MULTILINE)
# Some exports omit the `# ++ Army Roster ++` line and open straight with a
# `## Section` heading — accept either marker.
_SECTION_HEADER_ANYWHERE = re.compile(r"^##\s+", re.MULTILINE)
_SECTION_HEADER = re.compile(r"^##\s*(.+?)(?:\s*\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\])?\s*$")
_UNIT_LINE = re.compile(
    r"^(.+?)\s*\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\](?:\s*:\s*(.*))?$", re.IGNORECASE
)
_BULLET = re.compile(
    r"^\s*•\s*(\d+)x\s+(.+?)(?:\s*\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\])?(?:\s*:\s*(.*))?\s*$"
)
_SPLIT_LINES = re.compile(r"\r?\n")

_UNIT_TOTAL_PREFIX = re.compile(r"^Unit total:\s*", re.IGNORECASE)
_ATTACHMENT_TOKEN = re.compile(
    r"^Attachment:\s*(leader|support)\s*->\s*(.+?)(\s+\[provisional\])?$",
    re.IGNORECASE,
)


def _new_unit(name: str, displayed_pts: int | None) -> dict[str, Any]:
    return {
        "raw_name": name,
        "is_character": False,
        "is_warlord": False,
        "keyword_overrides": [],
        "seen_keyword_overrides": set(),
        "enhancement_raw_name": None,
        "enhancement_pts": None,
        "displayed_pts": displayed_pts,
        "saw_bullet": False,
        "model_count": 1,
        "leader_attachment": None,
        # Aggregated wargear, keyed by name (insertion-ordered). Counts sum
        # across `• Nx ModelType` breakdowns.
        "wargear": {},
        "loadout_groups": [],
    }


def _apply_tokens(
    unit: dict[str, Any], tokens_csv: str, multiplier: int = 1
) -> list[dict[str, Any]]:
    wargear_tokens: list[str] = []
    for token in split_wargear_list(tokens_csv):
        attachment = _ATTACHMENT_TOKEN.match(token)
        if attachment:
            unit["leader_attachment"] = {
                "role": attachment.group(1).lower(),
                "bodyguard_raw_name": attachment.group(2),
                "provisional": attachment.group(3) is not None,
            }
        else:
            wargear_tokens.append(token)

    cls = classify_wargear_list(wargear_tokens)
    if cls["is_warlord"]:
        unit["is_warlord"] = True
    if cls["is_character"]:
        unit["is_character"] = True
    for keyword in cls["keyword_overrides"]:
        if keyword not in unit["seen_keyword_overrides"]:
            unit["keyword_overrides"].append(keyword)
            unit["seen_keyword_overrides"].add(keyword)
    if cls["enhancement_raw_name"] and unit["enhancement_raw_name"] is None:
        unit["enhancement_raw_name"] = cls["enhancement_raw_name"]
        unit["enhancement_pts"] = cls["enhancement_points"]
    for w in cls["wargear"]:
        name = w["raw_name"]
        unit["wargear"][name] = unit["wargear"].get(name, 0) + w["count"] * multiplier
    return cls["wargear"]


def _finish_unit(unit: dict[str, Any]) -> dict[str, Any]:
    displayed = unit["displayed_pts"]
    points = (
        None
        if displayed is None
        else displayed - (unit["enhancement_pts"] if unit["enhancement_pts"] is not None else 0)
    )
    return {
        "raw_name": unit["raw_name"],
        "is_character": unit["is_character"],
        **({"keyword_overrides": unit["keyword_overrides"]} if unit["keyword_overrides"] else {}),
        "model_count": unit["model_count"],
        "points": points,
        "is_warlord": unit["is_warlord"],
        "enhancement_raw_name": unit["enhancement_raw_name"],
        "enhancement_points": (
            None if unit["enhancement_raw_name"] is None else unit["enhancement_pts"]
        ),
        "leader_attachment": unit["leader_attachment"],
        "wargear": [{"raw_name": n, "count": c} for n, c in unit["wargear"].items()],
        **({"loadout_groups": unit["loadout_groups"]} if unit["loadout_groups"] else {}),
    }


def _parse_first_line(line: str) -> dict[str, Any] | None:
    m = _FIRST_LINE.match(line)
    if not m:
        return None
    declared_limit = int(m.group(2))
    parts = [s for s in (p.strip() for p in m.group(1).split(" - ")) if s]
    if not parts:
        return None
    return {
        "name": parts[-1],
        "faction": parts[-2] if len(parts) >= 2 else None,
        "declared_limit": declared_limit,
    }


def _matches(decoded: Any) -> bool:
    if not isinstance(decoded, str):
        return False
    first_non_blank = next((line for line in _SPLIT_LINES.split(decoded) if line.strip()), None)
    if not first_non_blank:
        return False
    if not _FIRST_LINE.match(first_non_blank):
        return False
    # Some exports omit the `# ++ Army Roster ++` line and open straight with
    # a `## Section` heading — accept either marker.
    return (
        _ROSTER_HEADER_ANYWHERE.search(decoded) is not None
        or _SECTION_HEADER_ANYWHERE.search(decoded) is not None
    )


def _parse(decoded: Any) -> dict[str, Any]:
    if not isinstance(decoded, str):
        raise ValueError("newrecruit-simple: input is not a string")
    lines = _SPLIT_LINES.split(decoded)

    name = "Imported roster"
    faction_raw_name: str | None = None
    declared_limit: int | None = None
    total_reported: int | None = None
    detachment_raw_names: list[str] = []
    battle_size_raw: str | None = None
    force_disposition_raw_name: str | None = None
    units: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    multi_force = False
    section = "preamble"
    enhancement_pts: list[int | None] = []

    def finalize() -> None:
        nonlocal current
        if current is not None:
            enhancement_pts.append(current["enhancement_pts"])
            units.append(_finish_unit(current))
            current = None

    for raw in lines:
        line = raw.strip()
        if not line:
            continue

        # First non-blank line carries `<breadcrumb> - <faction> - <list> - [N pts]`.
        if section == "preamble" and name == "Imported roster":
            first = _parse_first_line(line)
            if first:
                name = first["name"]
                faction_raw_name = first["faction"]
                declared_limit = first["declared_limit"]
                continue

        roster_match = _ROSTER_HEADER.match(line)
        if roster_match:
            total_reported = int(roster_match.group(1))
            continue

        section_match = _SECTION_HEADER.match(line)
        if section_match:
            finalize()
            heading = section_match.group(1).strip().lower()
            if heading == "configuration":
                section = "configuration"
            else:
                section = "units"
                if "allied" in heading:
                    multi_force = True
            continue

        if section == "configuration":
            # Some exports list units directly after Configuration with no units
            # section heading; a `Name [N pts]` line ends the configuration block.
            if _UNIT_LINE.match(line):
                section = "units"
            else:
                idx = line.find(":")
                if idx > 0:
                    key = line[:idx].strip().lower()
                    value = line[idx + 1 :].strip()
                    if key == "battle size":
                        battle_size_raw = value
                    elif key == "list name":
                        name = value
                    elif key == "faction":
                        faction_raw_name = value
                    elif key == "force disposition":
                        force_disposition_raw_name = value
                    elif key == "detachment":
                        # Parenthetical suffixes ("(3 Detachment Points)") are
                        # presentation, not part of the detachment name.
                        detachment_raw_names.append(strip_parenthetical(value))
                continue

        # Unit section. A bullet line extends the *current* unit.
        bullet_match = _BULLET.match(raw)
        if bullet_match and current is not None:
            count = int(bullet_match.group(1))
            # The unit header has no model-count information. Replace its
            # implicit single-model default once, then aggregate every later
            # breakdown, irrespective of whether that breakdown has wargear.
            if not current["saw_bullet"]:
                current["model_count"] = count
                current["saw_bullet"] = True
            else:
                current["model_count"] += count
            # An explicitly empty `:` suffix is a meaningful exact group.
            # Check syntactic presence rather than truthiness so empty groups
            # survive export → import round-trips.
            if bullet_match.group(4) is not None:
                tokens = bullet_match.group(4)
                unit_total = _UNIT_TOTAL_PREFIX.match(tokens) is not None
                group_wargear = _apply_tokens(
                    current,
                    _UNIT_TOTAL_PREFIX.sub("", tokens),
                    1 if unit_total else count,
                )
                if not unit_total:
                    current["loadout_groups"].append(
                        {
                            "model_name": bullet_match.group(2).strip(),
                            "count": count,
                            "wargear": group_wargear,
                        }
                    )
            continue

        unit_match = _UNIT_LINE.match(line)
        if unit_match:
            finalize()
            unit_name = unit_match.group(1).strip()
            pts = int(unit_match.group(2))
            current = _new_unit(unit_name, pts)
            inline_wargear = (unit_match.group(3) or "").strip()
            if inline_wargear:
                _apply_tokens(current, inline_wargear, 1)
            # Leave model_count at the default 1. If `•` bullet lines follow,
            # the bullet handler resets model_count to the summed counts.
            continue

    finalize()

    total_computed = 0
    for i, u in enumerate(units):
        total_computed += u["points"] or 0
        if i < len(enhancement_pts):
            total_computed += enhancement_pts[i] or 0

    return {
        "name": name,
        "generated_by": None,
        "faction_raw_name": faction_raw_name,
        "detachment_raw_names": detachment_raw_names,
        "force_disposition_raw_name": force_disposition_raw_name,
        "battle_size_raw": battle_size_raw,
        "declared_limit": declared_limit,
        "total_reported": total_reported,
        "total_computed": total_computed,
        "units": units,
        "multi_force": multi_force,
    }


newrecruit_simple_adapter = FormatAdapter(id="newrecruit-simple", matches=_matches, parse=_parse)
