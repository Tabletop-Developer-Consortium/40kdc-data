package wh40kdc

import (
	"errors"
	"strings"
)

// Army-list importer dispatch: decode -> parse -> resolve. Go mirror of
// python .../imports/__init__.py.

// adapters in match-priority order.
var importAdapters = []formatAdapter{
	// roster-json runs first: its matcher is the most specific (the canonical
	// source.format + game_version + diagnostics envelope), so a 40kdc-native
	// export is never mis-detected by a looser matcher.
	rosterJSONAdapter,
	rosterizerAdapter,
	newrecruitJSONAdapter,
	gwAdapter,
	newrecruitWtcFullAdapter,
	newrecruitWtcCompactAdapter,
	newrecruitSimpleAdapter,
	listforgeTextAdapter,
	listforgeAdapter,
}

func isCanonicalRoster(decoded any) bool {
	d, ok := decoded.(map[string]any)
	if !ok {
		return false
	}
	source, ok := d["source"].(map[string]any)
	if !ok {
		return false
	}
	if _, ok := source["format"].(string); !ok {
		return false
	}
	if _, ok := d["units"].([]any); !ok {
		return false
	}
	_, hasDiag := d["diagnostics"]
	return hasDiag
}

func selectAdapter(decoded any) (formatAdapter, bool) {
	for _, a := range importAdapters {
		if a.matches(decoded) {
			return a, true
		}
	}
	return formatAdapter{}, false
}

func importRoster(decoded any, ds *Dataset) (map[string]any, error) {
	if isCanonicalRoster(decoded) {
		return decoded.(map[string]any), nil
	}
	adapter, ok := selectAdapter(decoded)
	if !ok {
		return nil, errors.New("no registered import adapter recognises this payload")
	}
	parsed, err := adapter.parse(decoded)
	if err != nil {
		return nil, err
	}
	return resolveRoster(parsed, ds, adapter.id), nil
}

func looksLikeListforgeEncoded(input string) bool {
	if strings.Contains(input, "/listforge/") {
		return true
	}
	if urlRe.MatchString(input) {
		return true
	}
	return strings.HasPrefix(input, "H4sIA")
}

// tryImportRoster auto-detects and imports any supported format. Never errors;
// returns a discriminated result map.
func tryImportRoster(input string, ds *Dataset) map[string]any {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return map[string]any{"ok": false, "reason": "empty-input", "message": "input is empty", "trials": []any{}}
	}
	var decoded any
	if looksLikeListforgeEncoded(trimmed) {
		d, err := decodeListforge(trimmed)
		if err != nil {
			return map[string]any{
				"ok": false, "reason": "decode-failed",
				"message": "failed to decode ListForge payload: " + err.Error(),
				"trials":  []any{map[string]any{"id": "listforge", "matched": false, "reason": err.Error()}},
			}
		}
		decoded = d
	} else if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
		d, err := jsonParse(trimmed)
		if err != nil {
			return map[string]any{"ok": false, "reason": "decode-failed", "message": "input looks like JSON but failed to parse: " + err.Error(), "trials": []any{}}
		}
		decoded = d
	} else {
		decoded = input
	}

	trials := []any{}
	for _, adapter := range importAdapters {
		if !adapter.matches(decoded) {
			trials = append(trials, map[string]any{"id": adapter.id, "matched": false})
			continue
		}
		parsed, err := adapter.parse(decoded)
		if err != nil {
			trials = append(trials, map[string]any{"id": adapter.id, "matched": true, "reason": err.Error()})
			return map[string]any{"ok": false, "reason": "parse-failed", "message": adapter.id + ": " + err.Error(), "trials": trials}
		}
		roster := resolveRoster(parsed, ds, adapter.id)
		return map[string]any{"ok": true, "roster": roster, "format": adapter.id}
	}
	return map[string]any{"ok": false, "reason": "no-adapter-matched", "message": "tried formats, none recognised the input", "trials": trials}
}
