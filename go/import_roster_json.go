package wh40kdc

// Canonical roster-json adapter: re-import a 40kdc Roster export.
//
// The exporter's roster-json format is the lossless pivot — exactly
// roster.schema.json shape. This adapter closes the loop so a 40kdc-native
// export round-trips through the normal tryImportRoster pipeline: validate the
// canonical envelope, lower it to the format-agnostic parsed roster, and let
// resolve re-derive ids against the current dataset (so a stored export keeps
// resolving across dataset releases, and stale ids self-heal through name
// resolution).
//
// Lowering notes:
//   - Unit/wargear/enhancement rows lower to their ref.raw_name.
//   - faction_id has no raw name in the canonical shape, so the id slug passes
//     through (id-match before name lookup). Detachments carry a ref.raw_name.
//   - is_character lowers as (leader_attachment != nil) so the support-only
//     inference still has its gate for any unit without an explicit attachment.
//   - An explicit leader_attachment (the builder emits one, provisional=false)
//     is carried verbatim so resolve reconstructs it exactly — lossless.
//
// Go mirror of tools/src/import/roster-json.ts.

var rosterJSONBattleSizeLabels = map[string]string{
	"incursion":    "Incursion",
	"strike-force": "Strike Force",
}

func rosterJSONMatches(decoded any) bool {
	d, ok := decoded.(map[string]any)
	if !ok {
		return false
	}
	source, ok := d["source"].(map[string]any)
	if !ok {
		return false
	}
	if _, ok := source["format"].(string); !ok {
		return false
	}
	gv, ok := d["game_version"].(map[string]any)
	if !ok {
		return false
	}
	if _, ok := gv["edition"].(string); !ok {
		return false
	}
	if _, ok := d["diagnostics"].(map[string]any); !ok {
		return false
	}
	_, ok = d["units"].([]any)
	return ok
}

func rosterJSONLowerUnit(uAny any) map[string]any {
	u := uAny.(map[string]any)
	ref := u["ref"].(map[string]any)
	la, hasLA := u["leader_attachment"].(map[string]any)

	wargear := []any{}
	for _, wAny := range asArrayOf(u["wargear"]) {
		w := wAny.(map[string]any)
		wref := w["ref"].(map[string]any)
		wargear = append(wargear, map[string]any{"raw_name": wref["raw_name"], "count": w["count"]})
	}

	var enhancementRawName any
	if enh, ok := u["enhancement"].(map[string]any); ok {
		enhancementRawName = enh["raw_name"]
	}

	keywordOverrides := getList(u, "keyword_overrides")
	isCharacter := hasLA
	for _, keyword := range keywordOverrides {
		if keyword == "Character" {
			isCharacter = true
			break
		}
	}
	parsed := map[string]any{
		"raw_name":             ref["raw_name"],
		"is_character":         isCharacter,
		"keyword_overrides":    keywordOverrides,
		"model_count":          u["model_count"],
		"points":               u["points"],
		"is_warlord":           u["is_warlord"],
		"enhancement_raw_name": enhancementRawName,
		"enhancement_points":   u["enhancement_points"],
		"wargear":              wargear,
	}
	if groups := getList(u, "loadout_groups"); len(groups) > 0 {
		lowered := make([]any, 0, len(groups))
		for _, groupAny := range groups {
			group := groupAny.(map[string]any)
			groupWargear := []any{}
			for _, itemAny := range getList(group, "wargear") {
				item := itemAny.(map[string]any)
				groupWargear = append(groupWargear, map[string]any{
					"raw_name": refOf(item)["raw_name"], "count": item["count"],
				})
			}
			lowered = append(lowered, map[string]any{
				"model_name": group["model_name"], "count": group["count"], "wargear": groupWargear,
			})
		}
		parsed["loadout_groups"] = lowered
	}
	// Carry an explicit attachment verbatim (key elided when absent, matching
	// every other adapter, which never sets it).
	if hasLA {
		bref := la["bodyguard_ref"].(map[string]any)
		parsed["leader_attachment"] = map[string]any{
			"bodyguard_raw_name": bref["raw_name"],
			"role":               la["role"],
			"provisional":        la["provisional"],
		}
	}
	return parsed
}

func rosterJSONParse(decoded any) (map[string]any, error) {
	roster := decoded.(map[string]any)
	source := roster["source"].(map[string]any)
	points := roster["points"].(map[string]any)

	var battleSizeRaw any
	if bs, ok := roster["battle_size"].(string); ok {
		if label, ok := rosterJSONBattleSizeLabels[bs]; ok {
			battleSizeRaw = label
		}
	}

	detachmentRawNames := []any{}
	for _, dAny := range asArrayOf(roster["detachments"]) {
		d := dAny.(map[string]any)
		dref := d["ref"].(map[string]any)
		detachmentRawNames = append(detachmentRawNames, dref["raw_name"])
	}

	units := []any{}
	for _, uAny := range asArrayOf(roster["units"]) {
		units = append(units, rosterJSONLowerUnit(uAny))
	}

	return map[string]any{
		"name":         roster["name"],
		"generated_by": source["generated_by"],
		// Id slug passes through as the raw name — id-match before name lookup.
		"faction_raw_name":     roster["faction_id"],
		"detachment_raw_names": detachmentRawNames,
		"battle_size_raw":      battleSizeRaw,
		"force_disposition":    roster["force_disposition"],
		"declared_limit":       points["declared_limit"],
		"total_reported":       points["total_reported"],
		"total_computed":       points["total_computed"],
		"units":                units,
		// The canonical shape carries a single primary faction.
		"multi_force": false,
	}, nil
}

var rosterJSONAdapter = formatAdapter{
	id:      "roster-json",
	matches: rosterJSONMatches,
	parse:   rosterJSONParse,
}
