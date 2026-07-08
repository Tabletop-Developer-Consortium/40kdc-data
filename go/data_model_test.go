package wh40kdc

import "testing"

// A shared ability_id keeps one copy per faction (the copies legitimately
// diverge); only true within-faction duplicates collapse. Mirror of the
// TS/Rust/Python data-model tests.
func TestDeduplicatesAbilitiesByFactionAndID(t *testing.T) {
	ds := EmbeddedDataset()
	seen := map[string]struct{}{}
	idols := 0
	for _, a := range ds.Abilities.All() {
		key := getStr(a.Raw, "faction_id") + "::" + a.ID()
		if _, dup := seen[key]; dup {
			t.Fatalf("duplicate (faction_id, ability_id) pair %q in All()", key)
		}
		seen[key] = struct{}{}
		if a.ID() == "idol-of-blessed-blood" {
			idols++
		}
	}
	if idols != 2 {
		t.Fatalf("idol-of-blessed-blood copies = %d, want 2 (both factions survive dedupe)", idols)
	}
}

// idol-of-blessed-blood is authored in both world-eaters and
// chaos-space-marines (shared Khorne Lord of Skulls datasheet); each faction's
// unit must see its own faction's copy.
func TestResolvesSharedAbilityIDToUnitsOwnFactionsCopy(t *testing.T) {
	ds := EmbeddedDataset()
	for _, faction := range []string{"world-eaters", "chaos-space-marines"} {
		unit, ok := ds.Units.GetInFaction("khorne-lord-of-skulls", faction)
		if !ok {
			t.Fatalf("khorne-lord-of-skulls missing from %s", faction)
		}
		var idol *AbilityView
		for _, a := range unit.Abilities() {
			if a.ID() == "idol-of-blessed-blood" {
				idol = a
				break
			}
		}
		if idol == nil {
			t.Fatalf("idol-of-blessed-blood missing on %s lord of skulls", faction)
		}
		if got := getStr(idol.Raw, "faction_id"); got != faction {
			t.Fatalf("idol resolved to faction %q, want %q", got, faction)
		}
	}
}

// The shared _core pool stays faction-less; a bare Get still finds it.
func TestCorePoolAbilitiesResolveViaFallback(t *testing.T) {
	ds := EmbeddedDataset()
	if _, ok := ds.Abilities.Get("benefit-of-cover"); !ok {
		t.Fatal("benefit-of-cover (shared _core pool) not resolvable")
	}
}

// The tripwire that turns a silent wrong-faction lookup into a loud error:
// chaos-land-raider exists under several Chaos factions, so a faction-less
// Get would return the first-registered copy (wrong divergent fields).
func TestGetPanicsForSharedUnitIDWithoutFaction(t *testing.T) {
	ds := EmbeddedDataset()
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("Get on a shared unit id should panic")
		}
	}()
	ds.Units.Get("chaos-land-raider")
}

func TestGetAnyIsTheExplicitFirstWinsOptOut(t *testing.T) {
	ds := EmbeddedDataset()
	unit, ok := ds.Units.GetAny("chaos-land-raider")
	if !ok || unit.ID() != "chaos-land-raider" {
		t.Fatal("GetAny should resolve the shared id first-wins")
	}
}

func TestGetStillWorksForUnambiguousIDsOnGuardedCollection(t *testing.T) {
	ds := EmbeddedDataset()
	if _, ok := ds.Units.Get("kharn-the-betrayer"); !ok {
		t.Fatal("unambiguous id should resolve through Get")
	}
}

func TestGetPanicsForSharedDetachmentIDWithoutFaction(t *testing.T) {
	ds := EmbeddedDataset()
	// Find a chapter-replicated detachment id (appears under >1 faction).
	counts := map[string]int{}
	var shared string
	for _, dAny := range ds.Detachments.All() {
		id := getStr(dAny.(map[string]any), "id")
		counts[id]++
		if counts[id] > 1 {
			shared = id
			break
		}
	}
	if shared == "" {
		t.Fatal("expected at least one chapter-replicated detachment id")
	}
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("Get on a shared detachment id should panic")
		}
	}()
	ds.Detachments.Get(shared)
}

// lascannon exists under many factions with divergent stats; a faction-less
// Get would silently crunch the wrong faction's profile.
func TestGetPanicsForSharedWeaponIDWithoutFaction(t *testing.T) {
	ds := EmbeddedDataset()
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("Get on a shared weapon id should panic")
		}
	}()
	ds.Weapons.Get("lascannon")
}

func TestGetPanicsForSharedAbilityIDWithoutFaction(t *testing.T) {
	ds := EmbeddedDataset()
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("Get on a shared ability id should panic")
		}
	}()
	ds.Abilities.Get("idol-of-blessed-blood")
}
