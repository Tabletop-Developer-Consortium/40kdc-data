"""Translate an Ability DSL ``effect`` tree into the Buff stack it contributes
(for an attacker-perspective crunch) along with a list of effect fragments the
translator could not auto-apply.

The buff layer is intentionally a subset of the DSL: it covers the math the
cruncher's expected-value engine reads and reports everything else — choice
nodes (player decisions), dice-gated effects (stochastic), defender-side
bs-modifier, attack-restrictions, ability grants, mortal wound triggers — as
``unsupported`` so a UI can surface "this ability has effects we can't
auto-apply" rather than silently dropping them.

Python mirror of ``tools/src/cruncher/from-dsl.ts``. Applied-buff list order
and unsupported-reason strings are pinned by
``conformance/abilities-resolver/from-dsl.json`` /
``defensive-from-dsl.json``.
"""

from __future__ import annotations

import math
from typing import Any, TypeGuard

from wh40kdc.cruncher.buffs import Buff, BuffSource, EngineContext

EffectTranslation = dict[str, Any]

#: Targets that resolve to the buffed unit itself.
_SELF_TARGETS = frozenset(
    ["self", "bearer", "unit", "attached-unit", "friendly-within-aura", "all-friendly"]
)
_ATTACKER_TARGET = "attacker"
_DEFENDER_TARGETS = frozenset(["defender", "enemy-within-aura", "all-enemy"])


def effect_to_buffs(
    effect: Any,
    source: BuffSource,
    context: EngineContext,
    perspective: str = "attacker",
) -> EffectTranslation:
    """Walk an ability DSL ``effect`` tree and produce the buff stack it
    contributes against ``context`` from the given ``perspective``
    (``"attacker"`` or ``"target"``), plus an ``unsupported`` list naming any
    branches the buff layer can't express today and an ``activatable`` list of
    player-decision levers."""
    out: EffectTranslation = {"applied": [], "unsupported": [], "activatable": []}
    ability_id = source.get("abilityId", "effect") if source.get("kind") == "ability" else "effect"
    opts = {"context": context, "perspective": perspective, "abilityId": ability_id}
    _walk(effect, source, opts, out)
    return out


def _is_object(value: Any) -> TypeGuard[dict[str, Any]]:
    return isinstance(value, dict)


def _walk(node: Any, source: BuffSource, opts: dict[str, Any], out: EffectTranslation) -> None:
    if not _is_object(node):
        return
    node_type = node.get("type")
    if node_type == "re-roll":
        _translate_reroll(node, source, opts, out)
    elif node_type == "roll-modifier":
        _translate_roll_modifier(node, source, opts, out)
    elif node_type == "stat-modifier":
        _translate_stat_modifier(node, source, opts, out)
    elif node_type == "feel-no-pain":
        _translate_feel_no_pain(node, source, opts, out)
    elif node_type == "keyword-grant":
        _translate_keyword_grant(node, source, opts, out)
    elif node_type == "bs-modifier":
        _translate_bs_modifier(node, source, opts, out)
    elif node_type == "damage-reduction":
        _translate_damage_reduction(node, source, opts, out)
    elif node_type == "invulnerable-save":
        _translate_invulnerable_save(node, source, opts, out)
    elif node_type == "conditional":
        _translate_conditional(node, source, opts, out)
    elif node_type == "sequence":
        for step in node.get("steps") or []:
            _walk(step, source, opts, out)
    elif node_type == "choice":
        # Player decision — each branch becomes an opt-in lever (pick one).
        _enumerate_choice(node, source, opts, out)
    elif node_type == "dice-gated":
        # Probabilistic; the buff layer is deterministic.
        out["unsupported"].append(
            {
                "reason": "dice-gated effect: stochastic; not expressible as a buff",
                "effectFragment": node,
            }
        )
    elif node_type == "dice-pool-allocation":
        # Player spends dice on options at runtime — each buff-bearing option
        # becomes an opt-in lever, grouped under the pool's activation cap.
        _enumerate_dice_pool(node, source, opts, out)
    elif node_type == "select-units":
        # Targeting wrapper — the selected units receive the nested effect.
        _walk(node.get("effect"), source, opts, out)
    else:
        # Unknown effect — record it. Covers ability-grant, deep-strike,
        # mortal-wounds, cp-gain, movement-modifier, etc.
        out["unsupported"].append(
            {
                "reason": f'effect type "{_js_str(node_type)}" is not modelled by the buff layer',
                "effectFragment": node,
            }
        )


# ---------------------------------------------------------------------------
# Leaf translators
# ---------------------------------------------------------------------------


def _classify_target(node: dict[str, Any]) -> str:
    """Classify a node's ``target`` field: ``"self"`` / ``"attacker"`` /
    ``"defender"`` / ``"unknown"``."""
    target = node.get("target")
    if not isinstance(target, str):
        return "unknown"
    if target == _ATTACKER_TARGET:
        return "attacker"
    if target in _DEFENDER_TARGETS:
        return "defender"
    if target in _SELF_TARGETS:
        return "self"
    return "unknown"


def _applies_to_buffed_unit(node: dict[str, Any], perspective: str) -> bool:
    """Does this node's target match the buffed unit under the perspective?"""
    cls = _classify_target(node)
    if cls == "self":
        return True
    if cls == "attacker":
        return perspective == "attacker"
    if cls == "defender":
        return perspective == "target"
    return False


def _translate_reroll(
    node: dict[str, Any], source: BuffSource, opts: dict[str, Any], out: EffectTranslation
) -> None:
    # Rerolls are inherently attacker-side. Apply only under the matching
    # perspective so a target-perspective walk doesn't grab the attacker's
    # reroll-failed-hits buff.
    if opts["perspective"] == "attacker" and not _applies_to_buffed_unit(node, "attacker"):
        return
    modifier = node.get("modifier")
    if not _is_object(modifier):
        out["unsupported"].append(
            {"reason": "re-roll: missing modifier object", "effectFragment": node}
        )
        return
    narrowed = _unhonorable_narrowing(modifier)
    if narrowed:
        out["unsupported"].append(
            {
                "reason": (
                    f're-roll: narrows by "{narrowed}" which the cruncher '
                    "can't resolve here"
                ),
                "effectFragment": node,
            }
        )
        return
    roll = modifier.get("roll")
    # A `value: 1` on a re-roll modifier unambiguously means "re-roll rolls of
    # 1". A historical migration mis-defaulted such nodes to `subset:
    # "all-failures"`; honor the value as the source of truth.
    subset = "ones" if modifier.get("value") == 1 else modifier.get("subset")
    # Under target perspective, only "save" rerolls fire on the buffed unit.
    if opts["perspective"] == "target" and roll != "save":
        return
    if roll in ("hit", "wound", "save", "damage") and subset in ("ones", "all-failures"):
        out["applied"].append(
            {"source": source, "contribution": {"type": "reroll", "roll": roll, "subset": subset}}
        )
        return
    out["unsupported"].append(
        {
            "reason": (
                f're-roll on "{_js_str(roll)}" (subset "{_js_str(subset)}") '
                "is outside the damage path"
            ),
            "effectFragment": node,
        }
    )


def _translate_roll_modifier(
    node: dict[str, Any], source: BuffSource, opts: dict[str, Any], out: EffectTranslation
) -> None:
    modifier = node.get("modifier")
    if not _is_object(modifier):
        out["unsupported"].append(
            {"reason": "roll-modifier: missing modifier object", "effectFragment": node}
        )
        return
    narrowed = _unhonorable_narrowing(modifier)
    if narrowed:
        out["unsupported"].append(
            {
                "reason": (
                    f'roll-modifier: narrows by "{narrowed}" which the cruncher '
                    "can't resolve here"
                ),
                "effectFragment": node,
            }
        )
        return
    value = _signed_value(modifier)
    if value is None:
        out["unsupported"].append(
            {
                "reason": (
                    f'roll-modifier: operation "{_js_str(modifier.get("operation"))}" '
                    "not supported"
                ),
                "effectFragment": node,
            }
        )
        return
    roll = modifier.get("roll")
    # Each roll type is intrinsically on one side. Hit / wound / damage are
    # attacker-side; save is defender-side.
    if opts["perspective"] == "attacker":
        if not _applies_to_buffed_unit(node, "attacker"):
            return
        if roll == "save":
            return  # saves apply to the defender, not the attacker.
    else:
        # Target perspective accepts: self+save (own save rolls), or
        # attacker+hit/wound (penalty to incoming attacker rolls).
        cls = _classify_target(node)
        if cls == "attacker":
            if roll not in ("hit", "wound"):
                return
        elif cls == "self":
            if roll != "save":
                return
        else:
            return
    contribution_type = {
        "hit": "hit-mod",
        "wound": "wound-mod",
        "save": "save-mod",
        "damage": "damage-mod",
    }.get(roll) if isinstance(roll, str) else None
    if contribution_type is None:
        out["unsupported"].append(
            {
                "reason": f'roll-modifier on "{_js_str(roll)}" is outside the damage path',
                "effectFragment": node,
            }
        )
        return
    out["applied"].append(
        {"source": source, "contribution": {"type": contribution_type, "value": value}}
    )


def _translate_stat_modifier(
    node: dict[str, Any], source: BuffSource, opts: dict[str, Any], out: EffectTranslation
) -> None:
    modifier = node.get("modifier")
    if not _is_object(modifier):
        out["unsupported"].append(
            {"reason": "stat-modifier: missing modifier object", "effectFragment": node}
        )
        return
    narrowed = _unhonorable_narrowing(modifier)
    if narrowed:
        out["unsupported"].append(
            {
                "reason": (
                    f'stat-modifier: narrows by "{narrowed}" which the cruncher '
                    "can't resolve here"
                ),
                "effectFragment": node,
            }
        )
        return
    stat = modifier.get("stat")
    is_on_buffed_unit = _applies_to_buffed_unit(node, opts["perspective"])
    # `attack_type: melee|ranged` scopes the mod to that attack — express it
    # as a phase gate.
    applicability = _attack_type_applicability(modifier)

    def emit(contribution: dict[str, Any]) -> None:
        buff: Buff = {"source": source, "contribution": contribution}
        if applicability:
            buff = {**buff, "applicableWhen": applicability}
        out["applied"].append(buff)

    # AP has an inverted sign convention and offensive/defensive variants.
    if stat == "AP":
        _translate_ap_modifier(node, modifier, opts, out, emit)
        return

    value = _signed_value(modifier)
    if value is None:
        out["unsupported"].append(
            {
                "reason": (
                    f'stat-modifier: operation "{_js_str(modifier.get("operation"))}" '
                    "not supported"
                ),
                "effectFragment": node,
            }
        )
        return
    if stat == "A":
        if opts["perspective"] != "attacker" or not is_on_buffed_unit:
            return
        emit({"type": "attacks-mod", "value": value})
    elif stat == "S":
        if opts["perspective"] != "attacker" or not is_on_buffed_unit:
            return
        emit({"type": "strength-mod", "value": value})
    elif stat == "T":
        # Defender stat. Only relevant under target perspective.
        if opts["perspective"] != "target":
            out["unsupported"].append(
                {
                    "reason": (
                        "stat-modifier T: defender-side stat; applies when the "
                        "buffed unit is the target"
                    ),
                    "effectFragment": node,
                }
            )
            return
        if not is_on_buffed_unit:
            return
        emit({"type": "toughness-mod", "value": value})
    elif stat == "Sv":
        # A +1 to Sv means "improve the save by 1", which maps to a save-mod
        # of -value since save-mod is signed against the *needed roll*.
        if opts["perspective"] != "target":
            out["unsupported"].append(
                {
                    "reason": (
                        "stat-modifier Sv: defender-side stat; applies when the "
                        "buffed unit is the target"
                    ),
                    "effectFragment": node,
                }
            )
            return
        if not is_on_buffed_unit:
            return
        emit({"type": "save-mod", "value": -value})
    else:
        out["unsupported"].append(
            {
                "reason": f'stat-modifier on "{_js_str(stat)}" is outside the damage path',
                "effectFragment": node,
            }
        )


def _translate_ap_modifier(
    node: dict[str, Any],
    modifier: dict[str, Any],
    opts: dict[str, Any],
    out: EffectTranslation,
    emit: Any,
) -> None:
    """AP stat-modifier: offensive (self/unit target) → attacker-side
    ``ap-mod``; defensive (``target: "attacker"``) → unsupported."""
    if _classify_target(node) == "attacker":
        out["unsupported"].append(
            {
                "reason": (
                    "stat-modifier AP on the attacker: defender-side AP reduction "
                    "is not modelled by the buff layer"
                ),
                "effectFragment": node,
            }
        )
        return
    if opts["perspective"] != "attacker" or not _applies_to_buffed_unit(node, "attacker"):
        return
    delta = _ap_delta(modifier)
    if delta is None:
        out["unsupported"].append(
            {
                "reason": (
                    f'stat-modifier AP: operation "{_js_str(modifier.get("operation"))}" '
                    "not supported"
                ),
                "effectFragment": node,
            }
        )
        return
    emit({"type": "ap-mod", "value": delta})


def _translate_feel_no_pain(
    node: dict[str, Any], source: BuffSource, opts: dict[str, Any], out: EffectTranslation
) -> None:
    # FNP applies when the buffed unit is the *target*. Under attacker
    # perspective drop silently rather than as `unsupported`.
    if opts["perspective"] != "target":
        return
    modifier = node.get("modifier")
    if not _is_object(modifier):
        out["unsupported"].append(
            {"reason": "feel-no-pain: missing modifier object", "effectFragment": node}
        )
        return
    threshold = _js_number(modifier.get("threshold"))
    if not math.isfinite(threshold):
        out["unsupported"].append(
            {"reason": "feel-no-pain: threshold not numeric", "effectFragment": node}
        )
        return
    threshold = _intify(threshold)
    # `modifier.scope` ∈ {"all", "mortal"} (default "all"); anything else is
    # routed to unsupported so a typo can't masquerade as an all-FNP.
    raw_scope = modifier.get("scope")
    scope = "all"
    if raw_scope is not None:
        if raw_scope in ("all", "mortal"):
            scope = raw_scope
        else:
            out["unsupported"].append(
                {
                    "reason": (
                        f'feel-no-pain: unrecognised scope "{_js_str(raw_scope)}" '
                        '(expected "all" or "mortal")'
                    ),
                    "effectFragment": node,
                }
            )
            return
    contribution = (
        {"type": "feel-no-pain", "threshold": threshold, "scope": "mortal"}
        if scope == "mortal"
        else {"type": "feel-no-pain", "threshold": threshold}
    )
    out["applied"].append({"source": source, "contribution": contribution})


def _translate_keyword_grant(
    node: dict[str, Any], source: BuffSource, opts: dict[str, Any], out: EffectTranslation
) -> None:
    # Weapon-keyword grants ride with the attacker's profile.
    if opts["perspective"] != "attacker":
        return
    if not _applies_to_buffed_unit(node, "attacker"):
        return
    modifier = node.get("modifier")
    if not _is_object(modifier):
        return
    raws = _keyword_grant_list(modifier)
    if not raws:
        return
    applicability = _weapon_type_applicability(modifier)
    for raw in raws:
        ref = parse_keyword_grant(raw)
        if ref is None:
            out["unsupported"].append(
                {
                    "reason": f'keyword-grant: cannot parse "{raw}" to a catalog keyword',
                    "effectFragment": {"keyword": raw},
                }
            )
            continue
        buff: Buff = {
            "source": source,
            "contribution": {"type": "extra-keyword", "keywordRef": ref},
        }
        if applicability:
            buff = {**buff, "applicableWhen": applicability}
        out["applied"].append(buff)


def _keyword_grant_list(modifier: dict[str, Any]) -> list[str]:
    """Normalise a keyword-grant modifier's singular ``keyword`` and/or
    ``keywords`` array."""
    out: list[str] = []
    if isinstance(modifier.get("keyword"), str):
        out.append(modifier["keyword"])
    if isinstance(modifier.get("keywords"), list):
        out.extend(k for k in modifier["keywords"] if isinstance(k, str))
    return out


def _weapon_type_applicability(modifier: dict[str, Any]) -> dict[str, Any] | None:
    """Map a keyword-grant's ``weapon_type`` to the phase its weapons fire in."""
    if modifier.get("weapon_type") == "melee":
        return {"phases": ["fight"]}
    if modifier.get("weapon_type") == "ranged":
        return {"phases": ["shooting"]}
    return None


def _attack_type_applicability(modifier: dict[str, Any]) -> dict[str, Any] | None:
    """Map a stat-modifier's ``attack_type`` (or equivalent ``weapon_type``) to
    the phase that attack happens in."""
    kind = modifier.get("attack_type")
    if kind is None:
        kind = modifier.get("weapon_type")
    if kind == "melee":
        return {"phases": ["fight"]}
    if kind == "ranged":
        return {"phases": ["shooting"]}
    return None


#: Narrowing keys that scope a buff to a named weapon or a model subset the
#: cruncher can't resolve at translation time. Applying the buff unfiltered
#: would silently OVER-APPLY it, so it surfaces as unsupported instead.
_UNHONORABLE_NARROWING = (
    "weapon_name",
    "weapon_profile",
    "weapon_keyword",
    "weapon_filter",
    "model_filter",
    "model_scope",
)


def _unhonorable_narrowing(modifier: dict[str, Any]) -> str | None:
    for k in _UNHONORABLE_NARROWING:
        if modifier.get(k) is not None:
            return k
    return None


def _translate_damage_reduction(
    node: dict[str, Any], source: BuffSource, opts: dict[str, Any], out: EffectTranslation
) -> None:
    """Defender-side damage-reduction. Only the additive numeric form is
    modelled — ``"half"`` / ``"to-zero"`` are one-use ablation effects."""
    if opts["perspective"] != "target":
        return
    if not _applies_to_buffed_unit(node, "target"):
        return
    modifier = node.get("modifier")
    if not _is_object(modifier):
        out["unsupported"].append(
            {"reason": "damage-reduction: missing modifier object", "effectFragment": node}
        )
        return
    reduction = modifier.get("reduction")
    if (
        isinstance(reduction, (int, float))
        and not isinstance(reduction, bool)
        and math.isfinite(reduction)
        and reduction > 0
    ):
        out["applied"].append(
            {"source": source, "contribution": {"type": "damage-reduction", "value": reduction}}
        )
        return
    if reduction in ("half", "to-zero"):
        out["unsupported"].append(
            {
                "reason": (
                    f'damage-reduction: "{reduction}" is a one-use ablation effect, '
                    "not modelled by the expected-value engine"
                ),
                "effectFragment": node,
            }
        )
        return
    out["unsupported"].append(
        {
            "reason": f'damage-reduction: unrecognised reduction "{_js_str(reduction)}"',
            "effectFragment": node,
        }
    )


def _translate_invulnerable_save(
    node: dict[str, Any], source: BuffSource, opts: dict[str, Any], out: EffectTranslation
) -> None:
    """Defender-side ability-granted invulnerable save."""
    if opts["perspective"] != "target":
        return
    if not _applies_to_buffed_unit(node, "target"):
        return
    modifier = node.get("modifier")
    if not _is_object(modifier):
        out["unsupported"].append(
            {"reason": "invulnerable-save: missing modifier object", "effectFragment": node}
        )
        return
    threshold = _js_number(modifier.get("invuln_sv"))
    if not math.isfinite(threshold) or threshold < 2 or threshold > 7:
        out["unsupported"].append(
            {
                "reason": (
                    f'invulnerable-save: invuln_sv "{_js_str(modifier.get("invuln_sv"))}" '
                    "is not a valid save threshold (2–7)"
                ),
                "effectFragment": node,
            }
        )
        return
    out["applied"].append(
        {
            "source": source,
            "contribution": {"type": "invulnerable-save", "threshold": _intify(threshold)},
        }
    )


def _translate_bs_modifier(
    node: dict[str, Any], source: BuffSource, opts: dict[str, Any], out: EffectTranslation
) -> None:
    # A bs-modifier on `target: "attacker"` is a defender-side rule: it
    # penalises *incoming* hit rolls. Translate as a hit-mod under target
    # perspective so the resolver's ±1 cap composes with attacker-side mods.
    if opts["perspective"] != "target":
        return
    if _classify_target(node) != "attacker":
        return  # a bs-modifier on self wouldn't make sense.
    modifier = node.get("modifier")
    if not _is_object(modifier):
        return
    value = _signed_value(modifier)
    if value is None:
        return
    out["applied"].append({"source": source, "contribution": {"type": "hit-mod", "value": value}})


def _translate_conditional(
    node: dict[str, Any], source: BuffSource, opts: dict[str, Any], out: EffectTranslation
) -> None:
    condition = node.get("condition")
    effect = node.get("effect")
    if not _is_object(condition):
        return
    negated = condition.get("negated") is True
    verdict = _evaluate_condition(condition, opts["context"])
    if verdict == "unknown":
        # A timing the player controls isn't a wall — it's an activation the
        # player can opt into. Surface it as a lever rather than dropping it.
        if _condition_mentions_timing(condition):
            _enumerate_timing_gate(node, source, opts, out)
        else:
            out["unsupported"].append(
                {
                    "reason": (
                        "conditional: cannot evaluate condition "
                        f'"{_js_str(condition.get("type"))}" against current context'
                    ),
                    "effectFragment": node,
                }
            )
        return
    active = (not verdict) if negated else verdict
    if not active:
        return
    _walk(effect, source, opts, out)


# ---------------------------------------------------------------------------
# Activatable-lever enumeration
# ---------------------------------------------------------------------------


def _enumerate_choice(
    node: dict[str, Any], source: BuffSource, opts: dict[str, Any], out: EffectTranslation
) -> None:
    """Emit one lever per ``choice`` branch that yields a buff (pick one)."""
    options = node.get("options")
    if not isinstance(options, list):
        options = []
    for i, opt in enumerate(options):
        buffs: list[Buff] = []
        _collect_gated_buffs(opt, source, opts, {}, buffs)
        if not buffs:
            continue
        out["activatable"].append(
            {
                "id": f"{opts['abilityId']}?{i}",
                "label": _label_for_buffs(buffs),
                "buffs": buffs,
                "group": {"id": f"{opts['abilityId']}?choice", "maxActivations": 1},
            }
        )


def _enumerate_dice_pool(
    node: dict[str, Any], source: BuffSource, opts: dict[str, Any], out: EffectTranslation
) -> None:
    """Emit one lever per buff-bearing dice-pool option, capped by
    ``max_activations``."""
    options = node.get("options")
    if not isinstance(options, list):
        options = []
    max_activations = node.get("max_activations")
    if not isinstance(max_activations, (int, float)) or isinstance(max_activations, bool):
        max_activations = len(options)
    for opt in options:
        if not _is_object(opt):
            continue
        buffs: list[Buff] = []
        _collect_gated_buffs(opt.get("effect"), source, opts, {}, buffs)
        if not buffs:
            continue
        opt_name = opt.get("name")
        name = opt_name if isinstance(opt_name, str) and opt_name else _label_for_buffs(buffs)
        out["activatable"].append(
            {
                "id": f"{opts['abilityId']}#{name}",
                "label": name,
                "buffs": buffs,
                "group": {"id": opts["abilityId"], "maxActivations": max_activations},
            }
        )


def _enumerate_timing_gate(
    node: dict[str, Any], source: BuffSource, opts: dict[str, Any], out: EffectTranslation
) -> None:
    """Surface a timing-gated activation: inner decisions surface their own
    levers; inner always-on buffs bundle into a single timing lever."""
    condition = node.get("condition")
    if not _is_object(condition):
        return
    sub: EffectTranslation = {"applied": [], "unsupported": [], "activatable": []}
    _walk(node.get("effect"), source, opts, sub)
    # Inner independent decisions pass straight through as their own levers.
    out["activatable"].extend(sub["activatable"])
    # Inner unconditional buffs become one lever gated only on the timing.
    if sub["applied"]:
        timing = _extract_timing(condition) or "timing"
        out["activatable"].append(
            {
                "id": f"{opts['abilityId']}@{timing}",
                "label": _label_for_buffs(sub["applied"]),
                "buffs": sub["applied"],
            }
        )


def _collect_gated_buffs(
    node: Any,
    source: BuffSource,
    opts: dict[str, Any],
    applicability: dict[str, Any],
    out_buffs: list[Buff],
) -> None:
    """Walk the body of a player gate, collecting the buffs it would
    contribute. Conditions are deferred to ``applicableWhen`` where
    expressible; nested decisions and stochastic rolls are not modelled."""
    if not _is_object(node):
        return
    node_type = node.get("type")
    if node_type == "conditional":
        condition = node.get("condition")
        if not _is_object(condition):
            return
        app = _condition_to_applicability(condition)
        if app == "gate":
            # A nested timing gate: opting into the activation satisfies it.
            _collect_gated_buffs(node.get("effect"), source, opts, applicability, out_buffs)
            return
        if app == "context":
            # Can't express as a buff gate — only descend when the condition
            # is definitely active against the current context.
            if _evaluate_condition(condition, opts["context"]) is True:
                _collect_gated_buffs(node.get("effect"), source, opts, applicability, out_buffs)
            return
        _collect_gated_buffs(
            node.get("effect"), source, opts, _combine_applicability(applicability, app), out_buffs
        )
        return
    if node_type == "sequence":
        for step in node.get("steps") or []:
            _collect_gated_buffs(step, source, opts, applicability, out_buffs)
        return
    if node_type in ("choice", "dice-pool-allocation", "dice-gated"):
        # A decision (or stochastic roll) nested inside an activation. The
        # outer lever already stands for a player choice.
        return
    # Leaf effect — run the normal leaf translators into a throwaway sink,
    # then attach the accumulated applicability.
    tmp: EffectTranslation = {"applied": [], "unsupported": [], "activatable": []}
    _walk(node, source, opts, tmp)
    for b in tmp["applied"]:
        out_buffs.append(_apply_applicability(b, applicability))


def _condition_mentions_timing(condition: dict[str, Any]) -> bool:
    """Does this condition (or any operand) gate on a player-controlled timing?"""
    if condition.get("type") == "timing-is":
        return True
    if isinstance(condition.get("operator"), str) and isinstance(condition.get("operands"), list):
        return any(
            _is_object(o) and _condition_mentions_timing(o) for o in condition["operands"]
        )
    return False


def _extract_timing(condition: dict[str, Any]) -> str | None:
    """Pull the first ``timing-is`` timing value out of a (possibly compound)
    condition."""
    if condition.get("type") == "timing-is":
        t = (condition.get("parameters") or {}).get("timing")
        return t if isinstance(t, str) else None
    if isinstance(condition.get("operands"), list):
        for o in condition["operands"]:
            if _is_object(o):
                t = _extract_timing(o)
                if t:
                    return t
    return None


def _condition_to_applicability(condition: dict[str, Any]) -> Any:
    """Translate a condition into a buff applicability the resolver can gate
    on. Returns ``"gate"`` for a player-controlled timing, or ``"context"``
    when the condition has no declarative buff representation."""
    if condition.get("negated") is True:
        return "context"
    if isinstance(condition.get("operator"), str) and isinstance(condition.get("operands"), list):
        if condition["operator"] != "and":
            return "context"
        merged: dict[str, Any] = {}
        for operand in condition["operands"]:
            if not _is_object(operand):
                return "context"
            a = _condition_to_applicability(operand)
            if a == "gate":
                continue  # timing operand: satisfied by opting in.
            if a == "context":
                return "context"
            merged = _combine_applicability(merged, a)
        return merged
    params = condition.get("parameters")
    params = params if _is_object(params) else None
    ctype = condition.get("type")
    if ctype == "timing-is":
        return "gate"
    if ctype == "phase-is":
        phase = params.get("phase") if params else None
        return {"phases": [phase]} if isinstance(phase, str) else "context"
    if ctype == "target-has-keyword":
        kw = params.get("keyword") if params else None
        return {"requiresTargetKeyword": kw} if isinstance(kw, str) else "context"
    if ctype == "unit-has-keyword":
        kw = params.get("keyword") if params else None
        return {"requiresAttackerKeyword": kw} if isinstance(kw, str) else "context"
    if ctype == "attack-is-type":
        t = params.get("attack_type") if params else None
        if t == "melee":
            return {"phases": ["fight"]}
        if t == "ranged":
            return {"phases": ["shooting"]}
        return "context"
    return "context"


def _combine_applicability(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    """Merge two applicabilities; ``phases`` intersect, the rest narrow."""
    out = dict(a)
    if b.get("phases"):
        out["phases"] = (
            [p for p in a["phases"] if p in b["phases"]] if a.get("phases") else b["phases"]
        )
    if b.get("rollType"):
        out["rollType"] = b["rollType"]
    if b.get("requiresTargetKeyword"):
        out["requiresTargetKeyword"] = b["requiresTargetKeyword"]
    if b.get("requiresAttackerKeyword"):
        out["requiresAttackerKeyword"] = b["requiresAttackerKeyword"]
    return out


def _apply_applicability(buff: Buff, applicability: dict[str, Any]) -> Buff:
    """Attach an accumulated applicability to a buff (no-op when empty)."""
    if not applicability:
        return buff
    merged = (
        _combine_applicability(buff["applicableWhen"], applicability)
        if buff.get("applicableWhen")
        else applicability
    )
    return {**buff, "applicableWhen": merged}


def _label_for_buffs(buffs: list[Buff]) -> str:
    """A short, deduped human label summarising a lever's contributions."""
    seen: set[str] = set()
    parts: list[str] = []
    for b in buffs:
        p = _describe_contribution(b["contribution"])
        if p not in seen:
            seen.add(p)
            parts.append(p)
    return ", ".join(parts) or "buff"


def _describe_contribution(c: dict[str, Any]) -> str:
    ctype = c.get("type")
    if ctype == "extra-keyword":
        return _keyword_label(c["keywordRef"])
    if ctype == "hit-mod":
        return f"{_signed(c['value'])} to hit"
    if ctype == "wound-mod":
        return f"{_signed(c['value'])} to wound"
    if ctype == "save-mod":
        return f"{_signed(c['value'])} to save"
    if ctype == "damage-mod":
        return f"{_signed(c['value'])} damage"
    if ctype == "attacks-mod":
        return f"{_signed(c['value'])} attacks"
    if ctype == "strength-mod":
        return f"{_signed(c['value'])} strength"
    if ctype == "toughness-mod":
        return f"{_signed(c['value'])} toughness"
    if ctype == "ap-mod":
        return f"AP {_num_str(c['value'])}"
    if ctype == "reroll":
        ones = " 1s" if c.get("subset") == "ones" else ""
        return f"re-roll {c['roll']}{ones}"
    if ctype == "feel-no-pain":
        if c.get("scope") == "mortal":
            return f"feel no pain {_num_str(c['threshold'])}+ vs mortals"
        return f"feel no pain {_num_str(c['threshold'])}+"
    if ctype == "damage-reduction":
        return f"-{_num_str(c['value'])} damage"
    if ctype == "invulnerable-save":
        return f"{_num_str(c['threshold'])}+ invuln"
    return "cover"


def _signed(n: float) -> str:
    return f"+{_num_str(n)}" if n >= 0 else _num_str(n)


def _num_str(n: Any) -> str:
    if isinstance(n, float) and n.is_integer():
        return str(int(n))
    return str(n)


def _keyword_label(ref: dict[str, Any]) -> str:
    """Render a weapon-keyword ref back to its printed form (best-effort)."""
    params = ref.get("parameters") or {}
    if ref.get("keyword_id") == "anti" and isinstance(params.get("target_keyword"), str):
        th = params.get("threshold")
        is_num = isinstance(th, (int, float)) and not isinstance(th, bool)
        suffix = f" {_num_str(th)}+" if is_num else ""
        return f"Anti-{params['target_keyword']}{suffix}"
    base = " ".join(
        w[0].upper() + w[1:] if w else w for w in ref.get("keyword_id", "").split("-")
    )
    value = params.get("value")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f"{base} {_num_str(value)}"
    return base


# ---------------------------------------------------------------------------
# Condition evaluator
# ---------------------------------------------------------------------------


def _evaluate_condition(condition: dict[str, Any], ctx: EngineContext) -> Any:
    # Compound conditions use {operator, operands}; dispatch on shape.
    if isinstance(condition.get("operator"), str) and isinstance(condition.get("operands"), list):
        return _evaluate_compound(condition["operator"], condition["operands"], ctx)
    ctype = condition.get("type")
    params = condition.get("parameters") if _is_object(condition.get("parameters")) else None
    if ctype == "phase-is":
        wanted = params.get("phase") if params else None
        if not isinstance(wanted, str):
            return "unknown"
        return ctx.get("phase") == wanted
    if ctype == "timing-is":
        wanted = params.get("timing") if params else None
        if not isinstance(wanted, str):
            return "unknown"
        if ctx.get("timing") is None:
            return "unknown"
        return ctx["timing"] == wanted
    if ctype == "remained-stationary":
        return ctx.get("attackerStationary") is True
    if ctype == "charged-this-turn":
        if ctx.get("attackerCharged") is None:
            return "unknown"
        return ctx["attackerCharged"]
    if ctype == "target-has-keyword":
        kw = params.get("keyword") if params else None
        if not isinstance(kw, str):
            return "unknown"
        return kw.lower() in (ctx.get("targetKeywords") or [])
    if ctype == "unit-has-keyword":
        kw = params.get("keyword") if params else None
        if not isinstance(kw, str):
            return "unknown"
        return kw.lower() in (ctx.get("attackerKeywords") or [])
    if ctype in ("is-attached", "model-is-leader"):
        # "attachment present" is the signal both conditions gate on.
        if ctx.get("attackerAttached") is None:
            return "unknown"
        return ctx["attackerAttached"]
    return "unknown"


def _evaluate_compound(operator: str, operands: list[Any], ctx: EngineContext) -> Any:
    """Kleene three-valued evaluator for compound conditions. ``and``
    short-circuits to False on any false operand; ``or`` to True
    symmetrically; ``not`` flips its single operand. Unknown operands that
    don't get short-circuited propagate as ``"unknown"``."""
    if operator == "not":
        first = operands[0] if operands else None
        if not _is_object(first):
            return "unknown"
        v = _evaluate_condition(first, ctx)
        if v == "unknown":
            return "unknown"
        return not v
    if operator not in ("and", "or"):
        return "unknown"
    saw_unknown = False
    for operand in operands:
        if not _is_object(operand):
            saw_unknown = True
            continue
        v = _evaluate_condition(operand, ctx)
        if v == "unknown":
            saw_unknown = True
            continue
        if operator == "and" and v is False:
            return False
        if operator == "or" and v is True:
            return True
    if saw_unknown:
        return "unknown"
    return operator == "and"  # all true for AND, all false for OR


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _js_str(v: Any) -> str:
    """JS ``String(x)`` for the values that flow into reason strings."""
    if v is None:
        return "undefined"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _js_number(v: Any) -> float:
    """JS ``Number()`` semantics for the inputs that occur here.

    Note ``null`` → 0 in JS, but a missing key → NaN; dict.get can't tell
    them apart, so absent-or-null both map to NaN (the data never carries an
    explicit null in these positions)."""
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.strip()) if v.strip() else 0.0
        except ValueError:
            return math.nan
    return math.nan


def _intify(n: float) -> Any:
    """Collapse integral floats back to int so JSON round-trips match TS
    (JS has one number type; 5.0 serializes as 5)."""
    if isinstance(n, float) and n.is_integer():
        return int(n)
    return n


def _signed_value(modifier: dict[str, Any]) -> Any:
    """Read a signed numeric value out of a modifier ``{operation, value}``
    pair. "add"/"improve" keep the sign; "subtract"/"worsen" negate; anything
    else returns None (surfaced as unsupported)."""
    value = _js_number(modifier.get("value"))
    if not math.isfinite(value):
        return None
    operation = modifier.get("operation")
    if operation in ("add", "improve"):
        return _intify(value)
    if operation in ("subtract", "worsen"):
        return _intify(-value)
    # set / halve / multiply: not a single signed delta — left unsupported.
    return None


def _ap_delta(modifier: dict[str, Any]) -> Any:
    """Read the AP delta out of a stat-modifier. AP is stored negative (more
    negative = more piercing), so "improve" makes it more negative and
    "worsen" less; the legacy add/subtract forms pass the signed value
    through."""
    value = _js_number(modifier.get("value"))
    if not math.isfinite(value):
        return None
    operation = modifier.get("operation")
    if operation == "improve":
        return _intify(-abs(value))
    if operation == "worsen":
        return _intify(abs(value))
    if operation == "add":
        return _intify(value)
    if operation == "subtract":
        return _intify(-value)
    return None


def parse_keyword_grant(raw: str) -> dict[str, Any] | None:
    """Parse a printed weapon-keyword string (e.g. ``"Sustained Hits 1"``,
    ``"Anti-INFANTRY 4+"``, ``"Lethal Hits"``) into a
    ``{keyword_id, parameters?}`` catalog reference, or None if the form is
    unrecognised."""
    import re

    trimmed = raw.strip()
    if trimmed == "":
        return None

    # Anti-X N+ → { anti, target_keyword: X, threshold: N }
    anti_match = re.match(r"^anti-([A-Z][A-Z\s-]*)\s+(\d+)\+?$", trimmed, re.IGNORECASE)
    if anti_match:
        return {
            "keyword_id": "anti",
            "parameters": {
                "target_keyword": anti_match.group(1).strip(),
                "threshold": int(anti_match.group(2)),
            },
        }

    # "Lethal Hits", "Twin-linked", "Heavy" → kebab-case lookup, no params.
    # "Sustained Hits 1", "Rapid Fire 2", "Melta 2" → kebab-case + value.
    value_match = re.match(r"^(.+?)\s+(\d+)$", trimmed)
    if value_match:
        return {
            "keyword_id": _to_kebab_case(value_match.group(1)),
            "parameters": {"value": int(value_match.group(2))},
        }
    return {"keyword_id": _to_kebab_case(trimmed)}


def _to_kebab_case(s: str) -> str:
    import re

    return re.sub(r"[^a-z0-9-]", "", re.sub(r"[\s_]+", "-", s.lower()))
