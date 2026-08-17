"""Card-driven secondary-mission scoring, 10th-edition tactical model.

Drawn secondaries are *held* in hand across rounds and **scored once**: the
player asserts which of a card's awards they achieved, the engine computes
the VP (clamped to the card's cap), records it against the current battle
round, and the card is then discarded.

Deck-level rules the card schema deliberately omits live here as constants —
chiefly the 5 VP-per-card ceiling of the Tactical approach. The Fixed
approach instead uses each award's printed ``vp_max``.

``PlayerGame`` is a plain JSON-serializable dict.

CONFORMANCE: mirrors ``tools/src/scoring/index.ts`` and the Rust
``wh40kdc::scoring`` module, pinned by the ``conformance/scoring`` corpus.
All values are exact integers — no tolerance.
"""

from __future__ import annotations

import math
from typing import Any

#: The Tactical approach caps a single secondary's score at this many VP.
TACTICAL_CARD_CAP = 5
#: Battle rounds in a game.
ROUNDS = 5
#: Per-player VP ceiling (WTC sheet: grand total out of 100).
GAME_VP_CAP = 100

PlayerGame = dict[str, Any]
AssertedAward = dict[str, Any]


def empty_player_game(approach: str = "tactical") -> PlayerGame:
    """A fresh player game for the given approach (defaults to tactical)."""
    return {
        "approach": approach,
        "handIds": [],
        "rounds": [{"primary": 0, "secondary": 0} for _ in range(ROUNDS)],
        "log": [],
    }


def awards_of(card: dict[str, Any]) -> list[dict[str, Any]]:
    """Read a card's ``awards``."""
    return card.get("awards") or []


def awards_for_approach(card: dict[str, Any], approach: str) -> list[dict[str, Any]]:
    """The awards a player scores under ``approach``. An award with no
    ``mode`` is flat; an award tagged fixed/tactical scores only under the
    matching approach."""
    return [a for a in awards_of(card) if a.get("mode") is None or a.get("mode") == approach]


def score_award(award: dict[str, Any], count: int = 1) -> int:
    """VP for a single asserted award. A flat ``vp`` ignores ``count``; a
    ``vp_per`` award scores ``vp_per × count``, with ``count`` clamped to
    ``per_max`` when present."""
    if award.get("vp") is not None:
        return award["vp"]
    if award.get("vp_per") is not None:
        per_max = award.get("per_max")
        capped = min(count, per_max) if per_max is not None else count
        return award["vp_per"] * max(0, capped)
    return 0


def score_turn(asserted: list[AssertedAward]) -> int:
    """VP from everything asserted in one scoring, before the card cap.

    Awards sharing an ``exclusive_group`` resolve as "only the highest
    scores"; everything else, including ``cumulative`` "+" rows, sums.
    """
    group_best: dict[str, int] = {}
    total = 0
    for entry in asserted:
        award = entry["award"]
        v = score_award(award, entry.get("count", 1) if entry.get("count") is not None else 1)
        group = award.get("exclusive_group")
        if group is not None:
            if v > group_best.get(group, 0):
                group_best[group] = v
        else:
            total += v
    return total + sum(group_best.values())


def score_cap(card: dict[str, Any], approach: str) -> float:
    """A card's per-score VP ceiling under ``approach``. Tactical is the
    universal :data:`TACTICAL_CARD_CAP`. Fixed uses the largest ``vp_max``
    printed on the card's scorable awards, or infinity when none is printed
    (uncapped)."""
    if approach == "tactical":
        return TACTICAL_CARD_CAP
    caps = [a["vp_max"] for a in awards_for_approach(card, "fixed") if a.get("vp_max") is not None]
    return max(caps) if caps else math.inf


def score_secondary_event(
    asserted: list[AssertedAward], card: dict[str, Any], approach: str
) -> int:
    """The VP a single scoring of ``card`` grants under ``approach``: the
    asserted awards' total, clamped to the card's cap."""
    return int(min(score_turn(asserted), score_cap(card, approach)))


def score_primary_event(asserted: list[AssertedAward], round_cap: int) -> int:
    """The primary VP a single battle round's scoring grants: the asserted
    awards' total, clamped to the per-round cap. There is no tactical 5-VP
    rule on primary; the per-game primary cap is applied separately by
    :func:`set_primary`."""
    return min(score_turn(asserted), round_cap)


def _round_index(round: int) -> int:
    return max(0, min(ROUNDS - 1, math.trunc(round) - 1))


def record_secondary(
    pg: PlayerGame,
    round: int,
    vp: int,
    caps: dict[str, Any] | None = None,
) -> PlayerGame:
    """Add secondary VP to a battle round (1-based). Pure — returns new state.

    ``caps`` mirrors :func:`set_primary`: ``roundCap`` bounds the round's
    cumulative secondary, ``gameCap`` the game-wide secondary total.
    """
    i = _round_index(round)
    added = max(0, vp)
    caps = caps or {}
    others = sum(c["secondary"] for idx, c in enumerate(pg["rounds"]) if idx != i)
    game_room = max(0, (caps.get("gameCap") or math.inf) - others)
    round_room = max(0, (caps.get("roundCap") or math.inf) - pg["rounds"][i]["secondary"])
    clamped = min(added, round_room, game_room)
    rounds = [
        {**c, "secondary": c["secondary"] + clamped} if idx == i else c
        for idx, c in enumerate(pg["rounds"])
    ]
    return {**pg, "rounds": rounds}


def score_secondary(
    pg: PlayerGame, round: int, card_id: str, vp: int, caps: dict[str, Any] | None = None
) -> PlayerGame:
    """Score a held secondary: add its VP to the round, append it to the log,
    and discard it from hand. Pure."""
    banked = max(0, vp)
    recorded = record_secondary(pg, round, banked, caps)
    i = _round_index(round)
    actually_banked = recorded["rounds"][i]["secondary"] - pg["rounds"][i]["secondary"]
    return {
        **remove_from_hand(recorded, card_id),
        "log": [*pg["log"], {"cardId": card_id, "round": round, "vp": actually_banked}],
    }


def remove_score(pg: PlayerGame, index: int) -> PlayerGame:
    """Undo a logged scoring by index: subtract its VP from its round, drop
    the log entry, and return the card to hand. Pure; a no-op for an
    out-of-range index."""
    if not (0 <= index < len(pg["log"])):
        return pg
    entry = pg["log"][index]
    i = _round_index(entry["round"])
    rounds = [
        {**c, "secondary": max(0, c["secondary"] - entry["vp"])} if idx == i else c
        for idx, c in enumerate(pg["rounds"])
    ]
    log = [e for idx, e in enumerate(pg["log"]) if idx != index]
    hand_ids = (
        pg["handIds"] if entry["cardId"] in pg["handIds"] else [*pg["handIds"], entry["cardId"]]
    )
    return {**pg, "rounds": rounds, "log": log, "handIds": hand_ids}


def set_primary(
    pg: PlayerGame,
    round: int,
    vp: int,
    caps: dict[str, Any] | None = None,
) -> PlayerGame:
    """Set primary VP for a battle round (1-based) to a clamped value. Pure.

    ``caps`` bounds the stored value by both the per-round ceiling
    (``roundCap``) and the remaining per-game primary room (``gameCap``,
    computed against the *other* rounds' primary). With no caps both default
    to infinity, leaving only the floor-at-zero clamp.
    """
    caps = caps or {}
    i = _round_index(round)
    others = sum(c["primary"] for idx, c in enumerate(pg["rounds"]) if idx != i)
    round_cap = caps.get("roundCap")
    game_cap = caps.get("gameCap")
    room = max(
        0,
        min(
            round_cap if round_cap is not None else math.inf,
            (game_cap if game_cap is not None else math.inf) - others,
        ),
    )
    clamped = max(0, min(vp, room))
    clamped = int(clamped) if clamped != math.inf else clamped
    rounds = [{**c, "primary": clamped} if idx == i else c for idx, c in enumerate(pg["rounds"])]
    return {**pg, "rounds": rounds}


def add_to_hand(pg: PlayerGame, card_id: str) -> PlayerGame:
    """Put a drawn card in hand (no duplicates). Pure."""
    if card_id in pg["handIds"]:
        return pg
    return {**pg, "handIds": [*pg["handIds"], card_id]}


def remove_from_hand(pg: PlayerGame, card_id: str) -> PlayerGame:
    """Remove a card from hand (e.g. on score or discard). Pure."""
    return {**pg, "handIds": [id_ for id_ in pg["handIds"] if id_ != card_id]}


def player_primary(pg: PlayerGame) -> int:
    """Total primary VP across the game."""
    return sum(c["primary"] for c in pg["rounds"])


def player_secondary(pg: PlayerGame) -> int:
    """Total secondary VP across the game."""
    return sum(c["secondary"] for c in pg["rounds"])


def player_total(pg: PlayerGame) -> int:
    """Grand total VP, capped at :data:`GAME_VP_CAP`."""
    return min(GAME_VP_CAP, player_primary(pg) + player_secondary(pg))


def wtc_result(total_a: int, total_b: int) -> dict[str, int]:
    """The WTC 20-point result from two grand totals.

    The winner's margin maps onto 11 bands (0-5 → 10-10 draw, 6-10 → 11-9,
    ... 51+ → 20-0); the loser gets the complement.
    """
    diff = abs(total_a - total_b)
    band = 0 if diff <= 5 else min(10, math.ceil((diff - 5) / 5))
    winner = 10 + band
    loser = 10 - band
    if total_a == total_b:
        return {"a": 10, "b": 10}
    return {"a": winner, "b": loser} if total_a > total_b else {"a": loser, "b": winner}
