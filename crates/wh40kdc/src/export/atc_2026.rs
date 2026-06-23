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

use crate::import::{Roster, RosterUnit};

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

    let attach_parts: Vec<String> = units
        .iter()
        .filter_map(|u| {
            u.leader_attachment.as_ref().map(|la| {
                format!(
                    "{} attached to {}",
                    u.ref_.raw_name, la.bodyguard_ref.raw_name
                )
            })
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
