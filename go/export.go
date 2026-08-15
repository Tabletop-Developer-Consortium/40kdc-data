package wh40kdc

import (
	"errors"
	"strings"
)

// Roster exporters — symmetric counterpart to the importer. Deterministic and
// Dataset-free, byte-identical to the TS/Rust/Python output (pinned by the
// conformance/roster export goldens). Go mirror of python .../export/*.

var exportSerializers = map[string]func(map[string]any) string{
	"newrecruit-json":        serializeNewrecruitJSON,
	"newrecruit-wtc-compact": serializeWtcCompact,
	"newrecruit-wtc-full":    serializeWtcFull,
	"newrecruit-simple":      serializeNewrecruitSimple,
	"roster-json":            serializeRosterJSON,
	"rosterizer":             serializeRosterizer,
	"atc-2026-compact":       serializeAtc2026Compact,
	"atc-2026-full":          serializeAtc2026Full,
}

// exportDataSerializers are the Dataset-backed export-only formats: they read
// full datasheet data the Roster doesn't carry (stat lines, weapon profiles,
// keywords, ability text), so they take the extra *Dataset argument. Dispatched
// through exportRosterWithDataset. The eight Dataset-free serializers keep the
// func(map[string]any) string signature untouched.
var exportDataSerializers = map[string]func(map[string]any, *Dataset) string{
	"yellowscribe": serializeYellowscribe,
}

// isExportFormat reports whether format is a registered export format (either
// Dataset-free or Dataset-backed).
func isExportFormat(format string) bool {
	return exportSerializers[format] != nil || exportDataSerializers[format] != nil
}

func exportRoster(roster map[string]any, format string) (string, error) {
	ser := exportSerializers[format]
	if ser == nil {
		return "", errors.New("unknown export format: " + format)
	}
	return ser(roster), nil
}

// exportRosterWithDataset serializes a Roster into the named format, supplying
// the Dataset to Dataset-backed formats. Dataset-free formats ignore ds. A
// Dataset-backed format with a nil ds errors rather than emitting an empty
// roster. Go mirror of python export_roster's optional-dataset dispatch.
func exportRosterWithDataset(roster map[string]any, format string, ds *Dataset) (string, error) {
	if ser := exportSerializers[format]; ser != nil {
		return ser(roster), nil
	}
	if dser := exportDataSerializers[format]; dser != nil {
		if ds == nil {
			return "", errors.New("export format '" + format + "' requires a dataset argument")
		}
		return dser(roster, ds), nil
	}
	return "", errors.New("unknown export format: " + format)
}

// --- helpers ---

func titleCaseID(id any) any {
	s, ok := id.(string)
	if !ok {
		return nil
	}
	if s == "" {
		return ""
	}
	parts := strings.Split(s, "-")
	for i, seg := range parts {
		if seg != "" {
			parts[i] = strings.ToUpper(seg[:1]) + seg[1:]
		}
	}
	return strings.Join(parts, " ")
}

func titleCaseIDOr(id any, fallback string) string {
	if v := titleCaseID(id); v != nil {
		return v.(string)
	}
	return fallback
}

func displayedUnitPoints(u map[string]any) any {
	if u["points"] == nil {
		return nil
	}
	return asFloat(u["points"]) + enhPtsOr0(u)
}

func enhPtsOr0(u map[string]any) float64 {
	if p, ok := u["enhancement_points"].(float64); ok {
		return p
	}
	return 0
}

func ptsOr0(u map[string]any) float64 {
	if p, ok := u["points"].(float64); ok {
		return p
	}
	return 0
}

func totalArmyPoints(roster map[string]any) float64 {
	total := 0.0
	for _, uAny := range getList(roster, "units") {
		u := uAny.(map[string]any)
		total += ptsOr0(u) + enhPtsOr0(u)
	}
	return total
}

// charSlotAssignment returns a 1-based char slot per unit, or -1 for none.
func charSlotAssignment(units []any) []int {
	out := make([]int, len(units))
	next := 1
	for i, uAny := range units {
		u := uAny.(map[string]any)
		isChar := u["is_warlord"] == true || u["enhancement"] != nil || u["leader_attachment"] != nil
		if isChar {
			out[i] = next
			next++
		} else {
			out[i] = -1
		}
	}
	return out
}

func refOf(x map[string]any) map[string]any {
	r, _ := x["ref"].(map[string]any)
	return r
}

func refRawName(x map[string]any) any { return refOf(x)["raw_name"] }

func unitWargear(u map[string]any) []any { return getList(u, "wargear") }

// --- battle-size label (shared by 3 exporters) ---

func battleSizeLabel(roster map[string]any) any {
	pts, _ := roster["points"].(map[string]any)
	declared := pts["declared_limit"]
	switch roster["battle_size"] {
	case "strike-force":
		limit := "2000"
		if declared != nil {
			limit = numStr(declared)
		}
		return "Strike Force (" + limit + " Point limit)"
	case "incursion":
		limit := "1000"
		if declared != nil {
			limit = numStr(declared)
		}
		return "Incursion (" + limit + " Point limit)"
	}
	return nil
}
