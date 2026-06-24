//! Headerless plain-text adapter: the GW 40K app's *exported* list (no
//! `++…++` / `+ FACTION KEYWORD:` summary fence), the NewRecruit "copy as
//! text" dialect, and the markdown-ish `## Section (N pts)` shape hand-authored
//! lists use. All three share one body grammar; they differ only in cosmetic
//! framing, so a single lenient parser covers them.
//!
//! Shape (any of):
//! ```text
//! <list name> (1995 Points)            ← title line (consumed, not a unit)
//! World Eaters                         ← faction / detachment / battle-size preamble (skipped)
//! Strike Force (2,000 Points)
//!
//! CHARACTERS                           ← ALL-CAPS role section …
//! ## Battleline (200 pts)              ← … or `##` markdown section …
//! Epic Hero:                           ← … or `Title:` colon section
//!
//! Khârn the Betrayer (100 Points)      ← unit header: Name (N pts|Points)
//!   • Warlord                          ← annotation
//!   • 1x Gorechild                     ← Nx wargear (single-model unit)
//!   • Enhancements: Berzerker Glaive   ← enhancement
//! Khorne Berzerkers (180 Points)
//!   • 9x Khorne Berzerker              ← model group (has ◦ children) …
//!      ◦ 8x Bolt pistol                ← … children are squad-wide wargear
//!   • 4x Intercessor: Bolt rifle       ← model group (colon wargear, no children)
//! ```
//!
//! **Model vs wargear** (the crux), unified across dialects: a top-level bullet
//! is a *model group* when it carries a `: wargear` colon **or** is followed by
//! deeper-indented child bullets; its `Nx` count (default 1) adds to the model
//! count. Otherwise it is plain wargear (an `Nx`/bare item) or an annotation
//! (`Warlord`, `… Character`, `Enhancements: …`).
//!
//! **Disjointness**: this adapter is the fallback for bullet-bearing text that
//! the framed adapters reject — it declines input carrying the GW
//! `+ FACTION KEYWORD:` fence (→ [`GwAdapter`](super::gw)), the NewRecruit
//! `# ++ Army Roster ++` header (→ [`NewRecruitSimpleAdapter`]), or WTC
//! `N with` body lines, and requires at least one `•` bullet.

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

use super::adapter::{FormatAdapter, ParseError};
use super::newrecruit_text::infer_battle_size_raw;
use super::types::{ParsedRoster, ParsedUnit, ParsedWargear, RosterFormat};

const CHARACTERS_SECTION: &str = "CHARACTERS";
const ALLIED_SECTION: &str = "ALLIED UNITS";
const CHARACTER_SUFFIX: &str = " Character";
const WARLORD_MARKER: &str = "Warlord";

/// Title / unit header: `Name (N pts|Points)` with an optional trailing comment
/// (the GW export sometimes appends TO notes). Points may carry thousands
/// commas. Case-insensitive `pts`/`points`.
static RE_PTS_LINE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^(.+?)\s*\(\s*([\d,]+)\s*(?:pts?|points?)\s*\).*$").unwrap());
/// `## Section [ (N pts) ]` markdown header.
static RE_MD_SECTION: Lazy<Regex> = Lazy::new(|| Regex::new(r"^#{1,6}\s*(.+?)\s*$").unwrap());
/// ALL-CAPS role section (`CHARACTERS`, `OTHER DATASHEETS`, …).
static RE_CAPS_SECTION: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Z][A-Z0-9 \-/&]+$").unwrap());
/// `Title:` colon section (`Epic Hero:`, `Battleline:`).
static RE_COLON_SECTION: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^([A-Za-z][\w /&-]*):\s*$").unwrap());
/// Bullet line: leading indent, a `•` or `◦` marker, then the body.
static RE_BULLET: Lazy<Regex> = Lazy::new(|| Regex::new(r"^([\t ]*)[•◦]\s*(.+?)\s*$").unwrap());
static RE_NX_PREFIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^(\d+)x\s+(.+)$").unwrap());
/// Inline enhancement annotation: `Name (+N pts)`.
static RE_ENHANCEMENT_ANNOT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^(.+?)\s*\(\+\s*(\d+)\s*pts?\s*\)\s*$").unwrap());
/// `Enhancements: X` / `E: X` enhancement bullet.
static RE_ENHANCEMENT_LABEL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^(?:e|enh|enhancement|enhancements)\s*:\s*(.+)$").unwrap());
static RE_WITH_LINE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^[\t ]*\d+\s+with\b").unwrap());
static RE_BULLET_ANYWHERE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^[\t ]*[•◦]").unwrap());

/// Battle-size labels that look like unit headers (`Strike Force (2,000 Points)`)
/// but are army metadata, not datasheets.
const BATTLE_SIZE_NAMES: &[&str] = &["combat patrol", "incursion", "strike force", "onslaught"];

fn parse_pts(raw: &str) -> Option<u64> {
    raw.replace(',', "").parse().ok()
}

/// Accept bullet-bearing plain text that no framed adapter claims.
fn headerless_text(decoded: &Value) -> Option<&str> {
    let s = decoded.as_str()?;
    if !RE_BULLET_ANYWHERE.is_match(s) {
        return None; // need at least one bullet to be this family
    }
    if s.contains("+ FACTION KEYWORD:") {
        return None; // framed GW export → GwAdapter
    }
    if RE_WITH_LINE.is_match(s) {
        return None; // WTC-full
    }
    // NewRecruit `# ++ Army Roster ++` → NewRecruitSimpleAdapter.
    if s.lines().any(|l| {
        let t = l.trim();
        t.starts_with("# ++") && t.contains("Army Roster")
    }) {
        return None;
    }
    // Require a `Name (N pts|Points)` line somewhere — the unit/title signature.
    s.lines()
        .any(|l| RE_PTS_LINE.is_match(l.trim()))
        .then_some(s)
}

#[derive(Clone)]
struct Bullet {
    indent: usize,
    count: Option<u64>,
    /// Model/wargear name (after any `Nx` and before any `: wargear`).
    name: String,
    /// Comma-separated wargear listed after a `:` on a model bullet.
    colon_wargear: Option<String>,
    /// True for `Warlord` / `… Character` / `Enhancements:` annotations.
    is_annotation: bool,
    enhancement: Option<(String, Option<u64>)>,
}

struct UnitAcc {
    raw_name: String,
    displayed_pts: Option<u64>,
    is_character_section: bool,
    bullets: Vec<Bullet>,
}

fn parse_bullet(indent: usize, body: &str) -> Bullet {
    // Enhancement label first — `Enhancements: X` must not read as a model.
    if let Some(c) = RE_ENHANCEMENT_LABEL.captures(body) {
        return Bullet {
            indent,
            count: None,
            name: String::new(),
            colon_wargear: None,
            is_annotation: true,
            enhancement: Some((c[1].trim().to_string(), None)),
        };
    }

    let (count, rest) = match RE_NX_PREFIX.captures(body) {
        Some(nx) => (nx[1].parse::<u64>().ok(), nx[2].trim().to_string()),
        None => (None, body.trim().to_string()),
    };

    // `Name (+N pts)` enhancement annotation.
    if let Some(c) = RE_ENHANCEMENT_ANNOT.captures(&rest) {
        return Bullet {
            indent,
            count,
            name: rest.clone(),
            colon_wargear: None,
            is_annotation: true,
            enhancement: Some((c[1].trim().to_string(), c[2].parse().ok())),
        };
    }

    // `ModelType: w1, w2` — a model bullet with inline wargear.
    if let Some(idx) = rest.find(':') {
        let (model, wargear) = rest.split_at(idx);
        let wargear = wargear[1..].trim();
        return Bullet {
            indent,
            count,
            name: model.trim().to_string(),
            colon_wargear: (!wargear.is_empty()).then(|| wargear.to_string()),
            is_annotation: false,
            enhancement: None,
        };
    }

    // Bare token: annotation iff it has no count (Warlord / Character / wargear).
    Bullet {
        indent,
        count,
        name: rest,
        colon_wargear: None,
        is_annotation: count.is_none(),
        enhancement: None,
    }
}

fn finish_unit(acc: UnitAcc) -> ParsedUnit {
    let top_indent = acc.bullets.iter().map(|b| b.indent).min().unwrap_or(0);

    let mut wargear: Vec<ParsedWargear> = Vec::new();
    let mut add_wargear = |raw_name: &str, count: u64| {
        let raw_name = raw_name.trim();
        if raw_name.is_empty() {
            return;
        }
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
    let mut is_character = acc.is_character_section;
    let mut enhancement_raw_name: Option<String> = None;
    let mut enhancement_points: Option<u64> = None;

    for (i, b) in acc.bullets.iter().enumerate() {
        // Child bullet: a model group's squad-wide wargear (count already total).
        if b.indent > top_indent {
            add_wargear(&b.name, b.count.unwrap_or(1));
            continue;
        }

        // Enhancement annotation (`Enhancements: X` or `X (+N pts)`).
        if let Some((name, pts)) = &b.enhancement {
            if enhancement_raw_name.is_none() {
                enhancement_raw_name = Some(name.clone());
                enhancement_points = *pts;
            }
            continue;
        }

        // Model with inline `: wargear` (the `##`/fixture dialect).
        if let Some(csv) = &b.colon_wargear {
            let n = b.count.unwrap_or(1);
            model_count += n;
            for item in csv.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                add_wargear(item, n);
            }
            continue;
        }

        // Model group: top-level bullet followed by deeper child bullets.
        let next_is_child = acc
            .bullets
            .get(i + 1)
            .map(|n| n.indent > top_indent)
            .unwrap_or(false);
        if next_is_child {
            model_count += b.count.unwrap_or(1);
            continue;
        }

        // Annotation (no count): Warlord / Character flags, else bare wargear.
        if b.is_annotation {
            let mut leftover: Vec<&str> = Vec::new();
            for token in b.name.split(',').map(str::trim).filter(|t| !t.is_empty()) {
                if token == WARLORD_MARKER {
                    is_warlord = true;
                } else if token.ends_with(CHARACTER_SUFFIX) {
                    is_character = true;
                } else {
                    leftover.push(token);
                }
            }
            for token in leftover {
                add_wargear(token, 1);
            }
            continue;
        }

        // Plain `Nx` wargear on a single-model unit.
        add_wargear(&b.name, b.count.unwrap_or(1));
    }

    if model_count == 0 {
        model_count = 1;
    }

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

fn is_battle_size(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    BATTLE_SIZE_NAMES.iter().any(|b| lower == *b)
}

pub struct GwHeaderlessAdapter;

impl FormatAdapter for GwHeaderlessAdapter {
    fn format(&self) -> RosterFormat {
        // Provenance: a GW-family plain-text export. Reuses the `gw` enum value
        // so no schema/codegen churn is needed for a new label.
        RosterFormat::Gw
    }

    fn detect(&self, decoded: &Value) -> bool {
        headerless_text(decoded).is_some()
    }

    fn parse(&self, decoded: &Value) -> Result<ParsedRoster, ParseError> {
        let text = headerless_text(decoded)
            .ok_or_else(|| ParseError("gw-headerless: not a headerless plain-text list".into()))?;

        let mut name = String::from("Imported roster");
        let mut declared_limit: Option<u64> = None;
        let mut battle_size_raw: Option<String> = None;
        let mut units: Vec<ParsedUnit> = Vec::new();
        let mut current: Option<UnitAcc> = None;
        let mut section: Option<String> = None;
        let mut allied = 0u64;
        let mut consumed_title = false;
        // The GW app export lists faction then detachment as bare lines between
        // the title and the first section (`World Eaters` / `Berzerker Warband`).
        // Capture the first two so `resolve` can scope to them; later bare lines
        // (stray notes) are ignored.
        let mut faction_raw_name: Option<String> = None;
        let mut detachment_raw_names: Vec<String> = Vec::new();

        let flush = |current: &mut Option<UnitAcc>, units: &mut Vec<ParsedUnit>| {
            if let Some(u) = current.take() {
                units.push(finish_unit(u));
            }
        };

        for raw in text.split('\n') {
            let raw = raw.trim_end_matches('\r');
            let line = raw.trim();
            if line.is_empty() {
                continue;
            }

            // Bullets attach to the open unit.
            if let Some(c) = RE_BULLET.captures(raw) {
                if let Some(unit) = current.as_mut() {
                    unit.bullets.push(parse_bullet(c[1].len(), &c[2]));
                }
                continue;
            }

            // GW export footer.
            if line.starts_with("Exported with") {
                continue;
            }

            // `## Section` markdown header (strip an optional `(N pts)` tail).
            if let Some(c) = RE_MD_SECTION.captures(line) {
                flush(&mut current, &mut units);
                let heading = RE_PTS_LINE
                    .captures(&c[1])
                    .map(|p| p[1].trim().to_string())
                    .unwrap_or_else(|| c[1].trim().to_string());
                section = Some(heading);
                continue;
            }

            // First `Name (N pts|Points)` line is the roster title, not a unit.
            if let Some(c) = RE_PTS_LINE.captures(line) {
                let header_name = c[1].trim().to_string();
                let pts = parse_pts(&c[2]);
                if !consumed_title && current.is_none() && units.is_empty() {
                    consumed_title = true;
                    name = header_name;
                    declared_limit = pts;
                    continue;
                }
                // Battle-size metadata (`Strike Force (2,000 Points)`).
                if is_battle_size(&header_name) {
                    battle_size_raw = Some(line.to_string());
                    if declared_limit.is_none() {
                        declared_limit = pts;
                    }
                    continue;
                }
                // A real unit header.
                flush(&mut current, &mut units);
                let in_chars = section
                    .as_deref()
                    .map(|s| s.eq_ignore_ascii_case(CHARACTERS_SECTION))
                    .unwrap_or(false);
                if section.as_deref() == Some(ALLIED_SECTION) {
                    allied += 1;
                }
                current = Some(UnitAcc {
                    raw_name: header_name,
                    displayed_pts: pts,
                    is_character_section: in_chars,
                    bullets: Vec::new(),
                });
                continue;
            }

            // Section headers without points (ALL-CAPS role, `Title:` colon).
            if RE_CAPS_SECTION.is_match(line) || RE_COLON_SECTION.is_match(line) {
                flush(&mut current, &mut units);
                let heading = line.trim_end_matches(':').trim().to_string();
                section = Some(heading);
                continue;
            }

            // Anything else (faction/detachment preamble, stray notes).
            if !consumed_title && current.is_none() && units.is_empty() {
                // Very first content line with no `(N pts)` title → use as name.
                consumed_title = true;
                name = line.to_string();
            } else if current.is_none() && units.is_empty() {
                // Preamble after the title, before the first unit: faction then
                // detachment. Names are resolved (and warned on miss) downstream.
                if faction_raw_name.is_none() {
                    faction_raw_name = Some(line.to_string());
                } else if detachment_raw_names.is_empty() {
                    detachment_raw_names.push(line.to_string());
                }
            }
        }
        flush(&mut current, &mut units);

        let total_computed: u64 = units
            .iter()
            .map(|u| u.points.unwrap_or(0) + u.enhancement_points.unwrap_or(0))
            .sum();

        if battle_size_raw.is_none() {
            battle_size_raw = infer_battle_size_raw(declared_limit);
        }

        Ok(ParsedRoster {
            name,
            generated_by: None,
            faction_raw_name,
            detachment_raw_names,
            battle_size_raw,
            force_disposition: None,
            declared_limit,
            total_reported: None,
            total_computed,
            units,
            multi_force: allied > 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // GW app export (world-eaters dialect): `(N Points)`, ALL-CAPS sections,
    // `◦` child wargear, single-model characters with bare/`Nx` wargear.
    const GW_APP: &str = "Ding dong (1995 Points)

World Eaters
Berzerker Warband
Strike Force (2,000 Points)

CHARACTERS

Khârn the Betrayer (100 Points)
  • Warlord
  • 1x Gorechild
  • 1x Plasma pistol

Master of Executions (95 Points)
  • 1x Axe of dismemberment
  • Enhancements: Berzerker Glaive

BATTLELINE

Khorne Berzerkers (180 Points)
  • 1x Khorne Berzerker Champion
     ◦ 1x Chainblade
  • 9x Khorne Berzerker
     ◦ 8x Bolt pistol
     ◦ 7x Chainblade

Exported with App Version: v1.48.0 (1), Data Version: v750
";

    // Markdown `##` fixture dialect: `(N pts)`, `• Nx Model: wargear`.
    const MD_FIXTURE: &str = "Test Army - Space Marines - Gladius Task Force (300 pts)

## Battleline (200 pts)
Intercessor Squad (200 pts)
  • 4x Intercessor: Bolt rifle
  • Intercessor Sergeant: Bolt rifle
";

    // NewRecruit text dialect: `Title:` sections, deeper-`•` children.
    const NR_TEXT: &str = "all gas no breaks - Chaos Daemons - Daemonic Incursion (1995 Points)

Character:
Bloodmaster (65 pts)
  • Blade of blood

Battleline:
Bloodletters (110 pts)
  • Bloodreaper
    • Hellblade
  • Instrument of Chaos
  • 9x Bloodletter
    • 9x Hellblade
";

    #[test]
    fn detects_only_headerless_bullet_text() {
        assert!(GwHeaderlessAdapter.detect(&json!(GW_APP)));
        assert!(GwHeaderlessAdapter.detect(&json!(MD_FIXTURE)));
        assert!(GwHeaderlessAdapter.detect(&json!(NR_TEXT)));
        // Framed GW export belongs to GwAdapter.
        assert!(!GwHeaderlessAdapter.detect(&json!("+ FACTION KEYWORD: X\n\nU (1 pts)\n• 1x W\n")));
        // No bullets → not this family.
        assert!(!GwHeaderlessAdapter.detect(&json!("U (100 pts)\n")));
        assert!(!GwHeaderlessAdapter.detect(&json!({"roster": {}})));
    }

    #[test]
    fn parses_gw_app_export() {
        let p = GwHeaderlessAdapter.parse(&json!(GW_APP)).unwrap();
        assert_eq!(p.name, "Ding dong");
        // Faction / detachment are read from the bare preamble lines.
        assert_eq!(p.faction_raw_name.as_deref(), Some("World Eaters"));
        assert_eq!(
            p.detachment_raw_names,
            vec!["Berzerker Warband".to_string()]
        );
        assert_eq!(p.units.len(), 3);

        let kharn = &p.units[0];
        assert_eq!(kharn.raw_name, "Khârn the Betrayer");
        assert!(kharn.is_warlord);
        assert!(kharn.is_character); // CHARACTERS section
        assert_eq!(kharn.model_count, 1);
        assert!(kharn.wargear.iter().any(|w| w.raw_name == "Gorechild"));

        let moe = &p.units[1];
        assert_eq!(
            moe.enhancement_raw_name.as_deref(),
            Some("Berzerker Glaive")
        );

        let zerks = &p.units[2];
        assert_eq!(zerks.model_count, 10); // 1 champion + 9
        let bolt = zerks
            .wargear
            .iter()
            .find(|w| w.raw_name == "Bolt pistol")
            .unwrap();
        assert_eq!(bolt.count, 8);
    }

    #[test]
    fn parses_md_fixture_model_count() {
        let p = GwHeaderlessAdapter.parse(&json!(MD_FIXTURE)).unwrap();
        assert_eq!(p.units.len(), 1);
        let squad = &p.units[0];
        assert_eq!(squad.raw_name, "Intercessor Squad");
        assert_eq!(squad.model_count, 5); // 4 + 1
        let bolt = squad
            .wargear
            .iter()
            .find(|w| w.raw_name == "Bolt rifle")
            .unwrap();
        assert_eq!(bolt.count, 5);
    }

    #[test]
    fn parses_nr_text_dialect() {
        let p = GwHeaderlessAdapter.parse(&json!(NR_TEXT)).unwrap();
        assert_eq!(p.units.len(), 2);
        let bloodmaster = &p.units[0];
        assert_eq!(bloodmaster.model_count, 1);
        assert!(bloodmaster
            .wargear
            .iter()
            .any(|w| w.raw_name == "Blade of blood"));
        let letters = &p.units[1];
        assert_eq!(letters.model_count, 10); // Bloodreaper + 9 Bloodletter
        assert!(letters.wargear.iter().any(|w| w.raw_name == "Hellblade"));
    }
}
