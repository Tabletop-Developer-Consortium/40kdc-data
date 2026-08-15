package wh40kdc

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

// NewRecruit "simple" markdown-ish text adapter. Go mirror of
// python .../imports/newrecruit_simple.py.

var simpleFirstLine = regexp.MustCompile(`(?i)^(.+)\s-\s\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\]\s*$`)
var simpleRosterHeader = regexp.MustCompile(`(?i)^#\s*\+\+\s*Army Roster\s*\+\+\s*\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\]\s*$`)
var simpleRosterHeaderAnywhere = regexp.MustCompile(`(?m)^#\s*\+\+\s*Army Roster\s*\+\+`)
var simpleSectionHeaderAnywhere = regexp.MustCompile(`(?m)^##\s+`)
var simpleSectionHeader = regexp.MustCompile(`^##\s*(.+?)(?:\s*\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\])?\s*$`)
var simpleUnitLine = regexp.MustCompile(`(?i)^(.+?)\s*\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\](?:\s*:\s*(.*))?$`)
var simpleBullet = regexp.MustCompile(`^\s*•\s*(\d+)x\s+(.+?)(?:\s*\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\])?(?:\s*:\s*(.*))?\s*$`)
var simpleUnitTotalPrefix = regexp.MustCompile(`(?i)^Unit total:\s*`)
var simpleAttachmentToken = regexp.MustCompile(`(?i)^Attachment:\s*(leader|support)\s*->\s*(.+?)(\s+\[provisional\])?$`)

type simpleUnit struct {
	rawName            string
	isCharacter        bool
	isWarlord          bool
	keywordOverrides   []string
	enhancementRawName any
	enhancementPts     any
	displayedPts       any
	modelCount         int
	leaderAttachment   any
	loadoutGroups      []any
	wargear            *orderedCounter
}

func simpleApplyTokens(u *simpleUnit, tokensCSV string, multiplier int) []any {
	var wargearTokens []string
	for _, token := range splitWargearList(tokensCSV) {
		if m := simpleAttachmentToken.FindStringSubmatch(token); m != nil {
			u.leaderAttachment = map[string]any{
				"role":               strings.ToLower(m[1]),
				"bodyguard_raw_name": strings.TrimSpace(m[2]),
				"provisional":        m[3] != "",
			}
			continue
		}
		wargearTokens = append(wargearTokens, token)
	}
	cls := classifyWargearList(wargearTokens)
	if cls.isWarlord {
		u.isWarlord = true
	}
	if cls.isCharacter {
		u.isCharacter = true
	}
	u.keywordOverrides = append(u.keywordOverrides, cls.keywordOverrides...)
	if cls.enhancementRawName != nil && u.enhancementRawName == nil {
		u.enhancementRawName = cls.enhancementRawName
		u.enhancementPts = cls.enhancementPoints
	}
	for _, wAny := range cls.wargear {
		w := wAny.(map[string]any)
		u.wargear.add(getStr(w, "raw_name"), asInt(w["count"])*multiplier)
	}
	return cls.wargear
}

func finishSimpleUnit(u *simpleUnit) map[string]any {
	var points any
	if u.displayedPts != nil {
		points = float64(asInt(u.displayedPts) - asInt(u.enhancementPts))
	}
	var keywordOverrides any
	if len(u.keywordOverrides) > 0 {
		keywordOverrides = strSliceToAny(u.keywordOverrides)
	}
	result := map[string]any{
		"raw_name":             u.rawName,
		"is_character":         u.isCharacter,
		"model_count":          float64(u.modelCount),
		"points":               points,
		"is_warlord":           u.isWarlord,
		"enhancement_raw_name": u.enhancementRawName,
		"enhancement_points":   u.enhancementPts,
		"leader_attachment":    u.leaderAttachment,
		"wargear":              u.wargear.pairs(),
	}
	if keywordOverrides != nil {
		result["keyword_overrides"] = keywordOverrides
	}
	if len(u.loadoutGroups) > 0 {
		result["loadout_groups"] = u.loadoutGroups
	}
	return result
}

func firstNonBlank(lines []string) (string, bool) {
	for _, l := range lines {
		if strings.TrimSpace(l) != "" {
			return l, true
		}
	}
	return "", false
}

var newrecruitSimpleAdapter = formatAdapter{
	id: "newrecruit-simple",
	matches: func(decoded any) bool {
		s, ok := decoded.(string)
		if !ok {
			return false
		}
		fnb, ok := firstNonBlank(splitLines(s))
		if !ok {
			return false
		}
		if !simpleFirstLine.MatchString(fnb) {
			return false
		}
		return simpleRosterHeaderAnywhere.MatchString(s) || simpleSectionHeaderAnywhere.MatchString(s)
	},
	parse: parseSimple,
}

func parseSimple(decoded any) (map[string]any, error) {
	text, ok := decoded.(string)
	if !ok {
		return nil, errors.New("newrecruit-simple: input is not a string")
	}
	lines := splitLines(text)
	name := "Imported roster"
	var factionRaw, declaredLimit, totalReported, battleSizeRaw, forceDispositionRaw any
	detachmentRawNames := []any{}
	var units []map[string]any
	var current *simpleUnit
	multiForce := false
	section := "preamble"
	var enhPts []any

	finalize := func() {
		if current != nil {
			enhPts = append(enhPts, current.enhancementPts)
			units = append(units, finishSimpleUnit(current))
			current = nil
		}
	}

	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		if section == "preamble" && name == "Imported roster" {
			if m := simpleFirstLine.FindStringSubmatch(line); m != nil {
				dl, _ := strconv.Atoi(m[2])
				parts := splitDashParts(m[1])
				if len(parts) > 0 {
					name = parts[len(parts)-1]
					if len(parts) >= 2 {
						factionRaw = parts[len(parts)-2]
					}
					declaredLimit = float64(dl)
					continue
				}
			}
		}
		if m := simpleRosterHeader.FindStringSubmatch(line); m != nil {
			n, _ := strconv.Atoi(m[1])
			totalReported = float64(n)
			continue
		}
		if m := simpleSectionHeader.FindStringSubmatch(line); m != nil {
			finalize()
			heading := strings.ToLower(strings.TrimSpace(m[1]))
			if heading == "configuration" {
				section = "configuration"
			} else {
				section = "units"
				if strings.Contains(heading, "allied") {
					multiForce = true
				}
			}
			continue
		}
		if section == "configuration" {
			if simpleUnitLine.MatchString(line) {
				section = "units"
			} else {
				if idx := strings.Index(line, ":"); idx > 0 {
					key := strings.ToLower(strings.TrimSpace(line[:idx]))
					value := strings.TrimSpace(line[idx+1:])
					if key == "battle size" {
						battleSizeRaw = value
					} else if key == "list name" {
						name = value
					} else if key == "faction" {
						factionRaw = value
					} else if key == "force disposition" {
						forceDispositionRaw = value
					} else if key == "detachment" {
						detachmentRawNames = append(detachmentRawNames, stripParenthetical(value))
					}
				}
				continue
			}
		}
		if bm := simpleBullet.FindStringSubmatch(raw); bm != nil && current != nil {
			count, _ := strconv.Atoi(bm[1])
			if current.wargear.empty() && current.modelCount == 1 {
				current.modelCount = count
			} else {
				current.modelCount += count
			}
			if bm[4] != "" {
				unitTotal := simpleUnitTotalPrefix.MatchString(bm[4])
				groupWargear := simpleApplyTokens(current, simpleUnitTotalPrefix.ReplaceAllString(bm[4], ""), map[bool]int{true: 1, false: count}[unitTotal])
				if !unitTotal {
					current.loadoutGroups = append(current.loadoutGroups, map[string]any{
						"model_name": strings.TrimSpace(bm[2]),
						"count":      float64(count),
						"wargear":    groupWargear,
					})
				}
			}
			continue
		}
		if m := simpleUnitLine.FindStringSubmatch(line); m != nil {
			finalize()
			pts, _ := strconv.Atoi(m[2])
			current = &simpleUnit{rawName: strings.TrimSpace(m[1]), displayedPts: float64(pts), modelCount: 1, wargear: newOrderedCounter()}
			if inline := strings.TrimSpace(m[3]); inline != "" {
				simpleApplyTokens(current, inline, 1)
			}
			continue
		}
	}
	finalize()

	totalComputed := 0.0
	for i, u := range units {
		if p, ok := u["points"].(float64); ok {
			totalComputed += p
		}
		totalComputed += asFloat(enhPts[i])
	}
	return map[string]any{
		"name":                       name,
		"generated_by":               nil,
		"faction_raw_name":           factionRaw,
		"detachment_raw_names":       detachmentRawNames,
		"battle_size_raw":            battleSizeRaw,
		"force_disposition_raw_name": forceDispositionRaw,
		"declared_limit":             declaredLimit,
		"total_reported":             totalReported,
		"total_computed":             totalComputed,
		"units":                      mapsToAny(units),
		"multi_force":                multiForce,
	}, nil
}

func splitDashParts(s string) []string {
	var out []string
	for _, p := range strings.Split(s, " - ") {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
