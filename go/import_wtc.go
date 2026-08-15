package wh40kdc

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

// NewRecruit wtc-compact / wtc-full text adapters. Go mirror of
// python .../imports/newrecruit_wtc.py.

const wtcHeaderPrefix = "+ FACTION KEYWORD:"

var wtcHeaderFaction = regexp.MustCompile(`(?i)^\+\s*FACTION KEYWORD:\s*(.+?)\s*$`)
var wtcHeaderDetachment = regexp.MustCompile(`(?i)^\+\s*DETACHMENT:\s*(.+?)\s*$`)
var wtcHeaderForceDisposition = regexp.MustCompile(`(?i)^\+\s*FORCE DISPOSITION:\s*(.+?)\s*$`)
var wtcHeaderTotalPoints = regexp.MustCompile(`(?i)^\+\s*TOTAL ARMY POINTS:\s*(\d+)\s*pts?\s*$`)
var wtcHeaderPointsLimit = regexp.MustCompile(`(?i)^\+\s*POINTS LIMIT:\s*(\d+)\s*pts?\s*$`)
var wtcHeaderListName = regexp.MustCompile(`(?i)^\+\s*LIST NAME:\s*(.+?)\s*$`)
var fenceRe = regexp.MustCompile(`^\++\s*$`)

var unitHeaderCompact = regexp.MustCompile(`(?i)^(?:Char\d+:\s*)?(\d+)x\s+(.+?)\s*\(\s*(\d+)\s*pts?\s*\)\s*:\s*(.*)$`)
var unitHeaderFull = regexp.MustCompile(`(?i)^(?:Char\d+:\s*)?(\d+)x\s+(.+?)\s*\(\s*(\d+)\s*pts?\s*\)\s*$`)
var enhancementLineRe = regexp.MustCompile(`(?i)^Enhancement:\s*(.+?)(?:\s*\(\+\s*(\d+)\s*pts?\s*\))?\s*$`)
var attachmentLineRe = regexp.MustCompile(`(?i)^Attachment:\s*(leader|support)\s*->\s*(.+?)(\s+\[provisional\])?\s*$`)
var withPrefixRe = regexp.MustCompile(`(?i)^(\d+)\s+with\s+(.*)$`)

// Optional trailing `: <wargear>` — NewRecruit inlines a model group's loadout
// after the model type (`• 1x Champion: Chainblades`) instead of always
// breaking it onto `N with` continuation lines.
var modelBreakdownRe = regexp.MustCompile(`^\s*•\s*(\d+)x\s+([^:]+?)(?:\s*\[[^\]]*\])?\s*(?::\s*(.+))?$`)
var sectionHeaderRe = regexp.MustCompile(`^[A-Z][A-Z0-9 \-/&]+$`)
var headerLineRe = regexp.MustCompile(`^\+`)
var charPrefixRe = regexp.MustCompile(`(?i)^Char\d+:`)

type wtcHeader struct {
	name                    string
	factionRawName          any
	detachmentRawNames      []any
	forceDispositionRawName any
	declaredLimit           any
	totalReported           any
	battleSizeRaw           any
}

func parseWtcHeader(text string) (*wtcHeader, int, bool) {
	lines := splitLines(text)
	var factionRaw, forceDispositionRaw, totalReported, pointsLimit, listName any
	detachmentRawNames := []any{}
	fenceIndices := []int{}
	for i, line := range lines {
		if len(fenceIndices) >= 2 {
			break
		}
		if fenceRe.MatchString(line) {
			fenceIndices = append(fenceIndices, i)
		}
	}
	sawFaction := false
	for _, line := range lines {
		if !strings.HasPrefix(line, "+") {
			continue
		}
		if m := wtcHeaderFaction.FindStringSubmatch(line); m != nil {
			factionRaw = factionFromKeyword(m[1])
			sawFaction = true
			continue
		}
		if m := wtcHeaderDetachment.FindStringSubmatch(line); m != nil {
			name := stripParenthetical(m[1])
			if name != "—" {
				detachmentRawNames = append(detachmentRawNames, name)
			}
			continue
		}
		if m := wtcHeaderForceDisposition.FindStringSubmatch(line); m != nil {
			forceDispositionRaw = m[1]
			continue
		}
		if m := wtcHeaderTotalPoints.FindStringSubmatch(line); m != nil {
			n, _ := strconv.Atoi(m[1])
			totalReported = float64(n)
			continue
		}
		if m := wtcHeaderPointsLimit.FindStringSubmatch(line); m != nil {
			n, _ := strconv.Atoi(m[1])
			pointsLimit = float64(n)
			continue
		}
		if m := wtcHeaderListName.FindStringSubmatch(line); m != nil {
			listName = m[1]
		}
	}
	if !sawFaction {
		return nil, 0, false
	}
	bodyStart := 0
	if len(fenceIndices) >= 2 {
		bodyStart = fenceIndices[1] + 1
	}
	declaredLimit := pointsLimit
	if declaredLimit == nil {
		declaredLimit = totalReported
	}
	name := "Imported roster"
	if s, ok := listName.(string); ok {
		name = s
	}
	return &wtcHeader{
		name: name, factionRawName: factionRaw, detachmentRawNames: detachmentRawNames,
		forceDispositionRawName: forceDispositionRaw,
		declaredLimit:           declaredLimit, totalReported: totalReported,
		battleSizeRaw: inferBattleSizeRaw(declaredLimit),
	}, bodyStart, true
}

type wtcLoadoutGroup struct {
	modelName string
	count     int
	wargear   []any
}

type wtcUnit struct {
	rawName            string
	isCharacter        bool
	isWarlord          bool
	keywordOverrides   []string
	enhancementRawName any
	displayedPts       any
	enhancementPts     any
	leaderAttachment   any
	modelCount         int
	loadoutGroups      []wtcLoadoutGroup
	wargear            *orderedCounter
}

func newWtcUnit(name string, displayedPts int, leadingCount int, isCharPrefix bool) *wtcUnit {
	mc := leadingCount
	if mc <= 0 {
		mc = 1
	}
	return &wtcUnit{
		rawName: name, isCharacter: isCharPrefix, displayedPts: float64(displayedPts),
		modelCount: mc, wargear: newOrderedCounter(),
	}
}

func parseWithGroup(text string, defaultMultiplier int) (int, string) {
	if m := withPrefixRe.FindStringSubmatch(text); m != nil {
		n, _ := strconv.Atoi(m[1])
		if n <= 0 {
			n = 1
		}
		return n, m[2]
	}
	return defaultMultiplier, text
}

func applyWithGroup(unit *wtcUnit, listText string, defaultMultiplier int) []any {
	multiplier, wargearList := parseWithGroup(listText, defaultMultiplier)
	cls := classifyWargearList(splitWargearList(wargearList))
	if cls.isWarlord {
		unit.isWarlord = true
	}
	if cls.isCharacter {
		unit.isCharacter = true
	}
	unit.keywordOverrides = append(unit.keywordOverrides, cls.keywordOverrides...)
	for _, wAny := range cls.wargear {
		w := wAny.(map[string]any)
		unit.wargear.add(getStr(w, "raw_name"), asInt(w["count"])*multiplier)
	}
	return cls.wargear
}

func finishWtcUnit(unit *wtcUnit) map[string]any {
	var points any
	if unit.displayedPts != nil {
		points = float64(asInt(unit.displayedPts) - asInt(unit.enhancementPts))
	}
	var enhPts any
	if unit.enhancementRawName != nil {
		enhPts = unit.enhancementPts
	}
	result := map[string]any{
		"raw_name":             unit.rawName,
		"is_character":         unit.isCharacter,
		"model_count":          float64(unit.modelCount),
		"points":               points,
		"is_warlord":           unit.isWarlord,
		"enhancement_raw_name": unit.enhancementRawName,
		"enhancement_points":   enhPts,
		"wargear":              unit.wargear.pairs(),
	}
	if len(unit.keywordOverrides) > 0 {
		overrides := make([]any, len(unit.keywordOverrides))
		for i, keyword := range unit.keywordOverrides {
			overrides[i] = keyword
		}
		result["keyword_overrides"] = overrides
	}
	if unit.leaderAttachment != nil {
		result["leader_attachment"] = unit.leaderAttachment
	}
	if len(unit.loadoutGroups) > 0 {
		groups := make([]any, 0, len(unit.loadoutGroups))
		for _, group := range unit.loadoutGroups {
			groups = append(groups, map[string]any{
				"model_name": group.modelName, "count": float64(group.count), "wargear": group.wargear,
			})
		}
		result["loadout_groups"] = groups
	}
	return result
}

func computeWtcTotal(units []map[string]any, enhPts []any) float64 {
	total := 0.0
	for i, u := range units {
		if p, ok := u["points"].(float64); ok {
			total += p
		}
		if i < len(enhPts) && enhPts[i] != nil {
			total += asFloat(enhPts[i])
		}
	}
	return total
}

func parseCompactBody(body string) ([]map[string]any, []any) {
	lines := splitLines(body)
	var units []map[string]any
	var enhPts []any
	var current *wtcUnit
	finalize := func() {
		if current != nil {
			units = append(units, finishWtcUnit(current))
			enhPts = append(enhPts, current.enhancementPts)
			current = nil
		}
	}
	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" || headerLineRe.MatchString(line) || fenceRe.MatchString(line) {
			continue
		}
		if enh := enhancementLineRe.FindStringSubmatch(line); enh != nil && current != nil {
			current.enhancementRawName = strings.TrimSpace(enh[1])
			if enh[2] != "" {
				pts, _ := strconv.Atoi(enh[2])
				current.enhancementPts = float64(pts)
			}
			finalize()
			continue
		}
		if attachment := attachmentLineRe.FindStringSubmatch(line); attachment != nil && current != nil {
			current.leaderAttachment = map[string]any{
				"role": strings.ToLower(attachment[1]), "bodyguard_raw_name": attachment[2], "provisional": attachment[3] != "",
			}
			continue
		}
		if bd := modelBreakdownRe.FindStringSubmatch(raw); bd != nil && current != nil {
			count, _ := strconv.Atoi(bd[1])
			groupWargear := []any{}
			if bd[3] != "" {
				groupWargear = applyWithGroup(current, bd[3], count)
			}
			current.loadoutGroups = append(current.loadoutGroups, wtcLoadoutGroup{
				modelName: strings.TrimSpace(bd[2]), count: count, wargear: groupWargear,
			})
			continue
		}
		if m := unitHeaderCompact.FindStringSubmatch(line); m != nil {
			finalize()
			leadingCount, _ := strconv.Atoi(m[1])
			pts, _ := strconv.Atoi(m[3])
			current = newWtcUnit(strings.TrimSpace(m[2]), pts, leadingCount, charPrefixRe.MatchString(line))
			applyWithGroup(current, m[4], 1)
			continue
		}
	}
	finalize()
	return units, enhPts
}

func parseFullBody(body string) ([]map[string]any, []any) {
	lines := splitLines(body)
	var units []map[string]any
	var enhPts []any
	var current *wtcUnit
	breakdownModels := 0
	type pendingBreakdown struct {
		modelName     string
		count         int
		assignedCount int
	}
	var pending *pendingBreakdown
	flushPendingBreakdown := func() {
		if current == nil || pending == nil {
			return
		}
		if remaining := pending.count - pending.assignedCount; remaining > 0 {
			current.loadoutGroups = append(current.loadoutGroups, wtcLoadoutGroup{
				modelName: pending.modelName, count: remaining, wargear: []any{},
			})
		}
		pending = nil
	}
	finalize := func() {
		if current != nil {
			flushPendingBreakdown()
			if breakdownModels > 0 {
				current.modelCount = breakdownModels
			}
			units = append(units, finishWtcUnit(current))
			enhPts = append(enhPts, current.enhancementPts)
			current = nil
			breakdownModels = 0
		}
	}
	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" || headerLineRe.MatchString(line) || fenceRe.MatchString(line) {
			continue
		}
		if sectionHeaderRe.MatchString(line) && !unitHeaderFull.MatchString(line) {
			finalize()
			continue
		}
		if enh := enhancementLineRe.FindStringSubmatch(line); enh != nil && current != nil {
			current.enhancementRawName = strings.TrimSpace(enh[1])
			if enh[2] != "" {
				pts, _ := strconv.Atoi(enh[2])
				current.enhancementPts = float64(pts)
			}
			continue
		}
		if attachment := attachmentLineRe.FindStringSubmatch(line); attachment != nil && current != nil {
			current.leaderAttachment = map[string]any{
				"role": strings.ToLower(attachment[1]), "bodyguard_raw_name": attachment[2], "provisional": attachment[3] != "",
			}
			continue
		}
		if m := unitHeaderFull.FindStringSubmatch(line); m != nil {
			finalize()
			leadingCount, _ := strconv.Atoi(m[1])
			pts, _ := strconv.Atoi(m[3])
			current = newWtcUnit(strings.TrimSpace(m[2]), pts, leadingCount, charPrefixRe.MatchString(line))
			continue
		}
		// Single-model units (characters, vehicles) appear compact-style even
		// in full exports: `[CharN: ]Nx <Unit> (P pts): <wargear>` on one
		// line. Without this branch they fall through every matcher and vanish.
		if m := unitHeaderCompact.FindStringSubmatch(line); m != nil {
			finalize()
			leadingCount, _ := strconv.Atoi(m[1])
			pts, _ := strconv.Atoi(m[3])
			current = newWtcUnit(strings.TrimSpace(m[2]), pts, leadingCount, charPrefixRe.MatchString(line))
			applyWithGroup(current, m[4], 1)
			continue
		}
		if bd := modelBreakdownRe.FindStringSubmatch(raw); bd != nil && current != nil {
			flushPendingBreakdown()
			n, _ := strconv.Atoi(bd[1])
			breakdownModels += n
			modelName := strings.TrimSpace(bd[2])
			pending = &pendingBreakdown{modelName: modelName, count: n}
			if bd[3] != "" {
				groupWargear := applyWithGroup(current, bd[3], n)
				multiplier, _ := parseWithGroup(bd[3], n)
				current.loadoutGroups = append(current.loadoutGroups, wtcLoadoutGroup{
					modelName: modelName, count: multiplier, wargear: groupWargear,
				})
				pending.assignedCount = multiplier
			}
			continue
		}
		if withPrefixRe.MatchString(line) && current != nil {
			groupWargear := applyWithGroup(current, line, 1)
			if pending != nil {
				multiplier, _ := parseWithGroup(line, 1)
				current.loadoutGroups = append(current.loadoutGroups, wtcLoadoutGroup{
					modelName: pending.modelName, count: multiplier, wargear: groupWargear,
				})
				pending.assignedCount += multiplier
			}
			continue
		}
	}
	finalize()
	return units, enhPts
}

var alliedUnitsRe = regexp.MustCompile(`(?im)^ALLIED UNITS\s*$`)

func detectMultiForce(text, format string) bool {
	if format == "wtc-full" {
		return alliedUnitsRe.MatchString(text)
	}
	return false
}

func isWtcText(decoded any) (string, bool) {
	s, ok := decoded.(string)
	if !ok {
		return "", false
	}
	if !strings.Contains(s, wtcHeaderPrefix) {
		return "", false
	}
	return s, true
}

var fullFormatRe = regexp.MustCompile(`(?m)^[\t ]*\d+\s+with\b`)
var bulletsRe = regexp.MustCompile(`(?m)^[\t ]*•`)
var serializedFullFormatRe = regexp.MustCompile(`(?im)^\+\s*LIST NAME:.*$`)
var battlelineHeaderRe = regexp.MustCompile(`(?m)^BATTLELINE\s*$`)

func isFullFormat(text string) bool { return fullFormatRe.MatchString(text) }
func hasBullets(text string) bool   { return bulletsRe.MatchString(text) }

func parseWtcWithFormat(text, format string) (map[string]any, error) {
	header, bodyStart, ok := parseWtcHeader(text)
	if !ok {
		return nil, errors.New(format + ": missing \"+ FACTION KEYWORD:\" header")
	}
	bodyLines := splitLines(text)[bodyStart:]
	body := strings.Join(bodyLines, "\n")
	var units []map[string]any
	var enhPts []any
	if format == "wtc-full" {
		units, enhPts = parseFullBody(body)
	} else {
		units, enhPts = parseCompactBody(body)
	}
	return map[string]any{
		"name":                       header.name,
		"generated_by":               nil,
		"faction_raw_name":           header.factionRawName,
		"detachment_raw_names":       header.detachmentRawNames,
		"force_disposition_raw_name": header.forceDispositionRawName,
		"battle_size_raw":            header.battleSizeRaw,
		"declared_limit":             header.declaredLimit,
		"total_reported":             header.totalReported,
		"total_computed":             computeWtcTotal(units, enhPts),
		"units":                      mapsToAny(units),
		"multi_force":                detectMultiForce(text, format),
	}, nil
}

func mapsToAny(units []map[string]any) []any {
	out := make([]any, len(units))
	for i, u := range units {
		out[i] = u
	}
	return out
}

func firstCompactUnitLine(text string) string {
	for _, line := range splitLines(text) {
		if unitHeaderCompact.MatchString(strings.TrimSpace(line)) {
			return strings.TrimSpace(line)
		}
	}
	return ""
}

var newrecruitWtcCompactAdapter = formatAdapter{
	id: "newrecruit-wtc-compact",
	matches: func(decoded any) bool {
		text, ok := isWtcText(decoded)
		if !ok {
			return false
		}
		return !isFullFormat(text) && !(serializedFullFormatRe.MatchString(text) && battlelineHeaderRe.MatchString(text)) && unitHeaderCompact.MatchString(firstCompactUnitLine(text))
	},
	parse: func(decoded any) (map[string]any, error) {
		text, ok := isWtcText(decoded)
		if !ok {
			return nil, errors.New("newrecruit-wtc-compact: input is not a string")
		}
		return parseWtcWithFormat(text, "wtc-compact")
	},
}

var newrecruitWtcFullAdapter = formatAdapter{
	id: "newrecruit-wtc-full",
	matches: func(decoded any) bool {
		text, ok := isWtcText(decoded)
		if !ok {
			return false
		}
		return isFullFormat(text) || (serializedFullFormatRe.MatchString(text) && battlelineHeaderRe.MatchString(text))
	},
	parse: func(decoded any) (map[string]any, error) {
		text, ok := isWtcText(decoded)
		if !ok {
			return nil, errors.New("newrecruit-wtc-full: input is not a string")
		}
		return parseWtcWithFormat(text, "wtc-full")
	},
}
