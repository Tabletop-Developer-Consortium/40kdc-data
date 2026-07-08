package wh40kdc

import "math"

// Fleet comparison cells: expected kills / loadout damage of attacker weapons
// against target profiles. Go mirror of the compare_cell / loadout_cell entry
// points in python .../compare.py (the CLI/matrix rendering is omitted — only
// the conformance-pinned single-cell maths is ported).

type compareError struct{ msg string }

func (e *compareError) Error() string { return e.msg }

type resolvedTarget struct {
	profile    map[string]any
	unitRaw    map[string]any
	modelCount int
}

func resolveTarget(ds *Dataset, profile map[string]any) (*resolvedTarget, error) {
	unit, ok := ds.Units.GetInFaction(getStr(profile, "unit_id"), getStr(profile, "faction_id"))
	if !ok {
		return nil, &compareError{"target profile references a unit not in the dataset"}
	}
	modelCount := 1
	if isNumber(profile["model_count_override"]) && truthy(profile["model_count_override"]) {
		modelCount = asInt(profile["model_count_override"])
	} else {
		mc, _ := getMap(unit.Raw, "model_count")
		if isNumber(mc["min"]) {
			modelCount = asInt(mc["min"])
		}
	}
	return &resolvedTarget{profile: profile, unitRaw: unit.Raw, modelCount: modelCount}, nil
}

func (ds *Dataset) stageValue(weaponRaw map[string]any, profileIndex int, target *resolvedTarget, phase string, modelsFiring int, withinHalf bool, stageName string) (float64, error) {
	ctx := map[string]any{"phase": phase, "withinHalfRange": withinHalf}
	buffs := ds.defensiveBuffsFor(map[string]any{"unitId": getStr(target.unitRaw, "id"), "factionId": getStr(target.unitRaw, "faction_id")}, ctx)
	stages, _, err := crunch(map[string]any{
		"attacker":     map[string]any{"weapon": weaponRaw, "profileIndex": float64(profileIndex)},
		"target":       map[string]any{"unit": target.unitRaw, "profileIndex": float64(0), "modelCount": float64(target.modelCount)},
		"modelsFiring": float64(modelsFiring),
		"buffs":        buffs,
		"context":      ctx,
	}, ds)
	if err != nil {
		return 0, err
	}
	for _, st := range stages {
		if st["name"] == stageName {
			v, _ := num(st["expected"])
			return v, nil
		}
	}
	return 0, nil
}

func compareCell(ds *Dataset, factionID, unitID, weaponID string, profileIndex int, targetProfileID string, distance float64, phase string, modelsFiring int) (map[string]any, error) {
	profAny, ok := ds.TargetProfiles.Get(targetProfileID)
	if !ok {
		return nil, &compareError{"unknown target profile " + targetProfileID}
	}
	target, err := resolveTarget(ds, profAny.(map[string]any))
	if err != nil {
		return nil, err
	}
	weapon, ok := ds.Weapons.GetAny(weaponID)
	if !ok {
		return nil, &compareError{"unknown weapon " + weaponID}
	}
	profiles := getList(weapon.Raw, "profiles")
	if profileIndex < 0 || profileIndex >= len(profiles) {
		return nil, &compareError{"weapon profile index out of range"}
	}
	wprofile, _ := asMap(profiles[profileIndex])
	rng := wprofile["range"]
	isRanged := isNumber(rng)
	rngV, _ := num(rng)
	reaches := !isRanged || rngV >= distance
	withinHalf := isRanged && distance <= rngV/2
	kills := 0.0
	if reaches {
		kills, err = ds.stageValue(weapon.Raw, profileIndex, target, phase, modelsFiring, withinHalf, "models-killed")
		if err != nil {
			return nil, err
		}
	}
	return map[string]any{
		"expectedKills":   kills,
		"reaches":         reaches,
		"withinHalfRange": withinHalf,
		"modelCount":      target.modelCount,
	}, nil
}

type loadoutLine struct {
	weaponID     string
	count        int
	profileIndex int
}

func loadoutCell(ds *Dataset, lines []loadoutLine, targetProfileID string, distance float64, phase string) (map[string]any, error) {
	profAny, ok := ds.TargetProfiles.Get(targetProfileID)
	if !ok {
		return nil, &compareError{"unknown target profile " + targetProfileID}
	}
	target, err := resolveTarget(ds, profAny.(map[string]any))
	if err != nil {
		return nil, err
	}
	damage := 0.0
	for _, line := range lines {
		weapon, ok := ds.Weapons.GetAny(line.weaponID)
		if !ok {
			continue
		}
		profiles := getList(weapon.Raw, "profiles")
		if line.profileIndex < 0 || line.profileIndex >= len(profiles) {
			continue
		}
		wprofile, _ := asMap(profiles[line.profileIndex])
		rng := wprofile["range"]
		isRanged := isNumber(rng)
		rngV, _ := num(rng)
		if isRanged && rngV < distance {
			continue
		}
		withinHalf := isRanged && distance <= rngV/2
		d, err := ds.stageValue(weapon.Raw, line.profileIndex, target, phase, line.count, withinHalf, "after-fnp")
		if err != nil {
			return nil, err
		}
		damage += d
	}
	profiles := getList(target.unitRaw, "profiles")
	w := 1.0
	if len(profiles) > 0 {
		p0, _ := asMap(profiles[0])
		if isNumber(p0["W"]) && truthy(p0["W"]) {
			w, _ = num(p0["W"])
		}
	}
	kills := 0.0
	if w > 0 {
		kills = math.Min(float64(target.modelCount), damage/w)
	}
	return map[string]any{"damage": damage, "kills": kills}, nil
}
