package wh40kdc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
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

func rosterCaseDirs(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(corpusDir, "roster"))
	if os.IsNotExist(err) {
		t.Skip("conformance corpus not available")
	}
	if err != nil {
		t.Fatalf("read roster corpus: %v", err)
	}

	var caseDirs []string
	for _, entry := range entries {
		if entry.IsDir() {
			caseDirs = append(caseDirs, filepath.Join(corpusDir, "roster", entry.Name()))
		}
	}
	if len(caseDirs) == 0 {
		t.Skip("roster conformance corpus is empty")
	}
	return caseDirs
}

func rosterGolden(t *testing.T, caseDir string) map[string]any {
	t.Helper()
	path := filepath.Join(caseDir, "expected.roster.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("roster/%s: read roster golden: %v", filepath.Base(caseDir), err)
	}
	var roster map[string]any
	if err := json.Unmarshal(data, &roster); err != nil {
		t.Fatalf("roster/%s: parse roster golden: %v", filepath.Base(caseDir), err)
	}
	return roster
}

// expectedInputFormat names every corpus input convention backed by a Go
// adapter. A filename outside this list is not a Go importer target.
func expectedInputFormat(filename string) (string, bool) {
	switch filename {
	case "input.json":
		return "listforge", true
	case "input.rosterizer.json":
		return "rosterizer", true
	case "input.gw.txt":
		return "gw", true
	case "input.listforge-text.txt":
		return "listforge-text", true
	case "input.roster-json.json":
		return "roster-json", true
	}
	const prefix = "input.newrecruit-"
	if !strings.HasPrefix(filename, prefix) {
		return "", false
	}
	if !strings.HasSuffix(filename, ".json") && !strings.HasSuffix(filename, ".txt") {
		return "", false
	}
	format := strings.TrimSuffix(strings.TrimSuffix(filename, ".json"), ".txt")
	return strings.TrimPrefix(format, "input."), true
}

// TestRosterCorpusInputsImportToGoldens independently exercises every Go
// importer against every supported input in the shared corpus. The source and
// diagnostics fields are format-specific, so stable comparison excludes only
// those root fields.
func TestRosterCorpusInputsImportToGoldens(t *testing.T) {
	ds := EmbeddedDataset()
	for _, caseDir := range rosterCaseDirs(t) {
		caseDir := caseDir
		caseName := filepath.Base(caseDir)
		expected := rosterGolden(t, caseDir)
		entries, err := os.ReadDir(caseDir)
		if err != nil {
			t.Fatalf("roster/%s: read case directory: %v", caseName, err)
		}

		for _, entry := range entries {
			filename := entry.Name()
			format, supported := expectedInputFormat(filename)
			if !supported || entry.IsDir() {
				continue
			}
			t.Run("roster/"+caseName+"/"+filename, func(t *testing.T) {
				input, err := os.ReadFile(filepath.Join(caseDir, filename))
				if err != nil {
					t.Fatalf("read input: %v", err)
				}
				result := tryImportRoster(string(input), ds)
				if result["ok"] != true {
					t.Fatalf("expected import success, got %v: %v", result["reason"], result["message"])
				}
				if got := result["format"]; got != format {
					t.Fatalf("detected format = %v, want %q", got, format)
				}
				if got, want := canon(t, stripVolatile(result["roster"])), canon(t, stripVolatile(expected)); got != want {
					t.Fatalf("stable roster diverged from golden\n got: %s\nwant: %s", got, want)
				}
			})
		}
	}
}

// TestRosterCorpusDatasetFreeExportGoldens byte-compares every present golden
// for every registered Dataset-free serializer. Dataset-backed Yellowscribe
// remains covered by TestYellowscribeExportGoldens.
func TestRosterCorpusDatasetFreeExportGoldens(t *testing.T) {
	formats := make([]string, 0, len(exportSerializers))
	for format := range exportSerializers {
		formats = append(formats, format)
	}
	sort.Strings(formats)

	for _, caseDir := range rosterCaseDirs(t) {
		caseDir := caseDir
		caseName := filepath.Base(caseDir)
		roster := rosterGolden(t, caseDir)
		for _, format := range formats {
			format := format
			t.Run("roster/"+caseName+"/"+format, func(t *testing.T) {
				goldens, err := filepath.Glob(filepath.Join(caseDir, "expected."+format+".*"))
				if err != nil {
					t.Fatalf("discover export golden: %v", err)
				}
				if len(goldens) == 0 {
					t.Skipf("export format %q has no golden in this case", format)
				}
				if len(goldens) != 1 {
					t.Fatalf("expected one export golden, found %d: %v", len(goldens), goldens)
				}
				want, err := os.ReadFile(goldens[0])
				if err != nil {
					t.Fatalf("read export golden: %v", err)
				}
				got, err := exportRoster(roster, format)
				if err != nil {
					t.Fatalf("export failed: %v", err)
				}
				if got != string(want) {
					t.Fatalf("export diverged from %s\n--- got ---\n%s\n--- want ---\n%s", filepath.Base(goldens[0]), got, want)
				}
			})
		}
	}
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
