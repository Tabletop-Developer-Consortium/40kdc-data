"""Scoring engine against the scoring conformance corpus.

All values are exact integers — no tolerance. The op shapes mirror the
runner's ``score_event`` / ``score_state`` / ``wtc_result`` wire contract.
"""

from __future__ import annotations

import math
from typing import Any

import pytest

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

from ..conftest import load_corpus_json


def _cases() -> list[dict[str, Any]]:
    return load_corpus_json("scoring", "cases.json")


def _resolve_asserted(card: dict[str, Any], asserted: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Resolve ``[{index, count?}]`` against a card's awards (the wire shape —
    awards travel by index, never serialized)."""
    awards = awards_of(card)
    out = []
    for a in asserted:
        entry: dict[str, Any] = {"award": awards[a["index"]]}
        if a.get("count") is not None:
            entry["count"] = a["count"]
        out.append(entry)
    return out


def _optional_caps(op: dict[str, Any]) -> dict[str, Any]:
    caps: dict[str, Any] = {}
    if isinstance(op.get("roundCap"), (int, float)):
        caps["roundCap"] = op["roundCap"]
    if isinstance(op.get("gameCap"), (int, float)):
        caps["gameCap"] = op["gameCap"]
    return caps


def run_scoring_case(ds: Any, case: dict[str, Any]) -> Any:
    op = case["op"]
    args = case["args"]
    if op == "score_event":
        card = ds.mission_cards.get(args["cardId"])
        assert card is not None, f"unknown card {args['cardId']}"
        resolved = _resolve_asserted(card, args.get("asserted") or [])
        cap = score_cap(card, args["approach"])
        value: dict[str, Any] = {
            "turn": score_turn(resolved),
            # Infinity (uncapped fixed) has no JSON form — null means "no cap".
            "cap": None if cap == math.inf else int(cap),
            "banked": score_secondary_event(resolved, card, args["approach"]),
        }
        if isinstance(args.get("roundCap"), (int, float)):
            value["primaryBanked"] = score_primary_event(resolved, args["roundCap"])
        return value
    if op == "score_state":
        pg = empty_player_game(args["approach"])
        for state_op in args["ops"]:
            kind = state_op["kind"]
            if kind == "draw":
                pg = add_to_hand(pg, state_op["cardId"])
            elif kind == "score-secondary":
                card = ds.mission_cards.get(state_op["cardId"])
                assert card is not None
                resolved = _resolve_asserted(card, state_op.get("asserted") or [])
                vp = score_secondary_event(resolved, card, pg["approach"])
                pg = score_secondary(
                    pg,
                    state_op["round"],
                    state_op["cardId"],
                    vp,
                    _optional_caps(state_op),
                )
            elif kind == "score-primary":
                card = ds.mission_cards.get(state_op["cardId"])
                assert card is not None
                resolved = _resolve_asserted(card, state_op.get("asserted") or [])
                pg = set_primary(
                    pg, state_op["round"], score_turn(resolved), _optional_caps(state_op)
                )
            elif kind == "set-primary":
                pg = set_primary(pg, state_op["round"], state_op["vp"], _optional_caps(state_op))
            elif kind == "remove-score":
                pg = remove_score(pg, state_op["index"])
            else:
                raise AssertionError(f"unknown score_state op kind: {kind}")
        return {
            "rounds": pg["rounds"],
            "handIds": pg["handIds"],
            "log": pg["log"],
            "primary": player_primary(pg),
            "secondary": player_secondary(pg),
            "total": player_total(pg),
        }
    if op == "wtc_result":
        return wtc_result(args["a"], args["b"])
    raise AssertionError(f"unknown scoring op: {op}")


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["name"])
def test_scoring_case(dataset: Any, case: dict[str, Any]) -> None:
    assert run_scoring_case(dataset, case) == case["expected"]
