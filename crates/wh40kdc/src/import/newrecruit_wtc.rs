//! NewRecruit "wtc-compact" and "wtc-full" text adapters.
//!
//! Both formats open with a `++++++++` summary header carrying FACTION
//! KEYWORD, DETACHMENT, TOTAL ARMY POINTS, WARLORD, ENHANCEMENT(s),
//! NUMBER OF UNITS, and a tournament-objectives shorthand. The body diverges:
//!
//! - **wtc-compact** — one unit per line:
//!   `[CharN: ]Nx <Unit> (P pts): <comma-separated wargear>`
//!   followed optionally by `Enhancement: <Name> (+P pts)` on the next line.
//! - **wtc-full** — uppercase section headers (`BATTLELINE`, `ALLIED UNITS`),
//!   two-line unit blocks (`[CharN: ]Nx <Unit> (P pts)` then `N with
//!   <wargear>`), per-model-type breakdowns with `• Nx <ModelType>`, and an
//!   `Enhancement:` line.
//!
//! Rust mirror of `tools/src/import/newrecruit-wtc.ts`.

use super::types::{
    AttachmentRole, ParsedLeaderAttachment, ParsedLoadoutGroup, ParsedRoster, ParsedUnit,
    ParsedWargear, RosterFormat,
};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

use super::adapter::{FormatAdapter, ParseError};
use super::newrecruit_text::{
    classify_wargear_list, faction_from_keyword, infer_battle_size_raw, split_wargear_list,
    strip_parenthetical,
};

const WTC_HEADER_PREFIX: &str = "+ FACTION KEYWORD:";

// --- Header field regexes. -------------------------------------------------

static RE_FACTION: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^\+\s*FACTION KEYWORD:\s*(.+?)\s*$").unwrap());
static RE_DETACHMENT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^\+\s*DETACHMENT:\s*(.+?)\s*$").unwrap());
static RE_FORCE_DISPOSITION: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^\+\s*FORCE DISPOSITION:\s*(.+?)\s*$").unwrap());
static RE_TOTAL_PTS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^\+\s*TOTAL ARMY POINTS:\s*(\d+)\s*pts?\s*$").unwrap());
static RE_PTS_LIMIT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^\+\s*POINTS LIMIT:\s*(\d+)\s*pts?\s*$").unwrap());
static RE_LIST_NAME: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^\+\s*LIST NAME:\s*(.+?)\s*$").unwrap());
static RE_FENCE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\++\s*$").unwrap());

// --- Body line regexes. -----------------------------------------------------

static RE_UNIT_COMPACT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?im)^(?:Char\d+:\s*)?(\d+)x\s+(.+?)\s*\(\s*(\d+)\s*pts?\s*\)\s*:\s*(.*)$")
        .unwrap()
});
static RE_UNIT_FULL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(?:Char\d+:\s*)?(\d+)x\s+(.+?)\s*\(\s*(\d+)\s*pts?\s*\)\s*$").unwrap()
});
static RE_ENHANCEMENT_LINE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^Enhancement:\s*(.+?)(?:\s*\(\+\s*(\d+)\s*pts?\s*\))?\s*$").unwrap()
});
static RE_ATTACHMENT_LINE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^Attachment:\s*(leader|support)\s*->\s*(.+?)(\s+\[provisional\])?\s*$")
        .unwrap()
});
static RE_WITH_PREFIX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^(\d+)\s+with\s+(.*)$").unwrap());
// Optional trailing `: <wargear>` — NewRecruit inlines a model group's loadout
// after the model type (`• 1x Champion: Chainblades`) instead of always
// breaking it onto `N with` continuation lines.
static RE_MODEL_BREAKDOWN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*•\s*(\d+)x\s+([^:]+?)(?:\s*\[[^\]]*\])?\s*(?::\s*(.+))?$").unwrap()
});
static RE_SECTION_HEADER: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Z][A-Z0-9 \-/&]+$").unwrap());
static RE_CHAR_PREFIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^Char\d+:").unwrap());
static RE_FULL_FORMAT_MARKER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^[\t ]*\d+\s+with\b").unwrap());
static RE_SERIALIZED_FULL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?im)^\+\s*LIST NAME:.*\n(?:.*\n)*?^BATTLELINE\s*$").unwrap());
static RE_ALLIED_HEADER: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?im)^ALLIED UNITS\s*$").unwrap());

// --- Header parse ----------------------------------------------------------

struct WtcHeader {
    name: String,
    faction_raw_name: Option<String>,
    detachment_raw_names: Vec<String>,
    force_disposition_raw_name: Option<String>,
    declared_limit: Option<u64>,
    total_reported: Option<u64>,
    battle_size_raw: Option<String>,
}

fn parse_wtc_header(text: &str) -> Option<(WtcHeader, usize)> {
    let lines: Vec<&str> = text.split('\n').map(|l| l.trim_end_matches('\r')).collect();

    let mut faction_raw_name: Option<String> = None;
    let mut detachment_raw_names: Vec<String> = Vec::new();
    let mut force_disposition_raw_name: Option<String> = None;
    let mut total_reported: Option<u64> = None;
    let mut points_limit: Option<u64> = None;
    let mut list_name: Option<String> = None;

    let mut fence_indices: Vec<usize> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if fence_indices.len() >= 2 {
            break;
        }
        if RE_FENCE.is_match(line) {
            fence_indices.push(i);
        }
    }

    let mut saw_faction = false;
    for line in &lines {
        if !line.starts_with('+') {
            continue;
        }
        if let Some(c) = RE_FACTION.captures(line) {
            faction_raw_name = Some(faction_from_keyword(&c[1]));
            saw_faction = true;
            continue;
        }
        if let Some(c) = RE_DETACHMENT.captures(line) {
            let name = strip_parenthetical(&c[1]);
            if name != "—" {
                detachment_raw_names.push(name.to_string());
            }
            continue;
        }
        if let Some(c) = RE_FORCE_DISPOSITION.captures(line) {
            force_disposition_raw_name = Some(c[1].to_string());
            continue;
        }
        if let Some(c) = RE_TOTAL_PTS.captures(line) {
            total_reported = c[1].parse().ok();
            continue;
        }
        if let Some(c) = RE_PTS_LIMIT.captures(line) {
            points_limit = c[1].parse().ok();
            continue;
        }
        if let Some(c) = RE_LIST_NAME.captures(line) {
            list_name = Some(c[1].to_string());
        }
    }

    if !saw_faction {
        return None;
    }

    let body_start = if fence_indices.len() >= 2 {
        fence_indices[1] + 1
    } else {
        0
    };
    let declared_limit = points_limit.or(total_reported);
    let battle_size_raw = infer_battle_size_raw(declared_limit);

    Some((
        WtcHeader {
            name: list_name.unwrap_or_else(|| "Imported roster".to_string()),
            faction_raw_name,
            detachment_raw_names,
            force_disposition_raw_name,
            declared_limit,
            total_reported,
            battle_size_raw,
        },
        body_start,
    ))
}

// --- UnitBuilder + shared body helpers -------------------------------------

struct UnitBuilder {
    raw_name: String,
    is_character: bool,
    is_warlord: bool,
    keyword_overrides: Vec<String>,
    enhancement_raw_name: Option<String>,
    displayed_pts: Option<u64>,
    enhancement_pts: Option<u64>,
    leader_attachment: Option<ParsedLeaderAttachment>,
    model_count: u64,
    wargear: Vec<(String, u64)>,
    loadout_groups: Vec<ParsedLoadoutGroup>,
}

impl UnitBuilder {
    fn new(name: String, displayed_pts: u64, leading_count: u64, is_character: bool) -> Self {
        Self {
            raw_name: name,
            is_character,
            is_warlord: false,
            keyword_overrides: Vec::new(),
            enhancement_raw_name: None,
            displayed_pts: Some(displayed_pts),
            enhancement_pts: None,
            leader_attachment: None,
            model_count: if leading_count > 0 { leading_count } else { 1 },
            wargear: Vec::new(),
            loadout_groups: Vec::new(),
        }
    }

    fn add_wargear(&mut self, items: Vec<ParsedWargear>) {
        for ParsedWargear { raw_name, count } in items {
            if let Some(entry) = self.wargear.iter_mut().find(|(n, _)| n == &raw_name) {
                entry.1 += count;
            } else {
                self.wargear.push((raw_name, count));
            }
        }
    }

    fn finish(self) -> (ParsedUnit, Option<u64>) {
        let points = self
            .displayed_pts
            .map(|p| p.saturating_sub(self.enhancement_pts.unwrap_or(0)));
        let wargear = self
            .wargear
            .into_iter()
            .map(|(raw_name, count)| ParsedWargear { raw_name, count })
            .collect();
        let enhancement_points = self.enhancement_raw_name.as_ref().and(self.enhancement_pts);
        (
            ParsedUnit {
                raw_name: self.raw_name,
                is_character: self.is_character,
                keyword_overrides: (!self.keyword_overrides.is_empty())
                    .then_some(self.keyword_overrides),
                model_count: self.model_count,
                points,
                is_warlord: self.is_warlord,
                enhancement_raw_name: self.enhancement_raw_name,
                enhancement_points,
                wargear,
                loadout_groups: (!self.loadout_groups.is_empty()).then_some(self.loadout_groups),
                leader_attachment: Some(self.leader_attachment),
            },
            self.enhancement_pts,
        )
    }

    fn attach_enhancement(&mut self, raw_name: &str, pts: Option<u64>) {
        self.enhancement_raw_name = Some(raw_name.trim().to_string());
        self.enhancement_pts = pts;
    }
}

fn parse_with_group(text: &str) -> (u64, &str) {
    if let Some(c) = RE_WITH_PREFIX.captures(text) {
        let n: u64 = c[1].parse().unwrap_or(1);
        let multiplier = if n > 0 { n } else { 1 };
        let list_match = c.get(2).map(|m| m.as_str()).unwrap_or("");
        (multiplier, list_match)
    } else {
        (1, text)
    }
}
fn apply_with_group(
    unit: &mut UnitBuilder,
    list_text: &str,
    default_multiplier: u64,
) -> Vec<ParsedWargear> {
    let (parsed_multiplier, list) = parse_with_group(list_text);
    let multiplier = if RE_WITH_PREFIX.is_match(list_text) {
        parsed_multiplier
    } else {
        default_multiplier
    };
    let tokens = split_wargear_list(list);
    let mut normal_tokens = Vec::with_capacity(tokens.len());
    for token in tokens {
        let token = token.trim();
        let keyword = token
            .strip_prefix("40kdc Keyword:")
            .or_else(|| token.strip_prefix("40kdc Keywords:"))
            .map(str::trim);
        if let Some(keyword) = keyword {
            if !keyword.is_empty() && !unit.keyword_overrides.iter().any(|entry| entry == keyword) {
                unit.keyword_overrides.push(keyword.to_string());
            }
        } else {
            if token.ends_with(" Character")
                && !unit
                    .keyword_overrides
                    .iter()
                    .any(|entry| entry == "Character")
            {
                unit.keyword_overrides.push("Character".to_string());
            }
            normal_tokens.push(token);
        }
    }
    let cls = classify_wargear_list(&normal_tokens);
    if cls.is_warlord {
        unit.is_warlord = true;
    }
    if cls.is_character {
        unit.is_character = true;
    }
    let wargear = cls.wargear;
    unit.add_wargear(
        wargear
            .iter()
            .cloned()
            .map(|mut item| {
                item.count *= multiplier;
                item
            })
            .collect(),
    );
    wargear
}

fn compute_total(units: &[ParsedUnit], enhancement_pts: &[Option<u64>]) -> u64 {
    let mut total = 0u64;
    for (i, u) in units.iter().enumerate() {
        total += u.points.unwrap_or(0);
        total += enhancement_pts.get(i).copied().flatten().unwrap_or(0);
    }
    total
}

// --- compact body ----------------------------------------------------------

fn parse_compact_body(body: &str) -> (Vec<ParsedUnit>, Vec<Option<u64>>) {
    let mut units = Vec::new();
    let mut enhancement_pts = Vec::new();
    let mut current: Option<UnitBuilder> = None;
    let finalize = |current: &mut Option<UnitBuilder>,
                    units: &mut Vec<ParsedUnit>,
                    enhancement_pts: &mut Vec<Option<u64>>| {
        if let Some(builder) = current.take() {
            let (unit, points) = builder.finish();
            units.push(unit);
            enhancement_pts.push(points);
        }
    };

    for raw in body.split('\n') {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('+') {
            continue;
        }
        if let Some(c) = RE_ENHANCEMENT_LINE.captures(line) {
            if let Some(builder) = current.as_mut() {
                builder.attach_enhancement(&c[1], c.get(2).and_then(|m| m.as_str().parse().ok()));
                finalize(&mut current, &mut units, &mut enhancement_pts);
            }
            continue;
        }
        if let Some(c) = RE_ATTACHMENT_LINE.captures(line) {
            if let Some(builder) = current.as_mut() {
                builder.leader_attachment = Some(ParsedLeaderAttachment {
                    role: if c[1].eq_ignore_ascii_case("leader") {
                        AttachmentRole::Leader
                    } else {
                        AttachmentRole::Support
                    },
                    bodyguard_raw_name: c[2].to_string(),
                    provisional: c.get(3).is_some(),
                });
            }
            continue;
        }
        if let Some(c) = RE_MODEL_BREAKDOWN.captures(raw) {
            if let Some(builder) = current.as_mut() {
                let count = c[1].parse().unwrap_or(1);
                let wargear = c
                    .get(3)
                    .map(|m| apply_with_group(builder, m.as_str(), count))
                    .unwrap_or_default();
                builder.loadout_groups.push(ParsedLoadoutGroup {
                    model_name: Some(c[2].trim().to_string()),
                    count,
                    wargear,
                });
            }
            continue;
        }
        if let Some(c) = RE_UNIT_COMPACT.captures(line) {
            finalize(&mut current, &mut units, &mut enhancement_pts);
            let mut builder = UnitBuilder::new(
                c[2].trim().to_string(),
                c[3].parse().unwrap_or(0),
                c[1].parse().unwrap_or(1),
                RE_CHAR_PREFIX.is_match(line),
            );
            apply_with_group(&mut builder, &c[4], 1);
            current = Some(builder);
        }
    }
    finalize(&mut current, &mut units, &mut enhancement_pts);
    (units, enhancement_pts)
}

// --- full body -------------------------------------------------------------

fn parse_full_body(body: &str) -> (Vec<ParsedUnit>, Vec<Option<u64>>) {
    let mut units = Vec::new();
    let mut enhancement_pts = Vec::new();
    let mut current: Option<UnitBuilder> = None;
    let mut breakdown_models = 0;
    let mut pending: Option<(String, u64, u64)> = None;

    let flush_pending = |current: &mut Option<UnitBuilder>,
                         pending: &mut Option<(String, u64, u64)>| {
        if let Some((model_name, count, assigned)) = pending.take() {
            if count > assigned {
                if let Some(builder) = current.as_mut() {
                    builder.loadout_groups.push(ParsedLoadoutGroup {
                        model_name: Some(model_name),
                        count: count - assigned,
                        wargear: Vec::new(),
                    });
                }
            }
        }
    };
    let finalize = |current: &mut Option<UnitBuilder>,
                    breakdown_models: &mut u64,
                    pending: &mut Option<(String, u64, u64)>,
                    units: &mut Vec<ParsedUnit>,
                    enhancement_pts: &mut Vec<Option<u64>>| {
        flush_pending(current, pending);
        if let Some(mut builder) = current.take() {
            if *breakdown_models > 0 {
                builder.model_count = *breakdown_models;
            }
            let (unit, points) = builder.finish();
            units.push(unit);
            enhancement_pts.push(points);
            *breakdown_models = 0;
        }
    };

    for raw in body.split('\n') {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('+') {
            continue;
        }
        if RE_SECTION_HEADER.is_match(line) && !RE_UNIT_FULL.is_match(line) {
            finalize(
                &mut current,
                &mut breakdown_models,
                &mut pending,
                &mut units,
                &mut enhancement_pts,
            );
            continue;
        }
        if let Some(c) = RE_ENHANCEMENT_LINE.captures(line) {
            if let Some(builder) = current.as_mut() {
                builder.attach_enhancement(&c[1], c.get(2).and_then(|m| m.as_str().parse().ok()));
            }
            continue;
        }
        if let Some(c) = RE_ATTACHMENT_LINE.captures(line) {
            if let Some(builder) = current.as_mut() {
                builder.leader_attachment = Some(ParsedLeaderAttachment {
                    role: if c[1].eq_ignore_ascii_case("leader") {
                        AttachmentRole::Leader
                    } else {
                        AttachmentRole::Support
                    },
                    bodyguard_raw_name: c[2].to_string(),
                    provisional: c.get(3).is_some(),
                });
            }
            continue;
        }
        if let Some(c) = RE_UNIT_FULL.captures(line) {
            finalize(
                &mut current,
                &mut breakdown_models,
                &mut pending,
                &mut units,
                &mut enhancement_pts,
            );
            current = Some(UnitBuilder::new(
                c[2].trim().to_string(),
                c[3].parse().unwrap_or(0),
                c[1].parse().unwrap_or(1),
                RE_CHAR_PREFIX.is_match(line),
            ));
            continue;
        }
        if let Some(c) = RE_UNIT_COMPACT.captures(line) {
            finalize(
                &mut current,
                &mut breakdown_models,
                &mut pending,
                &mut units,
                &mut enhancement_pts,
            );
            let mut builder = UnitBuilder::new(
                c[2].trim().to_string(),
                c[3].parse().unwrap_or(0),
                c[1].parse().unwrap_or(1),
                RE_CHAR_PREFIX.is_match(line),
            );
            apply_with_group(&mut builder, &c[4], 1);
            current = Some(builder);
            continue;
        }
        if let Some(c) = RE_MODEL_BREAKDOWN.captures(raw) {
            flush_pending(&mut current, &mut pending);
            if let Some(builder) = current.as_mut() {
                let count = c[1].parse().unwrap_or(0);
                breakdown_models += count;
                let model_name = c[2].trim().to_string();
                pending = Some((model_name.clone(), count, 0));
                if let Some(inline) = c.get(3) {
                    let wargear = apply_with_group(builder, inline.as_str(), count);
                    let (multiplier, _) = parse_with_group(inline.as_str());
                    let group_count = if RE_WITH_PREFIX.is_match(inline.as_str()) {
                        multiplier
                    } else {
                        count
                    };
                    builder.loadout_groups.push(ParsedLoadoutGroup {
                        model_name: Some(model_name),
                        count: group_count,
                        wargear,
                    });
                    pending.as_mut().expect("set above").2 = group_count;
                }
            }
            continue;
        }
        if RE_WITH_PREFIX.is_match(line) {
            if let Some(builder) = current.as_mut() {
                let wargear = apply_with_group(builder, line, 1);
                if let Some((model_name, _, assigned)) = pending.as_mut() {
                    let (count, _) = parse_with_group(line);
                    builder.loadout_groups.push(ParsedLoadoutGroup {
                        model_name: Some(model_name.clone()),
                        count,
                        wargear,
                    });
                    *assigned += count;
                }
            }
        }
    }
    finalize(
        &mut current,
        &mut breakdown_models,
        &mut pending,
        &mut units,
        &mut enhancement_pts,
    );
    (units, enhancement_pts)
}

// --- adapters --------------------------------------------------------------

fn detect_multi_force(text: &str, full: bool) -> bool {
    full && RE_ALLIED_HEADER.is_match(text)
}

fn is_wtc_text(decoded: &Value) -> Option<&str> {
    let s = decoded.as_str()?;
    if s.contains(WTC_HEADER_PREFIX) {
        Some(s)
    } else {
        None
    }
}

fn is_full_format(text: &str) -> bool {
    RE_FULL_FORMAT_MARKER.is_match(text)
}

fn is_serialized_full_format(text: &str) -> bool {
    RE_SERIALIZED_FULL.is_match(text)
}

fn has_compact_unit(text: &str) -> bool {
    RE_UNIT_COMPACT.is_match(text)
}

fn parse_with(text: &str, full: bool, format_id: &str) -> Result<ParsedRoster, ParseError> {
    let (header, body_start) = parse_wtc_header(text).ok_or_else(|| {
        ParseError(format!(
            "{format_id}: missing \"+ FACTION KEYWORD:\" header"
        ))
    })?;
    let body_lines: Vec<&str> = text.split('\n').collect();
    let body = if body_start >= body_lines.len() {
        String::new()
    } else {
        body_lines[body_start..].join("\n")
    };
    let (units, enhancement_pts) = if full {
        parse_full_body(&body)
    } else {
        parse_compact_body(&body)
    };
    let total_computed = compute_total(&units, &enhancement_pts);

    Ok(ParsedRoster {
        name: header.name,
        generated_by: None,
        faction_raw_name: header.faction_raw_name,
        detachment_raw_names: header.detachment_raw_names,
        battle_size_raw: header.battle_size_raw,
        force_disposition: None,
        force_disposition_raw_name: Some(header.force_disposition_raw_name),
        declared_limit: header.declared_limit,
        total_reported: header.total_reported,
        total_computed,
        units,
        multi_force: detect_multi_force(text, full),
    })
}

pub struct NewRecruitWtcCompactAdapter;

impl FormatAdapter for NewRecruitWtcCompactAdapter {
    fn format(&self) -> RosterFormat {
        RosterFormat::NewrecruitWtcCompact
    }

    fn detect(&self, decoded: &Value) -> bool {
        match is_wtc_text(decoded) {
            Some(text) => {
                !is_full_format(text) && !is_serialized_full_format(text) && has_compact_unit(text)
            }
            None => false,
        }
    }

    fn parse(&self, decoded: &Value) -> Result<ParsedRoster, ParseError> {
        let text = is_wtc_text(decoded)
            .ok_or_else(|| ParseError("newrecruit-wtc-compact: input is not a string".into()))?;
        parse_with(text, false, "newrecruit-wtc-compact")
    }
}

pub struct NewRecruitWtcFullAdapter;

impl FormatAdapter for NewRecruitWtcFullAdapter {
    fn format(&self) -> RosterFormat {
        RosterFormat::NewrecruitWtcFull
    }

    fn detect(&self, decoded: &Value) -> bool {
        match is_wtc_text(decoded) {
            Some(text) => is_full_format(text) || is_serialized_full_format(text),
            None => false,
        }
    }

    fn parse(&self, decoded: &Value) -> Result<ParsedRoster, ParseError> {
        let text = is_wtc_text(decoded)
            .ok_or_else(|| ParseError("newrecruit-wtc-full: input is not a string".into()))?;
        parse_with(text, true, "newrecruit-wtc-full")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HEADER_ONLY: &str = "+++++++++++++++++++++++++++++++++++++++++++++++\n\
+ FACTION KEYWORD: Imperium - Adepta Sororitas\n\
+ DETACHMENT: Champions of Faith (Righteous Purpose)\n\
+ FORCE DISPOSITION: Disruption\n\
+ TOTAL ARMY POINTS: 990pts\n\
+++++++++++++++++++++++++++++++++++++++++++++++\n\
\n\
Char1: 1x Palatine (50 pts): Palatine blade, Plasma pistol\n";

    #[test]
    fn header_captures_force_disposition() {
        let parsed = NewRecruitWtcCompactAdapter
            .parse(&json!(HEADER_ONLY))
            .unwrap();
        assert_eq!(
            parsed.force_disposition_raw_name,
            Some(Some("Disruption".to_string()))
        );
        assert_eq!(
            parsed.detachment_raw_names,
            vec!["Champions of Faith".to_string()]
        );
    }

    #[test]
    fn header_without_disposition_is_explicit_null() {
        let no_disposition = HEADER_ONLY.replace("+ FORCE DISPOSITION: Disruption\n", "");
        let parsed = NewRecruitWtcCompactAdapter
            .parse(&json!(no_disposition))
            .unwrap();
        // Tri-state: the WTC adapter always sets the slot; absent line → explicit null.
        assert_eq!(parsed.force_disposition_raw_name, Some(None));
    }
}
