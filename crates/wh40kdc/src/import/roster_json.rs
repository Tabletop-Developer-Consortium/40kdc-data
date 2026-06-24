//! Canonical roster-json adapter: re-import a 40kdc [`Roster`] export.
//!
//! The exporter's `roster-json` format (see `export/roster_json.rs`) is the
//! lossless pivot — exactly `roster.schema.json` shape. This adapter closes
//! the loop so a 40kdc-native export round-trips through the normal
//! `try_import_roster` pipeline: deserialize the canonical document, lower it
//! to the format-agnostic [`ParsedRoster`], and let `resolve` re-derive ids
//! against the *current* dataset (so a stored export keeps resolving across
//! dataset releases, and stale ids self-heal through name resolution).
//!
//! Lowering notes:
//! - Unit/wargear/enhancement rows lower to their `ref.raw_name` — the same
//!   raw-display-name path every other adapter takes.
//! - `faction_id` has no raw name in the canonical shape, so the id slug is
//!   passed through as the raw name; `Collection::find` does an exact-id match
//!   before any name lookup, so resolution is exact. Detachments carry a
//!   `ref.raw_name`, so (like units) that lowers directly and round-trips.
//! - `is_character` isn't stored on the canonical shape (it's an inference
//!   input, not an output). It lowers as `leader_attachment.is_some()` so the
//!   `support`-only inference still has its gate for any unit without an
//!   explicit attachment.
//! - An explicit `leader_attachment` (the builder emits one, `provisional:false`)
//!   is carried verbatim into [`ParsedUnit::leader_attachment`] so `resolve`
//!   reconstructs it exactly — the round-trip is lossless. Only the bodyguard's
//!   raw name is lowered; `resolve` re-resolves its id against the current
//!   dataset (so stale ids self-heal, like every other ref).
//!
//! **IP safety**: the canonical document carries only permitted facts (names,
//! counts, points, ids); no prose fields exist to read.
//!
//! Rust mirror of `tools/src/import/roster-json.ts`.

use serde_json::Value;

use super::adapter::{FormatAdapter, ParseError};
use super::types::{
    BattleSize, ParsedLeaderAttachment, ParsedRoster, ParsedUnit, ParsedWargear, Roster,
    RosterFormat,
};

pub struct RosterJsonAdapter;

impl FormatAdapter for RosterJsonAdapter {
    fn format(&self) -> RosterFormat {
        RosterFormat::RosterJson
    }

    /// The canonical shape is unmistakable: a `source.format` discriminator
    /// plus the `game_version` + `diagnostics` envelope no external builder
    /// emits. All three are required by `roster.schema.json`.
    fn detect(&self, decoded: &Value) -> bool {
        let Some(obj) = decoded.as_object() else {
            return false;
        };
        obj.get("source")
            .and_then(|s| s.get("format"))
            .map(Value::is_string)
            .unwrap_or(false)
            && obj
                .get("game_version")
                .and_then(|g| g.get("edition"))
                .map(Value::is_string)
                .unwrap_or(false)
            && obj
                .get("diagnostics")
                .map(Value::is_object)
                .unwrap_or(false)
            && obj.get("units").map(Value::is_array).unwrap_or(false)
    }

    fn parse(&self, decoded: &Value) -> Result<ParsedRoster, ParseError> {
        let roster: Roster = serde_json::from_value(decoded.clone())
            .map_err(|e| ParseError(format!("roster-json deserialize failed: {e}")))?;
        Ok(lower(&roster))
    }
}

/// Lower a canonical [`Roster`] to the format-agnostic intermediate.
fn lower(roster: &Roster) -> ParsedRoster {
    let units: Vec<ParsedUnit> = roster
        .units
        .iter()
        .map(|u| ParsedUnit {
            raw_name: u.ref_.raw_name.clone(),
            // Keeps the inference gate for units without an explicit attachment.
            is_character: u.leader_attachment.is_some(),
            model_count: u.model_count,
            points: u.points,
            is_warlord: u.is_warlord,
            enhancement_raw_name: u.enhancement.as_ref().map(|e| e.raw_name.clone()),
            enhancement_points: u.enhancement_points,
            wargear: u
                .wargear
                .iter()
                .map(|w| ParsedWargear {
                    raw_name: w.ref_.raw_name.clone(),
                    count: w.count,
                })
                .collect(),
            // Carry an explicit attachment verbatim so resolve reconstructs it
            // exactly (lossless round-trip) rather than re-inferring — which
            // would drop a leader-role attachment entirely. See module docs.
            leader_attachment: u
                .leader_attachment
                .as_ref()
                .map(|la| ParsedLeaderAttachment {
                    bodyguard_raw_name: la.bodyguard_ref.raw_name.clone(),
                    role: la.role,
                    provisional: la.provisional,
                }),
        })
        .collect();

    ParsedRoster {
        name: roster.name.clone(),
        generated_by: roster.source.generated_by.clone(),
        // `faction_id` has no raw name in the canonical shape, so the id slug
        // passes through (id-match before any name lookup). Detachments carry a
        // `ref.raw_name`, so (like units) that lowers directly and round-trips.
        faction_raw_name: roster.faction_id.clone(),
        detachment_raw_names: roster
            .detachments
            .iter()
            .map(|d| d.ref_.raw_name.clone())
            .collect(),
        battle_size_raw: roster.battle_size.map(|b| {
            match b {
                BattleSize::Incursion => "Incursion",
                BattleSize::StrikeForce => "Strike Force",
            }
            .to_string()
        }),
        force_disposition: roster.force_disposition.clone(),
        declared_limit: roster.points.declared_limit,
        total_reported: roster.points.total_reported,
        total_computed: roster.points.total_computed,
        units,
        // The canonical shape carries a single primary faction.
        multi_force: false,
    }
}
