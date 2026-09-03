"""Dataset linked queries against the shared conformance corpus.

The dispatch here mirrors the runner's ``linked_query`` op (and is reused by
it once the runner lands); comparison semantics (``scalar`` / ``ordered`` /
``set``) follow CONFORMANCE.md.
"""

from __future__ import annotations

from typing import Any

import pytest

from ..conftest import load_corpus_json


def _cases() -> list[dict[str, Any]]:
    return load_corpus_json("linked-api", "cases.json")


def run_linked_query(ds: Any, query: str, args: dict[str, Any]) -> Any:
    from wh40kdc.data.base import encode_base
    from wh40kdc.data.loadout import base_loadout, loadout_candidates, maximal_loadout

    if query == "find_unit":
        u = ds.units.find(args.get("query", ""))
        return u.id if u else None
    if query == "find_weapon":
        w = ds.weapons.find(args.get("query", ""))
        return w.id if w else None
    if query == "find_faction":
        f = ds.factions.find(args.get("query", ""))
        return f.id if f else None
    if query == "find_ability":
        a = ds.abilities.find(args.get("query", ""))
        return a.id if a else None
    if query == "get_enhancement":
        e = ds.enhancements.get(args.get("id", ""))
        return e["id"] if e else None
    if query == "abilities_of":
        return [x.id for x in ds.units.get_any(args["unitId"]).abilities]
    if query == "weapons_of":
        return [x.id for x in ds.units.get_any(args["unitId"]).weapons]
    if query == "wargear_options_of":
        return [x["id"] for x in ds.units.get_any(args["unitId"]).wargear_options]
    if query == "base_loadout":
        unit = ds.units.get_any(args["unitId"])
        comp = next((c for c in ds.unit_compositions if c.get("unit_id") == args["unitId"]), None)
        lo = base_loadout(
            unit.raw,
            int(args["modelCount"]),
            ds.wargear_options_of(unit.raw),
            (comp or {}).get("models"),
        )
        return sorted(f"{id_}:{n}" for id_, n in lo.items())
    if query == "maximal_loadout":
        unit = ds.units.get_any(args["unitId"])
        lo = maximal_loadout(unit.raw, int(args["modelCount"]), ds.wargear_options_of(unit.raw))
        return sorted(f"{id_}:{n}" for id_, n in lo.items())
    if query == "loadout_candidates":
        unit = (
            ds.units.get_in_faction(args["unitId"], args["factionId"])
            if args.get("factionId")
            else ds.units.get_any(args["unitId"])
        )
        comp = next(
            (
                c
                for c in ds.unit_compositions
                if c.get("unit_id") == args["unitId"]
                and c.get("faction_id") == unit.raw.get("faction_id")
            ),
            None,
        )
        return loadout_candidates(
            unit.raw,
            int(args["modelCount"]),
            ds.wargear_options_of(unit.raw),
            (comp or {}).get("models"),
            (comp or {}).get("tiers"),
            int(args["limit"]) if args.get("limit") is not None else None,
        )
    if query == "phases_of":
        return list(ds.abilities.get(args["abilityId"]).phases)
    if query == "faction_of":
        f = ds.units.get_any(args["unitId"]).faction
        return f.id if f else None
    if query == "base_size_of":
        return encode_base(ds.units.get_any(args["unitId"]).raw.get("base_size_mm"))
    if query == "model_bases_of":
        unit_id = args["unitId"]
        comp = next((c for c in ds.unit_compositions if c.get("unit_id") == unit_id), None)
        models = (comp or {}).get("models") or []
        return [f"{m['name']}={encode_base(m.get('base_size_mm')) or 'none'}" for m in models]
    if query == "abilities_of_faction":
        return [x.id for x in ds.abilities.by_faction(args["factionId"])]
    if query == "weapons_of_faction":
        return [x.id for x in ds.factions.get(args["factionId"]).weapons]
    if query == "logo_url_of_faction":
        return ds.factions.get(args["factionId"]).logo_url
    if query == "units_with_keyword":
        return [u.id for u in ds.units_with_keyword(args["keyword"])]
    if query == "allies_for":
        return [r["id"] for r in ds.allies_for(args["factionId"], args.get("detachmentIds") or [])]
    if query == "ally_units_for":
        return [u.id for u in ds.ally_units_for(args["ruleId"])]
    if query == "leaders_attachable_to":
        return [u.id for u in ds.leaders_attachable_to(args["bodyguardId"])]
    if query == "bodyguards_attachable_from":
        return [u.id for u in ds.bodyguards_attachable_from(args["leaderId"])]
    if query == "reactive_trigger_ability_ids":
        return sorted(rt["ability_id"] for rt in ds.reactive_triggers())
    if query == "events_with_triggers":
        return sorted(ds.trigger_index().keys())
    if query == "triggers_for_event":
        event = args.get("event") or ""
        return sorted(rt["ability_id"] for rt in ds.reactive_triggers() if rt["event"] == event)
    raise AssertionError(f"unknown linked_query: {query}")


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["name"])
def test_linked_api_case(dataset: Any, case: dict[str, Any]) -> None:
    actual = run_linked_query(dataset, case["query"], case.get("args") or {})
    expected = case["expected"]
    comparison = case.get("comparison", "scalar")
    if comparison == "set":
        assert sorted(actual) == sorted(expected)
    else:  # scalar and ordered both compare exactly
        assert actual == expected
