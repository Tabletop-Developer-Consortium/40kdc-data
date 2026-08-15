"""NewRecruit JSON exporter.

Emits a BattleScribe-shaped roster skeleton that round-trips through the
NewRecruit JSON adapter. The shape carries only fields the importer reads:
``name``, ``type``, ``number``, ``costs[]``, ``categories[].name``, ``group``,
and ``catalogueName``. No ``rules`` / ``profiles`` / ``description`` ever
appear — we don't store them, and emitting them would be an IP violation.

Faction and detachment display names come from ``title_case_id(faction_id)``
— the Roster doesn't carry the source's raw faction name, so we reconstruct
it from the kebab-case id. This is the only lossy hop in the JSON round-trip
(e.g. ``tau-empire`` → "Tau Empire" rather than the canonical "T'au Empire").

Python mirror of ``tools/src/export/newrecruit-json.ts``; byte-identical
output, so dict insertion order replicates the TS object field order exactly
and conditional fields are omitted (never ``null``).
"""

from __future__ import annotations

from typing import Any

from wh40kdc.export.helpers import (
    Roster,
    RosterUnit,
    pretty_json,
    title_case_id,
    total_army_points,
)

_PTS_TYPE_ID = "pts-type"
_NEWRECRUIT_XMLNS = "http://www.battlescribe.net/schema/rosterSchema"
_NEWRECRUIT_GENERATED_BY = "https://newrecruit.eu"


def _faction_category(roster: Roster) -> dict[str, Any] | None:
    """Build a "Faction: <name>" category from the unit's roster context."""
    display = title_case_id(roster.get("faction_id"))
    if display is None:
        return None
    return {"name": f"Faction: {display}", "primary": False}


def _wargear_selection(idx: int, w: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": f"w-{idx}",
        "name": w["ref"]["raw_name"],
        "type": "upgrade",
        "number": w["count"],
        # The NewRecruit importer recognises a wargear selection by a category
        # ending in " Weapon" — emit a generic "Ranged Weapon" so we don't
        # have to track ranged-vs-melee separation the Roster doesn't model.
        "categories": [{"name": "Ranged Weapon", "primary": False}],
    }


def _group_model_selection(
    unit_index: int, group_index: int, unit: RosterUnit, group: dict[str, Any]
) -> dict[str, Any]:
    model_name = group.get("model_name")
    if model_name is None:
        model_name = unit["ref"]["raw_name"]
    return {
        "id": f"u{unit_index}-model-{group_index}",
        "name": model_name,
        "type": "model",
        "number": group["count"],
        "selections": [
            _wargear_selection(
                item_index,
                {**item, "count": item["count"] * group["count"]},
            )
            for item_index, item in enumerate(group["wargear"])
        ],
    }


def _unit_selection(idx: int, u: RosterUnit, faction: dict[str, Any] | None) -> dict[str, Any]:
    inner: list[dict[str, Any]] = []
    if u.get("is_warlord"):
        inner.append({"id": f"u{idx}-warlord", "name": "Warlord", "type": "upgrade", "number": 1})
    if u.get("leader_attachment"):
        attachment = u["leader_attachment"]
        status = "provisional" if attachment["provisional"] else "confirmed"
        inner.append(
            {
                "id": f"u{idx}-attachment",
                "name": attachment["bodyguard_ref"]["raw_name"],
                "type": "upgrade",
                "number": 1,
                "group": f"40kdc Attachment:{attachment['role']}:{status}",
            }
        )
    if u.get("enhancement"):
        enh: dict[str, Any] = {
            "id": f"u{idx}-enh",
            "name": u["enhancement"]["raw_name"],
            "type": "upgrade",
            "number": 1,
            "group": "Enhancements",
        }
        if u.get("enhancement_points") is not None:
            enh["costs"] = [
                {"name": "pts", "typeId": _PTS_TYPE_ID, "value": u["enhancement_points"]}
            ]
        inner.append(enh)

    wargear_selections = [_wargear_selection(wi, w) for wi, w in enumerate(u["wargear"])]
    groups = u.get("loadout_groups") or []
    if groups:
        model_selections = [
            _group_model_selection(idx, group_index, u, group)
            for group_index, group in enumerate(groups)
        ]
    else:
        model_selections = [
            {
                "id": f"u{idx}-model",
                "name": u["ref"]["raw_name"],
                "type": "model",
                "number": u["model_count"],
                "selections": wargear_selections,
            }
        ]
    own_categories = [
        *([faction] if faction else []),
        *[
            {"id": f"40kdc-keyword-{index}", "name": keyword, "primary": False}
            for index, keyword in enumerate(u.get("keyword_overrides") or [])
        ],
    ]
    if u["model_count"] <= 1 and not groups:
        sel: dict[str, Any] = {
            "id": f"u-{idx}",
            "name": u["ref"]["raw_name"],
            "type": "model",
            "number": 1,
            "categories": own_categories,
        }
        if u["points"] is not None:
            sel["costs"] = [{"name": "pts", "typeId": _PTS_TYPE_ID, "value": u["points"]}]
        sel["selections"] = [*inner, *wargear_selections]
        return sel
    sel = {
        "id": f"u-{idx}",
        "name": u["ref"]["raw_name"],
        "type": "unit",
        "number": 1,
        "categories": own_categories,
    }
    if u["points"] is not None:
        sel["costs"] = [{"name": "pts", "typeId": _PTS_TYPE_ID, "value": u["points"]}]
    sel["selections"] = [*inner, *model_selections]
    return sel


def _config_selection(name: str, value: str, idx: str) -> dict[str, Any]:
    return {
        "id": f"cfg-{idx}",
        "name": name,
        "type": "upgrade",
        "number": 1,
        "categories": [{"name": "Configuration", "primary": True}],
        "selections": [
            {
                "id": f"cfg-{idx}-val",
                "name": value,
                "type": "upgrade",
                "number": 1,
            }
        ],
    }


def _battle_size_label(roster: Roster) -> str | None:
    declared_limit = roster["points"].get("declared_limit")
    if roster.get("battle_size") == "strike-force":
        limit = declared_limit if declared_limit is not None else 2000
        return f"Strike Force ({limit} Point limit)"
    if roster.get("battle_size") == "incursion":
        limit = declared_limit if declared_limit is not None else 1000
        return f"Incursion ({limit} Point limit)"
    return None


def serialize_newrecruit_json(roster: Roster) -> str:
    faction = _faction_category(roster)
    faction_display = title_case_id(roster.get("faction_id"))
    if faction_display is None:
        faction_display = "Unknown"
    battle_size = _battle_size_label(roster)

    config: list[dict[str, Any]] = []
    if battle_size:
        config.append(_config_selection("Battle Size", battle_size, "battle-size"))
    for d in roster["detachments"]:
        config.append(_config_selection("Detachment", d["ref"]["raw_name"], "detachment"))
    force_disposition = roster.get("force_disposition")
    if force_disposition is not None:
        config.append(
            _config_selection(
                "Force Disposition",
                title_case_id(force_disposition) or force_disposition,
                "force-disposition",
            )
        )

    force = {
        "id": "force-1",
        "name": "Army Roster",
        "catalogueName": faction_display,
        "selections": [
            *config,
            *(_unit_selection(i, u, faction) for i, u in enumerate(roster["units"])),
        ],
    }

    total = total_army_points(roster)

    payload = {
        "name": roster["name"],
        "generatedBy": _NEWRECRUIT_GENERATED_BY,
        "roster": {
            "name": roster["name"],
            "xmlns": _NEWRECRUIT_XMLNS,
            "generatedBy": _NEWRECRUIT_GENERATED_BY,
            "costs": [{"name": "pts", "typeId": _PTS_TYPE_ID, "value": total}],
            "forces": [force],
        },
    }

    return pretty_json(payload)
