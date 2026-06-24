package wh40kdc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Strip the format-only fields the round-trip reshapes, mirroring the `stable`
// helper in the TS/Python conformance suites.
func stripVolatile(v any) any {
	m, ok := v.(map[string]any)
	if !ok {
		return v
	}
	out := map[string]any{}
	for k, val := range m {
		if k == "source" || k == "diagnostics" {
			continue
		}
		out[k] = val
	}
	return out
}

// Every roster case's expected.roster-json.json export golden re-imports
// through tryImportRoster (the adapter path, not the canonical passthrough) and
// lands on the roster golden, source/diagnostics excluded. Ties out with the
// TS/Rust/Python `roster_json_goldens_reimport_to_roster_goldens`; in particular
// it pins that an explicit leader→bodyguard attachment survives the round-trip.
func TestRosterJSONGoldensReimportToRosterGoldens(t *testing.T) {
	matches, _ := filepath.Glob(filepath.Join(corpusDir, "roster", "*", "expected.roster-json.json"))
	if len(matches) == 0 {
		t.Skip("conformance corpus not available")
	}
	ds := EmbeddedDataset()
	for _, goldenPath := range matches {
		caseDir := filepath.Dir(goldenPath)
		caseName := filepath.Base(caseDir)

		goldenText, err := os.ReadFile(goldenPath)
		if err != nil {
			t.Fatalf("roster/%s: read roster-json golden: %v", caseName, err)
		}
		result := tryImportRoster(string(goldenText), ds)
		if result["ok"] != true {
			t.Fatalf("roster/%s: roster-json golden failed to import: %v %v", caseName, result["reason"], result["message"])
		}
		if result["format"] != "roster-json" {
			t.Fatalf("roster/%s: mis-detected as %v", caseName, result["format"])
		}

		expectedBytes, err := os.ReadFile(filepath.Join(caseDir, "expected.roster.json"))
		if err != nil {
			t.Fatalf("roster/%s: read roster golden: %v", caseName, err)
		}
		var expected any
		if err := json.Unmarshal(expectedBytes, &expected); err != nil {
			t.Fatalf("roster/%s: parse roster golden: %v", caseName, err)
		}

		got := canon(t, stripVolatile(result["roster"]))
		want := canon(t, stripVolatile(expected))
		if got != want {
			t.Fatalf("roster/%s: reimported roster diverged from golden\n got: %s\nwant: %s", caseName, got, want)
		}
	}
}
