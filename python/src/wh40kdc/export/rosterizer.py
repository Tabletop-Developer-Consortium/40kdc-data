"""Rosterizer serializer.

Emits a Rosterizer-shaped roster JSON skeleton that round-trips through the
Rosterizer adapter. The shape carries only fields the importer reads:
``rulebook`` (envelope), ``snapshot`` (an ``Asset`` tree rooted at
``Roster§Roster``), and per-unit ``item``/``name``/``quantity``/
``stats.Points.value``/``assets.included``/``assets.traits``. No ``text``,
``description``, ``rules``, ``lineage``, ``_layers``, ``classIdentity``,
``processed``, or ``bareResourceKey`` ever appear — they aren't stored in the
Roster and emitting them could leak prose.

Faction and detachment display names come from ``title_case_id`` — the same
lossy hop as the NewRecruit JSON serializer.

Python mirror of ``tools/src/export/rosterizer.ts``; byte-identical output.
"""

from __future__ import annotations

from typing import Any

from wh40kdc.export.helpers import (
    Roster,
    RosterUnit,
    attachment_token,
    pretty_json,
    title_case_id,
    total_army_points,
)

# Mirror the importer's constants (kept inline rather than imported so the
# exporter stays decoupled — the seams are the `item` keys themselves).
_CLS_ROSTER = "Roster"
_CLS_FACTION = "Faction"
_CLS_DETACHMENT = "Detachment"
_CLS_UNIT = "Unit"
_CLS_MODEL = "Model"
_CLS_WEAPON = "Weapon"
_CLS_ENHANCEMENT = "Enhancement"
_CLS_BATTLE_SIZE = "Battle Size"
_CLS_TRAIT = "Trait"
_CLS_FORCE_DISPOSITION = "Force Disposition"
_CLS_ATTACHMENT = "Attachment"
_CLS_CHARACTER = "Character"
_CLS_KEYWORD_OVERRIDE = "40kdc Keyword"
_DSG_WARLORD = "Warlord"

_RULEBOOK = {
    "name": "40kdc",
    "game": "Warhammer 40,000",
    "publisher": "Alpaca Software",
    "url": "https://40kdc.dev",
    "genre": "wargame",
}


def _key(classification: str, designation: str) -> str:
    return f"{classification}§{designation}"


def _wargear_asset(w: dict[str, Any]) -> dict[str, Any]:
    return {
        "item": _key(_CLS_WEAPON, w["ref"]["raw_name"]),
        "name": w["ref"]["raw_name"],
        "quantity": w["count"],
    }


def _enhancement_asset(u: RosterUnit) -> dict[str, Any] | None:
    if not u.get("enhancement"):
        return None
    asset = {
        "item": _key(_CLS_ENHANCEMENT, u["enhancement"]["raw_name"]),
        "name": u["enhancement"]["raw_name"],
        "quantity": 1,
    }
    if u.get("enhancement_points") is not None:
        asset["stats"] = {"Points": {"value": u["enhancement_points"]}}
    return asset


def _warlord_trait_asset() -> dict[str, Any]:
    return {"item": _key(_CLS_TRAIT, _DSG_WARLORD), "name": _DSG_WARLORD, "quantity": 1}


def _attachment_asset(u: RosterUnit) -> dict[str, Any] | None:
    display = attachment_token(u)
    if display is None:
        return None
    return {"item": _key(_CLS_ATTACHMENT, display), "name": display, "quantity": 1}


def _keyword_trait_asset(keyword: str) -> dict[str, Any]:
    if keyword == "Character":
        return {
            "item": _key(_CLS_CHARACTER, "Detachment Character"),
            "name": "Detachment Character",
            "quantity": 1,
        }
    return {
        "item": _key(_CLS_KEYWORD_OVERRIDE, keyword),
        "name": keyword,
        "quantity": 1,
    }


def _loadout_group_assets(u: RosterUnit) -> list[dict[str, Any]] | None:
    groups = u.get("loadout_groups")
    if not groups:
        return None
    return [
        {
            "item": _key(
                _CLS_MODEL,
                group["model_name"]
                if group.get("model_name") is not None
                else u["ref"]["raw_name"],
            ),
            "name": group["model_name"]
            if group.get("model_name") is not None
            else u["ref"]["raw_name"],
            "quantity": group["count"],
            "assets": {
                "included": [
                    _wargear_asset({**item, "count": item["count"] * group["count"]})
                    for item in group["wargear"]
                ]
            },
        }
        for group in groups
    ]


def _unit_asset(u: RosterUnit) -> dict[str, Any]:
    included: list[dict[str, Any]] = []
    attachment = _attachment_asset(u)
    enhancement = _enhancement_asset(u)
    if attachment is not None:
        included.append(attachment)
    if enhancement is not None:
        included.append(enhancement)
    loadout_groups = _loadout_group_assets(u)
    if loadout_groups:
        included.extend(loadout_groups)
    else:
        included.extend(_wargear_asset(w) for w in u["wargear"])

    traits: list[dict[str, Any]] = []
    if u.get("is_warlord"):
        traits.append(_warlord_trait_asset())
    traits.extend(_keyword_trait_asset(keyword) for keyword in u.get("keyword_overrides") or [])

    asset: dict[str, Any] = {
        "item": _key(_CLS_UNIT, u["ref"]["raw_name"]),
        "name": u["ref"]["raw_name"],
        "quantity": u["model_count"],
    }
    if u["points"] is not None:
        asset["stats"] = {"Points": {"value": u["points"]}}
    if included or traits:
        asset["assets"] = {}
        if included:
            asset["assets"]["included"] = included
        if traits:
            asset["assets"]["traits"] = traits
    return asset


def _named_asset(cls: str, display: str | None) -> dict[str, Any] | None:
    if display is None:
        return None
    return {"item": _key(cls, display), "name": display, "quantity": 1}


def _battle_size_asset(roster: Roster) -> dict[str, Any] | None:
    declared_limit = roster["points"].get("declared_limit")
    if roster.get("battle_size") == "strike-force":
        limit = declared_limit if declared_limit is not None else 2000
        label = f"Strike Force ({limit} Point limit)"
        return {"item": _key(_CLS_BATTLE_SIZE, label), "name": label, "quantity": 1}
    if roster.get("battle_size") == "incursion":
        limit = declared_limit if declared_limit is not None else 1000
        label = f"Incursion ({limit} Point limit)"
        return {"item": _key(_CLS_BATTLE_SIZE, label), "name": label, "quantity": 1}
    return None


def serialize_rosterizer(roster: Roster) -> str:
    included: list[dict[str, Any]] = []
    faction = _named_asset(_CLS_FACTION, title_case_id(roster.get("faction_id")))
    if faction:
        included.append(faction)
    for d in roster["detachments"]:
        asset = _named_asset(_CLS_DETACHMENT, d["ref"]["raw_name"])
        if asset:
            included.append(asset)
    force_disposition = _named_asset(
        _CLS_FORCE_DISPOSITION, title_case_id(roster.get("force_disposition"))
    )
    if force_disposition:
        included.append(force_disposition)
    battle_size = _battle_size_asset(roster)
    if battle_size:
        included.append(battle_size)
    for u in roster["units"]:
        included.append(_unit_asset(u))

    total = total_army_points(roster)
    snapshot: dict[str, Any] = {
        "item": _key(_CLS_ROSTER, _CLS_ROSTER),
        "name": roster["name"],
        "quantity": 1,
    }
    if total > 0:
        snapshot["stats"] = {"Points": {"value": total}}
    snapshot["assets"] = {"included": included}

    envelope = {
        "slug": "",
        "key": "",
        "visible": "hidden",
        "locked": False,
        "rulebook": dict(_RULEBOOK),
        "snapshot": snapshot,
    }

    return pretty_json(envelope)
