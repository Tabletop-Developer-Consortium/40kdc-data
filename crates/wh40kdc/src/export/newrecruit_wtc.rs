//! NewRecruit wtc-compact and wtc-full text exporters.
//!
//! Both formats lead with a `++++++++` summary header and then list units.
//! The compact body packs each unit onto one line; the full body uses
//! section headers (`BATTLELINE` / `ALLIED UNITS`) and two-line unit blocks
//! with `N with <wargear>` and `• Nx <ModelType>` per-model breakdowns.
//!
//! Faction & detachment display names are reconstructed via
//! [`title_case_id`]. `CharN:` numbering is re-derived heuristically from
//! `is_warlord || enhancement || leader_attachment` (see
//! [`char_slot_assignment`]).
//!
//! Rust mirror of `tools/src/export/newrecruit-wtc.ts`.

use crate::import::{Roster, RosterUnit};

use super::helpers::{
    char_slot_assignment, coarsened_loadout_groups, displayed_unit_points, group_weapons_text,
    title_case_id, total_army_points,
};
use super::{ExportFormat, RosterSerializer};

pub(super) const FENCE: &str = "+++++++++++++++++++++++++++++++++++++++++++++++";

pub(super) fn keyword_tokens(unit: &RosterUnit) -> Vec<String> {
    unit.keyword_overrides
        .iter()
        .map(|keyword| {
            if keyword == "Character" {
                "Detachment Character".to_string()
            } else {
                format!("40kdc Keyword: {keyword}")
            }
        })
        .collect()
}

pub(super) fn attachment_token(unit: &RosterUnit) -> Option<String> {
    let attachment = unit.leader_attachment.as_ref()?;
    let role = match attachment.role {
        crate::import::AttachmentRole::Leader => "leader",
        crate::import::AttachmentRole::Support => "support",
    };
    Some(format!(
        "Attachment: {role} -> {}{}",
        attachment.bodyguard_ref.raw_name,
        if attachment.provisional {
            " [provisional]"
        } else {
            ""
        }
    ))
}

pub(super) fn wargear_list_text(unit: &RosterUnit, include_warlord_tag: bool) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(unit.wargear.len() + 1);
    for w in &unit.wargear {
        parts.push(if w.count > 1 {
            format!("{}x {}", w.count, w.ref_.raw_name)
        } else {
            w.ref_.raw_name.clone()
        });
    }
    if include_warlord_tag && unit.is_warlord {
        parts.push("Warlord".to_string());
    }
    parts.extend(keyword_tokens(unit));
    parts.join(", ")
}

fn header(roster: &Roster, units: &[RosterUnit], char_slots: &[Option<u32>]) -> String {
    let faction = title_case_id(roster.faction_id.as_deref()).unwrap_or_else(|| "Unknown".into());
    let detachment_lines: Vec<String> = if roster.detachments.is_empty() {
        vec!["+ DETACHMENT: —".to_string()]
    } else {
        roster
            .detachments
            .iter()
            .map(|d| format!("+ DETACHMENT: {}", d.ref_.raw_name))
            .collect()
    };
    let limit = roster
        .points
        .declared_limit
        .unwrap_or_else(|| total_army_points(roster));
    let total = roster
        .points
        .total_reported
        .unwrap_or_else(|| total_army_points(roster));

    let warlord_idx = units.iter().position(|u| u.is_warlord);
    let warlord = match warlord_idx {
        Some(i) => format!(
            "Char{}: {}",
            char_slots[i].map(|n| n.to_string()).unwrap_or_default(),
            units[i].ref_.raw_name
        ),
        None => "—".to_string(),
    };

    let enhancement_idx = units.iter().position(|u| u.enhancement.is_some());
    let enhancement = match enhancement_idx {
        Some(i) => {
            let u = &units[i];
            let enh = u.enhancement.as_ref().expect("enhancement present");
            format!(
                "{} (on Char{}: {})",
                enh.raw_name,
                char_slots[i].map(|n| n.to_string()).unwrap_or_default(),
                u.ref_.raw_name
            )
        }
        None => "—".to_string(),
    };

    let mut lines = vec![
        FENCE.to_string(),
        format!("+ LIST NAME: {}", roster.name),
        format!("+ FACTION KEYWORD: {faction}"),
    ];
    lines.extend(detachment_lines);
    if let Some(disp) = title_case_id(roster.force_disposition.as_deref()) {
        lines.push(format!("+ FORCE DISPOSITION: {disp}"));
    }
    lines.extend([
        format!("+ TOTAL ARMY POINTS: {total}pts"),
        format!("+ POINTS LIMIT: {limit}pts"),
        "+".to_string(),
        format!("+ WARLORD: {warlord}"),
        format!("+ ENHANCEMENT: {enhancement}"),
        format!("+ NUMBER OF UNITS: {}", units.len()),
        FENCE.to_string(),
    ]);
    lines.join("\n")
}

/// Heuristic: the Roster doesn't tag allied units explicitly, so wtc-full
/// export collapses everything to a single BATTLELINE section — matches the
/// TS behavior.
fn is_allied_unit(_u: &RosterUnit, _faction_id: Option<&str>) -> bool {
    false
}

/// The compact body — one line per unit, wargear inline — that follows the
/// summary header. Returned as the lines *after* the header (the leading empty
/// separator included) so any header variant (WTC or ATC 2026) can prepend its
/// own block. Compact callers append a trailing newline.
pub(super) fn wtc_compact_body_lines(units: &[RosterUnit], slots: &[Option<u32>]) -> Vec<String> {
    let mut lines: Vec<String> = vec![String::new()];
    for (i, u) in units.iter().enumerate() {
        let prefix = match slots[i] {
            Some(n) => format!("Char{n}: "),
            None => String::new(),
        };
        let pts = displayed_unit_points(u);
        let pts_text = match pts {
            Some(p) => format!("{p} pts"),
            None => String::new(),
        };
        let exact_groups = exact_group_lines(u);
        lines.push(format!(
            "{prefix}{}x {} ({pts_text}): {}",
            u.model_count,
            u.ref_.raw_name,
            if exact_groups.is_some() {
                String::new()
            } else {
                wargear_list_text(u, true)
            }
        ));
        if let Some(groups) = exact_groups {
            lines.extend(groups);
        }
        if let Some(attachment) = attachment_token(u) {
            lines.push(attachment);
        }
        if let Some(enh) = &u.enhancement {
            let enh_text = match u.enhancement_points {
                Some(p) => format!("Enhancement: {} (+{p} pts)", enh.raw_name),
                None => format!("Enhancement: {}", enh.raw_name),
            };
            lines.push(enh_text);
        }
    }
    lines
}

pub struct NewRecruitWtcCompactSerializer;

impl RosterSerializer for NewRecruitWtcCompactSerializer {
    fn id(&self) -> ExportFormat {
        ExportFormat::NewrecruitWtcCompact
    }

    fn serialize(&self, roster: &Roster) -> String {
        let units = &roster.units;
        let slots = char_slot_assignment(units);
        let mut lines: Vec<String> = vec![header(roster, units, &slots)];
        lines.extend(wtc_compact_body_lines(units, &slots));
        let mut out = lines.join("\n");
        out.push('\n');
        out
    }
}

/// For a multi-model unit, render its wargear as `N with <per-model list>`
/// when the wargear divides evenly across models. Otherwise emit
/// `1 with <full Nx counts>` so the counts round-trip exactly.
fn multi_model_with_line(u: &RosterUnit) -> String {
    let divisible = u
        .wargear
        .iter()
        .all(|w| u.model_count > 0 && w.count % u.model_count == 0);
    if divisible {
        let mut per_model: Vec<String> = u
            .wargear
            .iter()
            .map(|w| {
                let c = w.count / u.model_count;
                if c > 1 {
                    format!("{c}x {}", w.ref_.raw_name)
                } else {
                    w.ref_.raw_name.clone()
                }
            })
            .filter(|s| !s.is_empty())
            .collect();
        if u.is_warlord {
            per_model.push("Warlord".to_string());
        }
        per_model.extend(keyword_tokens(u));
        return format!("{} with {}", u.model_count, per_model.join(", "));
    }
    format!("1 with {}", wargear_list_text(u, true))
}

fn exact_group_lines(u: &RosterUnit) -> Option<Vec<String>> {
    let groups = u.loadout_groups.as_ref()?;
    if groups.is_empty() || groups.iter().any(|group| group.model_name.is_none()) {
        return None;
    }
    Some(
        groups
            .iter()
            .enumerate()
            .map(|(index, group)| {
                let mut parts = Vec::new();
                let weapons = group_weapons_text(&group.wargear);
                if !weapons.is_empty() {
                    parts.push(weapons);
                }
                if u.is_warlord && index == 0 {
                    parts.push("Warlord".to_string());
                }
                if index == 0 {
                    parts.extend(keyword_tokens(u));
                }
                format!(
                    "• {}x {}: {}",
                    group.count,
                    group.model_name.as_deref().unwrap_or_default(),
                    parts.join(", ")
                )
            })
            .collect(),
    )
}

/// The per-model `N with <loadout>` line(s) for a unit. A genuinely heterogeneous
/// unit (loadout groups coarsen to more than one distinct per-model loadout) emits
/// one line per loadout; everything else keeps the existing single-line form, so
/// uniform units render byte-identically to before. Mirror of TS `wtcModelLines`.
pub(super) fn wtc_model_lines(u: &RosterUnit) -> Vec<String> {
    if let Some(groups) = exact_group_lines(u) {
        return groups;
    }
    if u.model_count > 1 {
        if let Some(coarse) = coarsened_loadout_groups(u) {
            if coarse.len() > 1 {
                return coarse
                    .iter()
                    .enumerate()
                    .map(|(i, (count, wargear))| {
                        let mut tags = Vec::new();
                        if u.is_warlord && i == 0 {
                            tags.push("Warlord".to_string());
                        }
                        if i == 0 {
                            tags.extend(keyword_tokens(u));
                        }
                        let weapons = group_weapons_text(wargear);
                        format!(
                            "{} with {}{}",
                            count,
                            weapons,
                            if tags.is_empty() {
                                String::new()
                            } else {
                                format!(", {}", tags.join(", "))
                            }
                        )
                    })
                    .collect();
            }
        }
        return vec![multi_model_with_line(u)];
    }
    vec![format!("1 with {}", wargear_list_text(u, true))]
}

/// The full body — section headers plus two-line unit blocks — that follows
/// the summary header. Returned as the lines *after* the header (the leading
/// empty separator included). Unlike compact, full callers do not append a
/// trailing newline.
pub(super) fn wtc_full_body_lines(
    units: &[RosterUnit],
    slots: &[Option<u32>],
    faction_id: Option<&str>,
) -> Vec<String> {
    full_body_lines(units, slots, faction_id, wtc_model_lines)
}

/// The shared full-body scaffold: `BATTLELINE`/`ALLIED UNITS` sections, `CharN:`
/// prefixes, the unit header line, the per-model lines (supplied by `model_lines`
/// so WTC and ATC 2026 render them differently), and the enhancement line. Mirror
/// of the TS `fullBodyLines`.
pub(super) fn full_body_lines(
    units: &[RosterUnit],
    slots: &[Option<u32>],
    faction_id: Option<&str>,
    model_lines: fn(&RosterUnit) -> Vec<String>,
) -> Vec<String> {
    let mut battleline_idxs: Vec<usize> = Vec::new();
    let mut allied_idxs: Vec<usize> = Vec::new();
    for (i, u) in units.iter().enumerate() {
        if is_allied_unit(u, faction_id) {
            allied_idxs.push(i);
        } else {
            battleline_idxs.push(i);
        }
    }

    let mut lines: Vec<String> = vec![String::new(), "BATTLELINE".to_string(), String::new()];

    let emit_unit = |i: usize, lines: &mut Vec<String>| {
        let u = &units[i];
        let prefix = match slots[i] {
            Some(n) => format!("Char{n}: "),
            None => String::new(),
        };
        let pts = displayed_unit_points(u);
        let pts_text = match pts {
            Some(p) => format!("{p} pts"),
            None => String::new(),
        };
        lines.push(format!(
            "{prefix}{}x {} ({pts_text})",
            u.model_count, u.ref_.raw_name
        ));

        for line in model_lines(u) {
            lines.push(line);
        }
        if let Some(attachment) = attachment_token(u) {
            lines.push(attachment);
        }

        if let Some(enh) = &u.enhancement {
            let enh_text = match u.enhancement_points {
                Some(p) => format!("Enhancement: {} (+{p} pts)", enh.raw_name),
                None => format!("Enhancement: {}", enh.raw_name),
            };
            lines.push(enh_text);
        }
        lines.push(String::new());
    };

    for i in &battleline_idxs {
        emit_unit(*i, &mut lines);
    }

    if !allied_idxs.is_empty() {
        lines.push("ALLIED UNITS".to_string());
        lines.push(String::new());
        for i in &allied_idxs {
            emit_unit(*i, &mut lines);
        }
    }

    lines
}

pub struct NewRecruitWtcFullSerializer;

impl RosterSerializer for NewRecruitWtcFullSerializer {
    fn id(&self) -> ExportFormat {
        ExportFormat::NewrecruitWtcFull
    }

    fn serialize(&self, roster: &Roster) -> String {
        let units = &roster.units;
        let slots = char_slot_assignment(units);
        let mut lines: Vec<String> = vec![header(roster, units, &slots)];
        lines.extend(wtc_full_body_lines(
            units,
            &slots,
            roster.faction_id.as_deref(),
        ));
        lines.join("\n")
    }
}
