"""The expected-value damage engine.

Closed-form math over schema profiles + a flat buff stack. No sampling, no
I/O. Auto-injects every weapon-keyword on the attacker's profile as a buff,
then resolves the stack via :func:`~wh40kdc.cruncher.buffs.resolve_buffs`,
then walks attacks → hits → wounds → unsaved → damage → after-fnp →
models-killed.

Python mirror of ``tools/src/cruncher/engine.ts``. The reduction order is a
conformance contract (CONFORMANCE.md: buffs apply left-to-right, stages
left-to-right; no reordering, parallelization, or memoization) — every
accumulation below deliberately mirrors the TS loop order.
"""

from __future__ import annotations

import math
import re
from typing import Any

from wh40kdc.cruncher.buffs import (
    Buff,
    EngineContext,
    ResolvedModifiers,
    resolve_buffs,
)
from wh40kdc.data.dataset import Dataset

EngineInput = dict[str, Any]
EngineOutput = dict[str, Any]

_DICE_RE = re.compile(r"^(\d*)D(\d+)([+-]\d+)?$", re.IGNORECASE)

_embedded_dataset: Dataset | None = None


def _lazy_embedded_dataset() -> Dataset:
    global _embedded_dataset
    if _embedded_dataset is None:
        _embedded_dataset = Dataset.embedded()
    return _embedded_dataset


def crunch(input: EngineInput, dataset: Dataset | None = None) -> EngineOutput:
    """Compute the expected per-stage projection for one
    (attacker, target, buffs) triple.

    ``input`` mirrors the TS ``EngineInput``::

        {"attacker": {"weapon": <Weapon>, "profileIndex": int},
         "target": {"unit": <Unit>, "profileIndex": int, "modelCount": int?},
         "modelsFiring": int, "buffs": [Buff], "context": {...}}

    Returns ``{"stages": [{"name", "expected", "detail"}], "resolved": ...}``.
    """
    ds = dataset if dataset is not None else _lazy_embedded_dataset()
    attacker = input["attacker"]
    target = input["target"]
    weapon = attacker["weapon"]
    profiles = weapon["profiles"]
    profile_index = attacker["profileIndex"]
    if not (0 <= profile_index < len(profiles)):
        raise IndexError(
            f"crunch: attacker.profileIndex={profile_index} is out of range for "
            f"weapon {weapon['id']}"
        )
    weapon_profile = profiles[profile_index]
    unit = target["unit"]
    target_profile_index = target["profileIndex"]
    if not (0 <= target_profile_index < len(unit["profiles"])):
        raise IndexError(
            f"crunch: target.profileIndex={target_profile_index} is out of range for "
            f"unit {unit['id']}"
        )
    unit_profile = unit["profiles"][target_profile_index]

    target_keywords = _unit_keywords_lower(unit)
    ctx: EngineContext = dict(input["context"])
    if ctx.get("targetKeywords") is None:
        ctx["targetKeywords"] = target_keywords

    # Auto-inject weapon-keyword buffs from the attacker profile, then append
    # the caller-supplied stack. resolve_buffs deduplicates and ranks them.
    profile_buffs = _profile_buffs_for(attacker, ds, ctx)
    resolved = resolve_buffs([*profile_buffs, *input.get("buffs", [])], ctx)

    stages: list[dict[str, Any]] = []

    # 1. Attacks
    # Melee/ranged is per-profile (11e weapons mix profiles), not weapon-level.
    is_melee = weapon_profile.get("range") == "Melee"
    stats = weapon_profile["stats"]
    base_a = eval_stat_value(stats.get("A"))
    attacks_per_model = base_a + resolved["attacksMod"]["value"]
    rapid_fire = _find_keyword(resolved, "rapid-fire")
    half_range = ctx.get("withinHalfRange") is True
    rapid_fire_extra = (
        eval_stat_value((rapid_fire.get("parameters") or {}).get("value"))
        if rapid_fire and half_range
        else 0
    )
    blast = _find_keyword(resolved, "blast")
    target_model_count = target.get("modelCount")
    if target_model_count is None:
        target_model_count = (unit.get("model_count") or {}).get("min")
    if target_model_count is None:
        target_model_count = 1
    blast_extra = math.floor(target_model_count / 5) if blast else 0
    attacks = input["modelsFiring"] * (attacks_per_model + rapid_fire_extra + blast_extra)
    stages.append(
        {
            "name": "attacks",
            "expected": attacks,
            "detail": _attacks_detail(
                input["modelsFiring"], attacks_per_model, rapid_fire_extra, blast_extra
            ),
        }
    )

    # 2. Hits
    # Cover (11e): the benefit of cover is -1 to the attacker's hit roll, not a
    # save bonus, and it only applies to ranged attacks (ignored by ignores-cover
    # and irrelevant to auto-hitting Torrent weapons, which take no hit roll).
    ignores_cover = _find_keyword(resolved, "ignores-cover") is not None
    covered = resolved["cover"]["active"] and not ignores_cover and not is_melee
    cover_hit_penalty = -1 if covered else 0
    hit_stat = stats.get("WS") if is_melee else stats.get("BS")
    torrent = _find_keyword(resolved, "torrent") is not None
    if torrent:
        hits = attacks
        crit_hits = 0.0
        hits_detail = f"Torrent: auto-hits ({attacks:.4f})"
    else:
        if not isinstance(hit_stat, (int, float)) or isinstance(hit_stat, bool):
            raise ValueError(
                f"crunch: weapon {weapon['id']} profile {profile_index} missing "
                f"{'WS' if is_melee else 'BS'}"
            )
        hit_modifier = resolved["hitMod"]["value"] + cover_hit_penalty
        probs = _check_probabilities(
            unmodified_needed=hit_stat,
            modifier=hit_modifier,
            reroll=(resolved["rerolls"].get("hit") or {}).get("subset", "none"),
            auto_fail_on_one=True,
            auto_pass_on_six=True,
            crit_threshold=6,
        )
        hits = attacks * probs[0]
        crit_hits = attacks * probs[1]
        reroll_label = (resolved["rerolls"].get("hit") or {}).get("subset", "none")
        cover_text = ", cover -1" if covered else ""
        hits_detail = (
            f"{'WS' if is_melee else 'BS'}{hit_stat}+ "
            f"(mod {_signed(resolved['hitMod']['value'])}{cover_text}, reroll {reroll_label}) → "
            f"P(hit)={probs[0]:.4f}, P(crit)={probs[1]:.4f}"
        )
    sustained = _find_keyword(resolved, "sustained-hits")
    if sustained:
        hits += crit_hits * eval_stat_value((sustained.get("parameters") or {}).get("value"))
        sustained_value = (sustained.get("parameters") or {}).get("value", 1)
        hits_detail += f"; +Sustained Hits {sustained_value} on {crit_hits:.4f} crits"
    stages.append({"name": "hits", "expected": hits, "detail": hits_detail})

    # 3. Wounds
    s_stat = eval_stat_value(stats.get("S")) + resolved["strengthMod"]["value"]
    t_stat = unit_profile["T"] + resolved["toughnessMod"]["value"]
    std_wound_needed = _wound_threshold(s_stat, t_stat)
    anti = _find_keyword(resolved, "anti")
    anti_threshold: float = 7  # unreachable
    if anti:
        params = anti.get("parameters") or {}
        target_kw = params.get("target_keyword")
        target_kw = target_kw.lower() if isinstance(target_kw, str) else None
        if target_kw and target_kw in target_keywords:
            threshold = _js_number(params.get("threshold"))
            if math.isfinite(threshold):
                anti_threshold = threshold
    crit_wound_threshold = min(6, anti_threshold)

    has_lethal = _find_keyword(resolved, "lethal-hits") is not None
    hits_for_wound_roll = hits - crit_hits if has_lethal else hits
    lethal_auto_wounds = crit_hits if has_lethal else 0.0

    wound_probs = _check_probabilities(
        unmodified_needed=std_wound_needed,
        modifier=resolved["woundMod"]["value"],
        reroll=(resolved["rerolls"].get("wound") or {}).get("subset", "none"),
        auto_fail_on_one=True,
        auto_pass_on_six=True,
        crit_threshold=crit_wound_threshold,
    )
    regular_wounds_from_roll = hits_for_wound_roll * (wound_probs[0] - wound_probs[1])
    crit_wounds_from_roll = hits_for_wound_roll * wound_probs[1]
    total_regular_wounds = regular_wounds_from_roll + lethal_auto_wounds
    has_devastating = _find_keyword(resolved, "devastating-wounds") is not None
    mortal_wounds_stream = crit_wounds_from_roll if has_devastating else 0.0
    regular_wounds_for_saves = (
        total_regular_wounds if has_devastating else total_regular_wounds + crit_wounds_from_roll
    )
    total_wounds = regular_wounds_for_saves + mortal_wounds_stream
    anti_text = f"{anti_threshold}+ (active)" if anti_threshold <= 6 else "n/a"
    lethal_text = f"+{lethal_auto_wounds:.4f}" if has_lethal else "—"
    dev_text = f"{mortal_wounds_stream:.4f} MW" if has_devastating else "—"
    stages.append(
        {
            "name": "wounds",
            "expected": total_wounds,
            "detail": (
                f"S{s_stat} vs T{t_stat} → need {std_wound_needed}+, anti {anti_text}, "
                f"P(wound)={wound_probs[0]:.4f} ({crit_wounds_from_roll:.4f} crit), "
                f"lethal {lethal_text}, devastating {dev_text}"
            ),
        }
    )

    # 4. Saves
    ap_mod = resolved["apMod"]["value"]
    ap = stats["AP"] + ap_mod
    save_mod = resolved["saveMod"]["value"]
    armor_target_raw = unit_profile["Sv"] - ap - save_mod
    # Cover is a hit penalty (11e), applied in the hits stage above — it no
    # longer touches the save here.
    armor_final = _clamp(armor_target_raw, 2, 7)
    # The unit's printed invuln (from the profile) and any ability-granted
    # invuln combine best-wins (lowest threshold). Invuln bypasses AP, so the
    # final save is min(armor-after-AP, invuln).
    # Attack-scoped invuln (issue #87): a ranged-/melee-only save applies only to
    # that attack type; fall back to the unconditional invuln_sv when unscoped.
    scoped_invuln = unit_profile.get("invuln_sv_melee" if is_melee else "invuln_sv_ranged")
    printed_invuln = scoped_invuln if scoped_invuln is not None else unit_profile.get("invuln_sv")
    invulnerable = resolved["invulnerable"]
    ability_invuln = invulnerable["threshold"] if invulnerable is not None else None
    if printed_invuln is not None and ability_invuln is not None:
        effective_invuln = min(printed_invuln, ability_invuln)
    elif printed_invuln is not None:
        effective_invuln = printed_invuln
    else:
        effective_invuln = ability_invuln
    effective_save_target = (
        min(armor_final, effective_invuln) if effective_invuln is not None else armor_final
    )

    save_probs = _check_probabilities(
        unmodified_needed=effective_save_target,
        modifier=0,
        reroll=(resolved["rerolls"].get("save") or {}).get("subset", "none"),
        auto_fail_on_one=True,
        auto_pass_on_six=False,
        crit_threshold=7,
    )
    p_saved = 0.0 if effective_save_target >= 7 else save_probs[0]
    unsaved = regular_wounds_for_saves * (1 - p_saved)
    detail_parts = [f"Sv{unit_profile['Sv']}+, AP{_signed(ap)}"]
    if ap_mod != 0:
        detail_parts.append(f" (apmod {_signed(ap_mod)})")
    if save_mod != 0:
        detail_parts.append(f", savemod {_signed(save_mod)}")
    if ability_invuln is not None:
        detail_parts.append(f", invuln {ability_invuln}+ (ability)")
    detail_parts.append(f" → effective {effective_save_target}+ (P(save)={p_saved:.4f})")
    stages.append({"name": "unsaved", "expected": unsaved, "detail": "".join(detail_parts)})

    # 5. Damage
    base_d = eval_stat_value(stats.get("D"))
    melta = _find_keyword(resolved, "melta")
    melta_bonus = (
        eval_stat_value((melta.get("parameters") or {}).get("value"))
        if melta and half_range
        else 0
    )
    before_reduction = max(0, base_d + melta_bonus + resolved["damageMod"]["value"])
    damage_reduction = resolved["damageReduction"]["value"]
    # 10e damage-reduction abilities always carry the canonical "to a minimum
    # of 1" clause, so the floor lives in the math, not the data. The clause
    # only applies when damage-reduction is active.
    damage_per_hit = (
        max(1, before_reduction - damage_reduction) if damage_reduction > 0 else before_reduction
    )
    damage_main = unsaved * damage_per_hit
    damage_mortal = mortal_wounds_stream * damage_per_hit
    damage = damage_main + damage_mortal
    damage_detail = f"D {base_d}"
    if melta_bonus:
        damage_detail += f" + Melta {melta_bonus} (half range)"
    if resolved["damageMod"]["value"] != 0:
        damage_detail += f" {_signed(resolved['damageMod']['value'])} (mod)"
    if damage_reduction > 0:
        damage_detail += f" -{damage_reduction} (defender, min 1)"
    damage_detail += (
        f" = {damage_per_hit} per hit; main {damage_main:.4f}, mortal {damage_mortal:.4f}"
    )
    stages.append({"name": "damage", "expected": damage, "detail": damage_detail})

    # 6. FNP — an all-FNP fires on every unsaved wound; a mortal-FNP only on
    # the mortal-wound stream. Both against mortals: independent Bernoulli
    # trials, so the surviving fractions multiply.
    p_survive_all = _fnp_survival_fraction(resolved["feelNoPain"])
    p_survive_mortal = _fnp_survival_fraction(resolved["feelNoPainMortal"])
    after_main = damage_main * p_survive_all
    after_mortal = damage_mortal * p_survive_all * p_survive_mortal
    after_fnp = after_main + after_mortal
    stages.append(
        {
            "name": "after-fnp",
            "expected": after_fnp,
            "detail": _describe_fnp(resolved["feelNoPain"], resolved["feelNoPainMortal"]),
        }
    )

    # 7. Models killed
    wounds_stat = unit_profile["W"]
    expected_models_killed = (
        min(target_model_count, after_fnp / wounds_stat) if wounds_stat > 0 else 0
    )
    per_model = after_fnp / wounds_stat if wounds_stat > 0 else 0.0
    stages.append(
        {
            "name": "models-killed",
            "expected": expected_models_killed,
            "detail": (
                f"W{wounds_stat} per model, {target_model_count} models in target; "
                f"{after_fnp:.4f} damage / {wounds_stat} = {per_model:.4f} "
                f"(capped at {target_model_count})"
            ),
        }
    )

    return {"stages": stages, "resolved": resolved}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _unit_keywords_lower(unit: dict[str, Any]) -> list[str]:
    """Lower-cased union of a unit's ``keywords`` + ``faction_keywords``."""
    out = [str(k).lower() for k in unit.get("keywords") or []]
    out.extend(str(k).lower() for k in unit.get("faction_keywords") or [])
    return out


def _profile_buffs_for(
    attacker: dict[str, Any], dataset: Dataset, ctx: EngineContext
) -> list[Buff]:
    # Resolve buffs from the attacker's OWN weapon object, never a re-lookup by
    # id: a bare weapon id shared across factions (close-combat-weapon, power-fist,
    # …) first-wins-resolves to whichever faction bundled first, so re-resolving
    # would feed the WRONG faction's profile/keywords into buff math (issue #59).
    # attacker["weapon"] is authoritative and carries its full profiles.
    return _manual_weapon_keyword_buffs(attacker, dataset, ctx)


def _manual_weapon_keyword_buffs(
    attacker: dict[str, Any], dataset: Dataset, ctx: EngineContext
) -> list[Buff]:
    profiles = attacker["weapon"]["profiles"]
    index = attacker["profileIndex"]
    if not (0 <= index < len(profiles)):
        return []
    out: list[Buff] = []
    for ref in profiles[index].get("keywords") or []:
        view = dataset.weapon_keywords.get(ref["keyword_id"])
        if view is None:
            continue
        out.extend(view.get_buffs(ref.get("parameters"), attacker["weapon"]["id"], ctx))
    return out


def _find_keyword(resolved: ResolvedModifiers, keyword_id: str) -> dict[str, Any] | None:
    for e in resolved["extraKeywords"]:
        if e["keywordRef"].get("keyword_id") == keyword_id:
            return e["keywordRef"]
    return None


def _wound_threshold(s: float, t: float) -> int:
    """Standard 10e S-vs-T table → unmodified wound threshold (2..6)."""
    if s >= 2 * t:
        return 2
    if s > t:
        return 3
    if s == t:
        return 4
    if s * 2 > t:
        return 5
    return 6


def _check_probabilities(
    *,
    unmodified_needed: float,
    modifier: float,
    reroll: str,
    auto_fail_on_one: bool,
    auto_pass_on_six: bool,
    crit_threshold: float,
) -> tuple[float, float]:
    """Probability a single die check passes (and the conditional crit rate).

    Returns ``(pass, crit)``. The face loops run 1→6 in order — the
    accumulation order mirrors the TS reference (left-to-right reduction is a
    conformance contract).
    """

    def outcome(face: int) -> tuple[int, int]:
        if auto_fail_on_one and face == 1:
            return (0, 0)
        if face >= crit_threshold:
            return (1, 1)
        if auto_pass_on_six and face == 6:
            return (1, 0)
        return (1, 0) if (face + modifier) >= unmodified_needed else (0, 0)

    pass_p = 0.0
    crit_p = 0.0
    for face in range(1, 7):
        initial = outcome(face)
        if initial[0] == 1:
            pass_p += 1 / 6
            crit_p += initial[1] / 6
            continue
        # Failed initial — eligible for reroll?
        eligible = reroll == "all-failures" or (reroll == "ones" and face == 1)
        if not eligible:
            continue
        # Reroll: uniform over 1..6.
        reroll_pass = 0.0
        reroll_crit = 0.0
        for f2 in range(1, 7):
            second = outcome(f2)
            reroll_pass += second[0] / 6
            reroll_crit += second[1] / 6
        pass_p += reroll_pass / 6
        crit_p += reroll_crit / 6
    return (pass_p, crit_p)


def _js_number(v: Any) -> float:
    """JS ``Number()`` semantics for the inputs that occur here."""
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if v is None:
        return math.nan
    if isinstance(v, str):
        try:
            return float(v.strip()) if v.strip() else 0.0
        except ValueError:
            return math.nan
    return math.nan


def eval_stat_value(v: Any) -> float:
    """Mean value of a stat (number or dice expression like ``"D6"``,
    ``"2D6"``, ``"D3+1"``, ``"D6-1"``). Unrecognised strings raise — better to
    crash than to silently return 0 and produce a confidently wrong damage
    projection."""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v
    if not isinstance(v, str):
        n = _js_number(v)
        return n if math.isfinite(n) and n else 0
    trimmed = v.strip()
    if trimmed == "":
        return 0
    try:
        as_number = float(trimmed)
        if math.isfinite(as_number):
            return as_number
    except ValueError:
        pass
    match = _DICE_RE.match(trimmed)
    if not match:
        raise ValueError(f'eval_stat_value: cannot parse "{v}"')
    count = 1 if match.group(1) == "" else int(match.group(1))
    die = int(match.group(2))
    offset = int(match.group(3)) if match.group(3) else 0
    return count * (die + 1) / 2 + offset


def _clamp(n: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, n))


def _signed(n: float) -> str:
    if n > 0:
        return f"+{_num_str(n)}"
    return _num_str(n)


def _num_str(n: float) -> str:
    """JS template-literal number rendering: integral floats lose the .0."""
    if isinstance(n, float) and n.is_integer():
        return str(int(n))
    return str(n)


def _fnp_survival_fraction(fnp: dict[str, Any] | None) -> float:
    """Fraction of damage that survives a single FNP roll (1 if no FNP)."""
    if not fnp:
        return 1.0
    p_succ = max(0.0, min(1.0, (7 - fnp["threshold"]) / 6))
    return 1 - p_succ


def _describe_fnp(all_fnp: dict[str, Any] | None, mortal_fnp: dict[str, Any] | None) -> str:
    if not all_fnp and not mortal_fnp:
        return "no FNP"
    parts = []
    if all_fnp:
        p_succ = (7 - all_fnp["threshold"]) / 6
        parts.append(f"FNP {all_fnp['threshold']}+ (P={p_succ:.4f})")
    if mortal_fnp:
        p_succ = (7 - mortal_fnp["threshold"]) / 6
        parts.append(f"FNP {mortal_fnp['threshold']}+ vs mortals (P={p_succ:.4f})")
    return ", ".join(parts)


def _attacks_detail(models: float, per: float, rapid_fire: float, blast: float) -> str:
    parts = [f"{_num_str(models)} × {_num_str(per)}"]
    if rapid_fire:
        parts.append(f"+ Rapid Fire {_num_str(rapid_fire)} (half range)")
    if blast:
        parts.append(f"+ Blast {_num_str(blast)}/model")
    return " ".join(parts)
