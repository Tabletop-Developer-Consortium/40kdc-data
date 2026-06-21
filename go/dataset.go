package wh40kdc

import "sort"

// Dataset ties the embedded records together: it owns every Collection, builds
// the cross-entity indexes once, and is the hub the linked views resolve
// against. Go mirror of python .../data/dataset.py.
type Dataset struct {
	// Richly-linked collections.
	Units          *Collection[*UnitView]
	Weapons        *Collection[*WeaponView]
	WeaponKeywords *Collection[*WeaponKeywordView]
	Factions       *Collection[*FactionView]
	Abilities      *Collection[*AbilityView]

	// Id-bearing collections without bespoke views (records returned as-is).
	TargetProfiles     *Collection[any]
	Detachments        *Collection[any]
	AlliedRules        *Collection[any]
	Enhancements       *Collection[any]
	Stratagems         *Collection[any]
	WargearOptions     *Collection[any]
	Wargear            *Collection[any]
	Missions           *Collection[any]
	MissionMatchups    *Collection[any]
	MissionCards       *Collection[any]
	DeploymentPatterns *Collection[any]
	ForceDispositions  *Collection[any]
	TerrainTemplates   *Collection[any]
	TerrainLayouts     *Collection[any]
	HullShapes         *Collection[any]
	ResourcePools      *Collection[any]
	UnitKeywords       *Collection[any]

	// Id-less collections, exposed as plain lists.
	LeaderAttachments []any
	UnitCompositions  []any
	GameVersions      []any
	InteractionFlags  []any
	PhaseMappings     []any

	// Indexes.
	phaseIndex           map[string][]string
	unitsByAbility       map[string][]any
	unitsByWeapon        map[string][]any
	weaponsByKeyword     map[string][]any
	unitsByKeyword       map[string][]any
	wargearOptionsByUnit map[string][]any
}

func factionIDOf(i any) string { return getStr(i.(map[string]any), "faction_id") }

// EmbeddedDataset builds the dataset from the package's embedded data.
func EmbeddedDataset() *Dataset { return NewDataset(embeddedRawData()) }

// NewDataset builds a Dataset from raw collection data.
func NewDataset(raw rawData) *Dataset {
	ds := &Dataset{}

	ds.Units = newCollection(raw["units"], func(i any) *UnitView {
		return &UnitView{Raw: i.(map[string]any), ds: ds}
	}, collectionOpts{
		idOf: func(i any) string { return getStr(i.(map[string]any), "id") },
		// Same unit id is shared across factions; keep each faction's copy,
		// collapse only true within-faction duplicates.
		dedupeKeyOf: func(i any) string {
			m := i.(map[string]any)
			return getStr(m, "faction_id") + "::" + getStr(m, "id")
		},
		nameOf:    func(i any) string { return getStr(i.(map[string]any), "name") },
		factionOf: factionIDOf,
	})
	ds.Weapons = newCollection(raw["weapons"], func(i any) *WeaponView {
		return &WeaponView{Raw: i.(map[string]any), ds: ds}
	}, collectionOpts{
		idOf:   func(i any) string { return getStr(i.(map[string]any), "id") },
		nameOf: func(i any) string { return getStr(i.(map[string]any), "name") },
	})
	ds.WeaponKeywords = newCollection(raw["weapon_keywords"], func(i any) *WeaponKeywordView {
		return &WeaponKeywordView{Raw: i.(map[string]any), ds: ds}
	}, collectionOpts{
		idOf:   func(i any) string { return getStr(i.(map[string]any), "id") },
		nameOf: func(i any) string { return getStr(i.(map[string]any), "name") },
	})
	ds.Factions = newCollection(raw["factions"], func(i any) *FactionView {
		return &FactionView{Raw: i.(map[string]any), ds: ds}
	}, collectionOpts{
		idOf:   func(i any) string { return getStr(i.(map[string]any), "id") },
		nameOf: func(i any) string { return getStr(i.(map[string]any), "name") },
	})
	ds.Abilities = newCollection(raw["abilities"], func(i any) *AbilityView {
		return &AbilityView{Raw: i.(map[string]any), ds: ds}
	}, collectionOpts{
		idOf:      func(i any) string { return getStr(i.(map[string]any), "ability_id") },
		nameOf:    func(i any) string { return getStr(i.(map[string]any), "name") },
		factionOf: factionIDOf,
	})

	ds.TargetProfiles = idCollection(raw["target_profiles"], factionIDOf)
	ds.Detachments = newCollection(raw["detachments"], func(i any) any { return i }, collectionOpts{
		idOf:   func(i any) string { return getStr(i.(map[string]any), "id") },
		nameOf: func(i any) string { return getStr(i.(map[string]any), "name") },
		dedupeKeyOf: func(i any) string {
			m := i.(map[string]any)
			return getStr(m, "faction_id") + "::" + getStr(m, "id")
		},
		factionOf: factionIDOf,
	})
	ds.AlliedRules = idCollection(raw["allied_rules"], nil)
	ds.Enhancements = idCollection(raw["enhancements"], nil)
	ds.Stratagems = idCollection(raw["stratagems"], nil)
	ds.WargearOptions = idCollection(raw["wargear_options"], nil)
	ds.Wargear = idCollection(raw["wargear"], nil)
	ds.Missions = idCollection(raw["missions"], nil)
	ds.MissionMatchups = idCollection(raw["mission_matchups"], nil)
	ds.MissionCards = idCollection(raw["mission_cards"], nil)
	ds.DeploymentPatterns = idCollection(raw["deployment_patterns"], nil)
	ds.ForceDispositions = idCollection(raw["force_dispositions"], nil)
	ds.TerrainTemplates = idCollection(raw["terrain_templates"], nil)
	ds.TerrainLayouts = idCollection(raw["terrain_layouts"], nil)
	ds.HullShapes = idCollection(raw["hull_shapes"], nil)
	ds.ResourcePools = idCollection(raw["resource_pools"], nil)
	ds.UnitKeywords = idCollection(raw["unit_keywords"], nil)

	ds.LeaderAttachments = raw["leader_attachments"]
	ds.UnitCompositions = raw["unit_compositions"]
	ds.GameVersions = raw["game_versions"]
	ds.InteractionFlags = raw["interaction_flags"]
	ds.PhaseMappings = raw["phase_mappings"]

	ds.phaseIndex = map[string][]string{}
	ds.unitsByAbility = map[string][]any{}
	ds.unitsByWeapon = map[string][]any{}
	ds.weaponsByKeyword = map[string][]any{}
	ds.unitsByKeyword = map[string][]any{}
	ds.wargearOptionsByUnit = map[string][]any{}
	ds.buildIndexes(raw)
	return ds
}

// phasesFor returns the phases a source acts in, unioned across its
// phase-mappings.
func (ds *Dataset) phasesFor(sourceType, sourceID string) []string {
	return ds.phaseIndex[sourceType+":"+sourceID]
}

func (ds *Dataset) unitsWithAbility(abilityID string) []*UnitView {
	return wrapUnits(ds, ds.unitsByAbility[abilityID])
}

func (ds *Dataset) unitsWithWeapon(weaponID string) []*UnitView {
	return wrapUnits(ds, ds.unitsByWeapon[weaponID])
}

func (ds *Dataset) weaponsWithKeyword(keywordID string) []*WeaponView {
	items := ds.weaponsByKeyword[keywordID]
	out := make([]*WeaponView, len(items))
	for i, w := range items {
		out[i] = &WeaponView{Raw: w.(map[string]any), ds: ds}
	}
	return out
}

// unitsWithKeyword returns units carrying the given keyword (case-insensitive),
// matched against the union of keywords + faction_keywords.
func (ds *Dataset) unitsWithKeyword(keyword string) []*UnitView {
	return wrapUnits(ds, ds.unitsByKeyword[lower(keyword)])
}

// wargearOptionsOf returns wargear options authored for the unit, declared
// order preserved.
func (ds *Dataset) wargearOptionsOf(unit map[string]any) []any {
	return ds.wargearOptionsByUnit[getStr(unit, "id")]
}

// unitCompositionOf returns the (models, tiers) of the unit's faction-scoped
// composition — keyed by (faction_id, unit_id) so a shared chassis resolves the
// right faction's composition. Both are nil when the unit has no composition.
// Mirror of TS Dataset.unitCompositionOf.
func (ds *Dataset) unitCompositionOf(unit map[string]any) (models, tiers []any) {
	fid := getStr(unit, "faction_id")
	uid := getStr(unit, "id")
	for _, cAny := range ds.UnitCompositions {
		c, _ := asMap(cAny)
		if getStr(c, "unit_id") == uid && getStr(c, "faction_id") == fid {
			return getList(c, "models"), getList(c, "tiers")
		}
	}
	return nil, nil
}

// alliesFor returns allied-rules offered for an army of factionID running the
// given detachments.
func (ds *Dataset) alliesFor(factionID string, detachmentIDs []string) []any {
	faction, ok := ds.Factions.Get(factionID)
	if !ok {
		return nil
	}
	factionKeywords := map[string]struct{}{}
	for _, k := range getStrList(faction.Raw, "keywords") {
		factionKeywords[lower(k)] = struct{}{}
	}
	detachmentSet := map[string]struct{}{}
	for _, d := range detachmentIDs {
		detachmentSet[d] = struct{}{}
	}
	var out []any
	for _, ruleAny := range ds.AlliedRules.All() {
		rule := ruleAny.(map[string]any)
		armyAny := getStrList(rule, "army_keywords_any")
		armyGate := len(armyAny) == 0
		for _, k := range armyAny {
			if _, has := factionKeywords[lower(k)]; has {
				armyGate = true
				break
			}
		}
		det := rule["detachment_id"]
		detachmentGate := det == nil
		if ds, ok := det.(string); ok {
			if _, has := detachmentSet[ds]; has {
				detachmentGate = true
			}
		}
		if armyGate && detachmentGate {
			out = append(out, rule)
		}
	}
	return out
}

// allyUnitsFor returns the unit pool an allied-rule grants, sorted by name.
func (ds *Dataset) allyUnitsFor(ruleID string) []*UnitView {
	ruleAny, ok := ds.AlliedRules.Get(ruleID)
	if !ok {
		return nil
	}
	rule := ruleAny.(map[string]any)
	sourceFaction := getStr(rule, "source_faction_id")
	var base []any
	if sourceFaction != "" {
		for _, v := range ds.Units.ByFaction(sourceFaction) {
			base = append(base, v.Raw)
		}
	} else {
		for _, v := range ds.Units.All() {
			base = append(base, v.Raw)
		}
	}
	sourceKeywords := lowerAll(getStrList(rule, "source_keywords"))
	required := lowerAll(getStrList(rule, "required_keywords"))
	excluded := lowerAll(getStrList(rule, "excluded_keywords"))
	roles := map[string]struct{}{}
	for _, r := range getStrList(rule, "roles") {
		roles[r] = struct{}{}
	}
	matches := func(unit map[string]any) bool {
		have := map[string]struct{}{}
		for _, k := range append(getStrList(unit, "keywords"), getStrList(unit, "faction_keywords")...) {
			have[lower(k)] = struct{}{}
		}
		if len(sourceKeywords) > 0 && !anyIn(have, sourceKeywords) {
			return false
		}
		if len(required) > 0 && !allIn(have, required) {
			return false
		}
		if anyIn(have, excluded) {
			return false
		}
		if len(roles) > 0 {
			if _, has := roles[getStr(unit, "role")]; !has {
				return false
			}
		}
		return true
	}
	var pool []map[string]any
	for _, u := range base {
		um := u.(map[string]any)
		if matches(um) {
			pool = append(pool, um)
		}
	}
	sort.SliceStable(pool, func(i, j int) bool {
		return getStr(pool[i], "name") < getStr(pool[j], "name")
	})
	out := make([]*UnitView, len(pool))
	for i, u := range pool {
		out[i] = &UnitView{Raw: u, ds: ds}
	}
	return out
}

// ReactiveTrigger is an ability's reactive trigger block plus the units that
// list it. Go mirror of the TS ReactiveTrigger shape.
type ReactiveTrigger struct {
	AbilityID string
	Event     string
	UnitIDs   []string
	Trigger   map[string]any
}

// ReactiveTriggers returns every ability whose `trigger` is non-null, sorted
// ascending by AbilityID. UnitIDs are the ids of units listing the ability
// (reverse index), sorted ascending (empty for faction/detachment-rule
// abilities). Go mirror of TS Dataset.reactiveTriggers.
func (ds *Dataset) ReactiveTriggers() []ReactiveTrigger {
	var out []ReactiveTrigger
	for _, ability := range ds.Abilities.All() {
		trigger, ok := getMap(ability.Raw, "trigger")
		if !ok || trigger == nil {
			continue
		}
		abilityID := ability.ID()
		unitIDs := []string{}
		for _, unitAny := range ds.unitsByAbility[abilityID] {
			unit, _ := asMap(unitAny)
			unitIDs = append(unitIDs, getStr(unit, "id"))
		}
		sort.Strings(unitIDs)
		out = append(out, ReactiveTrigger{
			AbilityID: abilityID,
			Event:     getStr(trigger, "event"),
			UnitIDs:   unitIDs,
			Trigger:   trigger,
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].AbilityID < out[j].AbilityID
	})
	return out
}

// TriggerIndex maps each trigger event to its ReactiveTriggers (buckets stay
// ability-id-sorted via ReactiveTriggers's ordering). Callers sort the event
// keys when deterministic iteration is needed. Go mirror of TS
// Dataset.triggerIndex.
func (ds *Dataset) TriggerIndex() map[string][]ReactiveTrigger {
	index := map[string][]ReactiveTrigger{}
	for _, rt := range ds.ReactiveTriggers() {
		index[rt.Event] = append(index[rt.Event], rt)
	}
	return index
}

func (ds *Dataset) buildIndexes(raw rawData) {
	for _, pmAny := range raw["phase_mappings"] {
		pm := pmAny.(map[string]any)
		key := getStr(pm, "source_type") + ":" + getStr(pm, "source_id")
		existing := ds.phaseIndex[key]
		for _, ph := range getStrList(pm, "phases") {
			if !contains(existing, ph) {
				existing = append(existing, ph)
			}
		}
		ds.phaseIndex[key] = existing
	}
	for _, unitAny := range raw["units"] {
		unit := unitAny.(map[string]any)
		for _, abilityID := range getStrList(unit, "ability_ids") {
			ds.unitsByAbility[abilityID] = append(ds.unitsByAbility[abilityID], unit)
		}
		for _, weaponID := range getStrList(unit, "weapon_ids") {
			ds.unitsByWeapon[weaponID] = append(ds.unitsByWeapon[weaponID], unit)
		}
		seenKw := map[string]struct{}{}
		for _, kw := range append(getStrList(unit, "keywords"), getStrList(unit, "faction_keywords")...) {
			key := lower(kw)
			if _, dup := seenKw[key]; dup {
				continue
			}
			seenKw[key] = struct{}{}
			ds.unitsByKeyword[key] = append(ds.unitsByKeyword[key], unit)
		}
	}
	for _, optAny := range raw["wargear_options"] {
		opt := optAny.(map[string]any)
		uid := getStr(opt, "unit_id")
		ds.wargearOptionsByUnit[uid] = append(ds.wargearOptionsByUnit[uid], opt)
	}
	seenByKeyword := map[string]map[string]struct{}{}
	for _, weaponAny := range raw["weapons"] {
		weapon := weaponAny.(map[string]any)
		wid := getStr(weapon, "id")
		for _, profAny := range getList(weapon, "profiles") {
			prof, _ := asMap(profAny)
			for _, refAny := range getList(prof, "keywords") {
				ref, _ := asMap(refAny)
				kid := getStr(ref, "keyword_id")
				seen := seenByKeyword[kid]
				if seen == nil {
					seen = map[string]struct{}{}
					seenByKeyword[kid] = seen
				}
				if _, dup := seen[wid]; dup {
					continue
				}
				seen[wid] = struct{}{}
				ds.weaponsByKeyword[kid] = append(ds.weaponsByKeyword[kid], weapon)
			}
		}
	}
}

func wrapUnits(ds *Dataset, items []any) []*UnitView {
	out := make([]*UnitView, len(items))
	for i, u := range items {
		out[i] = &UnitView{Raw: u.(map[string]any), ds: ds}
	}
	return out
}
