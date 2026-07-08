package wh40kdc

// AbilityView buff-translation methods + the Dataset buff-collection methods
// (eligible_abilities / buffs_for / defensive_buffs_for). Go mirror of the
// buff-translation halves of python .../data/entities.py and dataset.py.

// describeBuffs is the full DSL->Buff translation (applied/unsupported/
// activatable), with a range-scoped ability's scope.range_inches stamped onto
// every emitted buff as applicableWhen.maxRangeInches.
func (a *AbilityView) describeBuffs(source map[string]any, ctx map[string]any, perspective string) *effectTranslation {
	if ctx == nil {
		ctx = map[string]any{"phase": "shooting"}
	}
	translated := effectToBuffs(a.Raw["effect"], source, ctx, perspective)
	scope, _ := getMap(a.Raw, "scope")
	rngVal := scope["range_inches"]
	if !isNumber(rngVal) {
		return translated
	}
	rng, _ := num(rngVal)
	gate := func(bAny any) any {
		b, _ := asMap(bAny)
		nb := cloneMap(b)
		aw, _ := getMap(b, "applicableWhen")
		merged := cloneMap(aw)
		merged["maxRangeInches"] = rng
		nb["applicableWhen"] = merged
		return nb
	}
	out := &effectTranslation{unsupported: translated.unsupported}
	for _, b := range translated.applied {
		out.applied = append(out.applied, gate(b))
	}
	for _, actAny := range translated.activatable {
		act, _ := asMap(actAny)
		na := cloneMap(act)
		var gb []any
		for _, b := range getList(act, "buffs") {
			gb = append(gb, gate(b))
		}
		na["buffs"] = gb
		out.activatable = append(out.activatable, na)
	}
	if out.applied == nil {
		out.applied = []any{}
	}
	if out.activatable == nil {
		out.activatable = []any{}
	}
	return out
}

func (a *AbilityView) getBuffs(source map[string]any, ctx map[string]any, perspective string) []any {
	return a.describeBuffs(source, ctx, perspective).applied
}

func buffSourceFromEligible(entry map[string]any) map[string]any {
	ability := entry["ability"].(*AbilityView)
	source := entry["source"].(map[string]any)
	kind := getStr(source, "kind")
	if kind == "attached" {
		return map[string]any{"kind": "ability", "abilityId": ability.ID(), "abilityKind": "attached", "sourceUnitId": source["unitId"]}
	}
	abilityKind := kind
	if kind == "detachment-stratagem" {
		abilityKind = "detachment-stratagem"
	}
	return map[string]any{"kind": "ability", "abilityId": ability.ID(), "abilityKind": abilityKind}
}

func (ds *Dataset) eligibleAbilities(input map[string]any, phase string) []map[string]any {
	return resolveEligibleAbilities(ds, input, phase)
}

func (ds *Dataset) derivedContext(input, context map[string]any) map[string]any {
	ctx := cloneMap(context)
	if ctx["attackerAttached"] == nil {
		ctx["attackerAttached"] = len(getList(input, "attachedUnitIds")) > 0
	}
	return ctx
}

// weaponFaction is the faction to scope weaponProfiles lookups by: the
// explicit factionId when given, else the input unit's own faction.
func (ds *Dataset) weaponFaction(input map[string]any) string {
	if f := getStr(input, "factionId"); f != "" {
		return f
	}
	if unit, ok := ds.Units.GetAny(getStr(input, "unitId")); ok {
		return getStr(unit.Raw, "faction_id")
	}
	return ""
}

func (ds *Dataset) collectBuffs(input, context map[string]any, perspective string) []any {
	out := []any{}
	ctx := ds.derivedContext(input, context)
	if perspective == "attacker" {
		// Weapon ids are shared across factions with divergent stats — resolve
		// within the input unit's faction (GetAny fallback for cross-faction ids).
		weaponFaction := ds.weaponFaction(input)
		for _, refAny := range getList(input, "weaponProfiles") {
			ref, _ := asMap(refAny)
			weapon, ok := (*WeaponView)(nil), false
			if weaponFaction != "" {
				weapon, ok = ds.Weapons.GetInFaction(getStr(ref, "weaponId"), weaponFaction)
			}
			if !ok {
				weapon, ok = ds.Weapons.GetAny(getStr(ref, "weaponId"))
			}
			if !ok {
				continue
			}
			out = append(out, weapon.profileBuffs(asInt(ref["profileIndex"]), ctx)...)
		}
	}
	optedIn := map[string]struct{}{}
	for _, s := range getStrList(input, "optedInStratagemIds") {
		optedIn[s] = struct{}{}
	}
	for _, entry := range ds.eligibleAbilities(input, getStr(ctx, "phase")) {
		source := entry["source"].(map[string]any)
		if getStr(source, "kind") == "detachment-stratagem" {
			if _, ok := optedIn[getStr(source, "stratagemId")]; !ok {
				continue
			}
		}
		ability := entry["ability"].(*AbilityView)
		bs := buffSourceFromEligible(entry)
		out = append(out, ability.getBuffs(bs, ctx, perspective)...)
	}
	return out
}

func (ds *Dataset) buffsFor(input, context map[string]any) []any {
	return ds.collectBuffs(input, context, "attacker")
}

func (ds *Dataset) defensiveBuffsFor(input, context map[string]any) []any {
	return ds.collectBuffs(input, context, "target")
}
