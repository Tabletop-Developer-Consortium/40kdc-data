"""Canonical roster-json adapter: re-import a 40kdc ``Roster`` export.

The exporter's ``roster-json`` format is the lossless pivot — exactly
``roster.schema.json`` shape. This adapter closes the loop so a 40kdc-native
export round-trips through the normal ``try_import_roster`` pipeline: validate
the canonical envelope, lower it to the format-agnostic ``ParsedRoster`` dict,
and let ``resolve`` re-derive ids against the *current* dataset (so a stored
export keeps resolving across dataset releases, and stale ids self-heal through
name resolution).

Lowering notes:

- Unit/wargear/enhancement rows lower to their ``ref.raw_name`` — the same
  raw-display-name path every other adapter takes.
- ``faction_id`` has no raw name in the canonical shape, so the id slug passes
  through as the raw name; collection lookup id-matches exactly before any name
  lookup. Detachments carry a ``ref.raw_name``, so that lowers directly.
- ``is_character`` isn't stored on the canonical shape; it lowers as
  ``leader_attachment is not None`` so the ``support``-only inference still has
  its gate for any unit without an explicit attachment.
- An explicit ``leader_attachment`` (the builder emits one, ``provisional`` =
  ``False``) is carried verbatim into the parsed unit so ``resolve``
  reconstructs it exactly — the round-trip is lossless. Only the bodyguard's
  raw name is lowered; ``resolve`` re-resolves its id against the current
  dataset.

Python mirror of ``tools/src/import/roster-json.ts``.
"""

from __future__ import annotations

from typing import Any

from wh40kdc.imports.adapter import FormatAdapter

#: Battle-size labels ``resolve`` maps back to the enum.
_BATTLE_SIZE_LABELS = {"incursion": "Incursion", "strike-force": "Strike Force"}


def _matches(decoded: Any) -> bool:
    """The canonical shape is unmistakable: a ``source.format`` discriminator
    plus the ``game_version`` + ``diagnostics`` envelope no external builder
    emits. All three are required by ``roster.schema.json``."""
    if not isinstance(decoded, dict):
        return False
    source = decoded.get("source")
    game_version = decoded.get("game_version")
    return (
        isinstance(source, dict)
        and isinstance(source.get("format"), str)
        and isinstance(game_version, dict)
        and isinstance(game_version.get("edition"), str)
        and isinstance(decoded.get("diagnostics"), dict)
        and isinstance(decoded.get("units"), list)
    )


def _lower_unit(u: dict[str, Any]) -> dict[str, Any]:
    la = u.get("leader_attachment")
    parsed: dict[str, Any] = {
        "raw_name": u["ref"]["raw_name"],
        "is_character": la is not None or "Character" in (u.get("keyword_overrides") or []),
        "model_count": u["model_count"],
        "points": u["points"],
        "is_warlord": u["is_warlord"],
        "enhancement_raw_name": (u.get("enhancement") or {}).get("raw_name"),
        "enhancement_points": u["enhancement_points"],
        "wargear": [{"raw_name": w["ref"]["raw_name"], "count": w["count"]} for w in u["wargear"]],
    }
    if u.get("keyword_overrides"):
        parsed["keyword_overrides"] = u["keyword_overrides"]
    if u.get("loadout_groups"):
        parsed["loadout_groups"] = [
            {
                "model_name": group.get("model_name"),
                "count": group["count"],
                "wargear": [
                    {"raw_name": item["ref"]["raw_name"], "count": item["count"]}
                    for item in group["wargear"]
                ],
            }
            for group in u["loadout_groups"]
        ]
    # Carry an explicit attachment verbatim (key elided when absent, matching
    # every other adapter, which never sets it).
    if la is not None:
        parsed["leader_attachment"] = {
            "bodyguard_raw_name": la["bodyguard_ref"]["raw_name"],
            "role": la["role"],
            "provisional": la["provisional"],
        }
    return parsed


def _parse(decoded: Any) -> dict[str, Any]:
    roster: dict[str, Any] = decoded
    battle_size = roster.get("battle_size")
    battle_size_raw = _BATTLE_SIZE_LABELS.get(battle_size) if battle_size is not None else None
    points = roster["points"]
    return {
        "name": roster["name"],
        "generated_by": roster["source"].get("generated_by"),
        # Id slug passes through as the raw name — id-match before name lookup.
        "faction_raw_name": roster.get("faction_id"),
        "detachment_raw_names": [d["ref"]["raw_name"] for d in roster["detachments"]],
        "battle_size_raw": battle_size_raw,
        "force_disposition": roster.get("force_disposition"),
        "declared_limit": points["declared_limit"],
        "total_reported": points["total_reported"],
        "total_computed": points["total_computed"],
        "units": [_lower_unit(u) for u in roster["units"]],
        # The canonical shape carries a single primary faction.
        "multi_force": False,
    }


roster_json_adapter = FormatAdapter(id="roster-json", matches=_matches, parse=_parse)
