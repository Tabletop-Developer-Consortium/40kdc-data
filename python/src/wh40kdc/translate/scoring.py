"""Humanize a ``secondary-card`` scoring ``award`` into plain English.

Output is **ASCII-only** with a fixed clause order, pinned byte-for-byte
across the TS, Rust, and Python ports by the
``conformance/scoring-translation`` corpus. The community ``text`` summary
and the ``actions`` list are verbatim data, not translation, so they are not
produced here — only the structured ``awards``.

Python mirror of ``tools/src/translate/scoring.ts``.
"""

from __future__ import annotations

from typing import Any

from wh40kdc.translate.condition import dekebab, describe_condition


def _capitalize(s: str) -> str:
    return s if s == "" else s[0].upper() + s[1:]


def describe_trigger(t: dict[str, Any]) -> str:
    """ "End of your Command phase (round 2+)" and friends."""
    player_turn = t.get("player_turn")
    if player_turn == "opponent-turn":
        turn = "the opponent's"
    elif player_turn == "either":
        turn = "any"
    else:
        turn = "your"

    timing = t.get("timing")
    phase = t.get("phase")
    if timing == "start-of-turn":
        base = f"Start of {turn} turn"
    elif timing == "end-of-turn":
        base = f"End of {turn} turn"
    elif timing == "start-of-phase":
        base = f"Start of {turn} {_capitalize(phase or '')} phase"
    elif timing == "end-of-phase":
        base = f"End of {turn} {_capitalize(phase or '')} phase"
    elif timing == "end-of-battle":
        base = "End of the battle"
    else:
        base = f"During {turn} {_capitalize(phase)} phase" if phase else "Any time"

    br = t.get("battle_round")
    if br:
        min_ = br.get("min")
        max_ = br.get("max")
        if min_ is not None and max_ is not None:
            base += f" (round {min_})" if min_ == max_ else f" (rounds {min_}-{max_})"
        elif min_ is not None:
            base += f" (round {min_}+)"
        elif max_ is not None:
            base += f" (rounds 1-{max_})"
    return base


def describe_award(a: dict[str, Any]) -> str:
    """ "End of your Command phase (round 2+): 3 VP per controlled objective when ..." """
    trigger = describe_trigger(a["trigger"]) if a.get("trigger") else "Any time"

    if a.get("vp") is not None:
        amount = f"{a['vp']} VP"
    elif a.get("vp_per") is not None:
        per = dekebab(a["per"]) if a.get("per") else "instance"
        amount = f"{a['vp_per']} VP per {per}"
        if a.get("per_max") is not None:
            amount += f" (max {a['per_max']})"
    else:
        amount = "no VP"

    prefix = "+ " if a.get("cumulative") else ""
    when = f" when {describe_condition(a['when'])}" if a.get("when") else ""
    tier = " [highest tier]" if a.get("exclusive_group") else ""
    return f"{prefix}{trigger}: {amount}{when}{tier}"


def describe_scoring_card(card: dict[str, Any]) -> list[str]:
    """Humanize every award on a card, in array order (order is load-bearing)."""
    return [describe_award(a) for a in card.get("awards") or []]
