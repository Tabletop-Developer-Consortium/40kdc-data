package wh40kdc

import (
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Rosterizer roster JSON adapter. Go mirror of python .../imports/rosterizer.py.

const (
	clsFaction          = "Faction"
	clsDetachment       = "Detachment"
	clsUnit             = "Unit"
	clsSquad            = "Squad"
	clsModel            = "Model"
	clsWeapon           = "Weapon"
	clsEnhancement      = "Enhancement"
	clsBattleSize       = "Battle Size"
	clsTrait            = "Trait"
	clsForceDisposition = "Force Disposition"
	clsAttachment       = "Attachment"
	clsKeywordOverride  = "40kdc Keyword"
	dsgWarlord          = "Warlord"
)

var rzCharClassifications = map[string]bool{"Character": true, "Epic Hero": true}
var rzLeadingNumberRe = regexp.MustCompile(`^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?`)
var rzAttachmentRe = regexp.MustCompile(`(?i)^Attachment:\s*(leader|support)\s*->\s*(.+?)(\s+\[provisional\])?\s*$`)

func rzObj(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return nil
}

// rzNumber returns a *float64 or nil.
func rzNumber(v any) *float64 {
	switch x := v.(type) {
	case bool:
		return nil
	case float64:
		if math.IsInf(x, 0) || math.IsNaN(x) {
			return nil
		}
		return &x
	case string:
		m := rzLeadingNumberRe.FindString(x)
		if m == "" {
			return nil
		}
		n, err := strconv.ParseFloat(strings.TrimSpace(m), 64)
		if err != nil || math.IsInf(n, 0) || math.IsNaN(n) {
			return nil
		}
		return &n
	}
	return nil
}

func rzSplitItem(asset map[string]any) (string, string) {
	if item, ok := asset["item"].(string); ok {
		if i := strings.Index(item, "§"); i >= 0 {
			return item[:i], item[i+len("§"):]
		}
	}
	cls, _ := asset["classification"].(string)
	dsg, _ := asset["designation"].(string)
	return cls, dsg
}

func rzDisplayName(asset map[string]any) string {
	if name, ok := asset["name"].(string); ok {
		return name
	}
	_, dsg := rzSplitItem(asset)
	return dsg
}

func rzQuantity(asset map[string]any) int {
	if n := rzNumber(asset["quantity"]); n != nil && *n > 0 {
		return int(math.Trunc(*n))
	}
	return 1
}

func rzIncluded(asset map[string]any) []map[string]any {
	a := rzObj(asset["assets"])
	var out []map[string]any
	if a != nil {
		for _, c := range asArrayOf(a["included"]) {
			if cm, ok := c.(map[string]any); ok {
				out = append(out, cm)
			}
		}
	}
	return out
}

func rzTraits(asset map[string]any) []map[string]any {
	a := rzObj(asset["assets"])
	var out []map[string]any
	if a != nil {
		for _, c := range asArrayOf(a["traits"]) {
			if cm, ok := c.(map[string]any); ok {
				out = append(out, cm)
			}
		}
	}
	return out
}

func rzPointsOf(asset map[string]any) any {
	if stats := rzObj(asset["stats"]); stats != nil {
		for _, key := range []string{"Points", "Pts"} {
			if stat := rzObj(stats[key]); stat != nil {
				if v := rzNumber(stat["value"]); v != nil {
					return math.Trunc(*v)
				}
			}
		}
	}
	if meta := rzObj(asset["meta"]); meta != nil {
		if v := rzNumber(meta["points"]); v != nil {
			return math.Trunc(*v)
		}
	}
	return nil
}

func rzWalk(asset map[string]any, visit func(map[string]any)) {
	visit(asset)
	for _, c := range rzIncluded(asset) {
		rzWalk(c, visit)
	}
	for _, c := range rzTraits(asset) {
		rzWalk(c, visit)
	}
}

func rzClassOf(asset map[string]any) string { cls, _ := rzSplitItem(asset); return cls }

func rzIsUnit(asset map[string]any) bool {
	c := rzClassOf(asset)
	return c == clsUnit || c == clsSquad
}

func rzIsWeapon(asset map[string]any) bool {
	c := rzClassOf(asset)
	return c == clsWeapon || strings.HasSuffix(c, " "+clsWeapon)
}

func rzIsEnhancement(asset map[string]any) bool { return rzClassOf(asset) == clsEnhancement }

func rzIsCharacter(asset map[string]any) bool {
	if keywords := rzObj(asset["keywords"]); keywords != nil {
		for _, kwList := range keywords {
			for _, kw := range asArrayOf(kwList) {
				if s, ok := kw.(string); ok && rzCharClassifications[s] {
					return true
				}
			}
		}
	}
	for _, t := range rzTraits(asset) {
		if rzCharClassifications[rzClassOf(t)] || rzCharClassifications[rzDisplayName(t)] {
			return true
		}
	}
	return false
}

func rzIsWarlordTrait(asset map[string]any) bool {
	cls, dsg := rzSplitItem(asset)
	if dsg == dsgWarlord {
		return true
	}
	return cls == clsTrait && dsg == dsgWarlord
}

func rzModelCount(unit map[string]any) int {
	nested := 0
	for _, child := range rzIncluded(unit) {
		if rzIsUnit(child) || rzClassOf(child) == clsModel {
			nested += rzQuantity(child)
		}
	}
	if nested > 0 {
		return nested
	}
	return rzQuantity(unit)
}

func rzParseUnit(unit map[string]any) map[string]any {
	wargear := []any{}
	var enhancementRawName, enhancementPoints any
	isWarlord := false
	var leaderAttachment map[string]any
	keywordOverrides := []any{}
	seenKeywordOverrides := map[string]bool{}
	addKeywordOverride := func(keyword string) {
		if keyword != "" && !seenKeywordOverrides[keyword] {
			seenKeywordOverrides[keyword] = true
			keywordOverrides = append(keywordOverrides, keyword)
		}
	}
	visit := func(a map[string]any) {
		if rzClassOf(a) == clsAttachment {
			if match := rzAttachmentRe.FindStringSubmatch(rzDisplayName(a)); match != nil {
				leaderAttachment = map[string]any{
					"role":               strings.ToLower(match[1]),
					"bodyguard_raw_name": match[2],
					"provisional":        match[3] != "",
				}
			}
			return
		}
		if rzIsEnhancement(a) {
			if enhancementRawName == nil {
				enhancementRawName = rzDisplayName(a)
				enhancementPoints = rzPointsOf(a)
			}
			return
		}
		if rzIsWeapon(a) {
			wargear = append(wargear, map[string]any{"raw_name": rzDisplayName(a), "count": float64(rzQuantity(a))})
		}
	}
	for _, child := range rzIncluded(unit) {
		rzWalk(child, visit)
	}
	loadoutGroups := []any{}
	for _, model := range rzIncluded(unit) {
		if rzClassOf(model) != clsModel {
			continue
		}
		count := rzQuantity(model)
		groupWargear := []any{}
		rzWalk(model, func(asset map[string]any) {
			if !rzIsWeapon(asset) {
				return
			}
			total := rzQuantity(asset)
			perModel := total
			if count > 0 && total%count == 0 {
				perModel = total / count
			}
			groupWargear = append(groupWargear, map[string]any{"raw_name": rzDisplayName(asset), "count": float64(perModel)})
		})
		loadoutGroups = append(loadoutGroups, map[string]any{
			"model_name": rzDisplayName(model),
			"count":      float64(count),
			"wargear":    groupWargear,
		})
	}
	for _, t := range rzTraits(unit) {
		rzWalk(t, func(a map[string]any) {
			if rzIsWarlordTrait(a) {
				isWarlord = true
			}
			classification, designation := rzSplitItem(a)
			if classification == clsKeywordOverride {
				addKeywordOverride(designation)
			} else if rzCharClassifications[classification] {
				addKeywordOverride("Character")
			}
		})
	}
	result := map[string]any{
		"raw_name":             rzDisplayName(unit),
		"is_character":         rzIsCharacter(unit),
		"model_count":          float64(rzModelCount(unit)),
		"points":               rzPointsOf(unit),
		"is_warlord":           isWarlord,
		"enhancement_raw_name": enhancementRawName,
		"enhancement_points":   enhancementPoints,
		"wargear":              wargear,
		"leader_attachment":    leaderAttachment,
	}
	if len(keywordOverrides) > 0 {
		result["keyword_overrides"] = keywordOverrides
	}
	if len(loadoutGroups) > 0 {
		result["loadout_groups"] = loadoutGroups
	}
	return result
}

func rzSnapshotOf(env map[string]any) map[string]any {
	if snap := rzObj(env["snapshot"]); snap != nil {
		return snap
	}
	if history := rzObj(env["history"]); history != nil {
		if present := rzObj(history["present"]); present != nil {
			if pr := rzObj(present["roster"]); pr != nil {
				return pr
			}
		}
	}
	return nil
}

func isRosterizerEnvelope(decoded any) bool {
	env := rzObj(decoded)
	if env == nil {
		return false
	}
	if rzObj(env["rulebook"]) == nil {
		return false
	}
	return rzSnapshotOf(env) != nil
}

var rosterizerAdapter = formatAdapter{
	id:      "rosterizer",
	matches: func(decoded any) bool { return isRosterizerEnvelope(decoded) },
	parse: func(decoded any) (map[string]any, error) {
		if !isRosterizerEnvelope(decoded) {
			return nil, errors.New("rosterizer: payload is not a Rosterizer roster envelope")
		}
		root := rzSnapshotOf(rzObj(decoded))
		if root == nil {
			return nil, errors.New("rosterizer: envelope has no snapshot or history.present.roster")
		}
		var factionRaw, battleSizeRaw, forceDispositionRaw any
		detachmentRawNames := []any{}
		var factions []string
		seenFaction := map[string]bool{}
		rzWalk(root, func(a map[string]any) {
			switch rzClassOf(a) {
			case clsFaction:
				name := rzDisplayName(a)
				if !seenFaction[name] {
					seenFaction[name] = true
					factions = append(factions, name)
				}
				if factionRaw == nil {
					factionRaw = name
				}
			case clsDetachment:
				detachmentRawNames = append(detachmentRawNames, rzDisplayName(a))
			case clsBattleSize:
				if battleSizeRaw == nil {
					battleSizeRaw = rzDisplayName(a)
				}
			case clsForceDisposition:
				if forceDispositionRaw == nil {
					forceDispositionRaw = rzDisplayName(a)
				}
			}
		})

		var units []map[string]any
		var collect func(a map[string]any, underUnit bool)
		collect = func(a map[string]any, underUnit bool) {
			if rzIsUnit(a) && !underUnit {
				units = append(units, rzParseUnit(a))
				for _, c := range rzIncluded(a) {
					collect(c, true)
				}
				for _, c := range rzTraits(a) {
					collect(c, true)
				}
				return
			}
			if rzIsUnit(a) && underUnit {
				units = append(units, rzParseUnit(a))
				return
			}
			for _, c := range rzIncluded(a) {
				collect(c, underUnit)
			}
			for _, c := range rzTraits(a) {
				collect(c, underUnit)
			}
		}
		collect(root, false)

		totalReported := rzPointsOf(root)
		totalComputed := 0.0
		for _, u := range units {
			if p, ok := u["points"].(float64); ok {
				totalComputed += p
			}
			if p, ok := u["enhancement_points"].(float64); ok {
				totalComputed += p
			}
		}
		rulebook := rzObj(rzObj(decoded)["rulebook"])
		var generatedBy any
		if rulebook != nil {
			generatedBy = asStringOrNil(rulebook["name"])
			if generatedBy == nil {
				generatedBy = asStringOrNil(rulebook["url"])
			}
		}
		name := rzDisplayName(root)
		if name == "" {
			if rulebook != nil {
				if s, ok := rulebook["name"].(string); ok {
					name = s
				}
			}
			if name == "" {
				name = "Imported roster"
			}
		}
		return map[string]any{
			"name":                       name,
			"generated_by":               generatedBy,
			"faction_raw_name":           factionRaw,
			"detachment_raw_names":       detachmentRawNames,
			"battle_size_raw":            battleSizeRaw,
			"force_disposition_raw_name": forceDispositionRaw,
			"declared_limit":             parseLimit(battleSizeRaw),
			"total_reported":             totalReported,
			"total_computed":             totalComputed,
			"units":                      mapsToAny(units),
			"multi_force":                len(factions) > 1,
		}, nil
	},
}
