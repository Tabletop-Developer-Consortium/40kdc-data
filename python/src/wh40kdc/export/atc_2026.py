"""ATC 2026 roster text exporters (``atc-2026-compact`` / ``atc-2026-full``).

These reuse the WTC compact/full *bodies* verbatim (see
:func:`~wh40kdc.export.newrecruit_wtc.wtc_compact_body_lines` /
:func:`~wh40kdc.export.newrecruit_wtc.wtc_full_body_lines`) but replace the
summary header with the block the American Team Championship 2026 list-
submission format asks for: player/team identification, the picked Force
Disposition, every enhancement-bearing model, and the leader/support
attachments spelled out.

Provisional and **export-only** — there is no ATC import adapter, so the format
is additive. The existing WTC formats (and real-world WTC import) are untouched.

Python mirror of ``tools/src/export/atc-2026.ts``; byte-identical output.
"""

from __future__ import annotations

from wh40kdc.export.helpers import (
    Roster,
    RosterUnit,
    char_slot_assignment,
    title_case_id,
    total_army_points,
)
from wh40kdc.export.newrecruit_wtc import (
    _FENCE,
    wtc_compact_body_lines,
    wtc_full_body_lines,
)

_DASH = "—"


def _header(roster: Roster, units: list[RosterUnit], char_slots: list[int | None]) -> str:
    faction = title_case_id(roster.get("faction_id")) or "Unknown"
    disposition = title_case_id(roster.get("force_disposition")) or _DASH
    detachments = roster["detachments"]
    detachment = (
        ", ".join(title_case_id(d["ref"]["id"]) or d["ref"]["raw_name"] for d in detachments)
        if detachments
        else _DASH
    )
    total = roster["points"].get("total_reported")
    if total is None:
        total = total_army_points(roster)

    warlord = _DASH
    for i, u in enumerate(units):
        if u.get("is_warlord"):
            warlord = f"Char{char_slots[i]}: {u['ref']['raw_name']}"
            break

    enh_parts = [
        f"{u['enhancement']['raw_name']} (on Char{char_slots[i]}: {u['ref']['raw_name']})"
        for i, u in enumerate(units)
        if u.get("enhancement") is not None
    ]
    enhancement = "; ".join(enh_parts) if enh_parts else _DASH

    attach_parts = [
        f"{u['ref']['raw_name']} attached to {u['leader_attachment']['bodyguard_ref']['raw_name']}"
        for u in units
        if u.get("leader_attachment") is not None
    ]
    leader_support = "; ".join(attach_parts) if attach_parts else _DASH

    lines = [
        _FENCE,
        f"+ PLAYER NAME: {_DASH}",
        f"+ TEAM NAME: {_DASH}",
        f"+ FACTIONS USED: {faction}",
        f"+ DISPOSITION: {disposition}",
        f"+ DETACHMENT: {detachment}",
        f"+ ARMY POINTS: {total}pts",
        "+",
        f"+ WARLORD: {warlord}",
        f"+ ENHANCEMENT: {enhancement}",
        f"+ LEADER/SUPPORT: {leader_support}",
        f"+ NUMBER OF UNITS: {len(units)}",
        _FENCE,
    ]
    return "\n".join(lines)


def serialize_atc_2026_compact(roster: Roster) -> str:
    units = roster["units"]
    slots = char_slot_assignment(units)
    return "\n".join([_header(roster, units, slots), *wtc_compact_body_lines(units, slots)]) + "\n"


def serialize_atc_2026_full(roster: Roster) -> str:
    units = roster["units"]
    slots = char_slot_assignment(units)
    return "\n".join([_header(roster, units, slots), *wtc_full_body_lines(units, slots)])
