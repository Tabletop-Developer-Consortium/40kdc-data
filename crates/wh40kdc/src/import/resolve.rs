//! Resolve a [`ParsedRoster`] onto 40kdc entity ids, producing a [`Roster`].
//!
//! Resolution is lenient: a name that doesn't match a 40kdc entity yields a
//! [`ResolvedRef`] with `id: None`, `resolved: false`, and up to five candidate
//! suggestions — the roster is never dropped or rejected. Everything that didn't
//! resolve cleanly is summarised in the [`Diagnostics`] block.
//!
//! Matching reuses the dataset's own lookups ([`Dataset::find_*`], `find_all`,
//! `by_faction`) and [`normalize_name`](crate::normalize_name); there is no
//! bespoke fuzzy matcher. Faction is resolved first so unit/detachment/
//! enhancement lookups can be scoped to it — the same unit id can appear under
//! several factions, so scoping disambiguates.
//!
//! Rust mirror of `tools/src/import/resolve.ts`.

use std::collections::{BTreeMap, HashMap};

use crate::data::{group_loadout, loadout_models, normalize_name, Dataset};

use super::types::{
    AttachmentRole, BattleSize, Candidate, Diagnostics, ParsedRoster, ParsedUnit, ResolvedRef,
    Roster, RosterDetachment, RosterFormat, RosterLeaderAttachment, RosterLoadoutGroup,
    RosterPoints, RosterSource, RosterUnit, RosterWargear, Warning, WarningCode,
};

/// The dataset edition/dataslate stamped onto an imported roster.
const ROSTER_EDITION: &str = "11th";
const ROSTER_DATASLATE: &str = "pre-launch-provisional";

const MAX_CANDIDATES: usize = 5;

/// Accumulates warnings and resolved/unresolved tallies during an import.
#[derive(Default)]
struct DiagnosticsBuilder {
    resolved_units: u64,
    unresolved_units: u64,
    resolved_weapons: u64,
    unresolved_weapons: u64,
    warnings: Vec<Warning>,
}

impl DiagnosticsBuilder {
    fn warn(&mut self, code: WarningCode, message: &str, raw_name: Option<&str>) {
        self.warnings.push(Warning {
            code,
            message: message.to_string(),
            raw_name: raw_name.map(str::to_string),
        });
    }

    fn build(self) -> Diagnostics {
        Diagnostics {
            resolved_units: self.resolved_units,
            unresolved_units: self.unresolved_units,
            resolved_weapons: self.resolved_weapons,
            unresolved_weapons: self.unresolved_weapons,
            warnings: self.warnings,
        }
    }
}

fn unresolved(raw_name: &str, candidates: Vec<Candidate>) -> ResolvedRef {
    ResolvedRef {
        id: None,
        raw_name: raw_name.to_string(),
        resolved: false,
        candidates,
    }
}

fn resolved(id: &str, raw_name: &str) -> ResolvedRef {
    ResolvedRef {
        id: Some(id.to_string()),
        raw_name: raw_name.to_string(),
        resolved: true,
        candidates: Vec::new(),
    }
}

/// Map a source battle-size label to the 40kdc enum, if recognisable.
fn map_battle_size(raw: Option<&str>) -> Option<BattleSize> {
    let key = normalize_name(raw?);
    if key.contains("strike force") {
        Some(BattleSize::StrikeForce)
    } else if key.contains("incursion") {
        Some(BattleSize::Incursion)
    } else {
        None
    }
}

/// 11e detachment-point budget for a battle size; `None` when unknown.
fn detachment_cap_for(battle_size: Option<BattleSize>) -> Option<u64> {
    match battle_size {
        Some(BattleSize::StrikeForce) => Some(3),
        Some(BattleSize::Incursion) => Some(2),
        None => None,
    }
}

/// The kebab-case battle-size label used in the over-cap diagnostic message
/// (matches the serialized enum form, so the message is byte-identical to TS).
fn battle_size_label(battle_size: Option<BattleSize>) -> &'static str {
    match battle_size {
        Some(BattleSize::StrikeForce) => "strike-force",
        Some(BattleSize::Incursion) => "incursion",
        None => "",
    }
}

/// Resolve a [`ParsedRoster`] against the dataset.
///
/// # Examples
///
/// ```
/// use wh40kdc::Dataset;
/// use wh40kdc::import::{import_roster, decode_listforge, RosterFormat};
///
/// let payload = decode_listforge(r#"{
///     "name": "Demo",
///     "roster": { "name": "Demo", "forces": [] }
/// }"#).unwrap();
/// let roster = import_roster(&payload, Dataset::embedded()).unwrap();
/// assert_eq!(roster.source.format, RosterFormat::Listforge);
/// ```
pub fn resolve(parsed: &ParsedRoster, ds: &Dataset, format: RosterFormat) -> Roster {
    let mut diag = DiagnosticsBuilder::default();

    if parsed.multi_force {
        diag.warn(
            WarningCode::MultiForce,
            "Source list contains more than one faction; the primary faction was used for scoping.",
            None,
        );
    }

    // --- Faction (resolved first so other lookups can scope to it). ---------
    let mut faction_id: Option<String> = None;
    if let Some(raw) = &parsed.faction_raw_name {
        if let Some(hit) = ds.factions.find(raw) {
            faction_id = Some(hit.id.as_str().to_string());
        } else {
            diag.warn(
                WarningCode::FactionUnresolved,
                "Faction name did not match any 40kdc faction.",
                Some(raw),
            );
        }
    }

    // --- Detachments (each scoped to faction, then global fallback). --------
    // 11e lists may field several detachments under a detachment-point cap; the
    // list preserves source order. `dp_cost` is looked up from the resolved
    // detachment entity (no source format reports it).
    let detachments: Vec<RosterDetachment> = parsed
        .detachment_raw_names
        .iter()
        .map(|raw| {
            let key = normalize_name(raw);
            let scoped = faction_id.as_deref().and_then(|f| {
                ds.detachments
                    .by_faction(f)
                    .into_iter()
                    .find(|d| normalize_name(&d.name) == key)
            });
            let hit = scoped.or_else(|| ds.detachments.find(raw));
            if let Some(hit) = hit {
                RosterDetachment {
                    ref_: resolved(hit.id.as_str(), raw),
                    dp_cost: hit.detachment_points.map(|n| n.get()),
                }
            } else {
                diag.warn(
                    WarningCode::DetachmentUnresolved,
                    "Detachment name did not match any 40kdc detachment.",
                    Some(raw),
                );
                RosterDetachment {
                    ref_: unresolved(raw, detachment_candidates(&ds.detachments.find_all(raw))),
                    dp_cost: None,
                }
            }
        })
        .collect();
    let detachment_ids: Vec<String> = detachments
        .iter()
        .filter_map(|d| d.ref_.id.clone())
        .collect();

    // --- Battle size. -------------------------------------------------------
    let battle_size = map_battle_size(parsed.battle_size_raw.as_deref());
    if parsed.battle_size_raw.is_some() && battle_size.is_none() {
        diag.warn(
            WarningCode::BattleSizeUnmapped,
            "Battle size label could not be mapped.",
            parsed.battle_size_raw.as_deref(),
        );
    }
    let detachment_cap = detachment_cap_for(battle_size);

    // --- Detachment-point cap check (only when cap and every cost are known). -
    if let Some(cap) = detachment_cap {
        if !detachments.is_empty() && detachments.iter().all(|d| d.dp_cost.is_some()) {
            let spent: u64 = detachments.iter().map(|d| d.dp_cost.unwrap_or(0)).sum();
            if spent > cap {
                diag.warn(
                    WarningCode::DetachmentPointsExceeded,
                    &format!(
                        "Detachments cost {spent} detachment points but the {} budget is {cap}.",
                        battle_size_label(battle_size),
                    ),
                    None,
                );
            }
        }
    }

    // --- Units (and their enhancements / wargear). --------------------------
    let mut units: Vec<RosterUnit> = parsed
        .units
        .iter()
        .map(|u| resolve_unit(u, faction_id.as_deref(), &detachment_ids, ds, &mut diag))
        .collect();

    // --- Leader attachments (second pass: needs all resolved unit ids). -----
    apply_leader_attachments(
        &parsed.units,
        &mut units,
        ds,
        faction_id.as_deref(),
        &mut diag,
    );

    // --- Points reconciliation (reported vs computed kept distinct). --------
    if let Some(reported) = parsed.total_reported {
        if reported != parsed.total_computed {
            diag.warn(
                WarningCode::PointsMismatch,
                &format!(
                    "Source-reported total ({reported}) differs from the sum of cost lines ({}).",
                    parsed.total_computed
                ),
                None,
            );
        }
    }

    Roster {
        name: parsed.name.clone(),
        source: RosterSource {
            format,
            generated_by: parsed.generated_by.clone(),
        },
        faction_id,
        detachments,
        battle_size,
        // The source formats don't yet encode a Force Disposition (only the
        // canonical roster-json round-trip carries one), so this is `None`
        // unless the parsed payload supplied it.
        force_disposition: parsed.force_disposition.clone(),
        points: RosterPoints {
            declared_limit: parsed.declared_limit,
            detachment_cap,
            total_reported: parsed.total_reported,
            total_computed: parsed.total_computed,
        },
        units,
        game_version: super::types::GameVersionRef {
            edition: ROSTER_EDITION.to_string(),
            dataslate: ROSTER_DATASLATE.to_string(),
        },
        diagnostics: diag.build(),
    }
}

/// The canonical prefix the dataset uses for shared Chaos chassis ("Chaos Rhino",
/// "Chaos Land Raider", …). GW/NewRecruit subfaction exports substitute the
/// faction name for it ("Death Guard Rhino"), so swapping it back is one of the
/// candidate lookups (see [`unit_lookup_candidates`]).
const CHAOS_CHASSIS_PREFIX: &str = "Chaos ";

/// Candidate lookup strings for a unit name, in priority order. GW/NewRecruit
/// exports prefix shared chassis with the faction's display name in two forms:
/// keeping "Chaos" ("Death Guard Chaos Spawn" → dataset "Chaos Spawn") or
/// replacing it ("Death Guard Rhino" → dataset "Chaos Rhino"). When `raw_name`
/// starts with the resolved faction's display name we therefore also try the
/// prefix stripped, and the prefix replaced with [`CHAOS_CHASSIS_PREFIX`]. The
/// original `raw_name` is always what gets recorded on the ref — only the lookup
/// is adjusted. This is a general rule over all shared Chaos chassis × every
/// faction, not per-unit data. Mirror of the TS `unitLookupCandidates`.
fn unit_lookup_candidates(raw_name: &str, faction_id: Option<&str>, ds: &Dataset) -> Vec<String> {
    let mut candidates: Vec<String> = vec![raw_name.to_string()];
    let faction_name = faction_id
        .and_then(|f| ds.factions.get(f))
        .map(|f| f.name.as_str());
    if let Some(faction_name) = faction_name {
        let prefix = format!("{faction_name} ");
        if raw_name.len() > prefix.len()
            && raw_name.is_char_boundary(prefix.len())
            && raw_name.to_lowercase().starts_with(&prefix.to_lowercase())
        {
            let rest = raw_name[prefix.len()..].trim_start();
            if !rest.is_empty() {
                candidates.push(rest.to_string());
                candidates.push(format!("{CHAOS_CHASSIS_PREFIX}{rest}"));
            }
        }
    }
    // De-duplicate while preserving order (e.g. a name already starting "Chaos ").
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|c| seen.insert(c.clone()));
    candidates
}

fn resolve_unit(
    parsed: &ParsedUnit,
    faction_id: Option<&str>,
    detachment_ids: &[String],
    ds: &Dataset,
    diag: &mut DiagnosticsBuilder,
) -> RosterUnit {
    let lookup_names = unit_lookup_candidates(&parsed.raw_name, faction_id, ds);

    // Prefer a faction-scoped exact match (the same unit id recurs across
    // factions, and a stripped base name can collide with another faction's unit
    // — e.g. "Rhino" matches the Space Marine Rhino), matching canonical name or
    // alias.
    let in_faction: Vec<&crate::Unit> = faction_id
        .map(|f| ds.units.by_faction(f))
        .unwrap_or_default();
    let scoped_exact = |q: &str| -> Option<&crate::Unit> {
        let k = normalize_name(q);
        in_faction.iter().copied().find(|u| {
            normalize_name(&u.name) == k || u.aliases.iter().any(|a| normalize_name(a) == k)
        })
    };

    let mut hit: Option<&crate::Unit> = lookup_names.iter().find_map(|q| scoped_exact(q));
    // Global fallback (alias-aware via the name index); still prefer the resolved
    // faction's copy of a shared id over whichever copy registered first.
    let mut all: Vec<&crate::Unit> = Vec::new();
    if hit.is_none() {
        for q in &lookup_names {
            all = ds.units.find_all(q);
            hit = faction_id
                .and_then(|f| all.iter().copied().find(|u| u.faction_id.as_str() == f))
                .or_else(|| all.first().copied());
            if hit.is_some() {
                break;
            }
        }
    }

    let ref_ = if let Some(u) = hit {
        diag.resolved_units += 1;
        resolved(u.id.as_str(), &parsed.raw_name)
    } else {
        diag.unresolved_units += 1;
        diag.warn(
            WarningCode::UnitUnresolved,
            "Unit name did not match any 40kdc unit.",
            Some(&parsed.raw_name),
        );
        unresolved(&parsed.raw_name, unit_candidates(&all))
    };

    let enhancement = parsed
        .enhancement_raw_name
        .as_deref()
        .map(|name| resolve_enhancement(name, detachment_ids, ds, diag));
    let enhancement_points = if enhancement.is_some() {
        parsed.enhancement_points
    } else {
        None
    };

    let wargear: Vec<RosterWargear> = parsed
        .wargear
        .iter()
        .map(|w| {
            let hits = ds.weapons.find_all(&w.raw_name);
            if let Some(first) = hits.first() {
                diag.resolved_weapons += 1;
                RosterWargear {
                    ref_: resolved(first.id.as_str(), &w.raw_name),
                    count: w.count,
                }
            } else {
                diag.unresolved_weapons += 1;
                diag.warn(
                    WarningCode::WeaponUnresolved,
                    "Weapon name did not match any 40kdc weapon.",
                    Some(&w.raw_name),
                );
                RosterWargear {
                    ref_: unresolved(&w.raw_name, weapon_candidates(&hits)),
                    count: w.count,
                }
            }
        })
        .collect();

    // Reconstruct the per-model-type loadout groups deterministically from the
    // resolved unit, so a re-export reproduces the same grouped lines the exporter
    // emits (round-trip) without the text parsers understanding model-name labels.
    let loadout_groups = build_loadout_groups(hit, parsed.model_count, &wargear, ds);

    RosterUnit {
        ref_,
        model_count: parsed.model_count,
        points: parsed.points,
        is_warlord: parsed.is_warlord,
        enhancement,
        enhancement_points,
        wargear,
        loadout_groups,
        leader_attachment: None,
    }
}

/// Recompute a unit's [`RosterUnit::loadout_groups`] from its resolved wargear via
/// [`group_loadout`] — the same maths the exporter uses, so an import→export
/// round-trip is stable. `None` when the unit is unresolved, any weapon is
/// unresolved (the aggregate would be incomplete), or the loadout doesn't decompose
/// exactly. Mirror of the TS `buildLoadoutGroups`.
fn build_loadout_groups(
    hit: Option<&crate::Unit>,
    model_count: u64,
    wargear: &[RosterWargear],
    ds: &Dataset,
) -> Option<Vec<RosterLoadoutGroup>> {
    let unit = hit?;
    let mut ref_by_id: HashMap<String, ResolvedRef> = HashMap::new();
    let mut counts: BTreeMap<String, i64> = BTreeMap::new();
    for w in wargear {
        let id = w.ref_.id.as_ref()?; // incomplete aggregate → can't group faithfully
        ref_by_id.insert(id.clone(), w.ref_.clone());
        *counts.entry(id.clone()).or_insert(0) += w.count as i64;
    }
    let options = ds.wargear_options_of(unit);
    let comp = ds.unit_compositions.iter().find(|c| {
        c.unit_id.as_str() == unit.id.as_str() && c.faction_id.as_str() == unit.faction_id.as_str()
    });
    let models = comp.map(|c| loadout_models(&c.models));
    let groups = group_loadout(unit, model_count, &options, models.as_deref(), &counts)?;
    Some(
        groups
            .into_iter()
            .map(|g| RosterLoadoutGroup {
                model_name: g.model_name,
                count: g.count,
                wargear: g
                    .weapons
                    .into_iter()
                    .map(|w| RosterWargear {
                        ref_: ref_by_id
                            .get(&w.id)
                            .cloned()
                            .expect("group weapon id is a subset of the aggregate counts"),
                        count: w.count,
                    })
                    .collect(),
            })
            .collect(),
    )
}

fn resolve_enhancement(
    raw_name: &str,
    detachment_ids: &[String],
    ds: &Dataset,
    diag: &mut DiagnosticsBuilder,
) -> ResolvedRef {
    let key = normalize_name(raw_name);
    // Enhancements belong to a detachment, not a faction — scope to any of the
    // roster's resolved detachments.
    let scoped = if detachment_ids.is_empty() {
        None
    } else {
        ds.enhancements.all().iter().find(|e| {
            detachment_ids.iter().any(|d| d == e.detachment_id.as_str())
                && normalize_name(&e.name) == key
        })
    };
    let hit = scoped.or_else(|| ds.enhancements.find(raw_name));
    if let Some(hit) = hit {
        return resolved(hit.id.as_str(), raw_name);
    }
    diag.warn(
        WarningCode::EnhancementUnresolved,
        "Enhancement name did not match any 40kdc enhancement.",
        Some(raw_name),
    );
    let candidates = ds
        .enhancements
        .find_all(raw_name)
        .iter()
        .take(MAX_CANDIDATES)
        .map(|e| Candidate {
            id: e.id.as_str().to_string(),
            name: e.name.to_string(),
        })
        .collect();
    unresolved(raw_name, candidates)
}

/// Resolve leader→bodyguard attachments in two passes (mirror of the TS
/// `applyLeaderAttachments`).
///
/// 1. **Explicit** attachments carried verbatim from the source (only the
///    canonical roster-json round-trip encodes one) are reconstructed exactly —
///    the bodyguard id is re-resolved against the current dataset, but the role
///    and provisional flag are preserved. This makes the round-trip lossless,
///    including `leader`-role attachments inference never produces.
/// 2. For every other character, the source does not encode an unambiguous
///    attachment, so each **inferred** link is marked provisional. Only
///    `support` characters are auto-attached: per the GW datasheet
///    bodyguard-group data they cannot operate alone, so attaching to an
///    eligible bodyguard present in the roster is certain. A `leader` (or a
///    character with no `attachment_role`) MAY be solo — the source doesn't
///    encode the attachment, so we don't guess one. `attachment_role` is
///    faction-specific (e.g. the World Eaters Master of Executions is a leader
///    while the Chaos Space Marines one is support), so resolve faction-scoped.
fn apply_leader_attachments(
    parsed_units: &[ParsedUnit],
    units: &mut [RosterUnit],
    ds: &Dataset,
    faction_id: Option<&str>,
    diag: &mut DiagnosticsBuilder,
) {
    use crate::generated::UnitAttachmentRole;

    // --- Pass 1: explicit attachments (lossless). ----------------------------
    // Compute first (immutable borrow), then apply (mutable) to avoid overlap.
    let mut explicit: Vec<(usize, ResolvedRef, AttachmentRole, bool)> = Vec::new();
    for (i, parsed) in parsed_units.iter().enumerate() {
        let Some(att) = &parsed.leader_attachment else {
            continue;
        };
        let key = normalize_name(&att.bodyguard_raw_name);
        let Some(bodyguard) = units
            .iter()
            .find(|u| normalize_name(&u.ref_.raw_name) == key)
        else {
            continue;
        };
        let bodyguard_ref = match &bodyguard.ref_.id {
            Some(id) => resolved(id, &bodyguard.ref_.raw_name),
            None => unresolved(&bodyguard.ref_.raw_name, Vec::new()),
        };
        explicit.push((i, bodyguard_ref, att.role, att.provisional));
    }
    for (idx, bodyguard_ref, role, provisional) in explicit {
        units[idx].leader_attachment = Some(RosterLeaderAttachment {
            bodyguard_ref,
            role,
            provisional,
        });
    }

    // --- Pass 2: inference for characters without an explicit attachment. -----
    let bodyguard_ids: std::collections::HashSet<String> = units
        .iter()
        .zip(parsed_units)
        .filter(|(u, p)| u.ref_.id.is_some() && !p.is_character)
        .filter_map(|(u, _)| u.ref_.id.clone())
        .collect();

    // Resolve a unit faction-scoped (shared chassis diverge per faction in
    // `attachment_role`), falling back to first-wins by id.
    let resolve_unit = |id: &str| -> Option<&crate::Unit> {
        faction_id
            .and_then(|f| {
                ds.units
                    .by_faction(f)
                    .into_iter()
                    .find(|u| u.id.as_str() == id)
            })
            .or_else(|| ds.units.get(id))
    };

    // First compute the attachments (immutable borrow of units), then apply
    // them (mutable borrow) to avoid overlapping borrows.
    let mut planned: Vec<(usize, String, String)> = Vec::new(); // (leader idx, bodyguard id, bodyguard raw name)
    for (i, (unit, parsed)) in units.iter().zip(parsed_units).enumerate() {
        if parsed.leader_attachment.is_some() {
            continue; // explicit already applied in pass 1
        }
        let Some(leader_id) = &unit.ref_.id else {
            continue;
        };
        if !parsed.is_character {
            continue;
        }
        // Auto-attach only Support characters (they cannot operate alone).
        if resolve_unit(leader_id).and_then(|u| u.attachment_role)
            != Some(UnitAttachmentRole::Support)
        {
            continue;
        }
        let Some(attachment) = ds
            .leader_attachments
            .iter()
            .find(|la| la.leader_id.as_str() == leader_id)
        else {
            continue;
        };
        let Some(bodyguard_id) = attachment
            .eligible_bodyguard_ids
            .iter()
            .map(|e| e.as_str())
            .find(|id| bodyguard_ids.contains(*id))
        else {
            continue;
        };
        let Some(bodyguard) = units
            .iter()
            .find(|u| u.ref_.id.as_deref() == Some(bodyguard_id))
        else {
            continue;
        };
        planned.push((i, bodyguard_id.to_string(), bodyguard.ref_.raw_name.clone()));
    }

    for (idx, bodyguard_id, bodyguard_raw_name) in planned {
        units[idx].leader_attachment = Some(RosterLeaderAttachment {
            bodyguard_ref: resolved(&bodyguard_id, &bodyguard_raw_name),
            role: AttachmentRole::Support,
            provisional: true,
        });
        let leader_raw = units[idx].ref_.raw_name.clone();
        diag.warn(
            WarningCode::LeaderAttachmentInferred,
            "Support character attached to an eligible bodyguard (it cannot operate alone); provisional.",
            Some(&leader_raw),
        );
    }
}

fn unit_candidates(records: &[&crate::Unit]) -> Vec<Candidate> {
    records
        .iter()
        .take(MAX_CANDIDATES)
        .map(|u| Candidate {
            id: u.id.as_str().to_string(),
            name: u.name.to_string(),
        })
        .collect()
}

fn weapon_candidates(records: &[&crate::Weapon]) -> Vec<Candidate> {
    records
        .iter()
        .take(MAX_CANDIDATES)
        .map(|w| Candidate {
            id: w.id.as_str().to_string(),
            name: w.name.to_string(),
        })
        .collect()
}

fn detachment_candidates(records: &[&crate::Detachment]) -> Vec<Candidate> {
    records
        .iter()
        .take(MAX_CANDIDATES)
        .map(|d| Candidate {
            id: d.id.as_str().to_string(),
            name: d.name.to_string(),
        })
        .collect()
}
