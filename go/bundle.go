package wh40kdc

import (
	"embed"
	"encoding/json"
	"sync"
)

// bundle.json is a byte-for-byte copy of the Rust crate's
// bundle.generated.json (snake_case collection keys, every collection
// pre-seeded, data files visited in sorted path order). Array order within each
// collection is load-bearing — the set-semantics linked-api conformance queries
// compare against the shared bundler's iteration order — so nothing here may
// re-sort or re-key the data. Regenerate via codegen/sync.sh.
//
//go:embed bundle.json
var bundleJSON []byte

//go:embed share_registry.json
var shareRegistryJSON []byte

// schemasFS holds the canonical JSON Schema tree (copy of repo-root schemas/),
// embedded for the validator's $id-keyed cross-file $ref resolution.
//
//go:embed schemas
var schemasFS embed.FS

// rawData is the decoded embedded dataset, parsed once per process.
type rawData map[string][]any

var (
	rawDataOnce  sync.Once
	rawDataValue rawData
)

// collectionKeys are the collections present in the bundle (and seeded empty in
// emptyRawData).
var collectionKeys = []string{
	"units", "target_profiles", "weapons", "weapon_keywords", "factions",
	"abilities", "phase_mappings", "detachments", "allied_rules", "stratagems",
	"enhancements", "leader_attachments", "unit_compositions", "wargear_options",
	"wargear", "game_versions", "missions", "mission_matchups", "mission_cards",
	"deployment_patterns", "force_dispositions", "terrain_templates",
	"terrain_layouts", "hull_shapes", "resource_pools",
	"interaction_flags",
}

func emptyRawData() rawData {
	rd := make(rawData, len(collectionKeys))
	for _, k := range collectionKeys {
		rd[k] = []any{}
	}
	return rd
}

// embeddedRawData returns the parsed embedded dataset (cached).
func embeddedRawData() rawData {
	rawDataOnce.Do(func() {
		var parsed map[string]json.RawMessage
		if err := json.Unmarshal(bundleJSON, &parsed); err != nil {
			panic("wh40kdc: cannot parse embedded bundle.json: " + err.Error())
		}
		rd := emptyRawData()
		for k, raw := range parsed {
			var arr []any
			if err := json.Unmarshal(raw, &arr); err != nil {
				panic("wh40kdc: cannot parse bundle collection " + k + ": " + err.Error())
			}
			rd[k] = arr
		}
		rawDataValue = rd
	})
	return rawDataValue
}
