//! NewRecruit "simple" markdown-ish text adapter.
//!
//! Shape:
//! ```text
//! <breadcrumb> - <faction> - <list name> - [N pts]
//!
//! # ++ Army Roster ++ [N pts]
//! ## Configuration
//! Battle Size: <Label>
//! Detachment: <Name>
//!
//! ## <Section> [N pts]
//! <Unit> [N pts]: <wargear>
//! <Unit> [N pts]:
//! • <count>x <ModelType>[ [N pts]]: <wargear>
//! ```
//!
//! Enhancements are inlined in the wargear list as `<Name> [N pts]` — the
//! only wargear token wearing a `[…]` pts suffix. `Warlord` and `<X>
//! Character` are stripped and become flags.
//!
//! Rust mirror of `tools/src/import/newrecruit-simple.ts`.

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

use super::adapter::{FormatAdapter, ParseError};
use super::newrecruit_text::{classify_wargear_list, split_wargear_list};
use super::types::{ParsedRoster, ParsedUnit, ParsedWargear, RosterFormat};

// Point brackets may carry comma-separated faction resources after the pts
// figure (e.g. `[4485pts, 29Cabal Points]`); the `(?:,[^\]]*)?` tail is
// recognized and discarded — only the pts figure is consumed.
static RE_FIRST_LINE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^(.+)\s-\s\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\]\s*$").unwrap());
static RE_ROSTER_HEADER: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^#\s*\+\+\s*Army Roster\s*\+\+\s*\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\]\s*$")
        .unwrap()
});
static RE_ROSTER_HEADER_SIG: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?im)^#\s*\+\+\s*Army Roster\s*\+\+").unwrap());
// Some exports omit the `# ++ Army Roster ++` line and open straight with a
// `## Section` heading — accept either marker in `detect`.
static RE_SECTION_SIG: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^##\s+").unwrap());
static RE_SECTION_HEADER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^##\s*(.+?)(?:\s*\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\])?\s*$").unwrap());
static RE_UNIT_LINE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(.+?)\s*\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\](?:\s*:\s*(.*))?$").unwrap()
});
static RE_BULLET: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^\s*•\s*(\d+)x\s+(.+?)(?:\s*\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\])?(?:\s*:\s*(.*))?\s*$",
    )
    .unwrap()
});

#[derive(Default)]
struct UnitBuilder {
    raw_name: String,
    is_character: bool,
    is_warlord: bool,
    enhancement_raw_name: Option<String>,
    enhancement_pts: u64,
    displayed_pts: Option<u64>,
    model_count: u64,
    wargear: Vec<(String, u64)>,
}

impl UnitBuilder {
    fn new(name: String, displayed_pts: Option<u64>) -> Self {
        Self {
            raw_name: name,
            displayed_pts,
            model_count: 1,
            ..Default::default()
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

    fn apply_tokens(&mut self, tokens_csv: &str, multiplier: u64) {
        let tokens: Vec<&str> = split_wargear_list(tokens_csv);
        let cls = classify_wargear_list(&tokens);
        if cls.is_warlord {
            self.is_warlord = true;
        }
        if cls.is_character {
            self.is_character = true;
        }
        if let Some(name) = cls.enhancement_raw_name {
            if self.enhancement_raw_name.is_none() {
                self.enhancement_raw_name = Some(name);
                self.enhancement_pts = cls.enhancement_points.unwrap_or(0);
            }
        }
        let scaled: Vec<ParsedWargear> = cls
            .wargear
            .into_iter()
            .map(|w| ParsedWargear {
                raw_name: w.raw_name,
                count: w.count * multiplier,
            })
            .collect();
        self.add_wargear(scaled);
    }

    fn finish(self) -> (ParsedUnit, u64) {
        let points = self
            .displayed_pts
            .map(|p| p.saturating_sub(self.enhancement_pts));
        let enhancement_points = if self.enhancement_raw_name.is_some() {
            Some(self.enhancement_pts)
        } else {
            None
        };
        let wargear: Vec<ParsedWargear> = self
            .wargear
            .into_iter()
            .map(|(raw_name, count)| ParsedWargear { raw_name, count })
            .collect();
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
}

struct FirstLine {
    name: String,
    faction: Option<String>,
    declared_limit: Option<u64>,
}

fn parse_first_line(line: &str) -> Option<FirstLine> {
    let c = RE_FIRST_LINE.captures(line)?;
    let declared_limit: u64 = c[2].parse().ok()?;
    let parts: Vec<&str> = c[1]
        .split(" - ")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        return None;
    }
    let list_name = parts[parts.len() - 1].to_string();
    let faction = if parts.len() >= 2 {
        Some(parts[parts.len() - 2].to_string())
    } else {
        None
    };
    Some(FirstLine {
        name: list_name,
        faction,
        declared_limit: Some(declared_limit),
    })
}

#[derive(Clone, Copy, PartialEq)]
enum Section {
    Preamble,
    Configuration,
    Units,
}

pub struct NewRecruitSimpleAdapter;

impl FormatAdapter for NewRecruitSimpleAdapter {
    fn format(&self) -> RosterFormat {
        RosterFormat::NewrecruitSimple
    }

    fn detect(&self, decoded: &Value) -> bool {
        let Some(text) = decoded.as_str() else {
            return false;
        };
        let first_non_blank = text
            .split('\n')
            .map(|l| l.trim_end_matches('\r').trim())
            .find(|l| !l.is_empty());
        let Some(first) = first_non_blank else {
            return false;
        };
        if !RE_FIRST_LINE.is_match(first) {
            return false;
        }
        // Some exports omit the `# ++ Army Roster ++` line and open straight
        // with a `## Section` heading — accept either marker.
        RE_ROSTER_HEADER_SIG.is_match(text) || RE_SECTION_SIG.is_match(text)
    }

    fn parse(&self, decoded: &Value) -> Result<ParsedRoster, ParseError> {
        let text = decoded
            .as_str()
            .ok_or_else(|| ParseError("newrecruit-simple: input is not a string".into()))?;

        let mut name = String::from("Imported roster");
        let mut faction_raw_name: Option<String> = None;
        let mut declared_limit: Option<u64> = None;
        let mut total_reported: Option<u64> = None;
        let mut detachment_raw_name: Option<String> = None;
        let mut battle_size_raw: Option<String> = None;
        let mut units: Vec<ParsedUnit> = Vec::new();
        let mut enhancement_pts: Vec<u64> = Vec::new();
        let mut current: Option<UnitBuilder> = None;
        let mut multi_force = false;
        let mut section = Section::Preamble;

        let finalize = |current: &mut Option<UnitBuilder>,
                        units: &mut Vec<ParsedUnit>,
                        enhancement_pts: &mut Vec<u64>| {
            if let Some(b) = current.take() {
                let (u, pts) = b.finish();
                enhancement_pts.push(pts);
                units.push(u);
            }
        };

        for raw in text.split('\n') {
            let raw = raw.trim_end_matches('\r');
            let line = raw.trim();
            if line.is_empty() {
                continue;
            }

            if section == Section::Preamble && name == "Imported roster" {
                if let Some(first) = parse_first_line(line) {
                    name = first.name;
                    faction_raw_name = first.faction;
                    declared_limit = first.declared_limit;
                    continue;
                }
            }

            if let Some(c) = RE_ROSTER_HEADER.captures(line) {
                total_reported = c[1].parse().ok();
                continue;
            }

            if let Some(c) = RE_SECTION_HEADER.captures(line) {
                finalize(&mut current, &mut units, &mut enhancement_pts);
                let heading = c[1].trim().to_ascii_lowercase();
                if heading == "configuration" {
                    section = Section::Configuration;
                } else {
                    section = Section::Units;
                    if heading.contains("allied") {
                        multi_force = true;
                    }
                }
                continue;
            }

            if section == Section::Configuration {
                // Some exports list units directly after Configuration with no
                // units section heading; a `Name [N pts]` line ends the
                // configuration block and is processed as a unit below.
                if RE_UNIT_LINE.is_match(line) {
                    section = Section::Units;
                } else {
                    if let Some(idx) = line.find(':') {
                        if idx > 0 {
                            let key = line[..idx].trim().to_ascii_lowercase();
                            let value = line[idx + 1..].trim();
                            if key == "battle size" {
                                battle_size_raw = Some(value.to_string());
                            } else if key == "detachment" {
                                detachment_raw_name = Some(value.to_string());
                            }
                        }
                    }
                    continue;
                }
            }

            // Unit section.
            if let Some(c) = RE_BULLET.captures(raw) {
                if let Some(b) = current.as_mut() {
                    let count: u64 = c[1].parse().unwrap_or(0);
                    if b.wargear.is_empty() && b.model_count == 1 {
                        b.model_count = count;
                    } else {
                        b.model_count += count;
                    }
                    if let Some(m) = c.get(4) {
                        b.apply_tokens(m.as_str(), count);
                    }
                    continue;
                }
            }

            if let Some(c) = RE_UNIT_LINE.captures(line) {
                finalize(&mut current, &mut units, &mut enhancement_pts);
                let unit_name = c[1].trim().to_string();
                let pts: u64 = c[2].parse().unwrap_or(0);
                let mut builder = UnitBuilder::new(unit_name, Some(pts));
                if let Some(inline) = c.get(3) {
                    let inline = inline.as_str().trim();
                    if !inline.is_empty() {
                        builder.apply_tokens(inline, 1);
                    }
                }
                current = Some(builder);
                continue;
            }
        }
        finalize(&mut current, &mut units, &mut enhancement_pts);

        let mut total_computed: u64 = 0;
        for (i, u) in units.iter().enumerate() {
            total_computed += u.points.unwrap_or(0);
            total_computed += enhancement_pts.get(i).copied().unwrap_or(0);
        }

        Ok(ParsedRoster {
            name,
            generated_by: None,
            faction_raw_name,
            detachment_raw_names: detachment_raw_name.into_iter().collect(),
            battle_size_raw,
            force_disposition: None,
            declared_limit,
            total_reported,
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

    const SAMPLE: &str = "Chaos - Chaos Knights - Dog Kill God? - [2000 pts]

# ++ Army Roster ++ [2000 pts]
## Configuration
Battle Size: Strike Force (2000 Point limit)
Detachment: Houndpack Lance
Show/Hide Options: Nurgle Daemons are visible

## Battleline [1855 pts]
War Dog Karnivore [165 pts]: Houndpack Lance Character, Preyslayer's Mantle [15 pts], Reaper chaintalon, Slaughterclaw, Havoc multi-launcher
War Dog Karnivore [150 pts]: Reaper chaintalon, Slaughterclaw, Havoc multi-launcher
War Dog Executioner [130 pts]: Houndpack Lance Character, Warlord, Armoured feet, 2x War Dog autocannon, Diabolus heavy stubber

## Allied Units [145 pts]
Nurglings [40 pts]:
• 3x Nurgling Swarm: Diseased claws and teeth
Beasts of Nurgle [65 pts]:
• 1x Beast of Nurgle [65 pts]: Putrid appendages
";

    #[test]
    fn matches_simple_text_only() {
        assert!(NewRecruitSimpleAdapter.detect(&json!(SAMPLE)));
        assert!(!NewRecruitSimpleAdapter.detect(&json!("+ FACTION KEYWORD: …")));
        assert!(!NewRecruitSimpleAdapter.detect(&json!({ "roster": { "forces": [] } })));
    }

    #[test]
    fn parses_name_faction_limit_and_units() {
        let parsed = NewRecruitSimpleAdapter.parse(&json!(SAMPLE)).unwrap();
        assert_eq!(parsed.name, "Dog Kill God?");
        assert_eq!(parsed.faction_raw_name.as_deref(), Some("Chaos Knights"));
        assert_eq!(parsed.declared_limit, Some(2000));
        assert_eq!(parsed.total_reported, Some(2000));
        assert_eq!(
            parsed.battle_size_raw.as_deref(),
            Some("Strike Force (2000 Point limit)")
        );
        assert_eq!(
            parsed.detachment_raw_names,
            vec!["Houndpack Lance".to_string()]
        );

        let names: Vec<&str> = parsed.units.iter().map(|u| u.raw_name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "War Dog Karnivore",
                "War Dog Karnivore",
                "War Dog Executioner",
                "Nurglings",
                "Beasts of Nurgle",
            ]
        );

        // Inline enhancement is recognised and its cost subtracted from points.
        let kar = &parsed.units[0];
        assert_eq!(
            kar.enhancement_raw_name.as_deref(),
            Some("Preyslayer's Mantle")
        );
        assert_eq!(kar.points, Some(150)); // 165 − 15
        assert!(kar.is_character);
        assert!(!kar.is_warlord);

        // 150 + 15 + 150 + 130 + 40 + 65 = 550
        assert_eq!(parsed.total_computed, 550);
        assert!(parsed.multi_force);
    }

    // --- edge cases (mirror of tools/test/import/newrecruit-simple.test.ts) ---

    #[test]
    fn parses_points_brackets_with_comma_separated_faction_resources() {
        let cabal = "Chaos - Thousand Sons - Tester - [4485pts, 29Cabal Points]

# ++ Army Roster ++ [4485pts, 29Cabal Points]
## Epic Hero [895pts, 13Cabal Points]
Ahriman [140pts, 3Cabal Points]: Black Staff of Ahriman, Inferno bolt pistol
";
        assert!(NewRecruitSimpleAdapter.detect(&json!(cabal)));
        let parsed = NewRecruitSimpleAdapter.parse(&json!(cabal)).unwrap();
        assert_eq!(parsed.declared_limit, Some(4485));
        assert_eq!(parsed.total_reported, Some(4485));
        assert_eq!(parsed.units.len(), 1);
        assert_eq!(parsed.units[0].raw_name, "Ahriman");
        assert_eq!(parsed.units[0].points, Some(140));
    }

    #[test]
    fn matches_exports_that_omit_the_army_roster_line_but_carry_sections() {
        let headerless = "Chaos - World Eaters - Proxy List - [2000pts]

## Epic Hero [675pts]
Angron [435pts]: Samni'arius and Spinegrinder, Warlord
";
        assert!(NewRecruitSimpleAdapter.detect(&json!(headerless)));
        let parsed = NewRecruitSimpleAdapter.parse(&json!(headerless)).unwrap();
        assert_eq!(parsed.faction_raw_name.as_deref(), Some("World Eaters"));
        assert_eq!(parsed.total_reported, None);
        assert_eq!(parsed.units.len(), 1);
        assert!(parsed.units[0].is_warlord);
    }

    #[test]
    fn treats_a_unit_line_directly_after_configuration_as_ending_that_section() {
        let no_units_header = "Xenos - T'au Empire - Base Tau - [2000pts]

# ++ Army Roster ++ [2000pts]
## Configuration
Battle Size: Strike Force (2000 Point limit)
Detachment: Auxiliary Cadre
Show/Hide Options: Legends are visible

Broadside Battlesuits [90pts]:
• 1x Broadside Shas'vre: Crushing bulk, 2x Shield Drone, Heavy rail rifle
Broadside Battlesuits [90pts]:
• 1x Broadside Shas'vre: Crushing bulk, 2x Shield Drone, Heavy rail rifle
";
        let parsed = NewRecruitSimpleAdapter
            .parse(&json!(no_units_header))
            .unwrap();
        assert_eq!(
            parsed.detachment_raw_names,
            vec!["Auxiliary Cadre".to_string()]
        );
        assert_eq!(parsed.units.len(), 2);
        assert_eq!(parsed.units[0].raw_name, "Broadside Battlesuits");
        assert_eq!(parsed.units[0].model_count, 1);
        let gear = |n: &str| {
            parsed.units[0]
                .wargear
                .iter()
                .find(|w| w.raw_name == n)
                .map(|w| w.count)
        };
        assert_eq!(gear("Shield Drone"), Some(2));
        assert_eq!(gear("Heavy rail rifle"), Some(1));
    }
}
