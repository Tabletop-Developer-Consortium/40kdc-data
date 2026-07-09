package wh40kdc

// Whole-army roster legality: the per-unit loadout check (loadout.go) layered
// with the nine army-construction dimensions. Go mirror of
// tools/src/data/roster-resolve.ts (validateRosterCore / NormRoster).

// normUnit is one unit in the normalised roster the core checker consumes.
// Empty-string enhancementID / leaderBodyguardID means "null".
type normUnit struct {
	unitID            string
	modelCount        int
	isWarlord         bool
	enhancementID     string
	leaderBodyguardID string
	counts            map[string]int
}

// normRoster is the compact roster spec shared by the runner op. factionID and
// battleSize are "" for null; forceDisposition is nil for null (distinct from
// the empty string, which is a picked-but-blank disposition).
type normRoster struct {
	factionID        string
	battleSize       string
	forceDisposition *string
	detachmentIDs    []string
	units            []normUnit
}

// unitLoadoutResult is the per-unit loadout verdict (the building block layered
// under the army checks). Carries the resolved unit's index and its violations.
type unitLoadoutResult struct {
	unitIndex  int
	violations []map[string]string
}

// rosterViolation is one army-level legality violation. unitIndex is -1 for an
// army-wide violation; severity is "error" or "warn".
type rosterViolation struct {
	code      string
	id        string
	unitIndex int
	severity  string
}

// validateRosterCore runs the per-unit loadout check on every resolved unit,
// then the nine army-construction dimensions. Returns the per-unit loadout
// results (resolved units, in source order) and the army violations (unsorted;
// the runner op assembles + sorts the final lines). Mirror of the TS reference.
func validateRosterCore(spec normRoster, ds *Dataset) ([]unitLoadoutResult, []rosterViolation) {
	var army []rosterViolation
	push := func(severity, code, id string, unitIndex int) {
		army = append(army, rosterViolation{code: code, id: id, unitIndex: unitIndex, severity: severity})
	}
	errV := func(code, id string, unitIndex int) { push("error", code, id, unitIndex) }

	resolveUnit := func(unitID string) *UnitView {
		if unitID == "" {
			return nil
		}
		if spec.factionID != "" {
			if uv, ok := ds.Units.GetInFaction(unitID, spec.factionID); ok {
				return uv
			}
		}
		if uv, ok := ds.Units.GetAny(unitID); ok {
			return uv
		}
		return nil
	}
	keywordSet := func(view *UnitView) map[string]struct{} {
		s := map[string]struct{}{}
		for _, k := range getStrList(view.Raw, "keywords") {
			s[k] = struct{}{}
		}
		for _, k := range getStrList(view.Raw, "faction_keywords") {
			s[k] = struct{}{}
		}
		return s
	}
	isCharacter := func(view *UnitView) bool {
		r := getStr(view.Raw, "role")
		if r == "character" || r == "epic-hero" {
			return true
		}
		return contains(getStrList(view.Raw, "keywords"), "Character")
	}

	views := make([]*UnitView, len(spec.units))
	for i, u := range spec.units {
		views[i] = resolveUnit(u.unitID)
	}

	// --- Per-unit loadout (reuse the tier/bounds checker). --------------------
	var units []unitLoadoutResult
	for idx, su := range spec.units {
		view := views[idx]
		if view == nil {
			continue
		}
		models, tiers := ds.unitCompositionOf(view.Raw)
		units = append(units, unitLoadoutResult{
			unitIndex:  idx,
			violations: checkUnitLegality(view.Raw, su.modelCount, ds.wargearOptionsOf(view.Raw), su.counts, models, tiers),
		})
	}

	// Resolved detachments (drop ids absent from the dataset); primary = first.
	var detachments []map[string]any
	// Shared detachment ids (Codex chapters) resolve within the roster's
	// faction; fall back first-wins when the spec names no faction.
	for _, id := range spec.detachmentIDs {
		d, ok := any(nil), false
		if spec.factionID != "" {
			d, ok = ds.Detachments.GetInFaction(id, spec.factionID)
		}
		if !ok {
			d, ok = ds.Detachments.GetAny(id)
		}
		if ok {
			detachments = append(detachments, d.(map[string]any))
		}
	}
	var primary map[string]any
	if len(detachments) > 0 {
		primary = detachments[0]
	}

	// --- Enhancements: per-unit eligibility + army-wide uniqueness. -----------
	enhUses := map[string]int{}
	for idx, su := range spec.units {
		if su.enhancementID == "" {
			continue
		}
		enhUses[su.enhancementID]++
		eAny, eok := ds.Enhancements.Get(su.enhancementID)
		view := views[idx]
		if !eok || view == nil {
			continue
		}
		enh := eAny.(map[string]any)
		enhID := getStr(enh, "id")
		if !contains(spec.detachmentIDs, getStr(enh, "detachment_id")) {
			errV("enhancement-wrong-detachment", enhID, idx)
		}
		if !isCharacter(view) && enh["upgrade_tag"] != true {
			errV("enhancement-on-non-character", enhID, idx)
		}
		kws := keywordSet(view)
		for _, k := range getStrList(enh, "keyword_restrictions") {
			if _, has := kws[k]; !has {
				errV("enhancement-keyword-mismatch", enhID, idx)
				break
			}
		}
		for _, k := range getStrList(enh, "exclusion_keywords") {
			if _, has := kws[k]; has {
				errV("enhancement-excluded-keyword", enhID, idx)
				break
			}
		}
	}
	for enhID, uses := range enhUses {
		maxTargets := 1
		if eAny, ok := ds.Enhancements.Get(enhID); ok {
			if mt, has := eAny.(map[string]any)["max_targets"]; has && mt != nil {
				maxTargets = asInt(mt)
			}
		}
		if uses > maxTargets {
			errV("enhancement-over-max-targets", enhID, -1)
		}
	}

	// --- Leader attachment. ----------------------------------------------------
	for idx, su := range spec.units {
		view := views[idx]
		if view == nil {
			continue
		}
		if su.leaderBodyguardID != "" {
			eligible := bodyguardEligibleIDs(ds, view.ID())
			if _, ok := eligible[su.leaderBodyguardID]; !ok {
				errV("leader-attachment-illegal", view.ID(), idx)
			}
		} else if getStr(view.Raw, "attachment_role") == "support" {
			errV("leader-must-attach", view.ID(), idx)
		}
	}

	// --- Points total (ordinal-aware) + enhancement costs. --------------------
	ordinals := map[string]int{}
	total := 0
	for idx, su := range spec.units {
		view := views[idx]
		if view == nil {
			continue
		}
		ord := ordinals[su.unitID] + 1
		ordinals[su.unitID] = ord
		total += baseUnitPoints(view.Raw, su.modelCount, ord)
		total += wargearPoints(view.Raw, su.counts)
		if su.enhancementID != "" {
			if eAny, ok := ds.Enhancements.Get(su.enhancementID); ok {
				total += asInt(eAny.(map[string]any)["cost"])
			}
		}
	}
	if limit, ok := pointsLimitForBattleSize(spec.battleSize); ok && total > limit {
		errV("points-over-limit", "roster", -1)
	}

	// --- Detachment-point budget. ---------------------------------------------
	cap, capOk := detachmentCapForBattleSize(spec.battleSize)
	dpUsed := 0
	for _, d := range detachments {
		dpUsed += asInt(d["detachment_points"])
	}
	if capOk && dpUsed > cap {
		errV("detachment-points-over", "roster", -1)
	}

	// --- Force disposition (advisory / warn). ---------------------------------
	if spec.forceDisposition == nil {
		push("warn", "disposition-not-picked", "roster", -1)
	} else if primary != nil {
		// `primary?.force_dispositions` truthy in TS: the key is present and not
		// null (an empty array still triggers the membership check).
		if fd, ok := primary["force_dispositions"]; ok && fd != nil {
			if !contains(toStrList(fd), *spec.forceDisposition) {
				push("warn", "disposition-invalid", *spec.forceDisposition, -1)
			}
		}
	}

	// --- Detachment tag uniqueness (one per shared tag). ----------------------
	tagCounts := map[string]int{}
	for _, d := range detachments {
		for _, t := range getStrList(d, "tags") {
			tagCounts[t]++
		}
	}
	for tag, n := range tagCounts {
		if n > 1 {
			errV("detachment-tag-conflict", tag, -1)
		}
	}

	// --- Detachment restrictions (required/excluded army keywords, per unit). -
	for _, d := range detachments {
		r, ok := getMap(d, "restrictions")
		if !ok {
			continue
		}
		required := getStrList(r, "required_keywords")
		excluded := getStrList(r, "excluded_keywords")
		for idx := range spec.units {
			view := views[idx]
			if view == nil {
				continue
			}
			kws := keywordSet(view)
			for _, k := range required {
				if _, has := kws[k]; !has {
					errV("detachment-restriction-required", view.ID(), idx)
					break
				}
			}
			for _, k := range excluded {
				if _, has := kws[k]; has {
					errV("detachment-restriction-excluded", view.ID(), idx)
					break
				}
			}
		}
	}

	// --- Faction exclusions (a generic unit barred from this army's chapter). --
	// The shared Space Marine pool can't drop a generic datasheet for one chapter,
	// so a removed-without-replacement unit (e.g. Librarians for Black Templars)
	// carries excluded_faction_keywords; it is illegal when the army's faction
	// keywords intersect that list. Mirror of TS unit-excluded-from-faction.
	if spec.factionID != "" {
		factionKeywords := map[string]struct{}{}
		if fac, ok := ds.Factions.Get(spec.factionID); ok {
			for _, k := range getStrList(fac.Raw, "keywords") {
				factionKeywords[k] = struct{}{}
			}
		}
		if len(factionKeywords) > 0 {
			for idx := range spec.units {
				view := views[idx]
				if view == nil {
					continue
				}
				for _, k := range getStrList(view.Raw, "excluded_faction_keywords") {
					if _, has := factionKeywords[k]; has {
						errV("unit-excluded-from-faction", view.ID(), idx)
						break
					}
				}
			}
		}
	}

	// --- Warlord present (exactly one). ---------------------------------------
	warlords := 0
	for _, su := range spec.units {
		if su.isWarlord {
			warlords++
		}
	}
	if warlords == 0 {
		errV("no-warlord", "roster", -1)
	} else if warlords > 1 {
		errV("multiple-warlords", "roster", -1)
	}

	// --- Unit minimums (e.g. Houndpack: 3+ WAR DOG units). --------------------
	for _, d := range detachments {
		for _, umAny := range getList(d, "unit_minimums") {
			um, _ := asMap(umAny)
			keyword := getStr(um, "keyword")
			minN := asInt(um["min"])
			count := 0
			for _, v := range views {
				if v == nil {
					continue
				}
				if _, has := keywordSet(v)[keyword]; has {
					count++
				}
			}
			if count < minN {
				errV("unit-minimum-unmet", keyword, -1)
			}
		}
	}

	return units, army
}

// bodyguardEligibleIDs is the set of body-unit ids the given leader can attach
// to — its leader-attachment `eligible_bodyguard_ids` that resolve to a known
// unit. Mirror of Dataset.bodyguardsAttachableFrom (membership only).
func bodyguardEligibleIDs(ds *Dataset, leaderUnitID string) map[string]struct{} {
	out := map[string]struct{}{}
	for _, laAny := range ds.LeaderAttachments {
		la, _ := asMap(laAny)
		if getStr(la, "leader_id") != leaderUnitID {
			continue
		}
		for _, bid := range getStrList(la, "eligible_bodyguard_ids") {
			// Faction-agnostic attachment data — GetAny.
			if _, ok := ds.Units.GetAny(bid); ok {
				out[bid] = struct{}{}
			}
		}
	}
	return out
}
