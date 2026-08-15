"""Shared walker for BattleScribe-derived roster trees (ListForge + NewRecruit
JSON).

The TS reference keeps two byte-identical copies of these helpers in
``listforge.ts`` and ``newrecruit-json.ts``; behavior — not file structure —
is what conformance pins, so the Python port shares them here. The walk reads
an ALLOWLIST of fields only — ``name``, ``number``, ``type``,
``categories[].name``, ``group``, ``costs`` point values, and (NewRecruit)
``catalogueName`` — and never touches ``rules[].description`` or ability
``profiles[].characteristics[].$text``, which carry reproduced rules text.
This keeps the importer's output free of copyrighted prose by construction.

Selection-tree shape (recursive ``selections``):

- Configuration nodes (``type: "upgrade"``) named "Detachment" / "Battle Size"
  carry the chosen value as their first child selection.
- Unit nodes (``type: "model" | "unit"``) carry role categories, a points
  cost, and — nested anywhere beneath them — their wargear (weapon-category
  selections), enhancement (a selection whose ``group`` starts
  "Enhancements"), the "Warlord" marker, and model sub-selections.
- Every unit carries a ``"Faction: <Name>"`` category.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator
from typing import Any

PTS_COST_NAME = "pts"
FACTION_CATEGORY = re.compile(r"^Faction:\s*(.+)$")
POINTS_LIMIT = re.compile(r"(\d[\d,]*)\s*Point", re.IGNORECASE)
ENHANCEMENT_GROUP_PREFIX = "Enhancements"
CHARACTER_CATEGORIES = frozenset(["Character", "Epic Hero"])
WEAPON_CATEGORY_SUFFIX = " Weapon"  # "Ranged Weapon", "Melee Weapon", "Psychic Weapon"
NEWRECRUIT_XMLNS = "http://www.battlescribe.net/schema/rosterSchema"
ATTACHMENT_GROUP = re.compile(r"^40kdc Attachment:(leader|support):(confirmed|provisional)$")
NEWRECRUIT_HOST_PREFIX = "https://newrecruit"


def as_array(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _is_number(value: Any) -> bool:
    # JS `typeof x === "number"` — bool is excluded deliberately.
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def selection_name(sel: Any) -> str:
    return as_string(_field(sel, "name")) or ""


def selection_type(sel: Any) -> str:
    return as_string(_field(sel, "type")) or ""


def _field(sel: Any, key: str) -> Any:
    return sel.get(key) if isinstance(sel, dict) else None


def selection_count(sel: Any) -> int:
    """A selection's multiplicity (``number``), defaulting to 1."""
    n = _field(sel, "number")
    return n if _is_number(n) and n > 0 else 1


def points_of(sel: Any) -> int | None:
    """Point value from a selection's cost block, or None when absent."""
    for cost in as_array(_field(sel, "costs")):
        if not isinstance(cost, dict):
            continue
        if as_string(cost.get("name")) == PTS_COST_NAME and _is_number(cost.get("value")):
            return cost["value"]
    return None


def category_names(sel: Any) -> list[str]:
    out = []
    for c in as_array(_field(sel, "categories")):
        name = as_string(c.get("name")) if isinstance(c, dict) else None
        if name is not None:
            out.append(name)
    return out


def child_selections(sel: Any) -> list[Any]:
    return as_array(_field(sel, "selections"))


def walk(sel: Any, visit: Callable[[Any], None]) -> None:
    """Depth-first visit of a selection and everything beneath it."""
    visit(sel)
    for child in child_selections(sel):
        walk(child, visit)


def is_unit_selection(sel: Any) -> bool:
    return selection_type(sel) in ("model", "unit")


def is_character(sel: Any) -> bool:
    return any(n in CHARACTER_CATEGORIES for n in category_names(sel))


def keyword_overrides(sel: Any) -> list[str]:
    """Explicit source keywords emitted by 40kdc's round-trip serializers."""
    return [
        name
        for category in as_array(_field(sel, "categories"))
        if isinstance(category, dict)
        and (as_string(category.get("id")) or "").startswith("40kdc-keyword-")
        and (name := as_string(category.get("name"))) is not None
    ]


def _weapon_collector(target: list[dict[str, Any]]) -> Callable[[Any], None]:
    def collect(selection: Any) -> None:
        if is_weapon_selection(selection):
            target.append(
                {"raw_name": selection_name(selection), "count": selection_count(selection)}
            )

    return collect


def is_weapon_selection(sel: Any) -> bool:
    return any(n.endswith(WEAPON_CATEGORY_SUFFIX) for n in category_names(sel))


def is_enhancement_selection(sel: Any) -> bool:
    group = as_string(_field(sel, "group"))
    return group is not None and group.startswith(ENHANCEMENT_GROUP_PREFIX)


def model_count(unit: Any) -> int:
    """Sum the model count of a unit from its nested model selections."""
    total = 0

    def visit(s: Any) -> None:
        nonlocal total
        if selection_type(s) == "model":
            total += selection_count(s)

    walk(unit, visit)
    return total if total > 0 else selection_count(unit)


def parse_unit(unit: Any) -> dict[str, Any]:
    """Build a parsed unit from a top-level unit selection."""
    wargear: list[dict[str, Any]] = []
    state: dict[str, Any] = {
        "enhancement_raw_name": None,
        "enhancement_points": None,
        "is_warlord": False,
        "leader_attachment": None,
    }

    def visit(s: Any) -> None:
        attachment = ATTACHMENT_GROUP.match(as_string(_field(s, "group")) or "")
        if attachment:
            state["leader_attachment"] = {
                "bodyguard_raw_name": selection_name(s),
                "role": attachment.group(1),
                "provisional": attachment.group(2) == "provisional",
            }
            return
        if is_enhancement_selection(s):
            if state["enhancement_raw_name"] is None:
                state["enhancement_raw_name"] = selection_name(s)
                state["enhancement_points"] = points_of(s)
            return
        if selection_name(s) == "Warlord":
            state["is_warlord"] = True
            return
        if is_weapon_selection(s):
            wargear.append({"raw_name": selection_name(s), "count": selection_count(s)})

    for node in child_selections(unit):
        walk(node, visit)

    loadout_groups: list[dict[str, Any]] = []
    for model in child_selections(unit):
        if selection_type(model) != "model":
            continue
        count = selection_count(model)
        totals: list[dict[str, Any]] = []

        walk(model, _weapon_collector(totals))
        if count > 0 and all(item["count"] % count == 0 for item in totals):
            loadout_groups.append(
                {
                    "model_name": selection_name(model),
                    "count": count,
                    "wargear": [
                        {"raw_name": item["raw_name"], "count": item["count"] // count}
                        for item in totals
                    ],
                }
            )

    overrides = keyword_overrides(unit)

    parsed = {
        "raw_name": selection_name(unit),
        "is_character": is_character(unit),
        "model_count": model_count(unit),
        "points": points_of(unit),
        "is_warlord": state["is_warlord"],
        "enhancement_raw_name": state["enhancement_raw_name"],
        "enhancement_points": state["enhancement_points"],
        "wargear": wargear,
        **({"keyword_overrides": overrides} if overrides else {}),
        **({"leader_attachment": state["leader_attachment"]} if state["leader_attachment"] else {}),
        **({"loadout_groups": loadout_groups} if loadout_groups else {}),
    }
    return parsed


def config_value(selections: list[Any], config_name: str) -> str | None:
    """Value carried as the first child of a named configuration selection."""
    for s in selections:
        if selection_name(s) == config_name:
            children = child_selections(s)
            return selection_name(children[0]) if children else None
    return None


def config_values(selections: list[Any], config_name: str) -> list[str]:
    """Every value under a named config, across repeated blocks and multiple
    children, in source order. Used for multi-detachment 11e lists."""
    out: list[str] = []
    for s in selections:
        if selection_name(s) != config_name:
            continue
        for child in child_selections(s):
            name = selection_name(child)
            if name:
                out.append(name)
    return out


def parse_limit(label: str | None) -> int | None:
    if not label:
        return None
    match = POINTS_LIMIT.search(label)
    if not match:
        return None
    return int(match.group(1).replace(",", ""))


def collect_factions(forces: list[Any]) -> list[str]:
    """All distinct ``"Faction: X"`` category names, in first-seen order."""
    seen: dict[str, None] = {}

    def visit(s: Any) -> None:
        for name in category_names(s):
            match = FACTION_CATEGORY.match(name)
            if match:
                seen.setdefault(match.group(1).strip())

    for force in forces:
        for sel in child_selections(force):
            walk(sel, visit)
    return list(seen)


def roster_of(decoded: Any) -> dict[str, Any] | None:
    if not isinstance(decoded, dict):
        return None
    roster = decoded.get("roster")
    if not isinstance(roster, dict):
        return None
    if not isinstance(roster.get("forces"), list):
        return None
    return roster


def has_newrecruit_signature(decoded: Any, roster: dict[str, Any]) -> bool:
    """Detect a NewRecruit payload: BattleScribe ``rosterSchema`` xmlns or a
    ``generatedBy`` URL pointing at newrecruit.eu."""
    if as_string(roster.get("xmlns")) == NEWRECRUIT_XMLNS:
        return True
    gen_by = as_string(_field(decoded, "generatedBy"))
    if gen_by is None:
        gen_by = as_string(roster.get("generatedBy"))
    return gen_by is not None and gen_by.lower().startswith(NEWRECRUIT_HOST_PREFIX)


def iter_force_tops(roster: dict[str, Any]) -> Iterator[tuple[Any, list[Any]]]:
    for force in as_array(roster.get("forces")):
        yield force, child_selections(force)


def total_computed_of(roster: dict[str, Any]) -> int:
    """Honest computed total: sum every cost line in the tree. A unit's own
    cost and its nested enhancement's cost are distinct lines that together
    make up the unit's army contribution, so a full walk reproduces the army
    total."""
    total = 0

    def visit(s: Any) -> None:
        nonlocal total
        pts = points_of(s)
        if pts:
            total += pts

    for _force, top in iter_force_tops(roster):
        for sel in top:
            walk(sel, visit)
    return total
