"""Loading of the embedded data bundle.

``_bundle.json`` is a byte-for-byte copy of the Rust crate's
``bundle.generated.json`` (snake_case collection keys, every collection
pre-seeded, data files visited in sorted path order). Array order within each
collection is load-bearing — the set-semantics linked-api conformance queries
compare against the shared bundler's iteration order — so nothing here may
re-sort or re-key the data.
"""

from __future__ import annotations

import json
from functools import cache
from importlib import resources
from typing import Any

RawData = dict[str, list[Any]]

#: Collection keys present in the bundle (and in :func:`empty_raw_data`).
COLLECTION_KEYS = (
    "units",
    "target_profiles",
    "weapons",
    "weapon_keywords",
    "unit_keywords",
    "factions",
    "abilities",
    "phase_mappings",
    "detachments",
    "allied_rules",
    "stratagems",
    "enhancements",
    "leader_attachments",
    "unit_compositions",
    "wargear_options",
    "wargear",
    "game_versions",
    "missions",
    "mission_matchups",
    "mission_cards",
    "deployment_patterns",
    "force_dispositions",
    "terrain_templates",
    "terrain_layouts",
    "hull_shapes",
    "resource_pools",
    "interaction_flags",
)


def empty_raw_data() -> RawData:
    """A ``RawData`` with every collection initialised to an empty list."""
    return {key: [] for key in COLLECTION_KEYS}


@cache
def raw_data() -> RawData:
    """The embedded dataset, parsed once per process."""
    text = resources.files("wh40kdc").joinpath("_bundle.json").read_text(encoding="utf-8")
    data: RawData = json.loads(text)
    return data
