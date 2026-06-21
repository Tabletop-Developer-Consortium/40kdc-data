package wh40kdc

// translate_scoring / translate_effect op handlers. Go mirror of the translate
// handlers in python .../runner.py.

func (s *RunnerState) handleTranslateScoring(args any) map[string]any {
	a, ok := asMap(args)
	if !ok {
		return errResp("INVALID_INPUT", detail("translate_scoring args must be an object"))
	}
	cardID, ok := a["cardId"].(string)
	if !ok {
		return errResp("INVALID_INPUT", detail("translate_scoring.cardId must be a string"))
	}
	cardAny, ok := s.dataset().MissionCards.Get(cardID)
	if !ok {
		return errResp("UNKNOWN_ENTITY", map[string]any{"kind": "secondary-card", "id": cardID})
	}
	card := cardAny.(map[string]any)
	awards := describeScoringCard(card)
	out := make([]any, len(awards))
	for i, s := range awards {
		out[i] = s
	}
	return okResp(map[string]any{"awards": out})
}

func (s *RunnerState) handleTranslateEffect(args any) map[string]any {
	a, ok := asMap(args)
	if !ok {
		return errResp("INVALID_INPUT", detail("translate_effect args must be an object"))
	}
	effect, ok := getMap(a, "effect")
	if !ok {
		return errResp("INVALID_INPUT", detail("translate_effect.effect must be an object"))
	}
	ability := map[string]any{"effect": effect}
	if scope, ok := getMap(a, "scope"); ok {
		ability["scope"] = scope
	}
	if at, ok := getMap(a, "applies_to"); ok {
		ability["applies_to"] = at
	}
	if usage, ok := getMap(a, "usage"); ok {
		ability["usage"] = usage
	}
	if trigger, ok := getMap(a, "trigger"); ok {
		ability["trigger"] = trigger
	}
	return okResp(map[string]any{"text": describeAbility(ability)})
}
