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
    attachment_token,
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


def _unit_tokens(u: RosterUnit) -> list[str]:
    parts: list[str] = []
    attachment = attachment_token(u)
    if attachment:
        parts.append(attachment)
    if u.get("enhancement"):
        points = u.get("enhancement_points")
        pts_tag = "" if points is None else f" [{points} pts]"
        prefix = "Enhancement: " if points is None else ""
        parts.append(f"{prefix}{u['enhancement']['raw_name']}{pts_tag}")
    if u.get("is_warlord"):
        parts.append("Warlord")
    for keyword in u.get("keyword_overrides") or []:
        parts.append(
            "Detachment Character" if keyword == "Character" else f"40kdc Keyword: {keyword}"
        )
    return parts


def _wargear_text(u: RosterUnit, per_model_divisor: int) -> str:
    """Build the wargear list inline. For homogeneous multi-model units,
    divides counts by model_count so the per-model render is clean."""
    parts = _unit_tokens(u)
    for w in u["wargear"]:
        c = w["count"] // per_model_divisor if per_model_divisor > 0 else w["count"]
        raw_name = w["ref"]["raw_name"]
        parts.append(f"{c}x {raw_name}" if c > 1 else raw_name)
    return ", ".join(parts)


def _unit_text(u: RosterUnit) -> list[str]:
    pts = displayed_unit_points(u)
    pts_text = "" if pts is None else f"{pts} pts"

    if u["model_count"] <= 1 and not u.get("loadout_groups"):
        return [f"{u['ref']['raw_name']} [{pts_text}]: {_wargear_text(u, 1)}"]
    # Preserve exact per-model groups for both single- and multi-model units,
    # with enhancement/Warlord tokens leading the first group.
    groups = u.get("loadout_groups")
    if groups:
        lead = _unit_tokens(u)
        lines = [f"{u['ref']['raw_name']} [{pts_text}]:"]
        for i, g in enumerate(groups):
            name = g["model_name"] or u["ref"]["raw_name"]
            weapons = group_weapons_text(g["wargear"])
            tokens = [*(lead if i == 0 else []), *([weapons] if weapons else [])]
            lines.append(f"• {g['count']}x {name}: {', '.join(tokens)}")
        return lines
    # No exact breakdown: homogeneous units divide cleanly. Heterogeneous
    # aggregates use an explicit marker so re-import does not multiply
    # already-squad-wide weapon counts.
    divisible = all(w["count"] % u["model_count"] == 0 for w in u["wargear"])
    loadout = _wargear_text(u, u["model_count"] if divisible else 1)
    return [
        f"{u['ref']['raw_name']} [{pts_text}]:",
        f"• {u['model_count']}x {u['ref']['raw_name']}: "
        f"{loadout if divisible else f'Unit total: {loadout}'}",
    ]


def serialize_newrecruit_simple(roster: Roster) -> str:
    faction = title_case_id(roster.get("faction_id"))
    if faction is None:
        faction = "Unknown"
    detachments = [d["ref"]["raw_name"] for d in roster["detachments"]]
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
    lines.append(f"List Name: {roster['name']}")
    lines.append(f"Faction: {faction}")
    if battle:
        lines.append(f"Battle Size: {battle}")
    for detachment in detachments:
        lines.append(f"Detachment: {detachment}")
    if roster.get("force_disposition") is not None:
        lines.append(f"Force Disposition: {title_case_id(roster['force_disposition'])}")
    lines.append("")

    # The Roster doesn't tag allied vs. battleline per unit; emit one section.
    section_total = sum(
        (u.get("points") or 0) + (u.get("enhancement_points") or 0) for u in roster["units"]
    )
    lines.append(f"## Battleline [{section_total} pts]")
    for u in roster["units"]:
        lines.extend(_unit_text(u))

    return "\n".join(lines) + "\n"
