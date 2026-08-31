"""Faction-scoped ability resolution over the linked API.

Mirror of the TS ``data-model.test.ts`` collection-integrity tests and the
Rust ``data_api.rs`` equivalents: a shared ability_id keeps one copy per
faction, and a unit resolves its own faction's copy.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

import pytest

from wh40kdc.data.collection import Collection


def test_deduplicates_abilities_by_faction_and_id(dataset: Any) -> None:
    keys = [f"{a.raw.get('faction_id') or ''}::{a.id}" for a in dataset.abilities.all]
    assert len(set(keys)) == len(keys)
    idols = [a for a in dataset.abilities.all if a.id == "idol-of-blessed-blood"]
    assert len(idols) == 2, "both factions' idol-of-blessed-blood copies survive dedupe"


def test_by_external_ref_returns_every_exact_match() -> None:
    items = [
        {
            "id": "first",
            "external_refs": [
                {"namespace": "source", "id": "shared"},
                {"namespace": "source", "id": "alternate"},
            ],
        },
        {
            "id": "second",
            "external_refs": [{"namespace": "source", "id": "shared"}],
        },
    ]
    collection = Collection(
        items,
        id_of=lambda item: item["id"],
        external_refs_of=lambda item: item["external_refs"],
        wrap=lambda item: item,
    )

    assert [item["id"] for item in collection.by_external_ref("source", "shared")] == [
        "first",
        "second",
    ]
    assert [item["id"] for item in collection.by_external_ref("source", "alternate")] == ["first"]
    assert collection.by_external_ref("Source", "shared") == []
    assert collection.by_external_ref("source", "Shared") == []


def test_resolves_shared_ability_id_to_units_own_factions_copy(dataset: Any) -> None:
    # `idol-of-blessed-blood` is authored in both world-eaters and
    # chaos-space-marines (shared Khorne Lord of Skulls datasheet); each
    # faction's unit must see its own faction's copy.
    for faction in ("world-eaters", "chaos-space-marines"):
        unit = dataset.units.get_in_faction("khorne-lord-of-skulls", faction)
        assert unit is not None
        idol = next((a for a in unit.abilities if a.id == "idol-of-blessed-blood"), None)
        assert idol is not None, f"idol-of-blessed-blood on {faction} lord of skulls"
        assert idol.raw.get("faction_id") == faction


def test_core_pool_abilities_resolve_via_fallback(dataset: Any) -> None:
    # The shared `_core` pool stays faction-less; a bare get() still finds it.
    assert dataset.abilities.get("benefit-of-cover") is not None


def test_get_raises_for_shared_unit_id_without_faction(dataset: Any) -> None:
    # The tripwire that turns a silent wrong-faction lookup into a loud error:
    # chaos-land-raider exists under several Chaos factions. Runs under
    # __debug__ (any pytest run); -O degrades to first-wins.
    with pytest.raises(LookupError, match="Ambiguous unit lookup"):
        dataset.units.get("chaos-land-raider")


def test_get_any_is_the_explicit_first_wins_opt_out(dataset: Any) -> None:
    unit = dataset.units.get_any("chaos-land-raider")
    assert unit is not None
    assert unit.id == "chaos-land-raider"


def test_get_still_works_for_unambiguous_ids_on_guarded_collection(dataset: Any) -> None:
    assert dataset.units.get("kharn-the-betrayer") is not None


def test_get_raises_for_shared_detachment_id_without_faction(dataset: Any) -> None:
    counts = Counter(d["id"] for d in dataset.detachments.all)
    shared = next(id_ for id_, n in counts.items() if n > 1)
    with pytest.raises(LookupError, match="Ambiguous detachment lookup"):
        dataset.detachments.get(shared)


def test_get_raises_for_shared_weapon_id_without_faction(dataset: Any) -> None:
    # lascannon exists under many factions with divergent stats; a
    # faction-less get() would silently crunch the wrong faction's profile.
    with pytest.raises(LookupError, match="Ambiguous weapon lookup"):
        dataset.weapons.get("lascannon")
    assert dataset.weapons.get_any("lascannon") is not None


def test_get_raises_for_shared_ability_id_without_faction(dataset: Any) -> None:
    with pytest.raises(LookupError, match="Ambiguous ability lookup"):
        dataset.abilities.get("idol-of-blessed-blood")
    assert dataset.abilities.get_any("idol-of-blessed-blood") is not None


# ---------------------------------------------------------------------------
# Core rule 19.04 — a rule affecting a single specified model only ever applies
# to that model, even while part of an attached unit. Mirror of the TS
# `defensive-buffs.test.ts` "attached members" block; pinned cross-impl by
# `conformance/abilities-resolver/{from-dsl,defensive-from-dsl}.json`.
# ---------------------------------------------------------------------------

_MODEL_SCOPED_REASON = (
    "model-scoped effect from an attached model: applies to that model only (core rule 19.04)"
)


def _invulns(buffs: list[dict[str, Any]], ability_id: str) -> list[dict[str, Any]]:
    return [
        b
        for b in buffs
        if b["contribution"]["type"] == "invulnerable-save"
        and b["source"].get("abilityId") == ability_id
    ]


def test_leader_personal_invuln_does_not_buff_the_bodyguard_unit(dataset: Any) -> None:
    """Shadowfield reads "the bearer has a 4+ invulnerable save" — one model out
    of eleven, so it is not the Kabalite squad's invulnerable save."""
    attached = dataset.defensive_buffs_for(
        {
            "unitId": "kabalite-warriors",
            "factionId": "drukhari",
            "attachedUnitIds": ["archon"],
        },
        {"phase": "shooting"},
    )
    assert _invulns(attached, "shadowfield") == []

    # The Archon crunched as itself still keeps it (source kind "unit").
    own = dataset.defensive_buffs_for(
        {"unitId": "archon", "factionId": "drukhari"}, {"phase": "shooting"}
    )
    assert [b["contribution"] for b in _invulns(own, "shadowfield")] == [
        {"type": "invulnerable-save", "threshold": 4}
    ]


def test_unit_scoped_leader_rule_still_buffs_the_attached_unit(dataset: Any) -> None:
    """Mental Fortress reads "models in that unit have a 4+ invulnerable save" —
    authored `target: "unit"`, so the model-scope gate must not touch it."""
    attached = dataset.defensive_buffs_for(
        {
            "unitId": "intercessor-squad",
            "factionId": "adeptus-astartes",
            "attachedUnitIds": ["librarian"],
        },
        {"phase": "fight"},
    )
    buffs = _invulns(attached, "mental-fortress-psychic")
    assert len(buffs) == 1
    assert buffs[0]["source"]["abilityKind"] == "attached"
    assert buffs[0]["source"]["sourceUnitId"] == "librarian"


def test_dropped_model_scoped_effect_is_reported_as_unsupported(dataset: Any) -> None:
    from wh40kdc.cruncher import effect_to_buffs

    ability = dataset.abilities.get_any("shadowfield")
    translated = effect_to_buffs(
        ability.raw.get("effect"),
        {
            "kind": "ability",
            "abilityId": "shadowfield",
            "abilityKind": "attached",
            "sourceUnitId": "archon",
        },
        {"phase": "shooting"},
        "target",
    )
    assert translated["applied"] == []
    assert [u["reason"] for u in translated["unsupported"]] == [_MODEL_SCOPED_REASON]


def test_gate_is_attacker_side_too_and_spares_unit_scoped_grants(dataset: Any) -> None:
    def keywords_from(buffs: list[dict[str, Any]], ability_id: str) -> list[str]:
        return [
            b["contribution"]["keywordRef"]["keyword_id"]
            for b in buffs
            if b["source"].get("abilityId") == ability_id
            and b["contribution"]["type"] == "extra-keyword"
        ]

    # Psychic Gifts reads "the bearer has the Psyker keyword" — model-scoped.
    led = dataset.buffs_for(
        {
            "unitId": "inquisitorial-agents",
            "factionId": "agents-of-the-imperium",
            "attachedUnitIds": ["inquisitor"],
        },
        {"phase": "command"},
    )
    assert keywords_from(led, "psychic-gifts") == []
    alone = dataset.buffs_for(
        {"unitId": "inquisitor", "factionId": "agents-of-the-imperium"},
        {"phase": "command"},
    )
    assert keywords_from(alone, "psychic-gifts") == ["psyker"]

    # Surgical Precision is unit-scoped, so an attached Apothecary Biologis
    # still grants [LETHAL HITS] to the squad it joined.
    aggressors = dataset.buffs_for(
        {
            "unitId": "aggressor-squad",
            "factionId": "adeptus-astartes",
            "attachedUnitIds": ["apothecary-biologis"],
        },
        {"phase": "shooting"},
    )
    assert keywords_from(aggressors, "surgical-precision") == ["lethal-hits"]


def test_entity_backed_rules_bundle_expands_before_buff_translation() -> None:
    from wh40kdc.data.bundle import empty_raw_data
    from wh40kdc.data.dataset import Dataset

    raw = empty_raw_data()
    raw["abilities"] = [
        {
            "ability_id": "shared-rules",
            "name": "Shared Rules",
            "faction_id": "orks",
            "effect": {
                "type": "rules-bundle",
                "steps": [
                    {
                        "type": "re-roll",
                        "target": "unit",
                        "modifier": {"roll": "hit", "subset": "ones"},
                    },
                    {
                        "type": "re-roll",
                        "target": "unit",
                        "modifier": {"roll": "wound", "subset": "ones"},
                    },
                ],
            },
        },
        {
            "ability_id": "bundle-grant",
            "name": "Bundle Grant",
            "faction_id": "orks",
            "effect": {
                "type": "ability-grant",
                "target": "unit",
                "modifier": {"ability_id": "shared-rules", "rules_bundle": True},
            },
        },
        {
            "ability_id": "cycle-a",
            "name": "Cycle A",
            "faction_id": "orks",
            "effect": {
                "type": "rules-bundle",
                "steps": [
                    {
                        "type": "ability-grant",
                        "target": "unit",
                        "modifier": {"ability_id": "cycle-b", "rules_bundle": True},
                    }
                ],
            },
        },
        {
            "ability_id": "cycle-b",
            "name": "Cycle B",
            "faction_id": "orks",
            "effect": {
                "type": "rules-bundle",
                "steps": [
                    {
                        "type": "ability-grant",
                        "target": "unit",
                        "modifier": {"ability_id": "cycle-a", "rules_bundle": True},
                    }
                ],
            },
        },
    ]
    ability = Dataset(raw).abilities.get_in_faction("bundle-grant", "orks")
    assert ability is not None

    result = ability.describe_buffs(
        {"kind": "ability", "abilityId": "bundle-grant", "abilityKind": "unit"},
        {"phase": "shooting"},
    )

    assert [buff["contribution"] for buff in result["applied"]] == [
        {"type": "reroll", "roll": "hit", "subset": "ones"},
        {"type": "reroll", "roll": "wound", "subset": "ones"},
    ]
    assert result["unsupported"] == []

    cycle = Dataset(raw).abilities.get_in_faction("cycle-a", "orks")
    assert cycle is not None
    cyclic_result = cycle.describe_buffs(
        {"kind": "ability", "abilityId": "cycle-a", "abilityKind": "unit"},
        {"phase": "shooting"},
    )
    assert cyclic_result["applied"] == []
    assert [item["reason"] for item in cyclic_result["unsupported"]] == [
        'effect type "ability-grant" is not modelled by the buff layer'
    ]


def test_weapon_keyword_target_gates_apply_in_linked_buff_apis(dataset: Any) -> None:
    input_ = {
        "weaponProfiles": [{"weaponId": "big-shoota", "profileIndex": 0}],
    }
    matching = dataset.buffs_for(input_, {"phase": "shooting", "targetKeywords": ["infantry"]})
    assert any(
        buff["contribution"].get("keywordRef", {}).get("keyword_id") == "lethal-hits"
        for buff in matching
    )

    excluded_context = {"phase": "shooting", "targetKeywords": ["monster"]}
    excluded = dataset.buffs_for(input_, excluded_context)
    assert not any(
        buff["contribution"].get("keywordRef", {}).get("keyword_id") == "lethal-hits"
        for buff in excluded
    )
    stackable = dataset.stackable_buffs_for(input_, excluded_context)["buffs"]
    assert not any(
        buff["contribution"].get("keywordRef", {}).get("keyword_id") == "lethal-hits"
        for group in stackable
        for buff in group["buffs"]
    )
