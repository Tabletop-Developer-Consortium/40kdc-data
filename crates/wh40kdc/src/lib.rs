//! Rust types for the [40kdc-data](https://github.com/wn-mitch/40kdc-data)
//! Warhammer 40K schema layer.
//!
//! Every type in this crate is generated from the canonical JSON Schemas by
//! `cargo run -p xtask -- codegen`. The schema content these types describe is
//! published under CC0 — see the crate README.
//!
//! ```
//! use wh40kdc::Unit;
//!
//! let data = std::fs::read_to_string("path/to/units.json").unwrap_or("[]".to_string());
//! let units: Vec<Unit> = serde_json::from_str(&data).unwrap();
//! ```
//!
//! With the default `bundled-data` feature the whole dataset ships embedded
//! behind a linked, typed API ([`Dataset`]) — find an entity and follow it to
//! its weapons, abilities, phases, and faction:
//!
//! ```
//! # #[cfg(feature = "bundled-data")] {
//! use wh40kdc::{Dataset, Phase};
//!
//! let ds = Dataset::embedded();
//! let kharn = ds.find_unit("Kharn").unwrap(); // resolves "Khârn the Betrayer"
//! let shooting: Vec<&str> = ds
//!     .abilities_of(kharn)
//!     .into_iter()
//!     .filter(|a| ds.phases_of(a).contains(&Phase::Shooting))
//!     .map(|a| a.ability_id.as_str())
//!     .collect();
//! assert_eq!(shooting, ["berzerker-frenzy"]);
//! # }
//! ```

// generated.rs is prettyplease-formatted by the codegen (see xtask); skip rustfmt
// so `cargo fmt` doesn't fight the committed output / CI drift check.
#[rustfmt::skip]
mod generated;

pub use generated::*;

/// Compact, URL-safe list-share tokens — the Rust mirror of the TS `share`
/// module. Standalone (embeds its own id registry); gated by feature `share`.
#[cfg(feature = "share")]
pub mod share;

/// Canonical string encoding of a base size, shared by the conformance runner and
/// its tests so both sides of the cross-impl contract agree byte-for-byte. Mirrors
/// the TS `encodeBase`. Examples: round 32 → `"round:32"`; oval 75×42 →
/// `"oval:75x42"`; small flyer → `"flying-base:small:draft"`; hull → `"hull:draft"`.
pub fn encode_base_size(b: &BaseSize) -> String {
    let mut parts = vec![b.shape.to_string()];
    match b.shape {
        BaseSizeShape::Round => {
            if let Some(d) = b.diameter {
                parts.push(d.to_string());
            }
        }
        BaseSizeShape::Oval => {
            if let (Some(w), Some(l)) = (b.width, b.length) {
                parts.push(format!("{}x{}", w, l));
            }
        }
        BaseSizeShape::FlyingBase => {
            if let Some(s) = &b.size {
                parts.push(s.to_string());
            }
        }
        _ => {}
    }
    if b.draft {
        parts.push("draft".to_string());
    }
    parts.join(":")
}

/// Linked, typed access over the embedded dataset (default `bundled-data`).
#[cfg(feature = "bundled-data")]
pub mod data;

#[cfg(feature = "bundled-data")]
pub use data::{normalize_name, Collection, Dataset, RawData, ReactiveTrigger};

pub use data::{
    base_loadout, base_unit_points, check_unit_legality, clamp_weapon_count, group_loadout,
    loadout_models, loadout_tiers, maximal_loadout, option_cap, points_tier_missing,
    validate_loadout, Loadout, LoadoutGroup, LoadoutGroupWeapon, LoadoutModel, LoadoutTier,
    Violation, ViolationCode, WeaponBound,
};

// Roster-level legality + affordability primitives (need both the Dataset and
// the importer's Roster/BattleSize types).
#[cfg(feature = "import")]
pub use data::{
    candidate_affordability, check_roster, complete_loadout, detachment_cap_for_battle_size,
    points_limit_for_battle_size, validate_roster_core,
    validate_roster_core_with_keyword_overrides, AffordabilitySpec, AffordabilityUnit,
    CandidateCost, CompletedLoadout, NormRoster, NormUnit, RosterLegality, RosterViolation,
    RosterViolationCode, Severity as RosterSeverity, UnitLegality,
};

/// Army-list importer: ListForge share payload + NewRecruit (JSON / wtc /
/// simple) → resolved 40kdc roster (default `import`). The same module
/// hosts the [`Roster`](import::Roster) domain types, which are also reused
/// by the exporter — so it stays available whenever either `import` or
/// `export` is enabled.
#[cfg(any(feature = "import", feature = "export"))]
pub mod import;

/// Roster exporter: resolved [`Roster`](import::Roster) → NewRecruit JSON /
/// wtc-compact / wtc-full / simple / canonical Roster JSON (default
/// `export`). Dataset-free — outputs depend only on the Roster shape, which
/// keeps Rust and TS byte-identical for export goldens.
#[cfg(feature = "export")]
pub mod export;

/// Expected-value damage-projection engine: pure-function math over schema
/// profiles and a flat [`Buff`](cruncher::Buff) stack (default `cruncher`).
/// Mirrors `tools/src/cruncher/` in the TS package; the
/// `conformance/cruncher/` corpus pins both implementations to within
/// `5e-4` per pipeline stage.
#[cfg(feature = "cruncher")]
pub mod cruncher;

/// Plain-English translation of `secondary-card` scoring `awards` (mission
/// "how to play" readouts) plus the shared Ability-DSL condition humanizer.
/// Mirrors `tools/src/translate/` in the TS package; the
/// `conformance/scoring-translation/` corpus pins both implementations to
/// byte-identical output. Depends only on the generated types, so it stays
/// available even in a types-only (`default-features = false`) build.
pub mod translate;

pub use translate::{
    describe_ability, describe_ability_parts, describe_applies_to, describe_award,
    describe_condition, describe_effect, describe_effect_inline, describe_effect_with_scope,
    describe_scope, describe_scoring_card, describe_trigger,
};

/// Roster-highlighting scope: resolve which units an ability's curated
/// `applies_to` keyword filter benefits. Mirrors `tools/src/scope.ts` (TS) and
/// `wh40kdc.scope` (Python); pinned by the `conformance/applies-to` corpus.
/// Depends only on the generated types, so it stays available in a types-only
/// build.
pub mod scope;

pub use scope::{ability_applies_to_unit, unit_matches_applies_to};

/// Terrain layout geometry: resolve template-anchored layouts to absolute
/// board-space vertices. Pure (no data deps), so available in every build.
/// Cross-impl pinned by the `terrain-resolver` conformance corpus.
pub mod terrain;

pub use terrain::{
    keystone_measurements, resolve_layout, Keystone, KeystoneError, KeystoneMeasurement,
    ResolvedPiece, TerrainKeystoneError, TerrainResolveError, BOARD_INCHES,
};

/// Card-driven secondary-mission scoring engine: pure-function VP computation
/// from asserted awards, plus per-round, per-player scoring state. Mirrors
/// `tools/src/scoring/` in the TS package (the reference implementation); the
/// `conformance/scoring` corpus pins both ports. Depends only on the generated
/// types, so it stays available even in a types-only build.
pub mod scoring;

pub use scoring::{
    empty_player_game, player_primary, player_secondary, player_total, score_award, score_cap,
    score_primary_event, score_secondary, score_secondary_event, score_turn, set_primary,
    wtc_result, AssertedAward, PlayerGame, RoundCell, ScoreEntry, ScoringMode, WtcResult,
};

/// The bundled, self-contained JSON Schema (draft 2020-12) these types were
/// generated from. Consumers can feed this to a JSON Schema validator to check
/// data before deserializing; the canonical validation CLI lives in the
/// `@alpaca-software/40kdc-data` npm package.
pub const BUNDLED_SCHEMA: &str = include_str!("../schemas/bundled.schema.json");

/// Hand-rolled schema validator emitting the closed cross-implementation
/// `(path, code)` enum over [`BUNDLED_SCHEMA`]; pinned by `conformance/validator`.
#[cfg(feature = "validate")]
pub mod validator;

#[cfg(feature = "validate")]
pub use validator::{has_target as validator_has_target, validate_target, VALIDATOR_TARGETS};
