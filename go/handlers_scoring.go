package wh40kdc

import "math"

// Scoring-engine op handlers. Awards are referenced by index into the card's
// awards array (never serialized) so all impls reconstruct the same asserted
// awards from the shared embedded dataset. Go mirror of the scoring handlers in
// python .../runner.py.

func isScoringMode(v any) bool { return v == "fixed" || v == "tactical" }

// resolveAsserted resolves [{index, count?}] against a card's awards, or returns
// a typed runner error.
func resolveAsserted(card map[string]any, asserted any) ([]map[string]any, map[string]any) {
	list, ok := asList(asserted)
	if !ok {
		return nil, errResp("INVALID_INPUT", detail("asserted must be an array"))
	}
	awards := awardsOf(card)
	out := []map[string]any{}
	for _, rawAny := range list {
		raw, ok := asMap(rawAny)
		if !ok {
			return nil, errResp("INVALID_INPUT", detail("asserted entry must be an object"))
		}
		if !isNumber(raw["index"]) {
			return nil, errResp("INVALID_INPUT", detail("asserted.index out of range"))
		}
		index := asInt(raw["index"])
		if index < 0 || index >= len(awards) {
			return nil, errResp("INVALID_INPUT", detail("asserted.index out of range"))
		}
		entry := map[string]any{"award": awards[index]}
		if raw["count"] != nil {
			entry["count"] = raw["count"]
		}
		out = append(out, entry)
	}
	return out, nil
}

func optionalCaps(o map[string]any) (*int, *int) {
	var rc, gc *int
	if isNumber(o["roundCap"]) {
		v := asInt(o["roundCap"])
		rc = &v
	}
	if isNumber(o["gameCap"]) {
		v := asInt(o["gameCap"])
		gc = &v
	}
	return rc, gc
}

func (s *RunnerState) handleScoreEvent(args any) map[string]any {
	a, ok := asMap(args)
	if !ok {
		return errResp("INVALID_INPUT", detail("score_event args must be an object"))
	}
	cardID, ok := a["cardId"].(string)
	if !ok {
		return errResp("INVALID_INPUT", detail("score_event.cardId must be a string"))
	}
	approach, _ := a["approach"].(string)
	if !isScoringMode(approach) {
		return errResp("INVALID_INPUT", detail("score_event.approach must be 'fixed' or 'tactical'"))
	}
	cardAny, ok := s.dataset().MissionCards.Get(cardID)
	if !ok {
		return errResp("UNKNOWN_ENTITY", map[string]any{"kind": "secondary-card", "id": cardID})
	}
	card := cardAny.(map[string]any)
	resolved, errR := resolveAsserted(card, a["asserted"])
	if errR != nil {
		return errR
	}
	cap := scoreCap(card, approach)
	value := map[string]any{
		"turn":   scoreTurn(resolved),
		"banked": scoreSecondaryEvent(resolved, card, approach),
	}
	if math.IsInf(cap, 1) {
		value["cap"] = nil
	} else {
		value["cap"] = int(cap)
	}
	if isNumber(a["roundCap"]) {
		value["primaryBanked"] = scorePrimaryEvent(resolved, asInt(a["roundCap"]))
	}
	return okResp(value)
}

func (s *RunnerState) handleScoreState(args any) map[string]any {
	a, ok := asMap(args)
	if !ok {
		return errResp("INVALID_INPUT", detail("score_state args must be an object"))
	}
	approach, _ := a["approach"].(string)
	if !isScoringMode(approach) {
		return errResp("INVALID_INPUT", detail("score_state.approach must be 'fixed' or 'tactical'"))
	}
	ops, ok := asList(a["ops"])
	if !ok {
		return errResp("INVALID_INPUT", detail("score_state.ops must be an array"))
	}
	pg := emptyPlayerGame(approach)
	ds := s.dataset()
	for _, rawAny := range ops {
		raw, _ := asMap(rawAny)
		kind, _ := raw["kind"].(string)
		switch kind {
		case "draw":
			cardID, ok := raw["cardId"].(string)
			if !ok {
				return errResp("INVALID_INPUT", detail("draw.cardId must be a string"))
			}
			pg = addToHand(pg, cardID)
		case "score-secondary":
			cardID, ok := raw["cardId"].(string)
			if !ok || !isNumber(raw["round"]) {
				return errResp("INVALID_INPUT", detail("score-secondary needs cardId and round"))
			}
			cardAny, ok := ds.MissionCards.Get(cardID)
			if !ok {
				return errResp("UNKNOWN_ENTITY", map[string]any{"kind": "secondary-card", "id": cardID})
			}
			card := cardAny.(map[string]any)
			resolved, errR := resolveAsserted(card, raw["asserted"])
			if errR != nil {
				return errR
			}
			vp := scoreSecondaryEvent(resolved, card, approach)
			rc, gc := optionalCaps(raw)
			pg = scoreSecondary(pg, asInt(raw["round"]), cardID, vp, rc, gc)
		case "score-primary":
			cardID, ok := raw["cardId"].(string)
			if !ok || !isNumber(raw["round"]) {
				return errResp("INVALID_INPUT", detail("score-primary needs cardId and round"))
			}
			cardAny, ok := ds.MissionCards.Get(cardID)
			if !ok {
				return errResp("UNKNOWN_ENTITY", map[string]any{"kind": "secondary-card", "id": cardID})
			}
			card := cardAny.(map[string]any)
			resolved, errR := resolveAsserted(card, raw["asserted"])
			if errR != nil {
				return errR
			}
			rc, gc := optionalCaps(raw)
			pg = setPrimary(pg, asInt(raw["round"]), scoreTurn(resolved), rc, gc)
		case "set-primary":
			if !isNumber(raw["round"]) || !isNumber(raw["vp"]) {
				return errResp("INVALID_INPUT", detail("set-primary needs round and vp"))
			}
			rc, gc := optionalCaps(raw)
			pg = setPrimary(pg, asInt(raw["round"]), asInt(raw["vp"]), rc, gc)
		case "remove-score":
			if !isNumber(raw["index"]) {
				return errResp("INVALID_INPUT", detail("remove-score needs index"))
			}
			pg = removeScore(pg, asInt(raw["index"]))
		default:
			return errResp("INVALID_INPUT", detail("unknown score_state op kind: "+kind))
		}
	}
	return okResp(map[string]any{
		"rounds":    pg["rounds"],
		"handIds":   pg["handIds"],
		"log":       pg["log"],
		"primary":   playerPrimary(pg),
		"secondary": playerSecondary(pg),
		"total":     playerTotal(pg),
	})
}

func (s *RunnerState) handleWtcResult(args any) map[string]any {
	a, ok := asMap(args)
	if !ok {
		return errResp("INVALID_INPUT", detail("wtc_result args must be an object"))
	}
	if !isNumber(a["a"]) || !isNumber(a["b"]) {
		return errResp("INVALID_INPUT", detail("wtc_result needs numeric a and b"))
	}
	return okResp(wtcResult(asInt(a["a"]), asInt(a["b"])))
}
