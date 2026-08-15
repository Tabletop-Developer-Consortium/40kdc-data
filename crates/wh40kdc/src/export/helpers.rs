//! Shared helpers for the roster exporters.
//!
//! Exporters are deterministic and Dataset-free: they read the Roster only
//! and regenerate format-specific decoration (display names, Char-slot
//! numbering, displayed unit totals) from what's stored. Anything the Roster
//! doesn't model — char-slot numbers, the detachment `<X> Character`
//! keyword, secondary-objective summaries — is either derived heuristically
//! here or dropped.
//!
//! Rust mirror of `tools/src/export/helpers.ts`.

use crate::import::{Roster, RosterUnit, RosterWargear};

/// Convert a kebab-case entity id (`"chaos-knights"`) to a Title Case
/// display name (`"Chaos Knights"`). The round-trip best-effort when the
/// Roster doesn't carry the source's raw faction/detachment name.
pub fn title_case_id(id: Option<&str>) -> Option<String> {
    let id = id?;
    if id.is_empty() {
        return Some(String::new());
    }
    let parts: Vec<String> = id
        .split('-')
        .map(|seg| {
            if seg.is_empty() {
                String::new()
            } else {
                let mut chars = seg.chars();
                let first = chars.next().unwrap().to_ascii_uppercase();
                let rest: String = chars.collect();
                let mut out = String::with_capacity(seg.len());
                out.push(first);
                out.push_str(&rest);
                out
            }
        })
        .collect();
    Some(parts.join(" "))
}

/// Sum of unit base pts + enhancement pts (= the figure most text formats
/// display).
pub fn displayed_unit_points(u: &RosterUnit) -> Option<u64> {
    let base = u.points?;
    Some(base + u.enhancement_points.unwrap_or(0))
}

/// Sum of every unit's displayed total + every enhancement cost line.
pub fn total_army_points(roster: &Roster) -> u64 {
    let mut total = 0u64;
    for u in &roster.units {
        total += u.points.unwrap_or(0);
        total += u.enhancement_points.unwrap_or(0);
    }
    total
}

/// Heuristic re-derivation of which units would carry a `CharN:` prefix on
/// export to a wtc text format. The Roster doesn't track unit categories, so
/// we approximate "is a character" as "is the warlord OR has an enhancement
/// OR has a leader attachment". CharN: numbering follows declaration order.
///
/// Returns a parallel array: `slot[i]` is the 1-based char index for unit
/// `i`, or `None` if that unit doesn't get a `CharN:` prefix.
pub fn char_slot_assignment(units: &[RosterUnit]) -> Vec<Option<u32>> {
    let mut result = Vec::with_capacity(units.len());
    let mut next: u32 = 1;
    for u in units {
        let is_char = u.is_warlord || u.enhancement.is_some() || u.leader_attachment.is_some();
        if is_char {
            result.push(Some(next));
            next += 1;
        } else {
            result.push(None);
        }
    }
    result
}

/// Render a loadout group's per-model weapons in their source order, with `Nx`
/// for counts >1. Mirror of the TS `groupWeaponsText`.
pub fn group_weapons_text(wargear: &[RosterWargear]) -> String {
    wargear
        .iter()
        .map(|w| {
            if w.count > 1 {
                format!("{}x {}", w.count, w.ref_.raw_name)
            } else {
                w.ref_.raw_name.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Coarsen a unit's fine per-model loadout groups by merging groups that share an
/// identical per-model weapon set (dropping the model-type name) — the granularity
/// the WTC `N with …` convention wants. Preserves first-seen order. `None` when the
/// unit carries no loadout groups. Mirror of the TS `coarsenedLoadoutGroups`.
pub fn coarsened_loadout_groups(u: &RosterUnit) -> Option<Vec<(u64, Vec<RosterWargear>)>> {
    let groups = u.loadout_groups.as_ref()?;
    if groups.is_empty() {
        return None;
    }
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut out: Vec<(u64, Vec<RosterWargear>)> = Vec::new();
    for g in groups {
        let mut key_parts: Vec<String> = g
            .wargear
            .iter()
            .map(|w| {
                format!(
                    "{}#{}",
                    w.ref_.id.as_deref().unwrap_or(&w.ref_.raw_name),
                    w.count
                )
            })
            .collect();
        key_parts.sort();
        let key = key_parts.join("|");
        if let Some(&idx) = index.get(&key) {
            out[idx].0 += g.count;
        } else {
            index.insert(key, out.len());
            out.push((g.count, g.wargear.clone()));
        }
    }
    Some(out)
}

/// Pretty JSON with a trailing newline — matches the repo's 2-space
/// convention used by `prettyJson` in TS.
pub fn pretty_json<T: serde::Serialize>(value: &T) -> String {
    let mut buf = Vec::with_capacity(1024);
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"  ");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    value.serialize(&mut ser).expect("Roster serializes");
    buf.push(b'\n');
    String::from_utf8(buf).expect("UTF-8")
}
