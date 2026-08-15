from wh40kdc.imports.gw_headerless import gw_headerless_adapter

_EVENT_EXPORT = """Participant
Team
Orks
Recon (1995 points)
Taktikal Brigade (3 Detachment Points)

1995 points

BATTLELINE

Squighog Boyz (270 points)
    • Leader: Beastboss on Squigosaur
    • 2x Nob on Smasha Squig
        ◦ 2x Big choppa
    • 6x Squighog Boy
        ◦ 6x Stikka
"""


def test_recovers_unframed_event_preamble_and_attachment_count() -> None:
    parsed = gw_headerless_adapter.parse(_EVENT_EXPORT)

    assert parsed["name"] == "Recon"
    assert parsed["declared_limit"] == 1995
    assert parsed["faction_raw_name"] == "Orks"
    assert parsed["detachment_raw_names"] == ["Taktikal Brigade"]
    assert [unit["raw_name"] for unit in parsed["units"]] == ["Squighog Boyz"]

    unit = parsed["units"][0]
    assert unit["model_count"] == 8
    assert all("leader" not in item["raw_name"].lower() for item in unit["wargear"])


def test_parses_dense_preamble_ordered_annotations_and_shallow_model_indent() -> None:
    dense = """++++++++++++++++++++++++++++++++++++++++
Player Name: Example
Army Points: 2000
+++++++++++++++++++++++++++++++++++++++
Fabricated Patrol (2,000 Points)
Fabricated Faction
Houndpack Lance (2 Detachment Points) Reconnaissance Strike Force (2,000 Points)
CHARACTERS
Tunnel Guide (70 Points)
 • Houndpack Lance Keyword: Character
 • Enhancements: Fabricated Relic
 • 1x Tunnel Guide: Tool
 • 2x Helper
  ◦ 2x Tool
"""
    parsed = gw_headerless_adapter.parse(dense)

    assert parsed["detachment_raw_names"] == ["Houndpack Lance"]
    assert parsed["force_disposition_raw_name"] == "Reconnaissance"
    assert parsed["battle_size_raw"] == "Strike Force (2,000 Points)"
    guide = parsed["units"][0]
    assert guide["is_character"] is True
    assert guide["enhancement_raw_name"] == "Fabricated Relic"
    assert guide["model_count"] == 3
    assert {item["raw_name"] for item in guide["wargear"]} == {"Tool"}
