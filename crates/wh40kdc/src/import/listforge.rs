//! ListForge adapter: lower a decoded ListForge "share JSON" payload (a
//! BattleScribe-derived roster tree) to a [`ParsedRoster`].
//!
//! The walk reads an ALLOWLIST of fields only — `name`, `number`, `type`,
//! `categories[].name`, `group`, and `costs` point values — and never touches
//! `rules[].description` or ability `profiles[].characteristics[].$text`, which
//! carry reproduced rules text. This keeps the importer's output free of
//! copyrighted prose **by construction**; the `import_ip_safety` integration
//! test is the regression guard.
//!
//! Selection-tree shape (recursive `selections`):
//! - Configuration nodes (`type: "upgrade"`) named "Detachment" / "Battle Size"
//!   carry the chosen value as their first child selection.
//! - Unit nodes (`type: "model" | "unit"`) carry role categories, a points
//!   cost, and — nested anywhere beneath them — their wargear (weapon-category
//!   selections), enhancement (a selection whose `group` starts "Enhancements"),
//!   the "Warlord" marker, and model sub-selections.
//! - Every unit carries a `"Faction: <Name>"` category.
//!
//! Rust mirror of `tools/src/import/listforge.ts`.

use serde_json::Value;

use super::adapter::{FormatAdapter, ParseError};
use super::types::{ParsedRoster, ParsedUnit, ParsedWargear, RosterFormat};

const PTS_COST_NAME: &str = "pts";
const ENHANCEMENT_GROUP_PREFIX: &str = "Enhancements";
const WEAPON_CATEGORY_SUFFIX: &str = " Weapon"; // "Ranged Weapon", "Melee Weapon", …
const CHARACTER_CATEGORIES: [&str; 2] = ["Character", "Epic Hero"];
const NEWRECRUIT_XMLNS: &str = "http://www.battlescribe.net/schema/rosterSchema";
const NEWRECRUIT_HOST_PREFIX: &str = "https://newrecruit";

// --- Allowlisted field accessors (the IP-safety boundary). ------------------
// Only these fields of a selection are ever read. Adding an accessor here is the
// only way to widen what the importer touches, so the allowlist stays auditable.

fn as_array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn as_string(value: &Value) -> Option<&str> {
    value.as_str()
}

fn selection_name(sel: &Value) -> &str {
    as_string(&sel["name"]).unwrap_or("")
}

fn selection_type(sel: &Value) -> &str {
    as_string(&sel["type"]).unwrap_or("")
}

/// A selection's multiplicity (`number`), defaulting to 1.
fn selection_count(sel: &Value) -> u64 {
    match sel["number"].as_u64() {
        Some(n) if n > 0 => n,
        _ => 1,
    }
}

/// Point value from a selection's cost block, or `None` when absent.
fn points_of(sel: &Value) -> Option<u64> {
    for cost in as_array(&sel["costs"]) {
        if as_string(&cost["name"]) == Some(PTS_COST_NAME) {
            // ListForge encodes points as a (sometimes fractional) number; the
            // 40kdc model uses whole points, so truncate toward zero.
            if let Some(v) = cost["value"].as_f64() {
                return Some(v as u64);
            }
        }
    }
    None
}

fn category_names(sel: &Value) -> Vec<&str> {
    as_array(&sel["categories"])
        .iter()
        .filter_map(|c| as_string(&c["name"]))
        .collect()
}

fn child_selections(sel: &Value) -> &[Value] {
    as_array(&sel["selections"])
}

/// Depth-first visit of a selection and everything beneath it.
fn walk(sel: &Value, visit: &mut impl FnMut(&Value)) {
    visit(sel);
    for child in child_selections(sel) {
        walk(child, visit);
    }
}

fn is_unit_selection(sel: &Value) -> bool {
    matches!(selection_type(sel), "model" | "unit")
}

fn is_character(sel: &Value) -> bool {
    category_names(sel)
        .iter()
        .any(|n| CHARACTER_CATEGORIES.contains(n))
}

fn is_weapon_selection(sel: &Value) -> bool {
    category_names(sel)
        .iter()
        .any(|n| n.ends_with(WEAPON_CATEGORY_SUFFIX))
}

fn is_enhancement_selection(sel: &Value) -> bool {
    as_string(&sel["group"]).is_some_and(|g| g.starts_with(ENHANCEMENT_GROUP_PREFIX))
}

/// Sum the model count of a unit from its nested model selections.
fn model_count(unit: &Value) -> u64 {
    let mut total = 0;
    walk(unit, &mut |s| {
        if selection_type(s) == "model" {
            total += selection_count(s);
        }
    });
    if total > 0 {
        total
    } else {
        selection_count(unit)
    }
}

/// Build a parsed unit from a top-level unit selection.
fn parse_unit(unit: &Value) -> ParsedUnit {
    let mut wargear: Vec<ParsedWargear> = Vec::new();
    let mut enhancement_raw_name: Option<String> = None;
    let mut enhancement_points: Option<u64> = None;
    let mut is_warlord = false;

    for node in child_selections(unit) {
        walk(node, &mut |s| {
            if is_enhancement_selection(s) {
                if enhancement_raw_name.is_none() {
                    enhancement_raw_name = Some(selection_name(s).to_string());
                    enhancement_points = points_of(s);
                }
                return;
            }
            if selection_name(s) == "Warlord" {
                is_warlord = true;
                return;
            }
            if is_weapon_selection(s) {
                wargear.push(ParsedWargear {
                    raw_name: selection_name(s).to_string(),
                    count: selection_count(s),
                });
            }
        });
    }

    ParsedUnit {
        raw_name: selection_name(unit).to_string(),
        is_character: is_character(unit),
        model_count: model_count(unit),
        points: points_of(unit),
        is_warlord,
        enhancement_raw_name,
        enhancement_points,
        wargear,
        leader_attachment: None,
    }
}

/// Value carried as the first child of a named configuration selection.
fn config_value(selections: &[Value], config_name: &str) -> Option<String> {
    let node = selections
        .iter()
        .find(|s| selection_name(s) == config_name)?;
    let child = child_selections(node).first()?;
    Some(selection_name(child).to_string())
}

/// Every value under a named config, across repeated blocks and multiple
/// children, in source order. Used for multi-detachment 11e lists.
fn config_values(selections: &[Value], config_name: &str) -> Vec<String> {
    let mut out = Vec::new();
    for node in selections {
        if selection_name(node) != config_name {
            continue;
        }
        for child in child_selections(node) {
            let name = selection_name(child);
            if !name.is_empty() {
                out.push(name.to_string());
            }
        }
    }
    out
}

/// Parse the points ceiling out of a battle-size label like
/// "2. Strike Force (2000 Point limit)".
fn parse_limit(label: Option<&str>) -> Option<u64> {
    let label = label?;
    // Find a digit run immediately followed (allowing spaces) by "Point".
    let bytes = label.as_bytes();
    let lower = label.to_ascii_lowercase();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b',') {
                i += 1;
            }
            // Skip whitespace then check for "point".
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

/// All distinct `"Faction: X"` category names found anywhere in the forces.
fn collect_factions(forces: &[Value]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for force in forces {
        for sel in child_selections(force) {
            walk(sel, &mut |s| {
                for name in category_names(s) {
                    if let Some(rest) = name.strip_prefix("Faction:") {
                        let value = rest.trim().to_string();
                        if !value.is_empty() && !seen.contains(&value) {
                            seen.push(value);
                        }
                    }
                }
            });
        }
    }
    seen
}

/// The roster object (with a `forces` array), if the payload carries one.
fn roster_of(decoded: &Value) -> Option<&Value> {
    let roster = decoded.get("roster")?;
    if !roster.is_object() {
        return None;
    }
    if !roster.get("forces").map(Value::is_array).unwrap_or(false) {
        return None;
    }
    Some(roster)
}

/// Detect a NewRecruit-flavoured BattleScribe payload. ListForge's matcher
/// excludes these so the greedy first-match dispatcher routes them to the
/// NewRecruit adapter without falling through to here.
fn has_newrecruit_signature(decoded: &Value, roster: &Value) -> bool {
    if as_string(&roster["xmlns"]) == Some(NEWRECRUIT_XMLNS) {
        return true;
    }
    let gen_by = as_string(&decoded["generatedBy"]).or_else(|| as_string(&roster["generatedBy"]));
    gen_by.is_some_and(|g| g.to_ascii_lowercase().starts_with(NEWRECRUIT_HOST_PREFIX))
}

/// The ListForge "share JSON" adapter — the first concrete
/// [`FormatAdapter`](super::FormatAdapter).
pub struct ListForgeAdapter;

impl FormatAdapter for ListForgeAdapter {
    fn format(&self) -> RosterFormat {
        RosterFormat::Listforge
    }

    fn detect(&self, decoded: &Value) -> bool {
        let Some(roster) = roster_of(decoded) else {
            return false;
        };
        !has_newrecruit_signature(decoded, roster)
    }

    fn parse(&self, decoded: &Value) -> Result<ParsedRoster, ParseError> {
        let roster = roster_of(decoded)
            .ok_or_else(|| ParseError("listforge: payload has no roster.forces array".into()))?;
        let forces = as_array(&roster["forces"]);

        // Configuration lives among each force's top-level selections.
        let mut detachment_raw_names: Vec<String> = Vec::new();
        let mut battle_size_raw: Option<String> = None;
        let mut units: Vec<ParsedUnit> = Vec::new();
        for force in forces {
            let top = child_selections(force);
            detachment_raw_names.extend(config_values(top, "Detachment"));
            if battle_size_raw.is_none() {
                battle_size_raw = config_value(top, "Battle Size");
            }
            for sel in top {
                if is_unit_selection(sel) {
                    units.push(parse_unit(sel));
                }
            }
        }

        let factions = collect_factions(forces);
        let total_reported = points_of(roster);

        // Honest computed total: sum every cost line in the tree. A unit's own
        // cost and its nested enhancement's cost are distinct lines that together
        // make up the unit's army contribution, so a full walk reproduces the
        // army total.
        let mut total_computed = 0;
        for force in forces {
            for sel in child_selections(force) {
                walk(sel, &mut |s| {
                    if let Some(pts) = points_of(s) {
                        total_computed += pts;
                    }
                });
            }
        }

        let name = as_string(&decoded["name"])
            .or_else(|| as_string(&roster["name"]))
            .unwrap_or("Imported roster")
            .to_string();

        Ok(ParsedRoster {
            name,
            generated_by: as_string(&decoded["generatedBy"]).map(str::to_string),
            faction_raw_name: factions.first().cloned(),
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
