"""Linked, typed access to the embedded dataset."""

from wh40kdc.data.bundle import COLLECTION_KEYS, RawData, empty_raw_data, raw_data
from wh40kdc.data.collection import Collection
from wh40kdc.data.dataset import Dataset
from wh40kdc.data.entities import (
    AbilityView,
    FactionView,
    UnitView,
    WeaponKeywordView,
    WeaponView,
)
from wh40kdc.data.loadout import (
    base_loadout,
    check_unit_legality,
    clamp_weapon_count,
    loadout_candidates,
    maximal_loadout,
    option_cap,
    validate_loadout,
    weapon_bounds,
)
from wh40kdc.data.normalize import normalize_name
from wh40kdc.data.pricing import base_unit_points, points_tier_missing

__all__ = [
    "COLLECTION_KEYS",
    "AbilityView",
    "Collection",
    "Dataset",
    "FactionView",
    "RawData",
    "UnitView",
    "WeaponKeywordView",
    "WeaponView",
    "base_loadout",
    "base_unit_points",
    "check_unit_legality",
    "clamp_weapon_count",
    "empty_raw_data",
    "loadout_candidates",
    "maximal_loadout",
    "normalize_name",
    "option_cap",
    "points_tier_missing",
    "raw_data",
    "validate_loadout",
    "weapon_bounds",
]
