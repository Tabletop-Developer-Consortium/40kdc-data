package wh40kdc

import "sort"

// handleLinkedQuery dispatches the Dataset read-path queries. Go mirror of
// python runner._handle_linked_query.
// handleCheckUnitLegality is the tier-aware whole-unit loadout legality op —
// mirror of the TS runner op. Returns sorted "code:id" strings.
func (s *RunnerState) handleCheckUnitLegality(args any) map[string]any {
	a, ok := asMap(args)
	if !ok {
		return errResp("INVALID_INPUT", detail("check_unit_legality args must be an object"))
	}
	unitID, ok := a["unitId"].(string)
	if !ok {
		return errResp("INVALID_INPUT", detail("check_unit_legality.unitId/modelCount required"))
	}
	mc, ok := a["modelCount"].(float64)
	if !ok {
		return errResp("INVALID_INPUT", detail("check_unit_legality.unitId/modelCount required"))
	}
	modelCount := int(mc)
	ds := s.dataset()
	var u *UnitView
	if fid, ok := a["factionId"].(string); ok {
		if uv, found := ds.Units.GetInFaction(unitID, fid); found {
			u = uv
		}
	} else if uv, found := ds.Units.GetAny(unitID); found {
		u = uv
	}
	if u == nil {
		return errResp("UNKNOWN_ENTITY", map[string]any{"kind": "unit", "id": unitID})
	}
	factionID := getStr(u.Raw, "faction_id")
	var models, tiers []any
	for _, cAny := range ds.UnitCompositions {
		c, _ := asMap(cAny)
		if getStr(c, "unit_id") == unitID && getStr(c, "faction_id") == factionID {
			models = getList(c, "models")
			tiers = getList(c, "tiers")
			break
		}
	}
	counts := map[string]int{}
	if cs, ok := asMap(a["counts"]); ok {
		for k, v := range cs {
			counts[k] = asInt(v)
		}
	}
	violations := checkUnitLegality(u.Raw, modelCount, ds.wargearOptionsOf(u.Raw), counts, models, tiers)
	strs := make([]string, 0, len(violations))
	for _, v := range violations {
		strs = append(strs, v["code"]+":"+v["id"])
	}
	sort.Strings(strs)
	return okResp(toAnyList(strs))
}

// handleCheckRosterLegality is the whole-army legality op — mirror of the TS
// runner op. Builds a normRoster from the compact spec, runs validateRosterCore,
// and returns the sorted union of per-unit loadout and army violations as
// "<scope>|<severity>|<code>:<id>" strings (scope army or u<index>).
func (s *RunnerState) handleCheckRosterLegality(args any) map[string]any {
	a, ok := asMap(args)
	if !ok {
		return errResp("INVALID_INPUT", detail("check_roster_legality args must be an object"))
	}
	unitsRaw, ok := a["units"].([]any)
	if !ok {
		return errResp("INVALID_INPUT", detail("check_roster_legality.units must be an array"))
	}
	spec := normRoster{
		factionID:  getStr(a, "factionId"),
		battleSize: getStr(a, "battleSize"),
	}
	if fd, ok := a["forceDisposition"].(string); ok {
		spec.forceDisposition = &fd
	}
	for _, dAny := range getList(a, "detachments") {
		d, _ := asMap(dAny)
		if id, ok := d["id"].(string); ok {
			spec.detachmentIDs = append(spec.detachmentIDs, id)
		}
	}
	for _, uAny := range unitsRaw {
		u, _ := asMap(uAny)
		nu := normUnit{
			unitID:     getStr(u, "unitId"),
			modelCount: asInt(u["modelCount"]),
			isWarlord:  u["isWarlord"] == true,
			counts:     map[string]int{},
		}
		if e, ok := u["enhancementId"].(string); ok {
			nu.enhancementID = e
		}
		if l, ok := u["leaderBodyguardId"].(string); ok {
			nu.leaderBodyguardID = l
		}
		if cs, ok := asMap(u["counts"]); ok {
			for k, v := range cs {
				nu.counts[k] = asInt(v)
			}
		}
		spec.units = append(spec.units, nu)
	}

	units, army := validateRosterCore(spec, s.dataset())
	lines := []string{}
	for _, ur := range units {
		for _, v := range ur.violations {
			lines = append(lines, "u"+itoa(ur.unitIndex)+"|error|"+v["code"]+":"+v["id"])
		}
	}
	for _, v := range army {
		scope := "army"
		if v.unitIndex >= 0 {
			scope = "u" + itoa(v.unitIndex)
		}
		lines = append(lines, scope+"|"+v.severity+"|"+v.code+":"+v.id)
	}
	sort.Strings(lines)
	return okResp(toAnyList(lines))
}

// handleCandidateAffordability is the cheapest-next-copy pricing + affordability
// op — mirror of the TS runner op. Returns [{unitId, nextCopyCost, affordable}]
// sorted ascending by (nextCopyCost, unitId).
func (s *RunnerState) handleCandidateAffordability(args any) map[string]any {
	a, ok := asMap(args)
	if !ok {
		return errResp("INVALID_INPUT", detail("candidate_affordability args must be an object"))
	}
	if _, ok := a["units"].([]any); !ok {
		return errResp("INVALID_INPUT", detail("candidate_affordability.units must be an array"))
	}
	spec := affordabilitySpec{
		factionID:  getStr(a, "factionId"),
		battleSize: getStr(a, "battleSize"),
	}
	if v, ok := a["pointsLimitOverride"].(float64); ok {
		n := int(v)
		spec.pointsLimitOverride = &n
	}
	for _, uAny := range getList(a, "units") {
		u, _ := asMap(uAny)
		au := affordabilityUnit{
			unitID:     getStr(u, "unitId"),
			modelCount: asInt(u["modelCount"]),
		}
		if e, ok := u["enhancementId"].(string); ok {
			au.enhancementID = e
		}
		spec.units = append(spec.units, au)
	}
	if ids, ok := a["candidateUnitIds"].([]any); ok {
		spec.candidateProvided = true
		for _, idAny := range ids {
			if id, ok := idAny.(string); ok {
				spec.candidateUnitIDs = append(spec.candidateUnitIDs, id)
			}
		}
	}

	result := candidateAffordability(spec, s.dataset())
	out := make([]any, len(result))
	for i, r := range result {
		out[i] = r
	}
	return okResp(out)
}

func (s *RunnerState) handleLinkedQuery(args any) map[string]any {
	a, ok := asMap(args)
	if !ok {
		return errResp("INVALID_INPUT", detail("linked_query args must be an object"))
	}
	query, ok := a["query"].(string)
	if !ok {
		return errResp("INVALID_INPUT", detail("linked_query.query must be a string"))
	}
	ds := s.dataset()
	in, _ := asMap(a["input"])
	if in == nil {
		in = map[string]any{}
	}
	unitID := getStr(in, "unitId")

	unknownUnit := func() map[string]any {
		return errResp("UNKNOWN_ENTITY", map[string]any{"kind": "unit", "id": in["unitId"]})
	}

	switch query {
	case "find_unit":
		if u, ok := ds.Units.Find(getStr(in, "query")); ok {
			return okResp(u.ID())
		}
		return okResp(nil)
	case "find_weapon":
		if w, ok := ds.Weapons.Find(getStr(in, "query")); ok {
			return okResp(w.ID())
		}
		return okResp(nil)
	case "find_faction":
		if f, ok := ds.Factions.Find(getStr(in, "query")); ok {
			return okResp(f.ID())
		}
		return okResp(nil)
	case "find_ability":
		if ab, ok := ds.Abilities.Find(getStr(in, "query")); ok {
			return okResp(ab.ID())
		}
		return okResp(nil)
	case "abilities_of":
		u, ok := ds.Units.GetAny(unitID)
		if !ok {
			return unknownUnit()
		}
		return okResp(idsOfAbilities(u.Abilities()))
	case "weapons_of":
		u, ok := ds.Units.GetAny(unitID)
		if !ok {
			return unknownUnit()
		}
		return okResp(idsOfWeapons(u.Weapons()))
	case "wargear_options_of":
		u, ok := ds.Units.GetAny(unitID)
		if !ok {
			return unknownUnit()
		}
		out := []any{}
		for _, o := range u.WargearOptions() {
			out = append(out, getStr(o.(map[string]any), "id"))
		}
		return okResp(out)
	case "base_loadout", "maximal_loadout":
		u, ok := ds.Units.GetAny(unitID)
		if !ok {
			return unknownUnit()
		}
		modelCount := asInt(in["modelCount"])
		var models []any
		for _, cAny := range ds.UnitCompositions {
			c, _ := asMap(cAny)
			if getStr(c, "unit_id") == unitID {
				models = getList(c, "models")
				break
			}
		}
		var lo map[string]int
		if query == "base_loadout" {
			lo = baseLoadout(u.Raw, modelCount, ds.wargearOptionsOf(u.Raw), models)
		} else {
			lo = maximalLoadout(u.Raw, modelCount, ds.wargearOptionsOf(u.Raw), models)
		}
		strs := make([]string, 0, len(lo))
		for id, n := range lo {
			strs = append(strs, id+":"+itoa(n))
		}
		sort.Strings(strs)
		return okResp(toAnyList(strs))
	case "phases_of":
		ab, ok := ds.Abilities.Get(getStr(in, "abilityId"))
		if !ok {
			return errResp("UNKNOWN_ENTITY", map[string]any{"kind": "ability", "id": in["abilityId"]})
		}
		return okResp(toAnyList(ab.Phases()))
	case "faction_of":
		u, ok := ds.Units.GetAny(unitID)
		if !ok {
			return unknownUnit()
		}
		if f, ok := u.Faction(); ok {
			return okResp(f.ID())
		}
		return okResp(nil)
	case "base_size_of":
		u, ok := ds.Units.GetAny(unitID)
		if !ok {
			return unknownUnit()
		}
		bs, _ := getMap(u.Raw, "base_size_mm")
		if enc, ok := encodeBase(bs); ok {
			return okResp(enc)
		}
		return okResp(nil)
	case "model_bases_of":
		if _, ok := ds.Units.GetAny(unitID); !ok {
			return unknownUnit()
		}
		var comp map[string]any
		for _, cAny := range ds.UnitCompositions {
			c, _ := asMap(cAny)
			if getStr(c, "unit_id") == unitID {
				comp = c
				break
			}
		}
		out := []any{}
		for _, mAny := range getList(comp, "models") {
			m, _ := asMap(mAny)
			bs, _ := getMap(m, "base_size_mm")
			enc, ok := encodeBase(bs)
			if !ok {
				enc = "none"
			}
			out = append(out, getStr(m, "name")+"="+enc)
		}
		return okResp(out)
	case "abilities_of_faction":
		return okResp(idsOfAbilities(ds.Abilities.ByFaction(getStr(in, "factionId"))))
	case "weapons_of_faction":
		f, ok := ds.Factions.Get(getStr(in, "factionId"))
		if !ok {
			return errResp("UNKNOWN_ENTITY", map[string]any{"kind": "faction", "id": in["factionId"]})
		}
		return okResp(idsOfWeapons(f.Weapons()))
	case "logo_url_of_faction":
		f, ok := ds.Factions.Get(getStr(in, "factionId"))
		if !ok {
			return errResp("UNKNOWN_ENTITY", map[string]any{"kind": "faction", "id": in["factionId"]})
		}
		if url, present := f.Raw["logo_url"].(string); present {
			return okResp(url)
		}
		return okResp(nil)
	case "units_with_keyword":
		out := []any{}
		for _, u := range ds.unitsWithKeyword(getStr(in, "keyword")) {
			out = append(out, u.ID())
		}
		return okResp(out)
	case "allies_for":
		detIDs := getStrList(in, "detachmentIds")
		out := []any{}
		for _, r := range ds.alliesFor(getStr(in, "factionId"), detIDs) {
			out = append(out, getStr(r.(map[string]any), "id"))
		}
		return okResp(out)
	case "ally_units_for":
		out := []any{}
		for _, u := range ds.allyUnitsFor(getStr(in, "ruleId")) {
			out = append(out, u.ID())
		}
		return okResp(out)
	case "reactive_trigger_ability_ids":
		ids := []string{}
		for _, rt := range ds.ReactiveTriggers() {
			ids = append(ids, rt.AbilityID)
		}
		sort.Strings(ids)
		return okResp(toAnyList(ids))
	case "events_with_triggers":
		seen := map[string]struct{}{}
		events := []string{}
		for _, rt := range ds.ReactiveTriggers() {
			if _, dup := seen[rt.Event]; dup {
				continue
			}
			seen[rt.Event] = struct{}{}
			events = append(events, rt.Event)
		}
		sort.Strings(events)
		return okResp(toAnyList(events))
	case "triggers_for_event":
		event := getStr(in, "event")
		ids := []string{}
		for _, rt := range ds.ReactiveTriggers() {
			if rt.Event == event {
				ids = append(ids, rt.AbilityID)
			}
		}
		sort.Strings(ids)
		return okResp(toAnyList(ids))
	default:
		return errResp("INVALID_INPUT", detail("unknown linked_query: "+query))
	}
}

func (s *RunnerState) handleMatchAppliesTo(args any) map[string]any {
	a, ok := asMap(args)
	if !ok {
		return errResp("INVALID_INPUT", detail("match_applies_to args must be an object"))
	}
	units := getList(a, "units")
	if units == nil {
		if _, isList := a["units"].([]any); !isList {
			return errResp("INVALID_INPUT", detail("match_applies_to.units must be an array"))
		}
	}
	appliesTo, _ := getMap(a, "applies_to")
	matched := []any{}
	for _, uAny := range units {
		u, _ := asMap(uAny)
		owned := append(getStrList(u, "keywords"), getStrList(u, "faction_keywords")...)
		if unitMatchesAppliesTo(appliesTo, owned) {
			matched = append(matched, getStr(u, "id"))
		}
	}
	return okResp(map[string]any{"matchedIds": matched})
}

func idsOfAbilities(xs []*AbilityView) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x.ID()
	}
	return out
}

func idsOfWeapons(xs []*WeaponView) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x.ID()
	}
	return out
}

func toAnyList(xs []string) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x
	}
	return out
}
