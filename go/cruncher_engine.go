package wh40kdc

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// The expected-value damage engine. Closed-form math over schema profiles + a
// flat buff stack. Go mirror of python .../cruncher/engine.py. The reduction
// order is a conformance contract (buffs left-to-right, stages left-to-right);
// only the numeric `expected` per stage crosses the wire (detail strings are
// dropped).

var diceRe = regexp.MustCompile(`^(\d*)[dD](\d+)([+-]\d+)?$`)

type crunchError struct{ msg string }

func (e *crunchError) Error() string { return e.msg }

// profileBuffs returns the buffs contributed by profile i's intrinsic keywords.
func (w *WeaponView) profileBuffs(i int, ctx map[string]any) []any {
	var out []any
	for _, entry := range w.keywordsAt(i) {
		kw := entry["keyword"].(*WeaponKeywordView)
		var params map[string]any
		if p, ok := asMap(entry["parameters"]); ok {
			params = p
		}
		out = append(out, buffsFromKeyword(kw.ID(), w.ID(), kw.Raw["effect"], params, ctx)...)
	}
	return out
}

func profileBuffsFor(attacker map[string]any, ds *Dataset, ctx map[string]any) []any {
	// Resolve buffs from the attacker's OWN weapon object, never a re-lookup by
	// id: a bare weapon id shared across factions first-wins-resolves to whichever
	// faction bundled first, feeding the WRONG faction's keywords into buff math
	// (issue #59). attacker["weapon"] is authoritative and carries its profiles.
	return manualWeaponKeywordBuffs(attacker, ds, ctx)
}

func manualWeaponKeywordBuffs(attacker map[string]any, ds *Dataset, ctx map[string]any) []any {
	weapon, _ := getMap(attacker, "weapon")
	profiles := getList(weapon, "profiles")
	index := asInt(attacker["profileIndex"])
	if index < 0 || index >= len(profiles) {
		return nil
	}
	prof, _ := asMap(profiles[index])
	var out []any
	for _, refAny := range getList(prof, "keywords") {
		ref, _ := asMap(refAny)
		view, ok := ds.WeaponKeywords.Get(getStr(ref, "keyword_id"))
		if !ok {
			continue
		}
		var params map[string]any
		if p, ok := getMap(ref, "parameters"); ok {
			params = p
		}
		out = append(out, buffsFromKeyword(view.ID(), getStr(weapon, "id"), view.Raw["effect"], params, ctx)...)
	}
	return out
}

func stage(name string, expected float64) map[string]any {
	return map[string]any{"name": name, "expected": expected}
}

// crunch computes the per-stage projection for one (attacker, target, buffs)
// triple. Returns the stages, the resolved modifiers (for attribution), or an
// error.
func crunch(input map[string]any, ds *Dataset) ([]map[string]any, *resolved, error) {
	attacker, _ := getMap(input, "attacker")
	target, _ := getMap(input, "target")
	weapon, _ := getMap(attacker, "weapon")
	profiles := getList(weapon, "profiles")
	profileIndex := asInt(attacker["profileIndex"])
	if profileIndex < 0 || profileIndex >= len(profiles) {
		return nil, nil, &crunchError{"crunch: attacker.profileIndex out of range for weapon " + getStr(weapon, "id")}
	}
	weaponProfile, _ := asMap(profiles[profileIndex])
	unit, _ := getMap(target, "unit")
	unitProfiles := getList(unit, "profiles")
	targetProfileIndex := asInt(target["profileIndex"])
	if targetProfileIndex < 0 || targetProfileIndex >= len(unitProfiles) {
		return nil, nil, &crunchError{"crunch: target.profileIndex out of range for unit " + getStr(unit, "id")}
	}
	unitProfile, _ := asMap(unitProfiles[targetProfileIndex])

	targetKeywords := unitKeywordsLower(unit)
	ctx := cloneMap(getMapOr(input, "context"))
	if ctx["targetKeywords"] == nil {
		tk := make([]any, len(targetKeywords))
		for i, k := range targetKeywords {
			tk[i] = k
		}
		ctx["targetKeywords"] = tk
	}

	profBuffs := profileBuffsFor(attacker, ds, ctx)
	allBuffs := append(append([]any{}, profBuffs...), getList(input, "buffs")...)
	res := resolveBuffs(allBuffs, ctx)

	stats, _ := getMap(weaponProfile, "stats")
	stages := []map[string]any{}

	// Melee/ranged is per-profile (11e weapons mix profiles), not weapon-level.
	isMelee := getStr(weaponProfile, "range") == "Melee"

	// 1. Attacks
	baseA, err := evalStatValue(stats["A"])
	if err != nil {
		return nil, nil, err
	}
	attacksPerModel := baseA + res.attacksMod
	rapidFire := res.findKeyword("rapid-fire")
	halfRange := ctx["withinHalfRange"] == true
	rapidFireExtra := 0.0
	if rapidFire != nil && halfRange {
		rapidFireExtra, err = evalStatValue(paramValue(rapidFire, "value"))
		if err != nil {
			return nil, nil, err
		}
	}
	blast := res.findKeyword("blast")
	targetModelCount := target["modelCount"]
	if targetModelCount == nil {
		mc, _ := getMap(unit, "model_count")
		targetModelCount = mc["min"]
	}
	tmc := 1.0
	if isNumber(targetModelCount) {
		tmc, _ = num(targetModelCount)
	}
	blastExtra := 0.0
	if blast != nil {
		blastExtra = math.Floor(tmc / 5)
	}
	modelsFiring, _ := num(input["modelsFiring"])
	attacks := modelsFiring * (attacksPerModel + rapidFireExtra + blastExtra)
	stages = append(stages, stage("attacks", attacks))

	// 2. Hits
	ignoresCover := res.findKeyword("ignores-cover") != nil
	covered := res.coverActive && !ignoresCover && !isMelee
	coverHitPenalty := 0.0
	if covered {
		coverHitPenalty = -1
	}
	var hitStat any
	if isMelee {
		hitStat = stats["WS"]
	} else {
		hitStat = stats["BS"]
	}
	torrent := res.findKeyword("torrent") != nil
	var hits, critHits float64
	if torrent {
		hits = attacks
		critHits = 0
	} else {
		if !isNumber(hitStat) {
			ws := "BS"
			if isMelee {
				ws = "WS"
			}
			return nil, nil, &crunchError{"crunch: weapon " + getStr(weapon, "id") + " missing " + ws}
		}
		hitStatN, _ := num(hitStat)
		hitModifier := res.hitMod + coverHitPenalty
		passP, critP := checkProbabilities(hitStatN, hitModifier, rerollSubset(res, "hit"), true, true, 6)
		hits = attacks * passP
		critHits = attacks * critP
	}
	sustained := res.findKeyword("sustained-hits")
	if sustained != nil {
		sv, err := evalStatValue(paramValue(sustained, "value"))
		if err != nil {
			return nil, nil, err
		}
		hits += critHits * sv
	}
	stages = append(stages, stage("hits", hits))

	// 3. Wounds
	sBase, err := evalStatValue(stats["S"])
	if err != nil {
		return nil, nil, err
	}
	sStat := sBase + res.strengthMod
	tStat := numOr0(unitProfile["T"]) + res.toughnessMod
	stdWoundNeeded := woundThreshold(sStat, tStat)
	anti := res.findKeyword("anti")
	antiThreshold := 7.0
	if anti != nil {
		params, _ := getMap(anti, "parameters")
		targetKw, _ := params["target_keyword"].(string)
		if targetKw != "" && containsStr2(targetKeywords, lower(targetKw)) {
			threshold := jsNumber(params["threshold"])
			if !math.IsInf(threshold, 0) && !math.IsNaN(threshold) {
				antiThreshold = threshold
			}
		}
	}
	critWoundThreshold := math.Min(6, antiThreshold)
	hasLethal := res.findKeyword("lethal-hits") != nil
	hitsForWoundRoll := hits
	lethalAutoWounds := 0.0
	if hasLethal {
		hitsForWoundRoll = hits - critHits
		lethalAutoWounds = critHits
	}
	woundPass, woundCrit := checkProbabilities(float64(stdWoundNeeded), res.woundMod, rerollSubset(res, "wound"), true, true, critWoundThreshold)
	regularWoundsFromRoll := hitsForWoundRoll * (woundPass - woundCrit)
	critWoundsFromRoll := hitsForWoundRoll * woundCrit
	totalRegularWounds := regularWoundsFromRoll + lethalAutoWounds
	hasDevastating := res.findKeyword("devastating-wounds") != nil
	mortalWoundsStream := 0.0
	if hasDevastating {
		mortalWoundsStream = critWoundsFromRoll
	}
	regularWoundsForSaves := totalRegularWounds + critWoundsFromRoll
	if hasDevastating {
		regularWoundsForSaves = totalRegularWounds
	}
	totalWounds := regularWoundsForSaves + mortalWoundsStream
	stages = append(stages, stage("wounds", totalWounds))

	// 4. Saves
	ap := numOr0(stats["AP"]) + res.apMod
	armorTargetRaw := numOr0(unitProfile["Sv"]) - ap - res.saveMod
	armorFinal := clampF(armorTargetRaw, 2, 7)
	var effectiveInvuln *float64
	// Attack-scoped invuln (issue #87): a ranged-/melee-only save applies only to
	// that attack type; fall back to the unconditional invuln_sv when unscoped.
	scopedKey := "invuln_sv_ranged"
	if isMelee {
		scopedKey = "invuln_sv_melee"
	}
	pv := unitProfile[scopedKey]
	if !isNumber(pv) {
		pv = unitProfile["invuln_sv"]
	}
	if isNumber(pv) {
		p, _ := num(pv)
		effectiveInvuln = &p
	}
	if res.invulnerable != nil {
		ai := res.invulnerable.threshold
		if effectiveInvuln == nil {
			effectiveInvuln = &ai
		} else if ai < *effectiveInvuln {
			effectiveInvuln = &ai
		}
	}
	effectiveSaveTarget := armorFinal
	if effectiveInvuln != nil {
		effectiveSaveTarget = math.Min(armorFinal, *effectiveInvuln)
	}
	savePass, _ := checkProbabilities(effectiveSaveTarget, 0, rerollSubset(res, "save"), true, false, 7)
	pSaved := savePass
	if effectiveSaveTarget >= 7 {
		pSaved = 0
	}
	unsaved := regularWoundsForSaves * (1 - pSaved)
	stages = append(stages, stage("unsaved", unsaved))

	// 5. Damage
	baseD, err := evalStatValue(stats["D"])
	if err != nil {
		return nil, nil, err
	}
	melta := res.findKeyword("melta")
	meltaBonus := 0.0
	if melta != nil && halfRange {
		meltaBonus, err = evalStatValue(paramValue(melta, "value"))
		if err != nil {
			return nil, nil, err
		}
	}
	beforeReduction := math.Max(0, baseD+meltaBonus+res.damageMod)
	damageReduction := res.damageReduction
	damagePerHit := beforeReduction
	if damageReduction > 0 {
		damagePerHit = math.Max(1, beforeReduction-damageReduction)
	}
	damageMain := unsaved * damagePerHit
	damageMortal := mortalWoundsStream * damagePerHit
	damage := damageMain + damageMortal
	stages = append(stages, stage("damage", damage))

	// 6. FNP
	pSurviveAll := fnpSurvivalFraction(res.feelNoPain)
	pSurviveMortal := fnpSurvivalFraction(res.feelNoPainMortal)
	afterMain := damageMain * pSurviveAll
	afterMortal := damageMortal * pSurviveAll * pSurviveMortal
	afterFnp := afterMain + afterMortal
	stages = append(stages, stage("after-fnp", afterFnp))

	// 7. Models killed
	woundsStat := numOr0(unitProfile["W"])
	expectedModelsKilled := 0.0
	if woundsStat > 0 {
		expectedModelsKilled = math.Min(tmc, afterFnp/woundsStat)
	}
	stages = append(stages, stage("models-killed", expectedModelsKilled))

	return stages, res, nil
}

func getMapOr(m map[string]any, key string) map[string]any {
	v, _ := getMap(m, key)
	if v == nil {
		return map[string]any{}
	}
	return v
}

func paramValue(ref map[string]any, key string) any {
	params, _ := getMap(ref, "parameters")
	if params == nil {
		return nil
	}
	return params[key]
}

func rerollSubset(r *resolved, roll string) string {
	if e, ok := r.rerolls[roll]; ok {
		return e.subset
	}
	return "none"
}

func unitKeywordsLower(unit map[string]any) []string {
	var out []string
	for _, k := range getStrList(unit, "keywords") {
		out = append(out, lower(k))
	}
	for _, k := range getStrList(unit, "faction_keywords") {
		out = append(out, lower(k))
	}
	return out
}

func containsStr2(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

func woundThreshold(s, t float64) int {
	switch {
	case s >= 2*t:
		return 2
	case s > t:
		return 3
	case s == t:
		return 4
	case s*2 > t:
		return 5
	default:
		return 6
	}
}

func checkProbabilities(unmodifiedNeeded, modifier float64, reroll string, autoFailOnOne, autoPassOnSix bool, critThreshold float64) (float64, float64) {
	outcome := func(face int) (int, int) {
		f := float64(face)
		if autoFailOnOne && face == 1 {
			return 0, 0
		}
		if f >= critThreshold {
			return 1, 1
		}
		if autoPassOnSix && face == 6 {
			return 1, 0
		}
		if (f + modifier) >= unmodifiedNeeded {
			return 1, 0
		}
		return 0, 0
	}
	passP, critP := 0.0, 0.0
	for face := 1; face <= 6; face++ {
		p, c := outcome(face)
		if p == 1 {
			passP += 1.0 / 6
			critP += float64(c) / 6
			continue
		}
		eligible := reroll == "all-failures" || (reroll == "ones" && face == 1)
		if !eligible {
			continue
		}
		rerollPass, rerollCrit := 0.0, 0.0
		for f2 := 1; f2 <= 6; f2++ {
			sp, sc := outcome(f2)
			rerollPass += float64(sp) / 6
			rerollCrit += float64(sc) / 6
		}
		passP += rerollPass / 6
		critP += rerollCrit / 6
	}
	return passP, critP
}

func jsNumber(v any) float64 {
	switch x := v.(type) {
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case nil:
		return math.NaN()
	case string:
		t := strings.TrimSpace(x)
		if t == "" {
			return 0
		}
		f, err := strconv.ParseFloat(t, 64)
		if err != nil {
			return math.NaN()
		}
		return f
	}
	return math.NaN()
}

func evalStatValue(v any) (float64, error) {
	if isNumber(v) {
		f, _ := num(v)
		return f, nil
	}
	s, ok := v.(string)
	if !ok {
		n := jsNumber(v)
		if !math.IsInf(n, 0) && !math.IsNaN(n) && n != 0 {
			return n, nil
		}
		return 0, nil
	}
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return 0, nil
	}
	if asNumber, err := strconv.ParseFloat(trimmed, 64); err == nil {
		if !math.IsInf(asNumber, 0) && !math.IsNaN(asNumber) {
			return asNumber, nil
		}
	}
	m := diceRe.FindStringSubmatch(trimmed)
	if m == nil {
		return 0, &crunchError{"eval_stat_value: cannot parse \"" + s + "\""}
	}
	count := 1
	if m[1] != "" {
		count, _ = strconv.Atoi(m[1])
	}
	die, _ := strconv.Atoi(m[2])
	offset := 0
	if m[3] != "" {
		offset, _ = strconv.Atoi(m[3])
	}
	return float64(count)*(float64(die)+1)/2 + float64(offset), nil
}

func clampF(n, lo, hi float64) float64 {
	return math.Max(lo, math.Min(hi, n))
}

func fnpSurvivalFraction(f *fnpState) float64 {
	if f == nil {
		return 1
	}
	pSucc := math.Max(0, math.Min(1, (7-f.threshold)/6))
	return 1 - pSucc
}
