//! Rosterizer adapter: lower a Rosterizer roster JSON payload to a
//! [`ParsedRoster`].
//!
//! Rosterizer (<https://rosterizer.com>) stores a roster as a `Roster`
//! envelope with a recursive `Asset` tree under `snapshot` (or
//! `history.present.roster` as a fallback). Every entity — faction,
//! detachment, unit, weapon, ability, enhancement — is an `Asset` keyed by
//! `Classification§Designation` (e.g. `"Unit§Tactical Squad"`). Children sit
//! under `assets.included` (game pieces) and `assets.traits` (modifiers,
//! abilities, markers).
//!
//! The schema is rulebook-agnostic, so the actual `Classification` strings
//! come from whichever Rosterizer rulebook authored the roster. The
//! constants here encode the 40K convention used by the 40kdc
//! reference rulebook; tune them in one place if a real export disagrees.
//!
//! **IP safety**: the walk reads an ALLOWLIST — `item`, `designation`,
//! `name`, `classification`, `quantity`, `meta.points`,
//! `stats.Points.value`, and the recursive `assets.included` /
//! `assets.traits` children. Prose-bearing fields are never touched.
//!
//! Rust mirror of `tools/src/import/rosterizer.ts`.

use serde_json::Value;

use super::adapter::{FormatAdapter, ParseError};
use super::types::{ParsedRoster, ParsedUnit, ParsedWargear, RosterFormat};

// --- 40K rulebook Classification§Designation conventions. -----------------

const CLS_FACTION: &str = "Faction";
const CLS_DETACHMENT: &str = "Detachment";
const CLS_UNIT: &str = "Unit";
const CLS_SQUAD: &str = "Squad";
const CLS_WEAPON: &str = "Weapon";
const CLS_ENHANCEMENT: &str = "Enhancement";
const CLS_BATTLE_SIZE: &str = "Battle Size";
const CLS_TRAIT: &str = "Trait";
const DSG_WARLORD: &str = "Warlord";
const CHAR_CLASSIFICATIONS: [&str; 2] = ["Character", "Epic Hero"];
const POINTS_STAT_KEYS: [&str; 2] = ["Points", "Pts"];
const ITEM_SEPARATOR: char = '§';

// --- Allowlisted accessors -------------------------------------------------

fn as_str(value: &Value) -> Option<&str> {
    value.as_str()
}

fn as_number(value: &Value) -> Option<f64> {
    if let Some(n) = value.as_f64() {
        return Some(n);
    }
    if let Some(s) = value.as_str() {
        return s.parse().ok();
    }
    None
}

fn split_item(asset: &Value) -> (String, String) {
    if let Some(item) = as_str(&asset["item"]) {
        if let Some((cls, dsg)) = item.split_once(ITEM_SEPARATOR) {
            return (cls.to_string(), dsg.to_string());
        }
    }
    (
        as_str(&asset["classification"]).unwrap_or("").to_string(),
        as_str(&asset["designation"]).unwrap_or("").to_string(),
    )
}

fn class_of(asset: &Value) -> String {
    split_item(asset).0
}

fn display_name(asset: &Value) -> String {
    if let Some(name) = as_str(&asset["name"]) {
        return name.to_string();
    }
    split_item(asset).1
}

fn quantity(asset: &Value) -> u64 {
    match as_number(&asset["quantity"]) {
        Some(n) if n > 0.0 => n.trunc() as u64,
        _ => 1,
    }
}

fn included(asset: &Value) -> &[Value] {
    asset["assets"]["included"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn traits_of(asset: &Value) -> &[Value] {
    asset["assets"]["traits"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn points_of(asset: &Value) -> Option<u64> {
    for key in POINTS_STAT_KEYS {
        let stat = &asset["stats"][key];
        if let Some(v) = as_number(&stat["value"]) {
            return Some(v.trunc() as u64);
        }
    }
    if let Some(v) = as_number(&asset["meta"]["points"]) {
        return Some(v.trunc() as u64);
    }
    None
}

fn walk(asset: &Value, visit: &mut impl FnMut(&Value)) {
    visit(asset);
    for child in included(asset) {
        walk(child, visit);
    }
    for child in traits_of(asset) {
        walk(child, visit);
    }
}

fn is_unit_asset(asset: &Value) -> bool {
    matches!(class_of(asset).as_str(), CLS_UNIT | CLS_SQUAD)
}

fn is_weapon_asset(asset: &Value) -> bool {
    let cls = class_of(asset);
    cls == CLS_WEAPON || cls.ends_with(&format!(" {CLS_WEAPON}"))
}

fn is_enhancement_asset(asset: &Value) -> bool {
    class_of(asset) == CLS_ENHANCEMENT
}

fn is_character_asset(asset: &Value) -> bool {
    // Any keyword bucket containing "Character" / "Epic Hero" flags it.
    if let Some(keywords) = asset["keywords"].as_object() {
        for list in keywords.values() {
            if let Some(arr) = list.as_array() {
                for kw in arr {
                    if let Some(s) = as_str(kw) {
                        if CHAR_CLASSIFICATIONS.contains(&s) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    // A trait classified or named "Character" / "Epic Hero" flags it too.
    for t in traits_of(asset) {
        let cls = class_of(t);
        if CHAR_CLASSIFICATIONS.contains(&cls.as_str()) {
            return true;
        }
        let dsg = display_name(t);
        if CHAR_CLASSIFICATIONS.contains(&dsg.as_str()) {
            return true;
        }
    }
    false
}

fn is_warlord_trait(asset: &Value) -> bool {
    let (cls, dsg) = split_item(asset);
    if dsg == DSG_WARLORD {
        return true;
    }
    cls == CLS_TRAIT && dsg == DSG_WARLORD
}

fn model_count(unit: &Value) -> u64 {
    let mut nested = 0u64;
    for child in included(unit) {
        if is_unit_asset(child) {
            nested += quantity(child);
        }
    }
    if nested > 0 {
        nested
    } else {
        quantity(unit)
    }
}

fn parse_unit(unit: &Value) -> ParsedUnit {
    let mut wargear: Vec<ParsedWargear> = Vec::new();
    let mut enhancement_raw_name: Option<String> = None;
    let mut enhancement_points: Option<u64> = None;
    let mut is_warlord = false;

    for child in included(unit) {
        walk(child, &mut |a| {
            if is_enhancement_asset(a) {
                if enhancement_raw_name.is_none() {
                    enhancement_raw_name = Some(display_name(a));
                    enhancement_points = points_of(a);
                }
                return;
            }
            if is_weapon_asset(a) {
                wargear.push(ParsedWargear {
                    raw_name: display_name(a),
                    count: quantity(a),
                });
            }
        });
    }
    for t in traits_of(unit) {
        walk(t, &mut |a| {
            if is_warlord_trait(a) {
                is_warlord = true;
            }
        });
    }

    ParsedUnit {
        raw_name: display_name(unit),
        is_character: is_character_asset(unit),
        model_count: model_count(unit),
        points: points_of(unit),
        is_warlord,
        enhancement_raw_name,
        enhancement_points,
        wargear,
        leader_attachment: None,
    }
}

/// Resolve the snapshot Asset tree, preferring `snapshot` but falling
/// through to `history.present.roster`.
fn snapshot_of(envelope: &Value) -> Option<&Value> {
    if envelope["snapshot"].is_object() {
        return Some(&envelope["snapshot"]);
    }
    let present = &envelope["history"]["present"];
    if present.is_object() && present["roster"].is_object() {
        return Some(&present["roster"]);
    }
    None
}

fn is_rosterizer_envelope(decoded: &Value) -> bool {
    if !decoded.is_object() {
        return false;
    }
    if !decoded["rulebook"].is_object() {
        return false;
    }
    snapshot_of(decoded).is_some()
}

fn parse_limit(label: Option<&str>) -> Option<u64> {
    let label = label?;
    let bytes = label.as_bytes();
    let lower = label.to_ascii_lowercase();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b',') {
                i += 1;
            }
            let mut j = i;
            while j < bytes.len() && bytes[j] == b' ' {
                j += 1;
            }
            if lower[j..].starts_with("point") {
                let digits: String = label[start..i].chars().filter(|c| *c != ',').collect();
                return digits.parse().ok();
            }
        } else {
            i += 1;
        }
    }
    None
}

fn collect_units(root: &Value, out: &mut Vec<ParsedUnit>, under_unit: bool) {
    if is_unit_asset(root) {
        out.push(parse_unit(root));
        if under_unit {
            // Nested-unit case: already parsed; don't descend again to avoid
            // double-counting wargear that was already absorbed by the
            // parse_unit walk.
            return;
        }
        // Descend into a top-level unit so any nested attached leader/body
        // unit also surfaces as its own ParsedUnit.
        for c in included(root) {
            if is_unit_asset(c) {
                collect_units(c, out, true);
            } else {
                collect_units(c, out, true);
            }
        }
        for c in traits_of(root) {
            collect_units(c, out, true);
        }
        return;
    }
    for c in included(root) {
        collect_units(c, out, under_unit);
    }
    for c in traits_of(root) {
        collect_units(c, out, under_unit);
    }
}

pub struct RosterizerAdapter;

impl FormatAdapter for RosterizerAdapter {
    fn format(&self) -> RosterFormat {
        RosterFormat::Rosterizer
    }

    fn detect(&self, decoded: &Value) -> bool {
        is_rosterizer_envelope(decoded)
    }

    fn parse(&self, decoded: &Value) -> Result<ParsedRoster, ParseError> {
        if !is_rosterizer_envelope(decoded) {
            return Err(ParseError(
                "rosterizer: payload is not a Rosterizer roster envelope".into(),
            ));
        }
        let root = snapshot_of(decoded).ok_or_else(|| {
            ParseError("rosterizer: envelope has no snapshot or history.present.roster".into())
        })?;

        let mut faction_raw_name: Option<String> = None;
        let mut detachment_raw_names: Vec<String> = Vec::new();
        let mut battle_size_raw: Option<String> = None;
        let mut factions: Vec<String> = Vec::new();
        walk(root, &mut |a| {
            let cls = class_of(a);
            if cls == CLS_FACTION {
                let name = display_name(a);
                if !factions.contains(&name) {
                    factions.push(name.clone());
                }
                if faction_raw_name.is_none() {
                    faction_raw_name = Some(name);
                }
            } else if cls == CLS_DETACHMENT {
                detachment_raw_names.push(display_name(a));
            } else if cls == CLS_BATTLE_SIZE {
                if battle_size_raw.is_none() {
                    battle_size_raw = Some(display_name(a));
                }
            }
        });

        let mut units: Vec<ParsedUnit> = Vec::new();
        collect_units(root, &mut units, false);

        let total_reported = points_of(root);
        let mut total_computed: u64 = 0;
        for u in &units {
            total_computed += u.points.unwrap_or(0);
            total_computed += u.enhancement_points.unwrap_or(0);
        }

        let rulebook = &decoded["rulebook"];
        let generated_by = as_str(&rulebook["name"])
            .or_else(|| as_str(&rulebook["url"]))
            .map(str::to_string);

        let name = {
            let dn = display_name(root);
            if dn.is_empty() {
                as_str(&rulebook["name"])
                    .unwrap_or("Imported roster")
                    .to_string()
            } else {
                dn
            }
        };

        Ok(ParsedRoster {
            name,
            generated_by,
            faction_raw_name,
            detachment_raw_names,
            battle_size_raw: battle_size_raw.clone(),
            force_disposition: None,
            declared_limit: parse_limit(battle_size_raw.as_deref()),
            total_reported,
            total_computed,
            units,
            multi_force: factions.len() > 1,
        })
    }
}
