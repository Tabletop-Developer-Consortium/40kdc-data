"""NewRecruit JSON adapter: lower a decoded NewRecruit roster export (a
BattleScribe-derived tree, same outer shape as ListForge) to a
``ParsedRoster``.

NewRecruit-specific signals used to detect the format: ``generatedBy``
reports the NewRecruit URL ("https://newrecruit.eu"), and/or ``roster.xmlns``
is the BattleScribe rosterSchema namespace. The primary faction surfaces in
``forces[].catalogueName`` (e.g. "Chaos - Chaos Knights") — we take the
segment after the final " - ", falling back to the first ``"Faction: X"``
category.

Python mirror of ``tools/src/import/newrecruit-json.ts``; tree-walking
helpers live in :mod:`wh40kdc.imports.battlescribe`.
"""

from __future__ import annotations

from typing import Any

from wh40kdc.imports.adapter import FormatAdapter
from wh40kdc.imports.battlescribe import (
    as_string,
    collect_factions,
    config_value,
    config_values,
    has_newrecruit_signature,
    is_unit_selection,
    iter_force_tops,
    parse_limit,
    parse_unit,
    points_of,
    roster_of,
    total_computed_of,
)


def _primary_faction_from_catalogue(forces: list[Any]) -> str | None:
    """Primary faction from a force's ``catalogueName``
    (e.g. "Chaos - Chaos Knights" → "Chaos Knights")."""
    for force in forces:
        name = as_string(force.get("catalogueName")) if isinstance(force, dict) else None
        if not name:
            continue
        last = name.split(" - ")[-1].strip()
        if last:
            return last
    return None


def _matches(decoded: Any) -> bool:
    roster = roster_of(decoded)
    if roster is None:
        return False
    return has_newrecruit_signature(decoded, roster)


def _parse(decoded: Any) -> dict[str, Any]:
    roster = roster_of(decoded)
    if roster is None:
        raise ValueError("newrecruit-json: payload has no roster.forces array")

    detachment_raw_names: list[str] = []
    battle_size_raw: str | None = None
    force_disposition_raw_name: str | None = None
    units: list[dict[str, Any]] = []
    for _force, top in iter_force_tops(roster):
        detachment_raw_names.extend(config_values(top, "Detachment"))
        if battle_size_raw is None:
            battle_size_raw = config_value(top, "Battle Size")
        if force_disposition_raw_name is None:
            force_disposition_raw_name = config_value(top, "Force Disposition")
        for sel in top:
            if is_unit_selection(sel):
                unit = parse_unit(sel)
                unit.setdefault("keyword_overrides", [])
                unit.setdefault("leader_attachment", None)
                units.append(unit)

    forces = roster.get("forces") or []
    factions = collect_factions(forces)
    primary_faction = _primary_faction_from_catalogue(forces)
    if primary_faction is None:
        primary_faction = factions[0] if factions else None
    total_reported = points_of(roster)

    payload_name = as_string(decoded.get("name") if isinstance(decoded, dict) else None)
    name = payload_name if payload_name is not None else as_string(roster.get("name"))
    generated_by = as_string(decoded.get("generatedBy") if isinstance(decoded, dict) else None)
    if generated_by is None:
        generated_by = as_string(roster.get("generatedBy"))

    return {
        "name": name if name is not None else "Imported roster",
        "generated_by": generated_by,
        "faction_raw_name": primary_faction,
        "detachment_raw_names": detachment_raw_names,
        "force_disposition_raw_name": force_disposition_raw_name,
        "battle_size_raw": battle_size_raw,
        "declared_limit": parse_limit(battle_size_raw),
        "total_reported": total_reported,
        "total_computed": total_computed_of(roster),
        "units": units,
        "multi_force": len(factions) > 1,
    }


newrecruit_json_adapter = FormatAdapter(id="newrecruit-json", matches=_matches, parse=_parse)
