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
