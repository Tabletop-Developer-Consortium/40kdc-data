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

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

use super::adapter::{FormatAdapter, ParseError};
use super::newrecruit_text::{
    classify_wargear_list, faction_from_keyword, infer_battle_size_raw, split_wargear_list,
    strip_parenthetical,
};
use super::types::{ParsedRoster, ParsedUnit, ParsedWargear, RosterFormat};

const WTC_HEADER_PREFIX: &str = "+ FACTION KEYWORD:";

// --- Header field regexes. -------------------------------------------------

static RE_FACTION: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^\+\s*FACTION KEYWORD:\s*(.+?)\s*$").unwrap());
static RE_DETACHMENT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^\+\s*DETACHMENT:\s*(.+?)\s*$").unwrap());
static RE_TOTAL_PTS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^\+\s*TOTAL ARMY POINTS:\s*(\d+)\s*pts?\s*$").unwrap());
static RE_PTS_LIMIT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^\+\s*POINTS LIMIT:\s*(\d+)\s*pts?\s*$").unwrap());
static RE_LIST_NAME: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^\+\s*LIST NAME:\s*(.+?)\s*$").unwrap());
static RE_FENCE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\++\s*$").unwrap());

// --- Body line regexes. -----------------------------------------------------

static RE_UNIT_COMPACT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(?:Char\d+:\s*)?(\d+)x\s+(.+?)\s*\(\s*(\d+)\s*pts?\s*\)\s*:\s*(.*)$").unwrap()
});
static RE_UNIT_FULL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(?:Char\d+:\s*)?(\d+)x\s+(.+?)\s*\(\s*(\d+)\s*pts?\s*\)\s*$").unwrap()
});
static RE_ENHANCEMENT_LINE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^Enhancement:\s*(.+?)\s*\(\+\s*(\d+)\s*pts?\s*\)\s*$").unwrap());
static RE_WITH_PREFIX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^(\d+)\s+with\s+(.*)$").unwrap());
static RE_MODEL_BREAKDOWN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*•\s*(\d+)x\s+(.+?)(?:\s*\[[^\]]*\])?\s*$").unwrap());
static RE_SECTION_HEADER: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Z][A-Z0-9 \-/&]+$").unwrap());
static RE_CHAR_PREFIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^Char\d+:").unwrap());
static RE_FULL_FORMAT_MARKER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^[\t ]*\d+\s+with\b").unwrap());
static RE_BULLET_LINE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^[\t ]*•").unwrap());
static RE_ALLIED_HEADER: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?im)^ALLIED UNITS\s*$").unwrap());

// --- Header parse ----------------------------------------------------------

struct WtcHeader {
    name: String,
    faction_raw_name: Option<String>,
    detachment_raw_name: Option<String>,
    declared_limit: Option<u64>,
    total_reported: Option<u64>,
    battle_size_raw: Option<String>,
}

fn parse_wtc_header(text: &str) -> Option<(WtcHeader, usize)> {
    let lines: Vec<&str> = text.split('\n').map(|l| l.trim_end_matches('\r')).collect();

    let mut faction_raw_name: Option<String> = None;
    let mut detachment_raw_name: Option<String> = None;
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
            detachment_raw_name = Some(strip_parenthetical(&c[1]).to_string());
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
            detachment_raw_name,
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
    enhancement_raw_name: Option<String>,
    displayed_pts: Option<u64>,
    enhancement_pts: u64,
    model_count: u64,
    /// Wargear insertion order is preserved (matches the TS Map iteration
    /// order); we use `Vec<(name, count)>` + linear lookup since the lists
    /// are tiny (≤ ~12 entries per unit).
    wargear: Vec<(String, u64)>,
}

impl UnitBuilder {
    fn new(name: String, displayed_pts: u64, leading_count: u64, is_character: bool) -> Self {
        Self {
            raw_name: name,
            is_character,
            is_warlord: false,
            enhancement_raw_name: None,
            displayed_pts: Some(displayed_pts),
            enhancement_pts: 0,
            model_count: if leading_count > 0 { leading_count } else { 1 },
            wargear: Vec::new(),
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

    fn finish(self) -> (ParsedUnit, u64) {
        let displayed = self.displayed_pts;
        let points = displayed.map(|p| p.saturating_sub(self.enhancement_pts));
        let wargear: Vec<ParsedWargear> = self
            .wargear
            .into_iter()
            .map(|(raw_name, count)| ParsedWargear { raw_name, count })
            .collect();
        let enhancement_points = if self.enhancement_raw_name.is_some() {
            Some(self.enhancement_pts)
        } else {
            None
        };
        (
            ParsedUnit {
                raw_name: self.raw_name,
                is_character: self.is_character,
                model_count: self.model_count,
                points,
                is_warlord: self.is_warlord,
                enhancement_raw_name: self.enhancement_raw_name,
                enhancement_points,
                wargear,
                leader_attachment: None,
            },
            self.enhancement_pts,
        )
    }

    fn attach_enhancement(&mut self, raw_name: &str, pts: u64) {
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

fn apply_with_group(unit: &mut UnitBuilder, list_text: &str) {
    let (multiplier, list) = parse_with_group(list_text);
    let tokens: Vec<&str> = split_wargear_list(list);
    let cls = classify_wargear_list(&tokens);
    if cls.is_warlord {
        unit.is_warlord = true;
    }
    if cls.is_character {
        unit.is_character = true;
    }
    let scaled: Vec<ParsedWargear> = cls
        .wargear
        .into_iter()
        .map(|w| ParsedWargear {
            raw_name: w.raw_name,
            count: w.count * multiplier,
        })
        .collect();
    unit.add_wargear(scaled);
}

fn compute_total(units: &[ParsedUnit], enhancement_pts: &[u64]) -> u64 {
    let mut total = 0u64;
    for (i, u) in units.iter().enumerate() {
        total += u.points.unwrap_or(0);
        total += enhancement_pts.get(i).copied().unwrap_or(0);
    }
    total
}

// --- compact body ----------------------------------------------------------

fn parse_compact_body(body: &str) -> (Vec<ParsedUnit>, Vec<u64>) {
    let mut units: Vec<ParsedUnit> = Vec::new();
    let mut enhancement_pts: Vec<u64> = Vec::new();
    let mut current: Option<UnitBuilder> = None;

    let finalize = |current: &mut Option<UnitBuilder>,
                    units: &mut Vec<ParsedUnit>,
                    enhancement_pts: &mut Vec<u64>| {
        if let Some(b) = current.take() {
            let (u, pts) = b.finish();
            units.push(u);
            enhancement_pts.push(pts);
        }
    };

    for raw in body.split('\n') {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('+') {
            continue;
        }

        if let Some(c) = RE_ENHANCEMENT_LINE.captures(line) {
            if let Some(b) = current.as_mut() {
                let pts: u64 = c[2].parse().unwrap_or(0);
                b.attach_enhancement(&c[1], pts);
                finalize(&mut current, &mut units, &mut enhancement_pts);
            }
            continue;
        }

        if let Some(c) = RE_UNIT_COMPACT.captures(line) {
            finalize(&mut current, &mut units, &mut enhancement_pts);
            let leading_count: u64 = c[1].parse().unwrap_or(1);
            let name = c[2].trim().to_string();
            let pts: u64 = c[3].parse().unwrap_or(0);
            let is_character_prefix = RE_CHAR_PREFIX.is_match(line);
            let mut builder = UnitBuilder::new(name, pts, leading_count, is_character_prefix);
            apply_with_group(&mut builder, &c[4]);
            current = Some(builder);
            continue;
        }
    }

    finalize(&mut current, &mut units, &mut enhancement_pts);
    (units, enhancement_pts)
}

// --- full body -------------------------------------------------------------

fn parse_full_body(body: &str) -> (Vec<ParsedUnit>, Vec<u64>) {
    let mut units: Vec<ParsedUnit> = Vec::new();
    let mut enhancement_pts: Vec<u64> = Vec::new();
    let mut current: Option<UnitBuilder> = None;
    let mut breakdown_models: u64 = 0;

    fn finalize(
        current: &mut Option<UnitBuilder>,
        breakdown_models: &mut u64,
        units: &mut Vec<ParsedUnit>,
        enhancement_pts: &mut Vec<u64>,
    ) {
        if let Some(mut b) = current.take() {
            if *breakdown_models > 0 {
                b.model_count = *breakdown_models;
            }
            let (u, pts) = b.finish();
            units.push(u);
            enhancement_pts.push(pts);
            *breakdown_models = 0;
        }
    }

    for raw in body.split('\n') {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('+') {
            continue;
        }
        if RE_SECTION_HEADER.is_match(line) && !RE_UNIT_FULL.is_match(line) {
            finalize(
                &mut current,
                &mut breakdown_models,
                &mut units,
                &mut enhancement_pts,
            );
            continue;
        }

        if let Some(c) = RE_ENHANCEMENT_LINE.captures(line) {
            if let Some(b) = current.as_mut() {
                let pts: u64 = c[2].parse().unwrap_or(0);
                b.attach_enhancement(&c[1], pts);
            }
            continue;
        }

        if let Some(c) = RE_UNIT_FULL.captures(line) {
            finalize(
                &mut current,
                &mut breakdown_models,
                &mut units,
                &mut enhancement_pts,
            );
            let leading_count: u64 = c[1].parse().unwrap_or(1);
            let name = c[2].trim().to_string();
            let pts: u64 = c[3].parse().unwrap_or(0);
            let is_character_prefix = RE_CHAR_PREFIX.is_match(line);
            current = Some(UnitBuilder::new(
                name,
                pts,
                leading_count,
                is_character_prefix,
            ));
            continue;
        }

        if let Some(c) = RE_MODEL_BREAKDOWN.captures(raw) {
            if current.is_some() {
                breakdown_models += c[1].parse::<u64>().unwrap_or(0);
            }
            continue;
        }

        if RE_WITH_PREFIX.is_match(line) {
            if let Some(b) = current.as_mut() {
                apply_with_group(b, line);
            }
            continue;
        }
    }

    finalize(
        &mut current,
        &mut breakdown_models,
        &mut units,
        &mut enhancement_pts,
    );
    (units, enhancement_pts)
}

// --- adapters --------------------------------------------------------------

fn detect_multi_force(text: &str, full: bool) -> bool {
    if full {
        RE_ALLIED_HEADER.is_match(text)
    } else {
        false
    }
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

/// `•`-prefixed body lines. wtc-full uses them for per-model breakdowns; the GW
/// app format uses them for every wargear entry. wtc-compact never emits them,
/// so it's the one matcher that must exclude them to stay disjoint from GW.
fn has_bullets(text: &str) -> bool {
    RE_BULLET_LINE.is_match(text)
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
        detachment_raw_names: header.detachment_raw_name.into_iter().collect(),
        battle_size_raw: header.battle_size_raw,
        force_disposition: None,
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
        // wtc-compact has no `N with` lines (that's wtc-full) and no `•`
        // bullets (that's the GW app format) — excluding both keeps it disjoint.
        match is_wtc_text(decoded) {
            Some(t) => !is_full_format(t) && !has_bullets(t),
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
            Some(t) => is_full_format(t),
            None => false,
        }
    }

    fn parse(&self, decoded: &Value) -> Result<ParsedRoster, ParseError> {
        let text = is_wtc_text(decoded)
            .ok_or_else(|| ParseError("newrecruit-wtc-full: input is not a string".into()))?;
        parse_with(text, true, "newrecruit-wtc-full")
    }
}
