package wh40kdc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// Go-native conformance suite. The cross-impl differ (tooling/parity) drives
// the runner for most areas; this file covers the two areas the differ does not
// (weapon-keywords and abilities-resolver are pinned per-language against the
// shared corpus), plus normalize as a quick self-check.

const corpusDir = "../conformance"

func loadCorpus(t *testing.T, parts ...string) []byte {
	t.Helper()
	p := filepath.Join(append([]string{corpusDir}, parts...)...)
	b, err := os.ReadFile(p)
	if err != nil {
		t.Skipf("conformance corpus not available: %v", err)
	}
	return b
}

func canon(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

func TestNormalizeCorpus(t *testing.T) {
	var cases []map[string]any
	if err := json.Unmarshal(loadCorpus(t, "normalize.json"), &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		in, _ := c["input"].(string)
		want, _ := c["expected"].(string)
		if got := NormalizeName(in); got != want {
			t.Errorf("NormalizeName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestWeaponKeywordsCorpus(t *testing.T) {
	var cases []map[string]any
	if err := json.Unmarshal(loadCorpus(t, "weapon-keywords", "cases.json"), &cases); err != nil {
		t.Fatal(err)
	}
	ds := EmbeddedDataset()
	for _, c := range cases {
		id, _ := c["keyword_id"].(string)
		view, ok := ds.WeaponKeywords.Get(id)
		if !ok {
			t.Errorf("keyword %q not in catalog", id)
			continue
		}
		if got, want := canon(t, view.Raw["effect"]), canon(t, c["expected_effect"]); got != want {
			t.Errorf("keyword %q effect = %s, want %s", id, got, want)
		}
		if c["expected_effect"] == nil && !engineDispatchKeywords[id] {
			t.Errorf("keyword %q has null effect but is not engine-dispatched", id)
		}
	}
}

func TestEligibleAbilitiesCorpus(t *testing.T) {
	matches, _ := filepath.Glob(filepath.Join(corpusDir, "abilities-resolver", "0*.json"))
	if len(matches) == 0 {
		t.Skip("conformance corpus not available")
	}
	ds := EmbeddedDataset()
	for _, file := range matches {
		b, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var c map[string]any
		if err := json.Unmarshal(b, &c); err != nil {
			t.Fatal(err)
		}
		input, _ := asMap(c["input"])
		phase, _ := c["phase"].(string)
		grouped := map[string][]string{}
		for _, entry := range resolveEligibleAbilities(ds, input, phase) {
			source := entry["source"].(map[string]any)
			ability := entry["ability"].(*AbilityView)
			kind := getStr(source, "kind")
			grouped[kind] = append(grouped[kind], ability.ID())
		}
		for _, ids := range grouped {
			sort.Strings(ids)
		}
		if got, want := canon(t, grouped), canon(t, c["expected"]); got != want {
			t.Errorf("%s eligible = %s, want %s", filepath.Base(file), got, want)
		}
	}
}

func runDSLCorpus(t *testing.T, filename string) {
	t.Helper()
	var dsl map[string]any
	if err := json.Unmarshal(loadCorpus(t, "abilities-resolver", filename), &dsl); err != nil {
		t.Fatal(err)
	}
	ds := EmbeddedDataset()
	for _, cAny := range getList(dsl, "cases") {
		c, _ := asMap(cAny)
		abilityID := getStr(c, "abilityId")
		ability, ok := ds.Abilities.GetAny(abilityID)
		if !ok {
			t.Errorf("unknown ability %q", abilityID)
			continue
		}
		source, _ := getMap(c, "source")
		ctx, _ := getMap(c, "context")
		perspective := strOr(c, "perspective", "attacker")
		result := effectToBuffs(ability.Raw["effect"], source, ctx, perspective)
		expected, _ := getMap(c, "expected")

		var appliedContribs []any
		for _, b := range result.applied {
			bm, _ := asMap(b)
			appliedContribs = append(appliedContribs, bm["contribution"])
		}
		if got, want := canon(t, orEmpty(appliedContribs)), canon(t, expected["applied"]); got != want {
			t.Errorf("%s (%s) applied = %s, want %s", abilityID, perspective, got, want)
		}

		var reasons []any
		for _, u := range result.unsupported {
			um, _ := asMap(u)
			reasons = append(reasons, um["reason"])
		}
		if got, want := canon(t, orEmpty(reasons)), canon(t, expected["unsupportedReasons"]); got != want {
			t.Errorf("%s (%s) unsupportedReasons = %s, want %s", abilityID, perspective, got, want)
		}

		if expected["activatable"] != nil {
			var acts []any
			for _, aAny := range result.activatable {
				a, _ := asMap(aAny)
				var buffs []any
				for _, b := range getList(a, "buffs") {
					bm, _ := asMap(b)
					buffs = append(buffs, bm["contribution"])
				}
				acts = append(acts, map[string]any{
					"id":    a["id"],
					"label": a["label"],
					"group": a["group"],
					"buffs": orEmpty(buffs),
				})
			}
			// Normalise expected entries so a missing "group" reads as null.
			var expActs []any
			for _, eAny := range getList(expected, "activatable") {
				e, _ := asMap(eAny)
				ne := cloneMap(e)
				if _, has := ne["group"]; !has {
					ne["group"] = nil
				}
				expActs = append(expActs, ne)
			}
			if got, want := canon(t, orEmpty(acts)), canon(t, orEmpty(expActs)); got != want {
				t.Errorf("%s (%s) activatable = %s, want %s", abilityID, perspective, got, want)
			}
		}
	}
}

func orEmpty(l []any) []any {
	if l == nil {
		return []any{}
	}
	return l
}

func TestFromDSLCorpus(t *testing.T)          { runDSLCorpus(t, "from-dsl.json") }
func TestDefensiveFromDSLCorpus(t *testing.T) { runDSLCorpus(t, "defensive-from-dsl.json") }
