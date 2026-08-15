package wh40kdc

import (
	"regexp"
	"strconv"
	"strings"
)

// Shared walker for BattleScribe-derived roster trees (ListForge + NewRecruit
// JSON). Reads an allowlist of fields only. Go mirror of
// python .../imports/battlescribe.py.

const ptsCostName = "pts"
const enhancementGroupPrefix = "Enhancements"
const weaponCategorySuffix = " Weapon"
const newrecruitXMLNS = "http://www.battlescribe.net/schema/rosterSchema"
const newrecruitHostPrefix = "https://newrecruit"

var factionCategoryRe = regexp.MustCompile(`^Faction:\s*(.+)$`)
var pointsLimitRe = regexp.MustCompile(`(?i)(\d[\d,]*)\s*Point`)

var characterCategories = map[string]bool{"Character": true, "Epic Hero": true}
var attachmentGroupRe = regexp.MustCompile(`^40kdc Attachment:(leader|support):(confirmed|provisional)$`)

func bsField(sel any, key string) any {
	if m, ok := sel.(map[string]any); ok {
		return m[key]
	}
	return nil
}

func selectionName(sel any) string {
	if s, ok := bsField(sel, "name").(string); ok {
		return s
	}
	return ""
}

func selectionType(sel any) string {
	if s, ok := bsField(sel, "type").(string); ok {
		return s
	}
	return ""
}

func selectionCount(sel any) int {
	n := bsField(sel, "number")
	if f, ok := n.(float64); ok && f > 0 {
		return int(f)
	}
	return 1
}

// pointsOf returns the pts cost as float64, or nil.
func pointsOf(sel any) any {
	for _, costAny := range asArrayOf(bsField(sel, "costs")) {
		cost, ok := costAny.(map[string]any)
		if !ok {
			continue
		}
		if name, _ := cost["name"].(string); name == ptsCostName {
			if v, ok := cost["value"].(float64); ok {
				return v
			}
		}
	}
	return nil
}

func categoryNames(sel any) []string {
	var out []string
	for _, cAny := range asArrayOf(bsField(sel, "categories")) {
		if c, ok := cAny.(map[string]any); ok {
			if name, ok := c["name"].(string); ok {
				out = append(out, name)
			}
		}
	}
	return out
}
func keywordOverrides(sel any) []any {
	var out []any
	for _, categoryAny := range asArrayOf(bsField(sel, "categories")) {
		category, _ := asMap(categoryAny)
		id := getStr(category, "id")
		if strings.HasPrefix(id, "40kdc-keyword-") {
			if name := getStr(category, "name"); name != "" {
				out = append(out, name)
			}
		}
	}
	return out
}

func childSelections(sel any) []any { return asArrayOf(bsField(sel, "selections")) }

func asArrayOf(v any) []any {
	if l, ok := v.([]any); ok {
		return l
	}
	return nil
}

func bsWalk(sel any, visit func(any)) {
	visit(sel)
	for _, child := range childSelections(sel) {
		bsWalk(child, visit)
	}
}

func isUnitSelection(sel any) bool {
	t := selectionType(sel)
	return t == "model" || t == "unit"
}

func isCharacterSel(sel any) bool {
	for _, n := range categoryNames(sel) {
		if characterCategories[n] {
			return true
		}
	}
	return false
}

func isWeaponSelection(sel any) bool {
	for _, n := range categoryNames(sel) {
		if strings.HasSuffix(n, weaponCategorySuffix) {
			return true
		}
	}
	return false
}

func isEnhancementSelection(sel any) bool {
	if g, ok := bsField(sel, "group").(string); ok {
		return strings.HasPrefix(g, enhancementGroupPrefix)
	}
	return false
}

func bsModelCount(unit any) int {
	total := 0
	bsWalk(unit, func(s any) {
		if selectionType(s) == "model" {
			total += selectionCount(s)
		}
	})
	if total > 0 {
		return total
	}
	return selectionCount(unit)
}

func bsParseUnit(unit any) map[string]any {
	wargear := []any{}
	var enhancementRawName any
	var enhancementPoints any
	var leaderAttachment any
	isWarlord := false
	visit := func(s any) {
		group, _ := bsField(s, "group").(string)
		if attachment := attachmentGroupRe.FindStringSubmatch(group); attachment != nil {
			leaderAttachment = map[string]any{
				"bodyguard_raw_name": selectionName(s), "role": attachment[1], "provisional": attachment[2] == "provisional",
			}
			return
		}
		if isEnhancementSelection(s) {
			if enhancementRawName == nil {
				enhancementRawName = selectionName(s)
				enhancementPoints = pointsOf(s)
			}
			return
		}
		if selectionName(s) == "Warlord" {
			isWarlord = true
			return
		}
		if isWeaponSelection(s) {
			wargear = append(wargear, map[string]any{
				"raw_name": selectionName(s), "count": float64(selectionCount(s)),
			})
		}
	}
	for _, node := range childSelections(unit) {
		bsWalk(node, visit)
	}
	loadoutGroups := []any{}
	for _, model := range childSelections(unit) {
		if selectionType(model) != "model" {
			continue
		}
		count := selectionCount(model)
		totals := []any{}
		bsWalk(model, func(selection any) {
			if isWeaponSelection(selection) {
				totals = append(totals, map[string]any{
					"raw_name": selectionName(selection), "count": float64(selectionCount(selection)),
				})
			}
		})
		if count <= 0 {
			continue
		}
		divisible := true
		for _, totalAny := range totals {
			if asInt(totalAny.(map[string]any)["count"])%count != 0 {
				divisible = false
				break
			}
		}
		if !divisible {
			continue
		}
		perModel := make([]any, 0, len(totals))
		for _, totalAny := range totals {
			total := totalAny.(map[string]any)
			perModel = append(perModel, map[string]any{
				"raw_name": total["raw_name"], "count": float64(asInt(total["count"]) / count),
			})
		}
		loadoutGroups = append(loadoutGroups, map[string]any{
			"model_name": selectionName(model), "count": float64(count), "wargear": perModel,
		})
	}
	result := map[string]any{
		"raw_name":             selectionName(unit),
		"is_character":         isCharacterSel(unit),
		"keyword_overrides":    keywordOverrides(unit),
		"model_count":          float64(bsModelCount(unit)),
		"points":               pointsOf(unit),
		"is_warlord":           isWarlord,
		"enhancement_raw_name": enhancementRawName,
		"enhancement_points":   enhancementPoints,
		"wargear":              wargear,
	}
	if leaderAttachment != nil {
		result["leader_attachment"] = leaderAttachment
	}
	if len(loadoutGroups) > 0 {
		result["loadout_groups"] = loadoutGroups
	}
	return result
}

func bsConfigValue(selections []any, configName string) any {
	for _, s := range selections {
		if selectionName(s) == configName {
			children := childSelections(s)
			if len(children) > 0 {
				return selectionName(children[0])
			}
			return nil
		}
	}
	return nil
}

func bsConfigValues(selections []any, configName string) []string {
	var out []string
	for _, s := range selections {
		if selectionName(s) != configName {
			continue
		}
		for _, child := range childSelections(s) {
			if name := selectionName(child); name != "" {
				out = append(out, name)
			}
		}
	}
	return out
}

func parseLimit(label any) any {
	s, ok := label.(string)
	if !ok || s == "" {
		return nil
	}
	m := pointsLimitRe.FindStringSubmatch(s)
	if m == nil {
		return nil
	}
	n, _ := strconv.Atoi(strings.ReplaceAll(m[1], ",", ""))
	return float64(n)
}

func collectFactions(forces []any) []string {
	var order []string
	seen := map[string]bool{}
	visit := func(s any) {
		for _, name := range categoryNames(s) {
			if mm := factionCategoryRe.FindStringSubmatch(name); mm != nil {
				f := strings.TrimSpace(mm[1])
				if !seen[f] {
					seen[f] = true
					order = append(order, f)
				}
			}
		}
	}
	for _, force := range forces {
		for _, sel := range childSelections(force) {
			bsWalk(sel, visit)
		}
	}
	return order
}

func rosterOf(decoded any) map[string]any {
	d, ok := decoded.(map[string]any)
	if !ok {
		return nil
	}
	roster, ok := d["roster"].(map[string]any)
	if !ok {
		return nil
	}
	if _, ok := roster["forces"].([]any); !ok {
		return nil
	}
	return roster
}

func hasNewrecruitSignature(decoded any, roster map[string]any) bool {
	if x, ok := roster["xmlns"].(string); ok && x == newrecruitXMLNS {
		return true
	}
	genBy, _ := bsField(decoded, "generatedBy").(string)
	if genBy == "" {
		genBy, _ = roster["generatedBy"].(string)
	}
	return genBy != "" && strings.HasPrefix(strings.ToLower(genBy), newrecruitHostPrefix)
}

func totalComputedOf(roster map[string]any) float64 {
	total := 0.0
	visit := func(s any) {
		if pts := pointsOf(s); pts != nil {
			f, _ := pts.(float64)
			total += f
		}
	}
	for _, force := range asArrayOf(roster["forces"]) {
		for _, sel := range childSelections(force) {
			bsWalk(sel, visit)
		}
	}
	return total
}

func asStringOrNil(v any) any {
	if s, ok := v.(string); ok {
		return s
	}
	return nil
}
