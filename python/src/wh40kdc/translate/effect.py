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
    describe_selection_eligibility,
    describe_timing,
    event_clause,
    negated_timing,
)

Effect = dict[str, Any]
Ctx = dict[str, Any]

_CONTAINER_TYPES = {
    "sequence",
    "choice",
    "dice-gated",
    "dice-pool-allocation",
    "select-units",
    "for-each-unit",
    "leader-model-ability-grant",
    "designate-target",
    "persistent-designation",
    "stance-select",
    "risk-reward",
    "issue-orders",
    "resource-action-menu",
}


def _select_units_subject(sel: Any) -> str:
    """Render count and bearer-relative candidate gates for ``select-units``."""
    sel = sel or {}
    owner = _jstr(sel.get("owner"))
    keywords = " ".join(_title_case(_jstr(k)) for k in (sel.get("keywords") or []))
    owner_keywords = f" {keywords}" if keywords else ""
    exact_count = sel.get("count")
    min_count = sel.get("min_count")
    max_count = sel.get("max_count")
    if exact_count is None and min_count is not None and float(min_count) == float(max_count):
        exact_count = max_count
    bounded = min_count is not None and exact_count is None
    count = exact_count if exact_count is not None else max_count
    single = count == 1
    noun = "unit" if single else "units"
    if exact_count is not None:
        quantity = "one" if single else _jstr(count)
    elif bounded:
        quantity = f"from {_jstr(min_count)} through {_jstr(max_count)}"
    else:
        quantity = f"up to {_jstr(max_count)}"
    if sel.get("within_inches") is not None:
        within = f' within {_jstr(sel["within_inches"])}"'
    elif isinstance(sel.get("range_inches"), (int, float)):
        within = f" within {_jstr(sel['range_inches'])} inches of the bearer"
    else:
        within = ""
    visible = " visible to the bearer" if sel.get("visibility_required") is True else ""
    inclusive = ", inclusive" if bounded else ""
    return (
        f"{quantity} {owner}{owner_keywords} {noun}{inclusive}{within}{visible}"
        f"{_selection_eligibility(sel)}"
    )


def _select_units_engagement(sel: Any) -> str:
    sel = sel or {}
    if sel.get("engagement_relation") == "engaged-with-bearer":
        return "For each selected unit, it must be engaged with the bearer."
    if sel.get("engagement_relation") == "not-engaged-with-bearer":
        return "For each selected unit, it must not be engaged with the bearer."
    return ""


def _selected_recipient(text: str, sel: Any) -> str:
    sel = sel or {}
    count = sel.get("count", sel.get("max_count", 0))
    recipient = "each selected unit" if count > 1 else "the selected unit"
    text = text.replace("The unit's", "Each selected unit's").replace(
        "the unit's", f"{recipient}'s"
    )
    return text.replace("The unit", "Each selected unit").replace("the unit", recipient)


def _select_units_inline(sel: Any, effect: Effect, ctx: Ctx) -> str:
    subject = _select_units_subject(sel)
    engagement = _select_units_engagement(sel)
    nested = _selected_recipient(
        describe_effect_inline(effect, {**ctx, "selected_unit": True}), sel
    )
    return (
        f"select {subject}. {engagement} {_capitalize(nested)}"
        if engagement
        else f"select {subject}: {nested}"
    )


def _leader_model_ability_grant_clause(e: Effect, ctx: Ctx) -> str:
    """Render the beneficiary-only leader relation without a bearer fallback."""
    filt = e.get("leader_filter") or {}
    identity = _title_case(_jstr(filt.get("identity"))) if filt.get("identity") else ""
    keywords = " and ".join(_bracket_keyword(k) for k in (filt.get("keywords") or []))
    role = (
        "the attached CHARACTER leader model"
        if e.get("beneficiary") == "attached-character-leader"
        else "the attached leader model"
    )
    leader = (
        f"{role}{f' identified as {identity}' if identity else ''}"
        f"{f' with {keywords}' if keywords else ''}"
    )
    unit_keywords = " and ".join(_bracket_keyword(k) for k in (e.get("attached_unit_filter") or []))
    source = f"the bearer unit{f' with {unit_keywords}' if unit_keywords else ''}"
    nested = dict((e.get("grant") or {}).get("effect") or {})
    nested["target"] = "self"
    rendered = describe_effect_inline(nested, ctx).replace("this model", "that leader model", 1)
    return f"while {leader} leads {source}, {rendered}"


def _for_each_unit_subject(selector: Any) -> str:
    """The candidate phrase for an independently resolved unit iteration."""
    selector = selector or {}
    owner = _jstr(selector.get("owner"))
    within = (
        f' within {_jstr(selector.get("within_inches"))}"'
        if selector.get("within_inches") is not None
        else ""
    )
    return f"{owner} unit{within}"


def _selection_eligibility(sel: dict[str, Any]) -> str:
    """A selection-time predicate, phrased as part of the candidate noun phrase."""
    eligibility = sel.get("eligibility")
    return (
        f" {describe_selection_eligibility(eligibility)}" if isinstance(eligibility, dict) else ""
    )


def _aura_recipient(e: Effect) -> str:
    """Aura recipient noun phrase including optional keyword eligibility."""
    m = e.get("modifier") or {}
    eligible = m.get("eligible") or {}
    owner = "friendly" if e.get("target") == "friendly-within-aura" else "enemy"
    required = eligible.get("required_keywords") or []
    excluded = eligible.get("excluded_keywords") or []
    keywords = " ".join(_jstr(keyword) for keyword in required)
    recipient = f"each {owner}{f' {keywords}' if keywords else ''} unit"
    return (
        f"{recipient} (excluding {' '.join(_jstr(keyword) for keyword in excluded)} units)"
        if excluded
        else recipient
    )


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


def _round_number(v: Any) -> float | int | None:
    """JS ``Number(v)`` collapsing integral floats to int; None on non-numeric."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return int(f) if f.is_integer() else f


_BATTLE_ROUND_ORDS = ["zeroth", "first", "second", "third", "fourth", "fifth"]


def _battle_round_ord(n: float | int) -> str:
    """Ordinal name for a battle round (``["zeroth"..."fifth"][n] ?? "<n>th"``)."""
    if isinstance(n, int) and 0 <= n < len(_BATTLE_ROUND_ORDS):
        return _BATTLE_ROUND_ORDS[n]
    return f"{_jstr(n)}th"


def _capitalize(s: str) -> str:
    return s if s == "" else s[0].upper() + s[1:]


_TITLE_SMALL = {"of", "or", "and", "the", "a", "an", "to", "in", "on", "for", "with"}


def _persistent_designation_name(designation: Any, scope: Any) -> str:
    label = _title_case(_jstr(designation))
    if scope == "objective-marker":
        return f"your {label}" if label.endswith(" Marker") else f"your {label} Marker"
    return f"your {label}" if re.search(r"\bTarget$", label) else f"your {label} target"


def _persistent_designation_label(designation: Any, scope: Any) -> str:
    return f" ({_persistent_designation_name(designation, scope)})"


def _persistent_designation_supported(e: Effect) -> bool:
    select_raw = e.get("select")
    consumer_raw = e.get("consumer")
    sel = select_raw if isinstance(select_raw, dict) else {}
    consumer = consumer_raw if isinstance(consumer_raw, dict) else {}
    if consumer.get("beneficiary") != "bearer":
        return False
    return (
        sel.get("scope") == "enemy-unit" and consumer.get("relation") == "attacks-selected-unit"
    ) or (
        sel.get("scope") == "objective-marker"
        and consumer.get("relation") == "within-selected-marker"
    )


def _persistent_designation_lead(e: Effect) -> str:
    select_raw = e.get("select")
    sel = select_raw if isinstance(select_raw, dict) else {}
    scope_noun = "objective marker" if sel.get("scope") == "objective-marker" else "enemy unit"
    label = _persistent_designation_label(e.get("designation"), sel.get("scope"))
    timing = sel.get("timing")
    select_lead = f"{describe_timing(timing)}, select" if timing else "select"
    return f"{select_lead} one {scope_noun}{label}."


def _persistent_designation_when(e: Effect) -> str:
    select_raw = e.get("select")
    consumer_raw = e.get("consumer")
    sel = select_raw if isinstance(select_raw, dict) else {}
    consumer = consumer_raw if isinstance(consumer_raw, dict) else {}
    name = _persistent_designation_name(e.get("designation"), sel.get("scope"))
    relation = (
        f"while this model is within range of {name}"
        if consumer.get("relation") == "within-selected-marker"
        else "each time this model makes an attack against it"
    )
    _, trail = _duration_clauses(e.get("duration"))
    return f"{_capitalize(trail)}, {relation}" if trail else relation


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
    "nurgle-s-gift-aura": "Nurgle's Gift (Aura)",
}


def _grant_label(id: str) -> str:
    """The display label for a granted ability id: a curated override, else Title Case."""
    return _ABILITY_GRANT_LABELS.get(id) or _title_case(id)


def _designation_label(designation: Any) -> str:
    """ "(your Suppressed target)" — a designate-target mark's parenthetical. A
    designation slug that already ends in "target" keeps its own noun
    ("bio-stimulus-target" → "(your Bio Stimulus Target)", not "… Target target")."""
    label = _title_case(_jstr(designation))
    if re.search(r"\bTarget$", label):
        return f" (your {label})"
    return f" (your {label} target)"


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


# Narrowed feel-no-pain scopes -> trailing qualifier. Absent/`all` renders bare.
_FNP_SCOPES = {
    "mortal": " against mortal wounds",
    "psychic": " against Psychic Attacks",
    "psychic-and-mortal": " against Psychic Attacks and mortal wounds",
}


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
    if ri is not None:
        within = f' within {_jstr(ri)}"'
    elif ctx.get("engagement_range"):
        within = " within Engagement Range"
    elif ctx.get("scope_range") == "any-visible":
        within = " that are visible"
    elif ctx.get("scope_range") == "any-on-battlefield":
        within = " anywhere on the battlefield"
    else:
        within = " nearby"
    if target in ("self", "bearer"):
        return "this model"
    if target == "unit":
        return "that unit" if ctx.get("selected_unit") else "the unit"
    if target == "attached-unit":
        return "the unit this model leads"
    if target == "target":
        return "the target"
    if target == "attacker":
        return "the attacking unit"
    if target == "defender":
        # The defending unit in an attack is the enemy from the bearer's view.
        return "the target"
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


def _of_or_possessive(subj: str, rest: str) -> str:
    """`<subj>'s <rest>` for a simple subject; `the <rest> of <subj>` when the subject
    is a clause (an aura target ending in an inch mark), where a trailing possessive
    reads as garbage (`friendly units within 6"'s weapons`)."""
    if subj.endswith('"'):
        return f"the {rest} of {subj}"
    return f"{_possessive(subj)} {rest}"


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


def _describe_requirement(req: dict[str, Any] | None) -> str:
    """Dice-pool requirement phrase ("pair of 4+"); an ``any_of`` list joins its
    alternatives with " or " ("pair of 4+ or triple of 1+")."""
    req = req or {}

    def one(r: dict[str, Any] | None) -> str:
        r = r or {}
        return f"{_jstr(r.get('type'))} of {_jstr(r.get('min_value'))}+"

    any_of = req.get("any_of")
    if isinstance(any_of, list):
        return " or ".join(one(r) for r in any_of)
    return one(req)


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
        return ("", "until the start of your next Command phase")
    if duration == "until-next-battle-round":
        return ("", "until the start of the next battle round")
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


def _resource_noun(m: dict[str, Any], count: Any = None) -> str:
    """Player-facing noun for a ``resource-gain``/``resource-spend``/
    ``resource-clear`` modifier's pool, or a menu action's ``cost``.
    ``resource_label`` (a singular noun, e.g. "Battle Focus token") is an
    author-provided override that pluralizes by count and never leaks the
    internal ``pool_id``; absent, falls back to the established
    ``_pool_name`` title-casing (backward compatible with every pre-existing
    resource node)."""
    label = m.get("resource_label")
    if not isinstance(label, str) or not label:
        pool = m.get("pool_id") if m.get("pool_id") is not None else m.get("resource")
        return _pool_name(pool)
    n = _round_number(count) if count is not None else None
    return label if n == 1 else f"{label}s"


def _is_end_of_phase_disembark_battle_shock(t: dict[str, Any]) -> bool:
    condition = t.get("condition")
    if t.get("event") != "end-of-phase" or not isinstance(condition, dict):
        return False
    operands = condition.get("operands")
    return (
        condition.get("operator") == "and"
        and isinstance(operands, list)
        and len(operands) == 2
        and not operands[0].get("negated")
        and not operands[1].get("negated")
        and operands[0].get("type") == "disembarked-from-transport"
        and operands[1].get("type") == "is-battle-shocked"
    )


def _describe_trigger(t: dict[str, Any]) -> str:
    """Reactive trigger -> front-of-sentence lead clause
    ("an enemy unit ends a move within 9\" of this model")."""
    s = event_clause(t.get("event"))
    if t.get("event") == "falls-back" and t.get("subject") == "enemy-unit":
        s = "an enemy unit Falls Back"
    # Narrow a move event to its move kinds: "ends a move" -> "ends a Normal,
    # Advance or Fall Back move".
    move_types = t.get("move_types")
    if isinstance(move_types, list) and move_types:
        kinds = _or_list(
            ["Fall Back" if mt == "fall-back" else _cap_word(_jstr(mt)) for mt in move_types]
        )
        s = re.sub(r"\bmove\b", lambda _m: f"{kinds} move", s, count=1)
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
    if _is_end_of_phase_disembark_battle_shock(t):
        s += ", if the unit disembarked from a Transport this turn and is Battle-shocked"
    elif t.get("condition"):
        s += f", if {describe_condition(t['condition'])}"
    return s


def _menu_action_subject(elig: dict[str, Any] | None) -> str:
    """``excludes_keyword``/``requires_keyword`` -> the eligible-unit noun
    phrase for a menu action ("one friendly non-TITANIC unit" / "a friendly
    VEHICLE unit"). Absent eligibility keywords fall back to the plain
    subject."""
    elig = elig or {}
    requires = elig.get("requires_keyword") or []
    excludes = elig.get("excludes_keyword") or []
    if excludes:
        return f"one friendly non-{'/'.join(_jstr(k) for k in excludes)} unit"
    if requires:
        return f"a friendly {' '.join(_jstr(k) for k in requires)} unit"
    return "the unit"


def _menu_action_eligibility_clause(elig: dict[str, Any] | None) -> str:
    """A menu action's ``eligibility`` -> a trailing parenthetical naming
    which unit may use it and any extra requirements (``eligibility.requires``
    conditions, rendered via the shared ``describe_condition`` and joined
    with "and"). ``""`` when the action is open to any unit with no further
    gate."""
    if not elig:
        return ""
    has_keyword_gate = bool(elig.get("requires_keyword")) or bool(elig.get("excludes_keyword"))
    requirement_phrases = [describe_condition(c) for c in elig.get("requires") or []]
    if not has_keyword_gate and not requirement_phrases:
        return ""
    parts: list[str] = []
    if has_keyword_gate:
        parts.append(f"only usable by {_menu_action_subject(elig)}")
    if requirement_phrases:
        parts.append(" and ".join(requirement_phrases))
    return f" ({', '.join(parts)})" if parts else ""


def _menu_action_duration_clause(duration: Any) -> str:
    """A menu action's ``duration`` -> a trailing clause. ``immediate`` (and
    absent) render with NO clause -- a one-off action whose only lasting
    result is the board position it leaves behind."""
    if duration == "until-end-of-phase":
        return "until the end of the phase"
    if duration == "until-end-of-turn":
        return "until the end of the turn"
    return ""


def _describe_menu_action(a: dict[str, Any], ctx: Ctx) -> str:
    """One ``resource-action-menu`` action -> a bullet body ("Label: trigger,
    spend N tokens, effect, duration (notes).")."""
    label = _jstr(a.get("label") if a.get("label") is not None else a.get("id"))
    triggers = _normalize_triggers(a.get("when"))
    trig = " or ".join(s for s in (_describe_trigger(t) for t in triggers) if s)
    cost = a.get("cost") or {}
    cost_phrase = f"spend {_jstr(cost.get('amount'))} {_resource_noun(cost, cost.get('amount'))}"
    eff_clause = describe_effect_inline(a.get("effect") or {}, ctx)
    dur_clause = _menu_action_duration_clause(a.get("duration"))
    usage_note = (
        " (may be triggered more than once per phase if a different unit performs it each time)"
        if (a.get("usage") or {}).get("repeatable_if_different_unit")
        else ""
    )
    body = ", ".join(
        p
        for p in (
            f"{trig}{_menu_action_eligibility_clause(a.get('eligibility'))}",
            cost_phrase,
            eff_clause,
            dur_clause,
        )
        if p
    )
    return f"{label}: {body}{usage_note}."


def _shared_usage_clause(su: dict[str, Any] | None) -> str:
    """``shared_usage`` -> a menu-level sentence fragment ("a unit may perform
    at most one action per phase; unless stated otherwise, a given action may
    be triggered once per phase"). ``""`` when absent."""
    if not su:
        return ""
    parts: list[str] = []
    unit_max = su.get("unit_max_manoeuvres_per_phase")
    if unit_max is not None:
        parts.append(
            "a unit may perform at most one action per phase"
            if unit_max == 1
            else f"a unit may perform at most {_jstr(unit_max)} actions per phase"
        )
    default_max = su.get("default_manoeuvre_max_per_phase")
    if default_max is not None:
        parts.append(
            "unless stated otherwise, a given action may be triggered once per phase"
            if default_max == 1
            else (
                f"unless stated otherwise, a given action may be triggered up to "
                f"{_jstr(default_max)} times per phase"
            )
        )
    return "; ".join(parts)


def _negated_target_keywords(keywords: list[str]) -> str:
    """ "against a unit that is not a Monster or Vehicle" from excluded target keywords."""
    return "against a unit that is not a " + " or ".join(keywords)


def _cap_word(s: str) -> str:
    """Naturally capitalize a display word (``MONSTER`` → ``Monster``)."""
    return s[:1].upper() + s[1:].lower() if s else s


def _not_wrapped_target_keyword(op: Condition) -> str | None:
    """The keyword of a `not`-wrapping-a-single-`target-has-keyword` operand, else None.
    The aura-subject exclusion encoding, distinct from the bare negated form."""
    if op.get("operator") != "not":
        return None
    operands = op.get("operands")
    if not operands or len(operands) != 1:
        return None
    inner = operands[0]
    if inner.get("type") != "target-has-keyword" or inner.get("negated"):
        return None
    return _jstr((inner.get("parameters") or {}).get("keyword"))


def _excluded_target_keywords(keywords: list[str]) -> str:
    """ "(excluding Monster or Vehicle units)" from a run of `not`-wrapped exclusions."""
    return "(excluding " + " or ".join(_cap_word(k) for k in keywords) + " units)"


def _join_and_lead_ins(operands: list[Condition]) -> str:
    """Join `and` operands. Two exclusion encodings collapse: a run of bare-negated
    target-has-keyword becomes "against a unit that is not a X or Y", and a run of
    `not`-wrapped target-has-keyword becomes "(excluding X or Y units)". Either
    attaches to the preceding clause with a space; all other operands join with ", "."""
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
        if _not_wrapped_target_keyword(op) is not None:
            kws = []
            while i < len(operands):
                kw = _not_wrapped_target_keyword(operands[i])
                if kw is None:
                    break
                kws.append(kw)
                i += 1
            parts.append(_excluded_target_keywords(kws))
            continue
        if not op.get("negated") and op.get("type") == "unit-has-keyword":
            kws = []
            while (
                i < len(operands)
                and not operands[i].get("negated")
                and operands[i].get("type") == "unit-has-keyword"
            ):
                kws.append(_jstr((operands[i].get("parameters") or {}).get("keyword")))
                i += 1
            if len(kws) >= 2:
                parts.append(f"if the unit is a {' '.join(kws)} unit")
            else:
                parts.append(f"if the unit has the {kws[0]} keyword")
            continue
        parts.append(_condition_lead_in(op))
        i += 1
    acc = ""
    for part in parts:
        if acc == "":
            acc = part
        elif part.startswith("against ") or part.startswith("(excluding "):
            acc = f"{acc} {part}"
        else:
            acc = f"{acc}, {part}"
    return acc


def _join_or_lead_ins(operands: list[Condition]) -> str:
    """Join `or` operands, collapsing only an all-keyword group into one clause."""
    if operands and all(
        not op.get("negated") and op.get("type") == "unit-has-keyword" for op in operands
    ):
        keywords = [_jstr((op.get("parameters") or {}).get("keyword")) for op in operands]
        return f"if the unit has the {_or_list(keywords)} keywords"
    return " or ".join(_condition_lead_in(op) for op in operands)


def _condition_lead_in(c: Condition) -> str:
    operands = c.get("operands")
    if c.get("operator") == "and" and operands:
        return _join_and_lead_ins(operands)
    if c.get("operator") == "or" and operands:
        return _join_or_lead_ins(operands)
    if c.get("operator") == "not" and operands:
        return "unless " + " or ".join(re.sub(r"^if ", "", _condition_lead_in(o)) for o in operands)
    # Negated keyword gates read as an exclusion clause, not the generic "if not …".
    if c.get("negated") and c.get("type") == "target-has-keyword":
        return _negated_target_keywords([_jstr((c.get("parameters") or {}).get("keyword"))])
    if c.get("negated") and c.get("type") == "unit-has-keyword":
        kw = _jstr((c.get("parameters") or {}).get("keyword"))
        return f"unless the unit has the {kw} keyword"
    if c.get("negated") and c.get("type") == "timing-is":
        return negated_timing((c.get("parameters") or {}).get("timing"))
    if c.get("negated"):
        return f"if {describe_condition(c)}"

    p = c.get("parameters") or {}
    ctype = c.get("type")
    if ctype == "phase-is":
        return f"during the {_title_case(_jstr(p.get('phase')))} phase"
    if ctype == "is-attached":
        kw = f"{_jstr(p.get('keyword'))} " if p.get("keyword") else ""
        return f"while this model is leading a {kw}unit"
    if ctype == "timing-is":
        return describe_timing(p.get("timing"))
    if ctype == "player-turn-is":
        turn = p.get("turn")
        if turn in ("your-turn", "your", "own"):
            return "in your turn"
        if turn in ("opponent-turn", "opponent"):
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
        b_min = _round_number(p.get("min")) if p.get("min") is not None else None
        b_max = _round_number(p.get("max")) if p.get("max") is not None else None
        if b_min is not None and b_max is not None:
            if b_min == b_max:
                return f"during the {_battle_round_ord(b_min)} battle round"
            return f"during battle rounds {_jstr(b_min)}-{_jstr(b_max)}"
        if b_min is not None:
            return f"from the {_battle_round_ord(b_min)} battle round onward"
        if b_max is not None:
            return f"during the first {_jstr(b_max)} battle rounds"
        return "during the battle round"
    if ctype == "token-count-at-or-above":
        return f"while the unit has {_jstr(p.get('threshold'))}+ {_pool_name(p.get('pool_id'))}"
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
        if p.get("attack_type") == "any":
            return "when destroyed by any attack"
        return f"when destroyed by a {_jstr(p.get('attack_type'))} attack"
    if ctype == "opponent-unit-within-range":
        if p.get("weapon_name") is not None:
            where = f"range of {dekebab(_jstr(p.get('weapon_name')))}"
        elif p.get("range_multiplier") is not None:
            where = "half range of its ranged weapons"
        else:
            range_ = p.get("range")
            if range_ is None:
                range_ = p.get("range_inches")
            if range_ is None:
                range_ = p.get("within_inches")
            where = "engagement range" if range_ == "engagement" else f'{_jstr(range_)}"'
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


def _named_region_title(value: Any) -> str:
    return _title_case(_jstr(value))


def _named_region_relation(value: Any) -> str:
    return "wholly within" if value == "wholly-within" else dekebab(_jstr(value))


def _named_region_keywords(value: Any) -> str:
    return " or ".join(_jstr(v) for v in value) if isinstance(value, list) else "?"


def _named_region_prefix(m: dict[str, Any]) -> str:
    ref = m.get("region_ref") or {}
    region = _named_region_title(ref.get("region_id"))
    producer = m.get("producer") or {}
    sentences: list[str] = []
    for entry in producer.get("baseline") or []:
        zone = _jstr((entry or {}).get("zone"))
        if zone == "own-deployment-zone":
            sentences.append(f"Your deployment zone is always within {region}.")
        elif zone != "?":
            sentences.append(f"{_named_region_title(zone)} is always within {region}.")
    has_phase_extension = False
    for entry in producer.get("phase_extensions") or []:
        zone = _jstr((entry or {}).get("zone"))
        if zone == "no-mans-land":
            sentences.append(
                f"At the start of each phase, No Man's Land is within {region} "
                "until the end of that phase if you control at least half of "
                "its objective markers."
            )
            has_phase_extension = True
        elif zone == "opponent-deployment-zone":
            sentences.append(
                "The same applies separately to your opponent's deployment zone."
                if has_phase_extension
                else (
                    "At the start of each phase, your opponent's deployment zone "
                    f"is within {region} until the end of that phase if you control "
                    "at least half of its objective markers."
                )
            )
            has_phase_extension = True
        elif zone != "?":
            label = _named_region_title(zone)
            sentences.append(
                f"At the start of each phase, {label} is within {region} until "
                "the end of that phase if you control at least half of its "
                "objective markers."
            )
            has_phase_extension = True
    source_parts: list[str] = []
    for entry in producer.get("additive_extensions") or []:
        addition = entry or {}
        gate = addition.get("source_gate") or {}
        predicate = gate.get("unit_predicate") or {}
        if not predicate:
            continue
        faction = _named_region_title(predicate.get("faction"))
        keywords = _named_region_keywords(predicate.get("keywords"))
        radius = (
            f' within {_jstr(addition["radius_inches"])}"'
            if addition.get("radius_inches") is not None
            else ""
        )
        source_parts.append(f"{faction} units with {keywords}{radius}")
    unique_source_parts = list(dict.fromkeys(source_parts))
    if unique_source_parts:
        sentences.append(
            f"Selected objective markers extend {region} around {' or '.join(unique_source_parts)}."
        )
    return " ".join(sentences)


def _named_region_subject(m: dict[str, Any]) -> str:
    consumer = m.get("consumer") or {}
    gate = consumer.get("beneficiary_gate") or {}
    faction = _named_region_title(gate.get("faction")) if gate.get("faction") is not None else ""
    keywords = _named_region_keywords(gate.get("keywords"))
    faction_part = f" from your {faction} army" if faction else " from your army"
    return f"Models in {keywords} units{faction_part}"


def _named_region_effect(branch: dict[str, Any], qualified: bool, ctx: Ctx | None = None) -> str:
    effect_raw = branch.get("effect")
    effect: dict[str, Any] = {}
    if isinstance(effect_raw, dict):
        effect = effect_raw
    modifier_raw = effect.get("modifier")
    modifier: dict[str, Any] = {}
    if isinstance(modifier_raw, dict):
        modifier = modifier_raw
    roll = _roll_name(modifier.get("roll"))
    if effect.get("type") == "re-roll":
        if modifier.get("result_scope") == "any-result":
            text = f"can re-roll the {roll} roll"
        elif modifier.get("subset") == "ones":
            text = f"can re-roll {roll} rolls of 1"
        else:
            text = f"can re-roll {roll} rolls"
    elif effect.get("type") == "roll-modifier" and modifier.get("value") is not None:
        text = f"gets {_signed(modifier.get('operation'), modifier.get('value'))} to {roll}"
    else:
        text = describe_effect_inline(effect, ctx)
    if modifier.get("weapon_keyword") is not None:
        text += f" for {'those ' if qualified else ''}{_jstr(modifier['weapon_keyword'])} attacks"
    return text


def _named_region_branch(
    m: dict[str, Any],
    whole_unit: bool,
    qualified: bool,
    conditional: bool = False,
    ctx: Ctx | None = None,
) -> str:
    consumer = m.get("consumer") or {}
    branch = consumer.get("qualified_branch" if qualified else "default_branch") or {}
    effect = _named_region_effect(branch, qualified, ctx)
    if conditional:
        return f"{_named_region_subject(m)} {effect}"
    if not qualified:
        return f"{_named_region_subject(m)} {effect}."
    membership = consumer.get("membership") or {}
    region = _named_region_title((m.get("region_ref") or {}).get("region_id"))
    relation = _named_region_relation(membership.get("relation"))
    subject = (
        f"If such a unit is {relation} {region}, those models"
        if whole_unit
        else f"If such a model is {relation} {region}, it"
    )
    return f"{subject} {effect} instead"


def _describe_named_region_state(m: dict[str, Any], ctx: Ctx | None = None) -> str:
    consumer = m.get("consumer") or {}
    membership = consumer.get("membership") or {}
    whole_unit = membership.get("unit_scope") == "whole-unit"
    return " ".join(
        [
            _named_region_prefix(m),
            _named_region_branch(m, whole_unit, False, ctx=ctx),
            _named_region_branch(m, whole_unit, True, ctx=ctx),
        ]
    )


def _describe_named_region_conditional(
    m: dict[str, Any], condition: Condition, ctx: Ctx | None = None
) -> str:
    consumer = m.get("consumer") or {}
    membership = consumer.get("membership") or {}
    whole_unit = membership.get("unit_scope") == "whole-unit"
    positive = {**condition, "negated": False}
    predicate = describe_condition(positive)
    default = _named_region_branch(m, whole_unit, False, True, ctx)
    qualified = _named_region_branch(m, whole_unit, True, True, ctx)
    if condition.get("negated"):
        return (
            f"{_named_region_prefix(m)} Unless {predicate}, {default}. If {predicate}, {qualified}."
        )
    return f"{_named_region_prefix(m)} When {predicate}, {qualified}. Otherwise, {default}."


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
        # GW frames this lever by its effect on Desperate Escape tests: suppressing
        # Ordered Retreat forces the tests; granting it (e.g. while Battle-shocked)
        # exempts the unit. Mirrors the `desperate-escape` slug wording.
        return (
            f"{subj} {_v(subj, 'is')} not affected by Desperate Escape tests"
            if granted
            else f"{subj} must take Desperate Escape tests"
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


def _or_list(items: list[str]) -> str:
    """Oxford-free disjunction list ("a", "a or b", "a, b or c")."""
    if len(items) <= 1:
        return items[0] if items else ""
    if len(items) == 2:
        return f"{items[0]} or {items[1]}"
    return f"{', '.join(items[:-1])} or {items[-1]}"


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
            parts.append(" and ".join(_PASSTHROUGH_PHRASE.get(p, dekebab(p)) for p in passthrough))
        if parts:
            over = (
                f' (up to {_jstr(m["vertical_limit"])}" high)'
                if m.get("vertical_limit") is not None
                else ""
            )
            clause = (
                f"{subj} can move over {' and '.join(parts)}{over} as though they were not there"
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
        return f"add {_dice_case(_jstr(dist))} to {_of_or_possessive(subj, 'Advance rolls')}"
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
        return f'{_of_or_possessive(subj, "Move characteristic")} is reduced by {abs_n}"'
    if move_kinds:
        return f"add{inches} to {_of_or_possessive(subj, f'{move_kinds} moves')}"
    return f"{subj} can make a Normal move{of_up_to}"


def _keyword_filter_clause(value: Any, noun: str) -> str:
    if not isinstance(value, dict):
        return noun
    required = " and ".join(_jstr(k) for k in value.get("required_keywords") or [])
    excluded = " or ".join(_jstr(k) for k in value.get("excluded_keywords") or [])
    return (
        f"{noun}{f' with {required}' if required else ''}"
        f"{f' without {excluded}' if excluded else ''}"
    )


def _aura_clause(e: Effect, m: dict[str, Any], ctx: Ctx) -> str:
    """Generic aura ``modifier`` -> one lowercase-initial clause."""
    # Range-extension of a named aura (e.g. Gift of Poxes: contagion +3").
    if m.get("range_bonus") is not None:
        named = f"{_title_case(_jstr(m['of']))} " if m.get("of") is not None else ""
        return (
            f"the range of this model's {named}abilities "
            f'is increased by {_jstr(m["range_bonus"])}"'
        )
    rng = m.get("range")
    if isinstance(rng, list):
        range_text: str | None = "/".join(f'{_jstr(r)}"' for r in rng) + " (by battle round)"
    elif rng is not None:
        range_text = f'{_jstr(rng)}"'
    else:
        range_text = None
    who = _aura_recipient(e)
    recipient = _keyword_filter_clause(m.get("recipient_filter"), who)
    within = f"{recipient} within {range_text}" if range_text is not None else recipient
    filtered = m.get("emitter_filter") is not None or m.get("recipient_filter") is not None
    if m.get("effect") is not None:
        use_selected = m.get("eligible") is not None or filtered
        inner_ctx = {**ctx, "selected_unit": True} if use_selected else dict(ctx)
        nested = describe_effect_inline(m["effect"], inner_ctx)
        nested_subject = re.sub(r"^the unit\b\s*", "", nested)
        effect_text = f", and each such unit {nested_subject}" if filtered else f" {nested}"
    else:
        effect_text = ", and each such unit is affected" if filtered else " is affected"
    if m.get("emitter_filter") is not None:
        emitter = _keyword_filter_clause(m["emitter_filter"], "this model")
        return f"{emitter} projects an aura to {within}{effect_text}"
    return f"{within}{effect_text}"


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
        scope = (
            f" for {_jstr(m['weapon_type'])} weapons"
            if m.get("weapon_type")
            else f" ({_jstr(m['attack_type'])})"
            if m.get("attack_type")
            else ""
        )
        if m.get("stat") is None:
            return f"modify {_of_or_possessive(subj, 'characteristics')}{scope}"
        if m.get("operation") == "set":
            stat = _stat_name(m["stat"])
            set_val = _jstr(m.get("value"))
            return f"modify {_of_or_possessive(subj, f'{stat} characteristic')} to {set_val}{scope}"
        if m.get("operation") == "improve":
            stat_of = _of_or_possessive(subj, f"{_stat_name(m['stat'])} characteristic")
            return f"improve {stat_of} by {_jstr(m.get('value'))}{scope}"
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
        stat_of = _of_or_possessive(subj, f"{_stat_name(m['stat'])} characteristic")
        return f"{verb} {_jstr(val)} {prep} {stat_of}{scope}"
    if etype == "roll-modifier":
        roll_value = m.get("roll", m.get("test"))
        ctx_note = f" ({_jstr(m['context'])})" if m.get("context") else ""
        roll = _roll_name(roll_value)
        if m.get("critical_on") is not None:
            crit = "Critical Wounds" if roll_value == "wound" else "Critical Hits"
            crit_on = _jstr(m["critical_on"])
            return f"{subj} {_v(subj, 'scores')} {crit} on {roll} rolls of {crit_on}+"
        if m.get("operation") == "set":
            return f"{subj} can change {roll} rolls to a {_jstr(m.get('value'))}"
        if m.get("value") is None:
            op = dekebab(_jstr(m.get("operation")))
            return f"{op} {_of_or_possessive(subj, f'{roll} rolls')}{ctx_note}"
        sgn = _signed(m.get("operation"), m["value"])
        return f"{subj} {_v(subj, 'gets')} {sgn} to {roll} rolls{ctx_note}"
    if etype == "re-roll":
        if _jstr(m.get("roll")) == "any":
            which = "any roll of 1" if m.get("subset") == "ones" else "any roll"
        else:
            noun = _roll_name(m.get("roll"))
            which = f"a {noun} roll of 1" if m.get("subset") == "ones" else f"the {noun} roll"
        # An attack_type scopes the re-roll to melee/ranged attacks (Black
        # Rage's melee hit re-rolls); weapon_type keeps its wording precedence.
        if m.get("weapon_type"):
            weapon = f" with {_jstr(m['weapon_type'])} weapons"
        elif m.get("attack_type") is not None and m.get("attack_type") != "any":
            weapon = f" for {_jstr(m['attack_type'])} attacks"
        else:
            weapon = ""
        return f"you can re-roll {which}{weapon}"
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
        if m.get("bind_count_as") is not None:
            bound_dice = _dice_case(m.get("count") if m.get("count") is not None else m.get("dice"))
            return f"roll one {bound_dice}: {subj_mw} {verb} that many mortal wounds"
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
        # Escalating table ("on a 2-3, 1 mortal wound; on a 4-5, D3 ..."): the
        # roll decides the amount, so render the rows, not "a number of".
        table = m.get("amount_table") or m.get("table")
        if isinstance(table, list) and table:
            rows = []
            for idx, r in enumerate(table):
                amt = _dice_case(r.get("amount"))
                noun = "mortal wound" if amt == "1" else "mortal wounds"
                if idx == 0:
                    rows.append(f"on a {_jstr(r.get('roll'))}, {subj_mw} {verb} {amt} {noun}")
                else:
                    rows.append(f"on a {_jstr(r.get('roll'))}, {amt} {noun}")
            dice = m.get("dice") if m.get("dice") is not None else "D6"
            return f"roll one {_dice_case(dice)}: " + "; ".join(rows)
        if m.get("count") is not None:
            a: str | None = _jstr(m.get("count"))
        elif m.get("amount") is not None:
            a = _jstr(m.get("amount"))
        elif m.get("dice") is not None:
            a = _dice_case(m.get("dice"))
        else:
            a = None
        if a is None and m.get("trigger") is not None:
            trig = _title_case(_jstr(m.get("trigger")))
            return f"when this model is destroyed, {subj_mw} {verb} mortal wounds ({trig})"
        amt = a if a is not None else "?"
        noun = "mortal wound" if amt == "1" else "mortal wounds"
        return f"{subj_mw} {verb} {amt} {noun}"
    if etype == "feel-no-pain":
        vs = _FNP_SCOPES.get(_jstr(m.get("scope")), "")
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
            return f"{_of_or_possessive(subj, _jstr(m['weapon_name']))} gains {kw}"
        if m.get("weapon_type") is not None:
            weapon_type = _jstr(m["weapon_type"])
            return f"{_of_or_possessive(subj, f'{weapon_type} weapons')} gain {kw}"
        return f"{_of_or_possessive(subj, 'weapons')} gain {kw}"
    if etype == "ability-grant":
        grant = m.get("grant_type")
        if grant is None:
            grant = m.get("ability_id")
        # Reserves-arrival grant slugs read as full clauses in GW voice — the
        # generic "gains the X ability" form would bury the mechanic in a name.
        g = _jstr(grant)
        if g == "must-start-in-reserves":
            return f"{subj} must start the battle in Reserves"
        if g == "reinforcement-any-of-turns-1-to-3":
            return (
                f"{subj} can be set up in the Reinforcements step of your first, second"
                " or third Movement phase, regardless of any mission rules"
            )
        if g == "reserves-limit-exempt":
            return (
                f"{subj} {_v(subj, 'is')} not counted towards any limits on the number"
                " of units that can start the battle in Reserves"
            )
        if g == "reserves-limit-exempt-with-cargo":
            return (
                f"neither {subj} nor any units embarked within it are counted"
                " towards any limits on the number of units that can start the battle in Reserves"
            )
        if g == "may-start-in-reserves":
            return f"{subj} can start the battle in Reserves"
        if g == "battle-round-plus-one-for-arrival":
            return (
                f"{subj} {_v(subj, 'treats')} the current battle round number as being"
                " one higher than it actually is when arriving from Reserves"
            )
        if g == "flavor-text":
            return "this ability is a descriptive note (no additional rules effect)"
        if g == "crew-tokens":
            token_count = _jstr(m.get("count") if m.get("count") is not None else 1)
            token = (
                f"{_jstr(m.get('token_name'))} tokens"
                if m.get("token_name") is not None
                else "Crew tokens"
            )
            being = "they are" if _pronoun(subj) == "their" else "it is"
            return (
                f"place {token_count} {token} next to {subj} when {being} first set up,"
                f" removing one each time {subj} {_v(subj, 'loses')} a wound (the model"
                f" itself represents {_pronoun(subj)} final wound)"
            )
        cap = f" ({_jstr(m['capacity'])})" if m.get("capacity") is not None else ""
        # A grant's `timing` modifier scopes when the granted ability applies.
        when = f"{describe_timing(_jstr(m['timing']))}, " if m.get("timing") is not None else ""
        if grant is not None:
            return f"{when}{subj} {_v(subj, 'gains')} the {_grant_label(_jstr(grant))} ability{cap}"
        return f"{when}{subj} {_v(subj, 'gains')} an ability{cap}"
    if etype == "movement-modifier":
        return _movement_clause(m, subj)
    if etype == "aura":
        return _aura_clause(e, m, ctx)
    if etype == "damage-reduction":
        r = _jstr(
            m.get("reduction")
            if m.get("reduction") is not None
            else m.get("amount")
            if m.get("amount") is not None
            else m.get("value")
        )
        if r == "half":
            how = "halve the Damage of that attack"
        elif r == "to-zero":
            how = "reduce the Damage of that attack to 0"
        else:
            how = f"reduce the Damage of that attack by {r}"
        return f"each time an attack targets {subj}, {how}"
    if etype == "resurrection":
        count = _dice_case(m.get("count")) if m.get("count") is not None else "1"
        # `type: "wounds"` is a heal (regained wounds), not a revive.
        if m.get("type") == "wounds" or m.get("wounds") is not None:
            if m.get("count_from") is not None:
                healed = "that many"
            else:
                healed = _dice_case(m.get("wounds")) if m.get("wounds") is not None else count
            noun = "lost wound" if healed == "1" else "lost wounds"
            return f"{subj} {_v(subj, 'regains')} up to {healed} {noun}"
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
    if etype == "recovery-pool":
        recipient = (
            "independently for each friendly unit"
            if e.get("target") == "all-friendly" and m.get("per_target_unit") is True
            else f"for {subj}"
        )
        return (
            f"roll {_dice_case(m.get('dice'))} recovery points {recipient}, "
            "first using them to regain lost wounds on wounded models and then using any remaining "
            "points to return destroyed models to the unit with 1 wound remaining, stopping when "
            "the unit is at full strength and all its models have their full wounds; "
            "any unallocated points are lost"
        )
    if etype == "model-destruction":
        count = _dice_case(m.get("count")) if m.get("count") is not None else "1"
        noun = "model" if count == "1" else "models"
        return f"destroy {count} {noun} in {subj}"
    if etype == "named-region-state":
        return _describe_named_region_state(m, ctx)
    if etype == "rule-state":
        return _describe_rule_state(m, subj)
    if etype == "pool-add-die":
        pool_label = _pool_name(m.get("pool_id"))
        rolled = m.get("value") == "rolled"
        per_pool = m.get("count_per_pool")
        if per_pool is not None:
            # One die per point currently in the counting pool (Icon of Khorne).
            per_label = _pool_name(per_pool)
            per_plural = per_label if per_label.endswith("s") else f"{per_label}s"
            if rolled:
                die = "one rolled D6"
            elif m.get("value") == "highest":
                die = "one die showing the highest result"
            else:
                die = f"one die showing {_jstr(m.get('value'))}"
            lost = f", after which all your {per_plural} are lost" if m.get("consumes_pool") else ""
            return f"add {die} to your {pool_label} for each {per_label} you have{lost}"
        cnt = _dice_case(m.get("count")) if m.get("count") is not None else "1"
        if rolled:
            dice = "a rolled D6" if cnt == "1" else f"{cnt} rolled D6"
            return f"add {dice} to your {pool_label}"
        shown_val = "the highest result" if m.get("value") == "highest" else _jstr(m.get("value"))
        dice = "a die" if cnt == "1" else f"{cnt} dice"
        return f"add {dice} showing {shown_val} to your {pool_label}"
    if etype == "replace-roll-from-pool":
        raw_rolls = m.get("rolls")
        rolls = [dekebab(_jstr(r)) for r in raw_rolls] if isinstance(raw_rolls, list) else []
        return (
            f"discard a die from your {_pool_name(m.get('pool_id'))} "
            f"and substitute its value for a {_or_list(rolls)} roll"
        )
    if etype == "cp-gain":
        return f"you gain {_jstr(m.get('amount') if m.get('amount') is not None else 1)}CP"
    if etype == "cp-on-destroy":
        kw = (
            f"{_jstr(m['enemy_keyword'])} model"
            if m.get("enemy_keyword") is not None
            else "enemy model"
        )
        who = "this model's unit" if subj == "this model" else subj
        amount = m.get("amount") if m.get("amount") is not None else 1
        return f"each time {who} destroys a {kw}, you gain {_jstr(amount)}CP"
    if etype == "battle-shock-test":
        die = _dice_case(m.get("dice"))
        return f"{subj} {_v(subj, 'takes')} Battle-shock tests on {die} instead of 2D6"
    if etype == "flyover":
        hit = _pool_threshold(_jstr(m.get("comparison") or "gte"), m.get("threshold"))
        per = _jstr(m.get("mortal_wounds") if m.get("mortal_wounds") is not None else 1)
        per_noun = "mortal wound" if per == "1" else "mortal wounds"
        return (
            f"each time this model ends a Normal move, select one enemy unit it moved over "
            f"and roll {_dice_case(m.get('dice'))}: for each {hit}, that unit suffers "
            f"{per} {per_noun}"
        )
    if etype == "cp-refund":
        if m.get("stratagem") is not None:
            strat = f"the {_title_case(_jstr(m.get('stratagem')))} Stratagem"
        else:
            strat = "one Stratagem"
        return f"you can use {strat} on {subj} for 0CP"
    if etype == "stratagem-targeting-permission":
        return f"{subj} can be targeted with Stratagems even while Battle-shocked"
    if etype == "modifier-immunity":
        scope = _jstr(m.get("scope"))
        if scope == "enemy-stratagems":
            return f"{subj} cannot be affected by enemy Stratagems"
        if scope == "enemy-abilities":
            return f"{subj} cannot be affected by enemy abilities"
        exclude = m.get("exclude")
        if isinstance(exclude, list) and exclude:
            names = " and ".join(_stat_name(s) for s in exclude)
            exc = f" (except {names})"
        else:
            exc = ""
        return (
            f"{subj} {_v(subj, 'ignores')} any modifiers to {_pronoun(subj)} characteristics{exc}"
        )
    if etype == "stratagem-cost-modifier":
        if m.get("stratagem") is not None:
            which = f"the {_title_case(_jstr(m.get('stratagem')))} Stratagem"
        else:
            which = "Stratagems"
        whose = (
            f"used by {subj}"
            if m.get("applies_to") == "stratagems-used-by-bearer"
            else f"that target {subj}"
        )
        verb = "costs" if m.get("stratagem") is not None else "cost"
        if m.get("operation") == "set-to":
            val = f"{_jstr(m.get('set_to'))}CP"
        else:
            amount = m.get("amount") if m.get("amount") is not None else 1
            val = f"{_jstr(amount)} more CP"
        return f"{which} {whose} {verb} {val}"
    if etype == "targeting-permission":
        at = "ranged attacks" if m.get("attack_type") == "ranged" else "attacks"
        r = f'{_jstr(m.get("range"))}"' if m.get("range") is not None else "?"
        gate_val = _jstr(m.get("gate"))
        if gate_val == "within-range":
            gate = f"the attacking unit is within {r}"
        elif gate_val == "closest-eligible":
            gate = "it is the closest eligible target"
        elif gate_val == "closest-or-within-range":
            gate = f"it is the closest eligible target or the attacking unit is within {r}"
        else:
            gate = dekebab(gate_val)
        return f"{subj} can only be selected as the target of {at} if {gate}"
    if etype == "resource-gain":
        if m.get("count_mode") == "by-battle-size" or m.get("count_by_battle_size") is not None:
            return (
                f"you gain {_resource_noun(m)} based on the current battle size "
                "(see the accompanying table)"
            )
        amount = m.get("amount") if m.get("amount") is not None else m.get("value")
        return f"you gain {_jstr(amount)} {_resource_noun(m, amount)}"
    if etype == "resource-spend":
        amount = m.get("amount") if m.get("amount") is not None else m.get("value")
        base = f"spend {_jstr(amount)} {_resource_noun(m, amount)}"
        cap_obj = m.get("cap")
        if (
            isinstance(cap_obj, dict)
            and cap_obj.get("count") is not None
            and cap_obj.get("per") is not None
        ):
            count = _jstr(cap_obj.get("count"))
            per = _jstr(cap_obj.get("per"))
            return f"{base} (no more than {count} per {per})"
        return base
    if etype == "resource-clear":
        scope = "all" if m.get("scope") == "all" else "all unspent"
        return f"{scope} {_resource_noun(m, 2)} are lost"
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
        return f"modify {_of_or_possessive(subj, 'Leadership characteristic')}"
    if etype == "fight-first":
        return f"{subj} {_v(subj, 'has')} the Fights First ability"
    if etype == "fight-last":
        return f"{subj} {_v(subj, 'has')} the Fights Last ability"
    if etype == "fight-on-death":
        if subj == "this model":
            return "each time this model is destroyed, it can fight before being removed from play"
        return (
            f"each time a model in {subj} is destroyed, it can fight before being removed from play"
        )
    if etype == "shoot-on-death":
        if subj == "this model":
            return "each time this model is destroyed, it can shoot before being removed from play"
        return (
            f"each time a model in {subj} is destroyed, it can shoot before being removed from play"
        )
    if etype == "unit-keyword":
        name = _title_case(_jstr(m.get("keyword_id")))
        val = f" {_jstr(m.get('value'))}" if m.get("value") is not None else ""
        return f"{subj} {_v(subj, 'has')} the {name}{val} ability"
    if etype == "unit-keyword-grant":
        # Without a `to_keywords` filter the grant lands on the effect subject.
        if m.get("to_keywords") is not None:
            return f"{_jstr(m.get('to_keywords'))} units gain the {_jstr(m.get('keyword'))} keyword"
        return f"{subj} {_v(subj, 'gains')} the {_jstr(m.get('keyword'))} keyword"
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
            return f"{_of_or_possessive(subj, f'{roll} rolls')} automatically succeed"
        if res == "fail":
            return f"{_of_or_possessive(subj, f'{roll} rolls')} automatically fail"
        return f"{_of_or_possessive(subj, f'{roll} rolls')} count as {_jstr(res)}"
    if etype == "firing-deck":
        return f"{subj} {_v(subj, 'has')} Firing Deck {_jstr(m.get('value'))}"
    if etype == "disembark":
        where = (
            f' and be set up wholly within {_jstr(m.get("distance"))}" of the transport'
            if m.get("distance") is not None
            else ""
        )
        eng = (
            ", even within Engagement Range of enemy units"
            if m.get("allow_engagement_range")
            else ""
        )
        return f"{subj} can disembark{where}{eng}"
    if etype == "disembark-after-move":
        if m.get("after") is None:
            return f"units can disembark from {subj} after it has moved"
        who = (
            f"units with the {_title_case(_jstr(m.get('requires_keyword')))} ability"
            if m.get("requires_keyword") is not None
            else "units"
        )
        after = m.get("after")
        if after == "advance":
            when = "after it has Advanced"
        elif after == "deployment":
            when = "after it has been set up on the battlefield"
        elif after == "before-move":
            when = "before it moves"
        else:
            when = "after it has made a Normal move"
        # `mandatory`: a Reserves-transport whose cargo MUST disembark on arrival.
        verb = "must immediately disembark" if m.get("mandatory") else "can disembark"
        away = (
            f', and must be set up more than {_jstr(m["min_enemy_distance"])}" away'
            " from all enemy models"
            if m.get("min_enemy_distance") is not None
            else ""
        )
        counts = (
            "; such units count as having made a Normal move"
            if m.get("counts_as_normal_move")
            else ""
        )
        # A deployment-step disembark has no meaningful charge window; only an
        # explicit `can_charge` renders the charge tail there.
        if m.get("can_charge"):
            charge = ", and are still eligible to declare a charge this turn"
        elif after == "deployment" and m.get("can_charge") is None:
            charge = ""
        else:
            charge = ", but cannot declare a charge this turn"
        return f"{who} {verb} from {subj} {when}{away}{counts}{charge}"
    if etype == "unit-attachment":
        if m.get("mandatory"):
            return f"{subj} must be attached to a Leader, or it counts as destroyed"
        led = (
            f" led by a {_title_case(_jstr(m.get('led_by')))} model"
            if m.get("led_by") is not None
            else ""
        )
        return (
            "at the start of the Declare Battle Formations step, "
            f"{subj} can join one friendly unit{led}, becoming part of that Bodyguard unit"
        )
    if etype == "fallback-and-act":
        acts = "shoot and declare a charge" if m.get("can_charge") is True else "shoot"
        return f"{subj} {_v(subj, 'is')} eligible to {acts} in a turn in which it Fell Back"
    if etype == "fight-eligibility-extension":
        r = _jstr(m.get("range"))
        return (
            f"when determining which models in {subj} are eligible to fight, "
            f'models within {r}" of one or more enemy models are eligible '
            f'and can target enemy units within {r}"'
        )
    if etype == "engagement-passthrough":
        if m.get("no_end_in_engagement"):
            base = (
                f"{subj} can move through enemy models, but cannot end that move "
                "within Engagement Range of any enemy unit"
            )
        else:
            base = f"{subj} can move through enemy models"
        if isinstance(m.get("applies_to_moves"), list) and m["applies_to_moves"]:
            move_kinds = _and_list([_MOVE_NOUN.get(x, dekebab(x)) for x in m["applies_to_moves"]])
            return f"{base}, during its {move_kinds} moves"
        return base
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
        # An absolute set (Black Rage's OC 0) mirrors stat-modifier's wording.
        if m.get("operation") == "set":
            oc_of = _of_or_possessive(subj, "Objective Control characteristic")
            return f"modify {oc_of} to {_jstr(m.get('value'))}"
        if m.get("operation") is not None:
            sgn = _signed(m["operation"], m.get("value"))
            pron = _pronoun(subj)
            return f"{subj} {_v(subj, 'gets')} {sgn} to {pron} Objective Control characteristic"
        return f"modify {_of_or_possessive(subj, 'Objective Control characteristic')}"
    if etype == "bs-modifier":
        sgn = _signed(m.get("operation"), m.get("value"))
        return f"{subj} {_v(subj, 'gets')} {sgn} to Ballistic Skill"
    if etype == "charge-roll-modifier":
        sgn = _signed(m.get("operation"), m.get("value"))
        return f"{subj} {_v(subj, 'gets')} {sgn} to Charge rolls"
    if etype == "terrain-area-tag":
        if m.get("tag") is None:
            return "the terrain area is marked"
        return f"the terrain area is marked as {dekebab(_jstr(m.get('tag')))}"
    if etype == "objective-tag":
        if m.get("tag") is None:
            return "the objective is marked"
        return f"the objective is marked as {dekebab(_jstr(m.get('tag')))}"
    if etype == "unit-tag":
        if m.get("tag") is None:
            return f"{subj} {_v(subj, 'is')} marked"
        return f"{subj} {_v(subj, 'is')} marked as {dekebab(_jstr(m.get('tag')))}"

    # Container types — inline forms.
    if etype == "conditional":
        inner = e.get("effect") or {}
        if inner.get("type") == "named-region-state":
            return _describe_named_region_conditional(
                inner.get("modifier") or {}, e.get("condition") or {}, ctx
            )
        lead = _condition_lead_in(e.get("condition") or {})
        return f"{lead}, {describe_effect_inline(inner, ctx)}"
    if etype == "sequence":
        return "; ".join(describe_effect_inline(s, ctx) for s in e.get("steps") or [])
    if etype == "choice":
        prompt = e.get("choice_prompt") or (
            f"select one of the following ({_title_case(e['choice_label'])})"
            if e.get("choice_label")
            else "select one of the following"
        )
        options = " / ".join(describe_effect_inline(o, ctx) for o in e.get("options") or [])
        return f"{prompt}: {options}"
    if etype == "dice-gated":
        comp = _format_comparison(e.get("comparison") or "gte", e.get("threshold"))
        on_success = e.get("on_success")
        success = describe_effect_inline(on_success, ctx) if on_success else "nothing happens"
        on_fail = e.get("on_fail")
        fail = f"; otherwise, {describe_effect_inline(on_fail, ctx)}" if on_fail else ""
        return f"roll one {_dice_case(e.get('dice'))}: on {comp}, {success}{fail}"
    if etype == "dice-pool-allocation":
        pool = e.get("pool")
        pool_text = f"{_jstr(pool['count'])}{_jstr(pool['die'])}" if pool else "your dice pool"
        opts = " / ".join(
            f"{_jstr(o.get('name'))} (requires {_describe_requirement(o.get('requirement'))}): "
            f"{describe_effect_inline(o.get('effect') or {}, ctx)}"
            for o in e.get("options") or []
        )
        return f"roll {pool_text}: {opts}"
    if etype == "for-each-unit":
        inner_ctx = {**ctx, "selected_unit": True}
        return (
            f"for each {_for_each_unit_subject(e.get('selector'))}: "
            f"{describe_effect_inline(e.get('effect') or {}, inner_ctx)}"
        )
    if etype == "select-units":
        return _select_units_inline(e.get("selector"), e.get("effect") or {}, ctx)
    if etype == "leader-model-ability-grant":
        return _leader_model_ability_grant_clause(e, ctx)
    if etype == "persistent-designation":
        if not _persistent_designation_supported(e):
            return "[persistent-designation]"
        consumer = e.get("consumer") or {}
        return (
            f"{_persistent_designation_lead(e)} {_persistent_designation_when(e)}, "
            f"{describe_effect_inline(consumer.get('effect') or {}, ctx)}"
        )
    if etype == "designate-target":
        sel_raw = e.get("select")
        sel = sel_raw if isinstance(sel_raw, dict) else {}
        scope_noun = "friendly" if sel.get("scope") == "friendly-unit" else "enemy"
        desig = _designation_label(e["designation"]) if e.get("designation") else ""
        timing = sel.get("timing")
        select_lead = f"{describe_timing(timing)}, select" if timing else "select"
        _, dur_trail = _duration_clauses(e.get("duration"))
        applies = e.get("applies") or {}
        when = (
            "while it is your target"
            if applies.get("to") == "target"
            else "each time a friendly unit attacks it"
        )
        when_clause = f"{dur_trail}, {when}" if dur_trail else when
        inner = describe_effect_inline(applies.get("effect") or {}, ctx)
        return f"{select_lead} one {scope_noun} unit{desig}; {when_clause}, {inner}"
    if etype == "stance-select":
        opts = " / ".join(
            f"{_jstr(o.get('name'))} ({describe_effect_inline(o.get('effect') or {}, ctx)})"
            for o in e.get("options") or []
        )
        return f"select one: {opts}"
    if etype == "risk-reward":
        risk = e.get("risk") or {}
        on_fail = risk.get("on_fail")
        fail_txt = describe_effect_inline(on_fail, ctx) if on_fail else "suffer a consequence"
        reward = describe_effect_inline(e.get("reward") or {}, ctx)
        return (
            f"take a {_test_name(risk.get('test'))} test (on a failure, {fail_txt}), then {reward}"
        )
    if etype == "issue-orders":
        names = " / ".join(_jstr(o.get("name")) for o in e.get("options") or [])
        return f"issue Orders, each one of: {names}"

    if etype == "resource-action-menu":
        actions = " / ".join(_describe_menu_action(a, ctx) for a in e.get("actions") or [])
        return f"actions may be performed when their conditions are met: {actions}"

    return f"[{etype if etype is not None else 'unknown'}]"


def describe_effect(e: Effect, depth: int = 0, ctx: Ctx | None = None) -> str:
    """Block translation of a *container* effect tree (multi-line, indented)."""
    ctx = ctx or {}
    indent = "  " * depth
    arrow = "-> " if depth > 0 else ""
    etype = e.get("type")

    if etype == "conditional":
        inner = e.get("effect") or {}
        if inner.get("type") == "named-region-state":
            text = _capitalize(
                _describe_named_region_conditional(
                    inner.get("modifier") or {}, e.get("condition") or {}, ctx
                )
            )
            return f"{indent}{arrow}{text if text.endswith('.') else text + '.'}"
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
        prompt = e.get("choice_prompt") or (
            f"select one of the following ({_title_case(e['choice_label'])})"
            if e.get("choice_label")
            else "select one of the following"
        )
        options = "\n".join(
            f"{indent}  - {_capitalize(describe_effect_inline(o, ctx))}."
            for o in e.get("options") or []
        )
        return f"{indent}{_capitalize(prompt)}:\n{options}"
    if etype == "dice-gated":
        comp = _format_comparison(e.get("comparison") or "gte", e.get("threshold"))
        on_success = e.get("on_success")
        success = describe_effect_inline(on_success, ctx) if on_success else "nothing happens"
        on_fail = e.get("on_fail")
        fail = f"; otherwise, {describe_effect_inline(on_fail, ctx)}" if on_fail else ""
        return f"{indent}{arrow}Roll one {_dice_case(e.get('dice'))}: on {comp}, {success}{fail}."
    if etype == "dice-pool-allocation":
        pool = e.get("pool")
        pool_text = f"{_jstr(pool['count'])}{_jstr(pool['die'])}" if pool else "your dice pool"
        max_act = e.get("max_activations")
        up_to = (
            f" to activate up to {_jstr(max_act)} of the following"
            if max_act is not None
            else " to activate the following"
        )
        lines = [f"{indent}{arrow}Roll {pool_text}; allocate dice{up_to}:"]
        for opt in e.get("options") or []:
            lines.append(
                f"{indent}  - {_jstr(opt.get('name'))} "
                f"(requires {_describe_requirement(opt.get('requirement'))}): "
                f"{describe_effect_inline(opt.get('effect') or {}, ctx)}."
            )
        return "\n".join(lines)
    if etype == "select-units":
        selector = e.get("selector") or {}
        inner = e.get("effect") or {}
        inner_ctx = {**ctx, "selected_unit": True}
        engagement = _select_units_engagement(selector)
        lead = f"Select {_select_units_subject(selector)}"
        header = f"{indent}{arrow}{lead}. {engagement}" if engagement else f"{indent}{arrow}{lead}"
        if inner.get("type") in _CONTAINER_TYPES:
            count = selector.get("count", selector.get("max_count", 0))
            if count > 1:
                nested = describe_effect(inner, depth + 2, inner_ctx)
                return f"{header}:\n{indent}  -> For each selected unit:\n{nested}"
            return f"{header}:\n" + describe_effect(inner, depth + 1, inner_ctx)
        nested = _selected_recipient(describe_effect_inline(inner, inner_ctx), selector)
        return f"{header} {_capitalize(nested)}." if engagement else f"{header}: {nested}."
    if etype == "leader-model-ability-grant":
        text = _capitalize(_leader_model_ability_grant_clause(e, ctx))
        return f"{indent}{arrow}{text}."
    if etype == "persistent-designation":
        if not _persistent_designation_supported(e):
            return f"{indent}{arrow}[persistent-designation]."
        consumer = e.get("consumer") or {}
        inner = consumer.get("effect") or {}
        lead = _capitalize(_persistent_designation_lead(e))
        head = f"{indent}{arrow}{lead} {_persistent_designation_when(e)}"
        if inner.get("type") in _CONTAINER_TYPES:
            return f"{head}:\n" + describe_effect(inner, depth + 1, ctx)
        return f"{head}, {describe_effect_inline(inner, ctx)}."
    if etype == "for-each-unit":
        inner = e.get("effect") or {}
        inner_ctx = {**ctx, "selected_unit": True}
        lead = f"For each {_for_each_unit_subject(e.get('selector'))}"
        if inner.get("type") in _CONTAINER_TYPES:
            return f"{indent}{lead}:\n" + describe_effect(inner, depth + 1, inner_ctx)
        return f"{indent}{lead}: {_capitalize(describe_effect_inline(inner, inner_ctx))}."
    if etype == "designate-target":
        sel_raw = e.get("select")
        sel = sel_raw if isinstance(sel_raw, dict) else {}
        scope_noun = "friendly" if sel.get("scope") == "friendly-unit" else "enemy"
        desig = _designation_label(e["designation"]) if e.get("designation") else ""
        applies = e.get("applies") or {}
        inner = applies.get("effect") or {}
        # The mark's timing and duration are content: "After this unit shoots,
        # select .... Until your next Command phase, each time ...".
        timing = sel.get("timing")
        select_lead = f"{_capitalize(describe_timing(timing))}, select" if timing else "Select"
        _, dur_trail = _duration_clauses(e.get("duration"))
        when = (
            "while it is your target"
            if applies.get("to") == "target"
            else "each time a friendly unit makes an attack against it"
        )
        when_clause = f"{_capitalize(dur_trail)}, {when}" if dur_trail else _capitalize(when)
        head = f"{indent}{arrow}{select_lead} one {scope_noun} unit{desig}. {when_clause}"
        if inner.get("type") in _CONTAINER_TYPES:
            return f"{head}:\n" + describe_effect(inner, depth + 1, ctx)
        return f"{head}, {describe_effect_inline(inner, ctx)}."
    if etype == "stance-select":
        select = e.get("select")
        when = (
            _capitalize(event_clause(select))
            if isinstance(select, str)
            else "At the start of your turn"
        )
        consum = " (each may be chosen once per battle)" if e.get("mode") == "consumable" else ""
        lines = [f"{indent}{arrow}{when}, select one{consum}:"]
        for opt in e.get("options") or []:
            lines.append(
                f"{indent}  - {_jstr(opt.get('name'))}: "
                f"{describe_effect_inline(opt.get('effect') or {}, ctx)}."
            )
        return "\n".join(lines)
    if etype == "risk-reward":
        risk = e.get("risk") or {}
        on_fail = risk.get("on_fail")
        on_fail_txt = describe_effect_inline(on_fail, ctx) if on_fail else "there is a consequence"
        reward = describe_effect_inline(e.get("reward") or {}, ctx)
        return (
            f"{indent}{arrow}First take a {_test_name(risk.get('test'))} test — "
            f"on a failure, {on_fail_txt}; then {reward}."
        )
    if etype == "issue-orders":
        n = _jstr(e.get("count")) if e.get("count") is not None else "one or more"
        rng = f' within {_jstr(e["range"])}"' if e.get("range") is not None else ""
        eligible = e.get("eligible") or {}
        elig = f" {_jstr(eligible['keyword'])}" if eligible.get("keyword") else ""
        lines = [
            f"{indent}{arrow}Issue up to {n} Orders to eligible friendly{elig} units{rng}, "
            "each one of:"
        ]
        for opt in e.get("options") or []:
            lines.append(
                f"{indent}  - {_jstr(opt.get('name'))}: "
                f"{describe_effect_inline(opt.get('effect') or {}, ctx)}."
            )
        return "\n".join(lines)
    if etype == "resource-action-menu":
        su = _shared_usage_clause(e.get("shared_usage"))
        intro = (
            f"Actions may be performed when their conditions are met. {_capitalize(su)}"
            if su
            else "Actions may be performed when their conditions are met"
        )
        lines = [f"{indent}{arrow}{intro}:"]
        for action in e.get("actions") or []:
            lines.append(f"{indent}  - {_describe_menu_action(action, ctx)}")
        return "\n".join(lines)
    # Leaf at block position — a single capitalized sentence.
    return f"{indent}{arrow}{_capitalize(describe_effect_inline(e, ctx))}."


def describe_scope(s: dict[str, Any] | None) -> str:
    """``Scope: aura (6"). Duration: phase.`` — retained for the legacy translate CLI footer."""
    if not s or (not s.get("range") and not s.get("duration")):
        return ""
    range_ = dekebab(s.get("range") or "")
    inches = f' ({_jstr(s["range_inches"])}")' if s.get("range_inches") is not None else ""
    duration_value = s.get("duration") or ""
    duration = (
        "until the start of the next battle round"
        if duration_value == "until-next-battle-round"
        else dekebab(duration_value)
    )
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


def _normalize_triggers(t: Any) -> list[dict[str, Any]]:
    """Normalize the polymorphic trigger field to a flat list (empty when absent)."""
    if t is None:
        return []
    return list(t) if isinstance(t, list) else [t]


def _timing_of_condition(c: dict[str, Any] | None) -> str | None:
    """The timing value of a bare ``timing-is`` condition, else None."""
    if c and c.get("type") == "timing-is":
        return _jstr((c.get("parameters") or {}).get("timing"))
    return None


def _condition_within_range(c: dict[str, Any] | None) -> float | int | None:
    """The numeric range of a top-level within-range condition, else None."""
    if not c or c.get("type") not in ("unit-within-range-of", "opponent-unit-within-range"):
        return None
    params = c.get("parameters") or {}
    r = params.get("range")
    if r is None:
        r = params.get("range_inches")
    if r is None:
        r = params.get("within_inches")
    return r if isinstance(r, (int, float)) and not isinstance(r, bool) else None


def _render_top_level(
    e: Effect,
    scope: dict[str, Any] | None,
    usage: dict[str, Any] | None = None,
    trigger: Any = None,
) -> str:
    ctx: Ctx = {
        "range_inches": _aura_radius(scope),
        "engagement_range": (scope or {}).get("range") == "engagement-range",
        "scope_range": (scope or {}).get("range"),
    }
    dur_lead, trail = _duration_clauses((scope or {}).get("duration"))
    # An explicit usage limit supersedes the duration's coarse "once per battle" lead.
    lead = _usage_clause(usage) if usage and usage.get("frequency") is not None else dur_lead

    # A reactive trigger (or several — the ability fires on any) opens the
    # sentence ("Each time ..."). B2: when a trigger's proximity just restates a
    # within-range condition on the effect, render the range once (drop it here).
    triggers = [t for t in _normalize_triggers(trigger) if t.get("event") is not None]
    trigger_events = {t.get("event") for t in triggers}
    cond_range = _condition_within_range(
        e.get("condition") if e.get("type") == "conditional" else None
    )
    trig_parts: list[str] = []
    for t in triggers:
        prox = t.get("proximity") or {}
        if cond_range is not None and prox.get("range") == cond_range:
            t_render = {k: val for k, val in t.items() if k != "proximity"}
        else:
            t_render = t
        s = _describe_trigger(t_render)
        if s:
            trig_parts.append(s)
    trig = " or ".join(trig_parts)

    if e.get("type") == "conditional":
        inner = e.get("effect") or {}
        if inner.get("type") == "named-region-state":
            return _describe_named_region_conditional(
                inner.get("modifier") or {}, e.get("condition") or {}, ctx
            )
        # B1: drop the condition lead-in when it merely restates a trigger's timing
        # (e.g. trigger start-of-phase + condition timing-is start-of-phase).
        cond_timing = _timing_of_condition(e.get("condition"))
        lead_in = (
            ""
            if (cond_timing is not None and cond_timing in trigger_events)
            else _condition_lead_in(e.get("condition") or {})
        )
        if inner.get("type") in _CONTAINER_TYPES:
            header = ", ".join(part for part in (trig, lead, lead_in, trail) if part)
            return _capitalize(header) + ":\n" + describe_effect(inner, 1, ctx)
        return _assemble_sentence([trig, lead, lead_in, trail, describe_effect_inline(inner, ctx)])

    if e.get("type") in _CONTAINER_TYPES:
        # A designate-target carrying its own `duration` renders that duration
        # itself — repeating the scope duration in the head would double it.
        own_duration = (
            e.get("type") in {"designate-target", "persistent-designation"}
            and e.get("duration") is not None
        )
        block = describe_effect(e, 0, ctx)
        head = ", ".join(part for part in (trig, lead or ("" if own_duration else trail)) if part)
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
