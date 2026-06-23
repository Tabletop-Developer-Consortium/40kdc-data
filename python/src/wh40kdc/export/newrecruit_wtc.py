"""NewRecruit wtc-compact and wtc-full text exporters.

Both formats lead with a ``++++++++`` summary header and then list units. The
compact body packs each unit onto one line; the full body uses section headers
(``BATTLELINE`` / ``ALLIED UNITS``) and two-line unit blocks with
``N with <wargear>`` per-model breakdowns.

Faction & detachment display names are reconstructed via
:func:`~wh40kdc.export.helpers.title_case_id`. ``CharN:`` numbering is
re-derived heuristically (see ``char_slot_assignment``). The ``+ SECONDARY:``
summary line is omitted — tournament secondaries aren't modelled in the
Roster.

Python mirror of ``tools/src/export/newrecruit-wtc.ts``; byte-identical
output. Note the asymmetric trailing newline: compact ends with one, full
does not (pinned by the goldens).
"""

from __future__ import annotations

from wh40kdc.export.helpers import (
    Roster,
    RosterUnit,
    char_slot_assignment,
    displayed_unit_points,
    title_case_id,
    total_army_points,
)

_FENCE = "+++++++++++++++++++++++++++++++++++++++++++++++"


def _wargear_list_text(unit: RosterUnit, include_warlord_tag: bool) -> str:
    parts: list[str] = []
    for w in unit["wargear"]:
        raw_name = w["ref"]["raw_name"]
        parts.append(f"{w['count']}x {raw_name}" if w["count"] > 1 else raw_name)
    if include_warlord_tag and unit.get("is_warlord"):
        parts.append("Warlord")
    return ", ".join(parts)


def _header(roster: Roster, units: list[RosterUnit], char_slots: list[int | None]) -> str:
    faction = title_case_id(roster.get("faction_id"))
    if faction is None:
        faction = "Unknown"
    detachments = roster["detachments"]
    detachment = (
        ", ".join(title_case_id(d["ref"]["id"]) or d["ref"]["raw_name"] for d in detachments)
        if detachments
        else None
    )
    points = roster["points"]
    limit = points.get("declared_limit")
    if limit is None:
        limit = total_army_points(roster)
    total = points.get("total_reported")
    if total is None:
        total = total_army_points(roster)

    warlord = "—"
    for i, u in enumerate(units):
        if u.get("is_warlord"):
            warlord = f"Char{char_slots[i]}: {u['ref']['raw_name']}"
            break

    enhancement = "—"
    for i, u in enumerate(units):
        if u.get("enhancement") is not None:
            enhancement = (
                f"{u['enhancement']['raw_name']} (on Char{char_slots[i]}: {u['ref']['raw_name']})"
            )
            break

    lines = [
        _FENCE,
        f"+ LIST NAME: {roster['name']}",
        f"+ FACTION KEYWORD: {faction}",
        f"+ DETACHMENT: {detachment if detachment is not None else '—'}",
        f"+ TOTAL ARMY POINTS: {total}pts",
        f"+ POINTS LIMIT: {limit}pts",
        "+",
        f"+ WARLORD: {warlord}",
        f"+ ENHANCEMENT: {enhancement}",
        f"+ NUMBER OF UNITS: {len(units)}",
        _FENCE,
    ]
    return "\n".join(lines)


def _enhancement_line(u: RosterUnit) -> str:
    if u.get("enhancement_points") is None:
        return f"Enhancement: {u['enhancement']['raw_name']}"
    return f"Enhancement: {u['enhancement']['raw_name']} (+{u['enhancement_points']} pts)"


def wtc_compact_body_lines(units: list[RosterUnit], slots: list[int | None]) -> list[str]:
    """The compact body — one line per unit, wargear inline — that follows the
    summary header. Returned as the lines *after* the header (the leading ``""``
    separator included) so any header variant (WTC or ATC 2026) can prepend its
    own block. Compact callers append a trailing newline."""
    lines = [""]
    for i, u in enumerate(units):
        prefix = f"Char{slots[i]}: " if slots[i] is not None else ""
        pts = displayed_unit_points(u)
        pts_text = "" if pts is None else f"{pts} pts"
        lines.append(
            f"{prefix}{u['model_count']}x {u['ref']['raw_name']} ({pts_text}): "
            f"{_wargear_list_text(u, True)}"
        )
        if u.get("enhancement"):
            lines.append(_enhancement_line(u))
    return lines


def serialize_newrecruit_wtc_compact(roster: Roster) -> str:
    units = roster["units"]
    slots = char_slot_assignment(units)
    return "\n".join([_header(roster, units, slots), *wtc_compact_body_lines(units, slots)]) + "\n"


def _multi_model_with_line(u: RosterUnit) -> str:
    """For a multi-model unit, render its wargear as ``N with <per-model list>``
    when the wargear divides evenly across models (the natural NewRecruit
    form). Otherwise emit ``1 with <full Nx counts>`` so the counts round-trip
    exactly."""
    model_count = u["model_count"]
    divisible = all(w["count"] % model_count == 0 for w in u["wargear"])
    if divisible:
        per_model = []
        for w in u["wargear"]:
            c = w["count"] // model_count
            raw_name = w["ref"]["raw_name"]
            per_model.append(f"{c}x {raw_name}" if c > 1 else raw_name)
        per_model = [s for s in per_model if s != ""]
        if u.get("is_warlord"):
            per_model.append("Warlord")
        return f"{model_count} with {', '.join(per_model)}"
    return f"1 with {_wargear_list_text(u, True)}"


def wtc_full_body_lines(units: list[RosterUnit], slots: list[int | None]) -> list[str]:
    """The full body — section headers plus two-line unit blocks — that follows
    the summary header. Returned as the lines *after* the header (the leading
    ``""`` separator included). Unlike compact, full callers do not append a
    trailing newline.

    The Roster doesn't tag allied units per-unit (the multi-force fact is a
    diagnostic warning), so this collapses to one BATTLELINE section."""
    lines = ["", "BATTLELINE", ""]
    for i, u in enumerate(units):
        prefix = f"Char{slots[i]}: " if slots[i] is not None else ""
        pts = displayed_unit_points(u)
        pts_text = "" if pts is None else f"{pts} pts"
        lines.append(f"{prefix}{u['model_count']}x {u['ref']['raw_name']} ({pts_text})")

        if u["model_count"] > 1:
            lines.append(_multi_model_with_line(u))
        else:
            lines.append(f"1 with {_wargear_list_text(u, True)}")

        if u.get("enhancement"):
            lines.append(_enhancement_line(u))
        lines.append("")
    return lines


def serialize_newrecruit_wtc_full(roster: Roster) -> str:
    units = roster["units"]
    slots = char_slot_assignment(units)
    return "\n".join([_header(roster, units, slots), *wtc_full_body_lines(units, slots)])
