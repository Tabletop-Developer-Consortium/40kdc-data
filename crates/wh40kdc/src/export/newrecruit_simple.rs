//! NewRecruit "simple" markdown-ish text exporter.
//!
//! Shape:
//! ```text
//! <faction> - <list name> - [N pts]
//!
//! # ++ Army Roster ++ [N pts]
//! ## Configuration
//! Battle Size: <Label>
//! Detachment: <Name>
//!
//! ## Battleline [N pts]
//! <Unit> [pts]: <wargear, …, EnhName [N pts], …>
//! <Multi-Unit> [pts]:
//! • <Nx> <ModelType>: <wargear>
//! ```
//!
//! Enhancements are inlined as `Name [N pts]` (the only place we re-emit a
//! `[N pts]` bracket on a token).
//!
//! Rust mirror of `tools/src/export/newrecruit-simple.ts`.

use crate::import::{BattleSize, Roster, RosterUnit};

use super::helpers::{displayed_unit_points, group_weapons_text, title_case_id, total_army_points};
use super::{ExportFormat, RosterSerializer};

fn battle_size_label(roster: &Roster) -> Option<String> {
    match roster.battle_size? {
        BattleSize::StrikeForce => Some(format!(
            "Strike Force ({} Point limit)",
            roster.points.declared_limit.unwrap_or(2000)
        )),
        BattleSize::Incursion => Some(format!(
            "Incursion ({} Point limit)",
            roster.points.declared_limit.unwrap_or(1000)
        )),
    }
}

/// Build the wargear list inline. For homogeneous multi-model units,
/// divides counts by `per_model_divisor` so the per-model render is clean.
fn wargear_text(u: &RosterUnit, per_model_divisor: u64) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(enh) = &u.enhancement {
        let pts_tag = match u.enhancement_points {
            Some(p) => format!(" [{p} pts]"),
            None => String::new(),
        };
        parts.push(format!("{}{pts_tag}", enh.raw_name));
    }
    if u.is_warlord {
        parts.push("Warlord".to_string());
    }
    for w in &u.wargear {
        let c = if per_model_divisor > 0 {
            w.count / per_model_divisor
        } else {
            w.count
        };
        if c > 1 {
            parts.push(format!("{c}x {}", w.ref_.raw_name));
        } else {
            parts.push(w.ref_.raw_name.clone());
        }
    }
    parts.join(", ")
}

/// Unit-level tokens that lead the first wargear line: the enhancement then `Warlord`.
fn lead_tokens(u: &RosterUnit) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(enh) = &u.enhancement {
        let pts_tag = match u.enhancement_points {
            Some(p) => format!(" [{p} pts]"),
            None => String::new(),
        };
        parts.push(format!("{}{pts_tag}", enh.raw_name));
    }
    if u.is_warlord {
        parts.push("Warlord".to_string());
    }
    parts
}

fn unit_text(u: &RosterUnit) -> Vec<String> {
    let pts = displayed_unit_points(u);
    let pts_text = match pts {
        Some(p) => format!("{p} pts"),
        None => String::new(),
    };

    if u.model_count <= 1 {
        return vec![format!(
            "{} [{pts_text}]: {}",
            u.ref_.raw_name,
            wargear_text(u, 1)
        )];
    }
    // Multi-model with an exact per-model breakdown: one bullet per model-type group,
    // each named, with the enhancement/Warlord tokens leading the first group.
    if let Some(groups) = u.loadout_groups.as_ref() {
        if !groups.is_empty() {
            let lead = lead_tokens(u);
            let mut lines = vec![format!("{} [{pts_text}]:", u.ref_.raw_name)];
            for (i, g) in groups.iter().enumerate() {
                let name = g.model_name.as_deref().unwrap_or(&u.ref_.raw_name);
                let weapons = group_weapons_text(&g.wargear);
                let mut tokens: Vec<String> = Vec::new();
                if i == 0 {
                    tokens.extend(lead.iter().cloned());
                }
                if !weapons.is_empty() {
                    tokens.push(weapons);
                }
                lines.push(format!("• {}x {}: {}", g.count, name, tokens.join(", ")));
            }
            return lines;
        }
    }
    // No exact breakdown: homogeneous units divide cleanly; otherwise a single bullet
    // with the full counts (the legacy fallback, unit-named).
    let divisor = if u
        .wargear
        .iter()
        .all(|w| u.model_count > 0 && w.count % u.model_count == 0)
    {
        u.model_count
    } else {
        1
    };
    vec![
        format!("{} [{pts_text}]:", u.ref_.raw_name),
        format!(
            "• {}x {}: {}",
            u.model_count,
            u.ref_.raw_name,
            wargear_text(u, divisor)
        ),
    ]
}

pub struct NewRecruitSimpleSerializer;

impl RosterSerializer for NewRecruitSimpleSerializer {
    fn id(&self) -> ExportFormat {
        ExportFormat::NewrecruitSimple
    }

    fn serialize(&self, roster: &Roster) -> String {
        let faction =
            title_case_id(roster.faction_id.as_deref()).unwrap_or_else(|| "Unknown".to_string());
        let battle = battle_size_label(roster);
        let total = total_army_points(roster);
        let limit = roster.points.declared_limit.unwrap_or(total);

        let mut lines: Vec<String> = Vec::new();
        lines.push(format!("{faction} - {} - [{limit} pts]", roster.name));
        lines.push(String::new());
        lines.push(format!("# ++ Army Roster ++ [{total} pts]"));
        lines.push("## Configuration".to_string());
        if let Some(b) = battle {
            lines.push(format!("Battle Size: {b}"));
        }
        for d in &roster.detachments {
            let display =
                title_case_id(d.ref_.id.as_deref()).unwrap_or_else(|| d.ref_.raw_name.clone());
            lines.push(format!("Detachment: {display}"));
        }
        lines.push(String::new());

        let section_total: u64 = roster
            .units
            .iter()
            .map(|u| u.points.unwrap_or(0) + u.enhancement_points.unwrap_or(0))
            .sum();
        lines.push(format!("## Battleline [{section_total} pts]"));
        for u in &roster.units {
            lines.extend(unit_text(u));
        }

        let mut out = lines.join("\n");
        out.push('\n');
        out
    }
}
