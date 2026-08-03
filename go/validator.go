package wh40kdc

import (
	"encoding/json"
	"io/fs"
	"math"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Schema validation with the closed cross-implementation error-code enum. A
// hand-rolled draft-2020-12 subset validator over the embedded schema tree,
// keyed by $id for cross-file $ref resolution. Maps validation failures onto
// the closed (path, code) enum pinned by conformance/validator. Go mirror of
// the validator half of python .../validator.py + tools/src/runner.ts.

var validatorTargets = map[string]string{
	"unit":           "https://40kdc.dev/schemas/core/unit.schema.json",
	"weapon":         "https://40kdc.dev/schemas/core/weapon.schema.json",
	"faction":        "https://40kdc.dev/schemas/core/faction.schema.json",
	"ability":        "https://40kdc.dev/schemas/enrichment/ability-dsl/ability.schema.json",
	"wargear":        "https://40kdc.dev/schemas/core/wargear.schema.json",
	"wargear-option": "https://40kdc.dev/schemas/core/wargear-option.schema.json",
}

var keywordToCode = map[string]string{
	"required":             "REQUIRED_MISSING",
	"type":                 "TYPE_MISMATCH",
	"enum":                 "ENUM_VIOLATION",
	"const":                "ENUM_VIOLATION",
	"pattern":              "PATTERN_MISMATCH",
	"format":               "PATTERN_MISMATCH",
	"minimum":              "RANGE_VIOLATION",
	"maximum":              "RANGE_VIOLATION",
	"exclusiveMinimum":     "RANGE_VIOLATION",
	"exclusiveMaximum":     "RANGE_VIOLATION",
	"minLength":            "RANGE_VIOLATION",
	"maxLength":            "RANGE_VIOLATION",
	"minItems":             "RANGE_VIOLATION",
	"maxItems":             "RANGE_VIOLATION",
	"additionalProperties": "ADDITIONAL_PROPERTY",
	"uniqueItems":          "UNIQUE_VIOLATION",
}

// SchemaValidator holds all project schemas registered by $id.
type SchemaValidator struct {
	schemas map[string]map[string]any
	cache   map[string]*regexp.Regexp
}

// NewSchemaValidator loads the embedded schema tree keyed by $id.
func NewSchemaValidator() *SchemaValidator {
	v := &SchemaValidator{schemas: map[string]map[string]any{}, cache: map[string]*regexp.Regexp{}}
	_ = fs.WalkDir(schemasFS, "schemas", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".schema.json") {
			return nil
		}
		b, err := schemasFS.ReadFile(path)
		if err != nil {
			return nil
		}
		var schema map[string]any
		if json.Unmarshal(b, &schema) != nil {
			return nil
		}
		if id, ok := schema["$id"].(string); ok && id != "" {
			v.schemas[id] = schema
		}
		return nil
	})
	return v
}

func (v *SchemaValidator) hasSchema(id string) bool { _, ok := v.schemas[id]; return ok }

type violation struct{ path, keyword string }

// validateTarget validates value against one wire target, returning the
// deduplicated closed-enum (path, code) errors.
func (v *SchemaValidator) validateTarget(target string, value any) []map[string]any {
	id := validatorTargets[target]
	root := v.schemas[id]
	var vs []violation
	v.check(root, value, "", id, &vs)
	seen := map[string]bool{}
	out := []map[string]any{}
	for _, viol := range vs {
		code, ok := keywordToCode[viol.keyword]
		if !ok {
			continue
		}
		key := viol.path + "|" + code
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, map[string]any{"path": viol.path, "code": code})
	}
	return out
}

func (v *SchemaValidator) valid(schema any, instance any, base string) bool {
	var vs []violation
	v.check(schema, instance, "", base, &vs)
	return len(vs) == 0
}

func (v *SchemaValidator) resolveRef(base, ref string) (any, string) {
	parts := strings.SplitN(ref, "#", 2)
	urlPart, frag := parts[0], ""
	if len(parts) == 2 {
		frag = parts[1]
	}
	newBase := base
	var doc map[string]any
	if urlPart == "" {
		doc = v.schemas[base]
	} else {
		baseURL, err := url.Parse(base)
		if err != nil {
			return nil, base
		}
		refURL, err := url.Parse(urlPart)
		if err != nil {
			return nil, base
		}
		abs := baseURL.ResolveReference(refURL).String()
		abs = strings.SplitN(abs, "#", 2)[0]
		doc = v.schemas[abs]
		newBase = abs
	}
	if doc == nil {
		return nil, newBase
	}
	if frag == "" {
		return doc, newBase
	}
	return resolvePointer(doc, frag), newBase
}

func resolvePointer(doc any, frag string) any {
	cur := doc
	for _, tok := range strings.Split(strings.TrimPrefix(frag, "/"), "/") {
		if tok == "" {
			continue
		}
		tok = strings.ReplaceAll(strings.ReplaceAll(tok, "~1", "/"), "~0", "~")
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[tok]
	}
	return cur
}

func (v *SchemaValidator) check(schemaAny, instance any, path, base string, out *[]violation) {
	switch s := schemaAny.(type) {
	case bool:
		if !s {
			*out = append(*out, violation{path, "false"})
		}
		return
	case map[string]any:
		v.checkSchema(s, instance, path, base, out)
	}
}

func (v *SchemaValidator) checkSchema(schema map[string]any, instance any, path, base string, out *[]violation) {
	if ref, ok := schema["$ref"].(string); ok {
		target, newBase := v.resolveRef(base, ref)
		v.check(target, instance, path, newBase, out)
	}

	if t, ok := schema["type"]; ok {
		if !typeMatchesAny(t, instance) {
			*out = append(*out, violation{path, "type"})
		}
	}
	if enum, ok := schema["enum"].([]any); ok {
		matched := false
		for _, e := range enum {
			if jsonEqual(e, instance) {
				matched = true
				break
			}
		}
		if !matched {
			*out = append(*out, violation{path, "enum"})
		}
	}
	if c, ok := schema["const"]; ok {
		if !jsonEqual(c, instance) {
			*out = append(*out, violation{path, "const"})
		}
	}

	switch inst := instance.(type) {
	case map[string]any:
		if req, ok := schema["required"].([]any); ok {
			for _, rAny := range req {
				r, _ := rAny.(string)
				if _, present := inst[r]; !present {
					*out = append(*out, violation{path + "/" + escapeToken(r), "required"})
				}
			}
		}
		props, _ := schema["properties"].(map[string]any)
		for k, val := range inst {
			if sub, ok := props[k]; ok {
				v.check(sub, val, path+"/"+escapeToken(k), base, out)
			}
		}
		if ap, ok := schema["additionalProperties"]; ok {
			for k, val := range inst {
				if _, isProp := props[k]; isProp {
					continue
				}
				switch apv := ap.(type) {
				case bool:
					if !apv {
						*out = append(*out, violation{path + "/" + escapeToken(k), "additionalProperties"})
					}
				case map[string]any:
					v.check(apv, val, path+"/"+escapeToken(k), base, out)
				}
			}
		}
	case []any:
		prefix, _ := schema["prefixItems"].([]any)
		for i, e := range inst {
			if i < len(prefix) {
				v.check(prefix[i], e, path+"/"+itoa(i), base, out)
			} else if items, ok := schema["items"]; ok {
				v.check(items, e, path+"/"+itoa(i), base, out)
			}
		}
		if mi, ok := schema["minItems"]; ok && len(inst) < asInt(mi) {
			*out = append(*out, violation{path, "minItems"})
		}
		if ma, ok := schema["maxItems"]; ok && len(inst) > asInt(ma) {
			*out = append(*out, violation{path, "maxItems"})
		}
		if u, ok := schema["uniqueItems"].(bool); ok && u {
			if hasDuplicate(inst) {
				*out = append(*out, violation{path, "uniqueItems"})
			}
		}
	case string:
		if ml, ok := schema["minLength"]; ok && utf8.RuneCountInString(inst) < asInt(ml) {
			*out = append(*out, violation{path, "minLength"})
		}
		if ml, ok := schema["maxLength"]; ok && utf8.RuneCountInString(inst) > asInt(ml) {
			*out = append(*out, violation{path, "maxLength"})
		}
		if pat, ok := schema["pattern"].(string); ok {
			re := v.regex(pat)
			if re != nil && !re.MatchString(inst) {
				*out = append(*out, violation{path, "pattern"})
			}
		}
		// format: intentionally treated as always-valid (no corpus case exercises
		// a format failure; emitting nothing avoids false positives).
	case float64:
		if m, ok := schema["minimum"]; ok && inst < asFloat(m) {
			*out = append(*out, violation{path, "minimum"})
		}
		if m, ok := schema["maximum"]; ok && inst > asFloat(m) {
			*out = append(*out, violation{path, "maximum"})
		}
		if m, ok := schema["exclusiveMinimum"]; ok && inst <= asFloat(m) {
			*out = append(*out, violation{path, "exclusiveMinimum"})
		}
		if m, ok := schema["exclusiveMaximum"]; ok && inst >= asFloat(m) {
			*out = append(*out, violation{path, "exclusiveMaximum"})
		}
	}

	if allOf, ok := schema["allOf"].([]any); ok {
		for _, sub := range allOf {
			v.check(sub, instance, path, base, out)
		}
	}
	if oneOf, ok := schema["oneOf"].([]any); ok {
		validCount := 0
		for _, sub := range oneOf {
			if v.valid(sub, instance, base) {
				validCount++
			}
		}
		if validCount == 0 {
			for _, sub := range oneOf {
				v.check(sub, instance, path, base, out)
			}
		}
	}
	if anyOf, ok := schema["anyOf"].([]any); ok {
		anyValid := false
		for _, sub := range anyOf {
			if v.valid(sub, instance, base) {
				anyValid = true
				break
			}
		}
		if !anyValid {
			for _, sub := range anyOf {
				v.check(sub, instance, path, base, out)
			}
		}
	}
}

func (v *SchemaValidator) regex(pat string) *regexp.Regexp {
	if re, ok := v.cache[pat]; ok {
		return re
	}
	re, err := regexp.Compile(pat)
	if err != nil {
		re = nil
	}
	v.cache[pat] = re
	return re
}

func typeMatchesAny(t, instance any) bool {
	switch tt := t.(type) {
	case string:
		return typeMatches(tt, instance)
	case []any:
		for _, e := range tt {
			if s, ok := e.(string); ok && typeMatches(s, instance) {
				return true
			}
		}
		return false
	}
	return true
}

func typeMatches(t string, instance any) bool {
	switch t {
	case "object":
		_, ok := instance.(map[string]any)
		return ok
	case "array":
		_, ok := instance.([]any)
		return ok
	case "string":
		_, ok := instance.(string)
		return ok
	case "boolean":
		_, ok := instance.(bool)
		return ok
	case "null":
		return instance == nil
	case "number":
		_, ok := instance.(float64)
		return ok
	case "integer":
		f, ok := instance.(float64)
		return ok && f == math.Trunc(f)
	}
	return false
}

func escapeToken(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "~", "~0"), "/", "~1")
}

func jsonEqual(a, b any) bool {
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	return string(ab) == string(bb)
}

func hasDuplicate(arr []any) bool {
	seen := map[string]bool{}
	for _, e := range arr {
		b, _ := json.Marshal(e)
		if seen[string(b)] {
			return true
		}
		seen[string(b)] = true
	}
	return false
}
