"""ListForge plain-text adapter unit tests.

ListForge's copy-paste export: a ``name - faction - detachment (N Points)``
first line, mixed-case role sections ending with ``:``, units as
``Name (N pts)`` headers, and indented ``•`` bullets for model groups, wargear,
the ``E: <name>`` enhancement annotation, and the bare ``Warlord`` marker.
These tests pin the parse and the disjointness from the other text matchers.

Python mirror of ``tools/test/import/listforge-text.test.ts``.
"""

from __future__ import annotations

from typing import Any

from wh40kdc.imports import try_import_roster
from wh40kdc.imports.gw import gw_adapter
from wh40kdc.imports.listforge_text import _parse_first_line, listforge_text_adapter
from wh40kdc.imports.newrecruit_simple import newrecruit_simple_adapter

# Condensed from the reference Chaos Daemons export.
SAMPLE = """all gas no breaks - Chaos Daemons - Daemonic Incursion (1995 Points)


Epic Hero:
Rotigus (250 pts)
  • Gnarlrod
  • Streams of brackish filth


Character:
Great Unclean One (295 pts)
  • Putrid vomit
  • Bileblade
  • Bilesword
  • E: The Endless Gift
  • Warlord

Bloodmaster (65 pts)
  • Blade of blood


Battleline:
Bloodletters (110 pts)
  • Bloodreaper
    • Hellblade
  • Instrument of Chaos
  • Daemonic Icon
  • 9x Bloodletter
    • 9x Hellblade


Beast:
Flesh Hounds (75 pts)
  • Gore Hound
    • Burning maw
    • Collar of Khorne
    • Gore-drenched fangs
  • 4x Flesh Hound
    • 4x Collar of Khorne
    • 4x Gore-drenched fangs
"""


def _by_name(parsed: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {u["raw_name"]: u for u in parsed["units"]}


def _gear(unit: dict[str, Any]) -> dict[str, int]:
    return {w["raw_name"]: w["count"] for w in unit["wargear"]}


class TestMatches:
    def test_recognises_the_listforge_text_export(self) -> None:
        assert listforge_text_adapter.matches(SAMPLE) is True

    def test_rejects_non_string_and_other_text_formats(self) -> None:
        assert listforge_text_adapter.matches({"roster": {}}) is False
        # newrecruit-simple first line ends `- [N pts]`, not `(N Points)`.
        assert (
            listforge_text_adapter.matches(
                "Chaos - Chaos Knights - List - [2000 pts]\n\n"
                "# ++ Army Roster ++ [2000 pts]\nUnit [5 pts]:\n• 1x Model: Gun"
            )
            is False
        )
        # A GW export's first non-blank line is the `++++` fence.
        assert (
            listforge_text_adapter.matches(
                "++++\n+ FACTION KEYWORD: Chaos - Chaos Knights\n++++\nUnit (5 pts)\n• 1x Gun"
            )
            is False
        )

    def test_requires_bullets_and_refuses_wtc_with_bodies(self) -> None:
        no_bullets = "name - Faction - Detachment (1000 Points)\nUnit (50 pts)"
        assert listforge_text_adapter.matches(no_bullets) is False
        with_lines = (
            "name - Faction - Detachment (1000 Points)\nUnit (50 pts)\n  • Gun\n1 with Sword"
        )
        assert listforge_text_adapter.matches(with_lines) is False

    def test_stays_disjoint_from_other_text_matchers(self) -> None:
        assert gw_adapter.matches(SAMPLE) is False
        assert newrecruit_simple_adapter.matches(SAMPLE) is False


class TestTryImportRoster:
    def test_auto_detects_and_resolves(self, dataset: Any) -> None:
        result = try_import_roster(SAMPLE, dataset)
        assert result["ok"] is True
        assert result["format"] == "listforge-text"
        assert result["roster"]["faction_id"] == "chaos-daemons"


class TestParse:
    parsed = listforge_text_adapter.parse(SAMPLE)

    def test_reads_header_fields(self) -> None:
        assert self.parsed["name"] == "all gas no breaks"
        assert self.parsed["faction_raw_name"] == "Chaos Daemons"
        assert self.parsed["detachment_raw_names"] == ["Daemonic Incursion"]
        assert self.parsed["total_reported"] == 1995
        # ListForge reports only the army total — it doubles as the limit.
        assert self.parsed["declared_limit"] == 1995

    def test_captures_units_in_declaration_order(self) -> None:
        assert [u["raw_name"] for u in self.parsed["units"]] == [
            "Rotigus",
            "Great Unclean One",
            "Bloodmaster",
            "Bloodletters",
            "Flesh Hounds",
        ]

    def test_flags_characters_from_epic_hero_and_character_sections(self) -> None:
        flags = {u["raw_name"]: u["is_character"] for u in self.parsed["units"]}
        assert flags["Rotigus"] is True
        assert flags["Great Unclean One"] is True
        assert flags["Bloodmaster"] is True
        assert flags["Bloodletters"] is False
        assert flags["Flesh Hounds"] is False

    def test_reads_enhancement_without_claiming_points(self) -> None:
        guo = _by_name(self.parsed)["Great Unclean One"]
        assert guo["enhancement_raw_name"] == "The Endless Gift"
        assert guo["enhancement_points"] is None
        assert guo["points"] == 295  # displayed points stay as-is
        assert guo["is_warlord"] is True

    def test_derives_model_counts_from_bulleted_model_groups(self) -> None:
        units = _by_name(self.parsed)
        assert units["Bloodletters"]["model_count"] == 10  # Bloodreaper + 9x
        assert units["Flesh Hounds"]["model_count"] == 5  # Gore Hound + 4x
        assert units["Rotigus"]["model_count"] == 1  # wargear-only bullets

    def test_aggregates_squad_wide_wargear(self) -> None:
        gear = _gear(_by_name(self.parsed)["Bloodletters"])
        assert gear["Hellblade"] == 10  # 1 (Bloodreaper's) + 9 (squad line)
        assert gear["Instrument of Chaos"] == 1
        assert gear["Daemonic Icon"] == 1

    def test_sums_total_computed_from_unit_points(self) -> None:
        assert self.parsed["total_computed"] == 250 + 295 + 65 + 110 + 75

    def test_does_not_leak_prose_fields(self) -> None:
        import json

        blob = json.dumps(self.parsed)
        assert "description" not in blob
        assert "rules" not in blob

    def test_legacy_three_segment_header_has_null_disposition_slot(self) -> None:
        # 3-segment header: the disposition slot is present but null.
        assert "force_disposition_raw_name" in self.parsed
        assert self.parsed["force_disposition_raw_name"] is None
        # every unit carries the leader_attachment key, null here.
        for u in self.parsed["units"]:
            assert u["leader_attachment"] is None


# 11e headers gained a Force Disposition segment and a comma-joined
# multi-detachment tail: `<name> - <faction> - <disposition> - <det>[, <det>]`.
class TestHeader11e:
    def test_parses_disposition_and_comma_splits_detachment_tail(self) -> None:
        h = _parse_first_line(
            "1.5k - Leagues of Votann - Priority Assets - "
            "Hearthfyre Arsenal, Hearthguard Covenant (1485 Points)"
        )
        assert h is not None
        assert h["name"] == "1.5k"
        assert h["faction_raw_name"] == "Leagues of Votann"
        assert h["disposition_raw_name"] == "Priority Assets"
        assert h["detachment_raw_names"] == [
            "Hearthfyre Arsenal",
            "Hearthguard Covenant",
        ]

    def test_keeps_single_detachment_four_segment_header_as_one(self) -> None:
        h = _parse_first_line(
            "Starshatter - Necrons - Priority Assets - Starshatter Arsenal (2000 Points)"
        )
        assert h is not None
        assert h["faction_raw_name"] == "Necrons"
        assert h["disposition_raw_name"] == "Priority Assets"
        assert h["detachment_raw_names"] == ["Starshatter Arsenal"]

    def test_leaves_legacy_three_segment_header_with_no_disposition(self) -> None:
        h = _parse_first_line(
            "all gas no breaks - Chaos Daemons - Daemonic Incursion (1995 Points)"
        )
        assert h is not None
        assert h["disposition_raw_name"] is None
        assert h["detachment_raw_names"] == ["Daemonic Incursion"]


# ListForge emits attached leaders in an `Attached Units:` section: a combined
# `Leader + Bodyguard (total pts)` marker, then the leader and bodyguard as
# indented sub-units. Condensed from a real Votann export.
ATTACHED = """1.5k - Leagues of Votann - Priority Assets - Hearthfyre Arsenal (1485 Points)

Attached Units:
Kâhl + Einhyr Hearthguard (205 pts)
  Kâhl (75 pts)
    • Volkanite disintegrator
    • Warlord
    • E: Ironskein
  Einhyr Hearthguard (130 pts)
    • Hesyr
      • EtaCarn plasma gun
    • 4x Einhyr Hearthguard
      • 4x Volkanite disintegrator

Character:
Einhyr Champion (65 pts)
  • Darkstar axe
"""


class TestAttachedUnits:
    parsed = listforge_text_adapter.parse(ATTACHED)

    def test_skips_marker_and_emits_leader_and_bodyguard(self) -> None:
        assert [u["raw_name"] for u in self.parsed["units"]] == [
            "Kâhl",
            "Einhyr Hearthguard",
            "Einhyr Champion",
        ]
        # The marker's points are the sub-units' sum; counting it would double.
        assert self.parsed["total_computed"] == 75 + 130 + 65

    def test_attached_leader_is_character_linked_to_bodyguard(self) -> None:
        kahl = _by_name(self.parsed)["Kâhl"]
        assert kahl["is_character"] is True
        assert kahl["is_warlord"] is True
        assert kahl["enhancement_raw_name"] == "Ironskein"
        assert kahl["leader_attachment"] == {
            "bodyguard_raw_name": "Einhyr Hearthguard",
            "role": "leader",
            "provisional": False,
        }

    def test_bodyguard_is_plain_unit_with_null_attachment(self) -> None:
        bg = _by_name(self.parsed)["Einhyr Hearthguard"]
        assert bg["is_character"] is False
        assert bg["leader_attachment"] is None
        assert bg["model_count"] == 5  # Hesyr + 4x Einhyr Hearthguard

    def test_attachment_state_resets_when_a_normal_section_follows(self) -> None:
        champ = _by_name(self.parsed)["Einhyr Champion"]
        assert champ["is_character"] is True  # Character section
        assert champ["leader_attachment"] is None

    def test_resolves_the_explicit_attachment_end_to_end(self, dataset: Any) -> None:
        result = try_import_roster(ATTACHED, dataset)
        assert result["ok"] is True
        kahl = next(u for u in result["roster"]["units"] if u["ref"]["id"] == "kahl")
        assert kahl["leader_attachment"] is not None
        assert kahl["leader_attachment"]["bodyguard_ref"]["id"] == "einhyr-hearthguard"
        assert kahl["leader_attachment"]["role"] == "leader"
        assert kahl["leader_attachment"]["provisional"] is False
