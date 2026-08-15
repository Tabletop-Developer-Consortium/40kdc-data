package wh40kdc

import (
	"errors"
	"strings"
)

// formatAdapter recognises and parses one source list-export format.
type formatAdapter struct {
	id      string
	matches func(any) bool
	parse   func(any) (map[string]any, error)
}

// --- listforge (share JSON) + newrecruit-json adapters ---

func bsParse(decoded any, primaryFromCatalogue bool) (map[string]any, error) {
	roster := rosterOf(decoded)
	if roster == nil {
		return nil, errors.New("payload has no roster.forces array")
	}
	var detachmentRawNames []string
	var battleSizeRaw, forceDispositionRaw any
	units := []any{}
	for _, force := range asArrayOf(roster["forces"]) {
		top := childSelections(force)
		detachmentRawNames = append(detachmentRawNames, bsConfigValues(top, "Detachment")...)
		if battleSizeRaw == nil {
			battleSizeRaw = bsConfigValue(top, "Battle Size")
		}
		if primaryFromCatalogue && forceDispositionRaw == nil {
			forceDispositionRaw = bsConfigValue(top, "Force Disposition")
		}
		for _, sel := range top {
			if isUnitSelection(sel) {
				units = append(units, bsParseUnit(sel))
			}
		}
	}
	forces := asArrayOf(roster["forces"])
	factions := collectFactions(forces)

	var factionRaw any
	if primaryFromCatalogue {
		factionRaw = primaryFactionFromCatalogue(forces)
	}
	if factionRaw == nil && len(factions) > 0 {
		factionRaw = factions[0]
	}

	d, _ := decoded.(map[string]any)
	name := asStringOrNil(d["name"])
	if name == nil {
		name = asStringOrNil(roster["name"])
	}
	if name == nil {
		name = "Imported roster"
	}
	generatedBy := asStringOrNil(d["generatedBy"])
	if generatedBy == nil {
		generatedBy = asStringOrNil(roster["generatedBy"])
	}

	if detachmentRawNames == nil {
		detachmentRawNames = []string{}
	}
	result := map[string]any{
		"name":                 name,
		"generated_by":         generatedBy,
		"faction_raw_name":     factionRaw,
		"detachment_raw_names": strSliceToAny(detachmentRawNames),
		"battle_size_raw":      battleSizeRaw,
		"declared_limit":       parseLimit(battleSizeRaw),
		"total_reported":       pointsOf(roster),
		"total_computed":       totalComputedOf(roster),
		"units":                units,
		"multi_force":          len(factions) > 1,
	}
	if primaryFromCatalogue {
		result["force_disposition_raw_name"] = forceDispositionRaw
	}
	return result, nil
}

func primaryFactionFromCatalogue(forces []any) any {
	for _, force := range forces {
		f, ok := force.(map[string]any)
		if !ok {
			continue
		}
		name, ok := f["catalogueName"].(string)
		if !ok || name == "" {
			continue
		}
		parts := strings.Split(name, " - ")
		last := strings.TrimSpace(parts[len(parts)-1])
		if last != "" {
			return last
		}
	}
	return nil
}

var listforgeAdapter = formatAdapter{
	id: "listforge",
	matches: func(decoded any) bool {
		roster := rosterOf(decoded)
		if roster == nil {
			return false
		}
		return !hasNewrecruitSignature(decoded, roster)
	},
	parse: func(decoded any) (map[string]any, error) {
		if rosterOf(decoded) == nil {
			return nil, errors.New("listforge: payload has no roster.forces array")
		}
		return bsParse(decoded, false)
	},
}

var newrecruitJSONAdapter = formatAdapter{
	id: "newrecruit-json",
	matches: func(decoded any) bool {
		roster := rosterOf(decoded)
		if roster == nil {
			return false
		}
		return hasNewrecruitSignature(decoded, roster)
	},
	parse: func(decoded any) (map[string]any, error) {
		if rosterOf(decoded) == nil {
			return nil, errors.New("newrecruit-json: payload has no roster.forces array")
		}
		return bsParse(decoded, true)
	},
}

func strSliceToAny(xs []string) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x
	}
	return out
}
