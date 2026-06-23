//! ATC 2026 roster text exporters (`atc-2026-compact` / `atc-2026-full`).
//!
//! These reuse the WTC compact/full *bodies* verbatim (see
//! [`wtc_compact_body_lines`] / [`wtc_full_body_lines`]) but replace the
//! summary header with the block the American Team Championship 2026 list-
//! submission format asks for: player/team identification, the picked Force
//! Disposition, every enhancement-bearing model, and the leader/support
//! attachments spelled out.
//!
//! Provisional and **export-only** — there is no ATC import adapter, so the
//! format is additive. The existing WTC formats (and real-world WTC import)
//! are untouched.
//!
//! Rust mirror of `tools/src/export/atc-2026.ts`.

use std::collections::HashMap;

use crate::import::{AttachmentRole, Roster, RosterUnit};

use super::helpers::{char_slot_assignment, title_case_id, total_army_points};
use super::newrecruit_wtc::{wtc_compact_body_lines, wtc_full_body_lines, FENCE};
use super::{ExportFormat, RosterSerializer};

const DASH: &str = "—";

fn atc_header(roster: &Roster, units: &[RosterUnit], char_slots: &[Option<u32>]) -> String {
    let faction = title_case_id(roster.faction_id.as_deref()).unwrap_or_else(|| "Unknown".into());
    let disposition =
        title_case_id(roster.force_disposition.as_deref()).unwrap_or_else(|| DASH.into());
    let detachment = if roster.detachments.is_empty() {
        DASH.to_string()
    } else {
        roster
            .detachments
            .iter()
            .map(|d| title_case_id(d.ref_.id.as_deref()).unwrap_or_else(|| d.ref_.raw_name.clone()))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let total = roster
        .points
        .total_reported
        .unwrap_or_else(|| total_army_points(roster));

    let warlord = match units.iter().position(|u| u.is_warlord) {
        Some(i) => format!(
            "Char{}: {}",
            char_slots[i].map(|n| n.to_string()).unwrap_or_default(),
            units[i].ref_.raw_name
        ),
        None => DASH.to_string(),
    };

    let enh_parts: Vec<String> = units
        .iter()
        .enumerate()
        .filter_map(|(i, u)| {
            u.enhancement.as_ref().map(|enh| {
                format!(
                    "{} (on Char{}: {})",
                    enh.raw_name,
                    char_slots[i].map(|n| n.to_string()).unwrap_or_default(),
                    u.ref_.raw_name
                )
            })
        })
        .collect();
    let enhancement = if enh_parts.is_empty() {
        DASH.to_string()
    } else {
        enh_parts.join("; ")
    };

    // LEADER/SUPPORT: group attaching characters by the bodyguard unit they
    // join, preserving first-seen order. A leader "leads" the bodyguard; a
    // support character (which cannot operate alone) renders as "supported by".
    struct AttachGroup {
        bodyguard: String,
        leaders: Vec<String>,
        supports: Vec<String>,
    }
    let mut groups: Vec<AttachGroup> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for u in units {
        if let Some(la) = u.leader_attachment.as_ref() {
            let key = la
                .bodyguard_ref
                .id
                .clone()
                .unwrap_or_else(|| la.bodyguard_ref.raw_name.clone());
            let gi = *index.entry(key).or_insert_with(|| {
                groups.push(AttachGroup {
                    bodyguard: la.bodyguard_ref.raw_name.clone(),
                    leaders: Vec::new(),
                    supports: Vec::new(),
                });
                groups.len() - 1
            });
            match la.role {
                AttachmentRole::Support => groups[gi].supports.push(u.ref_.raw_name.clone()),
                AttachmentRole::Leader => groups[gi].leaders.push(u.ref_.raw_name.clone()),
            }
        }
    }
    let attach_parts: Vec<String> = groups
        .iter()
        .map(|g| {
            let mut s = if g.leaders.is_empty() {
                g.bodyguard.clone()
            } else {
                format!("{} leading {}", g.leaders.join(" & "), g.bodyguard)
            };
            if !g.supports.is_empty() {
                s.push_str(&format!(
                    "{} supported by {}",
                    if g.leaders.is_empty() { "" } else { "," },
                    g.supports.join(" & ")
                ));
            }
            s
        })
        .collect();
    let leader_support = if attach_parts.is_empty() {
        DASH.to_string()
    } else {
        attach_parts.join("; ")
    };

    let lines = vec![
        FENCE.to_string(),
        format!("+ PLAYER NAME: {DASH}"),
        format!("+ TEAM NAME: {DASH}"),
        format!("+ FACTIONS USED: {faction}"),
        format!("+ DISPOSITION: {disposition}"),
        format!("+ DETACHMENT: {detachment}"),
        format!("+ ARMY POINTS: {total}pts"),
        "+".to_string(),
        format!("+ WARLORD: {warlord}"),
        format!("+ ENHANCEMENT: {enhancement}"),
        format!("+ LEADER/SUPPORT: {leader_support}"),
        format!("+ NUMBER OF UNITS: {}", units.len()),
        FENCE.to_string(),
    ];
    lines.join("\n")
}

pub struct Atc2026CompactSerializer;

impl RosterSerializer for Atc2026CompactSerializer {
    fn id(&self) -> ExportFormat {
        ExportFormat::Atc2026Compact
    }

    fn serialize(&self, roster: &Roster) -> String {
        let units = &roster.units;
        let slots = char_slot_assignment(units);
        let mut lines: Vec<String> = vec![atc_header(roster, units, &slots)];
        lines.extend(wtc_compact_body_lines(units, &slots));
        let mut out = lines.join("\n");
        out.push('\n');
        out
    }
}

pub struct Atc2026FullSerializer;

impl RosterSerializer for Atc2026FullSerializer {
    fn id(&self) -> ExportFormat {
        ExportFormat::Atc2026Full
    }

    fn serialize(&self, roster: &Roster) -> String {
        let units = &roster.units;
        let slots = char_slot_assignment(units);
        let mut lines: Vec<String> = vec![atc_header(roster, units, &slots)];
        lines.extend(wtc_full_body_lines(
            units,
            &slots,
            roster.faction_id.as_deref(),
        ));
        lines.join("\n")
    }
}
