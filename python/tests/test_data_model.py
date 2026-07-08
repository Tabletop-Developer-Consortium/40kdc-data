"""Faction-scoped ability resolution over the linked API.

Mirror of the TS ``data-model.test.ts`` collection-integrity tests and the
Rust ``data_api.rs`` equivalents: a shared ability_id keeps one copy per
faction, and a unit resolves its own faction's copy.
"""

from __future__ import annotations

from typing import Any


def test_deduplicates_abilities_by_faction_and_id(dataset: Any) -> None:
    keys = [
        f"{a.raw.get('faction_id') or ''}::{a.id}" for a in dataset.abilities.all
    ]
    assert len(set(keys)) == len(keys)
    idols = [a for a in dataset.abilities.all if a.id == "idol-of-blessed-blood"]
    assert len(idols) == 2, "both factions' idol-of-blessed-blood copies survive dedupe"


def test_resolves_shared_ability_id_to_units_own_factions_copy(dataset: Any) -> None:
    # `idol-of-blessed-blood` is authored in both world-eaters and
    # chaos-space-marines (shared Khorne Lord of Skulls datasheet); each
    # faction's unit must see its own faction's copy.
    for faction in ("world-eaters", "chaos-space-marines"):
        unit = dataset.units.get_in_faction("khorne-lord-of-skulls", faction)
        assert unit is not None
        idol = next(
            (a for a in unit.abilities if a.id == "idol-of-blessed-blood"), None
        )
        assert idol is not None, f"idol-of-blessed-blood on {faction} lord of skulls"
        assert idol.raw.get("faction_id") == faction


def test_core_pool_abilities_resolve_via_fallback(dataset: Any) -> None:
    # The shared `_core` pool stays faction-less; a bare get() still finds it.
    assert dataset.abilities.get("benefit-of-cover") is not None
