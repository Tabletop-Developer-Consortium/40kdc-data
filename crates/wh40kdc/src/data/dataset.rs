//! [`Dataset`] ties the embedded records together: it owns every
//! [`Collection`], builds the cross-entity indexes once, and is the value the
//! link-resolution methods borrow against.
//!
//! Where the TypeScript package exposes lazy view getters
//! (`unit.abilities`, `ability.phases`), Rust expresses the same join graph as
//! `&Dataset` methods returning borrows (`dataset.abilities_of(&unit)`,
//! `dataset.phases_of(&ability)`) — a borrowing view object would be
//! self-referential. The join graph is identical.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;

use crate::generated::{
    Ability, AbilityTrigger, AlliedRule, DeploymentPattern, Detachment, Enhancement, Faction,
    ForceDisposition, GameVersion, HullShape, InteractionFlag, KeywordList, LeaderAttachment,
    Mission, MissionMatchup, Phase, PhaseMapping, ResourcePool, SecondaryCard, Stratagem,
    TargetProfile, TerrainLayout, TerrainTemplate, Trigger, Unit, UnitComposition, UnitKeyword,
    Wargear, WargearOption, Weapon, WeaponKeyword,
};

use super::collection::Collection;

/// The shape of the embedded data bundle: one array per entity collection.
///
/// This is the boundary between the generated JSON-Schema types and the linked
/// API. The committed `bundle.generated.json` (written by
/// `cargo run -p xtask -- bundle-data`) deserializes into this; [`Dataset`]
/// wraps it with linked accessors. Every field is `#[serde(default)]` so a
/// collection with no authored data yet stays an empty array and the API
/// surface is stable.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct RawData {
    #[serde(default)]
    pub units: Vec<Unit>,
    /// Named target archetypes referencing real units (faction_id + unit_id).
    #[serde(default)]
    pub target_profiles: Vec<TargetProfile>,
    #[serde(default)]
    pub weapons: Vec<Weapon>,
    /// Catalog of weapon keywords (Lethal Hits, Sustained Hits N, Anti-X N+, ...).
    #[serde(default)]
    pub weapon_keywords: Vec<WeaponKeyword>,
    /// Catalog of universal unit abilities (Deep Strike, Scouts X", Feel No Pain X+, ...).
    #[serde(default)]
    pub unit_keywords: Vec<UnitKeyword>,
    #[serde(default)]
    pub factions: Vec<Faction>,
    /// Community-authored ability mechanics (keyed on `ability_id`, not `id`).
    #[serde(default)]
    pub abilities: Vec<Ability>,
    /// Phase assignments, joined to abilities/stratagems/etc. via `source_id`.
    #[serde(default)]
    pub phase_mappings: Vec<PhaseMapping>,
    #[serde(default)]
    pub detachments: Vec<Detachment>,
    /// Allied-detachment / 'soup' rules: how units lacking the army faction keyword may be included.
    #[serde(default)]
    pub allied_rules: Vec<AlliedRule>,
    #[serde(default)]
    pub stratagems: Vec<Stratagem>,
    #[serde(default)]
    pub enhancements: Vec<Enhancement>,
    #[serde(default)]
    pub leader_attachments: Vec<LeaderAttachment>,
    #[serde(default)]
    pub unit_compositions: Vec<UnitComposition>,
    #[serde(default)]
    pub wargear_options: Vec<WargearOption>,
    /// Non-weapon wargear items (icons, attachments) referenced by wargear options.
    #[serde(default)]
    pub wargear: Vec<Wargear>,
    #[serde(default)]
    pub game_versions: Vec<GameVersion>,
    #[serde(default)]
    pub missions: Vec<Mission>,
    #[serde(default)]
    pub mission_matchups: Vec<MissionMatchup>,
    #[serde(default)]
    pub mission_cards: Vec<SecondaryCard>,
    #[serde(default)]
    pub deployment_patterns: Vec<DeploymentPattern>,
    #[serde(default)]
    pub force_dispositions: Vec<ForceDisposition>,
    /// Reusable terrain catalog: standard areas and scenery features.
    #[serde(default)]
    pub terrain_templates: Vec<TerrainTemplate>,
    /// Terrain layouts: arrangements of catalog/inline pieces on the board.
    #[serde(default)]
    pub terrain_layouts: Vec<TerrainLayout>,
    /// Reusable model collision hulls (polygon footprints) referenced by id.
    #[serde(default)]
    pub hull_shapes: Vec<HullShape>,
    #[serde(default)]
    pub resource_pools: Vec<ResourcePool>,
    #[serde(default)]
    pub interaction_flags: Vec<InteractionFlag>,
}

/// A reactive trigger surfaced from an ability's `trigger` block.
///
/// Produced by [`Dataset::reactive_triggers`] and [`Dataset::trigger_index`].
/// `event` is the trigger event's string form (the schema enum value);
/// `unit_ids` are the ids of units listing the ability, sorted ascending.
#[derive(Debug, Clone, PartialEq)]
pub struct ReactiveTrigger<'a> {
    /// The `ability_id` of the ability carrying the trigger.
    pub ability_id: String,
    /// The trigger's game event, in its string form.
    pub event: String,
    /// Ids of units that list the ability, sorted ascending. Empty for
    /// faction / detachment-rule abilities that no unit references.
    pub unit_ids: Vec<String>,
    /// The trigger block itself, borrowed from the owning [`Ability`]. A single
    /// [`Trigger`] even when the ability's `trigger` field is an array — one
    /// [`ReactiveTrigger`] is emitted per event.
    pub trigger: &'a Trigger,
}

/// The whole dataset, with linked accessors over every entity collection.
///
/// Build it from the embedded bundle with [`Dataset::embedded`], or from custom
/// data with [`Dataset::from_raw`].
///
/// # Examples
///
/// The headline lookup — note `find_unit("Kharn")` resolves "Khârn the
/// Betrayer" through diacritic folding, and an ability's phases come from the
/// phase-mappings, not the ability record:
///
/// ```
/// use wh40kdc::{Dataset, Phase};
///
/// let ds = Dataset::embedded();
/// let kharn = ds.find_unit("Kharn").expect("Khârn is in the dataset");
///
/// let shooting_abilities: Vec<&str> = ds
///     .abilities_of(kharn)
///     .into_iter()
///     .filter(|a| ds.phases_of(a).contains(&Phase::Shooting))
///     .map(|a| a.ability_id.as_str())
///     .collect();
///
/// assert_eq!(shooting_abilities, ["berzerker-frenzy"]);
/// assert_eq!(ds.faction_of(kharn).unwrap().id.as_str(), "world-eaters");
/// ```
pub struct Dataset {
    // Richly-linked collections.
    pub units: Collection<Unit>,
    pub weapons: Collection<Weapon>,
    pub weapon_keywords: Collection<WeaponKeyword>,
    pub factions: Collection<Faction>,
    pub unit_keywords: Collection<UnitKeyword>,
    pub abilities: Collection<Ability>,

    // Id-bearing passthrough collections.
    pub target_profiles: Collection<TargetProfile>,
    pub detachments: Collection<Detachment>,
    pub allied_rules: Collection<AlliedRule>,
    pub enhancements: Collection<Enhancement>,
    pub stratagems: Collection<Stratagem>,
    pub wargear_options: Collection<WargearOption>,
    pub wargear: Collection<Wargear>,
    pub missions: Collection<Mission>,
    pub mission_matchups: Collection<MissionMatchup>,
    pub mission_cards: Collection<SecondaryCard>,
    pub deployment_patterns: Collection<DeploymentPattern>,
    pub force_dispositions: Collection<ForceDisposition>,
    pub terrain_templates: Collection<TerrainTemplate>,
    pub terrain_layouts: Collection<TerrainLayout>,
    pub hull_shapes: Collection<HullShape>,
    pub resource_pools: Collection<ResourcePool>,

    // Id-less collections, exposed as plain slices.
    pub leader_attachments: Vec<LeaderAttachment>,
    pub unit_compositions: Vec<UnitComposition>,
    pub game_versions: Vec<GameVersion>,
    pub interaction_flags: Vec<InteractionFlag>,
    pub phase_mappings: Vec<PhaseMapping>,

    /// `source_type:source_id` → unioned phases.
    phase_index: HashMap<String, Vec<Phase>>,
    /// ability id → indices of units that list it (into `units`).
    units_by_ability: HashMap<String, Vec<usize>>,
    /// weapon id → indices of units that list it (into `units`).
    units_by_weapon: HashMap<String, Vec<usize>>,
    /// lowercased keyword → indices of units carrying it (into `units`).
    units_by_keyword: HashMap<String, Vec<usize>>,
    /// unit id → indices of wargear options for it (into `wargear_options`).
    wargear_options_by_unit: HashMap<String, Vec<usize>>,
}

/// The embedded dataset bundle, inlined at build time and parsed once.
#[cfg(feature = "bundled-data")]
const BUNDLE_JSON: &str = include_str!("bundle.generated.json");

impl Dataset {
    /// The dataset built from the crate's embedded data, parsed once and cached.
    ///
    /// Requires the default `bundled-data` feature.
    #[cfg(feature = "bundled-data")]
    pub fn embedded() -> &'static Dataset {
        static EMBEDDED: OnceLock<Dataset> = OnceLock::new();
        EMBEDDED.get_or_init(|| {
            let raw: RawData =
                serde_json::from_str(BUNDLE_JSON).expect("embedded data bundle is valid JSON");
            Dataset::from_raw(raw)
        })
    }

    /// Build a dataset from arbitrary [`RawData`], wiring all collections and
    /// cross-entity indexes.
    pub fn from_raw(raw: RawData) -> Dataset {
        let units = Collection::build_with_aliases(
            raw.units,
            |u| u.id.to_string(),
            |u| Some(u.name.as_str()),
            // Units answer to alternate names (spelling variants in other tools'
            // exports) so an import matches despite a spelling difference.
            |u| u.aliases.iter().map(|a| a.as_str()).collect(),
            |u| Some(u.faction_id.as_str()),
            // The same unit id is shared across factions (e.g. ministorum-priest);
            // keep each faction's copy, collapse only true within-faction dupes.
            |u| format!("{}::{}", u.faction_id.as_str(), u.id.as_str()),
        )
        // Per-faction copies genuinely diverge (points, keywords, profiles), so
        // a faction-less get() of a shared id is a bug — mirror of the TS guard.
        .with_unscoped_guard("unit");
        let weapons = Collection::build(
            raw.weapons,
            |w| w.id.to_string(),
            |w| Some(w.name.as_str()),
            // A bare weapon id is shared across factions with divergent stats;
            // key on (faction_id, id) so every faction's copy is kept and a unit
            // resolves its own faction's weapon (issue #59), not whichever bundled
            // first. Mirrors the TS weapons collection.
            |w| w.faction_id.as_ref().map(|f| f.as_str()),
            |w| {
                format!(
                    "{}::{}",
                    w.faction_id.as_ref().map(|f| f.as_str()).unwrap_or(""),
                    w.id.as_str()
                )
            },
        );
        let weapon_keywords = id_name_collection(
            raw.weapon_keywords,
            |k| k.id.to_string(),
            |k| Some(k.name.as_str()),
        );
        let unit_keywords = id_name_collection(
            raw.unit_keywords,
            |k| k.id.to_string(),
            |k| Some(k.name.as_str()),
        );
        let factions = Collection::build(
            raw.factions,
            |f| f.id.to_string(),
            |f| Some(f.name.as_str()),
            |_| None,
            |f| f.id.to_string(),
        );
        // An ability_id is shared across factions (each faction's enrichment
        // authors its own copy of e.g. "deadly-demise-d3", and the copies
        // legitimately diverge); dedupe on (faction_id, id) so every faction's
        // copy is retained and a unit resolves its own faction's ability — the
        // same scheme as weapons (issue #59). `faction_id` is stamped at
        // bundle time from the enrichment directory; only the shared `_core`
        // pool stays faction-less, reachable through the first-wins fallback.
        let abilities = Collection::build(
            raw.abilities,
            |a| a.ability_id.to_string(),
            |a| Some(a.name.as_str()),
            |a| a.faction_id.as_ref().map(|e| e.as_str()),
            |a| {
                format!(
                    "{}::{}",
                    a.faction_id.as_ref().map(|e| e.as_str()).unwrap_or(""),
                    a.ability_id.as_str()
                )
            },
        );

        let target_profiles = Collection::build(
            raw.target_profiles,
            |p| p.id.to_string(),
            |p| Some(p.name.as_str()),
            |p| Some(p.faction_id.as_str()),
            |p| p.id.to_string(),
        );
        let detachments = Collection::build(
            raw.detachments,
            |d| d.id.to_string(),
            |d| Some(d.name.as_str()),
            |d| Some(d.faction_id.as_str()),
            // The generic Codex Space Marine detachments are replicated into every
            // Codex-compatible chapter/supplement view (shared id, distinct
            // faction); keep each faction's copy, collapse only within-faction dupes.
            |d| format!("{}::{}", d.faction_id.as_str(), d.id.as_str()),
        )
        // Shared detachments diverge per chapter (detachment_rule_id,
        // stratagem_ids, enhancement_ids, detachment_points) — same guard as units.
        .with_unscoped_guard("detachment");
        let allied_rules = id_name_collection(
            raw.allied_rules,
            |r| r.id.to_string(),
            |r| Some(r.name.as_str()),
        );
        let enhancements = id_name_collection(
            raw.enhancements,
            |e| e.id.to_string(),
            |e| Some(e.name.as_str()),
        );
        let stratagems = id_name_collection(
            raw.stratagems,
            |s| s.id.to_string(),
            |s| Some(s.name.as_str()),
        );
        // Option ids are unique only within a faction — a chassis shared across
        // factions (e.g. `chaos-terminators`) reuses ids like
        // `chaos-terminators-wgo-mfm-4` for different swaps. Dedupe on the full
        // `(faction_id, unit_id, id)` so every faction's copy is retained; the
        // `(faction_id, unit_id)` index in `wargear_options_of` then keeps them apart.
        let wargear_options = Collection::build(
            raw.wargear_options,
            |w| w.id.to_string(),
            |_| None,
            |_| None,
            |w| {
                format!(
                    "{}::{}::{}",
                    w.faction_id.as_str(),
                    w.unit_id.as_str(),
                    w.id.as_str()
                )
            },
        );
        let wargear =
            id_name_collection(raw.wargear, |w| w.id.to_string(), |w| Some(w.name.as_str()));
        let missions = id_name_collection(
            raw.missions,
            |m| m.id.to_string(),
            |m| Some(m.name.as_str()),
        );
        let mission_matchups =
            id_name_collection(raw.mission_matchups, |m| m.id.to_string(), |_| None);
        let mission_cards = id_name_collection(
            raw.mission_cards,
            |s| s.id.to_string(),
            |s| Some(s.name.as_str()),
        );
        let deployment_patterns = id_name_collection(
            raw.deployment_patterns,
            |d| d.id.to_string(),
            |d| Some(d.name.as_str()),
        );
        // ForceDispositionId is a Display string-enum, not a newtype.
        let force_dispositions = id_name_collection(
            raw.force_dispositions,
            |f| f.id.to_string(),
            |f| Some(f.name.as_str()),
        );
        let terrain_templates = id_name_collection(
            raw.terrain_templates,
            |t| t.id.to_string(),
            |t| Some(t.name.as_str()),
        );
        let terrain_layouts = id_name_collection(
            raw.terrain_layouts,
            |l| l.id.to_string(),
            |l| Some(l.name.as_str()),
        );
        let hull_shapes = id_name_collection(
            raw.hull_shapes,
            |h| h.id.to_string(),
            |h| Some(h.name.as_str()),
        );
        let resource_pools = Collection::build(
            raw.resource_pools,
            |r| r.id.to_string(),
            |r| Some(r.name.as_str()),
            |r| Some(r.faction_id.as_str()),
            |r| r.id.to_string(),
        );

        let phase_index = build_phase_index(&raw.phase_mappings);
        let (units_by_ability, units_by_weapon, units_by_keyword) = build_reverse_indexes(&units);
        // Faction-scoped: a chassis shared across factions (e.g. `chaos-terminators`
        // in World Eaters *and* Emperors Children) reuses the same option ids for
        // different swaps, so the key is `(faction_id, unit_id)` — never the union
        // across factions. Mirror of the TS `wargearOptionsByUnit`.
        let mut wargear_options_by_unit: HashMap<String, Vec<usize>> = HashMap::new();
        for (idx, option) in wargear_options.all().iter().enumerate() {
            wargear_options_by_unit
                .entry(format!(
                    "{}::{}",
                    option.faction_id.as_str(),
                    option.unit_id.as_str()
                ))
                .or_default()
                .push(idx);
        }

        Dataset {
            units,
            weapons,
            weapon_keywords,
            unit_keywords,
            factions,
            abilities,
            target_profiles,
            detachments,
            allied_rules,
            enhancements,
            stratagems,
            wargear_options,
            wargear,
            missions,
            mission_matchups,
            mission_cards,
            deployment_patterns,
            force_dispositions,
            terrain_templates,
            terrain_layouts,
            hull_shapes,
            resource_pools,
            leader_attachments: raw.leader_attachments,
            unit_compositions: raw.unit_compositions,
            game_versions: raw.game_versions,
            interaction_flags: raw.interaction_flags,
            phase_mappings: raw.phase_mappings,
            phase_index,
            units_by_ability,
            units_by_weapon,
            units_by_keyword,
            wargear_options_by_unit,
        }
    }

    // --- Convenience finders (delegate to the matching collection) ----------

    /// Find a unit by id or name (diacritic-insensitive). See
    /// [`Collection::find`].
    pub fn find_unit(&self, query: &str) -> Option<&Unit> {
        self.units.find(query)
    }

    /// Find a weapon by id or name.
    pub fn find_weapon(&self, query: &str) -> Option<&Weapon> {
        self.weapons.find(query)
    }

    /// Find a faction by id or name.
    pub fn find_faction(&self, query: &str) -> Option<&Faction> {
        self.factions.find(query)
    }

    /// Find an ability by id (`ability_id`) or name.
    pub fn find_ability(&self, query: &str) -> Option<&Ability> {
        self.abilities.find(query)
    }

    // --- Link resolution (the &Dataset replacement for view getters) --------

    /// The unit's faction, or `None` if its `faction_id` is unknown.
    pub fn faction_of(&self, unit: &Unit) -> Option<&Faction> {
        self.factions.get(unit.faction_id.as_str())
    }

    /// Resolve a terrain layout to absolute board-space vertices, using this
    /// dataset's embedded terrain-template catalog. This is the layout-id →
    /// renderable-geometry hop a consumer (e.g. shadowboxing) wants. Errors if
    /// the layout references a template absent from the catalog. The generated
    /// types round-trip through their canonical JSON into the resolver's input
    /// structs — the same JSON the conformance corpus pins.
    pub fn resolve_terrain(
        &self,
        layout: &TerrainLayout,
    ) -> Result<Vec<crate::terrain::ResolvedPiece>, crate::terrain::TerrainResolveError> {
        fn convert<T: serde::de::DeserializeOwned, S: serde::Serialize>(value: &S) -> T {
            serde_json::from_value(
                serde_json::to_value(value).expect("generated terrain serializes"),
            )
            .expect("generated terrain type matches resolver shape")
        }
        let r_layout: crate::terrain::TerrainLayout = convert(layout);
        let templates: Vec<crate::terrain::TerrainTemplate> =
            self.terrain_templates.all().iter().map(convert).collect();
        crate::terrain::resolve_layout(&r_layout, &templates)
    }

    /// The terrain layouts a deployment pattern recommends, in declared order,
    /// skipping any ids absent from the dataset.
    pub fn recommended_terrain_layouts(&self, pattern: &DeploymentPattern) -> Vec<&TerrainLayout> {
        pattern
            .recommended_terrain_layout_ids
            .iter()
            .flatten()
            .filter_map(|id| self.terrain_layouts.get(id.as_str()))
            .collect()
    }

    /// Weapons referenced by `weapon_ids`, resolved within the unit's own faction
    /// (a bare id shared across factions resolves to the wielder's copy — issue
    /// #59), falling back to global first-wins for a genuinely cross-faction id.
    /// Unresolved ids are skipped.
    pub fn weapons_of(&self, unit: &Unit) -> Vec<&Weapon> {
        unit.weapon_ids
            .iter()
            .filter_map(|id| {
                self.weapons
                    .get_in_faction(id.as_str(), unit.faction_id.as_str())
                    .or_else(|| self.weapons.get(id.as_str()))
            })
            .collect()
    }

    /// Wargear options authored for the given unit, in declared order. Scoped to the
    /// unit's own faction (`(faction_id, unit_id)`): a chassis shared across factions
    /// reuses the same option ids for different swaps, so the lookup never unions
    /// across factions. Mirror of TS `Dataset.wargearOptionsOf`. Empty for a unit with
    /// no options.
    pub fn wargear_options_of(&self, unit: &Unit) -> Vec<&WargearOption> {
        self.wargear_options_by_unit
            .get(&format!(
                "{}::{}",
                unit.faction_id.as_str(),
                unit.id.as_str()
            ))
            .map(|idxs| idxs.iter().map(|&i| self.wargear_options.at(i)).collect())
            .unwrap_or_default()
    }

    /// Abilities referenced by `ability_ids`; unresolved ids are skipped.
    ///
    /// Resolves within the unit's own faction first — an ability_id shared
    /// across factions has per-faction copies that diverge. The fallback
    /// catches the faction-less `_core` pool (and any id absent from this
    /// faction's enrichment). Mirror of TS `UnitView.abilities`.
    pub fn abilities_of(&self, unit: &Unit) -> Vec<&Ability> {
        unit.ability_ids
            .iter()
            .filter_map(|id| {
                self.abilities
                    .get_in_faction(id.as_str(), unit.faction_id.as_str())
                    .or_else(|| self.abilities.get(id.as_str()))
            })
            .collect()
    }

    /// Game phases an ability acts in, unioned across its phase-mappings.
    ///
    /// Phases are not stored on the ability — they live in `phase_mappings`
    /// records where `source_type == "ability"` and `source_id == ability_id`.
    pub fn phases_of(&self, ability: &Ability) -> &[Phase] {
        self.phases_for("ability", ability.ability_id.as_str())
    }

    /// Phases a source acts in, unioned across its phase-mappings, keyed by the
    /// `source_type` / `source_id` pair (e.g. `("ability", "berzerker-frenzy")`).
    pub fn phases_for(&self, source_type: &str, source_id: &str) -> &[Phase] {
        self.phase_index
            .get(&format!("{source_type}:{source_id}"))
            .map_or(&[], Vec::as_slice)
    }

    /// Units that list the given ability id in their `ability_ids`.
    pub fn units_with_ability(&self, ability_id: &str) -> Vec<&Unit> {
        self.units_by_ability
            .get(ability_id)
            .map(|idxs| idxs.iter().map(|&i| self.units.at(i)).collect())
            .unwrap_or_default()
    }

    /// Every ability carrying a reactive `trigger` block, sorted ascending by
    /// `ability_id`. Each entry pairs the trigger's event with the ids of units
    /// that list the ability (via the units-by-ability reverse index, sorted
    /// ascending; empty for faction / detachment-rule abilities). Mirror of TS
    /// `Dataset.reactiveTriggers`.
    pub fn reactive_triggers(&self) -> Vec<ReactiveTrigger<'_>> {
        let mut out: Vec<ReactiveTrigger<'_>> = Vec::new();
        // The abilities collection retains one copy per faction of a shared
        // ability_id; this aggregation is faction-less (ReactiveTrigger carries
        // no faction), so emit each ability id once — first registered copy
        // wins, matching the collection's own by-id index and the TS mirror.
        let mut seen_ids: HashSet<&str> = HashSet::new();
        for ability in self.abilities.all() {
            if !seen_ids.insert(ability.ability_id.as_str()) {
                continue;
            }
            let Some(raw) = ability.trigger.as_ref() else {
                continue;
            };
            // `trigger` may be a single object or an array (the ability fires on
            // any); emit one ReactiveTrigger per event so the dispatch index
            // keys them all. Mirror of TS `Dataset.reactiveTriggers`.
            let triggers: Vec<&Trigger> = match raw {
                AbilityTrigger::Trigger(t) => vec![t],
                AbilityTrigger::Array(ts) => ts.iter().collect(),
            };
            let mut unit_ids: Vec<String> = self
                .units_with_ability(ability.ability_id.as_str())
                .into_iter()
                .map(|u| u.id.to_string())
                .collect();
            unit_ids.sort();
            for trigger in triggers {
                out.push(ReactiveTrigger {
                    ability_id: ability.ability_id.to_string(),
                    event: trigger.event.to_string(),
                    unit_ids: unit_ids.clone(),
                    trigger,
                });
            }
        }
        out.sort_by(|a, b| a.ability_id.cmp(&b.ability_id));
        out
    }

    /// Reactive triggers grouped by event. The [`BTreeMap`] iterates keys in
    /// ascending event order; each bucket preserves the ability-id-sorted order
    /// of [`reactive_triggers`](Self::reactive_triggers). Mirror of TS
    /// `Dataset.triggerIndex`.
    pub fn trigger_index(&self) -> BTreeMap<String, Vec<ReactiveTrigger<'_>>> {
        let mut index: BTreeMap<String, Vec<ReactiveTrigger<'_>>> = BTreeMap::new();
        for rt in self.reactive_triggers() {
            index.entry(rt.event.clone()).or_default().push(rt);
        }
        index
    }

    /// Units that list the given weapon id in their `weapon_ids`.
    pub fn units_with_weapon(&self, weapon_id: &str) -> Vec<&Unit> {
        self.units_by_weapon
            .get(weapon_id)
            .map(|idxs| idxs.iter().map(|&i| self.units.at(i)).collect())
            .unwrap_or_default()
    }

    /// Units carrying the given keyword, matched case-insensitively against the
    /// union of each unit's `keywords` and `faction_keywords`. Powers a list
    /// builder's keyword search bar across the whole dataset (so it also
    /// surfaces cross-faction ally pools). Mirror of TS `unitsWithKeyword`;
    /// pinned by the `units_with_keyword` conformance query.
    pub fn units_with_keyword(&self, keyword: &str) -> Vec<&Unit> {
        self.units_by_keyword
            .get(&keyword.to_lowercase())
            .map(|idxs| idxs.iter().map(|&i| self.units.at(i)).collect())
            .unwrap_or_default()
    }

    /// The allied-rules offered for an army of `faction_id` running the given
    /// detachments. A rule applies when both gates pass: the army gate
    /// (`army_keywords_any` empty, or intersecting the faction's keywords) and
    /// the detachment gate (`detachment_ids` empty, or at least one listed id
    /// among the selected detachments).
    /// Order follows the allied-rules data. Mirror of TS `alliesFor`; pinned by
    /// the `allies_for` conformance query.
    pub fn allies_for(&self, faction_id: &str, detachment_ids: &[&str]) -> Vec<&AlliedRule> {
        let Some(faction) = self.factions.get(faction_id) else {
            return Vec::new();
        };
        let faction_keywords: std::collections::HashSet<String> = faction
            .keywords
            .iter()
            .flat_map(|k| k.0.iter())
            .map(|k| k.to_lowercase())
            .collect();
        self.allied_rules
            .all()
            .iter()
            .filter(|rule| {
                let army_gate = match &rule.army_keywords_any {
                    None => true,
                    Some(kws) if kws.0.is_empty() => true,
                    Some(kws) => kws
                        .0
                        .iter()
                        .any(|k| faction_keywords.contains(&k.to_lowercase())),
                };
                let detachment_gate = {
                    let gates: Vec<&str> = rule
                        .detachment_ids
                        .iter()
                        .flatten()
                        .map(|x| x.as_str())
                        .collect();
                    gates.is_empty() || gates.iter().any(|id| detachment_ids.contains(id))
                };
                army_gate && detachment_gate
            })
            .collect()
    }

    /// The unit pool an allied-rule grants, sorted by name. Starts from the
    /// rule's `source_faction_id` (if set) or the whole dataset, then ANDs every
    /// filter the rule sets: `source_datasheet_ids` (explicit id allowlist —
    /// primary selector for generated pools), any `source_keywords`,
    /// `required_keywords` (all present), `excluded_keywords` (none present), and
    /// `roles`. Empty for an unknown rule id. Mirror of TS `allyUnitsFor`; pinned by the
    /// `ally_units_for` conformance query.
    pub fn ally_units_for(&self, rule_id: &str) -> Vec<&Unit> {
        let Some(rule) = self.allied_rules.get(rule_id) else {
            return Vec::new();
        };
        let base: Vec<&Unit> = match &rule.source_faction_id {
            Some(fid) => self.units.by_faction(fid.as_str()),
            None => self.units.all().iter().collect(),
        };
        let lower = |kws: &Option<KeywordList>| -> Vec<String> {
            kws.iter()
                .flat_map(|k| k.0.iter())
                .map(|k| k.to_lowercase())
                .collect()
        };
        let source_keywords = lower(&rule.source_keywords);
        let required = lower(&rule.required_keywords);
        let excluded = lower(&rule.excluded_keywords);
        let roles: std::collections::HashSet<String> =
            rule.roles.iter().flatten().map(|r| r.to_string()).collect();
        let datasheet_ids: std::collections::HashSet<&str> = rule
            .source_datasheet_ids
            .iter()
            .flatten()
            .map(|x| x.as_str())
            .collect();
        let mut out: Vec<&Unit> = base
            .into_iter()
            .filter(|u| {
                let have = unit_keyword_set(u);
                if !datasheet_ids.is_empty() && !datasheet_ids.contains(u.id.as_str()) {
                    return false;
                }
                if !source_keywords.is_empty() && !source_keywords.iter().any(|k| have.contains(k))
                {
                    return false;
                }
                if !required.is_empty() && !required.iter().all(|k| have.contains(k)) {
                    return false;
                }
                if excluded.iter().any(|k| have.contains(k)) {
                    return false;
                }
                if !roles.is_empty() {
                    match &u.role {
                        Some(role) => {
                            if !roles.contains(&role.to_string()) {
                                return false;
                            }
                        }
                        None => return false,
                    }
                }
                true
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// Leaders whose leader-attachment data lists `bodyguard_unit_id` among its
    /// eligible body units, sorted by name. The attachment is stored on the
    /// leader pointing down to its bodyguards, so answering "which leaders can
    /// attach to this unit?" means scanning the attachment list. Returns an
    /// empty vec for a unit nothing attaches to (including leader units).
    pub fn leaders_attachable_to(&self, bodyguard_unit_id: &str) -> Vec<&Unit> {
        let mut out: Vec<&Unit> = self
            .leader_attachments
            .iter()
            .filter(|la| {
                la.eligible_bodyguard_ids
                    .iter()
                    .any(|id| id.as_str() == bodyguard_unit_id)
            })
            // Attachment data is faction-agnostic (no faction context here);
            // accept first-wins for a shared leader chassis via get_any.
            .filter_map(|la| self.units.get_any(la.leader_id.as_str()))
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// The inverse of [`leaders_attachable_to`](Self::leaders_attachable_to):
    /// the body units the given leader can attach to, sorted by name. Scans the
    /// same data from the leader's side (`leader_id` matches; resolve each
    /// `eligible_bodyguard_ids` entry), deduped by id. Empty for a non-leader
    /// unit. The two together give the bidirectional attachment graph.
    pub fn bodyguards_attachable_from(&self, leader_unit_id: &str) -> Vec<&Unit> {
        let mut seen = std::collections::HashSet::new();
        let mut out: Vec<&Unit> = Vec::new();
        for la in &self.leader_attachments {
            if la.leader_id.as_str() != leader_unit_id {
                continue;
            }
            for bodyguard_id in &la.eligible_bodyguard_ids {
                if !seen.insert(bodyguard_id.as_str()) {
                    continue;
                }
                // Faction-agnostic attachment data — get_any, as above.
                if let Some(unit) = self.units.get_any(bodyguard_id.as_str()) {
                    out.push(unit);
                }
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// Faction-scoped abilities (abilities whose `faction_id` is this faction).
    pub fn abilities_of_faction(&self, faction_id: &str) -> Vec<&Ability> {
        self.abilities.by_faction(faction_id)
    }

    /// Distinct weapons carried by a faction's units (deduplicated by id).
    pub fn weapons_of_faction(&self, faction_id: &str) -> Vec<&Weapon> {
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for unit in self.units.by_faction(faction_id) {
            for weapon in self.weapons_of(unit) {
                if seen.insert(weapon.id.as_str().to_string()) {
                    out.push(weapon);
                }
            }
        }
        out
    }
}

/// Build a passthrough collection keyed on id (no faction scoping). The id also
/// serves as the dedupe key.
fn id_name_collection<T>(
    items: Vec<T>,
    id_of: impl Fn(&T) -> String,
    name_of: impl Fn(&T) -> Option<&str>,
) -> Collection<T> {
    Collection::build(items, &id_of, name_of, |_| None, |i| id_of(i))
}

/// Union the phases of every phase-mapping, keyed `source_type:source_id`.
fn build_phase_index(phase_mappings: &[PhaseMapping]) -> HashMap<String, Vec<Phase>> {
    let mut index: HashMap<String, Vec<Phase>> = HashMap::new();
    for pm in phase_mappings {
        let key = format!("{}:{}", pm.source_type, pm.source_id.as_str());
        let entry = index.entry(key).or_default();
        for &phase in pm.phases.iter() {
            if !entry.contains(&phase) {
                entry.push(phase);
            }
        }
    }
    index
}

/// The lowercased union of a unit's `keywords` and `faction_keywords`, for
/// membership tests in `ally_units_for`.
fn unit_keyword_set(unit: &Unit) -> std::collections::HashSet<String> {
    unit.keywords
        .iter()
        .flat_map(|k| k.0.iter())
        .chain(unit.faction_keywords.iter().flat_map(|k| k.0.iter()))
        .map(|k| k.to_lowercase())
        .collect()
}

/// Build ability-id→units, weapon-id→units, and keyword→units reverse indexes
/// (values are positions into the deduplicated units collection). Keywords are
/// the lowercased union of a unit's `keywords` and `faction_keywords`, deduped
/// per unit so an overlap doesn't list the unit twice.
#[allow(clippy::type_complexity)]
fn build_reverse_indexes(
    units: &Collection<Unit>,
) -> (
    HashMap<String, Vec<usize>>,
    HashMap<String, Vec<usize>>,
    HashMap<String, Vec<usize>>,
) {
    let mut by_ability: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_weapon: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_keyword: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, unit) in units.all().iter().enumerate() {
        for ability_id in &unit.ability_ids {
            by_ability
                .entry(ability_id.to_string())
                .or_default()
                .push(idx);
        }
        for weapon_id in &unit.weapon_ids {
            by_weapon
                .entry(weapon_id.to_string())
                .or_default()
                .push(idx);
        }
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let keywords = unit.keywords.iter().flat_map(|k| k.0.iter());
        let faction_keywords = unit.faction_keywords.iter().flat_map(|k| k.0.iter());
        for kw in keywords.chain(faction_keywords) {
            let key = kw.to_lowercase();
            if seen.insert(key.clone()) {
                by_keyword.entry(key).or_default().push(idx);
            }
        }
    }
    (by_ability, by_weapon, by_keyword)
}
