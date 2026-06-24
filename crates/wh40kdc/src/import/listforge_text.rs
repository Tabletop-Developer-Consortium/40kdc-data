//! ListForge plain-text adapter: lower ListForge's copy-paste text export to a
//! [`ParsedRoster`].
//!
//! This is the bullet-list text users copy out of the ListForge app (distinct
//! from the base64+gzip share-JSON the `listforge` adapter handles). Shape:
//!
//! ```text
//! all gas no breaks - Chaos Daemons - Daemonic Incursion (1995 Points)
//!
//! Epic Hero:
//! Rotigus (250 pts)
//!   • Gnarlrod
//!   • Streams of brackish filth
//!
//! Battleline:
//! Bloodletters (110 pts)
//!   • Bloodreaper
//!     • Hellblade
//!   • Daemonic Icon
//!   • 9x Bloodletter
//!     • 9x Hellblade
//! ```
//!
//! - The first non-blank line is `<list name> - <faction> - <detachment>
//!   (<N> Points)`. A list name containing ` - ` breaks the split — a
//!   documented ListForge limitation, not ours.
//! - Sections are mixed-case battlefield-role lines ending with `:`
//!   (`Epic Hero:`, `Character:`, `Battleline:`, …). Units under `Epic Hero:`
//!   or `Character:` are characters.
//! - Bullet classification mirrors the GW adapter: a top-level bullet with
//!   deeper children is a **model group** (its `Nx` count — implicitly 1 —
//!   adds to the model count); without children it's **wargear**. Child-bullet
//!   `Nx` counts are already squad-wide totals; a child without a count is one
//!   item (`• Hellblade` under a lone Bloodreaper).
//! - `E: <name>` is the enhancement annotation (ListForge reports no points for
//!   it, so `enhancement_points` stays null and unit points stay as displayed).
//!   A bare `Warlord` bullet flags the warlord.
//!
//! **Disjointness**: the `(N Points)` first-line suffix is unique to this
//! format — newrecruit-simple's first line ends `- [N pts]`, the GW export
//! opens with a `++++` fence, and the WTC formats carry `N with` lines or no
//! bullets at all.
//!
//! Rust mirror of `tools/src/import/listforge-text.ts`.

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

use super::adapter::{FormatAdapter, ParseError};
use super::newrecruit_text::infer_battle_size_raw;
use super::types::{ParsedRoster, ParsedUnit, ParsedWargear, RosterFormat};

static RE_FIRST_LINE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^(.+)\s\(\s*(\d+)\s*Points?\s*\)\s*$").unwrap());
static RE_SECTION_HEADER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9 /&'-]*:$").unwrap());
static RE_UNIT_HEADER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^(.+?)\s*\(\s*(\d+)\s*pts?\s*\)\s*$").unwrap());
static RE_BULLET_LINE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^([\t ]*)•\s*(.+?)\s*$").unwrap());
static RE_NX_PREFIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(\d+)x\s+(.+)$").unwrap());
static RE_BULLET_ANYWHERE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^[\t ]*•").unwrap());
static RE_WITH_LINE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^[\t ]*\d+\s+with\b").unwrap());

const ENHANCEMENT_PREFIX: &str = "E: ";
const WARLORD_MARKER: &str = "Warlord";

fn is_character_section(heading: &str) -> bool {
    matches!(heading, "epic hero" | "character")
}

/// Accept plain text whose first non-blank line is the ListForge
/// `name - faction - detachment (N Points)` header, with `•` bullets and no
/// WTC `N with` lines.
fn is_listforge_text(decoded: &Value) -> Option<&str> {
    let s = decoded.as_str()?;
    let first_non_blank = s
        .split('\n')
        .map(|l| l.trim_end_matches('\r').trim())
        .find(|l| !l.is_empty())?;
    let first = RE_FIRST_LINE.captures(first_non_blank)?;
    if first[1].split(" - ").count() < 3 {
        return None;
    }
    if !RE_BULLET_ANYWHERE.is_match(s) {
        return None;
    }
    if RE_WITH_LINE.is_match(s) {
        return None;
    }
    Some(s)
}

struct Header {
    name: String,
    faction_raw_name: Option<String>,
    detachment_raw_name: Option<String>,
    total_reported: Option<u64>,
}

fn parse_first_line(line: &str) -> Option<Header> {
    let m = RE_FIRST_LINE.captures(line.trim())?;
    let parts: Vec<&str> = m[1]
        .split(" - ")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if parts.len() < 3 {
        return None;
    }
    // `<list name> - <faction> - <detachment>`; the name is everything before
    // the trailing two segments so faction names with hyphens stay intact only
    // when ListForge itself doesn't insert ` - ` (it doesn't).
    let name = parts[..parts.len() - 2].join(" - ");
    let faction_raw_name = Some(parts[parts.len() - 2].to_string());
    let detachment_raw_name = Some(parts[parts.len() - 1].to_string());
    Some(Header {
        name,
        faction_raw_name,
        detachment_raw_name,
        total_reported: m[2].parse().ok(),
    })
}

struct Bullet {
    indent: usize,
    count: Option<u64>,
    text: String,
}

struct UnitAcc {
    raw_name: String,
    displayed_pts: Option<u64>,
    is_character: bool,
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
    let mut enhancement_raw_name: Option<String> = None;

    for (i, b) in acc.bullets.iter().enumerate() {
        // Child bullet: a model group's weapon. ListForge child counts are
        // squad-wide totals; a count-less child is a single item.
        if b.indent > top_indent {
            add_wargear(&b.text, b.count.unwrap_or(1));
            continue;
        }

        // Top-level annotations.
        if b.count.is_none() {
            if b.text == WARLORD_MARKER {
                is_warlord = true;
                continue;
            }
            if let Some(rest) = b.text.strip_prefix(ENHANCEMENT_PREFIX) {
                if enhancement_raw_name.is_none() {
                    enhancement_raw_name = Some(rest.trim().to_string());
                }
                continue;
            }
        }

        // Top-level entry: a model group when it has child bullets beneath it,
        // otherwise plain wargear. Either way a missing `Nx` count means 1.
        let next_is_child = acc
            .bullets
            .get(i + 1)
            .map(|n| n.indent > b.indent)
            .unwrap_or(false);
        if next_is_child {
            model_count += b.count.unwrap_or(1);
        } else {
            add_wargear(&b.text, b.count.unwrap_or(1));
        }
    }

    if model_count == 0 {
        model_count = 1;
    }

    ParsedUnit {
        raw_name: acc.raw_name,
        is_character: acc.is_character,
        model_count,
        points: acc.displayed_pts,
        is_warlord,
        enhancement_raw_name,
        // ListForge's text export reports no enhancement cost, so the unit's
        // displayed points stay as-is and no enhancement points are claimed.
        enhancement_points: None,
        wargear,
        leader_attachment: None,
    }
}

pub struct ListForgeTextAdapter;

impl FormatAdapter for ListForgeTextAdapter {
    fn format(&self) -> RosterFormat {
        RosterFormat::ListforgeText
    }

    fn detect(&self, decoded: &Value) -> bool {
        is_listforge_text(decoded).is_some()
    }

    fn parse(&self, decoded: &Value) -> Result<ParsedRoster, ParseError> {
        let text = is_listforge_text(decoded).ok_or_else(|| {
            ParseError("listforge-text: input is not a ListForge text export".into())
        })?;

        let lines: Vec<&str> = text.split('\n').map(|l| l.trim_end_matches('\r')).collect();
        let mut header: Option<Header> = None;
        let mut units: Vec<ParsedUnit> = Vec::new();
        let mut current: Option<UnitAcc> = None;
        let mut section_is_character = false;

        for raw in &lines {
            let line = raw.trim();
            if line.is_empty() {
                continue;
            }

            if header.is_none() {
                header = parse_first_line(line);
                if header.is_some() {
                    continue;
                }
            }

            if let Some(c) = RE_BULLET_LINE.captures(raw) {
                if let Some(unit) = current.as_mut() {
                    let indent = c[1].len();
                    let rest = c[2].to_string();
                    let (count, bullet_text) = match RE_NX_PREFIX.captures(&rest) {
                        Some(nx) => (nx[1].parse::<u64>().ok(), nx[2].trim().to_string()),
                        None => (None, rest.trim().to_string()),
                    };
                    unit.bullets.push(Bullet {
                        indent,
                        count,
                        text: bullet_text,
                    });
                }
                continue;
            }

            if RE_SECTION_HEADER.is_match(line) {
                if let Some(unit) = current.take() {
                    units.push(finish_unit(unit));
                }
                let heading = line[..line.len() - 1].trim().to_ascii_lowercase();
                section_is_character = is_character_section(&heading);
                continue;
            }

            if let Some(c) = RE_UNIT_HEADER.captures(line) {
                if let Some(unit) = current.take() {
                    units.push(finish_unit(unit));
                }
                current = Some(UnitAcc {
                    raw_name: c[1].trim().to_string(),
                    displayed_pts: c[2].parse().ok(),
                    is_character: section_is_character,
                    bullets: Vec::new(),
                });
            }
        }

        if let Some(unit) = current.take() {
            units.push(finish_unit(unit));
        }

        let header = header
            .ok_or_else(|| ParseError("listforge-text: missing ListForge header line".into()))?;

        let mut total_computed: u64 = 0;
        for u in &units {
            total_computed += u.points.unwrap_or(0);
        }

        // Like the GW export, ListForge text reports only the army total — use
        // it as the declared limit so battle-size inference stays
        // round-trippable.
        let declared_limit = header.total_reported;

        Ok(ParsedRoster {
            name: header.name,
            generated_by: Some("List Forge".to_string()),
            faction_raw_name: header.faction_raw_name,
            detachment_raw_names: header.detachment_raw_name.into_iter().collect(),
            battle_size_raw: infer_battle_size_raw(declared_limit),
            force_disposition: None,
            declared_limit,
            total_reported: header.total_reported,
            total_computed,
            units,
            multi_force: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Condensed from the reference Chaos Daemons export.
    const SAMPLE: &str = "all gas no breaks - Chaos Daemons - Daemonic Incursion (1995 Points)


Epic Hero:
Rotigus (250 pts)
  • Gnarlrod
  • Streams of brackish filth


Character:
Great Unclean One (295 pts)
  • Putrid vomit
  • Bileblade
  • Bilesword
  • E: The Endless Gift
  • Warlord

Bloodmaster (65 pts)
  • Blade of blood


Battleline:
Bloodletters (110 pts)
  • Bloodreaper
    • Hellblade
  • Instrument of Chaos
  • Daemonic Icon
  • 9x Bloodletter
    • 9x Hellblade


Beast:
Flesh Hounds (75 pts)
  • Gore Hound
    • Burning maw
    • Collar of Khorne
    • Gore-drenched fangs
  • 4x Flesh Hound
    • 4x Collar of Khorne
    • 4x Gore-drenched fangs
";

    #[test]
    fn recognises_the_listforge_text_export() {
        assert!(ListForgeTextAdapter.detect(&json!(SAMPLE)));
    }

    #[test]
    fn rejects_non_string_payloads_and_other_text_formats() {
        assert!(!ListForgeTextAdapter.detect(&json!({ "roster": {} })));
        // newrecruit-simple first line ends `- [N pts]`, not `(N Points)`.
        assert!(!ListForgeTextAdapter.detect(&json!(
            "Chaos - Chaos Knights - List - [2000 pts]\n\n# ++ Army Roster ++ [2000 pts]\nUnit [5 pts]:\n• 1x Model: Gun"
        )));
        // A GW export's first non-blank line is the `++++` fence.
        assert!(!ListForgeTextAdapter.detect(&json!(
            "++++\n+ FACTION KEYWORD: Chaos - Chaos Knights\n++++\nUnit (5 pts)\n• 1x Gun"
        )));
    }

    #[test]
    fn requires_bullets_and_refuses_wtc_with_bodies() {
        let no_bullets = "name - Faction - Detachment (1000 Points)\nUnit (50 pts)";
        assert!(!ListForgeTextAdapter.detect(&json!(no_bullets)));
        let with_lines =
            "name - Faction - Detachment (1000 Points)\nUnit (50 pts)\n  • Gun\n1 with Sword";
        assert!(!ListForgeTextAdapter.detect(&json!(with_lines)));
    }

    #[test]
    fn reads_header_from_the_first_line() {
        let parsed = ListForgeTextAdapter.parse(&json!(SAMPLE)).unwrap();
        assert_eq!(parsed.name, "all gas no breaks");
        assert_eq!(parsed.faction_raw_name.as_deref(), Some("Chaos Daemons"));
        assert_eq!(
            parsed.detachment_raw_names,
            vec!["Daemonic Incursion".to_string()]
        );
        assert_eq!(parsed.total_reported, Some(1995));
        // ListForge reports only the army total — it doubles as the limit.
        assert_eq!(parsed.declared_limit, Some(1995));
        assert_eq!(parsed.generated_by.as_deref(), Some("List Forge"));
    }

    #[test]
    fn captures_units_in_declaration_order() {
        let parsed = ListForgeTextAdapter.parse(&json!(SAMPLE)).unwrap();
        let names: Vec<&str> = parsed.units.iter().map(|u| u.raw_name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "Rotigus",
                "Great Unclean One",
                "Bloodmaster",
                "Bloodletters",
                "Flesh Hounds",
            ]
        );
    }

    #[test]
    fn flags_characters_from_epic_hero_and_character_sections() {
        let parsed = ListForgeTextAdapter.parse(&json!(SAMPLE)).unwrap();
        let by_name = |n: &str| parsed.units.iter().find(|u| u.raw_name == n).unwrap();
        assert!(by_name("Rotigus").is_character);
        assert!(by_name("Great Unclean One").is_character);
        assert!(by_name("Bloodmaster").is_character);
        assert!(!by_name("Bloodletters").is_character);
        assert!(!by_name("Flesh Hounds").is_character);
    }

    #[test]
    fn reads_enhancement_annotation_without_claiming_points() {
        let parsed = ListForgeTextAdapter.parse(&json!(SAMPLE)).unwrap();
        let guo = parsed
            .units
            .iter()
            .find(|u| u.raw_name == "Great Unclean One")
            .unwrap();
        assert_eq!(
            guo.enhancement_raw_name.as_deref(),
            Some("The Endless Gift")
        );
        assert_eq!(guo.enhancement_points, None);
        assert_eq!(guo.points, Some(295)); // displayed points stay as-is
        assert!(guo.is_warlord);
    }

    #[test]
    fn derives_model_counts_from_bulleted_model_groups() {
        let parsed = ListForgeTextAdapter.parse(&json!(SAMPLE)).unwrap();
        let by_name = |n: &str| parsed.units.iter().find(|u| u.raw_name == n).unwrap();
        assert_eq!(by_name("Bloodletters").model_count, 10); // Bloodreaper + 9x
        assert_eq!(by_name("Flesh Hounds").model_count, 5); // Gore Hound + 4x
        assert_eq!(by_name("Rotigus").model_count, 1); // wargear-only bullets
    }

    #[test]
    fn aggregates_squad_wide_wargear_from_child_and_leaf_bullets() {
        let parsed = ListForgeTextAdapter.parse(&json!(SAMPLE)).unwrap();
        let bloodletters = parsed
            .units
            .iter()
            .find(|u| u.raw_name == "Bloodletters")
            .unwrap();
        let gear = |n: &str| {
            bloodletters
                .wargear
                .iter()
                .find(|w| w.raw_name == n)
                .map(|w| w.count)
        };
        assert_eq!(gear("Hellblade"), Some(10)); // 1 (Bloodreaper) + 9 (squad)
        assert_eq!(gear("Instrument of Chaos"), Some(1));
        assert_eq!(gear("Daemonic Icon"), Some(1));
    }

    #[test]
    fn sums_total_computed_from_unit_points() {
        let parsed = ListForgeTextAdapter.parse(&json!(SAMPLE)).unwrap();
        assert_eq!(parsed.total_computed, 250 + 295 + 65 + 110 + 75);
    }
}
