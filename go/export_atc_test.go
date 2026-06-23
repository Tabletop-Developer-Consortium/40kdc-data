package wh40kdc

// ATC LEADER/SUPPORT wording. No conformance roster carries an inferred
// attachment (every golden shows "—"), so the populated line is pinned here
// against hand-built rosters, mirroring the TS/Python/Rust unit tests.

import (
	"encoding/json"
	"strings"
	"testing"
)

// atcRoster wraps a units JSON array into a complete roster and returns the
// "+ LEADER/SUPPORT:" line of its atc-2026-compact export.
func atcLeaderSupportLine(t *testing.T, unitsJSON string) string {
	t.Helper()
	rosterJSON := `{
		"name": "Test List",
		"source": {"format": "roster-json", "generated_by": null},
		"faction_id": "adeptus-astartes",
		"detachments": [{"ref": {"id": "gladius-task-force", "raw_name": "Gladius Task Force", "resolved": true, "candidates": []}, "dp_cost": null}],
		"battle_size": null,
		"force_disposition": null,
		"points": {"declared_limit": 2000, "detachment_cap": null, "total_reported": 500, "total_computed": 500},
		"units": ` + unitsJSON + `,
		"game_version": {"edition": "10", "dataslate": "test"},
		"diagnostics": {"resolved_units": 0, "unresolved_units": 0, "resolved_weapons": 0, "unresolved_weapons": 0, "warnings": []}
	}`
	var roster map[string]any
	if err := json.Unmarshal([]byte(rosterJSON), &roster); err != nil {
		t.Fatalf("bad roster json: %v", err)
	}
	out, err := exportRoster(roster, "atc-2026-compact")
	if err != nil {
		t.Fatalf("export failed: %v", err)
	}
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "+ LEADER/SUPPORT:") {
			return line
		}
	}
	t.Fatalf("no LEADER/SUPPORT line in:\n%s", out)
	return ""
}

func unitJSON(id, name string, warlord bool, attach string) string {
	la := "null"
	if attach != "" {
		la = attach
	}
	w := "false"
	if warlord {
		w = "true"
	}
	return `{"ref": {"id": "` + id + `", "raw_name": "` + name + `", "resolved": true, "candidates": []},
		"model_count": 1, "points": 100, "is_warlord": ` + w + `, "enhancement": null,
		"enhancement_points": null, "wargear": [], "leader_attachment": ` + la + `}`
}

func attachJSON(bgID, bgName, role string, provisional bool) string {
	p := "false"
	if provisional {
		p = "true"
	}
	return `{"bodyguard_ref": {"id": "` + bgID + `", "raw_name": "` + bgName + `", "resolved": true, "candidates": []},
		"role": "` + role + `", "provisional": ` + p + `}`
}

func TestAtcLeaderRendersLeading(t *testing.T) {
	units := "[" +
		unitJSON("captain", "Captain", true, attachJSON("assault-intercessor-squad", "Assault Squad", "leader", false)) + "," +
		unitJSON("assault-intercessor-squad", "Assault Squad", false, "") +
		"]"
	got := atcLeaderSupportLine(t, units)
	want := "+ LEADER/SUPPORT: Captain leading Assault Squad"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestAtcSupportRendersSupportedBy(t *testing.T) {
	units := "[" +
		unitJSON("master-of-executions", "Master of Executions", false, attachJSON("chaos-terminator-squad", "Chaos Terminators", "support", true)) + "," +
		unitJSON("chaos-terminator-squad", "Chaos Terminators", false, "") +
		"]"
	got := atcLeaderSupportLine(t, units)
	want := "+ LEADER/SUPPORT: Chaos Terminators supported by Master of Executions"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestAtcLeaderAndSupportCompound(t *testing.T) {
	units := "[" +
		unitJSON("slaughterbound", "Slaughterbound", true, attachJSON("eightbound", "Eightbound", "leader", false)) + "," +
		unitJSON("support-char", "Support Char", false, attachJSON("eightbound", "Eightbound", "support", true)) + "," +
		unitJSON("eightbound", "Eightbound", false, "") +
		"]"
	got := atcLeaderSupportLine(t, units)
	want := "+ LEADER/SUPPORT: Slaughterbound leading Eightbound, supported by Support Char"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}
