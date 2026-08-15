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
    let mut parts = lead_tokens(u);
    for w in &u.wargear {
        let count = if per_model_divisor > 0 {
            w.count / per_model_divisor
        } else {
            w.count
        };
        parts.push(if count > 1 {
            format!("{count}x {}", w.ref_.raw_name)
        } else {
            w.ref_.raw_name.clone()
        });
    }
    parts.join(", ")
}

fn lead_tokens(u: &RosterUnit) -> Vec<String> {
    let mut parts = Vec::new();
    if let Some(attachment) = &u.leader_attachment {
        let provisional = if attachment.provisional {
            " [provisional]"
        } else {
            ""
        };
        parts.push(format!(
            "Attachment: {} -> {}{provisional}",
            match attachment.role {
                crate::import::AttachmentRole::Leader => "leader",
                crate::import::AttachmentRole::Support => "support",
            },
            attachment.bodyguard_ref.raw_name
        ));
    }
    if let Some(enhancement) = &u.enhancement {
        parts.push(match u.enhancement_points {
            Some(points) => format!("{} [{points} pts]", enhancement.raw_name),
            None => format!("Enhancement: {}", enhancement.raw_name),
        });
    }
    if u.is_warlord {
        parts.push("Warlord".to_string());
    }
    for keyword in &u.keyword_overrides {
        parts.push(if keyword == "Character" {
            "Detachment Character".to_string()
        } else {
            format!("40kdc Keyword: {keyword}")
        });
    }
    parts
}

fn unit_text(u: &RosterUnit) -> Vec<String> {
    let pts = displayed_unit_points(u);
    let pts_text = match pts {
        Some(p) => format!("{p} pts"),
        None => String::new(),
    };

    if u.model_count <= 1 && u.loadout_groups.as_ref().map_or(true, Vec::is_empty) {
        return vec![format!(
            "{} [{pts_text}]: {}",
            u.ref_.raw_name,
            wargear_text(u, 1)
        )];
    }
    if let Some(groups) = u
        .loadout_groups
        .as_ref()
        .filter(|groups| !groups.is_empty())
    {
        let lead = lead_tokens(u);
        let mut lines = vec![format!("{} [{pts_text}]:", u.ref_.raw_name)];
        for (index, group) in groups.iter().enumerate() {
            let name = group.model_name.as_deref().unwrap_or(&u.ref_.raw_name);
            let mut tokens = Vec::new();
            if index == 0 {
                tokens.extend(lead.iter().cloned());
            }
            let weapons = group_weapons_text(&group.wargear);
            if !weapons.is_empty() {
                tokens.push(weapons);
            }
            lines.push(format!(
                "• {}x {}: {}",
                group.count,
                name,
                tokens.join(", ")
            ));
        }
        return lines;
    }
    let divisible = u.model_count > 0
        && u.wargear
            .iter()
            .all(|wargear| wargear.count % u.model_count == 0);
    let loadout = wargear_text(u, if divisible { u.model_count } else { 1 });
    vec![
        format!("{} [{pts_text}]:", u.ref_.raw_name),
        format!(
            "• {}x {}: {}",
            u.model_count,
            u.ref_.raw_name,
            if divisible {
                loadout
            } else {
                format!("Unit total: {loadout}")
            }
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
        lines.push(format!("List Name: {}", roster.name));
        lines.push(format!("Faction: {faction}"));
        if let Some(b) = battle {
            lines.push(format!("Battle Size: {b}"));
        }
        for d in &roster.detachments {
            lines.push(format!("Detachment: {}", d.ref_.raw_name));
        }
        if let Some(disposition) = roster.force_disposition.as_deref() {
            lines.push(format!(
                "Force Disposition: {}",
                title_case_id(Some(disposition)).unwrap_or_else(|| disposition.to_string())
            ));
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
