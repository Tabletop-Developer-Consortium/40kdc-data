package wh40kdc

import "strconv"

// Helpers for working with decoded JSON values modelled as plain Go `any`
// (map[string]any, []any, float64, string, bool, nil) — the same dynamic shape
// the Python port operates on as dicts. This keeps the port a near-line-by-line
// mirror of python/src/wh40kdc and avoids hundreds of generated struct fields.

// asMap returns v as a map[string]any, or (nil,false) when v isn't an object.
func asMap(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok
}

// asList returns v as a []any, or (nil,false) when v isn't an array.
func asList(v any) ([]any, bool) {
	l, ok := v.([]any)
	return l, ok
}

// isNumber reports whether v is a JSON number. Decoded JSON numbers are
// float64; bool is a distinct Go type so (unlike Python) it is never confused
// for a number.
func isNumber(v any) bool {
	_, ok := v.(float64)
	return ok
}

// num returns v as a float64, or (0,false).
func num(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok
}

// asInt truncates a JSON number to an int (0 when not a number).
func asInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	case string:
		// The runner protocol passes numeric args (e.g. modelCount) as strings.
		if i, err := strconv.Atoi(n); err == nil {
			return i
		}
	}
	return 0
}

// mGet looks up key in an object value, returning nil when v isn't an object
// or the key is absent.
func mGet(v any, key string) any {
	if m, ok := v.(map[string]any); ok {
		return m[key]
	}
	return nil
}

// getMap returns m[key] as an object, or (nil,false).
func getMap(m map[string]any, key string) (map[string]any, bool) {
	return asMap(m[key])
}

// getList returns m[key] as an array (nil when absent/not an array).
func getList(m map[string]any, key string) []any {
	l, _ := asList(m[key])
	return l
}

// getStr returns m[key] as a string ("" when absent/not a string).
func getStr(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

// strOr returns m[key] as a string, or def when absent/not a string.
func strOr(m map[string]any, key, def string) string {
	if s, ok := m[key].(string); ok {
		return s
	}
	return def
}

// getStrList returns m[key] as a []string, skipping non-string elements.
func getStrList(m map[string]any, key string) []string {
	l := getList(m, key)
	out := make([]string, 0, len(l))
	for _, e := range l {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// truthy mirrors Python truthiness for the value types we carry: nil/false/""/
// 0/empty-collections are falsey.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	default:
		return true
	}
}
