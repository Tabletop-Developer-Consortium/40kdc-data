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

from wh40kdc.translate.condition import (
    Condition,
    dekebab,
    describe_condition,
    describe_timing,
    event_clause,
)

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
    raw = _jstr(k).strip()
    anti = re.match(r"^anti[\s-]+(.*)$", raw, re.I)
    if anti:
        rated = re.match(r"^(.*?)[\s-]*(\d+)\s*(?:\+|plus)?$", anti.group(1), re.I)
        if rated:
            return f"[ANTI-{dekebab(rated.group(1)).strip().upper()} {rated.group(2)}+]"
        return f"[ANTI-{dekebab(anti.group(1)).strip().upper()}]"
    return f"[{dekebab(raw).upper()}]"


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
    "passes": "pass",
    "fails": "fail",
    "treats": "treat",
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


_USAGE_FREQUENCIES = {
    "once-per-turn": "once per turn",
    "once-per-phase": "once per phase",
    "once-per-command-phase": "once per Command phase",
    "once-per-opponent-turn": "once per opponent's turn",
    "first-this-battle": "the first time this battle",
    "first-time-this-phase": "the first time this phase",
}


def _usage_clause(u: dict[str, Any]) -> str:
    """Usage limit -> front-of-sentence lead clause ("once per turn", "twice per battle")."""
    count = u.get("count")
    try:
        n = int(count) if count is not None else 1
    except (TypeError, ValueError):
        n = 1
    freq = u.get("frequency")
    base = _USAGE_FREQUENCIES.get(freq) if isinstance(freq, str) else None
    if base is None:
        if freq == "n-per-battle":
            if n == 1:
                base = "once per battle"
            elif n == 2:
                base = "twice per battle"
            else:
                base = f"{_jstr(n)} times per battle"
        else:
            base = dekebab(_jstr(freq))
    return f"{base} per {_jstr(u['per'])}" if u.get("per") is not None else base


def _describe_trigger(t: dict[str, Any]) -> str:
    """Reactive trigger -> front-of-sentence lead clause
    ("an enemy unit ends a move within 9\" of this model")."""
    s = event_clause(t.get("event"))
    prox = t.get("proximity") or {}
    if prox.get("range") is not None:
        of_kind = prox.get("of")
        if of_kind == "attached-unit":
            of = "the unit this model leads"
        elif of_kind in ("self", "bearer"):
            of = "this model"
        else:
            of = "this unit"
        s += f' within {_jstr(prox["range"])}" of {of}'
    if t.get("condition"):
        s += f", if {describe_condition(t['condition'])}"
    return s


def _negated_target_keywords(keywords: list[str]) -> str:
    """"against a unit that is not a Monster or Vehicle" from excluded target keywords."""
    return "against a unit that is not a " + " or ".join(keywords)


def _join_and_lead_ins(operands: list[Condition]) -> str:
    """Join `and` operands. A run of negated target-has-keyword exclusions collapses
    into one "against a unit that is not a X or Y" clause, which attaches to the
    preceding clause with a space; all other operands join with ", "."""
    parts: list[str] = []
    i = 0
    while i < len(operands):
        op = operands[i]
        if op.get("negated") and op.get("type") == "target-has-keyword":
            kws: list[str] = []
            while (
                i < len(operands)
                and operands[i].get("negated")
                and operands[i].get("type") == "target-has-keyword"
            ):
                kws.append(_jstr((operands[i].get("parameters") or {}).get("keyword")))
                i += 1
            parts.append(_negated_target_keywords(kws))
            continue
        parts.append(_condition_lead_in(op))
        i += 1
    acc = ""
    for part in parts:
        if acc == "":
            acc = part
        elif part.startswith("against "):
            acc = f"{acc} {part}"
        else:
            acc = f"{acc}, {part}"
    return acc


def _condition_lead_in(c: Condition) -> str:
    operands = c.get("operands")
    if c.get("operator") == "and" and operands:
        return _join_and_lead_ins(operands)
    if c.get("operator") == "or" and operands:
        return " or ".join(_condition_lead_in(o) for o in operands)
    if c.get("operator") == "not" and operands:
        return "unless " + " or ".join(
            re.sub(r"^if ", "", _condition_lead_in(o)) for o in operands
        )
    # Negated keyword gates read as an exclusion clause, not the generic "if not …".
    if c.get("negated") and c.get("type") == "target-has-keyword":
        return _negated_target_keywords([_jstr((c.get("parameters") or {}).get("keyword"))])
    if c.get("negated") and c.get("type") == "unit-has-keyword":
        kw = _jstr((c.get("parameters") or {}).get("keyword"))
        return f"unless the unit has the {kw} keyword"
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
        if p.get("subject") == "target":
            return "while the target unit is below half strength"
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
        return f"while making {_jstr(p.get('attack_type'))} attacks"
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
        if st in ("not-in-engagement-range", "not-within-engagement-range"):
            return "while the unit is not within Engagement Range"
        return f"while the unit is {dekebab(st)}"
    if ctype == "disposition-matches":
        d = _jstr(p.get("disposition"))
        if d == "strategic-reserves":
            return "while the unit is in Strategic Reserves"
        return f"while the unit's disposition is {dekebab(d)}"
    if ctype == "fights-first":
        return "while the unit has the Fights First ability"
    return f"if {describe_condition(c)}"


def _describe_rule_state(m: dict[str, Any], subj: str) -> str:
    """``rule-state``: a named rule switched on/off for the subject. The
    ``faction-rule`` + ``suppressed`` path reproduces the legacy
    ``forgo-faction-rule`` wording verbatim; core-rule slugs get natural
    action/benefit phrasing; keyword/ability kinds fall back to a regular
    gains/loses-the-X clause. Pinned across the four ports by conformance."""
    direction = _jstr(m.get("direction"))
    kind = _jstr(m.get("rule_kind"))
    rule = _jstr(m.get("rule"))
    granted = direction == "granted"

    if kind == "faction-rule" and not granted:
        scope = f" this {dekebab(_jstr(m.get('scope')))}" if m.get("scope") is not None else ""
        cost = ""
        c = m.get("cost")
        if isinstance(c, dict) and c.get("dice") is not None:
            cfrom = c.get("from")
            if cfrom is None:
                frm = ""
            elif _jstr(cfrom) == rule:
                frm = " from that roll"
            else:
                frm = f" from the {_title_case(_jstr(cfrom))} roll"
            cost = f", using a {dekebab(_jstr(c.get('dice')))}{frm}"
        return f"forgo activating {_title_case(rule)}{scope}{cost}"
    if kind == "faction-rule":
        return f"{subj} {_v(subj, 'gains')} {_title_case(rule)}"

    if rule == "benefit-of-cover":
        if granted:
            return f"{subj} {_v(subj, 'has')} the Benefit of Cover"
        return f"{subj} cannot benefit from Cover"
    if rule == "charge":
        return f"{subj} can charge" if granted else f"{subj} cannot charge"
    if rule == "advance":
        return f"{subj} can Advance" if granted else f"{subj} cannot Advance"
    if rule == "fall-back":
        return f"{subj} can Fall Back" if granted else f"{subj} cannot Fall Back"
    if rule == "ordered-retreat":
        return (
            f"{subj} can make an Ordered Retreat"
            if granted
            else f"{subj} cannot make an Ordered Retreat"
        )
    if rule == "fire-overwatch":
        return f"{subj} can fire Overwatch" if granted else f"{subj} cannot fire Overwatch"
    if rule == "overwatch-against-bearer":
        return (
            f"your opponent can target {subj} with Overwatch"
            if granted
            else f"your opponent cannot target {subj} with Overwatch"
        )
    if rule == "desperate-escape":
        return (
            f"{subj} must take Desperate Escape tests"
            if granted
            else f"{subj} {_v(subj, 'is')} not affected by Desperate Escape tests"
        )

    noun = "keyword" if kind == "keyword" else "ability"
    if granted:
        return f"{subj} {_v(subj, 'gains')} the {_title_case(rule)} {noun}"
    return f"{subj} {_v(subj, 'loses')} the {_title_case(rule)} {noun}"


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


# Movement-modifier passthrough enum -> human phrase.
_PASSTHROUGH_PHRASE = {
    "non-titanic-models": "non-Titanic models",
    "friendly-vehicles": "friendly Vehicle models",
    "friendly-monsters": "friendly Monster models",
    "terrain-le-4": 'terrain features 4" or lower',
    "tall-terrain": 'terrain features over 4"',
    "all-terrain": "terrain features",
}


# Move-kind token -> display noun (for `applies_to_moves`).
_MOVE_NOUN = {
    "normal": "Normal",
    "advance": "Advance",
    "fall-back": "Fall Back",
    "charge": "Charge",
}


def _and_list(items: list[str]) -> str:
    """Oxford-free conjunction list ("a", "a and b", "a, b and c")."""
    if len(items) <= 1:
        return items[0] if items else ""
    if len(items) == 2:
        return f"{items[0]} and {items[1]}"
    return f"{', '.join(items[:-1])} and {items[-1]}"


def _inch_clause(dist: Any) -> str:
    """Trailing inches clause for a movement distance (int or dice string); "" when absent/zero."""
    if dist is None:
        return ""
    s = _dice_case(_jstr(dist))
    return "" if s == "0" else f' {s}"'


def _movement_clause(m: dict[str, Any], subj: str) -> str:
    """Closed movement-modifier ``modifier`` -> one lowercase-initial clause."""
    kind = m.get("move_type")
    dist = m.get("distance")
    inches = _inch_clause(dist)
    of_up_to = f" of up to{inches}" if inches else ""
    move_kinds = (
        _and_list([_MOVE_NOUN.get(x, dekebab(x)) for x in m["applies_to_moves"]])
        if isinstance(m.get("applies_to_moves"), list)
        else None
    )

    # Pure traversal capability (no move kind): passthrough / vertical / ignore-vertical.
    if kind is None:
        parts: list[str] = []
        passthrough = m.get("passthrough")
        if isinstance(passthrough, list) and passthrough:
            parts.append(
                " and ".join(_PASSTHROUGH_PHRASE.get(p, dekebab(p)) for p in passthrough)
            )
        if parts:
            over = (
                f' (up to {_jstr(m["vertical_limit"])}" high)'
                if m.get("vertical_limit") is not None
                else ""
            )
            clause = (
                f"{subj} can move over {' and '.join(parts)}{over} "
                "as though they were not there"
            )
        elif m.get("ignore_vertical"):
            clause = f"{subj} ignores vertical distances when it moves"
        else:
            clause = f"{subj} {_v(subj, 'has')} a movement capability"
        if m.get("excludes_keyword") is not None:
            clause += f" (excluding {_title_case(_jstr(m['excludes_keyword']))} models)"
        if move_kinds:
            clause += f", during its {move_kinds} moves"
        return clause

    kind_str = _jstr(kind)
    if kind_str == "scout":
        return f"before the first battle round, {subj} can make a Scout move{of_up_to}"
    if kind_str == "infiltrate":
        return f"{subj} {_v(subj, 'has')} the Infiltrators ability"
    if kind_str == "advance":
        return f"add {_dice_case(_jstr(dist))} to {_possessive(subj)} Advance rolls"
    if kind_str == "pile-in":
        pile_default = inches or ' 3"'
        return f"{subj} can Pile In up to{pile_default}"
    if kind_str == "consolidation":
        consol_default = inches or ' 3"'
        return f"{subj} can Consolidate up to{consol_default}"
    if kind_str == "surge":
        return f"{subj} can make a Surge move{of_up_to}"
    if kind_str == "shoot-and-scoot":
        return (
            f"{subj} can shoot and then make a Normal move{of_up_to}"
            if inches
            else f"{subj} can Shoot and Scoot"
        )
    if kind_str == "reactive":
        label = f" ({_jstr(m['name'])})" if m.get("name") is not None else ""
        return f"{subj} can make a Reactive move{of_up_to}{label}"
    if kind_str == "redeploy":
        marker = m.get("marker")
        if marker is not None:
            if marker.get("location") is not None:
                who = (
                    f"{_jstr(marker['unit_filter'])} units"
                    if marker.get("unit_filter") is not None
                    else "units"
                )
                return f"{who} can be set up on {_jstr(marker['location'])}"
            what = _jstr(marker["affected"]) if marker.get("affected") is not None else "markers"
            return f"{what} can be repositioned{inches}"
        if m.get("to_reserves"):
            n = f"up to {_jstr(m['max_units'])} units" if m.get("max_units") is not None else subj
            return f"{n} can be placed into Strategic Reserves"
        return f"{subj} can be redeployed{inches}"
    # normal / default
    dist_val = 0.0
    is_num = False
    if dist is not None:
        try:
            dist_val = float(dist)
            is_num = True
        except (TypeError, ValueError):
            dist_val = 0.0
            is_num = False
    if is_num and dist_val < 0:
        abs_n = int(abs(dist_val)) if float(abs(dist_val)).is_integer() else abs(dist_val)
        return f'{_possessive(subj)} Move characteristic is reduced by {abs_n}"'
    if move_kinds:
        return f"add{inches} to {_possessive(subj)} {move_kinds} moves"
    return f"{subj} can make a Normal move{of_up_to}"


def _aura_clause(e: Effect, m: dict[str, Any], ctx: Ctx) -> str:
    """Generic aura ``modifier`` -> one lowercase-initial clause."""
    # Range-extension of a named aura (e.g. Gift of Poxes: contagion +3").
    if m.get("range_bonus") is not None:
        named = f"{_title_case(_jstr(m['of']))} " if m.get("of") is not None else ""
        return (
            f"the range of this model's {named}abilities "
            f"is increased by {_jstr(m['range_bonus'])}\""
        )
    rng = m.get("range")
    if isinstance(rng, list):
        range_text: str | None = '/'.join(f'{_jstr(r)}"' for r in rng) + " (by battle round)"
    elif rng is not None:
        range_text = f'{_jstr(rng)}"'
    else:
        range_text = None
    who = "each friendly unit" if e.get("target") == "friendly-within-aura" else "each enemy unit"
    within = f"{who} within {range_text}" if range_text is not None else who
    if m.get("effect") is not None:
        return f"{within} {describe_effect_inline(m['effect'], dict(ctx))}"
    return f"{within} is affected"


def describe_effect_inline(e: Effect, ctx: Ctx | None = None) -> str:
    """Single-clause translation for leaf effects (lowercase-initial, no period),
    with any ``scaling`` block woven on as a trailing "for every ..." clause."""
    base = _describe_effect_inline_base(e, ctx)
    scaling = e.get("scaling")
    return f"{base} {_scaling_clause(scaling)}" if scaling else base


def _resurrection_placement(placement: Any) -> str:
    """Resurrection ``placement`` modifier → a "where it is set up" clause."""
    if placement is None:
        return ""
    p = _jstr(placement)
    if p == "deep-strike":
        return "using its Deep Strike ability"
    if p == "battlefield-edge":
        return "at a battlefield edge"
    if p == "closest-to-destruction":
        return "as close as possible to where it was destroyed"
    if p == "unengaged":
        return "not within Engagement Range of any enemy units"
    return f"via {dekebab(p)}"


def _resurrection_timing(timing: Any) -> str:
    """Resurrection ``timing`` modifier → a "when it is set up" clause."""
    if timing is None:
        return ""
    t = _jstr(timing)
    if t == "next-movement-phase":
        return "in your next Movement phase"
    if t == "end-of-phase":
        return "at the end of the phase"
    return dekebab(t)


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
        if m.get("anti_keyword") is not None:
            anti_th = m.get("anti_threshold")
            anti_th = anti_th if anti_th is not None else "?"
            kw = f"[ANTI-{dekebab(_jstr(m['anti_keyword'])).upper()} {_jstr(anti_th)}+]"
        elif isinstance(m.get("keywords"), list):
            kw = " and ".join(_bracket_keyword(k) for k in m["keywords"])
        elif m.get("value") is not None:
            # Rated keyword carried structurally (Sustained Hits N / Rapid Fire N / Melta N).
            base_kw = m.get("keyword") if m.get("keyword") is not None else "keywords"
            kw = f"[{dekebab(_jstr(base_kw)).upper()} {_jstr(m['value'])}]"
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
        return _movement_clause(m, subj)
    if etype == "aura":
        return _aura_clause(e, m, ctx)
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
        wounds = m.get("wounds_remaining")
        w = _jstr(wounds if wounds is not None else "full")
        place = _resurrection_placement(m.get("placement"))
        when = _resurrection_timing(m.get("timing"))
        tail = " ".join(p for p in (place, when) if p)
        tail_clause = f" {tail}" if tail else ""
        # Self/bearer resurrection reads as the model returning, not a model returned to itself.
        if e.get("target") in ("self", "bearer"):
            return f"{subj} {_v(subj, 'is')} set up again{tail_clause} with {w} wounds remaining"
        noun = "destroyed model" if count == "1" else "destroyed models"
        return f"return {count} {noun} to {subj} with {w} wounds{tail_clause}"
    if etype == "model-destruction":
        count = _dice_case(m.get("count")) if m.get("count") is not None else "1"
        noun = "model" if count == "1" else "models"
        return f"destroy {count} {noun} in {subj}"
    if etype == "rule-state":
        return _describe_rule_state(m, subj)
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
        if m.get("min_distance") is not None:
            return (
                f"{subj} {_v(subj, 'has')} the Deep Strike ability and can be set up "
                f'more than {_jstr(m["min_distance"])}" from enemy models'
            )
        return f"{subj} has the Deep Strike ability"
    if etype == "strategic-reserves-arrival":
        return f"{subj} can arrive from Strategic Reserves regardless of mission rules"
    if etype == "remove-battle-shock":
        return f"{subj} {_v(subj, 'is')} no longer Battle-shocked"
    if etype == "auto-result":
        res = m.get("result")
        if m.get("test") is not None:
            tn = _test_name(m.get("test"))
            if res == "pass":
                return f"{subj} automatically {_v(subj, 'passes')} {tn} tests"
            if res == "fail":
                return f"{subj} automatically {_v(subj, 'fails')} {tn} tests"
            return f"{subj} {_v(subj, 'treats')} {tn} tests as {_jstr(res)}"
        roll = _roll_name(m.get("roll"))
        if res == "pass":
            return f"{_possessive(subj)} {roll} rolls automatically succeed"
        if res == "fail":
            return f"{_possessive(subj)} {roll} rolls automatically fail"
        return f"{_possessive(subj)} {roll} rolls count as {_jstr(res)}"
    if etype == "firing-deck":
        return f"{subj} {_v(subj, 'has')} Firing Deck {_jstr(m.get('value'))}"
    if etype == "disembark-after-move":
        return f"units can disembark from {subj} after it has moved"
    if etype == "fallback-and-act":
        return (
            f"{subj} {_v(subj, 'is')} eligible to shoot and declare a charge "
            "in a turn in which it Fell Back"
        )
    if etype == "engagement-passthrough":
        if m.get("no_end_in_engagement"):
            return (
                f"{subj} can move through enemy models, but cannot end that move "
                "within Engagement Range of any enemy unit"
            )
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


def _aura_radius(scope: dict[str, Any] | None) -> float | int | None:
    """Aura radius in inches: explicit `range_inches`, else the integer baked into a
    standard `aura-<n>` slug (`aura-6` -> 6), else None. Per the scope schema,
    `aura-6/9/12` carry the radius in the slug and leave `range_inches` null; only
    `aura-custom` sets `range_inches`. Non-aura ranges yield None, so the subject
    helper keeps its " nearby" fallback."""
    scope = scope or {}
    if scope.get("range_inches") is not None:
        return scope.get("range_inches")
    m = re.fullmatch(r"aura-(\d+)", scope.get("range") or "")
    return int(m.group(1)) if m else None


def _render_top_level(
    e: Effect,
    scope: dict[str, Any] | None,
    usage: dict[str, Any] | None = None,
    trigger: dict[str, Any] | None = None,
) -> str:
    ctx: Ctx = {"range_inches": _aura_radius(scope)}
    dur_lead, trail = _duration_clauses((scope or {}).get("duration"))
    # An explicit usage limit supersedes the duration's coarse "once per battle" lead.
    lead = _usage_clause(usage) if usage and usage.get("frequency") is not None else dur_lead
    # A reactive trigger opens the sentence ("Each time ...").
    trig = _describe_trigger(trigger) if trigger and trigger.get("event") is not None else ""

    if e.get("type") == "conditional":
        inner = e.get("effect") or {}
        lead_in = _condition_lead_in(e.get("condition") or {})
        if inner.get("type") in _CONTAINER_TYPES:
            header = ", ".join(part for part in (trig, lead, lead_in, trail) if part)
            return _capitalize(header) + ":\n" + describe_effect(inner, 1, ctx)
        return _assemble_sentence([trig, lead, lead_in, trail, describe_effect_inline(inner, ctx)])

    if e.get("type") in _CONTAINER_TYPES:
        block = describe_effect(e, 0, ctx)
        head = ", ".join(part for part in (trig, lead or trail) if part)
        return _capitalize(head) + ":\n" + block if head else block

    return _assemble_sentence([trig, lead, trail, describe_effect_inline(e, ctx)])


def describe_ability(a: dict[str, Any]) -> str:
    """Full natural-English text for an ability (effect + woven scope/duration,
    plus a trailing ``Applies to:`` line when a curated filter is present)."""
    core = (
        _render_top_level(a["effect"], a.get("scope"), a.get("usage"), a.get("trigger"))
        if a.get("effect")
        else ""
    )
    applies = describe_applies_to(a.get("applies_to"))
    return "\n".join(part for part in (core, applies) if part)
