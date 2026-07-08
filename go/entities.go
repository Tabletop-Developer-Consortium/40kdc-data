package wh40kdc

// Linked views over the richly-connected entity types. Each wraps a raw record
// (a plain map[string]any) and resolves its relationships lazily against the
// owning Dataset; the full underlying record is always available via Raw.
//
// Go mirror of python .../data/entities.py. Buff-translation methods
// (profileBuffs, describeBuffs, getBuffs, describe) are added with the cruncher
// and translate ports (Phases 2-3).

// UnitView is a unit, linked to its faction, weapons, and abilities.
type UnitView struct {
	Raw map[string]any
	ds  *Dataset
}

func (u *UnitView) ID() string   { return getStr(u.Raw, "id") }
func (u *UnitView) Name() string { return getStr(u.Raw, "name") }

func (u *UnitView) Faction() (*FactionView, bool) {
	return u.ds.Factions.Get(getStr(u.Raw, "faction_id"))
}

func (u *UnitView) Weapons() []*WeaponView {
	// Resolve within the unit's own faction (a bare id shared across factions
	// resolves to the wielder's copy — issue #59), falling back to global
	// first-wins for a genuinely cross-faction id.
	faction := getStr(u.Raw, "faction_id")
	return resolveAll(getStrList(u.Raw, "weapon_ids"), func(id string) (*WeaponView, bool) {
		if w, ok := u.ds.Weapons.GetInFaction(id, faction); ok {
			return w, true
		}
		return u.ds.Weapons.Get(id)
	})
}

func (u *UnitView) Abilities() []*AbilityView {
	// Resolve within the unit's own faction first — an ability_id shared
	// across factions has per-faction copies that diverge. The fallback
	// catches the faction-less _core pool (and any id absent from this
	// faction's enrichment).
	faction := getStr(u.Raw, "faction_id")
	return resolveAll(getStrList(u.Raw, "ability_ids"), func(id string) (*AbilityView, bool) {
		if a, ok := u.ds.Abilities.GetInFaction(id, faction); ok {
			return a, true
		}
		return u.ds.Abilities.Get(id)
	})
}

func (u *UnitView) WargearOptions() []any {
	return u.ds.wargearOptionsOf(u.Raw)
}

// AbilityView is an ability, linked to the phases it acts in and units that
// have it.
type AbilityView struct {
	Raw map[string]any
	ds  *Dataset
}

func (a *AbilityView) ID() string   { return getStr(a.Raw, "ability_id") }
func (a *AbilityView) Name() string { return getStr(a.Raw, "name") }

func (a *AbilityView) Phases() []string {
	return a.ds.phasesFor("ability", getStr(a.Raw, "ability_id"))
}

func (a *AbilityView) Units() []*UnitView {
	return a.ds.unitsWithAbility(getStr(a.Raw, "ability_id"))
}

func (a *AbilityView) AppliesTo() map[string]any {
	m, _ := getMap(a.Raw, "applies_to")
	return m
}

// WeaponView is a weapon, linked to the units that carry it.
type WeaponView struct {
	Raw map[string]any
	ds  *Dataset
}

func (w *WeaponView) ID() string   { return getStr(w.Raw, "id") }
func (w *WeaponView) Name() string { return getStr(w.Raw, "name") }

func (w *WeaponView) Units() []*UnitView {
	return w.ds.unitsWithWeapon(getStr(w.Raw, "id"))
}

// profileAt returns the stat profile at index i (default 0); ok=false when out
// of range.
func (w *WeaponView) profileAt(i int) (map[string]any, bool) {
	profiles := getList(w.Raw, "profiles")
	if i < 0 || i >= len(profiles) {
		return nil, false
	}
	m, ok := asMap(profiles[i])
	return m, ok
}

// keywordsAt returns {keyword: *WeaponKeywordView, parameters: any} for each
// keyword referenced by profile i; unresolved ids are skipped.
func (w *WeaponView) keywordsAt(i int) []map[string]any {
	prof, ok := w.profileAt(i)
	if !ok {
		return nil
	}
	var out []map[string]any
	for _, ref := range getList(prof, "keywords") {
		rm, ok := asMap(ref)
		if !ok {
			continue
		}
		view, ok := w.ds.WeaponKeywords.Get(getStr(rm, "keyword_id"))
		if !ok {
			continue
		}
		out = append(out, map[string]any{"keyword": view, "parameters": rm["parameters"]})
	}
	return out
}

// WeaponKeywordView is a weapon-keyword catalog entry.
type WeaponKeywordView struct {
	Raw map[string]any
	ds  *Dataset
}

func (k *WeaponKeywordView) ID() string   { return getStr(k.Raw, "id") }
func (k *WeaponKeywordView) Name() string { return getStr(k.Raw, "name") }

func (k *WeaponKeywordView) Weapons() []*WeaponView {
	return k.ds.weaponsWithKeyword(getStr(k.Raw, "id"))
}

// FactionView is a faction, linked to its units and the records scoped to it.
type FactionView struct {
	Raw map[string]any
	ds  *Dataset
}

func (f *FactionView) ID() string   { return getStr(f.Raw, "id") }
func (f *FactionView) Name() string { return getStr(f.Raw, "name") }

// LogoURL returns the faction's logo/emblem image URL, or "" if unset.
func (f *FactionView) LogoURL() string { return getStr(f.Raw, "logo_url") }

func (f *FactionView) Units() []*UnitView {
	return f.ds.Units.ByFaction(getStr(f.Raw, "id"))
}

func (f *FactionView) Abilities() []*AbilityView {
	return f.ds.Abilities.ByFaction(getStr(f.Raw, "id"))
}

// Weapons returns distinct weapons carried by this faction's units.
func (f *FactionView) Weapons() []*WeaponView {
	seen := make(map[string]struct{})
	var out []*WeaponView
	for _, unit := range f.Units() {
		for _, weapon := range unit.Weapons() {
			id := weapon.ID()
			if _, dup := seen[id]; dup {
				continue
			}
			seen[id] = struct{}{}
			out = append(out, weapon)
		}
	}
	return out
}

// resolveAll resolves a list of ids, dropping any that don't resolve.
func resolveAll[V any](ids []string, get func(string) (V, bool)) []V {
	var out []V
	for _, id := range ids {
		if v, ok := get(id); ok {
			out = append(out, v)
		}
	}
	return out
}
