package wh40kdc

import "math"

// Card-driven secondary-mission scoring, 10th-edition tactical model. Go mirror
// of python .../scoring/__init__.py, pinned by conformance/scoring. All values
// are exact integers — no tolerance. PlayerGame is a plain map[string]any.

const (
	tacticalCardCap = 5   // Tactical caps a single secondary at this many VP.
	scoringRounds   = 5   // Battle rounds in a game.
	gameVPCap       = 100 // Per-player VP ceiling.
)

func emptyPlayerGame(approach string) map[string]any {
	rounds := make([]any, scoringRounds)
	for i := range rounds {
		rounds[i] = map[string]any{"primary": float64(0), "secondary": float64(0)}
	}
	return map[string]any{
		"approach": approach,
		"handIds":  []any{},
		"rounds":   rounds,
		"log":      []any{},
	}
}

func awardsOf(card map[string]any) []any { return getList(card, "awards") }

func awardsForApproach(card map[string]any, approach string) []any {
	var out []any
	for _, aAny := range awardsOf(card) {
		a, _ := asMap(aAny)
		mode := a["mode"]
		if mode == nil || mode == approach {
			out = append(out, a)
		}
	}
	return out
}

// scoreAward is the VP for a single asserted award.
func scoreAward(award map[string]any, count int) int {
	if award["vp"] != nil {
		return asInt(award["vp"])
	}
	if award["vp_per"] != nil {
		capped := count
		if award["per_max"] != nil {
			capped = minInt(count, asInt(award["per_max"]))
		}
		return asInt(award["vp_per"]) * maxInt(0, capped)
	}
	return 0
}

// scoreTurn is the VP from everything asserted in one scoring, before the card
// cap. assertedAward entries are {"award": map, "count"?: number}.
func scoreTurn(asserted []map[string]any) int {
	groupBest := map[string]int{}
	total := 0
	for _, entry := range asserted {
		award, _ := asMap(entry["award"])
		count := 1
		if entry["count"] != nil {
			count = asInt(entry["count"])
		}
		v := scoreAward(award, count)
		if g, ok := award["exclusive_group"].(string); ok {
			if v > groupBest[g] {
				groupBest[g] = v
			}
		} else {
			total += v
		}
	}
	for _, v := range groupBest {
		total += v
	}
	return total
}

// scoreCap is a card's per-score VP ceiling under approach. Returns +Inf for an
// uncapped fixed card.
func scoreCap(card map[string]any, approach string) float64 {
	if approach == "tactical" {
		return tacticalCardCap
	}
	best := math.Inf(-1)
	any := false
	for _, aAny := range awardsForApproach(card, "fixed") {
		a, _ := asMap(aAny)
		if a["vp_max"] != nil {
			any = true
			if v := float64(asInt(a["vp_max"])); v > best {
				best = v
			}
		}
	}
	if !any {
		return math.Inf(1)
	}
	return best
}

func scoreSecondaryEvent(asserted []map[string]any, card map[string]any, approach string) int {
	return int(math.Min(float64(scoreTurn(asserted)), scoreCap(card, approach)))
}

func scorePrimaryEvent(asserted []map[string]any, roundCap int) int {
	return minInt(scoreTurn(asserted), roundCap)
}

func roundIndex(round int) int {
	return maxInt(0, minInt(scoringRounds-1, round-1))
}

// recordSecondary adds secondary VP to a battle round (1-based), returning new
// state. The caps mirror setPrimary: roundCap bounds the round's cumulative
// secondary, gameCap the game-wide secondary total. A nil cap is unbounded.
func recordSecondary(pg map[string]any, round, vp int, roundCap, gameCap *int) map[string]any {
	i := roundIndex(round)
	added := float64(maxInt(0, vp))
	others := 0
	for idx, cAny := range getList(pg, "rounds") {
		if idx != i {
			c, _ := asMap(cAny)
			others += asInt(c["secondary"])
		}
	}
	rc := math.Inf(1)
	if roundCap != nil {
		rc = float64(*roundCap)
	}
	gc := math.Inf(1)
	if gameCap != nil {
		gc = float64(*gameCap)
	}
	rounds := cloneRounds(pg)
	c, _ := asMap(rounds[i])
	current := asInt(c["secondary"])
	roundRoom := math.Max(0, rc-float64(current))
	gameRoom := math.Max(0, gc-float64(others))
	clamped := math.Min(added, math.Min(roundRoom, gameRoom))
	c["secondary"] = float64(current) + clamped
	out := cloneMap(pg)
	out["rounds"] = rounds
	return out
}

func scoreSecondary(pg map[string]any, round int, cardID string, vp int, roundCap, gameCap *int) map[string]any {
	banked := maxInt(0, vp)
	recorded := recordSecondary(pg, round, banked, roundCap, gameCap)
	i := roundIndex(round)
	before, _ := asMap(getList(pg, "rounds")[i])
	after, _ := asMap(getList(recorded, "rounds")[i])
	actuallyBanked := asInt(after["secondary"]) - asInt(before["secondary"])
	out := removeFromHand(recorded, cardID)
	log := append(cloneList(getList(pg, "log")), map[string]any{
		"cardId": cardID, "round": float64(round), "vp": float64(actuallyBanked),
	})
	out["log"] = log
	return out
}

func removeScore(pg map[string]any, index int) map[string]any {
	logList := getList(pg, "log")
	if index < 0 || index >= len(logList) {
		return pg
	}
	entry, _ := asMap(logList[index])
	i := roundIndex(asInt(entry["round"]))
	rounds := cloneRounds(pg)
	c, _ := asMap(rounds[i])
	c["secondary"] = float64(maxInt(0, asInt(c["secondary"])-asInt(entry["vp"])))
	var log []any
	for idx, e := range logList {
		if idx != index {
			log = append(log, e)
		}
	}
	if log == nil {
		log = []any{}
	}
	cardID := getStr(entry, "cardId")
	hand := getList(pg, "handIds")
	if !containsAny(hand, cardID) {
		hand = append(cloneList(hand), cardID)
	}
	out := cloneMap(pg)
	out["rounds"] = rounds
	out["log"] = log
	out["handIds"] = hand
	return out
}

func setPrimary(pg map[string]any, round, vp int, roundCap, gameCap *int) map[string]any {
	i := roundIndex(round)
	others := 0
	for idx, cAny := range getList(pg, "rounds") {
		if idx != i {
			c, _ := asMap(cAny)
			others += asInt(c["primary"])
		}
	}
	rc := math.Inf(1)
	if roundCap != nil {
		rc = float64(*roundCap)
	}
	gc := math.Inf(1)
	if gameCap != nil {
		gc = float64(*gameCap)
	}
	room := math.Max(0, math.Min(rc, gc-float64(others)))
	clamped := math.Max(0, math.Min(float64(vp), room))
	rounds := cloneRounds(pg)
	c, _ := asMap(rounds[i])
	c["primary"] = clamped // integral float64 marshals without a decimal
	out := cloneMap(pg)
	out["rounds"] = rounds
	return out
}

func addToHand(pg map[string]any, cardID string) map[string]any {
	if containsAny(getList(pg, "handIds"), cardID) {
		return pg
	}
	out := cloneMap(pg)
	out["handIds"] = append(cloneList(getList(pg, "handIds")), cardID)
	return out
}

func removeFromHand(pg map[string]any, cardID string) map[string]any {
	var hand []any
	for _, id := range getList(pg, "handIds") {
		if id != cardID {
			hand = append(hand, id)
		}
	}
	if hand == nil {
		hand = []any{}
	}
	out := cloneMap(pg)
	out["handIds"] = hand
	return out
}

func playerPrimary(pg map[string]any) int {
	total := 0
	for _, cAny := range getList(pg, "rounds") {
		c, _ := asMap(cAny)
		total += asInt(c["primary"])
	}
	return total
}

func playerSecondary(pg map[string]any) int {
	total := 0
	for _, cAny := range getList(pg, "rounds") {
		c, _ := asMap(cAny)
		total += asInt(c["secondary"])
	}
	return total
}

func playerTotal(pg map[string]any) int {
	return minInt(gameVPCap, playerPrimary(pg)+playerSecondary(pg))
}

// wtcResult maps two grand totals onto the WTC 20-point result.
func wtcResult(totalA, totalB int) map[string]any {
	diff := absInt(totalA - totalB)
	band := 0
	if diff > 5 {
		band = minInt(10, int(math.Ceil(float64(diff-5)/5)))
	}
	winner := 10 + band
	loser := 10 - band
	if totalA == totalB {
		return map[string]any{"a": float64(10), "b": float64(10)}
	}
	if totalA > totalB {
		return map[string]any{"a": float64(winner), "b": float64(loser)}
	}
	return map[string]any{"a": float64(loser), "b": float64(winner)}
}

// --- clone helpers (the Python engine is pure/immutable) ---

func cloneMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func cloneList(l []any) []any {
	out := make([]any, len(l))
	copy(out, l)
	return out
}

// cloneRounds deep-copies the rounds list (each round map is mutated in place
// by callers after cloning).
func cloneRounds(pg map[string]any) []any {
	src := getList(pg, "rounds")
	out := make([]any, len(src))
	for i, cAny := range src {
		out[i] = cloneMap(cAny.(map[string]any))
	}
	return out
}

func containsAny(l []any, s string) bool {
	for _, v := range l {
		if v == s {
			return true
		}
	}
	return false
}

func absInt(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
