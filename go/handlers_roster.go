package wh40kdc

import (
	"encoding/json"
	"strings"
)

// import / try_import / export op handlers. Go mirror of the roster handlers in
// python .../runner.py.

func jsonParse(s string) (any, error) {
	var v any
	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return jsonNumbersToFloat(v), nil
}

// jsonNumbersToFloat converts json.Number to float64 so the whole tree uses the
// same numeric type the rest of the port assumes.
func jsonNumbersToFloat(v any) any {
	switch x := v.(type) {
	case json.Number:
		f, _ := x.Float64()
		return f
	case map[string]any:
		for k, e := range x {
			x[k] = jsonNumbersToFloat(e)
		}
		return x
	case []any:
		for i, e := range x {
			x[i] = jsonNumbersToFloat(e)
		}
		return x
	}
	return v
}

func (s *RunnerState) handleImport(args any) map[string]any {
	a, ok := asMap(args)
	if !ok {
		return errResp("INVALID_INPUT", detail("import args must be an object"))
	}
	raw, ok := a["input"].(string)
	if !ok {
		return errResp("INVALID_INPUT", detail("import.input must be a string"))
	}
	trimmed := strings.TrimLeft(raw, " \t\r\n")
	var decoded any = raw
	if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
		if d, err := jsonParse(raw); err == nil {
			decoded = d
		}
	}
	roster, err := importRoster(decoded, s.dataset())
	if err != nil {
		return errResp("IMPORT_FAILED", map[string]any{"detail": err.Error(), "format": a["format"]})
	}
	return okResp(roster)
}

func (s *RunnerState) handleTryImport(args any) map[string]any {
	a, ok := asMap(args)
	if !ok {
		return errResp("INVALID_INPUT", detail("try_import args must be an object"))
	}
	input, ok := a["input"].(string)
	if !ok {
		return errResp("INVALID_INPUT", detail("try_import.input must be a string"))
	}
	result := tryImportRoster(input, s.dataset())
	if result["ok"] != true {
		return errResp("IMPORT_FAILED", map[string]any{"reason": result["reason"], "message": result["message"]})
	}
	return okResp(map[string]any{"format": result["format"], "roster": result["roster"]})
}

func (s *RunnerState) handleExport(args any) map[string]any {
	a, ok := asMap(args)
	if !ok {
		return errResp("INVALID_INPUT", detail("export args must be an object"))
	}
	format, ok := a["format"].(string)
	if !ok || !isExportFormat(format) {
		return errResp("INVALID_INPUT", detail("unknown export format: "+format))
	}
	roster, ok := getMap(a, "roster")
	if !ok {
		return errResp("INVALID_INPUT", detail("export.roster must be an object"))
	}
	out, err := exportRosterWithDataset(roster, format, s.dataset())
	if err != nil {
		return errResp("EXPORT_FAILED", detail(err.Error()))
	}
	return okResp(out)
}
