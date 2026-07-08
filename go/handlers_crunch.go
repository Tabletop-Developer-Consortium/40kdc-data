package wh40kdc

// crunch / attribution op handlers. Go mirror of the cruncher handlers in
// python .../runner.py. Only the per-stage `expected` (and attribution's
// baseline/lifts/residual/intrinsics) crosses the wire.

// buildEngineInput validates the wire-shape crunch/attribution args and
// assembles the EngineInput both ops share, or returns a typed runner error.
func (s *RunnerState) buildEngineInput(a map[string]any, opName string) (map[string]any, map[string]any) {
	attacker, _ := getMap(a, "attacker")
	target, _ := getMap(a, "target")
	if getStr(attacker, "weaponId") == "" || !isNumber(attacker["profileIndex"]) {
		return nil, errResp("INVALID_INPUT", detail(opName+".attacker.weaponId/profileIndex required"))
	}
	if getStr(target, "unitId") == "" || !isNumber(target["profileIndex"]) {
		return nil, errResp("INVALID_INPUT", detail(opName+".target.unitId/profileIndex required"))
	}
	if !isNumber(a["modelsFiring"]) {
		return nil, errResp("INVALID_INPUT", detail(opName+".modelsFiring required"))
	}
	if _, ok := getMap(a, "context"); !ok {
		return nil, errResp("INVALID_INPUT", detail(opName+".context required"))
	}
	ds := s.dataset()
	weapon, ok := ds.Weapons.Get(getStr(attacker, "weaponId"))
	if !ok {
		return nil, errResp("UNKNOWN_ENTITY", map[string]any{"kind": "weapon", "id": attacker["weaponId"]})
	}
	unit, ok := ds.Units.GetAny(getStr(target, "unitId"))
	if !ok {
		return nil, errResp("UNKNOWN_ENTITY", map[string]any{"kind": "unit", "id": target["unitId"]})
	}
	targetInput := map[string]any{"unit": unit.Raw, "profileIndex": target["profileIndex"]}
	if target["modelCount"] != nil {
		targetInput["modelCount"] = target["modelCount"]
	}
	buffs := getList(a, "buffs")
	ctx, _ := getMap(a, "context")
	return map[string]any{
		"attacker":     map[string]any{"weapon": weapon.Raw, "profileIndex": attacker["profileIndex"]},
		"target":       targetInput,
		"modelsFiring": a["modelsFiring"],
		"buffs":        toAnySlice(buffs),
		"context":      ctx,
	}, nil
}

func toAnySlice(l []any) []any {
	if l == nil {
		return []any{}
	}
	return l
}

func (s *RunnerState) handleCrunch(args any) map[string]any {
	a, ok := asMap(args)
	if !ok {
		return errResp("INVALID_INPUT", detail("crunch args must be an object"))
	}
	input, errR := s.buildEngineInput(a, "crunch")
	if errR != nil {
		return errR
	}
	stages, _, err := crunch(input, s.dataset())
	if err != nil {
		return errResp("CRUNCH_ERROR", detail(err.Error()))
	}
	return okResp(map[string]any{"stages": toAny(stages)})
}

func (s *RunnerState) handleAttribution(args any) map[string]any {
	a, ok := asMap(args)
	if !ok {
		return errResp("INVALID_INPUT", detail("attribution args must be an object"))
	}
	input, errR := s.buildEngineInput(a, "attribution")
	if errR != nil {
		return errR
	}
	epsilon := 1e-6
	if isNumber(a["epsilon"]) {
		epsilon, _ = num(a["epsilon"])
	}
	stages, err := attributeStages(input, s.dataset(), epsilon)
	if err != nil {
		return errResp("CRUNCH_ERROR", detail(err.Error()))
	}
	return okResp(toAny(stages))
}
