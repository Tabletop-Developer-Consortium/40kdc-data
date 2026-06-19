"""Humanize an Ability-DSL ``effect`` tree into natural English — the
``ability.print()`` of the dataset.

Output is an *approximation* generated purely from the structured data (no
external rules text): subject-first, GW-datasheet voice, with scope range +
duration woven into the sentence and single-leaf conditionals inlined.
ASCII-only; pinned byte-for-byte across the TS, Rust, and Python ports by the
``conformance/effect-translation`` corpus.

Python mirror of ``tools/src/translate/effect.ts``.
"""

from __future__ import annotations

import re
from typing import Any

from wh40kdc.translate.condition import Condition, dekebab, describe_condition, describe_timing

Effect = dict[str, Any]
Ctx = dict[str, Any]

_CONTAINER_TYPES = {"sequence", "choice", "dice-gated", "dice-pool-allocation", "select-units"}


def _select_units_subject(sel: Any) -> str:
    """``up to 3 friendly Orks Vehicle units`` — the ``select-units`` selector phrase."""
    sel = sel or {}
    kw = " ".join(_title_case(_jstr(k)) for k in (sel.get("keywords") or []))
    owner = _jstr(sel.get("owner"))
    noun = "unit" if sel.get("max_count") == 1 else "units"
    kw = f" {kw}" if kw else ""
    return f"up to {_jstr(sel.get('max_count'))} {owner}{kw} {noun}"


def _jstr(v: Any) -> str:
    """JS-template stringification (numbers print without trailing ``.0``)."""
    if v is None:
        return "?"
    if isinstance(v, list):
        return ", ".join(_jstr(x) for x in v)
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _capitalize(s: str) -> str:
    return s if s == "" else s[0].upper() + s[1:]


_TITLE_SMALL = {"of", "or", "and", "the", "a", "an", "to", "in", "on", "for", "with"}


def _title_case(s: str) -> str:
    words = dekebab(s).split(" ")
    out = []
    for i, w in enumerate(words):
        if w == "":
            out.append(w)
        elif i > 0 and w.lower() in _TITLE_SMALL:
            out.append(w.lower())
        else:
            out.append(w[0].upper() + w[1:])
    return " ".join(out)


# Curated display labels for granted-ability ids whose Title-Cased slug reads
# wrong. The slug encodes the mechanic (charge-after-advance); the label is the
# published name players know (Advance & Charge). Mirror of ABILITY_GRANT_LABELS
# in tools/src/translate/effect.ts; applied only by the ability-grant describer.
_ABILITY_GRANT_LABELS = {
    "charge-after-advance": "Advance & Charge",
    "charge-after-fallback": "Fall Back & Charge",
    "charge-after-disembark": "Charge After Disembarking",
}


def _grant_label(id: str) -> str:
    """The display label for a granted ability id: a curated override, else Title Case."""
    return _ABILITY_GRANT_LABELS.get(id) or _title_case(id)


def _bracket_keyword(k: Any) -> str:
    return f"[{dekebab(_jstr(k)).upper()}]"


def _dice_case(v: Any) -> str:
    return re.sub(r"[dD]", "D", _jstr(v))


_TEST_NAMES = {"battle-shock": "Battle-shock", "desperate-escape": "Desperate Escape"}


def _test_name(test: Any) -> str:
    t = _jstr(test)
    return _TEST_NAMES.get(t, _title_case(t))


_STAT_NAMES = {
    "M": "Move",
    "T": "Toughness",
    "Sv": "Save",
    "W": "Wounds",
    "A": "Attacks",
    "Ld": "Leadership",
    "OC": "Objective Control",
    "S": "Strength",
    "WS": "Weapon Skill",
    "BS": "Ballistic Skill",
    "AP": "Armour Penetration",
    "D": "Damage",
    "Range": "Range",
}


def _stat_name(stat: Any) -> str:
    s = _jstr(stat)
    return _STAT_NAMES.get(s, _title_case(s))


def _pool_name(pool: Any) -> str:
    p = _jstr(pool)
    return "CP" if p.lower() == "cp" else _title_case(p)


_ROLL_NAMES = {
    "hit": "Hit",
    "wound": "Wound",
    "charge": "Charge",
    "damage": "Damage",
    "advance": "Advance",
    "save": "Saving throw",
    "leadership": "Leadership",
}


def _roll_name(roll: Any) -> str:
    r = _jstr(roll)
    return _ROLL_NAMES.get(r, _title_case(r))


def _is_plural(subj: str) -> bool:
    return bool(
        re.search(r" units\b", subj)
        or re.match(r"^all ", subj)
        or re.match(r"^(enemy|friendly) units", subj)
    )


_PLURAL_VERBS = {
    "has": "have",
    "is": "are",
    "gets": "get",
    "gains": "gain",
    "suffers": "suffer",
    "retains": "retain",
    "makes": "make",
}


def _v(subj: str, singular: str) -> str:
    if not _is_plural(subj):
        return singular
    return _PLURAL_VERBS.get(singular, re.sub(r"s$", "", singular))


def _pronoun(subj: str) -> str:
    return "their" if _is_plural(subj) else "its"


def _subject(target: str | None, ctx: Ctx) -> str:
    ri = ctx.get("range_inches")
    within = f' within {_jstr(ri)}"' if ri is not None else " nearby"
    if target in ("self", "bearer"):
        return "this model"
    if target == "unit":
        return "the unit"
    if target == "attached-unit":
        return "the unit this model leads"
    if target == "target":
        return "the target"
    if target == "attacker":
        return "the attacking unit"
    if target == "defender":
        return "your unit"
    if target == "all-friendly":
        return "all friendly units"
    if target == "all-enemy":
        return "all enemy units"
    if target == "friendly-within-aura":
        return f"friendly units{within}"
    if target == "enemy-within-aura":
        return f"enemy units{within}"
    return "the unit"


def _possessive(s: str) -> str:
    return f"{s}'" if s.endswith("s") else f"{s}'s"


def _signed(operation: Any, value: Any) -> str:
    positive = operation in ("add", "improve")
    sign = 1 if positive else -1
    try:
        n = float(value)
        if n < 0:
            sign = -sign
            value = int(abs(n)) if float(abs(n)).is_integer() else abs(n)
    except (TypeError, ValueError):
        pass
    return f"{'+' if sign > 0 else '-'}{_jstr(value)}"


def _pool_threshold(comp: str, threshold: Any) -> str:
    """Dice-pool success phrase ("4+", "6", "3 or less") — no leading "a", as it
    follows "for each" in a mortal-wounds pool."""
    th = _jstr(threshold)
    if comp == "lte":
        return f"{th} or less"
    if comp == "gt":
        return f"more than {th}"
    if comp == "lt":
        return f"less than {th}"
    if comp == "eq":
        return th
    return f"{th}+"


def _format_comparison(comp: str, threshold: Any) -> str:
    th = _jstr(threshold)
    if comp == "gte":
        return f"a {th}+"
    if comp == "lte":
        return f"a {th} or less"
    if comp == "gt":
        return f"greater than {th}"
    if comp == "lt":
        return f"less than {th}"
    if comp == "eq":
        return f"exactly {th}"
    return f"a {th}+"


def _duration_clauses(duration: str | None) -> tuple[str, str]:
    """Return (lead, trail) clauses for a duration. permanent adds nothing."""
    if duration == "phase":
        return ("", "until the end of the phase")
    if duration == "turn":
        return ("", "until the end of the turn")
    if duration == "battle":
        return ("", "for the rest of the battle")
    if duration == "battle-round":
        return ("", "until the end of the battle round")
    if duration == "until-next-command-phase":
        return ("", "until your next Command phase")
    if duration == "one-use":
        return ("once per battle", "")
    return ("", "")


def _condition_lead_in(c: Condition) -> str:
    operands = c.get("operands")
    if c.get("operator") == "and" and operands:
        return ", ".join(_condition_lead_in(o) for o in operands)
    if c.get("operator") == "or" and operands:
        return " or ".join(_condition_lead_in(o) for o in operands)
    if c.get("operator") == "not" and operands:
        return "unless " + " or ".join(
            re.sub(r"^if ", "", _condition_lead_in(o)) for o in operands
        )
    if c.get("negated"):
        return f"if {describe_condition(c)}"

    p = c.get("parameters") or {}
    ctype = c.get("type")
    if ctype == "phase-is":
        return f"during the {_title_case(_jstr(p.get('phase')))} phase"
    if ctype == "is-attached":
        kw = f"{_jstr(p.get('keyword'))} " if p.get("keyword") else ""
        return f"after being attached to a {kw}unit"
    if ctype == "timing-is":
        return describe_timing(p.get("timing"))
    if ctype == "player-turn-is":
        turn = p.get("turn")
        if turn == "your-turn":
            return "in your turn"
        if turn == "opponent-turn":
            return "in the opponent's turn"
        return "in either player's turn"
    if ctype == "model-is-leader":
        return "while this model leads a unit"
    if ctype == "charged-this-turn":
        return "if the unit charged this turn"
    if ctype == "advanced-this-turn":
        return "if the unit Advanced this turn"
    if ctype == "disembarked-from-transport":
        return "if the unit disembarked from a Transport this turn"
    if ctype == "faction-rule-active":
        return f"while the {_title_case(_jstr(p.get('rule')))} is active"
    if ctype == "battle-round":
        return f"during the first {_jstr(p.get('max'))} battle rounds"
    if ctype == "remained-stationary":
        return "if the unit Remained Stationary"
    if ctype == "target-has-keyword":
        return f"against {_jstr(p.get('keyword'))} targets"
    if ctype == "unit-has-keyword":
        return f"if the unit has the {_jstr(p.get('keyword'))} keyword"
    if ctype == "is-battle-shocked":
        return "while the unit is Battle-shocked"
    if ctype == "unit-below-half-strength":
        return "while the unit is below half strength"
    if ctype == "unit-below-starting-strength":
        return "while the unit is below its starting strength"
    if ctype == "has-lost-wounds":
        return "while the model has lost wounds"
    if ctype == "attack-is-type":
        if p.get("comparison") == "strength-greater-than-toughness":
            return "when this attack's Strength is greater than the target's Toughness"
        if p.get("comparison") is not None:
            return f"when {dekebab(_jstr(p.get('comparison')))}"
        return f"with {_jstr(p.get('attack_type'))} attacks"
    if ctype == "destroyed-by-attack-type":
        return f"when destroyed by a {_jstr(p.get('attack_type'))} attack"
    if ctype == "opponent-unit-within-range":
        if p.get("weapon_name") is not None:
            where = f"range of {dekebab(_jstr(p.get('weapon_name')))}"
        elif p.get("range_multiplier") is not None:
            where = "half range of its ranged weapons"
        elif p.get("range") == "engagement":
            where = "engagement range"
        else:
            where = f'{_jstr(p.get("range"))}"'
        return f"while an enemy unit is within {where}"
    if ctype == "engagement-state":
        state = p.get("state")
        if state is None:
            return "while the unit is within Engagement Range"
        st = _jstr(state)
        if st == "on-battlefield":
            return "while the unit is on the battlefield"
        if st == "embarked":
            return "while the unit is embarked"
        if st in ("engaged", "within-engagement-range", "in-engagement-range"):
            return "while the unit is within Engagement Range"
        return f"while the unit is {dekebab(st)}"
    if ctype == "disposition-matches":
        d = _jstr(p.get("disposition"))
        if d == "strategic-reserves":
            return "while the unit is in Strategic Reserves"
        return f"while the unit's disposition is {dekebab(d)}"
    if ctype == "fights-first":
        return "while the unit has the Fights First ability"
    return f"if {describe_condition(c)}"


def _describe_attack_restriction(m: dict[str, Any], subj: str) -> str:
    """Per-slug GW-prose for ``attack-restriction`` (reads ``restriction`` or
    ``restriction_type``)."""
    if (
        m.get("restriction") is None
        and m.get("restriction_type") is None
        and m.get("attack_type") is not None
    ):
        return f"{subj} cannot {_jstr(m.get('attack_type'))}"
    raw = m.get("restriction")
    if raw is None:
        raw = m.get("restriction_type")
    slug = _jstr(raw)
    rng = _jstr(m.get("range")) if m.get("range") is not None else None
    if slug == "worsen-incoming-ap":
        amount = _jstr(m.get("value")) if m.get("value") is not None else "1"
        return (
            f"each time an attack targets {subj}, "
            f"worsen the Armour Penetration of that attack by {amount}"
        )
    if slug == "cannot-be-targeted-unless-closest-or-within-12":
        return f'{subj} can only be targeted if it is the closest eligible target or within 12"'
    if slug == "targeting-range-limit":
        return f'{subj} can only target enemy units within {rng or "?"}"'
    if slug == "reinforcement-denial":
        return f'enemy units cannot be set up from Reserves within {rng or "?"}" of {subj}'
    if slug == "must-be-warlord":
        return "this model must be your Warlord"
    if slug == "cannot-be-warlord":
        return "this model cannot be your Warlord"
    if slug == "unique-unit-limit":
        return "you can include only one of this unit in your army"
    if slug == "no-charge":
        return f"{subj} cannot charge"
    rng_clause = f' (within {rng}")' if rng is not None else ""
    return f"{subj}: {dekebab(slug)}{rng_clause}"


# Humanized noun for a scaling `of` dimension (`enemy-models-in-range` -> `enemy models`).
_SCALE_OF = {
    "enemy-models-in-range": "enemy models",
    "friendly-models-in-range": "friendly models",
    "models-in-bearer-unit": "models in this unit",
    "enemy-units-in-range": "enemy units",
    "wounds-lost": "wounds lost",
}


def _scaling_clause(s: dict[str, Any]) -> str:
    """A ``scaling`` block -> trailing clause ("for every 5 enemy models within 6\"")."""
    of = _jstr(s.get("of"))
    of_text = _SCALE_OF.get(of, dekebab(of))
    c = f"for every {_jstr(s.get('per'))} {of_text}"
    if s.get("within_inches") is not None:
        c += f' within {_jstr(s.get("within_inches"))}"'
    if s.get("round") == "up":
        c += " (rounding up)"
    if s.get("max_value") is not None:
        c += f" (to a maximum of {_jstr(s.get('max_value'))})"
    return c


def describe_effect_inline(e: Effect, ctx: Ctx | None = None) -> str:
    """Single-clause translation for leaf effects (lowercase-initial, no period),
    with any ``scaling`` block woven on as a trailing "for every ..." clause."""
    base = _describe_effect_inline_base(e, ctx)
    scaling = e.get("scaling")
    return f"{base} {_scaling_clause(scaling)}" if scaling else base


def _describe_effect_inline_base(e: Effect, ctx: Ctx | None = None) -> str:
    """The leaf/container switch; :func:`describe_effect_inline` wraps it to append scaling."""
    ctx = ctx or {}
    m = e.get("modifier") or {}
    subj = _subject(e.get("target"), ctx)
    etype = e.get("type")

    if etype == "stat-modifier":
        scope = f" ({_jstr(m['attack_type'])})" if m.get("attack_type") else ""
        if m.get("stat") is None:
            return f"modify {_possessive(subj)} characteristics{scope}"
        if m.get("operation") == "set":
            stat = _stat_name(m["stat"])
            set_val = _jstr(m.get("value"))
            return f"modify {_possessive(subj)} {stat} characteristic to {set_val}{scope}"
        val = m.get("value")
        verb = "subtract" if m.get("operation") in ("subtract", "worsen") else "add"
        # `val is not None` guard replaces relying on float(None) raising
        # TypeError — same outcome (verb/val untouched), but typed.
        if val is not None:
            try:
                n = float(val)
                if n < 0:
                    verb = "subtract" if verb == "add" else "add"
                    val = int(abs(n)) if float(abs(n)).is_integer() else abs(n)
            except (TypeError, ValueError):
                pass
        prep = "to" if verb == "add" else "from"
        stat = _stat_name(m["stat"])
        return f"{verb} {_jstr(val)} {prep} {_possessive(subj)} {stat} characteristic{scope}"
    if etype == "roll-modifier":
        ctx_note = f" ({_jstr(m['context'])})" if m.get("context") else ""
        roll = _roll_name(m.get("roll"))
        if m.get("critical_on") is not None:
            crit = "Critical Wounds" if m.get("roll") == "wound" else "Critical Hits"
            crit_on = _jstr(m["critical_on"])
            return f"{subj} {_v(subj, 'scores')} {crit} on {roll} rolls of {crit_on}+"
        if m.get("operation") == "set":
            return f"{subj} can change {roll} rolls to a {_jstr(m.get('value'))}"
        if m.get("value") is None:
            op = dekebab(_jstr(m.get("operation")))
            return f"{op} {_possessive(subj)} {roll} rolls{ctx_note}"
        sgn = _signed(m.get("operation"), m["value"])
        return f"{subj} {_v(subj, 'gets')} {sgn} to {roll} rolls{ctx_note}"
    if etype == "re-roll":
        noun = _roll_name(m.get("roll"))
        which = f"a {noun} roll of 1" if m.get("subset") == "ones" else f"the {noun} roll"
        return f"you can re-roll {which}"
    if etype == "mortal-wounds":
        range_ = m.get("range")
        if range_ is None:
            range_ = m.get("range_inches")
        if range_ is None:
            range_ = ctx.get("range_inches")
        if e.get("target") == "enemy-within-aura" and range_ is not None:
            subj_mw = f'each enemy unit within {_jstr(range_)}"'
        else:
            subj_mw = subj
        verb = "suffers" if subj_mw.startswith("each ") else _v(subj_mw, "suffers")
        # Dice-pool form: N dice rolled, each success worth `mortal_per_success`
        # mortal wounds (distinct from a flat count).
        if m.get("mortal_per_success") is not None:
            per = _jstr(m.get("mortal_per_success"))
            per_noun = "mortal wound" if per == "1" else "mortal wounds"
            hit = _pool_threshold(_jstr(m.get("comparison") or "gte"), m.get("threshold"))
            die = _dice_case(m.get("dice"))
            # Per-model pool: one die per model in this/the target unit.
            if m.get("per_model") is not None:
                where = "the target unit" if m.get("per_model") == "target" else "this unit"
                return (
                    f"roll one {die} for each model in {where}: "
                    f"for each {hit}, {subj_mw} {verb} {per} {per_noun}"
                )
            return f"roll {die}: for each {hit}, {subj_mw} {verb} {per} {per_noun}"
        if m.get("count") is not None:
            a: str | None = _jstr(m.get("count"))
        elif m.get("amount") is not None:
            a = _jstr(m.get("amount"))
        elif m.get("dice") is not None:
            a = _dice_case(m.get("dice"))
        elif m.get("table") or m.get("amount_table"):
            a = "a number of"
        else:
            a = None
        if a is None and m.get("trigger") is not None:
            trig = _title_case(_jstr(m.get("trigger")))
            return f"when this model is destroyed, {subj_mw} {verb} mortal wounds ({trig})"
        amt = a if a is not None else "?"
        noun = "mortal wound" if amt == "1" else "mortal wounds"
        return f"{subj_mw} {verb} {amt} {noun}"
    if etype == "feel-no-pain":
        vs = " against mortal wounds" if m.get("scope") == "mortal" else ""
        return f"{subj} {_v(subj, 'has')} the Feel No Pain {_jstr(m.get('threshold'))}+ ability{vs}"
    if etype == "ward":
        threshold = m.get("threshold")
        if threshold is None:
            threshold = m.get("value")
        return f"{subj} {_v(subj, 'has')} the Ward {_jstr(threshold)}+ ability"
    if etype == "invulnerable-save":
        sv = m.get("invuln_sv")
        if sv is None:
            sv = m.get("value")
        if sv is None:
            sv = m.get("threshold")
        return f"{subj} {_v(subj, 'has')} a {_jstr(sv)}+ invulnerable save"
    if etype == "keyword-grant":
        if isinstance(m.get("keywords"), list):
            kw = " and ".join(_bracket_keyword(k) for k in m["keywords"])
        else:
            kw = _bracket_keyword(m.get("keyword") if m.get("keyword") is not None else "keywords")
        if m.get("weapon_name") is not None:
            return f"{_possessive(subj)} {_jstr(m['weapon_name'])} gains {kw}"
        if m.get("weapon_type") is not None:
            return f"{_possessive(subj)} {_jstr(m['weapon_type'])} weapons gain {kw}"
        return f"{_possessive(subj)} weapons gain {kw}"
    if etype == "ability-grant":
        grant = m.get("grant_type")
        if grant is None:
            grant = m.get("ability_id")
        cap = f" ({_jstr(m['capacity'])})" if m.get("capacity") is not None else ""
        if grant is not None:
            return f"{subj} {_v(subj, 'gains')} the {_grant_label(_jstr(grant))} ability{cap}"
        return f"{subj} {_v(subj, 'gains')} an ability{cap}"
    if etype == "movement-modifier":
        kind = m.get("move_type")
        if kind is None:
            kind = m.get("type")
        if _jstr(kind) == "move-through":
            return f"{subj} can move through enemy models and terrain"
        if _jstr(kind) == "scouts":
            dist = m.get("distance")
            if dist is None:
                dist = m.get("value")
            inches = f' {_jstr(dist)}"' if dist is not None and _jstr(dist) != "0" else ""
            lc_subj = subj[0].lower() + subj[1:] if subj else subj
            return f"Before the first battle round, {lc_subj} can Scout{inches}"
        dist = m.get("distance")
        if dist is None:
            dist = m.get("value")
        inches = f' {_jstr(dist)}"' if dist is not None and _jstr(dist) != "0" else ""
        if kind is not None:
            return f"{subj} {_v(subj, 'has')} the {_title_case(_jstr(kind))}{inches} ability"
        return f"{subj} {_v(subj, 'gains')} a movement ability"
    if etype == "damage-reduction":
        r = _jstr(m.get("reduction") if m.get("reduction") is not None
                  else m.get("amount") if m.get("amount") is not None else m.get("value"))
        if r == "half":
            how = "halve the Damage of that attack"
        elif r == "to-zero":
            how = "reduce the Damage of that attack to 0"
        else:
            how = f"reduce the Damage of that attack by {r}"
        return f"each time an attack targets {subj}, {how}"
    if etype == "resurrection":
        count = _dice_case(m.get("count")) if m.get("count") is not None else "1"
        noun = "destroyed model" if count == "1" else "destroyed models"
        wounds = m.get("wounds_remaining")
        w = _jstr(wounds if wounds is not None else "full")
        return f"return {count} {noun} to {subj} with {w} wounds"
    if etype == "model-destruction":
        count = _dice_case(m.get("count")) if m.get("count") is not None else "1"
        noun = "model" if count == "1" else "models"
        return f"destroy {count} {noun} in {subj}"
    if etype == "cp-gain":
        return f"you gain {_jstr(m.get('amount') if m.get('amount') is not None else 1)}CP"
    if etype == "cp-refund":
        if m.get("stratagem") is not None:
            strat = f"the {_title_case(_jstr(m.get('stratagem')))} Stratagem"
        else:
            strat = "one Stratagem"
        return f"you can use {strat} on {subj} for 0CP"
    if etype == "resource-gain":
        amount = m.get("amount") if m.get("amount") is not None else m.get("value")
        pool = m.get("pool_id") if m.get("pool_id") is not None else m.get("resource")
        return f"you gain {_jstr(amount)} {_pool_name(pool)}"
    if etype == "resource-spend":
        amount = m.get("amount") if m.get("amount") is not None else m.get("value")
        pool = m.get("pool_id") if m.get("pool_id") is not None else m.get("resource")
        return f"spend {_jstr(amount)} {_pool_name(pool)}"
    if etype == "leadership-modifier":
        test = f"{_test_name(m.get('test'))} test" if m.get("test") is not None else None
        if test is not None and m.get("operation") is None:
            return f"{subj} must take a {test}"
        if test is not None and m.get("operation") == "re-roll":
            return f"{subj} can re-roll {_test_name(m.get('test'))} tests"
        if test is not None and m.get("value") is not None:
            verb = "add" if m.get("operation") == "add" else "subtract"
            prep = "to" if m.get("operation") == "add" else "from"
            tn = _test_name(m.get("test"))
            return f"{verb} {_jstr(m['value'])} {prep} the {tn} test of {subj}"
        if m.get("operation") is not None and m.get("value") is not None:
            positive = m.get("operation") in ("add", "improve")
            verb = "add" if positive else "subtract"
            prep = "to" if positive else "from"
            return f"{verb} {_jstr(m['value'])} {prep} the Leadership characteristic of {subj}"
        return f"modify {_possessive(subj)} Leadership characteristic"
    if etype == "fight-first":
        return f"{subj} {_v(subj, 'has')} the Fights First ability"
    if etype == "fight-last":
        return f"{subj} {_v(subj, 'has')} the Fights Last ability"
    if etype == "fight-on-death":
        if subj == "this model":
            return "each time this model is destroyed, it can fight before being removed from play"
        return (
            f"each time a model in {subj} is destroyed, "
            "it can fight before being removed from play"
        )
    if etype == "shoot-on-death":
        if subj == "this model":
            return "each time this model is destroyed, it can shoot before being removed from play"
        return (
            f"each time a model in {subj} is destroyed, "
            "it can shoot before being removed from play"
        )
    if etype == "unit-keyword":
        name = _title_case(_jstr(m.get("keyword_id")))
        val = f" {_jstr(m.get('value'))}" if m.get("value") is not None else ""
        return f"{subj} {_v(subj, 'has')} the {name}{val} ability"
    if etype == "unit-keyword-grant":
        return f"{_jstr(m.get('to_keywords'))} units gain the {_jstr(m.get('keyword'))} keyword"
    if etype == "deep-strike":
        return f"{subj} {_v(subj, 'has')} the Deep Strike ability"
    if etype == "strategic-reserves-arrival":
        return f"{subj} can arrive from Strategic Reserves regardless of mission rules"
    if etype == "remove-battle-shock":
        return f"{subj} {_v(subj, 'is')} no longer Battle-shocked"
    if etype == "fallback-and-act":
        return (
            f"{subj} {_v(subj, 'is')} eligible to shoot and declare a charge "
            "in a turn in which it Fell Back"
        )
    if etype == "engagement-passthrough":
        return f"{subj} can move through enemy models"
    if etype == "attack-restriction":
        return _describe_attack_restriction(m, subj)
    if etype == "objective-control-modifier":
        if m.get("sticky"):
            return (
                f"{subj} {_v(subj, 'retains')} control of objective markers "
                "even after no models remain in range, "
                "until the enemy retakes them (sticky objectives)"
            )
        if m.get("operation") == "halve":
            return f"halve the Objective Control characteristic of {subj}"
        if m.get("operation") is not None:
            sgn = _signed(m["operation"], m.get("value"))
            pron = _pronoun(subj)
            return f"{subj} {_v(subj, 'gets')} {sgn} to {pron} Objective Control characteristic"
        return f"modify {_possessive(subj)} Objective Control characteristic"
    if etype == "bs-modifier":
        sgn = _signed(m.get("operation"), m.get("value"))
        return f"{subj} {_v(subj, 'gets')} {sgn} to Ballistic Skill"
    if etype == "charge-roll-modifier":
        sgn = _signed(m.get("operation"), m.get("value"))
        return f"{subj} {_v(subj, 'gets')} {sgn} to Charge rolls"
    if etype == "terrain-area-tag":
        return f"the terrain area is marked as {dekebab(_jstr(m.get('tag')))}"
    if etype == "objective-tag":
        return f"the objective is marked as {dekebab(_jstr(m.get('tag')))}"
    if etype == "unit-tag":
        return f"{subj} {_v(subj, 'is')} marked as {dekebab(_jstr(m.get('tag')))}"

    # Container types — inline forms.
    if etype == "conditional":
        lead = _condition_lead_in(e.get("condition") or {})
        return f"{lead}, {describe_effect_inline(e.get('effect') or {}, ctx)}"
    if etype == "sequence":
        return "; ".join(describe_effect_inline(s, ctx) for s in e.get("steps") or [])
    if etype == "choice":
        label = f" ({_title_case(e['choice_label'])})" if e.get("choice_label") else ""
        options = " / ".join(describe_effect_inline(o, ctx) for o in e.get("options") or [])
        return f"select one of the following{label}: {options}"
    if etype == "dice-gated":
        comp = _format_comparison(e.get("comparison") or "gte", e.get("threshold"))
        on_success = e.get("on_success")
        success = describe_effect_inline(on_success, ctx) if on_success else "nothing happens"
        on_fail = e.get("on_fail")
        fail = f"; otherwise, {describe_effect_inline(on_fail, ctx)}" if on_fail else ""
        return f"roll one {_dice_case(e.get('dice'))}: on {comp}, {success}{fail}"
    if etype == "dice-pool-allocation":
        pool = e.get("pool")
        pool_text = f"{_jstr(pool['count'])}{_jstr(pool['die'])}" if pool else "?"
        opts = " / ".join(
            f"{_jstr(o.get('name'))} ({_jstr((o.get('requirement') or {}).get('type'))} of "
            f"{_jstr((o.get('requirement') or {}).get('min_value'))}+): "
            f"{describe_effect_inline(o.get('effect') or {}, ctx)}"
            for o in e.get("options") or []
        )
        return f"roll {pool_text}: {opts}"
    if etype == "select-units":
        return (
            f"select {_select_units_subject(e.get('selector'))}: "
            f"{describe_effect_inline(e.get('effect') or {}, ctx)}"
        )

    return f"[{etype if etype is not None else 'unknown'}]"


def describe_effect(e: Effect, depth: int = 0, ctx: Ctx | None = None) -> str:
    """Block translation of a *container* effect tree (multi-line, indented)."""
    ctx = ctx or {}
    indent = "  " * depth
    arrow = "-> " if depth > 0 else ""
    etype = e.get("type")

    if etype == "conditional":
        inner = e.get("effect") or {}
        if inner.get("type") in _CONTAINER_TYPES:
            return (
                f"{indent}{_capitalize(_condition_lead_in(e.get('condition') or {}))}:\n"
                + describe_effect(inner, depth + 1, ctx)
            )
        lead = _capitalize(_condition_lead_in(e.get("condition") or {}))
        return f"{indent}{arrow}{lead}, {describe_effect_inline(inner, ctx)}."
    if etype == "sequence":
        return "\n".join(describe_effect(s, depth, ctx) for s in e.get("steps") or [])
    if etype == "choice":
        label = f" ({_title_case(e['choice_label'])})" if e.get("choice_label") else ""
        options = "\n".join(
            f"{indent}  - {_capitalize(describe_effect_inline(o, ctx))}."
            for o in e.get("options") or []
        )
        return f"{indent}Select one of the following{label}:\n{options}"
    if etype == "dice-gated":
        comp = _format_comparison(e.get("comparison") or "gte", e.get("threshold"))
        on_success = e.get("on_success")
        success = describe_effect_inline(on_success, ctx) if on_success else "nothing happens"
        on_fail = e.get("on_fail")
        fail = f"; otherwise, {describe_effect_inline(on_fail, ctx)}" if on_fail else ""
        return f"{indent}{arrow}Roll one {_dice_case(e.get('dice'))}: on {comp}, {success}{fail}."
    if etype == "dice-pool-allocation":
        pool = e.get("pool")
        pool_text = f"{_jstr(pool['count'])}{_jstr(pool['die'])}" if pool else "?"
        lines = [
            f"{indent}{arrow}Roll {pool_text} (max {_jstr(e.get('max_activations'))} activations):"
        ]
        for opt in e.get("options") or []:
            requirement = opt.get("requirement") or {}
            lines.append(
                f"{indent}  - {_jstr(opt.get('name'))}: need {_jstr(requirement.get('type'))} of "
                f"{_jstr(requirement.get('min_value'))}+ -> "
                f"{describe_effect_inline(opt.get('effect') or {}, ctx)}"
            )
        return "\n".join(lines)
    if etype == "select-units":
        inner = e.get("effect") or {}
        lead = f"Select {_select_units_subject(e.get('selector'))}"
        if inner.get("type") in _CONTAINER_TYPES:
            return f"{indent}{arrow}{lead}:\n" + describe_effect(inner, depth + 1, ctx)
        return f"{indent}{arrow}{lead}: {describe_effect_inline(inner, ctx)}."
    # Leaf at block position — a single capitalized sentence.
    return f"{indent}{arrow}{_capitalize(describe_effect_inline(e, ctx))}."


def describe_scope(s: dict[str, Any] | None) -> str:
    """``Scope: aura (6"). Duration: phase.`` — retained for the legacy translate CLI footer."""
    if not s or (not s.get("range") and not s.get("duration")):
        return ""
    range_ = dekebab(s.get("range") or "")
    inches = f' ({_jstr(s["range_inches"])}")' if s.get("range_inches") is not None else ""
    duration = dekebab(s.get("duration") or "")
    return f"Scope: {range_}{inches}. Duration: {duration}."


def describe_applies_to(a: dict[str, Any] | None) -> str:
    """``Applies to: units with Possessed.`` — roster-highlighting audience."""
    if not a:
        return ""
    required = a.get("required_keywords") or []
    excluded = a.get("excluded_keywords") or []
    if not required and not excluded:
        return ""
    base = f"units with {', '.join(required)}" if required else "all units"
    exc = f" (excluding {', '.join(excluded)})" if excluded else ""
    return f"Applies to: {base}{exc}."


def _assemble_sentence(parts: list[str]) -> str:
    body = ", ".join(p for p in parts if p)
    if body == "":
        return ""
    period = "" if body.endswith(".") or body.endswith(":") else "."
    return _capitalize(body) + period


def _render_top_level(e: Effect, scope: dict[str, Any] | None) -> str:
    ctx: Ctx = {"range_inches": (scope or {}).get("range_inches")}
    lead, trail = _duration_clauses((scope or {}).get("duration"))

    if e.get("type") == "conditional":
        inner = e.get("effect") or {}
        lead_in = _condition_lead_in(e.get("condition") or {})
        if inner.get("type") in _CONTAINER_TYPES:
            header = ", ".join(part for part in (lead, lead_in, trail) if part)
            return _capitalize(header) + ":\n" + describe_effect(inner, 1, ctx)
        return _assemble_sentence([lead, lead_in, trail, describe_effect_inline(inner, ctx)])

    if e.get("type") in _CONTAINER_TYPES:
        block = describe_effect(e, 0, ctx)
        dur = lead or trail
        return _capitalize(dur) + ":\n" + block if dur else block

    return _assemble_sentence([lead, trail, describe_effect_inline(e, ctx)])


def describe_ability(a: dict[str, Any]) -> str:
    """Full natural-English text for an ability (effect + woven scope/duration,
    plus a trailing ``Applies to:`` line when a curated filter is present)."""
    core = _render_top_level(a["effect"], a.get("scope")) if a.get("effect") else ""
    applies = describe_applies_to(a.get("applies_to"))
    return "\n".join(part for part in (core, applies) if part)
