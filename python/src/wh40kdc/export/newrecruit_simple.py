"""NewRecruit "simple" markdown-ish text exporter.

Shape::

    <faction> - <list name> - [N pts]

    # ++ Army Roster ++ [N pts]
    ## Configuration
    Battle Size: <Label>
    Detachment: <Name>

    ## Battleline [N pts]
    <Unit> [pts]: <wargear, …, EnhName [N pts], …>
    <Multi-Unit> [pts]:
    • <Nx> <ModelType>: <wargear>

Enhancements are inlined as ``Name [N pts]`` (the only place a ``[N pts]``
bracket re-appears on a token).

Python mirror of ``tools/src/export/newrecruit-simple.ts``; byte-identical
output.
"""

from __future__ import annotations

from wh40kdc.export.helpers import (
    Roster,
    RosterUnit,
    displayed_unit_points,
    group_weapons_text,
    title_case_id,
    total_army_points,
)


def _battle_size_label(roster: Roster) -> str | None:
    declared_limit = roster["points"].get("declared_limit")
    if roster.get("battle_size") == "strike-force":
        limit = declared_limit if declared_limit is not None else 2000
        return f"Strike Force ({limit} Point limit)"
    if roster.get("battle_size") == "incursion":
        limit = declared_limit if declared_limit is not None else 1000
        return f"Incursion ({limit} Point limit)"
    return None


def _wargear_text(u: RosterUnit, per_model_divisor: int) -> str:
    """Build the wargear list inline. For homogeneous multi-model units,
    divides counts by model_count so the per-model render is clean."""
    parts: list[str] = []
    if u.get("enhancement"):
        pts_tag = (
            "" if u.get("enhancement_points") is None else f" [{u['enhancement_points']} pts]"
        )
        parts.append(f"{u['enhancement']['raw_name']}{pts_tag}")
    if u.get("is_warlord"):
        parts.append("Warlord")
    for w in u["wargear"]:
        c = w["count"] // per_model_divisor if per_model_divisor > 0 else w["count"]
        raw_name = w["ref"]["raw_name"]
        parts.append(f"{c}x {raw_name}" if c > 1 else raw_name)
    return ", ".join(parts)


def _lead_tokens(u: RosterUnit) -> list[str]:
    """Unit-level tokens that lead the first wargear line: enhancement then ``Warlord``."""
    parts: list[str] = []
    if u.get("enhancement"):
        pts_tag = "" if u.get("enhancement_points") is None else f" [{u['enhancement_points']} pts]"
        parts.append(f"{u['enhancement']['raw_name']}{pts_tag}")
    if u.get("is_warlord"):
        parts.append("Warlord")
    return parts


def _unit_text(u: RosterUnit) -> list[str]:
    pts = displayed_unit_points(u)
    pts_text = "" if pts is None else f"{pts} pts"

    if u["model_count"] <= 1:
        return [f"{u['ref']['raw_name']} [{pts_text}]: {_wargear_text(u, 1)}"]
    # Multi-model with an exact per-model breakdown: one bullet per model-type
    # group, each named, with the enhancement/Warlord tokens leading the first.
    groups = u.get("loadout_groups")
    if groups:
        lead = _lead_tokens(u)
        lines = [f"{u['ref']['raw_name']} [{pts_text}]:"]
        for i, g in enumerate(groups):
            name = g["model_name"] or u["ref"]["raw_name"]
            weapons = group_weapons_text(g["wargear"])
            tokens = [*(lead if i == 0 else []), *([weapons] if weapons else [])]
            lines.append(f"• {g['count']}x {name}: {', '.join(tokens)}")
        return lines
    # No exact breakdown: homogeneous units divide cleanly; otherwise a single
    # bullet with full counts (the legacy fallback, unit-named).
    divisible = all(w["count"] % u["model_count"] == 0 for w in u["wargear"])
    divisor = u["model_count"] if divisible else 1
    return [
        f"{u['ref']['raw_name']} [{pts_text}]:",
        f"• {u['model_count']}x {u['ref']['raw_name']}: {_wargear_text(u, divisor)}",
    ]


def serialize_newrecruit_simple(roster: Roster) -> str:
    faction = title_case_id(roster.get("faction_id"))
    if faction is None:
        faction = "Unknown"
    detachments = [
        title_case_id(d["ref"]["id"]) or d["ref"]["raw_name"] for d in roster["detachments"]
    ]
    battle = _battle_size_label(roster)
    total = total_army_points(roster)

    lines: list[str] = []
    # First line carries the *declared limit* (the army's points ceiling); the
    # `# ++ Army Roster ++` line carries the *reported total*. They differ
    # when the list isn't filled to the cap.
    limit = roster["points"].get("declared_limit")
    if limit is None:
        limit = total
    lines.append(f"{faction} - {roster['name']} - [{limit} pts]")
    lines.append("")
    lines.append(f"# ++ Army Roster ++ [{total} pts]")
    lines.append("## Configuration")
    if battle:
        lines.append(f"Battle Size: {battle}")
    for detachment in detachments:
        lines.append(f"Detachment: {detachment}")
    lines.append("")

    # The Roster doesn't tag allied vs. battleline per unit; emit one section.
    section_total = sum(
        (u.get("points") or 0) + (u.get("enhancement_points") or 0) for u in roster["units"]
    )
    lines.append(f"## Battleline [{section_total} pts]")
    for u in roster["units"]:
        lines.extend(_unit_text(u))

    return "\n".join(lines) + "\n"
