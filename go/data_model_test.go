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

// Core rule 19.04 — a rule affecting a single specified model only ever applies
// to that model, even while part of an attached unit. Mirror of the TS
// `defensive-buffs.test.ts` / Python `test_data_model.py` blocks; pinned
// cross-impl by conformance/abilities-resolver/{from-dsl,defensive-from-dsl}.json.

const modelScopedReasonTest = "model-scoped effect from an attached model: applies to that model only (core rule 19.04)"

// contribTypesFrom projects the contributions a named ability put on the stack.
func contribTypesFrom(buffs []any, abilityID string) []map[string]any {
	var out []map[string]any
	for _, bAny := range buffs {
		b, _ := asMap(bAny)
		source, _ := getMap(b, "source")
		if getStr(source, "abilityId") != abilityID {
			continue
		}
		contribution, _ := getMap(b, "contribution")
		out = append(out, contribution)
	}
	return out
}

func TestLeaderPersonalInvulnDoesNotBuffBodyguardUnit(t *testing.T) {
	ds := EmbeddedDataset()
	// Shadowfield reads "the bearer has a 4+ invulnerable save" — one model out
	// of eleven, so it is not the Kabalite squad's invulnerable save.
	attached := ds.defensiveBuffsFor(map[string]any{
		"unitId":          "kabalite-warriors",
		"factionId":       "drukhari",
		"attachedUnitIds": []any{"archon"},
	}, map[string]any{"phase": "shooting"})
	if got := contribTypesFrom(attached, "shadowfield"); len(got) != 0 {
		t.Errorf("shadowfield buffs on the bodyguard unit = %v, want none", got)
	}

	// The Archon crunched as itself still keeps it (source kind "unit").
	own := ds.defensiveBuffsFor(
		map[string]any{"unitId": "archon", "factionId": "drukhari"},
		map[string]any{"phase": "shooting"},
	)
	got := contribTypesFrom(own, "shadowfield")
	if len(got) != 1 || getStr(got[0], "type") != "invulnerable-save" || asInt(got[0]["threshold"]) != 4 {
		t.Errorf("shadowfield buffs on the Archon itself = %v, want one 4+ invulnerable-save", got)
	}
}

func TestUnitScopedLeaderRuleStillBuffsAttachedUnit(t *testing.T) {
	ds := EmbeddedDataset()
	// Mental Fortress reads "models in that unit have a 4+ invulnerable save" —
	// authored `target: "unit"`, so the model-scope gate must not touch it.
	attached := ds.defensiveBuffsFor(map[string]any{
		"unitId":          "intercessor-squad",
		"factionId":       "adeptus-astartes",
		"attachedUnitIds": []any{"librarian"},
	}, map[string]any{"phase": "fight"})
	got := contribTypesFrom(attached, "mental-fortress-psychic")
	if len(got) != 1 || asInt(got[0]["threshold"]) != 4 {
		t.Errorf("mental-fortress-psychic buffs = %v, want one 4+ invulnerable-save", got)
	}
}

func TestDroppedModelScopedEffectIsReportedUnsupported(t *testing.T) {
	ds := EmbeddedDataset()
	ability, ok := ds.Abilities.GetAny("shadowfield")
	if !ok {
		t.Fatal("shadowfield missing from the embedded dataset")
	}
	result := effectToBuffs(
		ability.Raw["effect"],
		map[string]any{
			"kind":         "ability",
			"abilityId":    "shadowfield",
			"abilityKind":  "attached",
			"sourceUnitId": "archon",
		},
		map[string]any{"phase": "shooting"},
		"target",
	)
	if len(result.applied) != 0 {
		t.Errorf("applied = %v, want none", result.applied)
	}
	if len(result.unsupported) != 1 {
		t.Fatalf("unsupported = %v, want exactly one diagnostic", result.unsupported)
	}
	u, _ := asMap(result.unsupported[0])
	if getStr(u, "reason") != modelScopedReasonTest {
		t.Errorf("reason = %q, want %q", getStr(u, "reason"), modelScopedReasonTest)
	}
}

func TestModelScopeGateIsAttackerSideTooAndSparesUnitScopedGrants(t *testing.T) {
	ds := EmbeddedDataset()
	keywords := func(buffs []any, abilityID string) []string {
		var out []string
		for _, c := range contribTypesFrom(buffs, abilityID) {
			if getStr(c, "type") != "extra-keyword" {
				continue
			}
			ref, _ := getMap(c, "keywordRef")
			out = append(out, getStr(ref, "keyword_id"))
		}
		return out
	}

	// Psychic Gifts reads "the bearer has the Psyker keyword" — model-scoped.
	led := ds.buffsFor(map[string]any{
		"unitId":          "inquisitorial-agents",
		"factionId":       "agents-of-the-imperium",
		"attachedUnitIds": []any{"inquisitor"},
	}, map[string]any{"phase": "command"})
	if got := keywords(led, "psychic-gifts"); len(got) != 0 {
		t.Errorf("psychic-gifts keywords on the led unit = %v, want none", got)
	}
	alone := ds.buffsFor(
		map[string]any{"unitId": "inquisitor", "factionId": "agents-of-the-imperium"},
		map[string]any{"phase": "command"},
	)
	if got := keywords(alone, "psychic-gifts"); len(got) != 1 || got[0] != "psyker" {
		t.Errorf("psychic-gifts keywords on the Inquisitor itself = %v, want [psyker]", got)
	}

	// Surgical Precision is unit-scoped, so an attached Apothecary Biologis
	// still grants [LETHAL HITS] to the squad it joined.
	aggressors := ds.buffsFor(map[string]any{
		"unitId":          "aggressor-squad",
		"factionId":       "adeptus-astartes",
		"attachedUnitIds": []any{"apothecary-biologis"},
	}, map[string]any{"phase": "shooting"})
	if got := keywords(aggressors, "surgical-precision"); len(got) != 1 || got[0] != "lethal-hits" {
		t.Errorf("surgical-precision keywords = %v, want [lethal-hits]", got)
	}
}
