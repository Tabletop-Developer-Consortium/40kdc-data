//! NewRecruit JSON adapter: lower a decoded NewRecruit roster export
//! (BattleScribe-derived tree, same outer shape as ListForge) to a
//! [`ParsedRoster`].
//!
//! NewRecruit-specific detection: `generatedBy` is `"https://newrecruit…"`
//! and/or `roster.xmlns` is the BattleScribe rosterSchema namespace.
//!
//! The primary faction surfaces in `forces[].catalogueName`
//! (e.g. "Chaos - Chaos Knights") — we take the segment after the final
//! `" - "`. Falls back to the first `"Faction: X"` category.
//!
//! The walk reads the same allowlist as the ListForge adapter — `name`,
//! `number`, `type`, `categories[].name`, `group`, `costs` point values, and
//! `catalogueName`. `rules`/`profiles`/`description` are never touched.
//!
//! Rust mirror of `tools/src/import/newrecruit-json.ts`.

use serde_json::Value;

use super::adapter::{FormatAdapter, ParseError};
use super::types::{
    AttachmentRole, ParsedLeaderAttachment, ParsedLoadoutGroup, ParsedRoster, ParsedUnit,
    ParsedWargear, RosterFormat,
};

const PTS_COST_NAME: &str = "pts";
const ENHANCEMENT_GROUP_PREFIX: &str = "Enhancements";
const ATTACHMENT_GROUP_PREFIX: &str = "40kdc Attachment:";
const CHARACTER_CATEGORIES: [&str; 2] = ["Character", "Epic Hero"];
const WEAPON_CATEGORY_SUFFIX: &str = " Weapon";
const NEWRECRUIT_XMLNS: &str = "http://www.battlescribe.net/schema/rosterSchema";
const NEWRECRUIT_HOST_PREFIX: &str = "https://newrecruit";

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

fn selection_count(sel: &Value) -> u64 {
    match sel["number"].as_u64() {
        Some(n) if n > 0 => n,
        _ => 1,
    }
}

fn points_of(sel: &Value) -> Option<u64> {
    for cost in as_array(&sel["costs"]) {
        if as_string(&cost["name"]) == Some(PTS_COST_NAME) {
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

fn keyword_overrides(sel: &Value) -> Vec<String> {
    as_array(&sel["categories"])
        .iter()
        .filter(|category| {
            as_string(&category["id"]).is_some_and(|id| id.starts_with("40kdc-keyword-"))
        })
        .filter_map(|category| as_string(&category["name"]))
        .map(str::to_string)
        .collect()
}

fn attachment_of(sel: &Value) -> Option<ParsedLeaderAttachment> {
    let group = as_string(&sel["group"])?;
    let suffix = group.strip_prefix(ATTACHMENT_GROUP_PREFIX)?;
    let mut parts = suffix.split(':');
    let role = match parts.next()? {
        "leader" => AttachmentRole::Leader,
        "support" => AttachmentRole::Support,
        _ => return None,
    };
    let provisional = match parts.next()? {
        "confirmed" => false,
        "provisional" => true,
        _ => return None,
    };
    if parts.next().is_some() {
        return None;
    }
    Some(ParsedLeaderAttachment {
        bodyguard_raw_name: selection_name(sel).to_string(),
        role,
        provisional,
    })
}

fn is_weapon_selection(sel: &Value) -> bool {
    category_names(sel)
        .iter()
        .any(|n| n.ends_with(WEAPON_CATEGORY_SUFFIX))
}

fn is_enhancement_selection(sel: &Value) -> bool {
    as_string(&sel["group"]).is_some_and(|g| g.starts_with(ENHANCEMENT_GROUP_PREFIX))
}

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

fn parse_unit(unit: &Value) -> ParsedUnit {
    let mut wargear: Vec<ParsedWargear> = Vec::new();
    let mut enhancement_raw_name: Option<String> = None;
    let mut enhancement_points: Option<u64> = None;
    let mut leader_attachment: Option<ParsedLeaderAttachment> = None;
    let mut is_warlord = false;

    for node in child_selections(unit) {
        walk(node, &mut |s| {
            if let Some(attachment) = attachment_of(s) {
                leader_attachment = Some(attachment);
                return;
            }
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

    // Model selections retain an exact per-model breakdown. Only preserve a
    // group when every nested weapon total divides across its models; otherwise
    // resolving the aggregate is the only faithful representation.
    let loadout_groups: Vec<ParsedLoadoutGroup> = child_selections(unit)
        .iter()
        .filter(|model| selection_type(model) == "model")
        .filter_map(|model| {
            let count = selection_count(model);
            let mut totals = Vec::new();
            walk(model, &mut |selection| {
                if is_weapon_selection(selection) {
                    totals.push(ParsedWargear {
                        raw_name: selection_name(selection).to_string(),
                        count: selection_count(selection),
                    });
                }
            });
            if count == 0 || totals.iter().any(|item| item.count % count != 0) {
                return None;
            }
            Some(ParsedLoadoutGroup {
                model_name: Some(selection_name(model).to_string()),
                count,
                wargear: totals
                    .into_iter()
                    .map(|item| ParsedWargear {
                        raw_name: item.raw_name,
                        count: item.count / count,
                    })
                    .collect(),
            })
        })
        .collect();

    let loadout_groups = (!loadout_groups.is_empty()).then_some(loadout_groups);

    ParsedUnit {
        raw_name: selection_name(unit).to_string(),
        is_character: is_character(unit),
        keyword_overrides: Some(keyword_overrides(unit)),
        model_count: model_count(unit),
        points: points_of(unit),
        is_warlord,
        enhancement_raw_name,
        enhancement_points,
        wargear,
        loadout_groups,
        leader_attachment: Some(leader_attachment),
    }
}
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

/// Primary faction from a force's `catalogueName` (e.g.
/// "Chaos - Chaos Knights" → "Chaos Knights").
fn primary_faction_from_catalogue(forces: &[Value]) -> Option<String> {
    for force in forces {
        let name = as_string(&force["catalogueName"])?;
        let last = name.rsplit(" - ").next()?.trim();
        if !last.is_empty() {
            return Some(last.to_string());
        }
    }
    None
}

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

fn has_newrecruit_signature(decoded: &Value, roster: &Value) -> bool {
    if as_string(&roster["xmlns"]) == Some(NEWRECRUIT_XMLNS) {
        return true;
    }
    let gen_by = as_string(&decoded["generatedBy"]).or_else(|| as_string(&roster["generatedBy"]));
    if let Some(g) = gen_by {
        if g.to_ascii_lowercase().starts_with(NEWRECRUIT_HOST_PREFIX) {
            return true;
        }
    }
    false
}

pub struct NewRecruitJsonAdapter;

impl FormatAdapter for NewRecruitJsonAdapter {
    fn format(&self) -> RosterFormat {
        RosterFormat::NewrecruitJson
    }

    fn detect(&self, decoded: &Value) -> bool {
        match roster_of(decoded) {
            Some(roster) => has_newrecruit_signature(decoded, roster),
            None => false,
        }
    }

    fn parse(&self, decoded: &Value) -> Result<ParsedRoster, ParseError> {
        let roster = roster_of(decoded).ok_or_else(|| {
            ParseError("newrecruit-json: payload has no roster.forces array".into())
        })?;
        let forces = as_array(&roster["forces"]);

        let mut detachment_raw_names: Vec<String> = Vec::new();
        let mut battle_size_raw: Option<String> = None;
        let mut force_disposition_raw_name: Option<String> = None;
        let mut units: Vec<ParsedUnit> = Vec::new();
        for force in forces {
            let top = child_selections(force);
            detachment_raw_names.extend(config_values(top, "Detachment"));
            if battle_size_raw.is_none() {
                battle_size_raw = config_value(top, "Battle Size");
            }
            if force_disposition_raw_name.is_none() {
                force_disposition_raw_name = config_value(top, "Force Disposition");
            }
            for sel in top {
                if is_unit_selection(sel) {
                    units.push(parse_unit(sel));
                }
            }
        }

        let factions = collect_factions(forces);
        let primary_faction =
            primary_faction_from_catalogue(forces).or_else(|| factions.first().cloned());
        let total_reported = points_of(roster);

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

        let generated_by = as_string(&decoded["generatedBy"])
            .or_else(|| as_string(&roster["generatedBy"]))
            .map(str::to_string);

        let name = as_string(&decoded["name"])
            .or_else(|| as_string(&roster["name"]))
            .unwrap_or("Imported roster")
            .to_string();

        Ok(ParsedRoster {
            name,
            generated_by,
            faction_raw_name: primary_faction,
            detachment_raw_names,
            battle_size_raw: battle_size_raw.clone(),
            force_disposition: None,
            force_disposition_raw_name: Some(force_disposition_raw_name),
            declared_limit: parse_limit(battle_size_raw.as_deref()),
            total_reported,
            total_computed,
            units,
            multi_force: factions.len() > 1,
        })
    }
}
