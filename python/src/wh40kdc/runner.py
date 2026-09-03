"""NDJSON conformance runner — the Python implementation of the wire protocol
in ``conformance/RUNNER_PROTOCOL.md``.

Each line on stdin is a JSON request ``{op, args?}``; each line on stdout is
a JSON response ``{ok: true, value}`` or
``{ok: false, error_kind, error_payload?}``. Invoke as
``python -m wh40kdc.runner`` (deliberately not a console script — a
``wh40kdc-runner`` entry point would collide with the Rust binary of the
same name on PATH).

The runner is a *thin* wrapper over the public API — it is not the canonical
way to use the package. It exists to give the cross-implementation differ a
uniform interface across language ports. Python mirror of
``tools/src/runner.ts``; :func:`dispatch` is exported so pytest can drive
the runner in-process without spawning a child.
"""

from __future__ import annotations

import json
import math
import sys
from typing import Any, TypeGuard

from wh40kdc._spec import SPEC_VERSION
from wh40kdc._version import __version__ as IMPL_VERSION
from wh40kdc.compare import LoadoutLine, compare_cell, loadout_cell
from wh40kdc.cruncher import attribute_stages, crunch
from wh40kdc.data.affordability import candidate_affordability
from wh40kdc.data.base import encode_base
from wh40kdc.data.dataset import Dataset
from wh40kdc.data.loadout import base_loadout, check_unit_legality, loadout_candidates, maximal_loadout
from wh40kdc.data.normalize import normalize_name
from wh40kdc.data.roster import validate_roster_core
from wh40kdc.export import EXPORT_FORMATS, export_roster
from wh40kdc.imports import import_roster, try_import_roster
from wh40kdc.scope import unit_matches_applies_to
from wh40kdc.scoring import (
    add_to_hand,
    awards_of,
    empty_player_game,
    player_primary,
    player_secondary,
    player_total,
    remove_score,
    score_cap,
    score_primary_event,
    score_secondary,
    score_secondary_event,
    score_turn,
    set_primary,
    wtc_result,
)
from wh40kdc.share import decode_share_token, encode_share_token
from wh40kdc.terrain import (
    BOARD_INCHES,
    TerrainKeystoneError,
    TerrainResolveError,
    keystone_measurements,
    resolve_layout,
)
from wh40kdc.translate import describe_ability, describe_scoring_card
from wh40kdc.validator import VALIDATOR_TARGETS, SchemaValidator, create_validator

IMPL_NAME = "py"

Response = dict[str, Any]


def _ok(value: Any) -> Response:
    return {"ok": True, "value": value}


def _err(kind: str, payload: Any = None) -> Response:
    if payload is None:
        return {"ok": False, "error_kind": kind}
    return {"ok": False, "error_kind": kind, "error_payload": payload}


def _is_number(v: Any) -> TypeGuard[int | float]:
    # JS `typeof x === "number"` — bool is excluded deliberately.
    return isinstance(v, (int, float)) and not isinstance(v, bool)


class RunnerState:
    """init must be the first request; subsequent ops fail with INVALID_INPUT
    until init succeeds. Dataset and validator are lazy."""

    def __init__(self) -> None:
        self.initialized = False
        self.locale = "C"
        self.tz = "UTC"
        self.seed = 0
        self._dataset: Dataset | None = None
        self._validator: SchemaValidator | None = None

    def dataset(self) -> Dataset:
        if self._dataset is None:
            self._dataset = Dataset.embedded()
        return self._dataset

    def validator(self) -> SchemaValidator:
        if self._validator is None:
            self._validator = create_validator()
        return self._validator


def create_runner_state() -> RunnerState:
    return RunnerState()


# -----------------------------------------------------------------------------
# Op handlers.
# -----------------------------------------------------------------------------


def _handle_init(state: RunnerState, args: Any) -> Response:
    if state.initialized:
        return _err("INVALID_INPUT", {"detail": "init called twice"})
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "init args must be an object"})
    if args.get("spec_version") != SPEC_VERSION:
        return _err(
            "INVALID_INPUT",
            {
                "detail": (
                    f"spec_version mismatch: runner={SPEC_VERSION}, "
                    f"request={args.get('spec_version')}"
                )
            },
        )
    if args.get("locale") != "C":
        return _err(
            "INVALID_INPUT", {"detail": f'unsupported locale: {args.get("locale")} (only "C")'}
        )
    if args.get("tz") != "UTC":
        return _err("INVALID_INPUT", {"detail": f'unsupported tz: {args.get("tz")} (only "UTC")'})
    if not _is_number(args.get("seed")):
        return _err("INVALID_INPUT", {"detail": "seed must be a number"})
    state.initialized = True
    state.locale = args["locale"]
    state.tz = args["tz"]
    state.seed = args["seed"]
    return _ok({"impl": IMPL_NAME, "spec_version": SPEC_VERSION, "impl_version": IMPL_VERSION})


def _handle_normalize(args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "normalize args must be an object"})
    if not isinstance(args.get("input"), str):
        return _err("INVALID_INPUT", {"detail": "normalize.input must be a string"})
    return _ok(normalize_name(args["input"]))


def _handle_import(state: RunnerState, args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "import args must be an object"})
    if not isinstance(args.get("input"), str):
        return _err("INVALID_INPUT", {"detail": "import.input must be a string"})
    try:
        # The wire protocol carries every input as a string: JSON payloads
        # come through as the JSON text, text payloads come through as-is.
        raw = args["input"]
        trimmed = raw.lstrip()
        decoded: Any
        if trimmed.startswith("{") or trimmed.startswith("["):
            try:
                decoded = json.loads(raw)
            except ValueError:
                decoded = raw
        else:
            decoded = raw
        roster = import_roster(decoded, state.dataset())
        return _ok(roster)
    except Exception as e:
        return _err("IMPORT_FAILED", {"detail": str(e), "format": args.get("format")})


def _handle_try_import(state: RunnerState, args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "try_import args must be an object"})
    if not isinstance(args.get("input"), str):
        return _err("INVALID_INPUT", {"detail": "try_import.input must be a string"})
    result = try_import_roster(args["input"], state.dataset())
    if not result["ok"]:
        return _err("IMPORT_FAILED", {"reason": result["reason"], "message": result["message"]})
    return _ok({"format": result["format"], "roster": result["roster"]})


def _handle_export(state: RunnerState, args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "export args must be an object"})
    fmt = args.get("format")
    if not isinstance(fmt, str) or fmt not in EXPORT_FORMATS:
        return _err("INVALID_INPUT", {"detail": f"unknown export format: {fmt}"})
    if not isinstance(args.get("roster"), dict):
        return _err("INVALID_INPUT", {"detail": "export.roster must be an object"})
    try:
        # Dataset-backed formats (yellowscribe) get the embedded dataset; the
        # Dataset-free formats ignore it.
        return _ok(export_roster(args["roster"], fmt, state.dataset()))
    except Exception as e:
        return _err("EXPORT_FAILED", {"detail": str(e)})


def _handle_share_encode(args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "share_encode args must be an object"})
    if not isinstance(args.get("list"), dict):
        return _err("INVALID_INPUT", {"detail": "share_encode.list must be an object"})
    try:
        return _ok(encode_share_token(args["list"]))
    except Exception as e:
        # An id absent from the embedded registry is the only expected throw.
        return _err("INVALID_INPUT", {"detail": str(e)})


def _handle_share_decode(args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "share_decode args must be an object"})
    if not isinstance(args.get("token"), str):
        return _err("INVALID_INPUT", {"detail": "share_decode.token must be a string"})
    # A malformed/stale token is a normal result (the inner ``ok`` carries it).
    return _ok(decode_share_token(args["token"]))


def _handle_check_unit_legality(state: RunnerState, args: Any) -> Response:
    """Whole-unit loadout legality (tier-aware) — mirror of the TS runner op.

    Returns sorted ``"code:id"`` strings.
    """
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "check_unit_legality args must be an object"})
    unit_id = args.get("unitId")
    model_count = args.get("modelCount")
    if not isinstance(unit_id, str) or not isinstance(model_count, int):
        return _err("INVALID_INPUT", {"detail": "check_unit_legality.unitId/modelCount required"})
    faction_id = args.get("factionId")
    ds = state.dataset()
    u = (
        ds.units.get_in_faction(unit_id, faction_id)
        if isinstance(faction_id, str)
        else ds.units.get_any(unit_id)
    )
    if u is None:
        return _err("UNKNOWN_ENTITY", {"kind": "unit", "id": unit_id})
    comp = next(
        (
            c
            for c in ds.unit_compositions
            if c.get("unit_id") == unit_id and c.get("faction_id") == u.raw.get("faction_id")
        ),
        None,
    )
    counts = {k: int(v) for k, v in (args.get("counts") or {}).items()}
    violations = check_unit_legality(
        u.raw,
        model_count,
        ds.wargear_options_of(u.raw),
        counts,
        (comp or {}).get("models"),
        (comp or {}).get("tiers"),
    )
    return _ok(sorted(f"{v['code']}:{v['id']}" for v in violations))


def _handle_check_roster_legality(state: RunnerState, args: Any) -> Response:
    """Whole-army legality over a compact roster spec — mirror of the TS runner op.

    Returns the sorted union of per-unit loadout and army violations as
    ``"<scope>|<severity>|<code>:<id>"`` strings.
    """
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "check_roster_legality args must be an object"})
    if not isinstance(args.get("units"), list):
        return _err("INVALID_INPUT", {"detail": "check_roster_legality.units must be an array"})
    faction_id = args.get("factionId")
    battle_size = args.get("battleSize")
    force_disposition = args.get("forceDisposition")
    spec = {
        "faction_id": faction_id if isinstance(faction_id, str) else None,
        "battle_size": battle_size if isinstance(battle_size, str) else None,
        "force_disposition": force_disposition if isinstance(force_disposition, str) else None,
        "detachment_ids": [
            d["id"]
            for d in (args.get("detachments") or [])
            if isinstance(d, dict) and isinstance(d.get("id"), str)
        ],
        "units": [
            {
                "unit_id": u.get("unitId") if isinstance(u.get("unitId"), str) else "",
                "model_count": u.get("modelCount") if _is_number(u.get("modelCount")) else 0,
                "is_warlord": u.get("isWarlord") is True,
                "enhancement_id": (
                    u.get("enhancementId") if isinstance(u.get("enhancementId"), str) else None
                ),
                "leader_bodyguard_id": (
                    u.get("leaderBodyguardId")
                    if isinstance(u.get("leaderBodyguardId"), str)
                    else None
                ),
                "counts": {k: int(v) for k, v in (u.get("counts") or {}).items()},
            }
            for u in args["units"]
        ],
    }
    result = validate_roster_core(spec, state.dataset())
    lines = [
        f"u{u['unitIndex']}|error|{v['code']}:{v['id']}"
        for u in result["units"]
        for v in u["violations"]
    ]
    lines += [
        f"{'army' if v['unitIndex'] is None else 'u' + str(v['unitIndex'])}"
        f"|{v['severity']}|{v['code']}:{v['id']}"
        for v in result["army"]
    ]
    return _ok(sorted(lines))


def _handle_candidate_affordability(state: RunnerState, args: Any) -> Response:
    """Cheapest-next-copy pricing + affordability — mirror of the TS runner op.

    Returns ``[{unitId, nextCopyCost, affordable}]`` sorted ascending by
    ``(nextCopyCost, unitId)``.
    """
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "candidate_affordability args must be an object"})
    if not isinstance(args.get("units"), list):
        return _err("INVALID_INPUT", {"detail": "candidate_affordability.units must be an array"})
    faction_id = args.get("factionId")
    battle_size = args.get("battleSize")
    points_limit_override = args.get("pointsLimitOverride")
    candidate_unit_ids = args.get("candidateUnitIds")
    spec = {
        "faction_id": faction_id if isinstance(faction_id, str) else None,
        "battle_size": battle_size if isinstance(battle_size, str) else None,
        "points_limit_override": (
            points_limit_override if _is_number(points_limit_override) else None
        ),
        "units": [
            {
                "unit_id": u.get("unitId") if isinstance(u.get("unitId"), str) else "",
                "model_count": u.get("modelCount") if _is_number(u.get("modelCount")) else 0,
                "enhancement_id": (
                    u.get("enhancementId") if isinstance(u.get("enhancementId"), str) else None
                ),
            }
            for u in args["units"]
        ],
        "candidate_unit_ids": (
            [c for c in candidate_unit_ids if isinstance(c, str)]
            if isinstance(candidate_unit_ids, list)
            else None
        ),
    }
    return _ok(candidate_affordability(spec, state.dataset()))


def _handle_linked_query(state: RunnerState, args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "linked_query args must be an object"})
    query = args.get("query")
    if not isinstance(query, str):
        return _err("INVALID_INPUT", {"detail": "linked_query.query must be a string"})
    ds = state.dataset()
    input_ = args.get("input") or {}
    # The wire carries ids as strings; missing ids coerce to "" (matches the
    # TS Map.get(undefined) → miss behavior).
    unit_id = input_.get("unitId") or ""
    try:
        if query == "find_unit":
            u = ds.units.find(input_.get("query", ""))
            return _ok(u.id if u else None)
        if query == "find_weapon":
            w = ds.weapons.find(input_.get("query", ""))
            return _ok(w.id if w else None)
        if query == "find_faction":
            f = ds.factions.find(input_.get("query", ""))
            return _ok(f.id if f else None)
        if query == "find_ability":
            a = ds.abilities.find(input_.get("query", ""))
            return _ok(a.id if a else None)
        if query == "get_enhancement":
            # Resolved enhancement's current id (or null): exercises renamed-id
            # resolution via the share-registry alias map.
            e = ds.enhancements.get(input_.get("id", ""))
            return _ok(e["id"] if e else None)
        if query == "abilities_of":
            u = ds.units.get_any(unit_id)
            if u is None:
                return _err("UNKNOWN_ENTITY", {"kind": "unit", "id": input_.get("unitId")})
            return _ok([x.id for x in u.abilities])
        if query == "weapons_of":
            u = ds.units.get_any(unit_id)
            if u is None:
                return _err("UNKNOWN_ENTITY", {"kind": "unit", "id": input_.get("unitId")})
            return _ok([x.id for x in u.weapons])
        if query == "wargear_options_of":
            u = ds.units.get_any(unit_id)
            if u is None:
                return _err("UNKNOWN_ENTITY", {"kind": "unit", "id": input_.get("unitId")})
            return _ok([x["id"] for x in u.wargear_options])
        if query in ("base_loadout", "maximal_loadout"):
            u = ds.units.get_any(unit_id)
            if u is None:
                return _err("UNKNOWN_ENTITY", {"kind": "unit", "id": input_.get("unitId")})
            # The corpus always supplies modelCount; missing coerces to 0.
            model_count = int(input_.get("modelCount") or 0)
            comp = next((c for c in ds.unit_compositions if c.get("unit_id") == unit_id), None)
            fn = base_loadout if query == "base_loadout" else maximal_loadout
            lo = fn(
                u.raw,
                model_count,
                ds.wargear_options_of(u.raw),
                (comp or {}).get("models"),
            )
            # Encode the id→count map as sorted "id:count" strings for set compare.
            return _ok(sorted(f"{id_}:{n}" for id_, n in lo.items()))
        if query == "loadout_candidates":
            u = ds.units.get_in_faction(unit_id, input_.get("factionId")) if input_.get("factionId") else ds.units.get_any(unit_id)
            if u is None:
                return _err("UNKNOWN_ENTITY", {"kind": "unit", "id": input_.get("unitId")})
            comp = next((c for c in ds.unit_compositions if c.get("unit_id") == unit_id and c.get("faction_id") == u.raw.get("faction_id")), None)
            return _ok(loadout_candidates(
                u.raw,
                int(input_.get("modelCount") or 0),
                ds.wargear_options_of(u.raw),
                (comp or {}).get("models"),
                (comp or {}).get("tiers"),
                int(input_["limit"]) if input_.get("limit") is not None else None,
            ))
        if query == "phases_of":
            ab = ds.abilities.get_any(input_.get("abilityId") or "")
            if ab is None:
                return _err("UNKNOWN_ENTITY", {"kind": "ability", "id": input_.get("abilityId")})
            return _ok(list(ab.phases))
        if query == "faction_of":
            u = ds.units.get_any(unit_id)
            if u is None:
                return _err("UNKNOWN_ENTITY", {"kind": "unit", "id": input_.get("unitId")})
            return _ok(u.faction.id if u.faction else None)
        if query == "base_size_of":
            u = ds.units.get_any(unit_id)
            if u is None:
                return _err("UNKNOWN_ENTITY", {"kind": "unit", "id": input_.get("unitId")})
            return _ok(encode_base(u.raw.get("base_size_mm")))
        if query == "model_bases_of":
            u = ds.units.get_any(unit_id)
            if u is None:
                return _err("UNKNOWN_ENTITY", {"kind": "unit", "id": input_.get("unitId")})
            comp = next((c for c in ds.unit_compositions if c.get("unit_id") == unit_id), None)
            # Ordered "modelName=encodedBase" pairs in declared model order.
            models = (comp or {}).get("models") or []
            return _ok(
                [f"{m['name']}={encode_base(m.get('base_size_mm')) or 'none'}" for m in models]
            )
        if query == "abilities_of_faction":
            return _ok([x.id for x in ds.abilities.by_faction(input_.get("factionId") or "")])
        if query == "weapons_of_faction":
            f = ds.factions.get(input_.get("factionId") or "")
            if f is None:
                return _err("UNKNOWN_ENTITY", {"kind": "faction", "id": input_.get("factionId")})
            return _ok([x.id for x in f.weapons])
        if query == "logo_url_of_faction":
            f = ds.factions.get(input_.get("factionId") or "")
            if f is None:
                return _err("UNKNOWN_ENTITY", {"kind": "faction", "id": input_.get("factionId")})
            return _ok(f.logo_url)
        if query == "units_with_keyword":
            return _ok([u.id for u in ds.units_with_keyword(input_.get("keyword") or "")])
        if query == "allies_for":
            detachment_ids = input_.get("detachmentIds")
            if not isinstance(detachment_ids, list):
                detachment_ids = []
            return _ok(
                [r["id"] for r in ds.allies_for(input_.get("factionId") or "", detachment_ids)]
            )
        if query == "ally_units_for":
            return _ok([u.id for u in ds.ally_units_for(input_.get("ruleId") or "")])
        if query == "leaders_attachable_to":
            return _ok([u.id for u in ds.leaders_attachable_to(input_.get("bodyguardId") or "")])
        if query == "bodyguards_attachable_from":
            return _ok([u.id for u in ds.bodyguards_attachable_from(input_.get("leaderId") or "")])
        if query == "reactive_trigger_ability_ids":
            return _ok(sorted(rt["ability_id"] for rt in ds.reactive_triggers()))
        if query == "events_with_triggers":
            return _ok(sorted(ds.trigger_index().keys()))
        if query == "triggers_for_event":
            event = input_.get("event") or ""
            return _ok(
                sorted(rt["ability_id"] for rt in ds.reactive_triggers() if rt["event"] == event)
            )
        return _err("INVALID_INPUT", {"detail": f"unknown linked_query: {query}"})
    except Exception as e:
        return _err("INTERNAL_ERROR", {"detail": str(e)})


def _handle_validate(state: RunnerState, args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "validate args must be an object"})
    target = args.get("target")
    if not isinstance(target, str) or target not in VALIDATOR_TARGETS:
        return _err("INVALID_INPUT", {"detail": f"unknown validator target: {target}"})
    try:
        validator = state.validator()
        if not validator.has_schema(VALIDATOR_TARGETS[target]):
            return _err("VALIDATION_ERROR", {"detail": f"schema not loaded: {target}"})
        return _ok(validator.validate_target(target, args.get("value")))
    except Exception as e:
        return _err("VALIDATION_ERROR", {"detail": str(e)})


def _build_engine_input(
    state: RunnerState, a: dict[str, Any], op_name: str
) -> tuple[Any, Response | None]:
    """Validate the wire-shape crunch/attribution args and assemble the
    EngineInput both ops share, or return a typed runner error."""
    attacker = a.get("attacker") or {}
    target = a.get("target") or {}
    if not attacker.get("weaponId") or not _is_number(attacker.get("profileIndex")):
        return None, _err(
            "INVALID_INPUT", {"detail": f"{op_name}.attacker.weaponId/profileIndex required"}
        )
    if not target.get("unitId") or not _is_number(target.get("profileIndex")):
        return None, _err(
            "INVALID_INPUT", {"detail": f"{op_name}.target.unitId/profileIndex required"}
        )
    if not _is_number(a.get("modelsFiring")):
        return None, _err("INVALID_INPUT", {"detail": f"{op_name}.modelsFiring required"})
    if not a.get("context"):
        return None, _err("INVALID_INPUT", {"detail": f"{op_name}.context required"})
    ds = state.dataset()
    weapon = ds.weapons.get_any(attacker["weaponId"])
    if weapon is None:
        return None, _err("UNKNOWN_ENTITY", {"kind": "weapon", "id": attacker["weaponId"]})
    unit = ds.units.get_any(target["unitId"])
    if unit is None:
        return None, _err("UNKNOWN_ENTITY", {"kind": "unit", "id": target["unitId"]})
    target_input: dict[str, Any] = {"unit": unit.raw, "profileIndex": target["profileIndex"]}
    if target.get("modelCount") is not None:
        target_input["modelCount"] = target["modelCount"]
    return (
        {
            "attacker": {"weapon": weapon.raw, "profileIndex": attacker["profileIndex"]},
            "target": target_input,
            "modelsFiring": a["modelsFiring"],
            "buffs": a.get("buffs") or [],
            "context": a["context"],
        },
        None,
    )


def _handle_crunch(state: RunnerState, args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "crunch args must be an object"})
    input_, error = _build_engine_input(state, args, "crunch")
    if error is not None:
        return error
    try:
        # Canonical wire shape: stages array only. `resolved` is impl-internal;
        # per-stage `detail` strings aren't byte-equal across impls. The differ
        # compares per-stage `expected` with 5e-4 tolerance.
        out = crunch(input_, state.dataset())
        stages = [{"name": s["name"], "expected": s["expected"]} for s in out["stages"]]
        return _ok({"stages": stages})
    except Exception as e:
        return _err("CRUNCH_ERROR", {"detail": str(e)})


def _handle_compare(state: RunnerState, args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "compare args must be an object"})
    attacker = args.get("attacker") or {}
    phase = args.get("phase")
    if (
        not isinstance(attacker.get("factionId"), str)
        or not isinstance(attacker.get("unitId"), str)
        or not isinstance(attacker.get("weaponId"), str)
        or not _is_number(attacker.get("profileIndex"))
        or not isinstance(args.get("targetProfileId"), str)
        or not _is_number(args.get("distance"))
        or phase not in ("shooting", "fight")
    ):
        return _err(
            "INVALID_INPUT",
            {"detail": "compare: malformed attacker/target/distance/phase"},
        )
    models_firing = args.get("modelsFiring")
    try:
        cell = compare_cell(
            state.dataset(),
            faction_id=attacker["factionId"],
            unit_id=attacker["unitId"],
            weapon_id=attacker["weaponId"],
            profile_index=int(attacker["profileIndex"]),
            target_profile_id=args["targetProfileId"],
            distance=float(args["distance"]),
            phase=phase,
            models_firing=int(models_firing) if _is_number(models_firing) else 1,
        )
        return _ok(cell)
    except (KeyError, ValueError, IndexError) as e:
        return _err("UNKNOWN_ENTITY", {"detail": str(e)})


def _handle_loadout(state: RunnerState, args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "loadout args must be an object"})
    lines = args.get("lines")
    phase = args.get("phase")
    if (
        not isinstance(lines, list)
        or not isinstance(args.get("targetProfileId"), str)
        or not _is_number(args.get("distance"))
        or phase not in ("shooting", "fight")
    ):
        return _err("INVALID_INPUT", {"detail": "loadout: malformed lines/target/distance/phase"})
    try:
        parsed = [
            LoadoutLine(
                weapon_id=line["weaponId"],
                count=int(line["count"]),
                profile_index=int(line.get("profileIndex", 0)),
            )
            for line in lines
        ]
        cell = loadout_cell(
            state.dataset(),
            lines=parsed,
            target_profile_id=args["targetProfileId"],
            distance=float(args["distance"]),
            phase=phase,
        )
        return _ok(cell)
    except (KeyError, ValueError, IndexError, TypeError) as e:
        return _err("UNKNOWN_ENTITY", {"detail": str(e)})


def _handle_attribution(state: RunnerState, args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "attribution args must be an object"})
    input_, error = _build_engine_input(state, args, "attribution")
    if error is not None:
        return error
    try:
        epsilon = args.get("epsilon")
        # Drop `detail` from the wire (impl-specific formatting).
        if _is_number(epsilon):
            stages = attribute_stages(input_, state.dataset(), epsilon=epsilon)
        else:
            stages = attribute_stages(input_, state.dataset())
        return _ok(
            [
                {
                    "name": s["name"],
                    "expected": s["expected"],
                    "baseline": s["baseline"],
                    "lifts": s["lifts"],
                    "residual": s["residual"],
                    "intrinsics": s["intrinsics"],
                }
                for s in stages
            ]
        )
    except Exception as e:
        return _err("CRUNCH_ERROR", {"detail": str(e)})


def _handle_translate_scoring(state: RunnerState, args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "translate_scoring args must be an object"})
    if not isinstance(args.get("cardId"), str):
        return _err("INVALID_INPUT", {"detail": "translate_scoring.cardId must be a string"})
    card = state.dataset().mission_cards.get(args["cardId"])
    if card is None:
        return _err("UNKNOWN_ENTITY", {"kind": "secondary-card", "id": args["cardId"]})
    return _ok({"awards": describe_scoring_card(card)})


def _handle_translate_effect(args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "translate_effect args must be an object"})
    if not isinstance(args.get("effect"), dict):
        return _err("INVALID_INPUT", {"detail": "translate_effect.effect must be an object"})
    ability: dict[str, Any] = {"effect": args["effect"]}
    if isinstance(args.get("scope"), dict):
        ability["scope"] = args["scope"]
    if isinstance(args.get("usage"), dict):
        ability["usage"] = args["usage"]
    # A trigger may be a single object or an array (fire on any). Mirror the TS
    # runner's `typeof === "object" && !== null` check, which accepts both.
    if isinstance(args.get("trigger"), (dict, list)):
        ability["trigger"] = args["trigger"]
    if isinstance(args.get("applies_to"), dict):
        ability["applies_to"] = args["applies_to"]
    return _ok({"text": describe_ability(ability)})


def _handle_match_applies_to(args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "match_applies_to args must be an object"})
    units = args.get("units")
    if not isinstance(units, list):
        return _err("INVALID_INPUT", {"detail": "match_applies_to.units must be an array"})
    applies_to = args.get("applies_to")
    if not isinstance(applies_to, dict):
        applies_to = None
    matched_ids: list[str] = []
    for unit in units:
        owned = [*(unit.get("keywords") or []), *(unit.get("faction_keywords") or [])]
        if unit_matches_applies_to(applies_to, owned):
            matched_ids.append(unit["id"])
    return _ok({"matchedIds": matched_ids})


# -----------------------------------------------------------------------------
# Scoring engine ops. Awards are referenced by index into the card's `awards`
# array (never serialized over the wire) so all impls reconstruct the same
# asserted awards from the shared embedded dataset.
# -----------------------------------------------------------------------------


def _is_scoring_mode(v: Any) -> bool:
    return v in ("fixed", "tactical")


def _resolve_asserted(
    card: dict[str, Any], asserted: Any
) -> tuple[list[dict[str, Any]] | None, Response | None]:
    """Resolve ``[{index, count?}]`` against a card's awards, or return a
    typed error. The index addresses the full ``awards`` array."""
    if not isinstance(asserted, list):
        return None, _err("INVALID_INPUT", {"detail": "asserted must be an array"})
    awards = awards_of(card)
    out: list[dict[str, Any]] = []
    for raw in asserted:
        if not isinstance(raw, dict):
            return None, _err("INVALID_INPUT", {"detail": "asserted entry must be an object"})
        index = raw.get("index")
        if not _is_number(index) or index < 0 or index >= len(awards):
            return None, _err("INVALID_INPUT", {"detail": f"asserted.index out of range: {index}"})
        entry: dict[str, Any] = {"award": awards[int(index)]}
        if raw.get("count") is not None:
            entry["count"] = raw["count"]
        out.append(entry)
    return out, None


def _optional_caps(o: dict[str, Any]) -> dict[str, Any]:
    caps: dict[str, Any] = {}
    if _is_number(o.get("roundCap")):
        caps["roundCap"] = o["roundCap"]
    if _is_number(o.get("gameCap")):
        caps["gameCap"] = o["gameCap"]
    return caps


def _handle_score_event(state: RunnerState, args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "score_event args must be an object"})
    if not isinstance(args.get("cardId"), str):
        return _err("INVALID_INPUT", {"detail": "score_event.cardId must be a string"})
    if not _is_scoring_mode(args.get("approach")):
        return _err(
            "INVALID_INPUT", {"detail": "score_event.approach must be 'fixed' or 'tactical'"}
        )
    card = state.dataset().mission_cards.get(args["cardId"])
    if card is None:
        return _err("UNKNOWN_ENTITY", {"kind": "secondary-card", "id": args["cardId"]})
    resolved, error = _resolve_asserted(card, args.get("asserted"))
    if error is not None:
        return error
    assert resolved is not None

    cap = score_cap(card, args["approach"])
    value: dict[str, Any] = {
        "turn": score_turn(resolved),
        # Infinity (uncapped fixed) has no JSON form — null means "no cap".
        "cap": None if cap == math.inf else int(cap),
        "banked": score_secondary_event(resolved, card, args["approach"]),
    }
    if _is_number(args.get("roundCap")):
        value["primaryBanked"] = score_primary_event(resolved, args["roundCap"])
    return _ok(value)


def _handle_score_state(state: RunnerState, args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "score_state args must be an object"})
    if not _is_scoring_mode(args.get("approach")):
        return _err(
            "INVALID_INPUT", {"detail": "score_state.approach must be 'fixed' or 'tactical'"}
        )
    if not isinstance(args.get("ops"), list):
        return _err("INVALID_INPUT", {"detail": "score_state.ops must be an array"})
    pg = empty_player_game(args["approach"])
    ds = state.dataset()
    for raw in args["ops"]:
        kind = raw.get("kind") if isinstance(raw, dict) else None
        if kind == "draw":
            if not isinstance(raw.get("cardId"), str):
                return _err("INVALID_INPUT", {"detail": "draw.cardId must be a string"})
            pg = add_to_hand(pg, raw["cardId"])
        elif kind == "score-secondary":
            if not isinstance(raw.get("cardId"), str) or not _is_number(raw.get("round")):
                return _err("INVALID_INPUT", {"detail": "score-secondary needs cardId and round"})
            card = ds.mission_cards.get(raw["cardId"])
            if card is None:
                return _err("UNKNOWN_ENTITY", {"kind": "secondary-card", "id": raw["cardId"]})
            resolved, error = _resolve_asserted(card, raw.get("asserted"))
            if error is not None:
                return error
            assert resolved is not None
            vp = score_secondary_event(resolved, card, pg["approach"])
            pg = score_secondary(pg, raw["round"], raw["cardId"], vp, _optional_caps(raw))
        elif kind == "score-primary":
            if not isinstance(raw.get("cardId"), str) or not _is_number(raw.get("round")):
                return _err("INVALID_INPUT", {"detail": "score-primary needs cardId and round"})
            card = ds.mission_cards.get(raw["cardId"])
            if card is None:
                return _err("UNKNOWN_ENTITY", {"kind": "secondary-card", "id": raw["cardId"]})
            resolved, error = _resolve_asserted(card, raw.get("asserted"))
            if error is not None:
                return error
            assert resolved is not None
            # The app path: compute the round's raw total, then clamp on store.
            pg = set_primary(pg, raw["round"], score_turn(resolved), _optional_caps(raw))
        elif kind == "set-primary":
            if not _is_number(raw.get("round")) or not _is_number(raw.get("vp")):
                return _err("INVALID_INPUT", {"detail": "set-primary needs round and vp"})
            pg = set_primary(pg, raw["round"], raw["vp"], _optional_caps(raw))
        elif kind == "remove-score":
            if not _is_number(raw.get("index")):
                return _err("INVALID_INPUT", {"detail": "remove-score needs index"})
            pg = remove_score(pg, raw["index"])
        else:
            return _err("INVALID_INPUT", {"detail": f"unknown score_state op kind: {kind}"})
    return _ok(
        {
            "rounds": pg["rounds"],
            "handIds": pg["handIds"],
            "log": pg["log"],
            "primary": player_primary(pg),
            "secondary": player_secondary(pg),
            "total": player_total(pg),
        }
    )


def _handle_wtc_result(args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "wtc_result args must be an object"})
    if not _is_number(args.get("a")) or not _is_number(args.get("b")):
        return _err("INVALID_INPUT", {"detail": "wtc_result needs numeric a and b"})
    return _ok(wtc_result(args["a"], args["b"]))


def _handle_resolve_terrain(args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "resolve_terrain args must be an object"})
    if not isinstance(args.get("layout"), dict):
        return _err("INVALID_INPUT", {"detail": "resolve_terrain.layout must be an object"})
    templates = args.get("templates")
    if templates is None:
        templates = []
    if not isinstance(templates, list):
        return _err("INVALID_INPUT", {"detail": "resolve_terrain.templates must be an array"})
    try:
        return _ok({"pieces": resolve_layout(args["layout"], templates)})
    except TerrainResolveError as e:
        return _err("INVALID_INPUT", {"detail": str(e)})
    except Exception as e:
        return _err("INTERNAL_ERROR", {"detail": str(e)})


def _handle_keystones(args: Any) -> Response:
    if not isinstance(args, dict):
        return _err("INVALID_INPUT", {"detail": "keystones args must be an object"})
    if not isinstance(args.get("layout"), dict):
        return _err("INVALID_INPUT", {"detail": "keystones.layout must be an object"})
    templates = args.get("templates")
    if templates is None:
        templates = []
    if not isinstance(templates, list):
        return _err("INVALID_INPUT", {"detail": "keystones.templates must be an array"})
    board = BOARD_INCHES
    if args.get("board") is not None:
        b = args["board"]
        if (
            not isinstance(b, dict)
            or not _is_number(b.get("width"))
            or not _is_number(b.get("height"))
        ):
            return _err("INVALID_INPUT", {"detail": "keystones.board must be {width, height}"})
        board = {"width": b["width"], "height": b["height"]}
    try:
        measurements = keystone_measurements(args["layout"], templates, board)
        return _ok({"measurements": measurements})
    except (TerrainKeystoneError, TerrainResolveError) as e:
        return _err("INVALID_INPUT", {"detail": str(e)})
    except Exception as e:
        return _err("INTERNAL_ERROR", {"detail": str(e)})


# -----------------------------------------------------------------------------
# Dispatcher and per-line entry point.
# -----------------------------------------------------------------------------


def dispatch(state: RunnerState, req: dict[str, Any]) -> Response:
    """Apply one decoded request to the runner state and return the response.
    Used directly by tests; the CLI loop wraps it with line parsing."""
    op = req.get("op")
    args = req.get("args")
    if not state.initialized and op != "init":
        return _err("INVALID_INPUT", {"detail": "must init before any other op"})
    if op == "init":
        return _handle_init(state, args)
    if op == "version":
        return _ok({"impl": IMPL_NAME, "spec_version": SPEC_VERSION, "impl_version": IMPL_VERSION})
    if op == "normalize":
        return _handle_normalize(args)
    if op == "import":
        return _handle_import(state, args)
    if op == "try_import":
        return _handle_try_import(state, args)
    if op == "export":
        return _handle_export(state, args)
    if op == "linked_query":
        return _handle_linked_query(state, args)
    if op == "check_unit_legality":
        return _handle_check_unit_legality(state, args)
    if op == "check_roster_legality":
        return _handle_check_roster_legality(state, args)
    if op == "candidate_affordability":
        return _handle_candidate_affordability(state, args)
    if op == "validate":
        return _handle_validate(state, args)
    if op == "crunch":
        return _handle_crunch(state, args)
    if op == "compare":
        return _handle_compare(state, args)
    if op == "loadout":
        return _handle_loadout(state, args)
    if op == "attribution":
        return _handle_attribution(state, args)
    if op == "translate_scoring":
        return _handle_translate_scoring(state, args)
    if op == "translate_effect":
        return _handle_translate_effect(args)
    if op == "match_applies_to":
        return _handle_match_applies_to(args)
    if op == "score_event":
        return _handle_score_event(state, args)
    if op == "score_state":
        return _handle_score_state(state, args)
    if op == "wtc_result":
        return _handle_wtc_result(args)
    if op == "resolve_terrain":
        return _handle_resolve_terrain(args)
    if op == "keystones":
        return _handle_keystones(args)
    if op == "share_encode":
        return _handle_share_encode(args)
    if op == "share_decode":
        return _handle_share_decode(args)
    if op == "shutdown":
        return _ok(None)
    return _err("UNKNOWN_OP", {"op": op})


def process_request(state: RunnerState, line: str) -> str | None:
    """Process one line of stdin (one NDJSON request) and return the line that
    should be written to stdout. Returns None only on fully-empty input
    lines, which are silently ignored."""
    trimmed = line.strip()
    if trimmed == "":
        return None
    try:
        req = json.loads(trimmed)
    except ValueError as e:
        return json.dumps(
            _err("INVALID_INPUT", {"detail": f"not valid JSON: {e}"}), ensure_ascii=False
        )
    if not isinstance(req, dict) or not isinstance(req.get("op"), str):
        return json.dumps(
            _err("INVALID_INPUT", {"detail": "request must have a string `op` field"}),
            ensure_ascii=False,
        )
    response = dispatch(state, req)
    return json.dumps(response, ensure_ascii=False)


def main() -> int:
    """CLI loop: wire stdin/stdout. The differ pipelines requests and expects
    responses in order, flushed per line."""
    # The NDJSON protocol is UTF-8 on every platform; pin the streams so a child
    # process on a non-UTF-8 host locale (e.g. Windows cp1252) doesn't mangle
    # non-ASCII data (unit names like "Khârn") in or out.
    for stream in (sys.stdin, sys.stdout):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")
    state = create_runner_state()
    for line in sys.stdin:
        out = process_request(state, line)
        if out is not None:
            sys.stdout.write(out + "\n")
            sys.stdout.flush()
        # `shutdown` returns ok(null); honor it by exiting after the response
        # is flushed.
        try:
            req = json.loads(line)
            if isinstance(req, dict) and req.get("op") == "shutdown":
                return 0
        except ValueError:
            pass  # already handled above; not a shutdown
    return 0


if __name__ == "__main__":
    sys.exit(main())
