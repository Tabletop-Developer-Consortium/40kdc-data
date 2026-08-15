"""Rosterizer adapter: lower a Rosterizer roster JSON payload to a
``ParsedRoster``.

Rosterizer (https://rosterizer.com) stores a roster as a ``Roster`` envelope
with a recursive ``Asset`` tree under ``snapshot`` (or
``history.present.roster`` as a fallback). Every entity is an ``Asset`` keyed
by ``Classification§Designation`` (e.g. ``"Unit§Tactical Squad"``). Children
sit under ``assets.included`` (game pieces) and ``assets.traits`` (modifiers,
abilities, markers).

**IP safety**: the walk reads an ALLOWLIST — ``item``, ``designation``,
``name``, ``classification``, ``quantity``, ``meta.points``,
``stats.Points.value``, and the recursive ``assets.included``/
``assets.traits`` children. Prose-bearing fields are never touched.

Python mirror of ``tools/src/import/rosterizer.ts``.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from typing import Any

from wh40kdc.imports.adapter import FormatAdapter

# --- 40K rulebook Classification§Designation conventions. --------------------

_CLS_FACTION = "Faction"
_CLS_DETACHMENT = "Detachment"
_CLS_UNIT = "Unit"
_CLS_SQUAD = "Squad"  # alternative unit class some rulebooks use
_CLS_MODEL = "Model"
_CLS_WEAPON = "Weapon"
_CLS_ENHANCEMENT = "Enhancement"
_CLS_BATTLE_SIZE = "Battle Size"
_CLS_FORCE_DISPOSITION = "Force Disposition"
_CLS_TRAIT = "Trait"
_CLS_ATTACHMENT = "Attachment"
_CLS_KEYWORD_OVERRIDE = "40kdc Keyword"
_DSG_WARLORD = "Warlord"
_CHAR_CLASSIFICATIONS = frozenset(["Character", "Epic Hero"])

_POINTS_STAT_KEYS = ("Points", "Pts")
_POINTS_LIMIT = re.compile(r"(\d[\d,]*)\s*Point", re.IGNORECASE)
_ATTACHMENT = re.compile(
    r"^Attachment:\s*(leader|support)\s*->\s*(.+?)(\s+\[provisional\])?\s*$",
    re.IGNORECASE,
)

# --- Structural views --------------------------------------------------------


def _as_array(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_object(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _model_wargear_collector(
    target: list[dict[str, Any]], model_count: int
) -> Callable[[dict[str, Any]], None]:
    def collect(asset: dict[str, Any]) -> None:
        if not _is_weapon_asset(asset):
            return
        quantity = _quantity(asset)
        target.append(
            {
                "raw_name": _display_name(asset),
                "count": (
                    quantity // model_count
                    if model_count > 0 and quantity % model_count == 0
                    else quantity
                ),
            }
        )

    return collect


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        return value
    if isinstance(value, str):
        m = re.match(r"\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?", value)
        if m:
            try:
                n = float(m.group(0))
            except ValueError:
                return None
            return n if math.isfinite(n) else None
    return None


def _split_item(asset: dict[str, Any]) -> tuple[str, str]:
    """Split ``Classification§Designation`` into its two halves. Falls back to
    the raw ``classification``/``designation`` fields when ``item`` is absent."""
    item = _as_string(asset.get("item"))
    if item is not None:
        idx = item.find("§")
        if idx >= 0:
            return item[:idx], item[idx + 1 :]
    return (
        _as_string(asset.get("classification")) or "",
        _as_string(asset.get("designation")) or "",
    )


def _display_name(asset: dict[str, Any]) -> str:
    """A user-facing display name for an asset: ``name`` override beats the
    designation parsed out of the ``item`` key."""
    name = _as_string(asset.get("name"))
    return name if name is not None else _split_item(asset)[1]


def _quantity(asset: dict[str, Any]) -> int:
    n = _as_number(asset.get("quantity"))
    return math.trunc(n) if n is not None and n > 0 else 1


def _included(asset: dict[str, Any]) -> list[dict[str, Any]]:
    a = _as_object(asset.get("assets"))
    return [c for c in _as_array(a.get("included") if a else None) if isinstance(c, dict)]


def _traits(asset: dict[str, Any]) -> list[dict[str, Any]]:
    a = _as_object(asset.get("assets"))
    return [c for c in _as_array(a.get("traits") if a else None) if isinstance(c, dict)]


def _points_of(asset: dict[str, Any]) -> int | None:
    """Points cost from ``stats.Points.value`` (or aliases) / ``meta.points``."""
    stats = _as_object(asset.get("stats"))
    if stats:
        for key in _POINTS_STAT_KEYS:
            stat = _as_object(stats.get(key))
            if stat:
                v = _as_number(stat.get("value"))
                if v is not None:
                    return math.trunc(v)
    meta = _as_object(asset.get("meta"))
    if meta:
        v = _as_number(meta.get("points"))
        if v is not None:
            return math.trunc(v)
    return None


def _walk(asset: dict[str, Any], visit: Callable[[dict[str, Any]], None]) -> None:
    """Depth-first visit of an asset and every included/trait descendant."""
    visit(asset)
    for child in _included(asset):
        _walk(child, visit)
    for child in _traits(asset):
        _walk(child, visit)


def _class_of(asset: dict[str, Any]) -> str:
    return _split_item(asset)[0]


def _is_unit_asset(asset: dict[str, Any]) -> bool:
    return _class_of(asset) in (_CLS_UNIT, _CLS_SQUAD)


def _is_weapon_asset(asset: dict[str, Any]) -> bool:
    cls = _class_of(asset)
    # Match exact "Weapon", or any "<X> Weapon" (e.g. "Ranged Weapon").
    return cls == _CLS_WEAPON or cls.endswith(f" {_CLS_WEAPON}")


def _is_enhancement_asset(asset: dict[str, Any]) -> bool:
    return _class_of(asset) == _CLS_ENHANCEMENT


def _is_character_asset(asset: dict[str, Any]) -> bool:
    keywords = _as_object(asset.get("keywords"))
    if keywords:
        for kw_list in keywords.values():
            for kw in _as_array(kw_list):
                if isinstance(kw, str) and kw in _CHAR_CLASSIFICATIONS:
                    return True
    # Any nested trait classified as Character also flags the unit.
    for t in _traits(asset):
        if _class_of(t) in _CHAR_CLASSIFICATIONS:
            return True
        if _display_name(t) in _CHAR_CLASSIFICATIONS:
            return True
    return False


def _is_warlord_trait(asset: dict[str, Any]) -> bool:
    classification, designation = _split_item(asset)
    if designation == _DSG_WARLORD:
        return True
    return classification == _CLS_TRAIT and designation == _DSG_WARLORD


def _model_count(unit: dict[str, Any]) -> int:
    """Sum explicit unit/model child quantities; fall back to the unit's own
    quantity for single-model entries."""
    nested = 0
    for child in _included(unit):
        if _is_unit_asset(child) or _class_of(child) == _CLS_MODEL:
            nested += _quantity(child)
    return nested if nested > 0 else _quantity(unit)


def _parse_unit(unit: dict[str, Any]) -> dict[str, Any]:
    wargear: list[dict[str, Any]] = []
    state: dict[str, Any] = {
        "enhancement_raw_name": None,
        "enhancement_points": None,
        "is_warlord": False,
        "leader_attachment": None,
    }
    keyword_overrides: dict[str, None] = {}

    def visit(a: dict[str, Any]) -> None:
        if _class_of(a) == _CLS_ATTACHMENT:
            match = _ATTACHMENT.match(_display_name(a))
            if match:
                state["leader_attachment"] = {
                    "role": match.group(1).lower(),
                    "bodyguard_raw_name": match.group(2),
                    "provisional": match.group(3) is not None,
                }
            return
        if _is_enhancement_asset(a):
            if state["enhancement_raw_name"] is None:
                state["enhancement_raw_name"] = _display_name(a)
                state["enhancement_points"] = _points_of(a)
            return
        if _is_weapon_asset(a):
            wargear.append({"raw_name": _display_name(a), "count": _quantity(a)})

    for child in _included(unit):
        _walk(child, visit)

    def visit_trait(a: dict[str, Any]) -> None:
        if _is_warlord_trait(a):
            state["is_warlord"] = True
        classification, designation = _split_item(a)
        if classification == _CLS_KEYWORD_OVERRIDE:
            keyword_overrides.setdefault(designation, None)
        elif classification in _CHAR_CLASSIFICATIONS:
            keyword_overrides.setdefault("Character", None)

    for t in _traits(unit):
        _walk(t, visit_trait)
    loadout_groups = []
    for child in _included(unit):
        if _class_of(child) != _CLS_MODEL:
            continue
        model_wargear: list[dict[str, Any]] = []
        model_count = _quantity(child)

        _walk(child, _model_wargear_collector(model_wargear, model_count))
        loadout_groups.append(
            {
                "model_name": _display_name(child),
                "count": model_count,
                "wargear": model_wargear,
            }
        )

    return {
        "raw_name": _display_name(unit),
        "is_character": _is_character_asset(unit),
        **({"keyword_overrides": list(keyword_overrides)} if keyword_overrides else {}),
        "model_count": _model_count(unit),
        "points": _points_of(unit),
        "is_warlord": state["is_warlord"],
        "enhancement_raw_name": state["enhancement_raw_name"],
        "enhancement_points": state["enhancement_points"],
        "wargear": wargear,
        "leader_attachment": state["leader_attachment"],
        **({"loadout_groups": loadout_groups} if loadout_groups else {}),
    }


def _snapshot_of(env: dict[str, Any]) -> dict[str, Any] | None:
    """Resolve the snapshot Asset tree from an envelope, preferring the
    explicit ``snapshot`` field but falling through to the history-present
    roster."""
    snap = _as_object(env.get("snapshot"))
    if snap:
        return snap
    history = _as_object(env.get("history"))
    present = _as_object(history.get("present")) if history else None
    if present:
        present_roster = _as_object(present.get("roster"))
        if present_roster:
            return present_roster
    return None


def _is_rosterizer_envelope(decoded: Any) -> bool:
    env = _as_object(decoded)
    if not env:
        return False
    if not _as_object(env.get("rulebook")):
        return False
    return _snapshot_of(env) is not None


def _parse_limit(label: str | None) -> int | None:
    if not label:
        return None
    match = _POINTS_LIMIT.search(label)
    if not match:
        return None
    return int(match.group(1).replace(",", ""))


def _matches(decoded: Any) -> bool:
    return _is_rosterizer_envelope(decoded)


def _parse(decoded: Any) -> dict[str, Any]:
    if not _is_rosterizer_envelope(decoded):
        raise ValueError("rosterizer: payload is not a Rosterizer roster envelope")
    snapshot = _snapshot_of(decoded)
    if snapshot is None:
        raise ValueError("rosterizer: envelope has no snapshot or history.present.roster")

    # Treat the snapshot as the roster root regardless of its `item` value —
    # some exports root at `Roster§Roster`, others at the faction itself.
    root = snapshot

    # Roster-level metadata children: first child Asset of each classification.
    # Walk the whole tree so nested-force shapes still pick up the markers.
    meta_state: dict[str, Any] = {
        "faction_raw_name": None,
        "detachment_raw_names": [],
        "battle_size_raw": None,
        "force_disposition_raw_name": None,
    }
    factions: list[str] = []

    def visit_meta(a: dict[str, Any]) -> None:
        cls = _class_of(a)
        if cls == _CLS_FACTION:
            name = _display_name(a)
            if name not in factions:
                factions.append(name)
            if meta_state["faction_raw_name"] is None:
                meta_state["faction_raw_name"] = name
        elif cls == _CLS_DETACHMENT:
            meta_state["detachment_raw_names"].append(_display_name(a))
        elif cls == _CLS_BATTLE_SIZE:
            if meta_state["battle_size_raw"] is None:
                meta_state["battle_size_raw"] = _display_name(a)
        elif cls == _CLS_FORCE_DISPOSITION:
            if meta_state["force_disposition_raw_name"] is None:
                meta_state["force_disposition_raw_name"] = _display_name(a)

    _walk(root, visit_meta)

    # Collect units: any Unit/Squad asset anywhere in the tree. A unit nested
    # under another unit (leader on a body, etc.) is emitted as its own
    # top-level ParsedUnit so the resolver can match its id and the
    # leader-attachment inference pass can link the two.
    units: list[dict[str, Any]] = []

    def collect_units(a: dict[str, Any], under_unit: bool) -> None:
        if _is_unit_asset(a) and not under_unit:
            units.append(_parse_unit(a))
            for c in _included(a):
                collect_units(c, True)
            for c in _traits(a):
                collect_units(c, True)
            return
        if _is_unit_asset(a) and under_unit:
            units.append(_parse_unit(a))
            return
        for c in _included(a):
            collect_units(c, under_unit)
        for c in _traits(a):
            collect_units(c, under_unit)

    collect_units(root, False)

    # Roster-level total: prefer an explicit Points stat on the root, else
    # sum every unit's (base + enhancement) contribution.
    total_reported = _points_of(root)
    total_computed = 0
    for u in units:
        total_computed += u["points"] or 0
        total_computed += u["enhancement_points"] or 0

    rulebook = _as_object(decoded.get("rulebook"))
    generated_by = None
    if rulebook:
        generated_by = _as_string(rulebook.get("name"))
        if generated_by is None:
            generated_by = _as_string(rulebook.get("url"))
    name = _display_name(root)
    if not name:
        name = (_as_string(rulebook.get("name")) if rulebook else None) or "Imported roster"

    battle_size_raw = meta_state["battle_size_raw"]
    return {
        "name": name,
        "generated_by": generated_by,
        "faction_raw_name": meta_state["faction_raw_name"],
        "detachment_raw_names": meta_state["detachment_raw_names"],
        "force_disposition_raw_name": meta_state["force_disposition_raw_name"],
        "battle_size_raw": battle_size_raw,
        "declared_limit": _parse_limit(battle_size_raw),
        "total_reported": total_reported,
        "total_computed": total_computed,
        "units": units,
        "multi_force": len(factions) > 1,
    }


rosterizer_adapter = FormatAdapter(id="rosterizer", matches=_matches, parse=_parse)
