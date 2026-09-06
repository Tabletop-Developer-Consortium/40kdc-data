"""wh40kdc — the 40kdc Warhammer 40K dataset behind a linked, typed API.

Python counterpart to ``@alpaca-software/40kdc-data`` (npm) and the
``wh40kdc`` crate (crates.io), held in behavioral lockstep by the shared
conformance corpus. See the repository's CONFORMANCE.md.
"""

from wh40kdc._version import __version__
from wh40kdc.abilities_resolver import resolve_eligible_abilities
from wh40kdc.cruncher import (
    attribute_stages,
    buffs_from_keyword,
    crunch,
    effect_to_buffs,
    resolve_buffs,
)
from wh40kdc.data import (
    Collection,
    Dataset,
    base_loadout,
    base_unit_points,
    check_unit_legality,
    clamp_weapon_count,
    loadout_candidates,
    maximal_loadout,
    normalize_name,
    option_cap,
    points_tier_missing,
    validate_loadout,
    weapon_bounds,
)
from wh40kdc.export import EXPORT_FORMATS, export_roster
from wh40kdc.imports import (
    REGISTERED_ADAPTERS,
    decode_listforge,
    import_listforge,
    import_newrecruit,
    import_roster,
    try_import_roster,
)
from wh40kdc.scope import ability_applies_to_unit, unit_matches_applies_to
from wh40kdc.scoring import score_turn, wtc_result
from wh40kdc.share import (
    SHARE_FORMAT_VERSION,
    decode_share_token,
    encode_share_token,
    share_registry_version,
)
from wh40kdc.terrain import BOARD_INCHES, keystone_measurements, resolve_layout
from wh40kdc.translate import describe_ability, describe_condition, describe_scoring_card
from wh40kdc.validator import VALIDATOR_TARGETS, SchemaValidator, create_validator

__all__ = [
    "BOARD_INCHES",
    "EXPORT_FORMATS",
    "REGISTERED_ADAPTERS",
    "SHARE_FORMAT_VERSION",
    "VALIDATOR_TARGETS",
    "Collection",
    "Dataset",
    "SchemaValidator",
    "__version__",
    "ability_applies_to_unit",
    "attribute_stages",
    "base_loadout",
    "base_unit_points",
    "buffs_from_keyword",
    "check_unit_legality",
    "clamp_weapon_count",
    "create_validator",
    "crunch",
    "decode_listforge",
    "decode_share_token",
    "describe_ability",
    "describe_condition",
    "describe_scoring_card",
    "effect_to_buffs",
    "encode_share_token",
    "export_roster",
    "import_listforge",
    "import_newrecruit",
    "import_roster",
    "keystone_measurements",
    "loadout_candidates",
    "maximal_loadout",
    "normalize_name",
    "option_cap",
    "points_tier_missing",
    "resolve_buffs",
    "resolve_eligible_abilities",
    "resolve_layout",
    "score_turn",
    "share_registry_version",
    "try_import_roster",
    "unit_matches_applies_to",
    "validate_loadout",
    "weapon_bounds",
    "wtc_result",
]
