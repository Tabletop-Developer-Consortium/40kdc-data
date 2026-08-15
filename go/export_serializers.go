package wh40kdc

import (
	"sort"
	"strings"
)

// --- newrecruit-json ---

const ptsTypeID = "pts-type"
const nrXMLNS = "http://www.battlescribe.net/schema/rosterSchema"
const nrGeneratedBy = "https://newrecruit.eu"

func nrFactionCategory(roster map[string]any) *omap {
	display := titleCaseID(roster["faction_id"])
	if display == nil {
		return nil
	}
	return newOmap().set("name", "Faction: "+display.(string)).set("primary", false)
}

func nrWargearSelection(idx int, w map[string]any) *omap {
	return newOmap().
		set("id", "w-"+itoa(idx)).
		set("name", refRawName(w)).
		set("type", "upgrade").
		set("number", w["count"]).
		set("categories", []any{newOmap().set("name", "Ranged Weapon").set("primary", false)})
}

func nrUnitSelection(idx int, u map[string]any, faction *omap) *omap {
	inner := []any{}
	if u["is_warlord"] == true {
		inner = append(inner, newOmap().set("id", "u"+itoa(idx)+"-warlord").set("name", "Warlord").set("type", "upgrade").set("number", float64(1)))
	}
	if attachment, ok := u["leader_attachment"].(map[string]any); ok {
		provisional := "confirmed"
		if attachment["provisional"] == true {
			provisional = "provisional"
		}
		bodyguard, _ := attachment["bodyguard_ref"].(map[string]any)
		inner = append(inner, newOmap().
			set("id", "u"+itoa(idx)+"-attachment").
			set("name", getStr(bodyguard, "raw_name")).
			set("type", "upgrade").
			set("number", float64(1)).
			set("group", "40kdc Attachment:"+getStr(attachment, "role")+":"+provisional))
	}
	if enh, ok := u["enhancement"].(map[string]any); ok {
		eo := newOmap().set("id", "u"+itoa(idx)+"-enh").set("name", enh["raw_name"]).set("type", "upgrade").set("number", float64(1)).set("group", "Enhancements")
		if u["enhancement_points"] != nil {
			eo.set("costs", []any{newOmap().set("name", "pts").set("typeId", ptsTypeID).set("value", u["enhancement_points"])})
		}
		inner = append(inner, eo)
	}
	wargearSels := []any{}
	for wi, wAny := range unitWargear(u) {
		wargearSels = append(wargearSels, nrWargearSelection(wi, wAny.(map[string]any)))
	}
	modelSelections := []any{}
	if groups := getList(u, "loadout_groups"); len(groups) > 0 {
		for gi, gAny := range groups {
			g := gAny.(map[string]any)
			selections := []any{}
			for wi, wAny := range getList(g, "wargear") {
				w := wAny.(map[string]any)
				copy := make(map[string]any, len(w)+1)
				for k, v := range w {
					copy[k] = v
				}
				copy["count"] = asInt(w["count"]) * asInt(g["count"])
				selections = append(selections, nrWargearSelection(wi, copy))
			}
			name := getStr(g, "model_name")
			if name == "" {
				name = getStr(refOf(u), "raw_name")
			}
			modelSelections = append(modelSelections, newOmap().set("id", "u"+itoa(idx)+"-model-"+itoa(gi)).set("name", name).set("type", "model").set("number", g["count"]).set("selections", selections))
		}
	} else {
		modelSelections = append(modelSelections, newOmap().set("id", "u"+itoa(idx)+"-model").set("name", refRawName(u)).set("type", "model").set("number", u["model_count"]).set("selections", wargearSels))
	}
	ownCategories := []any{}
	if faction != nil {
		ownCategories = append(ownCategories, faction)
	}
	for ki, keyword := range getList(u, "keyword_overrides") {
		ownCategories = append(ownCategories, newOmap().set("id", "40kdc-keyword-"+itoa(ki)).set("name", keyword).set("primary", false))
	}
	if asInt(u["model_count"]) <= 1 && len(getList(u, "loadout_groups")) == 0 {
		sel := newOmap().set("id", "u-"+itoa(idx)).set("name", refRawName(u)).set("type", "model").set("number", float64(1)).set("categories", ownCategories)
		if u["points"] != nil {
			sel.set("costs", []any{newOmap().set("name", "pts").set("typeId", ptsTypeID).set("value", u["points"])})
		}
		sel.set("selections", append(append([]any{}, inner...), wargearSels...))
		return sel
	}
	sel := newOmap().set("id", "u-"+itoa(idx)).set("name", refRawName(u)).set("type", "unit").set("number", float64(1)).set("categories", ownCategories)
	if u["points"] != nil {
		sel.set("costs", []any{newOmap().set("name", "pts").set("typeId", ptsTypeID).set("value", u["points"])})
	}
	sel.set("selections", append(inner, modelSelections...))
	return sel
}

func nrConfigSelection(name, value, idx string) *omap {
	return newOmap().set("id", "cfg-"+idx).set("name", name).set("type", "upgrade").set("number", float64(1)).
		set("categories", []any{newOmap().set("name", "Configuration").set("primary", true)}).
		set("selections", []any{newOmap().set("id", "cfg-"+idx+"-val").set("name", value).set("type", "upgrade").set("number", float64(1))})
}

func serializeNewrecruitJSON(roster map[string]any) string {
	faction := nrFactionCategory(roster)
	factionDisplay := titleCaseIDOr(roster["faction_id"], "Unknown")
	battleSize := battleSizeLabel(roster)

	config := []any{}
	if battleSize != nil {
		config = append(config, nrConfigSelection("Battle Size", battleSize.(string), "battle-size"))
	}
	for _, dAny := range getList(roster, "detachments") {
		d := dAny.(map[string]any)
		config = append(config, nrConfigSelection("Detachment", getStr(refOf(d), "raw_name"), "detachment"))
	}
	if disposition, ok := roster["force_disposition"].(string); ok && disposition != "" {
		config = append(config, nrConfigSelection("Force Disposition", titleCaseIDOr(disposition, ""), "force-disposition"))
	}
	selections := append([]any{}, config...)
	for i, uAny := range getList(roster, "units") {
		selections = append(selections, nrUnitSelection(i, uAny.(map[string]any), faction))
	}
	force := newOmap().set("id", "force-1").set("name", "Army Roster").set("catalogueName", factionDisplay).set("selections", selections)
	total := totalArmyPoints(roster)
	payload := newOmap().
		set("name", roster["name"]).
		set("generatedBy", nrGeneratedBy).
		set("roster", newOmap().
			set("name", roster["name"]).
			set("xmlns", nrXMLNS).
			set("generatedBy", nrGeneratedBy).
			set("costs", []any{newOmap().set("name", "pts").set("typeId", ptsTypeID).set("value", total)}).
			set("forces", []any{force}))
	return prettyJSON(payload)
}

// --- newrecruit wtc compact + full ---

const wtcFence = "+++++++++++++++++++++++++++++++++++++++++++++++"

func keywordTokens(unit map[string]any) []string {
	tokens := []string{}
	for _, keyword := range getList(unit, "keyword_overrides") {
		name, _ := keyword.(string)
		if name == "Character" {
			tokens = append(tokens, "Detachment Character")
		} else {
			tokens = append(tokens, "40kdc Keyword: "+name)
		}
	}
	return tokens
}
func attachmentToken(u map[string]any) string {
	attachment, ok := u["leader_attachment"].(map[string]any)
	if !ok {
		return ""
	}
	provisional := ""
	if attachment["provisional"] == true {
		provisional = " [provisional]"
	}
	bodyguard, _ := attachment["bodyguard_ref"].(map[string]any)
	return "Attachment: " + getStr(attachment, "role") + " -> " + getStr(bodyguard, "raw_name") + provisional
}

func wtcWargearListText(unit map[string]any, includeWarlordTag bool) string {
	var parts []string
	for _, wAny := range unitWargear(unit) {
		w := wAny.(map[string]any)
		raw := getStr(refOf(w), "raw_name")
		if asInt(w["count"]) > 1 {
			parts = append(parts, numStr(w["count"])+"x "+raw)
		} else {
			parts = append(parts, raw)
		}
	}
	if includeWarlordTag && unit["is_warlord"] == true {
		parts = append(parts, "Warlord")
	}
	return strings.Join(append(parts, keywordTokens(unit)...), ", ")
}

func wtcHeaderText(roster map[string]any, units []any, slots []int) string {
	faction := titleCaseIDOr(roster["faction_id"], "Unknown")
	detachments := getList(roster, "detachments")
	detachmentLines := []string{"+ DETACHMENT: —"}
	if len(detachments) > 0 {
		detachmentLines = nil
		for _, dAny := range detachments {
			detachmentLines = append(detachmentLines, "+ DETACHMENT: "+getStr(refOf(dAny.(map[string]any)), "raw_name"))
		}
	}
	pts, _ := roster["points"].(map[string]any)
	limit := pts["declared_limit"]
	if limit == nil {
		limit = totalArmyPoints(roster)
	}
	total := pts["total_reported"]
	if total == nil {
		total = totalArmyPoints(roster)
	}
	warlord := "—"
	for i, uAny := range units {
		u := uAny.(map[string]any)
		if u["is_warlord"] == true {
			warlord = "Char" + itoa(slots[i]) + ": " + getStr(refOf(u), "raw_name")
			break
		}
	}
	enhancement := "—"
	for i, uAny := range units {
		u := uAny.(map[string]any)
		if enh, ok := u["enhancement"].(map[string]any); ok {
			enhancement = getStr(enh, "raw_name") + " (on Char" + itoa(slots[i]) + ": " + getStr(refOf(u), "raw_name") + ")"
			break
		}
	}
	lines := []string{
		wtcFence,
		"+ LIST NAME: " + getStr(roster, "name"),
		"+ FACTION KEYWORD: " + faction,
	}
	lines = append(lines, detachmentLines...)
	if disp, ok := roster["force_disposition"].(string); ok && disp != "" {
		lines = append(lines, "+ FORCE DISPOSITION: "+titleCaseIDOr(disp, ""))
	}
	lines = append(lines,
		"+ TOTAL ARMY POINTS: "+numStr(total)+"pts",
		"+ POINTS LIMIT: "+numStr(limit)+"pts",
		"+",
		"+ WARLORD: "+warlord,
		"+ ENHANCEMENT: "+enhancement,
		"+ NUMBER OF UNITS: "+itoa(len(units)),
		wtcFence,
	)
	return strings.Join(lines, "\n")
}

func wtcEnhancementLine(u map[string]any) string {
	enh, _ := u["enhancement"].(map[string]any)
	if u["enhancement_points"] == nil {
		return "Enhancement: " + getStr(enh, "raw_name")
	}
	return "Enhancement: " + getStr(enh, "raw_name") + " (+" + numStr(u["enhancement_points"]) + " pts)"
}

func exactGroupLines(u map[string]any) []string {
	groups := getList(u, "loadout_groups")
	if len(groups) == 0 {
		return nil
	}
	for _, gAny := range groups {
		if _, ok := gAny.(map[string]any)["model_name"].(string); !ok {
			return nil
		}
	}
	lines := make([]string, 0, len(groups))
	for i, gAny := range groups {
		g := gAny.(map[string]any)
		contents := groupWeaponsText(getList(g, "wargear"))
		tags := []string{}
		if u["is_warlord"] == true && i == 0 {
			tags = append(tags, "Warlord")
		}
		if i == 0 {
			tags = append(tags, keywordTokens(u)...)
		}
		if len(tags) > 0 {
			if contents != "" {
				contents += ", "
			}
			contents += strings.Join(tags, ", ")
		}
		lines = append(lines, "• "+itoa(asInt(g["count"]))+"x "+getStr(g, "model_name")+": "+contents)
	}
	return lines
}

// wtcCompactBodyLines is the compact body — one line per unit, wargear inline —
// that follows the summary header. Returned as the lines after the header (the
// leading "" separator included) so any header variant (WTC or ATC 2026) can
// prepend its own block. Compact callers append a trailing newline.
func wtcCompactBodyLines(units []any, slots []int) []string {
	lines := []string{""}
	for i, uAny := range units {
		u := uAny.(map[string]any)
		prefix := ""
		if slots[i] != -1 {
			prefix = "Char" + itoa(slots[i]) + ": "
		}
		ptsText := ""
		if pts := displayedUnitPoints(u); pts != nil {
			ptsText = numStr(pts) + " pts"
		}
		exact := exactGroupLines(u)
		wargear := wtcWargearListText(u, true)
		if exact != nil {
			wargear = ""
		}
		lines = append(lines, prefix+numStr(u["model_count"])+"x "+getStr(refOf(u), "raw_name")+" ("+ptsText+"): "+wargear)
		if exact != nil {
			lines = append(lines, exact...)
		}
		if attachment := attachmentToken(u); attachment != "" {
			lines = append(lines, attachment)
		}
		if _, ok := u["enhancement"].(map[string]any); ok {
			lines = append(lines, wtcEnhancementLine(u))
		}
	}
	return lines
}

func serializeWtcCompact(roster map[string]any) string {
	units := getList(roster, "units")
	slots := charSlotAssignment(units)
	lines := append([]string{wtcHeaderText(roster, units, slots)}, wtcCompactBodyLines(units, slots)...)
	return strings.Join(lines, "\n") + "\n"
}

func multiModelWithLine(u map[string]any) string {
	modelCount := asInt(u["model_count"])
	divisible := true
	for _, wAny := range unitWargear(u) {
		if asInt(wAny.(map[string]any)["count"])%modelCount != 0 {
			divisible = false
			break
		}
	}
	if divisible {
		var perModel []string
		for _, wAny := range unitWargear(u) {
			w := wAny.(map[string]any)
			c := asInt(w["count"]) / modelCount
			raw := getStr(refOf(w), "raw_name")
			if c > 1 {
				perModel = append(perModel, itoa(c)+"x "+raw)
			} else {
				perModel = append(perModel, raw)
			}
		}
		if u["is_warlord"] == true {
			perModel = append(perModel, "Warlord")
		}
		perModel = append(perModel, keywordTokens(u)...)
		return itoa(modelCount) + " with " + strings.Join(perModel, ", ")
	}
	return "1 with " + wtcWargearListText(u, true)
}

// groupWeaponsText renders a loadout group's per-model weapons in source order,
// with Nx for counts >1. Mirror of the TS groupWeaponsText.
func groupWeaponsText(wargear []any) string {
	parts := make([]string, 0, len(wargear))
	for _, wAny := range wargear {
		w := wAny.(map[string]any)
		count := asInt(w["count"])
		name := getStr(refOf(w), "raw_name")
		if count > 1 {
			parts = append(parts, itoa(count)+"x "+name)
		} else {
			parts = append(parts, name)
		}
	}
	return strings.Join(parts, ", ")
}

// coarsenedLoadoutGroups merges a unit's fine loadout groups that share an
// identical per-model weapon set (dropping the model-type name), preserving
// first-seen order; nil when the unit has no loadout groups. Mirror of the TS
// coarsenedLoadoutGroups.
func coarsenedLoadoutGroups(u map[string]any) []map[string]any {
	groups := getList(u, "loadout_groups")
	if len(groups) == 0 {
		return nil
	}
	index := map[string]int{}
	var out []map[string]any
	for _, gAny := range groups {
		g := gAny.(map[string]any)
		var keys []string
		for _, wAny := range getList(g, "wargear") {
			w := wAny.(map[string]any)
			ref := refOf(w)
			id, _ := ref["id"].(string)
			if id == "" {
				id = getStr(ref, "raw_name")
			}
			keys = append(keys, id+"#"+numStr(w["count"]))
		}
		sort.Strings(keys)
		key := strings.Join(keys, "|")
		if idx, ok := index[key]; ok {
			out[idx]["count"] = asInt(out[idx]["count"]) + asInt(g["count"])
		} else {
			index[key] = len(out)
			out = append(out, map[string]any{"count": asInt(g["count"]), "wargear": getList(g, "wargear")})
		}
	}
	return out
}

// wtcModelLines is the per-model "N with <loadout>" line(s) for a unit. A
// genuinely heterogeneous unit (loadout groups coarsen to more than one distinct
// per-model loadout) emits one line per loadout; everything else keeps the
// existing single-line form. Mirror of the TS wtcModelLines.
func wtcModelLines(u map[string]any) []string {
	if exact := exactGroupLines(u); exact != nil {
		return exact
	}
	if asInt(u["model_count"]) > 1 {
		coarse := coarsenedLoadoutGroups(u)
		if len(coarse) > 1 {
			lines := make([]string, 0, len(coarse))
			for i, c := range coarse {
				tags := []string{}
				if u["is_warlord"] == true && i == 0 {
					tags = append(tags, "Warlord")
				}
				if i == 0 {
					tags = append(tags, keywordTokens(u)...)
				}
				line := itoa(asInt(c["count"])) + " with " + groupWeaponsText(c["wargear"].([]any))
				if len(tags) > 0 {
					line += ", " + strings.Join(tags, ", ")
				}
				lines = append(lines, line)
			}
			return lines
		}
		return []string{multiModelWithLine(u)}
	}
	return []string{"1 with " + wtcWargearListText(u, true)}
}

// fullBodyLines is the shared full-body scaffold: the BATTLELINE section, CharN:
// prefixes, the unit header line, the per-model lines (supplied by modelLines so
// WTC and ATC 2026 render them differently), and the enhancement line. Mirror of
// the TS fullBodyLines.
func fullBodyLines(units []any, slots []int, modelLines func(map[string]any) []string) []string {
	lines := []string{"", "BATTLELINE", ""}
	for i, uAny := range units {
		u := uAny.(map[string]any)
		prefix := ""
		if slots[i] != -1 {
			prefix = "Char" + itoa(slots[i]) + ": "
		}
		ptsText := ""
		if pts := displayedUnitPoints(u); pts != nil {
			ptsText = numStr(pts) + " pts"
		}
		lines = append(lines, prefix+numStr(u["model_count"])+"x "+getStr(refOf(u), "raw_name")+" ("+ptsText+")")
		lines = append(lines, modelLines(u)...)
		if attachment := attachmentToken(u); attachment != "" {
			lines = append(lines, attachment)
		}
		if _, ok := u["enhancement"].(map[string]any); ok {
			lines = append(lines, wtcEnhancementLine(u))
		}
		lines = append(lines, "")
	}
	return lines
}

func serializeWtcFull(roster map[string]any) string {
	units := getList(roster, "units")
	slots := charSlotAssignment(units)
	lines := append([]string{wtcHeaderText(roster, units, slots)}, fullBodyLines(units, slots, wtcModelLines)...)
	return strings.Join(lines, "\n")
}

const atcDash = "—"

// atcHeaderText builds the American Team Championship 2026 list-submission
// header: player/team placeholders, the picked Force Disposition, every
// enhancement-bearing model, and the leader/support attachments spelled out.
// Go mirror of tools/src/export/atc-2026.ts.
func atcHeaderText(roster map[string]any, units []any, slots []int) string {
	faction := titleCaseIDOr(roster["faction_id"], "Unknown")
	disposition := titleCaseIDOr(roster["force_disposition"], atcDash)
	detachments := getList(roster, "detachments")
	detachment := atcDash
	if len(detachments) > 0 {
		var ds []string
		for _, dAny := range detachments {
			d := dAny.(map[string]any)
			disp := titleCaseIDOr(refOf(d)["id"], "")
			if disp == "" {
				disp = getStr(refOf(d), "raw_name")
			}
			ds = append(ds, disp)
		}
		detachment = strings.Join(ds, ", ")
	}
	pts, _ := roster["points"].(map[string]any)
	total := pts["total_reported"]
	if total == nil {
		total = totalArmyPoints(roster)
	}

	warlord := atcDash
	for i, uAny := range units {
		u := uAny.(map[string]any)
		if u["is_warlord"] == true {
			warlord = "Char" + itoa(slots[i]) + ": " + getStr(refOf(u), "raw_name")
			break
		}
	}

	var enhParts []string
	for i, uAny := range units {
		u := uAny.(map[string]any)
		if enh, ok := u["enhancement"].(map[string]any); ok {
			enhParts = append(enhParts, getStr(enh, "raw_name")+" (on Char"+itoa(slots[i])+": "+getStr(refOf(u), "raw_name")+")")
		}
	}
	enhancement := atcDash
	if len(enhParts) > 0 {
		enhancement = strings.Join(enhParts, "; ")
	}

	// LEADER/SUPPORT: group attaching characters by the bodyguard unit they join,
	// preserving first-seen order. A leader "leads" the bodyguard; a support
	// character (which cannot operate alone) renders as "supported by".
	type atcAttachGroup struct {
		bodyguard string
		leaders   []string
		supports  []string
	}
	var groups []*atcAttachGroup
	byKey := map[string]*atcAttachGroup{}
	for _, uAny := range units {
		u := uAny.(map[string]any)
		la, ok := u["leader_attachment"].(map[string]any)
		if !ok {
			continue
		}
		bg, _ := la["bodyguard_ref"].(map[string]any)
		key := getStr(bg, "id")
		if key == "" {
			key = getStr(bg, "raw_name")
		}
		g := byKey[key]
		if g == nil {
			g = &atcAttachGroup{bodyguard: getStr(bg, "raw_name")}
			byKey[key] = g
			groups = append(groups, g)
		}
		name := getStr(refOf(u), "raw_name")
		if getStr(la, "role") == "support" {
			g.supports = append(g.supports, name)
		} else {
			g.leaders = append(g.leaders, name)
		}
	}
	var attachParts []string
	for _, g := range groups {
		var s string
		if len(g.leaders) > 0 {
			s = strings.Join(g.leaders, " & ") + " leading " + g.bodyguard
		} else {
			s = g.bodyguard
		}
		if len(g.supports) > 0 {
			sep := ""
			if len(g.leaders) > 0 {
				sep = ","
			}
			s += sep + " supported by " + strings.Join(g.supports, " & ")
		}
		attachParts = append(attachParts, s)
	}
	leaderSupport := atcDash
	if len(attachParts) > 0 {
		leaderSupport = strings.Join(attachParts, "; ")
	}

	lines := []string{
		wtcFence,
		"+ PLAYER NAME: " + atcDash,
		"+ TEAM NAME: " + atcDash,
		"+ FACTIONS USED: " + faction,
		"+ DISPOSITION: " + disposition,
		"+ DETACHMENT: " + detachment,
		"+ ARMY POINTS: " + numStr(total) + "pts",
		"+",
		"+ WARLORD: " + warlord,
		"+ ENHANCEMENT: " + enhancement,
		"+ LEADER/SUPPORT: " + leaderSupport,
		"+ NUMBER OF UNITS: " + itoa(len(units)),
		wtcFence,
	}
	return strings.Join(lines, "\n")
}

func serializeAtc2026Compact(roster map[string]any) string {
	units := getList(roster, "units")
	slots := charSlotAssignment(units)
	lines := append([]string{atcHeaderText(roster, units, slots)}, wtcCompactBodyLines(units, slots)...)
	return strings.Join(lines, "\n") + "\n"
}

// atcModelLines renders one bulleted "• Nx <model-type>: <loadout>" line per
// loadout group (the ATC submission style); units whose loadout doesn't decompose
// fall back to the shared WTC rendering. Mirror of the TS atcModelLines.
func atcModelLines(u map[string]any) []string {
	if groups := getList(u, "loadout_groups"); len(groups) > 0 {
		lines := make([]string, 0, len(groups))
		for i, gAny := range groups {
			g := gAny.(map[string]any)
			name := getStr(refOf(u), "raw_name")
			if mn, ok := g["model_name"].(string); ok && mn != "" {
				name = mn
			}
			tag := ""
			if u["is_warlord"] == true && i == 0 {
				tag = ", Warlord"
			}
			lines = append(lines, "• "+itoa(asInt(g["count"]))+"x "+name+": "+groupWeaponsText(getList(g, "wargear"))+tag)
		}
		return lines
	}
	return wtcModelLines(u)
}

func serializeAtc2026Full(roster map[string]any) string {
	units := getList(roster, "units")
	slots := charSlotAssignment(units)
	lines := append([]string{atcHeaderText(roster, units, slots)}, fullBodyLines(units, slots, atcModelLines)...)
	return strings.Join(lines, "\n")
}

// --- newrecruit-simple ---

func simpleLeadTokens(u map[string]any) []string {
	var parts []string
	if attachment := attachmentToken(u); attachment != "" {
		parts = append(parts, attachment)
	}
	if enh, ok := u["enhancement"].(map[string]any); ok {
		if u["enhancement_points"] == nil {
			parts = append(parts, "Enhancement: "+getStr(enh, "raw_name"))
		} else {
			parts = append(parts, getStr(enh, "raw_name")+" ["+numStr(u["enhancement_points"])+" pts]")
		}
	}
	if u["is_warlord"] == true {
		parts = append(parts, "Warlord")
	}
	return append(parts, keywordTokens(u)...)
}

func simpleWargearText(u map[string]any, perModelDivisor int) string {
	parts := simpleLeadTokens(u)
	for _, wAny := range unitWargear(u) {
		w := wAny.(map[string]any)
		c := asInt(w["count"])
		if perModelDivisor > 0 {
			c /= perModelDivisor
		}
		raw := getStr(refOf(w), "raw_name")
		if c > 1 {
			parts = append(parts, itoa(c)+"x "+raw)
		} else {
			parts = append(parts, raw)
		}
	}
	return strings.Join(parts, ", ")
}
func simpleUnitText(u map[string]any) []string {
	ptsText := ""
	if pts := displayedUnitPoints(u); pts != nil {
		ptsText = numStr(pts) + " pts"
	}
	name := getStr(refOf(u), "raw_name")
	if asInt(u["model_count"]) <= 1 && len(getList(u, "loadout_groups")) == 0 {
		return []string{name + " [" + ptsText + "]: " + simpleWargearText(u, 1)}
	}
	if groups := getList(u, "loadout_groups"); len(groups) > 0 {
		lead := simpleLeadTokens(u)
		lines := []string{name + " [" + ptsText + "]:"}
		for i, gAny := range groups {
			g := gAny.(map[string]any)
			gName := getStr(g, "model_name")
			if gName == "" {
				gName = name
			}
			tokens := []string{}
			if i == 0 {
				tokens = append(tokens, lead...)
			}
			if weapons := groupWeaponsText(getList(g, "wargear")); weapons != "" {
				tokens = append(tokens, weapons)
			}
			lines = append(lines, "• "+itoa(asInt(g["count"]))+"x "+gName+": "+strings.Join(tokens, ", "))
		}
		return lines
	}
	mc := asInt(u["model_count"])
	divisible := true
	for _, wAny := range unitWargear(u) {
		if asInt(wAny.(map[string]any)["count"])%mc != 0 {
			divisible = false
			break
		}
	}
	loadout := simpleWargearText(u, 1)
	if divisible {
		loadout = simpleWargearText(u, mc)
	} else {
		loadout = "Unit total: " + loadout
	}
	return []string{name + " [" + ptsText + "]:", "• " + itoa(mc) + "x " + name + ": " + loadout}
}

func serializeNewrecruitSimple(roster map[string]any) string {
	faction := titleCaseIDOr(roster["faction_id"], "Unknown")
	battle := battleSizeLabel(roster)
	total := totalArmyPoints(roster)
	pts, _ := roster["points"].(map[string]any)
	limit := pts["declared_limit"]
	if limit == nil {
		limit = total
	}
	lines := []string{
		faction + " - " + getStr(roster, "name") + " - [" + numStr(limit) + " pts]",
		"",
		"# ++ Army Roster ++ [" + numStr(total) + " pts]",
		"## Configuration",
		"List Name: " + getStr(roster, "name"),
		"Faction: " + faction,
	}
	if battle != nil {
		lines = append(lines, "Battle Size: "+battle.(string))
	}
	for _, dAny := range getList(roster, "detachments") {
		lines = append(lines, "Detachment: "+getStr(refOf(dAny.(map[string]any)), "raw_name"))
	}
	if disposition, ok := roster["force_disposition"].(string); ok && disposition != "" {
		lines = append(lines, "Force Disposition: "+titleCaseIDOr(disposition, ""))
	}
	lines = append(lines, "")
	sectionTotal := 0.0
	for _, uAny := range getList(roster, "units") {
		u := uAny.(map[string]any)
		sectionTotal += ptsOr0(u) + enhPtsOr0(u)
	}
	lines = append(lines, "## Battleline ["+numStr(sectionTotal)+" pts]")
	for _, uAny := range getList(roster, "units") {
		lines = append(lines, simpleUnitText(uAny.(map[string]any))...)
	}
	return strings.Join(lines, "\n") + "\n"
}

// --- rosterizer ---

func rzKey(cls, dsg string) string { return cls + "§" + dsg }

const (
	rzForceDisposition = "Force Disposition"
	rzAttachment       = "Attachment"
	rzCharacter        = "Character"
	rzKeywordOverride  = "40kdc Keyword"
	rzModel            = "Model"
)

func serializeRosterizer(roster map[string]any) string {
	included := []any{}
	if f := titleCaseID(roster["faction_id"]); f != nil {
		included = append(included, newOmap().set("item", rzKey(clsFaction, f.(string))).set("name", f).set("quantity", float64(1)))
	}
	for _, dAny := range getList(roster, "detachments") {
		raw := getStr(refOf(dAny.(map[string]any)), "raw_name")
		included = append(included, newOmap().set("item", rzKey(clsDetachment, raw)).set("name", raw).set("quantity", float64(1)))
	}
	if disposition, ok := roster["force_disposition"].(string); ok && disposition != "" {
		display := titleCaseIDOr(disposition, "")
		included = append(included, newOmap().set("item", rzKey(rzForceDisposition, display)).set("name", display).set("quantity", float64(1)))
	}
	if bs := rzBattleSizeAsset(roster); bs != nil {
		included = append(included, bs)
	}
	for _, uAny := range getList(roster, "units") {
		included = append(included, rzUnitAsset(uAny.(map[string]any)))
	}
	total := totalArmyPoints(roster)
	snapshot := newOmap().set("item", rzKey("Roster", "Roster")).set("name", roster["name"]).set("quantity", float64(1))
	if total > 0 {
		snapshot.set("stats", newOmap().set("Points", newOmap().set("value", total)))
	}
	snapshot.set("assets", newOmap().set("included", included))
	rulebook := newOmap().set("name", "40kdc").set("game", "Warhammer 40,000").set("publisher", "Alpaca Software").set("url", "https://40kdc.dev").set("genre", "wargame")
	envelope := newOmap().set("slug", "").set("key", "").set("visible", "hidden").set("locked", false).set("rulebook", rulebook).set("snapshot", snapshot)
	return prettyJSON(envelope)
}
func rzUnitAsset(u map[string]any) *omap {
	included := []any{}
	if attachment := attachmentToken(u); attachment != "" {
		included = append(included, newOmap().set("item", rzKey(rzAttachment, attachment)).set("name", attachment).set("quantity", float64(1)))
	}
	if enh, ok := u["enhancement"].(map[string]any); ok {
		ea := newOmap().set("item", rzKey(clsEnhancement, getStr(enh, "raw_name"))).set("name", enh["raw_name"]).set("quantity", float64(1))
		if u["enhancement_points"] != nil {
			ea.set("stats", newOmap().set("Points", newOmap().set("value", u["enhancement_points"])))
		}
		included = append(included, ea)
	}
	if groups := getList(u, "loadout_groups"); len(groups) > 0 {
		for _, gAny := range groups {
			g := gAny.(map[string]any)
			name := getStr(g, "model_name")
			if name == "" {
				name = getStr(refOf(u), "raw_name")
			}
			weapons := []any{}
			for _, wAny := range getList(g, "wargear") {
				w := wAny.(map[string]any)
				weapons = append(weapons, newOmap().set("item", rzKey(clsWeapon, getStr(refOf(w), "raw_name"))).set("name", refRawName(w)).set("quantity", asInt(w["count"])*asInt(g["count"])))
			}
			included = append(included, newOmap().set("item", rzKey(rzModel, name)).set("name", name).set("quantity", g["count"]).set("assets", newOmap().set("included", weapons)))
		}
	} else {
		for _, wAny := range unitWargear(u) {
			w := wAny.(map[string]any)
			included = append(included, newOmap().set("item", rzKey(clsWeapon, getStr(refOf(w), "raw_name"))).set("name", refRawName(w)).set("quantity", w["count"]))
		}
	}
	traits := []any{}
	if u["is_warlord"] == true {
		traits = append(traits, newOmap().set("item", rzKey(clsTrait, dsgWarlord)).set("name", dsgWarlord).set("quantity", float64(1)))
	}
	for _, keyword := range getList(u, "keyword_overrides") {
		name, _ := keyword.(string)
		cls, display := rzKeywordOverride, name
		if name == "Character" {
			cls, display = rzCharacter, "Detachment Character"
		}
		traits = append(traits, newOmap().set("item", rzKey(cls, display)).set("name", display).set("quantity", float64(1)))
	}
	asset := newOmap().set("item", rzKey(clsUnit, getStr(refOf(u), "raw_name"))).set("name", refRawName(u)).set("quantity", u["model_count"])
	if u["points"] != nil {
		asset.set("stats", newOmap().set("Points", newOmap().set("value", u["points"])))
	}
	if len(included) > 0 || len(traits) > 0 {
		assets := newOmap()
		if len(included) > 0 {
			assets.set("included", included)
		}
		if len(traits) > 0 {
			assets.set("traits", traits)
		}
		asset.set("assets", assets)
	}
	return asset
}

func rzBattleSizeAsset(roster map[string]any) *omap {
	label := battleSizeLabel(roster)
	if label == nil {
		return nil
	}
	l := label.(string)
	return newOmap().set("item", rzKey(clsBattleSize, l)).set("name", l).set("quantity", float64(1))
}

// --- roster-json (canonical, rebuilt in resolve()'s key order) ---

func serializeRosterJSON(roster map[string]any) string {
	return prettyJSON(rosterToOmap(roster))
}

func refToOmap(ref map[string]any) *omap {
	cands := []any{}
	for _, cAny := range getList(ref, "candidates") {
		c := cAny.(map[string]any)
		co := newOmap().set("id", c["id"])
		if _, has := c["name"]; has {
			co.set("name", c["name"])
		}
		cands = append(cands, co)
	}
	return newOmap().set("id", ref["id"]).set("raw_name", ref["raw_name"]).set("resolved", ref["resolved"]).set("candidates", cands)
}

func unitToOmap(u map[string]any) *omap {
	wargear := []any{}
	for _, wAny := range unitWargear(u) {
		w := wAny.(map[string]any)
		wargear = append(wargear, newOmap().set("ref", refToOmap(refOf(w))).set("count", w["count"]))
	}
	o := newOmap().
		set("ref", refToOmap(refOf(u))).
		set("model_count", u["model_count"]).
		set("points", u["points"]).
		set("is_warlord", u["is_warlord"])
	if keywords, exists := u["keyword_overrides"]; exists {
		o.set("keyword_overrides", keywords)
	}
	if enh, ok := u["enhancement"].(map[string]any); ok {
		o.set("enhancement", refToOmap(enh))
	} else {
		o.set("enhancement", nil)
	}
	o.set("enhancement_points", u["enhancement_points"]).set("wargear", wargear)
	if lgList := getList(u, "loadout_groups"); len(lgList) > 0 {
		groups := []any{}
		for _, gAny := range lgList {
			g := gAny.(map[string]any)
			gw := []any{}
			for _, wAny := range getList(g, "wargear") {
				w := wAny.(map[string]any)
				gw = append(gw, newOmap().set("ref", refToOmap(refOf(w))).set("count", w["count"]))
			}
			groups = append(groups, newOmap().set("model_name", g["model_name"]).set("count", g["count"]).set("wargear", gw))
		}
		o.set("loadout_groups", groups)
	}
	if la, ok := u["leader_attachment"].(map[string]any); ok {
		o.set("leader_attachment", newOmap().
			set("bodyguard_ref", refToOmap(la["bodyguard_ref"].(map[string]any))).
			set("role", la["role"]).
			set("provisional", la["provisional"]))
	} else {
		o.set("leader_attachment", nil)
	}
	return o
}

func rosterToOmap(r map[string]any) *omap {
	src, _ := r["source"].(map[string]any)
	detachments := []any{}
	for _, dAny := range getList(r, "detachments") {
		d := dAny.(map[string]any)
		detachments = append(detachments, newOmap().set("ref", refToOmap(refOf(d))).set("dp_cost", d["dp_cost"]))
	}
	units := []any{}
	for _, uAny := range getList(r, "units") {
		units = append(units, unitToOmap(uAny.(map[string]any)))
	}
	pts, _ := r["points"].(map[string]any)
	gv, _ := r["game_version"].(map[string]any)
	diag, _ := r["diagnostics"].(map[string]any)
	warnings := []any{}
	for _, wAny := range getList(diag, "warnings") {
		w := wAny.(map[string]any)
		warnings = append(warnings, newOmap().set("code", w["code"]).set("message", w["message"]).set("raw_name", w["raw_name"]))
	}
	return newOmap().
		set("name", r["name"]).
		set("source", newOmap().set("format", src["format"]).set("generated_by", src["generated_by"])).
		set("faction_id", r["faction_id"]).
		set("detachments", detachments).
		set("battle_size", r["battle_size"]).
		set("force_disposition", r["force_disposition"]).
		set("points", newOmap().
			set("declared_limit", pts["declared_limit"]).
			set("detachment_cap", pts["detachment_cap"]).
			set("total_reported", pts["total_reported"]).
			set("total_computed", pts["total_computed"])).
		set("units", units).
		set("game_version", newOmap().set("edition", gv["edition"]).set("dataslate", gv["dataslate"])).
		set("diagnostics", newOmap().
			set("resolved_units", diag["resolved_units"]).
			set("unresolved_units", diag["unresolved_units"]).
			set("resolved_weapons", diag["resolved_weapons"]).
			set("unresolved_weapons", diag["unresolved_weapons"]).
			set("warnings", warnings))
}
