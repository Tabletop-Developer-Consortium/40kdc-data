//! Linked, typed access over the embedded 40kdc dataset.
//!
//! This is the Rust mirror of the `@alpaca-software/40kdc-data` npm package's
//! data API. Find an entity and follow it to its links:
//!
//! ```
//! use wh40kdc::Dataset;
//!
//! let ds = Dataset::embedded();
//! let kharn = ds.find_unit("Kharn").unwrap();
//! for ability in ds.abilities_of(kharn) {
//!     let phases = ds.phases_of(ability);
//!     println!("{} acts in {:?}", ability.ability_id.as_str(), phases);
//! }
//! ```
//!
//! The dataset is embedded at build time (see
//! `cargo run -p xtask -- bundle-data`) and exposed behind the default
//! `bundled-data` feature; build with `default-features = false` for a
//! types-only crate with no embedded data and no extra dependencies.

mod collection;
mod dataset;
mod loadout;
mod normalize;
mod pricing;

// Roster-level legality + affordability build on both the Dataset and the
// importer's `Roster`/`BattleSize` types, so they ride the `import` feature
// (which implies `bundled-data`). `battle_sizes` references `BattleSize` too.
#[cfg(feature = "import")]
pub mod affordability;
#[cfg(feature = "import")]
pub mod battle_sizes;
#[cfg(feature = "import")]
pub mod roster;

pub use collection::Collection;
pub use dataset::{Dataset, RawData, ReactiveTrigger};
pub use loadout::{
    base_loadout, check_unit_legality, clamp_weapon_count, group_loadout, loadout_models,
    loadout_tiers, maximal_loadout, option_cap, validate_loadout, Loadout, LoadoutGroup,
    LoadoutGroupWeapon, LoadoutModel, LoadoutTier, Violation, ViolationCode, WeaponBound,
};
pub use normalize::normalize_name;
pub use pricing::{base_unit_points, points_tier_missing};

#[cfg(feature = "import")]
pub use affordability::{
    candidate_affordability, AffordabilitySpec, AffordabilityUnit, CandidateCost,
};
#[cfg(feature = "import")]
pub use battle_sizes::{detachment_cap_for_battle_size, points_limit_for_battle_size};
#[cfg(feature = "import")]
pub use roster::{
    check_roster, validate_roster_core, NormRoster, NormUnit, RosterLegality, RosterViolation,
    RosterViolationCode, Severity, UnitLegality,
};
