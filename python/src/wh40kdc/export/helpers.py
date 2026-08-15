"""Shared helpers for the roster exporters.

Exporters are deterministic and Dataset-free: they read the Roster only and
regenerate format-specific decoration (display names, Char-slot numbering,
displayed unit totals) from what's stored. Anything the Roster doesn't model —
char-slot numbers, the detachment "<X> Character" keyword, secondary-objective
summaries — is either derived heuristically here or dropped.

Python mirror of ``tools/src/export/helpers.ts``. Output is byte-identical to
the TS and Rust implementations (pinned by the export goldens in
``conformance/roster/``).
"""

from __future__ import annotations

import json
from typing import Any

Roster = dict[str, Any]
RosterUnit = dict[str, Any]


def title_case_id(id: str | None) -> str | None:
    """Convert a kebab-case entity id ("chaos-knights") to Title Case
    ("Chaos Knights") — the round-trip best-effort when the Roster doesn't
    store the source's raw faction/detachment name."""
    if id is None:
        return None
    if id == "":
        return id
    return " ".join(seg if seg == "" else seg[0].upper() + seg[1:] for seg in id.split("-"))


def displayed_unit_points(u: RosterUnit) -> int | None:
    """Sum of unit base pts + enhancement pts (the figure text formats display)."""
    if u["points"] is None:
        return None
    return u["points"] + (u.get("enhancement_points") or 0)


def total_army_points(roster: Roster) -> int:
    """Sum of every unit's displayed total + every enhancement cost line."""
    total = 0
    for u in roster["units"]:
        total += u.get("points") or 0
        total += u.get("enhancement_points") or 0
    return total


def attachment_token(u: RosterUnit) -> str | None:
    """Render lossless attachment metadata accepted by paired importers."""
    attachment = u.get("leader_attachment")
    if not attachment:
        return None
    provisional = " [provisional]" if attachment.get("provisional") else ""
    return (
        f"Attachment: {attachment['role']} -> "
        f"{attachment['bodyguard_ref']['raw_name']}{provisional}"
    )


def group_weapons_text(wargear: list[dict[str, Any]]) -> str:
    """Render a loadout group's per-model weapons in source order, with ``Nx``
    for counts >1. Mirror of the TS ``groupWeaponsText``."""
    parts = []
    for w in wargear:
        name = w["ref"]["raw_name"]
        parts.append(f"{w['count']}x {name}" if w["count"] > 1 else name)
    return ", ".join(parts)


def coarsened_loadout_groups(u: RosterUnit) -> list[dict[str, Any]] | None:
    """Coarsen a unit's fine per-model ``loadout_groups`` by merging groups that
    share an identical per-model weapon set (dropping the model-type name) — the
    granularity the WTC ``N with …`` convention wants. Preserves first-seen order.
    ``None`` when the unit carries no loadout groups. Mirror of the TS
    ``coarsenedLoadoutGroups``."""
    groups = u.get("loadout_groups")
    if not groups:
        return None
    index: dict[str, int] = {}
    out: list[dict[str, Any]] = []
    for g in groups:
        key = "|".join(
            sorted(
                f"{w['ref'].get('id') or w['ref']['raw_name']}#{w['count']}" for w in g["wargear"]
            )
        )
        if key in index:
            out[index[key]]["count"] += g["count"]
        else:
            index[key] = len(out)
            out.append({"count": g["count"], "wargear": g["wargear"]})
    return out


def char_slot_assignment(units: list[RosterUnit]) -> list[int | None]:
    """Heuristic re-derivation of which units carry a ``CharN:`` prefix on
    export to a wtc text format.

    The Roster doesn't track unit categories, so "is a character" is
    approximated as "is the warlord OR has an enhancement OR has a leader
    attachment". Numbering follows declaration order. Returns a parallel list:
    ``slots[i]`` is the 1-based char index for unit i, or ``None``.
    """
    result: list[int | None] = []
    next_slot = 1
    for u in units:
        is_char = (
            u.get("is_warlord")
            or u.get("enhancement") is not None
            or u.get("leader_attachment") is not None
        )
        if is_char:
            result.append(next_slot)
            next_slot += 1
        else:
            result.append(None)
    return result


def pretty_json(value: Any) -> str:
    """Pretty JSON with a trailing newline — byte-identical to TS
    ``JSON.stringify(value, null, 2) + "\\n"`` (2-space indent, raw non-ASCII,
    insertion-order keys)."""
    return json.dumps(value, indent=2, ensure_ascii=False, separators=(",", ": ")) + "\n"
