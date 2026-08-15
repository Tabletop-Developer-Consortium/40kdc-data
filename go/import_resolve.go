package wh40kdc

import "strings"

// Resolve a ParsedRoster onto 40kdc entity ids, producing a Roster. Lenient:
// unmatched names yield resolved:false refs with candidate suggestions. Go
// mirror of python .../imports/resolve.py.

const maxCandidates = 5

type diagBuilder struct {
	resolvedUnits     int
	unresolvedUnits   int
	resolvedWeapons   int
	unresolvedWeapons int
	warnings          []any
}

func (d *diagBuilder) warn(code, message string, rawName any) {
	d.warnings = append(d.warnings, map[string]any{"code": code, "message": message, "raw_name": rawName})
}

func (d *diagBuilder) build() map[string]any {
	w := d.warnings
	if w == nil {
		w = []any{}
	}
	return map[string]any{
		"resolved_units":     float64(d.resolvedUnits),
		"unresolved_units":   float64(d.unresolvedUnits),
		"resolved_weapons":   float64(d.resolvedWeapons),
		"unresolved_weapons": float64(d.unresolvedWeapons),
		"warnings":           w,
	}
}

func refUnresolved(rawName any, candidates []any) map[string]any {
	if candidates == nil {
		candidates = []any{}
	}
	return map[string]any{"id": nil, "raw_name": rawName, "resolved": false, "candidates": candidates}
}

func refResolved(id, rawName any) map[string]any {
	return map[string]any{"id": id, "raw_name": rawName, "resolved": true, "candidates": []any{}}
}

func candFromRaw(records []any) []any {
	out := []any{}
	for i, r := range records {
		if i >= maxCandidates {
			break
		}
		m, _ := asMap(r)
		entry := map[string]any{"id": m["id"]}
		if m["name"] != nil {
			entry["name"] = m["name"]
		}
		out = append(out, entry)
	}
	return out
}

func candFromUnits(records []*UnitView) []any {
	out := []any{}
	for i, r := range records {
		if i >= maxCandidates {
			break
		}
		out = append(out, map[string]any{"id": r.ID(), "name": r.Name()})
	}
	return out
}

func candFromWeapons(records []*WeaponView) []any {
	out := []any{}
	for i, r := range records {
		if i >= maxCandidates {
			break
		}
		out = append(out, map[string]any{"id": r.ID(), "name": r.Name()})
	}
	return out
}

// findWeaponCandidates resolves a weapon raw name to candidate weapons,
// tolerating a leading "The " mismatch in either direction (NewRecruit "The
// Bloody Twins" ↔ data "Bloody Twins"; GW "Fire Axe" ↔ data "The Fire Axe").
// Tries the name as given, then the "The"-stripped form, then the
// "The"-prefixed form, returning the first non-empty match set. Mirror of the
// TS findWeaponCandidates.
func findWeaponCandidates(ds *Dataset, rawName string) []*WeaponView {
	direct := ds.Weapons.FindAll(rawName)
	if len(direct) > 0 {
		return direct
	}
	if stripped, ok := StripLeadingThe(rawName); ok {
		if hits := ds.Weapons.FindAll(stripped); len(hits) > 0 {
			return hits
		}
	}
	return ds.Weapons.FindAll("The " + rawName)
}

// scopedWeaponID resolves a weapon raw name to one of the RESOLVED unit's own
// weapon ids — its weapon_ids plus ids reachable through its wargear options —
// so a name match picks the per-unit stat variant the unit actually fields.
// Matches by NormalizeName with the same leading-"The" tolerance as
// findWeaponCandidates; returns ("", false) when the unit fields no weapon of
// that name (the caller falls back to the global lookup). Mirror of the TS
// scopedWeaponID.
func scopedWeaponID(ds *Dataset, hit *UnitView, rawName string) (string, bool) {
	ids := append([]string{}, getStrList(hit.Raw, "weapon_ids")...)
	for _, optAny := range ds.wargearOptionsOf(hit.Raw) {
		opt, _ := optAny.(map[string]any)
		ids = append(ids, getStrList(opt, "replaces")...)
		ids = append(ids, getStrList(opt, "replacement")...)
		for _, gAny := range getList(opt, "replacement_choice") {
			g, _ := gAny.([]any)
			for _, idAny := range g {
				if s, ok := idAny.(string); ok {
					ids = append(ids, s)
				}
			}
		}
	}
	targets := map[string]bool{NormalizeName(rawName): true, NormalizeName("The " + rawName): true}
	if stripped, ok := StripLeadingThe(rawName); ok {
		targets[NormalizeName(stripped)] = true
	}
	factionID := getStr(hit.Raw, "faction_id")
	for _, id := range ids {
		w, ok := ds.Weapons.GetInFaction(id, factionID)
		if !ok {
			w, ok = ds.Weapons.GetAny(id)
		}
		if ok && targets[NormalizeName(w.Name())] {
			return w.ID(), true
		}
	}
	return "", false
}

// resolveWargearItemID is the fallback for wargear ITEMS (Simulacrum
// Imperialis, Daemonic Icon, …) — raw names that are not weapons but do exist
// in the wargear collection. Runs only after BOTH weapon lookups miss, so a
// wargear item whose name collides with a weapon ("multi-melta", "power
// weapon") keeps resolving to the weapon exactly as before. Scoped-first: ids
// reachable through the resolved unit's wargear options, then the global
// collection (wargear is replicated-identical across factions, so a global
// first-match is safe). Same NormalizeName + leading-"The" tolerance as the
// weapon lookups. Mirror of the TS resolveWargearItemId.
func resolveWargearItemID(ds *Dataset, hit *UnitView, rawName string) (string, bool) {
	stripped, hasStripped := StripLeadingThe(rawName)
	if hit != nil {
		var ids []string
		for _, optAny := range ds.wargearOptionsOf(hit.Raw) {
			opt, _ := optAny.(map[string]any)
			ids = append(ids, getStrList(opt, "replaces")...)
			ids = append(ids, getStrList(opt, "replacement")...)
			for _, gAny := range getList(opt, "replacement_choice") {
				g, _ := gAny.([]any)
				for _, idAny := range g {
					if s, ok := idAny.(string); ok {
						ids = append(ids, s)
					}
				}
			}
		}
		targets := map[string]bool{NormalizeName(rawName): true, NormalizeName("The " + rawName): true}
		if hasStripped {
			targets[NormalizeName(stripped)] = true
		}
		for _, id := range ids {
			if itemAny, ok := ds.Wargear.GetAny(id); ok {
				item, _ := itemAny.(map[string]any)
				if targets[NormalizeName(getStr(item, "name"))] {
					return getStr(item, "id"), true
				}
			}
		}
	}
	if itemAny, ok := ds.Wargear.Find(rawName); ok {
		return getStr(itemAny.(map[string]any), "id"), true
	}
	if hasStripped {
		if itemAny, ok := ds.Wargear.Find(stripped); ok {
			return getStr(itemAny.(map[string]any), "id"), true
		}
	}
	if itemAny, ok := ds.Wargear.Find("The " + rawName); ok {
		return getStr(itemAny.(map[string]any), "id"), true
	}
	return "", false
}

func mapBattleSize(raw any) any {
	s, ok := raw.(string)
	if !ok || s == "" {
		return nil
	}
	key := NormalizeName(s)
	if containsSub(key, "strike force") {
		return "strike-force"
	}
	if containsSub(key, "incursion") {
		return "incursion"
	}
	return nil
}

func containsSub(h, n string) bool { return len(n) == 0 || indexOf(h, n) >= 0 }

func indexOf(h, n string) int {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return i
		}
	}
	return -1
}

func detachmentCap(battleSize any) any {
	switch battleSize {
	case "strike-force":
		return float64(3)
	case "incursion":
		return float64(2)
	}
	return nil
}

func lookupDetachment(ds *Dataset, detachmentID, factionID string) map[string]any {
	if factionID != "" {
		if detachment, ok := ds.Detachments.GetInFaction(detachmentID, factionID); ok {
			return detachment.(map[string]any)
		}
	}
	if detachment, ok := ds.Detachments.GetAny(detachmentID); ok {
		return detachment.(map[string]any)
	}
	return nil
}

func resolveRoster(parsed map[string]any, ds *Dataset, format string) map[string]any {
	diag := &diagBuilder{}
	if parsed["multi_force"] == true {
		diag.warn("multi-force", "Source list contains more than one faction; the primary faction was used for scoping.", nil)
	}

	var factionID any
	if fr, ok := parsed["faction_raw_name"].(string); ok && fr != "" {
		if hit, ok := ds.Factions.Find(fr); ok {
			factionID = hit.ID()
		} else {
			diag.warn("faction-unresolved", "Faction name did not match any 40kdc faction.", fr)
		}
	}
	if factionID == nil && getStr(parsed, "faction_raw_name") == "" {
		// Metadata-free exports can still identify their army from unit names, but
		// only let an exact faction-unique name contribute. A shared unit name
		// (including aliases) is deliberately ignored, and a tied total remains
		// unresolved.
		counts := map[string]int{}
		for _, parsedUnitAny := range getList(parsed, "units") {
			rawName := getStr(parsedUnitAny.(map[string]any), "raw_name")
			key := NormalizeName(rawName)
			exactFactions := map[string]struct{}{}
			for _, candidate := range ds.Units.FindAll(rawName) {
				exact := NormalizeName(candidate.Name()) == key
				if !exact {
					for _, alias := range getStrList(candidate.Raw, "aliases") {
						if NormalizeName(alias) == key {
							exact = true
							break
						}
					}
				}
				if exact {
					if candidateFactionID := getStr(candidate.Raw, "faction_id"); candidateFactionID != "" {
						exactFactions[candidateFactionID] = struct{}{}
					}
				}
			}
			if len(exactFactions) == 1 {
				for inferredFactionID := range exactFactions {
					counts[inferredFactionID]++
				}
			}
		}
		leaderID, leaderCount := "", 0
		tied := false
		for candidateFactionID, count := range counts {
			if count > leaderCount {
				leaderID, leaderCount, tied = candidateFactionID, count, false
			} else if count == leaderCount {
				tied = true
			}
		}
		if leaderID != "" && !tied {
			factionID = leaderID
		}
	}
	factionIDStr, _ := factionID.(string)
	resolveDetachment := func(rawName string) map[string]any {
		key := NormalizeName(rawName)
		var scoped map[string]any
		if factionIDStr != "" {
			for _, dAny := range ds.Detachments.ByFaction(factionIDStr) {
				d := dAny.(map[string]any)
				if NormalizeName(getStr(d, "name")) == key {
					scoped = d
					break
				}
			}
		}
		var hit map[string]any
		if scoped != nil {
			hit = scoped
		} else if h, ok := ds.Detachments.Find(rawName); ok {
			hit = h.(map[string]any)
		}
		if hit == nil {
			return nil
		}
		return map[string]any{
			"ref":     refResolved(hit["id"], rawName),
			"dp_cost": detachmentPointsOrNil(hit),
		}
	}
	detachments := []any{}
	for _, rnAny := range getList(parsed, "detachment_raw_names") {
		rawName := rnAny.(string)
		if whole := resolveDetachment(rawName); whole != nil {
			detachments = append(detachments, whole)
			continue
		}
		// Dual-detachment 11e lists print both names on one line joined with
		// " and " ("Hexwarp Thrallband and Sekhetar Cohort") or a comma
		// ("Exhibition of Slaughter, Skysplinter Assault"). Splitting is a
		// RESOLVE-TIME fallback, taken only when the whole name fails and every
		// part resolves — "Legends of Saga and Song" is a real single-detachment
		// name a lexical split would corrupt.
		parts := splitDetachmentParts(rawName)
		if len(parts) > 1 {
			split := make([]map[string]any, 0, len(parts))
			ok := true
			for _, p := range parts {
				d := resolveDetachment(p)
				if d == nil {
					ok = false
					break
				}
				split = append(split, d)
			}
			if ok {
				for _, d := range split {
					detachments = append(detachments, d)
				}
				continue
			}
		}
		diag.warn("detachment-unresolved", "Detachment name did not match any 40kdc detachment.", rawName)
		detachments = append(detachments, map[string]any{
			"ref":     refUnresolved(rawName, candFromRaw(ds.Detachments.FindAll(rawName))),
			"dp_cost": nil,
		})
	}
	var detachmentIDs []string
	for _, dAny := range detachments {
		d := dAny.(map[string]any)
		ref := d["ref"].(map[string]any)
		if id, ok := ref["id"].(string); ok {
			detachmentIDs = append(detachmentIDs, id)
		}
	}

	// roster-json carries an already-resolved id; ListForge and WTC text carry
	// the raw header name (e.g. "Priority Assets"), resolved here against the
	// dataset.
	forceDisposition := parsed["force_disposition"]
	if forceDisposition == nil {
		if raw, ok := parsed["force_disposition_raw_name"].(string); ok && raw != "" {
			name := raw
			if NormalizeName(name) == "recon" {
				name = "Reconnaissance"
			}
			if hit, ok := ds.ForceDispositions.Find(name); ok {
				forceDisposition = hit.(map[string]any)["id"]
			} else {
				diag.warn("disposition-unresolved", "Force Disposition name did not match any 40kdc disposition.", raw)
			}
		}
	}

	battleSize := mapBattleSize(parsed["battle_size_raw"])
	if bsr, ok := parsed["battle_size_raw"].(string); ok && bsr != "" && battleSize == nil {
		diag.warn("battle-size-unmapped", "Battle size label could not be mapped.", bsr)
	}
	cap := detachmentCap(battleSize)

	if cap != nil && len(detachments) > 0 {
		allKnown := true
		spent := 0.0
		for _, dAny := range detachments {
			d := dAny.(map[string]any)
			if d["dp_cost"] == nil {
				allKnown = false
				break
			}
			spent += asFloat(d["dp_cost"])
		}
		if allKnown && spent > asFloat(cap) {
			diag.warn("detachment-points-exceeded",
				"Detachments cost "+numStr(spent)+" detachment points but the "+battleSize.(string)+" budget is "+numStr(cap)+".", nil)
		}
	}

	units := []any{}
	parsedUnits := getList(parsed, "units")
	for _, puAny := range parsedUnits {
		pu := puAny.(map[string]any)
		units = append(units, resolveUnit(pu, factionIDStr, detachmentIDs, ds, diag))
	}

	if len(detachments) == 0 {
		inferred := map[string]bool{}
		for _, unitAny := range units {
			unit, _ := asMap(unitAny)
			enh, _ := asMap(unit["enhancement"])
			if enhancementID, ok := enh["id"].(string); ok && enhancementID != "" {
				if enhancementAny, ok := ds.Enhancements.GetAny(enhancementID); ok {
					if detachmentID := getStr(enhancementAny.(map[string]any), "detachment_id"); detachmentID != "" {
						inferred[detachmentID] = true
					}
				}
			}
		}
		if len(inferred) == 1 {
			for detachmentID := range inferred {
				if detachment := lookupDetachment(ds, detachmentID, factionIDStr); detachment != nil {
					detachments = append(detachments, map[string]any{
						"ref": refResolved(detachmentID, getStr(detachment, "name")), "dp_cost": detachmentPointsOrNil(detachment),
					})
					detachmentIDs = append(detachmentIDs, detachmentID)
				}
			}
		}
	}
	_, dispositionWasSpecified := parsed["force_disposition_raw_name"]
	if forceDisposition == nil && dispositionWasSpecified && parsed["force_disposition_raw_name"] == nil && len(detachmentIDs) > 0 {
		candidate := ""
		unambiguous := true
		for _, detachmentID := range detachmentIDs {
			detachment := lookupDetachment(ds, detachmentID, factionIDStr)
			dispositions := getStrList(detachment, "force_dispositions")
			if len(dispositions) != 1 || (candidate != "" && candidate != dispositions[0]) {
				unambiguous = false
				break
			}
			candidate = dispositions[0]
		}
		if unambiguous && candidate != "" {
			forceDisposition = candidate
		}
	}
	if format == "gw" {
		hasWarlord := false
		for _, unitAny := range units {
			if unitAny.(map[string]any)["is_warlord"] == true {
				hasWarlord = true
				break
			}
		}
		if !hasWarlord {
			for i, parsedUnitAny := range parsedUnits {
				if parsedUnitAny.(map[string]any)["is_character"] == true {
					units[i].(map[string]any)["is_warlord"] = true
					break
				}
			}
		}
	}
	applyLeaderAttachments(parsedUnits, units, ds, factionIDStr, diag)

	tr := parsed["total_reported"]
	tc := parsed["total_computed"]
	if tr != nil && !numEq(tr, tc) {
		diag.warn("points-mismatch",
			"Source-reported total ("+numStr(tr)+") differs from the sum of cost lines ("+numStr(tc)+").", nil)
	}

	return map[string]any{
		"name":              parsed["name"],
		"source":            map[string]any{"format": format, "generated_by": parsed["generated_by"]},
		"faction_id":        factionID,
		"detachments":       detachments,
		"battle_size":       battleSize,
		"force_disposition": forceDisposition,
		"points": map[string]any{
			"declared_limit": parsed["declared_limit"],
			"detachment_cap": cap,
			"total_reported": parsed["total_reported"],
			"total_computed": parsed["total_computed"],
		},
		"units":        units,
		"game_version": map[string]any{"edition": "11th", "dataslate": "pre-launch-provisional"},
		"diagnostics":  diag.build(),
	}
}

func detachmentPointsOrNil(d map[string]any) any {
	if v, ok := d["detachment_points"]; ok {
		return v
	}
	return nil
}

// chaosChassisPrefix is the canonical prefix the dataset uses for shared Chaos
// chassis ("Chaos Rhino", "Chaos Land Raider", …). GW/NewRecruit subfaction
// exports substitute the faction name for it ("Death Guard Rhino"), so swapping
// it back is one of the candidate lookups (see unitLookupCandidates).
const chaosChassisPrefix = "Chaos "

// unitLookupCandidates returns candidate lookup strings for a unit name, in
// priority order. GW/NewRecruit exports prefix shared chassis with the faction's
// display name in two forms: keeping "Chaos" ("Death Guard Chaos Spawn" → dataset
// "Chaos Spawn") or replacing it ("Death Guard Rhino" → dataset "Chaos Rhino").
// When rawName starts with the resolved faction's display name we therefore also
// try the prefix stripped, and the prefix replaced with chaosChassisPrefix. The
// original rawName is always what gets recorded on the ref — only the lookup is
// adjusted. This is a general rule over all shared Chaos chassis × every faction,
// not per-unit data.
func unitLookupCandidates(rawName, factionID string, ds *Dataset) []string {
	candidates := []string{rawName}
	if factionID != "" {
		if fac, ok := ds.Factions.Get(factionID); ok {
			if factionName := fac.Name(); factionName != "" {
				prefix := factionName + " "
				if len(rawName) > len(prefix) && strings.HasPrefix(lower(rawName), lower(prefix)) {
					rest := strings.TrimLeft(rawName[len(prefix):], " \t\n\r\f\v")
					if rest != "" {
						candidates = append(candidates, rest, chaosChassisPrefix+rest)
					}
				}
			}
		}
	}
	// De-duplicate while preserving order (e.g. a name already starting "Chaos ").
	seen := map[string]struct{}{}
	out := candidates[:0]
	for _, c := range candidates {
		if _, dup := seen[c]; dup {
			continue
		}
		seen[c] = struct{}{}
		out = append(out, c)
	}
	return out
}

func resolveUnit(parsed map[string]any, factionID string, detachmentIDs []string, ds *Dataset, diag *diagBuilder) map[string]any {
	rawName := getStr(parsed, "raw_name")
	lookupNames := unitLookupCandidates(rawName, factionID, ds)

	// Prefer a faction-scoped exact match (the same unit id recurs across factions,
	// and a stripped base name can collide with another faction's unit — e.g.
	// "Rhino" matches the Space Marine Rhino), matching canonical name or alias.
	var inFaction []*UnitView
	if factionID != "" {
		inFaction = ds.Units.ByFaction(factionID)
	}
	scopedExact := func(q string) *UnitView {
		k := NormalizeName(q)
		for _, u := range inFaction {
			if NormalizeName(u.Name()) == k {
				return u
			}
			for _, a := range getStrList(u.Raw, "aliases") {
				if NormalizeName(a) == k {
					return u
				}
			}
		}
		return nil
	}

	var hit *UnitView
	for _, q := range lookupNames {
		if hit = scopedExact(q); hit != nil {
			break
		}
	}

	var allHits []*UnitView
	if hit == nil {
		// Global fallback (alias-aware via the name index); still prefer the
		// resolved faction's copy of a shared id over whichever registered first.
		for _, q := range lookupNames {
			allHits = ds.Units.FindAll(q)
			if factionID != "" {
				for _, u := range allHits {
					if getStr(u.Raw, "faction_id") == factionID {
						hit = u
						break
					}
				}
			}
			if hit == nil && len(allHits) > 0 {
				hit = allHits[0]
			}
			if hit != nil {
				break
			}
		}
	}

	var ref map[string]any
	if hit != nil {
		ref = refResolved(hit.ID(), rawName)
		diag.resolvedUnits++
	} else {
		ref = refUnresolved(rawName, candFromUnits(allHits))
		diag.unresolvedUnits++
		diag.warn("unit-unresolved", "Unit name did not match any 40kdc unit.", rawName)
	}

	var enhancement any
	var enhancementPoints any
	if enr, ok := parsed["enhancement_raw_name"].(string); ok && enr != "" {
		enhancement = resolveEnhancement(enr, detachmentIDs, ds, diag)
		enhancementPoints = parsed["enhancement_points"]
	}

	// ── Model-line reclassification ─────────────────────────────────────────
	// The flat GW dialects print model bullets at the same indent as weapon
	// bullets, so the parser cannot tell "• 9x Pathfinder" from "• 10x Pulse
	// carbine" — the model names land in wargear and model_count collapses to
	// its 1 fallback. The RESOLVED unit knows its composition row names — and
	// its own name covers vehicle squadrons ("2x Hippogriff AFV") — so a wargear
	// entry matching one (singular/plural-insensitive) is a model line: its
	// count rebuilds the model count and it leaves the wargear bag. Mirror of
	// the TS reference.
	modelCount := asInt(parsed["model_count"])
	wargearLines := getList(parsed, "wargear")
	if hit != nil {
		modelNames := map[string]bool{singularName(hit.Name()): true}
		for _, a := range getStrList(hit.Raw, "aliases") {
			modelNames[singularName(a)] = true
		}
		models, _ := ds.unitCompositionOf(hit.Raw)
		for _, mAny := range models {
			m, _ := asMap(mAny)
			if name := getStr(m, "name"); name != "" {
				modelNames[singularName(name)] = true
			}
		}
		modelSum := 0
		lineNames := map[string]bool{}
		for _, wAny := range wargearLines {
			w, _ := asMap(wAny)
			if n := singularName(getStr(w, "raw_name")); modelNames[n] {
				modelSum += asInt(w["count"])
				lineNames[n] = true
			}
		}
		if modelSum > 0 {
			kept := make([]any, 0, len(wargearLines))
			for _, wAny := range wargearLines {
				w, _ := asMap(wAny)
				if !modelNames[singularName(getStr(w, "raw_name"))] {
					kept = append(kept, wAny)
				}
			}
			wargearLines = kept
			// When the reclassified lines cover EVERY composition row name, they
			// fully enumerate the unit and the parser's count was its synthetic 1
			// fallback — the sum stands alone. Any uncovered row means the parser
			// genuinely counted those models (a colon-dialect line) and the flat
			// lines are the REST of the squad — the counts add. Mirror of TS.
			covered := true
			for _, mAny := range models {
				m, _ := asMap(mAny)
				if name := getStr(m, "name"); name != "" && !lineNames[singularName(name)] {
					covered = false
					break
				}
			}
			if covered {
				modelCount = modelSum
			} else {
				modelCount += modelSum
			}
		}
	}

	wargear := []any{}
	for _, wAny := range wargearLines {
		w := wAny.(map[string]any)
		// Prefer the resolved unit's own weapon of this name — picks the right
		// per-unit stat variant — falling back to the global lookup only when the
		// unit is unresolved or fields no weapon of that name.
		if hit != nil {
			if id, ok := scopedWeaponID(ds, hit, getStr(w, "raw_name")); ok {
				diag.resolvedWeapons++
				wargear = append(wargear, map[string]any{"ref": refResolved(id, w["raw_name"]), "count": w["count"]})
				continue
			}
		}
		hits := findWeaponCandidates(ds, getStr(w, "raw_name"))
		if len(hits) > 0 {
			diag.resolvedWeapons++
			wargear = append(wargear, map[string]any{"ref": refResolved(hits[0].ID(), w["raw_name"]), "count": w["count"]})
		} else if wargearItemID, ok := resolveWargearItemID(ds, hit, getStr(w, "raw_name")); ok {
			diag.resolvedWeapons++
			wargear = append(wargear, map[string]any{"ref": refResolved(wargearItemID, w["raw_name"]), "count": w["count"]})
		} else {
			diag.unresolvedWeapons++
			diag.warn("weapon-unresolved", "Weapon name did not match any 40kdc weapon.", w["raw_name"])
			wargear = append(wargear, map[string]any{"ref": refUnresolved(w["raw_name"], candFromWeapons(hits)), "count": w["count"]})
		}
	}

	var loadoutGroups []any
	// Some selection-tree formats expose model groups containing only explicitly
	// printed gear. Preserve fully enumerated source groups, but let the normal
	// completion path reconstruct groups when legal implicit defaults are absent.
	// A failed completion deliberately leaves the source groups intact: it must not
	// turn an impossible optional combination into an invented legal loadout.
	useParsedGroups := parsed["loadout_groups"] != nil
	if useParsedGroups && hit != nil {
		explicitCounts := map[string]int{}
		allResolved := true
		for _, itemAny := range wargear {
			item, _ := asMap(itemAny)
			id, ok := refOf(item)["id"].(string)
			if !ok || id == "" {
				allResolved = false
				break
			}
			explicitCounts[id] += asInt(item["count"])
		}
		if allResolved {
			models, _ := ds.unitCompositionOf(hit.Raw)
			if completed := completeLoadout(hit.Raw, modelCount, ds.wargearOptionsOf(hit.Raw), models, explicitCounts); completed != nil {
				if len(completed.counts) != len(explicitCounts) {
					useParsedGroups = false
				} else {
					for id, count := range completed.counts {
						if explicitCounts[id] != count {
							useParsedGroups = false
							break
						}
					}
				}
			}
		}
	}

	if parsedGroups, hasGroups := parsed["loadout_groups"]; hasGroups && parsedGroups != nil && useParsedGroups {
		for _, groupAny := range getList(parsed, "loadout_groups") {
			group, _ := asMap(groupAny)
			groupWargear := []any{}
			for _, itemAny := range getList(group, "wargear") {
				item, _ := asMap(itemAny)
				raw := getStr(item, "raw_name")
				var resolved map[string]any
				for _, aggregateAny := range wargear {
					aggregate, _ := asMap(aggregateAny)
					if NormalizeName(getStr(refOf(aggregate), "raw_name")) == NormalizeName(raw) {
						resolved = refOf(aggregate)
						break
					}
				}
				if resolved == nil && hit != nil {
					if id, ok := scopedWeaponID(ds, hit, raw); ok {
						resolved = refResolved(id, raw)
					}
				}
				if resolved == nil {
					if hits := findWeaponCandidates(ds, raw); len(hits) > 0 {
						resolved = refResolved(hits[0].ID(), raw)
					} else if id, ok := resolveWargearItemID(ds, hit, raw); ok {
						resolved = refResolved(id, raw)
					} else {
						resolved = refUnresolved(raw, []any{})
					}
				}
				groupWargear = append(groupWargear, map[string]any{"ref": resolved, "count": item["count"]})
			}
			loadoutGroups = append(loadoutGroups, map[string]any{
				"model_name": group["model_name"], "count": group["count"], "wargear": groupWargear,
			})
		}
		allResolved := true
		originalIDs := map[string]bool{}
		for _, itemAny := range wargear {
			originalIDs[getStr(refOf(itemAny.(map[string]any)), "id")] = true
		}
		grouped := map[string]map[string]any{}
		for _, groupAny := range loadoutGroups {
			group, _ := asMap(groupAny)
			for _, itemAny := range getList(group, "wargear") {
				item, _ := asMap(itemAny)
				ref := refOf(item)
				id, ok := ref["id"].(string)
				if !ok || id == "" {
					allResolved = false
					break
				}
				if existing, found := grouped[id]; found {
					existing["count"] = asInt(existing["count"]) + asInt(group["count"])*asInt(item["count"])
				} else {
					grouped[id] = map[string]any{"ref": ref, "count": asInt(group["count"]) * asInt(item["count"])}
				}
			}
		}
		if allResolved {
			remaining := grouped
			seen := map[string]bool{}
			reconciled := []any{}
			for _, itemAny := range wargear {
				item, _ := asMap(itemAny)
				id, _ := refOf(item)["id"].(string)
				if seen[id] {
					continue
				}
				seen[id] = true
				if replacement, ok := remaining[id]; ok {
					reconciled = append(reconciled, replacement)
					delete(remaining, id)
				} else {
					reconciled = append(reconciled, item)
				}
			}
			for id := range remaining {
				if !originalIDs[id] {
					diag.resolvedWeapons++
				}
			}
			for _, groupAny := range loadoutGroups {
				for _, itemAny := range getList(groupAny.(map[string]any), "wargear") {
					item, _ := asMap(itemAny)
					id, _ := refOf(item)["id"].(string)
					if replacement, ok := remaining[id]; ok {
						reconciled = append(reconciled, replacement)
						delete(remaining, id)
					}
				}
			}

			wargear = reconciled
		}
	} else {
		if lg := buildLoadoutGroups(hit, modelCount, wargear, ds); lg != nil {
			loadoutGroups = lg
		}
		if loadoutGroups == nil && hit != nil {
			explicitRefs := map[string]map[string]any{}
			explicitCounts := map[string]int{}
			allResolved := true
			for _, itemAny := range wargear {
				item, _ := asMap(itemAny)
				ref := refOf(item)
				id, ok := ref["id"].(string)
				if !ok || id == "" {
					allResolved = false
					break
				}
				explicitRefs[id] = ref
				explicitCounts[id] += asInt(item["count"])
			}
			if allResolved {
				models, _ := ds.unitCompositionOf(hit.Raw)
				if completed := completeLoadout(hit.Raw, modelCount, ds.wargearOptionsOf(hit.Raw), models, explicitCounts); completed != nil {
					refForID := func(id string) map[string]any {
						if ref := explicitRefs[id]; ref != nil {
							return ref
						}
						for _, weapon := range hit.Weapons() {
							if weapon.ID() == id {
								return refResolved(id, weapon.Name())
							}
						}
						if item, ok := ds.Wargear.Get(id); ok {
							return refResolved(id, getStr(item.(map[string]any), "name"))
						}
						for _, ability := range hit.Abilities() {
							if ability.ID() == id {
								return refResolved(id, ability.Name())
							}
						}
						return refResolved(id, id)
					}
					remaining := map[string]any{}
					remainingOrder := []string{}
					seenRemaining := map[string]bool{}
					for _, id := range completed.order {
						remainingOrder = append(remainingOrder, id)
						seenRemaining[id] = true
					}
					for id, count := range completed.counts {
						remaining[id] = map[string]any{"ref": refForID(id), "count": count}
						if !seenRemaining[id] {
							remainingOrder = append(remainingOrder, id)
							seenRemaining[id] = true
						}
					}
					reconciled := []any{}
					seen := map[string]bool{}
					for _, itemAny := range wargear {
						item, _ := asMap(itemAny)
						id := getStr(refOf(item), "id")
						if seen[id] {
							continue
						}
						seen[id] = true
						if replacement, ok := remaining[id]; ok {
							reconciled = append(reconciled, replacement)
							delete(remaining, id)
						}
					}
					for _, id := range remainingOrder {
						replacement, ok := remaining[id]
						if !ok {
							continue
						}
						if explicitRefs[id] == nil {
							diag.resolvedWeapons++
						}
						reconciled = append(reconciled, replacement)
					}
					wargear = reconciled
					if completed.groups != nil {
						loadoutGroups = []any{}
						for _, groupAny := range completed.groups {
							group, _ := asMap(groupAny)
							groupWargear := []any{}
							for _, weaponAny := range getList(group, "weapons") {
								weapon, _ := asMap(weaponAny)
								groupWargear = append(groupWargear, map[string]any{"ref": refForID(getStr(weapon, "id")), "count": weapon["count"]})
							}
							loadoutGroups = append(loadoutGroups, map[string]any{"model_name": group["model_name"], "count": group["count"], "wargear": groupWargear})
						}
					}
				}
			}
		}
	}

	result := map[string]any{
		"ref":                ref,
		"model_count":        modelCount,
		"points":             parsed["points"],
		"is_warlord":         parsed["is_warlord"],
		"enhancement":        enhancement,
		"enhancement_points": enhancementPoints,
		"wargear":            wargear,
		"leader_attachment":  nil,
	}
	if len(loadoutGroups) > 0 {
		result["loadout_groups"] = loadoutGroups
	}
	keywordOverrides := []any{}
	seenKeywordOverrides := map[string]bool{}
	for _, override := range getList(parsed, "keyword_overrides") {
		keyword, ok := override.(string)
		if !ok || seenKeywordOverrides[keyword] {
			continue
		}
		seenKeywordOverrides[keyword] = true
		keywordOverrides = append(keywordOverrides, keyword)
	}
	if parsed["is_character"] == true && hit != nil &&
		getStr(hit.Raw, "role") != "character" && getStr(hit.Raw, "role") != "epic-hero" &&
		!contains(getStrList(hit.Raw, "keywords"), "Character") && !seenKeywordOverrides["Character"] {
		keywordOverrides = append(keywordOverrides, "Character")
	}
	if len(keywordOverrides) > 0 {
		result["keyword_overrides"] = keywordOverrides
	}

	// Loadout legality — the conservative checker over the fully-resolved counts.
	// Gated exactly like grouping (an unresolved unit has no datasheet; an
	// unresolved weapon means the counts under-report the list), plus two
	// import-specific reliability gates: the parsed model count must sit inside
	// the composition envelope (the GW flat dialect infers model_count 1 for some
	// units, so invalid-model-count is also filtered), and below-min is filtered
	// (list formats omit implicit default weapons). Mirror of the TS reference.
	if hit != nil {
		allResolved := true
		counts := map[string]int{}
		for _, wAny := range wargear {
			w, _ := asMap(wAny)
			r, _ := asMap(w["ref"])
			id, ok := r["id"].(string)
			if !ok || id == "" {
				allResolved = false
				break
			}
			counts[id] += asInt(w["count"])
		}
		if allResolved {
			models, tiers := ds.unitCompositionOf(hit.Raw)
			envMin, envMax := 0, 0
			for _, mAny := range models {
				m, _ := asMap(mAny)
				envMin += asInt(m["min"])
				envMax += asInt(m["max"])
			}
			if len(models) == 0 || (modelCount >= envMin && modelCount <= envMax) {
				var violations []map[string]string
				for _, v := range checkUnitLegality(hit.Raw, modelCount, ds.wargearOptionsOf(hit.Raw), counts, models, tiers) {
					if v["code"] == "invalid-model-count" || v["code"] == "below-min" {
						continue
					}
					violations = append(violations, v)
				}
				if len(violations) > 0 {
					parts := make([]string, 0, len(violations))
					for _, v := range violations {
						parts = append(parts, v["code"]+":"+v["id"])
					}
					diag.warn(
						"loadout-illegal",
						"Loadout is not buildable from the datasheet's wargear options: "+strings.Join(parts, ", "),
						parsed["raw_name"],
					)
				}
			}
		}
	}
	return result
}

// singularName is the singular/plural- and case-insensitive form for
// model-line matching: normalizeName then drop every 's' at a word boundary —
// exact mirror of the TS normalizeName(s).replace(/s\\b/g, "") (a boundary is
// a following non-word character or end of string).
func singularName(s string) string {
	n := NormalizeName(s)
	runes := []rune(n)
	out := make([]rune, 0, len(runes))
	for i, ch := range runes {
		nextIsWord := false
		if i+1 < len(runes) {
			c := runes[i+1]
			nextIsWord = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_'
		}
		if ch == 's' && !nextIsWord {
			continue
		}
		out = append(out, ch)
	}
	return string(out)
}

// splitDetachmentParts splits a dual-detachment line on its " and " / comma
// joiners (the resolve-time fallback's tokenizer; see the detachment loop).
func splitDetachmentParts(raw string) []string {
	var out []string
	for _, chunk := range strings.Split(raw, ",") {
		for _, part := range strings.Split(chunk, " and ") {
			if t := strings.TrimSpace(part); t != "" {
				out = append(out, t)
			}
		}
	}
	return out
}

// buildLoadoutGroups recomputes a unit's loadout_groups from its resolved wargear
// via GroupLoadout — the same maths the exporter uses, so an import→export
// round-trip is stable. nil when the unit is unresolved, any weapon is unresolved,
// or the loadout doesn't decompose exactly. Mirror of the TS buildLoadoutGroups.
func buildLoadoutGroups(hit *UnitView, modelCount int, wargear []any, ds *Dataset) []any {
	if hit == nil {
		return nil
	}
	refByID := map[string]any{}
	counts := map[string]int{}
	for _, wAny := range wargear {
		w := wAny.(map[string]any)
		ref := w["ref"].(map[string]any)
		id, ok := ref["id"].(string)
		if !ok || id == "" {
			return nil // incomplete aggregate → can't group faithfully
		}
		refByID[id] = ref
		counts[id] += asInt(w["count"])
	}
	options := ds.wargearOptionsOf(hit.Raw)
	models, _ := ds.unitCompositionOf(hit.Raw)
	groups := GroupLoadout(hit.Raw, modelCount, options, models, counts)
	if groups == nil {
		return nil
	}
	out := []any{}
	for _, gAny := range groups {
		g := gAny.(map[string]any)
		gw := []any{}
		for _, wAny := range g["weapons"].([]any) {
			w := wAny.(map[string]any)
			id := w["id"].(string)
			gw = append(gw, map[string]any{"ref": refByID[id], "count": w["count"]})
		}
		out = append(out, map[string]any{
			"model_name": g["model_name"],
			"count":      g["count"],
			"wargear":    gw,
		})
	}
	return out
}

func resolveEnhancement(rawName string, detachmentIDs []string, ds *Dataset, diag *diagBuilder) map[string]any {
	key := NormalizeName(rawName)
	var scoped map[string]any
	if len(detachmentIDs) > 0 {
		for _, eAny := range ds.Enhancements.All() {
			e := eAny.(map[string]any)
			did, _ := e["detachment_id"].(string)
			if containsStr2(detachmentIDs, did) && NormalizeName(getStr(e, "name")) == key {
				scoped = e
				break
			}
		}
	}
	var hit map[string]any
	if scoped != nil {
		hit = scoped
	} else if h, ok := ds.Enhancements.Find(rawName); ok {
		hit = h.(map[string]any)
	}
	if hit != nil {
		return refResolved(hit["id"], rawName)
	}
	diag.warn("enhancement-unresolved", "Enhancement name did not match any 40kdc enhancement.", rawName)
	return refUnresolved(rawName, candFromRaw(ds.Enhancements.FindAll(rawName)))
}

// applyLeaderAttachments resolves leader→bodyguard attachments in two passes
// (mirror of the TS applyLeaderAttachments):
//
//  1. Explicit attachments carried verbatim from the source (only the canonical
//     roster-json round-trip encodes one) are reconstructed exactly — the
//     bodyguard id is re-resolved against the current dataset, but the role and
//     provisional flag are preserved (lossless, incl. leader-role attachments
//     inference never produces).
//  2. For every other character, the source does not encode an unambiguous
//     attachment, so each inferred link is marked provisional: only `support`
//     characters (which cannot operate alone) are auto-attached.
func applyLeaderAttachments(parsedUnits []any, units []any, ds *Dataset, factionID string, diag *diagBuilder) {
	// --- Pass 1: explicit attachments (lossless). ----------------------------
	for i, uAny := range units {
		pu := parsedUnits[i].(map[string]any)
		explicit, ok := pu["leader_attachment"].(map[string]any)
		if !ok {
			continue
		}
		key := NormalizeName(getStr(explicit, "bodyguard_raw_name"))
		var bodyguard map[string]any
		for _, bAny := range units {
			b := bAny.(map[string]any)
			bref := b["ref"].(map[string]any)
			if NormalizeName(getStr(bref, "raw_name")) == key {
				bodyguard = b
				break
			}
		}
		if bodyguard == nil {
			continue
		}
		bref := bodyguard["ref"].(map[string]any)
		var bodyguardRef map[string]any
		if id, ok := bref["id"].(string); ok && id != "" {
			bodyguardRef = refResolved(id, bref["raw_name"])
		} else {
			bodyguardRef = refUnresolved(bref["raw_name"], nil)
		}
		unit := uAny.(map[string]any)
		unit["leader_attachment"] = map[string]any{
			"bodyguard_ref": bodyguardRef,
			"role":          explicit["role"],
			"provisional":   explicit["provisional"],
		}
	}

	// --- Pass 2: inference for characters without an explicit attachment. -----
	bodyguardIDs := map[string]bool{}
	for i, uAny := range units {
		u := uAny.(map[string]any)
		ref := u["ref"].(map[string]any)
		pu := parsedUnits[i].(map[string]any)
		if id, ok := ref["id"].(string); ok && id != "" && pu["is_character"] != true {
			bodyguardIDs[id] = true
		}
	}
	for i, uAny := range units {
		unit := uAny.(map[string]any)
		ref := unit["ref"].(map[string]any)
		pu := parsedUnits[i].(map[string]any)
		if _, has := pu["leader_attachment"].(map[string]any); has {
			continue // explicit already applied in pass 1
		}
		leaderID, ok := ref["id"].(string)
		if !ok || leaderID == "" || pu["is_character"] != true {
			continue
		}
		// Only `support` characters are auto-attached: per the GW datasheet
		// bodyguard-group data they cannot operate alone, so attaching to an
		// eligible bodyguard present in the roster is certain. A `leader` (or a
		// character with no attachment_role) MAY be solo, so we don't guess one.
		// attachment_role is faction-specific, so resolve faction-scoped.
		var resolvedUnit *UnitView
		if factionID != "" {
			if uv, ok := ds.Units.GetInFaction(leaderID, factionID); ok {
				resolvedUnit = uv
			}
		}
		if resolvedUnit == nil {
			if uv, ok := ds.Units.GetAny(leaderID); ok {
				resolvedUnit = uv
			}
		}
		if resolvedUnit == nil || getStr(resolvedUnit.Raw, "attachment_role") != "support" {
			continue
		}
		var attachment map[string]any
		for _, laAny := range ds.LeaderAttachments {
			la := laAny.(map[string]any)
			if getStr(la, "leader_id") == leaderID {
				attachment = la
				break
			}
		}
		if attachment == nil {
			continue
		}
		var bodyguardID string
		for _, idAny := range getStrList(attachment, "eligible_bodyguard_ids") {
			if bodyguardIDs[idAny] {
				bodyguardID = idAny
				break
			}
		}
		if bodyguardID == "" {
			continue
		}
		var bodyguard map[string]any
		for _, bAny := range units {
			b := bAny.(map[string]any)
			bref := b["ref"].(map[string]any)
			if bref["id"] == bodyguardID {
				bodyguard = b
				break
			}
		}
		if bodyguard == nil {
			continue
		}
		bref := bodyguard["ref"].(map[string]any)
		unit["leader_attachment"] = map[string]any{
			"bodyguard_ref": refResolved(bodyguardID, bref["raw_name"]),
			"role":          "support",
			"provisional":   true,
		}
		diag.warn("leader-attachment-inferred", "Support character attached to an eligible bodyguard (it cannot operate alone); provisional.", ref["raw_name"])
	}
}

func asFloat(v any) float64 {
	f, _ := v.(float64)
	return f
}

func numEq(a, b any) bool {
	af, aok := a.(float64)
	bf, bok := b.(float64)
	if aok && bok {
		return af == bf
	}
	return a == b
}
