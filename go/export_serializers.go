package wh40kdc

import "strings"

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
	ownCategories := []any{}
	if faction != nil {
		ownCategories = []any{faction}
	}
	if asInt(u["model_count"]) <= 1 {
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
	model := newOmap().set("id", "u"+itoa(idx)+"-model").set("name", refRawName(u)).set("type", "model").set("number", u["model_count"]).set("selections", wargearSels)
	sel.set("selections", append(append([]any{}, inner...), model))
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
		display := titleCaseIDOr(refOf(d)["id"], "")
		if display == "" {
			display = getStr(refOf(d), "raw_name")
		}
		config = append(config, nrConfigSelection("Detachment", display, "detachment"))
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
	return strings.Join(parts, ", ")
}

func wtcHeaderText(roster map[string]any, units []any, slots []int) string {
	faction := titleCaseIDOr(roster["faction_id"], "Unknown")
	detachments := getList(roster, "detachments")
	detachment := "—"
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
		"+ DETACHMENT: " + detachment,
		"+ TOTAL ARMY POINTS: " + numStr(total) + "pts",
		"+ POINTS LIMIT: " + numStr(limit) + "pts",
		"+",
		"+ WARLORD: " + warlord,
		"+ ENHANCEMENT: " + enhancement,
		"+ NUMBER OF UNITS: " + itoa(len(units)),
		wtcFence,
	}
	return strings.Join(lines, "\n")
}

func wtcEnhancementLine(u map[string]any) string {
	enh, _ := u["enhancement"].(map[string]any)
	if u["enhancement_points"] == nil {
		return "Enhancement: " + getStr(enh, "raw_name")
	}
	return "Enhancement: " + getStr(enh, "raw_name") + " (+" + numStr(u["enhancement_points"]) + " pts)"
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
		lines = append(lines, prefix+numStr(u["model_count"])+"x "+getStr(refOf(u), "raw_name")+" ("+ptsText+"): "+wtcWargearListText(u, true))
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
		return itoa(modelCount) + " with " + strings.Join(perModel, ", ")
	}
	return "1 with " + wtcWargearListText(u, true)
}

// wtcFullBodyLines is the full body — section headers plus two-line unit blocks —
// that follows the summary header. Returned as the lines after the header (the
// leading "" separator included). Unlike compact, full callers do not append a
// trailing newline.
func wtcFullBodyLines(units []any, slots []int) []string {
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
		if asInt(u["model_count"]) > 1 {
			lines = append(lines, multiModelWithLine(u))
		} else {
			lines = append(lines, "1 with "+wtcWargearListText(u, true))
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
	lines := append([]string{wtcHeaderText(roster, units, slots)}, wtcFullBodyLines(units, slots)...)
	return strings.Join(lines, "\n")
}

// --- ATC 2026 (export-only: ATC header + reused WTC body) ---

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

	var attachParts []string
	for _, uAny := range units {
		u := uAny.(map[string]any)
		if la, ok := u["leader_attachment"].(map[string]any); ok {
			bg, _ := la["bodyguard_ref"].(map[string]any)
			attachParts = append(attachParts, getStr(refOf(u), "raw_name")+" attached to "+getStr(bg, "raw_name"))
		}
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

func serializeAtc2026Full(roster map[string]any) string {
	units := getList(roster, "units")
	slots := charSlotAssignment(units)
	lines := append([]string{atcHeaderText(roster, units, slots)}, wtcFullBodyLines(units, slots)...)
	return strings.Join(lines, "\n")
}

// --- newrecruit-simple ---

func simpleWargearText(u map[string]any, perModelDivisor int) string {
	var parts []string
	if enh, ok := u["enhancement"].(map[string]any); ok {
		ptsTag := ""
		if u["enhancement_points"] != nil {
			ptsTag = " [" + numStr(u["enhancement_points"]) + " pts]"
		}
		parts = append(parts, getStr(enh, "raw_name")+ptsTag)
	}
	if u["is_warlord"] == true {
		parts = append(parts, "Warlord")
	}
	for _, wAny := range unitWargear(u) {
		w := wAny.(map[string]any)
		c := asInt(w["count"])
		if perModelDivisor > 0 {
			c = asInt(w["count"]) / perModelDivisor
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
	if asInt(u["model_count"]) <= 1 {
		return []string{getStr(refOf(u), "raw_name") + " [" + ptsText + "]: " + simpleWargearText(u, 1)}
	}
	mc := asInt(u["model_count"])
	divisible := true
	for _, wAny := range unitWargear(u) {
		if asInt(wAny.(map[string]any)["count"])%mc != 0 {
			divisible = false
			break
		}
	}
	divisor := 1
	if divisible {
		divisor = mc
	}
	return []string{
		getStr(refOf(u), "raw_name") + " [" + ptsText + "]:",
		"• " + itoa(mc) + "x " + getStr(refOf(u), "raw_name") + ": " + simpleWargearText(u, divisor),
	}
}

func serializeNewrecruitSimple(roster map[string]any) string {
	faction := titleCaseIDOr(roster["faction_id"], "Unknown")
	var detachments []string
	for _, dAny := range getList(roster, "detachments") {
		d := dAny.(map[string]any)
		disp := titleCaseIDOr(refOf(d)["id"], "")
		if disp == "" {
			disp = getStr(refOf(d), "raw_name")
		}
		detachments = append(detachments, disp)
	}
	battle := battleSizeLabel(roster)
	total := totalArmyPoints(roster)
	pts, _ := roster["points"].(map[string]any)
	var limit any = pts["declared_limit"]
	if limit == nil {
		limit = total
	}
	var lines []string
	lines = append(lines, faction+" - "+getStr(roster, "name")+" - ["+numStr(limit)+" pts]")
	lines = append(lines, "")
	lines = append(lines, "# ++ Army Roster ++ ["+numStr(total)+" pts]")
	lines = append(lines, "## Configuration")
	if battle != nil {
		lines = append(lines, "Battle Size: "+battle.(string))
	}
	for _, d := range detachments {
		lines = append(lines, "Detachment: "+d)
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

func serializeRosterizer(roster map[string]any) string {
	included := []any{}
	if f := titleCaseID(roster["faction_id"]); f != nil {
		included = append(included, newOmap().set("item", rzKey(clsFaction, f.(string))).set("name", f).set("quantity", float64(1)))
	}
	for _, dAny := range getList(roster, "detachments") {
		d := dAny.(map[string]any)
		disp := titleCaseIDOr(refOf(d)["id"], "")
		if disp == "" {
			disp = getStr(refOf(d), "raw_name")
		}
		included = append(included, newOmap().set("item", rzKey(clsDetachment, disp)).set("name", disp).set("quantity", float64(1)))
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
	if enh, ok := u["enhancement"].(map[string]any); ok {
		ea := newOmap().set("item", rzKey(clsEnhancement, getStr(enh, "raw_name"))).set("name", enh["raw_name"]).set("quantity", float64(1))
		if u["enhancement_points"] != nil {
			ea.set("stats", newOmap().set("Points", newOmap().set("value", u["enhancement_points"])))
		}
		included = append(included, ea)
	}
	for _, wAny := range unitWargear(u) {
		w := wAny.(map[string]any)
		included = append(included, newOmap().set("item", rzKey(clsWeapon, getStr(refOf(w), "raw_name"))).set("name", refRawName(w)).set("quantity", w["count"]))
	}
	traits := []any{}
	if u["is_warlord"] == true {
		traits = append(traits, newOmap().set("item", rzKey(clsTrait, dsgWarlord)).set("name", dsgWarlord).set("quantity", float64(1)))
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
