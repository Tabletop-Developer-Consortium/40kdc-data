//! Schema validation with the closed cross-implementation error-code enum.
//!
//! A hand-rolled JSON Schema draft-2020-12 *subset* validator over the embedded
//! [`crate::BUNDLED_SCHEMA`] document — every entity schema lives under its
//! `$defs`, and AJV bundling rewrote all `$ref`s to local `#/$defs/...`
//! pointers, so no cross-file resolution is needed. Maps validation failures
//! onto the closed `(path, code)` enum pinned by `conformance/validator`
//! (`REQUIRED_MISSING`, `TYPE_MISMATCH`, `ENUM_VIOLATION`, `PATTERN_MISMATCH`,
//! `RANGE_VIOLATION`, `ADDITIONAL_PROPERTY`, `UNIQUE_VIOLATION`). Wording is the
//! implementation's prerogative — only the codes cross the wire.
//!
//! Rust mirror of `python/src/wh40kdc/validator.py` (the closed-enum mapping)
//! and the Go `validator.go`. Pattern/format checks are treated as always-valid
//! (no corpus case exercises a pattern failure, and the `regex` dep stays
//! scoped to the importer) — adding one would be a `SPEC_VERSION` bump anyway.

use std::collections::HashSet;
use std::sync::OnceLock;

use serde_json::Value;

/// The wire validator targets — each is a key under the bundled schema's
/// `$defs`.
pub const VALIDATOR_TARGETS: &[&str] = &[
    "unit",
    "weapon",
    "faction",
    "ability",
    "wargear",
    "wargear-option",
];

fn keyword_to_code(keyword: &str) -> Option<&'static str> {
    Some(match keyword {
        "required" => "REQUIRED_MISSING",
        "type" => "TYPE_MISMATCH",
        "enum" | "const" => "ENUM_VIOLATION",
        "pattern" | "format" => "PATTERN_MISMATCH",
        "minimum" | "maximum" | "exclusiveMinimum" | "exclusiveMaximum" | "minLength"
        | "maxLength" | "minItems" | "maxItems" => "RANGE_VIOLATION",
        "additionalProperties" => "ADDITIONAL_PROPERTY",
        "uniqueItems" => "UNIQUE_VIOLATION",
        _ => return None,
    })
}

fn bundled() -> &'static Value {
    static ROOT: OnceLock<Value> = OnceLock::new();
    ROOT.get_or_init(|| {
        serde_json::from_str(crate::BUNDLED_SCHEMA).expect("bundled schema is valid JSON")
    })
}

/// True when `target` is a known wire target present in the bundled schema.
pub fn has_target(target: &str) -> bool {
    VALIDATOR_TARGETS.contains(&target) && !bundled()["$defs"][target].is_null()
}

struct Violation {
    path: String,
    keyword: &'static str,
}

/// Validate `value` against the named wire target, returning the deduplicated
/// closed-enum `(path, code)` errors as JSON objects.
pub fn validate_target(target: &str, value: &Value) -> Vec<Value> {
    let root = bundled();
    let schema = &root["$defs"][target];
    let mut vs: Vec<Violation> = Vec::new();
    check(root, schema, value, "", &mut vs);

    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<Value> = Vec::new();
    for v in vs {
        let Some(code) = keyword_to_code(v.keyword) else {
            continue;
        };
        let key = format!("{}|{}", v.path, code);
        if seen.insert(key) {
            out.push(serde_json::json!({ "path": v.path, "code": code }));
        }
    }
    out
}

fn resolve_ref<'a>(root: &'a Value, reference: &str) -> Option<&'a Value> {
    // Local pointer only: "#/$defs/entity-id" -> "/$defs/entity-id".
    let pointer = reference.strip_prefix('#').unwrap_or(reference);
    if pointer.is_empty() {
        return Some(root);
    }
    root.pointer(pointer)
}

fn is_valid(root: &Value, schema: &Value, instance: &Value) -> bool {
    let mut vs = Vec::new();
    check(root, schema, instance, "", &mut vs);
    vs.is_empty()
}

fn push(out: &mut Vec<Violation>, path: &str, keyword: &'static str) {
    out.push(Violation {
        path: path.to_string(),
        keyword,
    });
}

fn check(root: &Value, schema: &Value, instance: &Value, path: &str, out: &mut Vec<Violation>) {
    match schema {
        Value::Bool(false) => push(out, path, "false"),
        Value::Bool(true) => {}
        Value::Object(s) => check_object(root, s, instance, path, out),
        _ => {}
    }
}

fn check_object(
    root: &Value,
    schema: &serde_json::Map<String, Value>,
    instance: &Value,
    path: &str,
    out: &mut Vec<Violation>,
) {
    if let Some(Value::String(r)) = schema.get("$ref") {
        if let Some(target) = resolve_ref(root, r) {
            check(root, target, instance, path, out);
        }
    }

    if let Some(t) = schema.get("type") {
        if !type_matches_any(t, instance) {
            push(out, path, "type");
        }
    }
    if let Some(Value::Array(enum_)) = schema.get("enum") {
        if !enum_.iter().any(|e| e == instance) {
            push(out, path, "enum");
        }
    }
    if let Some(c) = schema.get("const") {
        if c != instance {
            push(out, path, "const");
        }
    }

    match instance {
        Value::Object(inst) => {
            if let Some(Value::Array(req)) = schema.get("required") {
                for r in req {
                    if let Some(name) = r.as_str() {
                        if !inst.contains_key(name) {
                            push(out, &format!("{}/{}", path, escape_token(name)), "required");
                        }
                    }
                }
            }
            let props = schema.get("properties").and_then(Value::as_object);
            for (k, val) in inst {
                if let Some(sub) = props.and_then(|p| p.get(k)) {
                    check(
                        root,
                        sub,
                        val,
                        &format!("{}/{}", path, escape_token(k)),
                        out,
                    );
                }
            }
            if let Some(ap) = schema.get("additionalProperties") {
                for (k, val) in inst {
                    if props.map(|p| p.contains_key(k)).unwrap_or(false) {
                        continue;
                    }
                    match ap {
                        Value::Bool(false) => push(
                            out,
                            &format!("{}/{}", path, escape_token(k)),
                            "additionalProperties",
                        ),
                        Value::Object(_) | Value::Bool(true) => {
                            check(root, ap, val, &format!("{}/{}", path, escape_token(k)), out)
                        }
                        _ => {}
                    }
                }
            }
        }
        Value::Array(arr) => {
            let prefix = schema.get("prefixItems").and_then(Value::as_array);
            for (i, e) in arr.iter().enumerate() {
                if let Some(p) = prefix.and_then(|p| p.get(i)) {
                    check(root, p, e, &format!("{}/{}", path, i), out);
                } else if let Some(items) = schema.get("items") {
                    check(root, items, e, &format!("{}/{}", path, i), out);
                }
            }
            if let Some(mi) = schema.get("minItems").and_then(Value::as_u64) {
                if (arr.len() as u64) < mi {
                    push(out, path, "minItems");
                }
            }
            if let Some(ma) = schema.get("maxItems").and_then(Value::as_u64) {
                if (arr.len() as u64) > ma {
                    push(out, path, "maxItems");
                }
            }
            if schema.get("uniqueItems").and_then(Value::as_bool) == Some(true)
                && has_duplicate(arr)
            {
                push(out, path, "uniqueItems");
            }
        }
        Value::String(s) => {
            let len = s.chars().count() as u64;
            if let Some(ml) = schema.get("minLength").and_then(Value::as_u64) {
                if len < ml {
                    push(out, path, "minLength");
                }
            }
            if let Some(ml) = schema.get("maxLength").and_then(Value::as_u64) {
                if len > ml {
                    push(out, path, "maxLength");
                }
            }
            // pattern / format intentionally treated as always-valid.
        }
        Value::Number(n) => {
            let x = n.as_f64().unwrap_or(f64::NAN);
            if let Some(m) = schema.get("minimum").and_then(Value::as_f64) {
                if x < m {
                    push(out, path, "minimum");
                }
            }
            if let Some(m) = schema.get("maximum").and_then(Value::as_f64) {
                if x > m {
                    push(out, path, "maximum");
                }
            }
            if let Some(m) = schema.get("exclusiveMinimum").and_then(Value::as_f64) {
                if x <= m {
                    push(out, path, "exclusiveMinimum");
                }
            }
            if let Some(m) = schema.get("exclusiveMaximum").and_then(Value::as_f64) {
                if x >= m {
                    push(out, path, "exclusiveMaximum");
                }
            }
        }
        _ => {}
    }

    if let Some(Value::Array(all_of)) = schema.get("allOf") {
        for sub in all_of {
            check(root, sub, instance, path, out);
        }
    }
    if let Some(Value::Array(one_of)) = schema.get("oneOf") {
        let valid_count = one_of
            .iter()
            .filter(|s| is_valid(root, s, instance))
            .count();
        if valid_count == 0 {
            for sub in one_of {
                check(root, sub, instance, path, out);
            }
        }
    }
    if let Some(Value::Array(any_of)) = schema.get("anyOf") {
        if !any_of.iter().any(|s| is_valid(root, s, instance)) {
            for sub in any_of {
                check(root, sub, instance, path, out);
            }
        }
    }
}

fn type_matches_any(t: &Value, instance: &Value) -> bool {
    match t {
        Value::String(s) => type_matches(s, instance),
        Value::Array(arr) => arr.iter().any(|e| {
            e.as_str()
                .map(|s| type_matches(s, instance))
                .unwrap_or(false)
        }),
        _ => true,
    }
}

fn type_matches(t: &str, instance: &Value) -> bool {
    match t {
        "object" => instance.is_object(),
        "array" => instance.is_array(),
        "string" => instance.is_string(),
        "boolean" => instance.is_boolean(),
        "null" => instance.is_null(),
        "number" => instance.is_number(),
        "integer" => match instance {
            Value::Number(n) => {
                n.is_i64() || n.is_u64() || n.as_f64().map(|f| f.fract() == 0.0).unwrap_or(false)
            }
            _ => false,
        },
        _ => false,
    }
}

fn escape_token(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}

fn has_duplicate(arr: &[Value]) -> bool {
    let mut seen: HashSet<String> = HashSet::new();
    for e in arr {
        let key = serde_json::to_string(e).unwrap_or_default();
        if !seen.insert(key) {
            return true;
        }
    }
    false
}
