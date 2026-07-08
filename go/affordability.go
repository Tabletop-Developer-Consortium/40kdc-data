package wh40kdc

import (
	"math"
	"sort"
)

// candidate_affordability — given the units already in a list and a points
// budget, price the cheapest next copy of each candidate unit and flag whether
// it still fits. Go mirror of tools/src/data/affordability.ts.

// affordabilityUnit is one unit already in the list (fixes the running total +
// per-datasheet ordinals). enhancementID is "" for none.
type affordabilityUnit struct {
	unitID        string
	modelCount    int
	enhancementID string
}

// affordabilitySpec is the compact input shared by the runner op.
type affordabilitySpec struct {
	factionID           string
	battleSize          string
	pointsLimitOverride *int
	units               []affordabilityUnit
	candidateUnitIDs    []string
	candidateProvided   bool
}

// cheapestNextCopy is the cheapest cost to field one more copy of view at army
// ordinal nextOrdinal (minimum over the unit's points tiers).
func cheapestNextCopy(view *UnitView, nextOrdinal int) int {
	tiers := getList(view.Raw, "points")
	if len(tiers) == 0 {
		return 0
	}
	min := math.MaxInt
	for _, tAny := range tiers {
		t, _ := asMap(tAny)
		cost := baseUnitPoints(view.Raw, asInt(t["models"]), nextOrdinal)
		if cost < min {
			min = cost
		}
	}
	if min == math.MaxInt {
		return 0
	}
	return min
}

// candidateAffordability prices the cheapest next copy of each candidate and
// flags affordability against the remaining budget. Returns one object per
// candidate that resolves in the dataset, sorted ascending by
// (nextCopyCost, unitId). Mirror of the TS reference.
func candidateAffordability(spec affordabilitySpec, ds *Dataset) []map[string]any {
	resolve := func(unitID string) *UnitView {
		if unitID == "" {
			return nil
		}
		if spec.factionID != "" {
			if uv, ok := ds.Units.GetInFaction(unitID, spec.factionID); ok {
				return uv
			}
		}
		if uv, ok := ds.Units.GetAny(unitID); ok {
			return uv
		}
		return nil
	}

	// Running total of the current list (ordinal-aware) + enhancement costs.
	ordinals := map[string]int{}
	spent := 0
	for _, u := range spec.units {
		view := resolve(u.unitID)
		if view == nil {
			continue
		}
		ord := ordinals[u.unitID] + 1
		ordinals[u.unitID] = ord
		spent += baseUnitPoints(view.Raw, u.modelCount, ord)
		if u.enhancementID != "" {
			if eAny, ok := ds.Enhancements.Get(u.enhancementID); ok {
				spent += asInt(eAny.(map[string]any)["cost"])
			}
		}
	}

	hasLimit := false
	limit := 0
	if spec.pointsLimitOverride != nil {
		limit = *spec.pointsLimitOverride
		hasLimit = true
	} else if l, ok := pointsLimitForBattleSize(spec.battleSize); ok {
		limit = l
		hasLimit = true
	}
	remaining := 0
	if hasLimit {
		remaining = limit - spent
	}

	// Candidate set: explicit list, else every unit in the faction.
	candidateIDs := spec.candidateUnitIDs
	if !spec.candidateProvided {
		candidateIDs = nil
		if spec.factionID != "" {
			for _, v := range ds.Units.ByFaction(spec.factionID) {
				candidateIDs = append(candidateIDs, v.ID())
			}
		}
	}

	out := []map[string]any{}
	for _, unitID := range candidateIDs {
		view := resolve(unitID)
		if view == nil {
			continue
		}
		nextOrdinal := ordinals[unitID] + 1
		nextCopyCost := cheapestNextCopy(view, nextOrdinal)
		affordable := !hasLimit || nextCopyCost <= remaining
		out = append(out, map[string]any{
			"unitId":       view.ID(),
			"nextCopyCost": nextCopyCost,
			"affordable":   affordable,
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		ci, cj := out[i]["nextCopyCost"].(int), out[j]["nextCopyCost"].(int)
		if ci != cj {
			return ci < cj
		}
		return out[i]["unitId"].(string) < out[j]["unitId"].(string)
	})
	return out
}
