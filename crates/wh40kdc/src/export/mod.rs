//! Roster exporters — the symmetric counterpart to the importer.
//!
//! [`export_roster`] dispatches to one of five registered serializers
//! (NewRecruit JSON, the three NewRecruit text formats, and the canonical
//! Roster JSON). Each serializer is deterministic and Dataset-free, so the
//! TS and Rust mirrors can produce byte-identical output for
//! cross-implementation conformance.
//!
//! Rust mirror of `tools/src/export/`.

mod atc_2026;
mod helpers;
mod newrecruit_json;
mod newrecruit_simple;
mod newrecruit_wtc;
mod roster_json;
mod rosterizer;
mod yellowscribe;

pub use atc_2026::{Atc2026CompactSerializer, Atc2026FullSerializer};
pub use newrecruit_json::NewRecruitJsonSerializer;
pub use newrecruit_simple::NewRecruitSimpleSerializer;
pub use newrecruit_wtc::{NewRecruitWtcCompactSerializer, NewRecruitWtcFullSerializer};
pub use roster_json::RosterJsonSerializer;
pub use rosterizer::RosterizerSerializer;

use crate::data::Dataset;
use crate::import::Roster;

/// The formats `exportRoster` can emit. Mirrors the TS `ExportFormat`
/// union — NewRecruit ones share kebab-case names with [`RosterFormat`]
/// (so a `Roster` originally imported as one of these can round-trip back
/// out), `roster-json` is the canonical pivot, and the `atc-2026-*` pair is
/// export-only (no importer).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    NewrecruitJson,
    NewrecruitWtcCompact,
    NewrecruitWtcFull,
    NewrecruitSimple,
    RosterJson,
    Rosterizer,
    Atc2026Compact,
    Atc2026Full,
    /// Dataset-backed BattleScribe `.ros` for Yellowscribe → Tabletop Simulator.
    /// Export-only, and the sole format that requires a [`Dataset`]; reach it
    /// through [`export_roster_with_dataset`] (a bare [`export_roster`] panics).
    Yellowscribe,
}

/// Symmetric counterpart to [`FormatAdapter`](crate::import::FormatAdapter):
/// turn a resolved [`Roster`] into a single target format.
pub trait RosterSerializer {
    fn id(&self) -> ExportFormat;
    fn serialize(&self, roster: &Roster) -> String;
}

/// Serialize a [`Roster`] into the named target format.
///
/// Every format here is Dataset-free. The one Dataset-backed format
/// ([`ExportFormat::Yellowscribe`]) needs full datasheet data, so it is served
/// by [`export_roster_with_dataset`] instead — calling `export_roster` with it
/// panics rather than silently emitting an incomplete roster.
pub fn export_roster(roster: &Roster, format: ExportFormat) -> String {
    match format {
        ExportFormat::NewrecruitJson => NewRecruitJsonSerializer.serialize(roster),
        ExportFormat::NewrecruitWtcCompact => NewRecruitWtcCompactSerializer.serialize(roster),
        ExportFormat::NewrecruitWtcFull => NewRecruitWtcFullSerializer.serialize(roster),
        ExportFormat::NewrecruitSimple => NewRecruitSimpleSerializer.serialize(roster),
        ExportFormat::RosterJson => RosterJsonSerializer.serialize(roster),
        ExportFormat::Rosterizer => RosterizerSerializer.serialize(roster),
        ExportFormat::Atc2026Compact => Atc2026CompactSerializer.serialize(roster),
        ExportFormat::Atc2026Full => Atc2026FullSerializer.serialize(roster),
        ExportFormat::Yellowscribe => {
            panic!("export format 'yellowscribe' is Dataset-backed; use export_roster_with_dataset")
        }
    }
}

/// Serialize a [`Roster`] into the named target format, with a [`Dataset`]
/// available for Dataset-backed formats.
///
/// The [`ExportFormat::Yellowscribe`] format resolves each unit's datasheet
/// (stat lines, weapon profiles, keywords, ability text) against `dataset`;
/// every other format is Dataset-free and ignores it, delegating to
/// [`export_roster`]. Mirror of the TS `exportRoster(roster, format, dataset)`.
pub fn export_roster_with_dataset(
    roster: &Roster,
    format: ExportFormat,
    dataset: &Dataset,
) -> String {
    match format {
        ExportFormat::Yellowscribe => yellowscribe::serialize(roster, dataset),
        other => export_roster(roster, other),
    }
}
