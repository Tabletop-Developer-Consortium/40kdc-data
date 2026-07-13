package wh40kdc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The Dataset-backed yellowscribe serializer reproduces every
// conformance/roster/*/expected.yellowscribe.ros golden byte-for-byte. Ties out
// with the TS/Python oracles (which produced the goldens) — this is the Go half
// of the cross-impl verification for the format.
func TestYellowscribeExportGoldens(t *testing.T) {
	matches, _ := filepath.Glob(filepath.Join(corpusDir, "roster", "*", "expected.yellowscribe.ros"))
	if len(matches) == 0 {
		t.Skip("conformance corpus not available")
	}
	ds := EmbeddedDataset()
	for _, goldenPath := range matches {
		caseDir := filepath.Dir(goldenPath)
		caseName := filepath.Base(caseDir)

		rosterBytes, err := os.ReadFile(filepath.Join(caseDir, "expected.roster.json"))
		if err != nil {
			t.Fatalf("roster/%s: read roster golden: %v", caseName, err)
		}
		var roster map[string]any
		if err := json.Unmarshal(rosterBytes, &roster); err != nil {
			t.Fatalf("roster/%s: parse roster golden: %v", caseName, err)
		}
		golden, err := os.ReadFile(goldenPath)
		if err != nil {
			t.Fatalf("roster/%s: read yellowscribe golden: %v", caseName, err)
		}

		got, err := exportRosterWithDataset(roster, "yellowscribe", ds)
		if err != nil {
			t.Fatalf("roster/%s: yellowscribe export failed: %v", caseName, err)
		}
		if got != string(golden) {
			t.Errorf("roster/%s: yellowscribe export mismatch\n--- got ---\n%s\n--- want ---\n%s", caseName, got, string(golden))
		}
	}
}

// A Dataset-backed format with no dataset errors rather than emitting an empty
// roster (mirror of the TS/Python guard).
func TestYellowscribeRequiresDataset(t *testing.T) {
	_, err := exportRosterWithDataset(map[string]any{"units": []any{}}, "yellowscribe", nil)
	if err == nil {
		t.Fatal("expected error when yellowscribe is called without a dataset")
	}
}

// exportRosterWithDataset still serves the eight Dataset-free formats unchanged.
func TestExportWithDatasetDispatchesDatasetFreeFormats(t *testing.T) {
	roster := map[string]any{
		"name":         "Empty",
		"faction_id":   "world-eaters",
		"detachments":  []any{},
		"battle_size":  nil,
		"points":       map[string]any{},
		"units":        []any{},
		"game_version": map[string]any{},
	}
	withDS, err := exportRosterWithDataset(roster, "roster-json", nil)
	if err != nil {
		t.Fatalf("roster-json via exportRosterWithDataset failed: %v", err)
	}
	plain, err := exportRoster(roster, "roster-json")
	if err != nil {
		t.Fatalf("roster-json via exportRoster failed: %v", err)
	}
	if withDS != plain {
		t.Errorf("dataset-free dispatch diverged:\n%s\nvs\n%s", withDS, plain)
	}
}
