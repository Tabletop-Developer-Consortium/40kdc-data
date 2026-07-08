"""Faction-scoped ability resolution over the linked API.

Mirror of the TS ``data-model.test.ts`` collection-integrity tests and the
Rust ``data_api.rs`` equivalents: a shared ability_id keeps one copy per
faction, and a unit resolves its own faction's copy.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

import pytest


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
