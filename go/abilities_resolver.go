package wh40kdc

// Walks the dataset for every ability that could apply to a chosen unit in a
// chosen phase. Go mirror of python .../abilities_resolver.py. Entries are
// map[string]any{"ability": *AbilityView, "source": map, "phases": []string}.

func (ds *Dataset) resolveUnitScoped(id, fid string) (*UnitView, bool) {
	if fid != "" {
		if scoped, ok := ds.Units.GetInFaction(id, fid); ok {
			return scoped, true
		}
	}
	return ds.Units.Get(id)
}

func resolveEligibleAbilities(ds *Dataset, input map[string]any, phase string) []map[string]any {
	unit, ok := ds.resolveUnitScoped(getStr(input, "unitId"), getStr(input, "factionId"))
	if !ok {
		return nil
	}
	factionID := getStr(input, "factionId")
	if factionID == "" {
		factionID = getStr(unit.Raw, "faction_id")
	}
	seen := map[string]struct{}{}
	var out []map[string]any

	pushUnique := func(entry map[string]any) {
		source := entry["source"].(map[string]any)
		ability := entry["ability"].(*AbilityView)
		key := getStr(source, "kind") + "::" + ability.ID()
		if _, dup := seen[key]; dup {
			return
		}
		seen[key] = struct{}{}
		out = append(out, entry)
	}

	phaseMatches := func(ability *AbilityView) bool {
		phases := ability.Phases()
		return len(phases) == 0 || contains(phases, phase)
	}
	intersect := func(phases []string) []string {
		if contains(phases, phase) {
			return []string{phase}
		}
		return phases
	}

	// 1. Army.
	for _, ability := range ds.Abilities.ByFaction(factionID) {
		if getStr(ability.Raw, "ability_type") != "faction" || !phaseMatches(ability) {
			continue
		}
		pushUnique(map[string]any{"ability": ability, "source": map[string]any{"kind": "army"}, "phases": intersect(ability.Phases())})
	}

	detachmentID := getStr(input, "detachmentId")
	if detachmentID != "" {
		// 2. Detachment abilities.
		for _, ability := range ds.Abilities.All() {
			if getStr(ability.Raw, "ability_type") != "detachment" {
				continue
			}
			if getStr(ability.Raw, "detachment_id") != detachmentID || !phaseMatches(ability) {
				continue
			}
			pushUnique(map[string]any{"ability": ability, "source": map[string]any{"kind": "detachment", "detachmentId": detachmentID}, "phases": intersect(ability.Phases())})
		}
		// 3. Detachment stratagems.
		if detAny, ok := ds.Detachments.Get(detachmentID); ok {
			det := detAny.(map[string]any)
			for _, stratID := range getStrList(det, "stratagem_ids") {
				stratAny, ok := ds.Stratagems.Get(stratID)
				if !ok {
					continue
				}
				stratagem := stratAny.(map[string]any)
				stratPhases := getStrList(stratagem, "phases")
				if len(stratPhases) == 0 || !contains(stratPhases, phase) {
					continue
				}
				abilityID, ok := stratagem["ability_id"].(string)
				if !ok {
					continue
				}
				// Stratagem ability ids are detachment-qualified but the
				// ability copies are still replicated per faction (SM
				// chapters) — prefer the resolving faction's copy, falling
				// back for shared pools.
				stratAbility, ok := ds.Abilities.GetInFaction(abilityID, factionID)
				if !ok {
					stratAbility, ok = ds.Abilities.Get(abilityID)
				}
				if !ok {
					continue
				}
				pushUnique(map[string]any{
					"ability": stratAbility,
					"source": map[string]any{
						"kind": "detachment-stratagem", "stratagemId": getStr(stratagem, "id"),
						"cpCost": stratagem["cp_cost"],
					},
					"phases": []string{phase},
				})
			}
		}
	}

	// 4. Unit's own abilities.
	for _, ability := range unit.Abilities() {
		if !phaseMatches(ability) {
			continue
		}
		pushUnique(map[string]any{"ability": ability, "source": map[string]any{"kind": "unit", "unitId": getStr(input, "unitId")}, "phases": intersect(ability.Phases())})
	}

	// 5. Attached members.
	for _, memberID := range getStrList(input, "attachedUnitIds") {
		member, ok := ds.resolveUnitScoped(memberID, factionID)
		if !ok {
			continue
		}
		for _, ability := range member.Abilities() {
			if !phaseMatches(ability) {
				continue
			}
			pushUnique(map[string]any{"ability": ability, "source": map[string]any{"kind": "attached", "unitId": memberID}, "phases": intersect(ability.Phases())})
		}
	}

	// 6. Supporting units — aura-scoped only.
	for _, supportID := range getStrList(input, "supportingUnitIds") {
		supporter, ok := ds.resolveUnitScoped(supportID, factionID)
		if !ok {
			continue
		}
		for _, ability := range supporter.Abilities() {
			if !phaseMatches(ability) {
				continue
			}
			scope, _ := getMap(ability.Raw, "scope")
			if !isAuraScope(scope["range"]) {
				continue
			}
			pushUnique(map[string]any{"ability": ability, "source": map[string]any{"kind": "support", "sourceUnitId": supportID}, "phases": intersect(ability.Phases())})
		}
	}
	return out
}

func isAuraScope(rng any) bool {
	s, ok := rng.(string)
	if !ok {
		return false
	}
	return len(s) >= 5 && s[:5] == "aura-" || s == "any-on-battlefield" || s == "any-visible"
}
