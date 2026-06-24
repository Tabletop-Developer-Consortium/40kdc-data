//! GW adapter: lower the Games Workshop 40K app's plain-text army-list export
//! to a [`ParsedRoster`].
//!
//! The format opens with the same `++++…++++` summary fence as the NewRecruit
//! WTC formats (FACTION KEYWORD / DETACHMENT / TOTAL ARMY POINTS / WARLORD /
//! ENHANCEMENT / NUMBER OF UNITS / SECONDARY), then lists units grouped under
//! ALL-CAPS battlefield-role sections (`BATTLELINE`, `CHARACTERS`,
//! `ALLIED UNITS`, …). Each unit is a header line `Name (N pts)` followed by
//! `•`-bulleted entries.
//!
//! Bullet classification (the parsing crux):
//! - A top-level `• Nx Thing` *with* further-indented child bullets is a
//!   **model group** — `N` adds to the model count and the children are that
//!   group's wargear (Nurglings, Beasts of Nurgle).
//! - A top-level `• Nx Thing` *without* children is plain **wargear**.
//! - A bullet *without* an `Nx` count is an **annotation**: `… Character` flags
//!   a character, `Warlord` flags the warlord, `Name (+N pts)` is the
//!   enhancement.
//!
//! **Disjointness from the WTC matchers**: the GW format always carries `•`
//! bullets and never the WTC `N with` lines. wtc-full always has `N with` (so
//! it never collides), and wtc-compact never has bullets (its matcher excludes
//! them). This adapter matches on *bullets present* + *no `N with`*.
//!
//! Rust mirror of `tools/src/import/gw.ts`.

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

use super::adapter::{FormatAdapter, ParseError};
use super::newrecruit_text::{faction_from_keyword, infer_battle_size_raw, strip_parenthetical};
use super::types::{ParsedRoster, ParsedUnit, ParsedWargear, RosterFormat};

const FACTION_KEYWORD_PREFIX: &str = "+ FACTION KEYWORD:";
const ALLIED_SECTION: &str = "ALLIED UNITS";
const CHARACTERS_SECTION: &str = "CHARACTERS";
const CHARACTER_SUFFIX: &str = " Character";
const WARLORD_MARKER: &str = "Warlord";

static RE_FACTION: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^\+\s*FACTION KEYWORD:\s*(.+?)\s*$").unwrap());
static RE_DETACHMENT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^\+\s*DETACHMENT:\s*(.+?)\s*$").unwrap());
static RE_TOTAL_PTS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^\+\s*TOTAL ARMY POINTS:\s*(\d+)\s*pts?\s*$").unwrap());
static RE_FENCE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\++\s*$").unwrap());
static RE_SECTION_HEADER: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Z][A-Z0-9 \-/&]+$").unwrap());
static RE_UNIT_HEADER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^(.+?)\s*\(\s*(\d+)\s*pts?\s*\)\s*$").unwrap());
static RE_BULLET_LINE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^([\t ]*)•\s*(.+?)\s*$").unwrap());
static RE_NX_PREFIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(\d+)x\s+(.+)$").unwrap());
static RE_ENHANCEMENT_ANNOT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^(.+?)\s*\(\+\s*(\d+)\s*pts?\s*\)\s*$").unwrap());
static RE_WITH_LINE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^[\t ]*\d+\s+with\b").unwrap());
static RE_BULLET_ANYWHERE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^[\t ]*•").unwrap());

/// Accept the input only when it carries the FACTION KEYWORD summary header,
/// has `•` bullets, and lacks the WTC `N with` body lines.
fn is_gw_text(decoded: &Value) -> Option<&str> {
    let s = decoded.as_str()?;
    if !s.contains(FACTION_KEYWORD_PREFIX) {
        return None;
    }
    if !RE_BULLET_ANYWHERE.is_match(s) {
        return None;
    }
    if RE_WITH_LINE.is_match(s) {
        return None; // that's wtc-full
    }
    Some(s)
}

struct GwHeader {
    name: String,
    faction_raw_name: Option<String>,
    detachment_raw_name: Option<String>,
    total_reported: Option<u64>,
    declared_limit: Option<u64>,
    battle_size_raw: Option<String>,
}

fn parse_header(lines: &[&str]) -> Option<(GwHeader, usize)> {
    let mut faction_raw_name: Option<String> = None;
    let mut detachment_raw_name: Option<String> = None;
    let mut total_reported: Option<u64> = None;

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
    for line in lines {
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
    // The GW export has no POINTS LIMIT line — only TOTAL ARMY POINTS. Use it
    // as the declared limit so the inferred battle size stays round-trippable.
    let declared_limit = total_reported;
    Some((
        GwHeader {
            name: "Imported roster".to_string(),
            faction_raw_name,
            detachment_raw_name,
            total_reported,
            declared_limit,
            battle_size_raw: infer_battle_size_raw(declared_limit),
        },
        body_start,
    ))
}

struct Bullet {
    indent: usize,
    count: Option<u64>,
    text: String,
}

struct UnitAcc {
    raw_name: String,
    displayed_pts: Option<u64>,
    section: Option<String>,
    bullets: Vec<Bullet>,
}

fn finish_unit(acc: UnitAcc) -> ParsedUnit {
    let top_indent = acc.bullets.iter().map(|b| b.indent).min().unwrap_or(0);

    // Insertion-ordered wargear with duplicate-name merge (mirrors the TS Map).
    let mut wargear: Vec<ParsedWargear> = Vec::new();
    let mut add_wargear = |raw_name: &str, count: u64| {
        if let Some(w) = wargear.iter_mut().find(|w| w.raw_name == raw_name) {
            w.count += count;
        } else {
            wargear.push(ParsedWargear {
                raw_name: raw_name.to_string(),
                count,
            });
        }
    };

    let mut model_count: u64 = 0;
    let mut is_warlord = false;
    let mut is_character = acc.section.as_deref() == Some(CHARACTERS_SECTION);
    let mut enhancement_raw_name: Option<String> = None;
    let mut enhancement_points: Option<u64> = None;

    for (i, b) in acc.bullets.iter().enumerate() {
        // A child bullet (deeper than the unit's top level) is a model group's
        // weapon — its `Nx` count is already the squad-wide total.
        if b.indent > top_indent {
            if let Some(count) = b.count {
                add_wargear(&b.text, count);
            }
            continue;
        }

        // Top-level annotation (no `Nx` count): enhancement / character /
        // warlord.
        if b.count.is_none() {
            if let Some(c) = RE_ENHANCEMENT_ANNOT.captures(&b.text) {
                if enhancement_raw_name.is_none() {
                    enhancement_raw_name = Some(c[1].trim().to_string());
                    enhancement_points = c[2].parse().ok();
                }
                continue;
            }
            for token in b.text.split(',').map(str::trim).filter(|t| !t.is_empty()) {
                if token == WARLORD_MARKER {
                    is_warlord = true;
                } else if token.ends_with(CHARACTER_SUFFIX) {
                    is_character = true;
                }
            }
            continue;
        }

        // Top-level `Nx` bullet: a model group when it has child bullets
        // beneath it, otherwise plain wargear.
        let count = b.count.unwrap();
        let next_is_child = acc
            .bullets
            .get(i + 1)
            .map(|n| n.indent > top_indent)
            .unwrap_or(false);
        if next_is_child {
            model_count += count;
        } else {
            add_wargear(&b.text, count);
        }
    }

    if model_count == 0 {
        model_count = 1;
    }

    // The GW unit header points include the enhancement; back it out to base.
    let points = match (acc.displayed_pts, enhancement_points) {
        (Some(displayed), Some(enh)) => Some(displayed.saturating_sub(enh)),
        (displayed, _) => displayed,
    };

    ParsedUnit {
        raw_name: acc.raw_name,
        is_character,
        model_count,
        points,
        is_warlord,
        enhancement_raw_name,
        enhancement_points,
        wargear,
        leader_attachment: None,
    }
}

fn parse_body(lines: &[&str], body_start: usize) -> (Vec<ParsedUnit>, bool) {
    let mut units: Vec<ParsedUnit> = Vec::new();
    let mut current: Option<UnitAcc> = None;
    let mut section: Option<String> = None;
    let mut allied_units = 0u64;

    for raw in &lines[body_start.min(lines.len())..] {
        let line = raw.trim();
        if line.is_empty() || RE_FENCE.is_match(line) || line.starts_with('+') {
            continue;
        }

        if let Some(c) = RE_BULLET_LINE.captures(raw) {
            if let Some(unit) = current.as_mut() {
                let indent = c[1].len();
                let rest = &c[2];
                let (count, text) = match RE_NX_PREFIX.captures(rest) {
                    Some(nx) => (nx[1].parse::<u64>().ok(), nx[2].trim().to_string()),
                    None => (None, rest.trim().to_string()),
                };
                unit.bullets.push(Bullet {
                    indent,
                    count,
                    text,
                });
            }
            continue;
        }

        if let Some(c) = RE_UNIT_HEADER.captures(line) {
            if let Some(unit) = current.take() {
                units.push(finish_unit(unit));
            }
            current = Some(UnitAcc {
                raw_name: c[1].trim().to_string(),
                displayed_pts: c[2].parse().ok(),
                section: section.clone(),
                bullets: Vec::new(),
            });
            if section.as_deref() == Some(ALLIED_SECTION) {
                allied_units += 1;
            }
            continue;
        }

        if RE_SECTION_HEADER.is_match(line) {
            if let Some(unit) = current.take() {
                units.push(finish_unit(unit));
            }
            section = Some(line.to_string());
        }
    }

    if let Some(unit) = current.take() {
        units.push(finish_unit(unit));
    }

    (units, allied_units > 0)
}

pub struct GwAdapter;

impl FormatAdapter for GwAdapter {
    fn format(&self) -> RosterFormat {
        RosterFormat::Gw
    }

    fn detect(&self, decoded: &Value) -> bool {
        is_gw_text(decoded).is_some()
    }

    fn parse(&self, decoded: &Value) -> Result<ParsedRoster, ParseError> {
        let text = is_gw_text(decoded)
            .ok_or_else(|| ParseError("gw: input is not a GW app text export".into()))?;

        let lines: Vec<&str> = text.split('\n').map(|l| l.trim_end_matches('\r')).collect();
        let (header, body_start) = parse_header(&lines)
            .ok_or_else(|| ParseError("gw: missing \"+ FACTION KEYWORD:\" header".into()))?;

        let (units, multi_force) = parse_body(&lines, body_start);

        let mut total_computed: u64 = 0;
        for u in &units {
            total_computed += u.points.unwrap_or(0);
            total_computed += u.enhancement_points.unwrap_or(0);
        }

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
            multi_force,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SAMPLE: &str = "+++++++++++++++++++++++++++++++++++++++++++++++
+ FACTION KEYWORD: Chaos - Chaos Knights
+ DETACHMENT: Houndpack Lance (Marked Prey)
+ TOTAL ARMY POINTS: 2000pts
+
+ WARLORD: Char3: War Dog Executioner
+ ENHANCEMENT: Preyslayer's Mantle (on Batt1: War Dog Karnivore)
+ NUMBER OF UNITS: 16
+ SECONDARY: - Bring It Down: (13x2) - Assassination: 3 Characters
+++++++++++++++++++++++++++++++++++++++++++++++

BATTLELINE

War Dog Executioner (130 pts)
• 1x Armoured feet
• 2x War Dog autocannon
• 1x Diabolus heavy stubber
• Houndpack Lance Character, Warlord

War Dog Karnivore (165 pts)
• 1x Reaper chaintalon
• 1x Slaughterclaw
• Houndpack Lance Character
• Preyslayer's Mantle (+15 pts)

ALLIED UNITS

Nurglings (40 pts)
• 3x Nurgling Swarm
    • 3x Diseased claws and teeth
";

    #[test]
    fn detects_gw_text_but_not_wtc() {
        assert!(GwAdapter.detect(&json!(SAMPLE)));
        // WTC full carries `N with` lines — must not be claimed by GW.
        let wtc = "+ FACTION KEYWORD: Chaos Knights\n\n1x War Dog (150 pts)\n1 with Reaper\n• 1x Reaper\n";
        assert!(!GwAdapter.detect(&json!(wtc)));
        assert!(!GwAdapter.detect(&json!({"roster": {}})));
    }

    #[test]
    fn parses_header_and_units() {
        let parsed = GwAdapter.parse(&json!(SAMPLE)).unwrap();
        assert_eq!(parsed.faction_raw_name.as_deref(), Some("Chaos Knights"));
        assert_eq!(
            parsed.detachment_raw_names,
            vec!["Houndpack Lance".to_string()]
        );
        assert_eq!(parsed.total_reported, Some(2000));
        assert_eq!(parsed.declared_limit, Some(2000));
        assert_eq!(parsed.units.len(), 3);
        assert!(parsed.multi_force);

        let exec = &parsed.units[0];
        assert!(exec.is_warlord);
        assert_eq!(exec.model_count, 1);
        let autocannon = exec
            .wargear
            .iter()
            .find(|w| w.raw_name == "War Dog autocannon")
            .unwrap();
        assert_eq!(autocannon.count, 2);

        let karnivore = &parsed.units[1];
        assert_eq!(
            karnivore.enhancement_raw_name.as_deref(),
            Some("Preyslayer's Mantle")
        );
        assert_eq!(karnivore.enhancement_points, Some(15));
        assert_eq!(karnivore.points, Some(150)); // 165 − 15
        assert!(karnivore.is_character);

        let nurglings = &parsed.units[2];
        assert_eq!(nurglings.model_count, 3);
        assert_eq!(nurglings.wargear.len(), 1);
        assert_eq!(nurglings.wargear[0].raw_name, "Diseased claws and teeth");
        assert_eq!(nurglings.wargear[0].count, 3);
    }
}
