package wh40kdc

import (
	"strings"
	"testing"
)

func namedRegionEffect(keywords []any, operator string, defaultEffect map[string]any) map[string]any {
	if defaultEffect == nil {
		defaultEffect = map[string]any{
			"type":   "re-roll",
			"target": "attacker",
			"modifier": map[string]any{
				"roll":   "hit",
				"subset": "ones",
			},
		}
	}
	return map[string]any{
		"type":   "named-region-state",
		"target": "all-friendly",
		"modifier": map[string]any{
			"consumer": map[string]any{
				"beneficiary_gate": map[string]any{
					"operator": operator,
					"keywords": keywords,
				},
				"default_branch": map[string]any{"effect": defaultEffect},
				"qualified_branch": map[string]any{
					"effect": map[string]any{
						"type":   "re-roll",
						"target": "attacker",
						"modifier": map[string]any{
							"roll":         "hit",
							"result_scope": "any-result",
						},
					},
				},
			},
		},
	}
}

func namedRegionSource() map[string]any {
	return map[string]any{"kind": "ability", "abilityId": "named-region-test", "abilityKind": "unit"}
}

func TestNamedRegionMatchingOrAppliesDefault(t *testing.T) {
	out := effectToBuffs(
		namedRegionEffect([]any{"CRYPTEK", "CANOPTEK"}, "or", nil),
		namedRegionSource(),
		map[string]any{"phase": "shooting", "attackerKeywords": []any{"canoptek"}},
		"attacker",
	)
	if len(out.applied) != 1 {
		t.Fatalf("applied = %#v", out.applied)
	}
	if len(out.unsupported) != 1 || !strings.Contains(out.unsupported[0].(map[string]any)["reason"].(string), "qualified replacement") {
		t.Fatalf("unsupported = %#v", out.unsupported)
	}
}

func TestNamedRegionNonmatchingGateAppliesNeither(t *testing.T) {
	out := effectToBuffs(
		namedRegionEffect([]any{"CRYPTEK", "CANOPTEK"}, "or", nil),
		namedRegionSource(),
		map[string]any{"phase": "shooting", "attackerKeywords": []any{"WARRIOR"}},
		"attacker",
	)
	if len(out.applied) != 0 || len(out.unsupported) != 0 {
		t.Fatalf("translation = %#v", out)
	}
}

func TestNamedRegionQualifiedBranchIsUnsupported(t *testing.T) {
	out := effectToBuffs(
		namedRegionEffect([]any{"CRYPTEK"}, "or", nil),
		namedRegionSource(),
		map[string]any{"phase": "shooting", "attackerKeywords": []any{"CRYPTEK"}},
		"attacker",
	)
	found := false
	for _, raw := range out.unsupported {
		if strings.Contains(raw.(map[string]any)["reason"].(string), "qualified replacement") {
			found = true
		}
	}
	if !found {
		t.Fatalf("unsupported = %#v", out.unsupported)
	}
}

func TestNamedRegionWeaponKeywordNarrowingIsUnsupported(t *testing.T) {
	out := effectToBuffs(
		namedRegionEffect([]any{"THOUSAND SONS"}, "and", map[string]any{
			"type":   "re-roll",
			"target": "attacker",
			"modifier": map[string]any{
				"roll":           "wound",
				"subset":         "ones",
				"weapon_keyword": "Psychic",
			},
		}),
		namedRegionSource(),
		map[string]any{"phase": "shooting", "attackerKeywords": []any{"thousand sons"}},
		"attacker",
	)
	if len(out.applied) != 0 {
		t.Fatalf("applied = %#v", out.applied)
	}
	found := false
	for _, raw := range out.unsupported {
		if strings.Contains(raw.(map[string]any)["reason"].(string), `weapon_keyword" which the cruncher can't resolve here`) {
			found = true
		}
	}
	if !found {
		t.Fatalf("unsupported = %#v", out.unsupported)
	}
}
