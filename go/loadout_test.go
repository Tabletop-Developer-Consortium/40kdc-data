package wh40kdc

import "testing"

// A lone plain single-target swap (base weapon → one replacement, max 1): a
// model takes one or the other, never both. Each id is independently in [0,1],
// so only the swap-conservation check catches keeping both. Uses a synthetic
// unit/options (data-independent) rather than a live unit, since dump-primary
// wargear data is regenerated per ingest. Mirror of the TS/Rust/Python tests.
func TestValidateLoadoutSwapConflict(t *testing.T) {
	unit := map[string]any{"weapon_ids": []any{"diabolus-heavy-stubber"}}
	opts := []any{
		map[string]any{
			"replaces":         []any{"diabolus-heavy-stubber"},
			"replacement":      []any{"havoc-multi-launcher"},
			"model_constraint": map[string]any{"max_count": float64(1)},
		},
	}

	both := map[string]int{"diabolus-heavy-stubber": 1, "havoc-multi-launcher": 1}
	v := validateLoadout(unit, 1, opts, both, nil)
	if len(v) != 1 || v[0]["id"] != "diabolus-heavy-stubber" || v[0]["code"] != "swap-conflict" {
		t.Fatalf("expected one swap-conflict on diabolus-heavy-stubber, got %v", v)
	}

	if got := validateLoadout(unit, 1, opts, map[string]int{"diabolus-heavy-stubber": 1}, nil); len(got) != 0 {
		t.Fatalf("keeping the stubber should be legal, got %v", got)
	}
	if got := validateLoadout(unit, 1, opts, map[string]int{"havoc-multi-launcher": 1}, nil); len(got) != 0 {
		t.Fatalf("swapping to the havoc launcher should be legal, got %v", got)
	}
}

// A 1-model unit with two slots that can each add "sword" (cf. the Knight
// Destrier): without the single-weapon flat-budget clamp the weapon sums to 2.
// The "max one" rule is modelled as a single-item per-unit budget, and
// maximalLoadout/weaponBounds must honour it. Mirror of the TS/Rust/Python tests.
func TestSingleWeaponFlatBudgetCaps(t *testing.T) {
	unit := map[string]any{
		"weapon_ids":      []any{"gun-a", "gun-b"},
		"wargear_budgets": []any{map[string]any{"items": []any{"sword"}, "count": float64(1), "per_models": float64(0)}},
	}
	opts := []any{
		map[string]any{"replaces": []any{"gun-a"}, "replacement": []any{"sword"}, "model_constraint": map[string]any{"any_number": true}},
		map[string]any{"replaces": []any{"gun-b"}, "replacement": []any{"sword"}, "model_constraint": map[string]any{"any_number": true}},
	}

	if b := weaponBounds(unit, 1, opts, nil)["sword"]; b.min != 0 || b.max != 1 {
		t.Fatalf("expected sword bound {0,1}, got {%d,%d}", b.min, b.max)
	}
	if got := maximalLoadout(unit, 1, opts, nil)["sword"]; got != 1 {
		t.Fatalf("expected maximal sword count 1, got %d", got)
	}
}
