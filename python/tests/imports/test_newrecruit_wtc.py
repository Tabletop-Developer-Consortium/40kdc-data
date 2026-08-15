"""NewRecruit WTC adapter tests — Force Disposition header + wargear items.

The 11e WTC template carries a ``+ FORCE DISPOSITION:`` header line, and
wtc-full bodies can list wargear ITEMS (non-weapon entries like the Simulacrum
Imperialis) that must resolve against the wargear collection once both weapon
lookups miss.

Python mirror of the disposition/wargear blocks in
``tools/test/import/newrecruit-wtc.test.ts``.
"""

from __future__ import annotations

from typing import Any

from wh40kdc.imports import try_import_roster
from wh40kdc.imports.newrecruit_wtc import (
    newrecruit_wtc_compact_adapter,
    newrecruit_wtc_full_adapter,
)

SORORITAS_LIST = """+++++++++++++++++++++++++++++++++++++++++++++++
+ FACTION KEYWORD: Imperium - Adepta Sororitas
+ DETACHMENT: Champions of Faith (Righteous Purpose)
+ FORCE DISPOSITION: Disruption
+ TOTAL ARMY POINTS: 150pts
+
+ WARLORD: Char1: Palatine
+ NUMBER OF UNITS: 2
+++++++++++++++++++++++++++++++++++++++++++++++

Char1: 1x Palatine (50 pts): Palatine blade, Plasma pistol, Warlord

10x Battle Sisters Squad (100 pts)
• 9x Battle Sister
    7 with Bolt pistol, Boltgun, Close combat weapon
    1 with Simulacrum Imperialis, Bolt pistol, Boltgun, Close combat weapon
    1 with Bolt pistol, Close combat weapon, Multi-melta
• 1x Sister Superior: Bolt pistol, Close combat weapon, Power weapon, Boltgun
"""


def test_header_captures_force_disposition() -> None:
    assert newrecruit_wtc_full_adapter.matches(SORORITAS_LIST) is True
    parsed = newrecruit_wtc_full_adapter.parse(SORORITAS_LIST)
    assert parsed["force_disposition_raw_name"] == "Disruption"
    assert parsed["detachment_raw_names"] == ["Champions of Faith"]


def test_header_without_disposition_is_explicit_null() -> None:
    no_disposition = SORORITAS_LIST.replace("+ FORCE DISPOSITION: Disruption\n", "")
    parsed = newrecruit_wtc_full_adapter.parse(no_disposition)
    assert parsed["force_disposition_raw_name"] is None


def test_compact_dialect_shares_the_header_parse() -> None:
    compact = "\n".join(
        line for line in SORORITAS_LIST.splitlines() if not line.startswith(("•", "    "))
    )
    assert newrecruit_wtc_compact_adapter.matches(compact) is True
    parsed = newrecruit_wtc_compact_adapter.parse(compact)
    assert parsed["force_disposition_raw_name"] == "Disruption"


def test_force_disposition_resolves_to_an_id(dataset: Any) -> None:
    result = try_import_roster(SORORITAS_LIST, dataset)
    assert result["ok"] is True
    assert result["format"] == "newrecruit-wtc-full"
    assert result["roster"]["force_disposition"] == "disruption"


def test_unknown_disposition_warns_and_stays_null(dataset: Any) -> None:
    bad = SORORITAS_LIST.replace("Disruption", "Total Mayhem")
    result = try_import_roster(bad, dataset)
    assert result["ok"] is True
    assert result["roster"]["force_disposition"] is None
    codes = [w["code"] for w in result["roster"]["diagnostics"]["warnings"]]
    assert "disposition-unresolved" in codes


def test_wargear_item_resolves_via_the_wargear_fallback(dataset: Any) -> None:
    result = try_import_roster(SORORITAS_LIST, dataset)
    assert result["ok"] is True
    squad = next(u for u in result["roster"]["units"] if u["ref"]["id"] == "battle-sisters-squad")
    simulacrum = next(
        w for w in squad["wargear"] if w["ref"]["raw_name"] == "Simulacrum Imperialis"
    )
    assert simulacrum["ref"]["id"] == "simulacrum-imperialis"
    assert result["roster"]["diagnostics"]["unresolved_weapons"] == 0


def test_weapon_precedence_over_wargear_for_colliding_names(dataset: Any) -> None:
    result = try_import_roster(SORORITAS_LIST, dataset)
    assert result["ok"] is True
    squad = next(u for u in result["roster"]["units"] if u["ref"]["id"] == "battle-sisters-squad")
    melta = next(w for w in squad["wargear"] if w["ref"]["raw_name"] == "Multi-melta")
    assert melta["ref"]["id"] is not None
    assert dataset.weapons.get_any(melta["ref"]["id"]) is not None


def test_full_body_keeps_single_line_characters() -> None:
    # Real WTC-full exports mix compact-style lines into the full layout:
    # single-model characters arrive as one `CharN: 1x Unit (pts): wargear`
    # line, and model-type bullets may inline their loadout after a colon.
    parsed = newrecruit_wtc_full_adapter.parse(SORORITAS_LIST)
    assert [u["raw_name"] for u in parsed["units"]] == ["Palatine", "Battle Sisters Squad"]
    palatine = parsed["units"][0]
    assert palatine["is_character"] is True
    assert palatine["is_warlord"] is True
    assert {w["raw_name"] for w in palatine["wargear"]} == {"Palatine blade", "Plasma pistol"}
    squad = parsed["units"][1]
    superior_loadout = {w["raw_name"] for w in squad["wargear"]}
    assert "Power weapon" in superior_loadout  # from the inline `• 1x Sister Superior: ...`


def test_full_preserves_ordered_detachments_bare_enhancement_and_repeated_model_groups() -> None:
    text = """+++++++++++++++++++++++++++++++++++++++++++++++
+ FACTION KEYWORD: Fabricated Faction
+ DETACHMENT: First Formation (2 Detachment Points)
+ DETACHMENT: Second Formation (1 Detachment Point)
+ TOTAL ARMY POINTS: 200pts
++++++++++++++++++++++++++++++++++++++++++++++

CHARACTERS
Char1: 1x Fabricated Captain (80 pts)
Enhancement: Bare Relic

BATTLELINE
9x Fabricated Squad (120 pts)
• 6x Trooper
    6 with Rifle
• 1x Sergeant
    1 with Rifle
• 1x Specialist
    1 with Rifle
• 1x Specialist
    1 with Rifle
"""
    parsed = newrecruit_wtc_full_adapter.parse(text)

    assert parsed["detachment_raw_names"] == ["First Formation", "Second Formation"]
    captain, squad = parsed["units"]
    assert captain["enhancement_raw_name"] == "Bare Relic"
    assert captain["enhancement_points"] is None
    assert squad["model_count"] == 9
    assert squad["wargear"] == [{"raw_name": "Rifle", "count": 9}]
    assert [group["count"] for group in squad["loadout_groups"]] == [6, 1, 1, 1]
