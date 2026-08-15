"""ListForge adapter: lower a decoded ListForge "share JSON" payload (a
BattleScribe-derived roster tree) to a ``ParsedRoster``.

Python mirror of ``tools/src/import/listforge.ts``; tree-walking helpers live
in :mod:`wh40kdc.imports.battlescribe`.
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


def _matches(decoded: Any) -> bool:
    roster = roster_of(decoded)
    if roster is None:
        return False
    # NewRecruit-flavoured BattleScribe payloads route to the NewRecruit
    # adapter; excluding them keeps the greedy first-match dispatch disjoint.
    return not has_newrecruit_signature(decoded, roster)


def _parse(decoded: Any) -> dict[str, Any]:
    roster = roster_of(decoded)
    if roster is None:
        raise ValueError("listforge: payload has no roster.forces array")

    # Configuration lives among each force's top-level selections.
    detachment_raw_names: list[str] = []
    battle_size_raw: str | None = None
    units: list[dict[str, Any]] = []
    for _force, top in iter_force_tops(roster):
        detachment_raw_names.extend(config_values(top, "Detachment"))
        if battle_size_raw is None:
            battle_size_raw = config_value(top, "Battle Size")
        for sel in top:
            if is_unit_selection(sel):
                unit = parse_unit(sel)
                unit.pop("loadout_groups", None)
                units.append(unit)

    forces = roster.get("forces") or []
    factions = collect_factions(forces)
    total_reported = points_of(roster)

    name = as_string(decoded.get("name") if isinstance(decoded, dict) else None)
    if name is None:
        name = as_string(roster.get("name"))
    generated_by = as_string(decoded.get("generatedBy") if isinstance(decoded, dict) else None)

    return {
        "name": name if name is not None else "Imported roster",
        "generated_by": generated_by,
        "faction_raw_name": factions[0] if factions else None,
        "detachment_raw_names": detachment_raw_names,
        "battle_size_raw": battle_size_raw,
        "declared_limit": parse_limit(battle_size_raw),
        "total_reported": total_reported,
        "total_computed": total_computed_of(roster),
        "units": units,
        "multi_force": len(factions) > 1,
    }


listforge_adapter = FormatAdapter(id="listforge", matches=_matches, parse=_parse)
