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

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::data::{
    check_unit_legality, complete_loadout, group_loadout, loadout_models, loadout_tiers,
    normalize_name, strip_leading_the, Dataset, ViolationCode,
};

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

/// Singular/plural- and case-insensitive form for model-line matching:
/// [`normalize_name`] then drop every 's' at a word boundary. Exact mirror of
/// the TS `singular` (`normalizeName(s).replace(/s\b/g, "")` — a boundary is a
/// following non-`\w` character or end of string).
fn singular(s: &str) -> String {
    let n = normalize_name(s);
    let chars: Vec<char> = n.chars().collect();
    let mut out = String::with_capacity(n.len());
    for (i, &ch) in chars.iter().enumerate() {
        let next_is_word = chars
            .get(i + 1)
            .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_');
        if ch == 's' && !next_is_word {
            continue;
        }
        out.push(ch);
    }
    out
}

/// Split a dual-detachment line on its " and " / comma joiners (the resolve-time
/// fallback's tokenizer; see the detachment loop in [`resolve`]).
fn split_detachment_parts(raw: &str) -> Vec<&str> {
    let mut out = Vec::new();
    for chunk in raw.split(',') {
        for part in chunk.split(" and ") {
            let t = part.trim();
            if !t.is_empty() {
                out.push(t);
            }
        }
    }
    out
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

    let _ = parsed.multi_force;

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
    let resolve_detachment = |raw: &str| -> Option<RosterDetachment> {
        let key = normalize_name(raw);
        let scoped = faction_id.as_deref().and_then(|f| {
            ds.detachments
                .by_faction(f)
                .into_iter()
                .find(|d| normalize_name(&d.name) == key)
        });
        let hit = scoped.or_else(|| ds.detachments.find(raw))?;
        Some(RosterDetachment {
            ref_: resolved(hit.id.as_str(), raw),
            dp_cost: hit.detachment_points.map(|n| n.get()),
        })
    };
    let mut detachments: Vec<RosterDetachment> = Vec::new();
    for raw in &parsed.detachment_raw_names {
        if let Some(whole) = resolve_detachment(raw) {
            detachments.push(whole);
            continue;
        }
        // Dual-detachment 11e lists print both names on one line joined with
        // " and " ("Hexwarp Thrallband and Sekhetar Cohort") or a comma
        // ("Exhibition of Slaughter, Skysplinter Assault"). Splitting is a
        // RESOLVE-TIME fallback, taken only when the whole name fails and every
        // part resolves — "Legends of Saga and Song" is a real single-detachment
        // name a lexical split would corrupt.
        let parts = split_detachment_parts(raw);
        if parts.len() > 1 {
            let split: Vec<Option<RosterDetachment>> =
                parts.iter().map(|p| resolve_detachment(p)).collect();
            if split.iter().all(Option::is_some) {
                detachments.extend(split.into_iter().flatten());
                continue;
            }
        }
        diag.warn(
            WarningCode::DetachmentUnresolved,
            "Detachment name did not match any 40kdc detachment.",
            Some(raw),
        );
        detachments.push(RosterDetachment {
            ref_: unresolved(raw, detachment_candidates(&ds.detachments.find_all(raw))),
            dp_cost: None,
        });
    }
    let mut detachment_ids: Vec<String> = detachments
        .iter()
        .filter_map(|d| d.ref_.id.clone())
        .collect();

    // --- Force Disposition. ---------------------------------------------------
    // roster-json carries an already-resolved id; ListForge and WTC text carry
    // the raw header name (e.g. "Priority Assets"), resolved here against the
    // dataset.
    let mut force_disposition = parsed.force_disposition.clone();
    if force_disposition.is_none() {
        if let Some(Some(raw)) = parsed.force_disposition_raw_name.as_ref() {
            if let Some(hit) = ds.force_dispositions.find(raw) {
                force_disposition = Some(hit.id.to_string());
            } else {
                diag.warn(
                    WarningCode::DispositionUnresolved,
                    "Force Disposition name did not match any 40kdc disposition.",
                    Some(raw),
                );
            }
        }
    }

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
    if faction_id.is_none() {
        let inferred: HashSet<String> = units
            .iter()
            .filter_map(|unit| {
                unit.ref_
                    .id
                    .as_deref()
                    .and_then(|id| ds.units.get_any(id))
                    .map(|unit| unit.faction_id.to_string())
            })
            .collect();
        if inferred.len() == 1 {
            faction_id = inferred.into_iter().next();
        }
    }

    // Metadata-free sources can identify one detachment through enhancement
    // ownership. Once that is known, infer a disposition only when every
    // selected detachment grants the same sole disposition.
    if detachments.is_empty() {
        let inferred: HashSet<String> = units
            .iter()
            .filter_map(|unit| {
                unit.enhancement
                    .as_ref()
                    .and_then(|enhancement| enhancement.id.as_deref())
                    .and_then(|id| ds.enhancements.get(id))
                    .map(|enhancement| enhancement.detachment_id.to_string())
            })
            .collect();
        if inferred.len() == 1 {
            let id = inferred
                .into_iter()
                .next()
                .expect("one inferred detachment");
            if let Some(detachment) = faction_id
                .as_deref()
                .and_then(|faction| ds.detachments.get_in_faction(&id, faction))
                .or_else(|| ds.detachments.get_any(&id))
            {
                detachments.push(RosterDetachment {
                    ref_: resolved(detachment.id.as_str(), detachment.name.as_str()),
                    dp_cost: detachment.detachment_points.map(|cost| cost.get()),
                });
                detachment_ids.push(id);
            }
        }
    }
    if force_disposition.is_none()
        && (matches!(parsed.force_disposition_raw_name, Some(None))
            || (parsed.force_disposition_raw_name.is_none()
                && !matches!(format, RosterFormat::Listforge | RosterFormat::RosterJson)))
    {
        let detachment_for = |id: &str| {
            faction_id
                .as_deref()
                .and_then(|faction| ds.detachments.get_in_faction(id, faction))
                .or_else(|| ds.detachments.get_any(id))
        };
        let disposition_ids: HashSet<String> = detachment_ids
            .iter()
            .flat_map(|id| {
                detachment_for(id)
                    .and_then(|detachment| detachment.force_dispositions.as_ref())
                    .into_iter()
                    .flatten()
                    .map(|disposition| disposition.as_str().to_owned())
            })
            .collect();
        let unique_per_detachment = !detachment_ids.is_empty()
            && detachment_ids.iter().all(|id| {
                detachment_for(id)
                    .and_then(|detachment| detachment.force_dispositions.as_ref())
                    .is_some_and(|dispositions| dispositions.len() == 1)
            });
        if unique_per_detachment && disposition_ids.len() == 1 {
            force_disposition = disposition_ids.into_iter().next();
        }
    }

    // Some GW exports omit Warlord while retaining explicit Character metadata.
    if format == RosterFormat::Gw && !units.iter().any(|unit| unit.is_warlord) {
        if let Some(index) = parsed.units.iter().position(|unit| unit.is_character) {
            units[index].is_warlord = true;
        }
    }

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
        force_disposition,
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

    // ── Model-line reclassification ────────────────────────────────────────
    // The flat GW dialects print model bullets at the same indent as weapon
    // bullets, so the parser cannot tell "• 9x Pathfinder" from "• 10x Pulse
    // carbine" — the model names land in `wargear` and `model_count` collapses
    // to its 1 fallback. The RESOLVED unit knows its composition row names —
    // and its own name covers vehicle squadrons ("2x Hippogriff AFV") — so a
    // wargear entry matching one (singular/plural-insensitive) is a model
    // line: its count rebuilds the model count and it leaves the wargear bag.
    // Mirror of the TS reference.
    let mut model_count = parsed.model_count;
    let mut wargear_lines: Vec<&crate::import::types::ParsedWargear> =
        parsed.wargear.iter().collect();
    if let Some(unit) = hit {
        let mut model_names: HashSet<String> = HashSet::new();
        model_names.insert(singular(&unit.name));
        for alias in &unit.aliases {
            model_names.insert(singular(alias));
        }
        if let Some(comp) = ds.unit_compositions.iter().find(|c| {
            c.unit_id.as_str() == unit.id.as_str()
                && c.faction_id.as_str() == unit.faction_id.as_str()
        }) {
            for m in &comp.models {
                model_names.insert(singular(&m.name));
            }
        }
        let model_lines: Vec<&crate::import::types::ParsedWargear> = parsed
            .wargear
            .iter()
            .filter(|w| model_names.contains(&singular(&w.raw_name)))
            .collect();
        let model_sum: u64 = model_lines.iter().map(|w| w.count as u64).sum();
        if model_sum > 0 {
            wargear_lines = parsed
                .wargear
                .iter()
                .filter(|w| !model_names.contains(&singular(&w.raw_name)))
                .collect();
            // When the reclassified lines cover EVERY composition row name, they
            // fully enumerate the unit and the parser's count was its synthetic 1
            // fallback — the sum stands alone. Any uncovered row means the parser
            // genuinely counted those models (a colon-dialect line) and the flat
            // lines are the REST of the squad — the counts add. Mirror of TS.
            let line_names: HashSet<String> =
                model_lines.iter().map(|w| singular(&w.raw_name)).collect();
            let covered = ds
                .unit_compositions
                .iter()
                .find(|c| {
                    c.unit_id.as_str() == unit.id.as_str()
                        && c.faction_id.as_str() == unit.faction_id.as_str()
                })
                .map(|c| {
                    c.models
                        .iter()
                        .all(|m| line_names.contains(&singular(&m.name)))
                })
                .unwrap_or(true);
            model_count = if covered {
                model_sum
            } else {
                model_count + model_sum
            };
        }
    }

    let mut wargear = Vec::new();
    for w in wargear_lines.iter().copied() {
        if let Some(ref_) = resolve_gear_ref(ds, hit, &w.raw_name) {
            diag.resolved_weapons += 1;
            wargear.push(RosterWargear {
                ref_,
                count: w.count,
            });
            continue;
        }

        let parts = split_gear_parts(&w.raw_name);
        if parts.len() > 1 {
            let refs: Vec<Option<ResolvedRef>> = parts
                .iter()
                .map(|part| resolve_gear_ref(ds, hit, part))
                .collect();
            if refs.iter().all(Option::is_some) {
                diag.resolved_weapons += parts.len() as u64;
                for (index, ref_) in refs.into_iter().flatten().enumerate() {
                    wargear.push(RosterWargear {
                        ref_,
                        count: if index == 0 { w.count } else { 1 },
                    });
                }
                continue;
            }
        }

        let hits = find_weapon_candidates(ds, &w.raw_name);
        diag.unresolved_weapons += 1;
        diag.warn(
            WarningCode::WeaponUnresolved,
            "Weapon name did not match any 40kdc weapon.",
            Some(&w.raw_name),
        );
        wargear.push(RosterWargear {
            ref_: unresolved(&w.raw_name, weapon_candidates(&hits)),
            count: w.count,
        });
    }
    // Preserve exact groups carried by a source format. Their totals are
    // authoritative, including defaults absent from the flat aggregate.
    let mut loadout_groups = parsed
        .loadout_groups
        .as_deref()
        .map(|groups| resolve_explicit_loadout_groups(groups, &wargear, ds, hit));
    if let Some(groups) = loadout_groups.as_ref() {
        if groups
            .iter()
            .all(|group| group.wargear.iter().all(|item| item.ref_.id.is_some()))
        {
            reconcile_grouped_wargear(&mut wargear, groups, diag);
        }
    }
    // No source groups: first prove the reported aggregate exact, then complete
    // only omitted defaults when it cannot be partitioned. This order is the
    // TS contract and prevents completion from replacing an already exact,
    // equally-valid source partition.
    if loadout_groups.is_none() {
        loadout_groups = build_loadout_groups(hit, model_count, &wargear, ds);
        if loadout_groups.is_none() {
            loadout_groups = complete_implicit_defaults(hit, model_count, &mut wargear, ds, diag);
        }
    }

    let mut keyword_overrides = Vec::new();
    let mut seen_keyword_overrides = HashSet::new();
    for keyword in parsed.keyword_overrides.as_deref().unwrap_or(&[]) {
        if seen_keyword_overrides.insert(keyword.clone()) {
            keyword_overrides.push(keyword.clone());
        }
    }
    if parsed.is_character
        && hit.is_some_and(|unit| {
            !matches!(
                unit.role,
                Some(crate::generated::UnitRole::Character)
                    | Some(crate::generated::UnitRole::EpicHero)
            ) && !unit.keywords.as_ref().is_some_and(|keywords| {
                keywords
                    .0
                    .iter()
                    .any(|keyword| keyword.as_str() == "Character")
            })
        })
        && !keyword_overrides
            .iter()
            .any(|keyword| keyword == "Character")
    {
        keyword_overrides.push("Character".to_string());
    }
    // Gated exactly like grouping (an unresolved unit has no datasheet; an
    // unresolved weapon means the counts under-report the list), plus two
    // import-specific reliability gates: the parsed model count must sit inside
    // the composition envelope (the GW flat dialect infers `model_count: 1` for
    // some units, so `invalid-model-count` is also filtered), and `below-min` is
    // filtered (list formats omit implicit default weapons). Mirror of the TS
    // reference.
    if let Some(unit) = hit {
        if wargear.iter().all(|w| w.ref_.id.is_some()) {
            let comp = ds.unit_compositions.iter().find(|c| {
                c.unit_id.as_str() == unit.id.as_str()
                    && c.faction_id.as_str() == unit.faction_id.as_str()
            });
            let models = comp.map(|c| loadout_models(&c.models));
            let rows = models.as_deref().unwrap_or(&[]);
            let env_min: u64 = rows.iter().map(|m| m.min).sum();
            let env_max: u64 = rows.iter().map(|m| m.max).sum();
            let plausible = rows.is_empty() || (model_count >= env_min && model_count <= env_max);
            if plausible {
                let mut counts: HashMap<String, i64> = HashMap::new();
                for w in &wargear {
                    if let Some(id) = &w.ref_.id {
                        *counts.entry(id.clone()).or_insert(0) += w.count as i64;
                    }
                }
                let options = ds.wargear_options_of(unit);
                let tiers = comp.map(|c| loadout_tiers(&c.tiers));
                let violations: Vec<_> = check_unit_legality(
                    unit,
                    model_count,
                    &options,
                    &counts,
                    models.as_deref(),
                    tiers.as_deref(),
                )
                .into_iter()
                .filter(|v| {
                    v.code != ViolationCode::InvalidModelCount && v.code != ViolationCode::BelowMin
                })
                .collect();
                if !violations.is_empty() {
                    let detail = violations
                        .iter()
                        .map(|v| format!("{}:{}", v.code.as_str(), v.id))
                        .collect::<Vec<_>>()
                        .join(", ");
                    diag.warn(
                        WarningCode::LoadoutIllegal,
                        &format!(
                            "Loadout is not buildable from the datasheet's wargear options: {detail}"
                        ),
                        Some(&parsed.raw_name),
                    );
                }
            }
        }
    }

    RosterUnit {
        ref_,

        model_count,
        keyword_overrides,
        points: parsed.points,
        is_warlord: parsed.is_warlord,
        enhancement,
        enhancement_points,
        wargear,
        loadout_groups,
        leader_attachment: None,
    }
}
/// Complete omitted implicit default weapons for aggregate-only source formats.
///
/// On a successful bounded completion, first source occurrences retain their raw
/// references and order, aggregate counts are replaced, and missing defaults append.
/// An impossible explicit combination leaves the aggregate untouched.
fn complete_implicit_defaults(
    hit: Option<&crate::Unit>,
    model_count: u64,
    wargear: &mut Vec<RosterWargear>,
    ds: &Dataset,
    diag: &mut DiagnosticsBuilder,
) -> Option<Vec<RosterLoadoutGroup>> {
    let unit = hit?;
    if wargear.iter().any(|item| item.ref_.id.is_none()) {
        return None;
    }
    let models = ds
        .unit_compositions
        .iter()
        .find(|composition| {
            composition.unit_id.as_str() == unit.id.as_str()
                && composition.faction_id.as_str() == unit.faction_id.as_str()
        })
        .map(|composition| loadout_models(&composition.models));
    let mut explicit_refs = HashMap::new();
    let mut explicit_counts = BTreeMap::new();
    for item in wargear.iter() {
        let id = item.ref_.id.as_ref().expect("checked resolved aggregate");
        explicit_refs
            .entry(id.clone())
            .or_insert_with(|| item.ref_.clone());
        *explicit_counts.entry(id.clone()).or_insert(0) += item.count as i64;
    }
    let completed = complete_loadout(
        unit,
        model_count,
        &ds.wargear_options_of(unit),
        models.as_deref(),
        &explicit_counts,
    )?;
    let ref_for_id = |id: &str| {
        explicit_refs.get(id).cloned().unwrap_or_else(|| {
            let name = ds
                .weapons
                .get_any(id)
                .map(|weapon| weapon.name.to_string())
                .or_else(|| ds.wargear.get(id).map(|item| item.name.to_string()))
                .or_else(|| {
                    ds.abilities
                        .get_any(id)
                        .map(|ability| ability.name.to_string())
                })
                .unwrap_or_else(|| id.to_owned());
            resolved(id, &name)
        })
    };
    let mut remaining: BTreeMap<String, RosterWargear> = completed
        .counts
        .iter()
        .map(|(id, count)| {
            (
                id.clone(),
                RosterWargear {
                    ref_: ref_for_id(id),
                    count: *count as u64,
                },
            )
        })
        .collect();
    let mut seen = HashSet::new();
    let mut rewritten = Vec::new();
    for item in wargear.drain(..) {
        let id = item.ref_.id.clone().expect("checked resolved aggregate");
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Some(replacement) = remaining.remove(&id) {
            rewritten.push(replacement);
        }
    }
    let added = remaining
        .keys()
        .filter(|id| !explicit_refs.contains_key(*id))
        .count() as u64;
    rewritten.extend(remaining.into_values());
    *wargear = rewritten;
    diag.resolved_weapons += added;
    completed.groups.map(|groups| {
        groups
            .into_iter()
            .map(|group| RosterLoadoutGroup {
                model_name: group.model_name,
                count: group.count,
                wargear: group
                    .weapons
                    .into_iter()
                    .map(|weapon| RosterWargear {
                        ref_: ref_for_id(&weapon.id),
                        count: weapon.count,
                    })
                    .collect(),
            })
            .collect()
    })
}

/// Resolve source-supplied group entries, preferring the aggregate's exact ref
/// but resolving group-only implicit defaults through the same gear pipeline.
fn resolve_explicit_loadout_groups(
    groups: &[super::types::ParsedLoadoutGroup],
    aggregate: &[RosterWargear],
    ds: &Dataset,
    hit: Option<&crate::Unit>,
) -> Vec<RosterLoadoutGroup> {
    groups
        .iter()
        .map(|group| RosterLoadoutGroup {
            model_name: group.model_name.clone(),
            count: group.count,
            wargear: group
                .wargear
                .iter()
                .flat_map(|item| {
                    if let Some(candidate) = aggregate.iter().find(|candidate| {
                        normalize_name(&candidate.ref_.raw_name) == normalize_name(&item.raw_name)
                    }) {
                        return vec![RosterWargear {
                            ref_: candidate.ref_.clone(),
                            count: item.count,
                        }];
                    }
                    if let Some(ref_) = resolve_gear_ref(ds, hit, &item.raw_name) {
                        return vec![RosterWargear {
                            ref_,
                            count: item.count,
                        }];
                    }
                    let parts = split_gear_parts(&item.raw_name);
                    if parts.len() > 1 {
                        let refs: Vec<Option<ResolvedRef>> = parts
                            .iter()
                            .map(|part| resolve_gear_ref(ds, hit, part))
                            .collect();
                        if refs.iter().all(Option::is_some) {
                            return refs
                                .into_iter()
                                .flatten()
                                .map(|ref_| RosterWargear {
                                    ref_,
                                    count: item.count,
                                })
                                .collect();
                        }
                    }
                    vec![RosterWargear {
                        ref_: unresolved(&item.raw_name, Vec::new()),
                        count: item.count,
                    }]
                })
                .collect(),
        })
        .collect()
}

/// Replace aggregate counts with the exact totals implied by source groups while
/// retaining aggregate order. Group-only items append in their first group order.
fn reconcile_grouped_wargear(
    aggregate: &mut Vec<RosterWargear>,
    groups: &[RosterLoadoutGroup],
    diag: &mut DiagnosticsBuilder,
) {
    let mut grouped: HashMap<String, RosterWargear> = HashMap::new();
    let mut group_order = Vec::new();
    for group in groups {
        for item in &group.wargear {
            let id = item.ref_.id.clone().expect("checked resolved group weapon");
            let total = group.count * item.count;
            if let Some(existing) = grouped.get_mut(&id) {
                existing.count += total;
            } else {
                group_order.push(id.clone());
                grouped.insert(
                    id,
                    RosterWargear {
                        ref_: item.ref_.clone(),
                        count: total,
                    },
                );
            }
        }
    }
    let original_ids: HashSet<String> = aggregate
        .iter()
        .filter_map(|item| item.ref_.id.clone())
        .collect();
    let mut seen = HashSet::new();
    let mut reconciled = Vec::new();
    for item in aggregate.drain(..) {
        let Some(id) = item.ref_.id.clone() else {
            reconciled.push(item);
            continue;
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Some(replacement) = grouped.remove(&id) {
            reconciled.push(replacement);
        } else {
            reconciled.push(item);
        }
    }
    for id in group_order {
        if let Some(item) = grouped.remove(&id) {
            if !original_ids.contains(&id) {
                diag.resolved_weapons += 1;
            }
            reconciled.push(item);
        }
    }
    *aggregate = reconciled;
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
    if model_count <= 1 {
        return None;
    }
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
        // Only an inner `Some` is an explicit attachment; `Some(None)` (an
        // adapter that sets the key on every unit, e.g. ListForge text) is
        // treated like `None` and left to Pass 2 inference.
        let Some(Some(att)) = &parsed.leader_attachment else {
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
            .or_else(|| ds.units.get_any(id))
    };

    // First compute the attachments (immutable borrow of units), then apply
    // them (mutable borrow) to avoid overlapping borrows.
    let mut planned: Vec<(usize, String, String)> = Vec::new(); // (leader idx, bodyguard id, bodyguard raw name)
    for (i, (unit, parsed)) in units.iter().zip(parsed_units).enumerate() {
        if matches!(parsed.leader_attachment, Some(Some(_))) {
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

/// Split a generator's prose `and` join only after an unsplit lookup fails.
/// Lowercasing preserves ASCII byte offsets, which is sufficient for this
/// syntax marker while leaving the original Unicode names untouched.
fn split_gear_parts(raw_name: &str) -> Vec<&str> {
    let lower = raw_name.to_ascii_lowercase();
    let mut parts = Vec::new();
    let mut start = 0;
    let mut search = 0;
    while let Some(offset) = lower[search..].find(" and ") {
        let index = search + offset;
        let part = raw_name[start..index].trim();
        if !part.is_empty() {
            parts.push(part);
        }
        start = index + 5;
        search = start;
    }
    let tail = raw_name[start..].trim();
    if !tail.is_empty() {
        parts.push(tail);
    }
    parts
}

/// The shared source-format gear resolver. Ordering matters: per-unit weapon
/// variants, then global weapons, then non-weapon wargear, then unit abilities.
fn resolve_gear_ref(
    ds: &Dataset,
    hit: Option<&crate::Unit>,
    raw_name: &str,
) -> Option<ResolvedRef> {
    if let Some(id) = hit.and_then(|unit| scoped_weapon_id(ds, unit, raw_name)) {
        return Some(resolved(id, raw_name));
    }
    if let Some(weapon) = find_weapon_candidates(ds, raw_name).first() {
        return Some(resolved(weapon.id.as_str(), raw_name));
    }
    if let Some(id) = resolve_wargear_item_id(ds, hit, raw_name) {
        return Some(resolved(id, raw_name));
    }
    resolve_unit_ability_id(ds, hit, raw_name).map(|id| resolved(id, raw_name))
}

/// Resolve a weapon raw name to candidate weapons, tolerating a leading "The "
/// mismatch in either direction (NewRecruit "The Bloody Twins" ↔ data "Bloody
/// Twins"; GW "Fire Axe" ↔ data "The Fire Axe"). Tries the name as given, then
/// the "The"-stripped form, then the "The"-prefixed form, returning the first
/// non-empty match set. Mirror of the TS `findWeaponCandidates`.
fn find_weapon_candidates<'a>(ds: &'a Dataset, raw_name: &str) -> Vec<&'a crate::Weapon> {
    let direct = ds.weapons.find_all(raw_name);
    if !direct.is_empty() {
        return direct;
    }
    if let Some(stripped) = strip_leading_the(raw_name) {
        let hits = ds.weapons.find_all(&stripped);
        if !hits.is_empty() {
            return hits;
        }
    }
    ds.weapons.find_all(&format!("The {raw_name}"))
}

/// Resolve a weapon raw name to one of the RESOLVED unit's own weapon ids — its
/// `weapon_ids` plus ids reachable through its wargear options. Per-unit stat
/// variants share a NAME, so a name match must pick the variant the resolved
/// unit actually fields. Matches by `normalize_name` with the same leading-"The"
/// tolerance as `find_weapon_candidates`; returns None when the unit fields no
/// weapon of that name (the caller falls back to the global lookup). Mirror of
/// the TS `scopedWeaponId`.
fn scoped_weapon_id<'a>(ds: &'a Dataset, unit: &crate::Unit, raw_name: &str) -> Option<&'a str> {
    let mut targets = vec![
        normalize_name(raw_name),
        normalize_name(&format!("The {raw_name}")),
    ];
    if let Some(stripped) = strip_leading_the(raw_name) {
        targets.push(normalize_name(&stripped));
    }
    let matches = |id: &str| -> Option<&'a str> {
        ds.weapons
            .get_in_faction(id, unit.faction_id.as_str())
            .or_else(|| ds.weapons.get_any(id))
            .filter(|w| targets.iter().any(|t| *t == normalize_name(&w.name)))
            .map(|w| w.id.as_str())
    };
    for id in &unit.weapon_ids {
        if let Some(found) = matches(id.as_str()) {
            return Some(found);
        }
    }
    for opt in ds.wargear_options_of(unit) {
        for id in opt
            .replaces
            .iter()
            .chain(&opt.replacement)
            .chain(opt.replacement_choice.iter().flatten())
        {
            if let Some(found) = matches(id.as_str()) {
                return Some(found);
            }
        }
    }
    None
}

/// Fallback for wargear ITEMS (Simulacrum Imperialis, Daemonic Icon, …) — raw
/// names that are not weapons but do exist in the wargear collection. Runs only
/// after BOTH weapon lookups miss, so a wargear item whose name collides with a
/// weapon ("multi-melta", "power weapon") keeps resolving to the weapon exactly
/// as before. Scoped-first: ids reachable through the resolved unit's wargear
/// options, then the global collection (wargear is replicated-identical across
/// factions, so a global first-match is safe). Same `normalize_name` +
/// leading-"The" tolerance as the weapon lookups. Mirror of the TS
/// `resolveWargearItemId`.
fn resolve_wargear_item_id<'a>(
    ds: &'a Dataset,
    hit: Option<&crate::Unit>,
    raw_name: &str,
) -> Option<&'a str> {
    let stripped = strip_leading_the(raw_name);
    if let Some(unit) = hit {
        let mut targets = vec![
            normalize_name(raw_name),
            normalize_name(&format!("The {raw_name}")),
        ];
        if let Some(s) = &stripped {
            targets.push(normalize_name(s));
        }
        for opt in ds.wargear_options_of(unit) {
            for id in opt
                .replaces
                .iter()
                .chain(&opt.replacement)
                .chain(opt.replacement_choice.iter().flatten())
            {
                if let Some(item) = ds.wargear.get_any(id.as_str()) {
                    if targets.iter().any(|t| *t == normalize_name(&item.name)) {
                        return Some(item.id.as_str());
                    }
                }
            }
        }
    }
    if let Some(item) = ds.wargear.find(raw_name) {
        return Some(item.id.as_str());
    }
    if let Some(s) = &stripped {
        if let Some(item) = ds.wargear.find(s) {
            return Some(item.id.as_str());
        }
    }
    ds.wargear
        .find(&format!("The {raw_name}"))
        .map(|item| item.id.as_str())
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

/// Resolve a bare unit ability emitted in an equipment line. Like weapons,
/// shared ids select the resolved unit's faction copy before the global core
/// fallback.
fn resolve_unit_ability_id<'a>(
    ds: &'a Dataset,
    hit: Option<&crate::Unit>,
    raw_name: &str,
) -> Option<&'a str> {
    let unit = hit?;
    let mut targets = vec![
        normalize_name(raw_name),
        normalize_name(&format!("The {raw_name}")),
    ];
    if let Some(stripped) = strip_leading_the(raw_name) {
        targets.push(normalize_name(&stripped));
    }
    for id in &unit.ability_ids {
        let Some(ability) = ds
            .abilities
            .get_in_faction(id.as_str(), unit.faction_id.as_str())
            .or_else(|| ds.abilities.get_any(id.as_str()))
        else {
            continue;
        };
        if targets
            .iter()
            .any(|target| *target == normalize_name(&ability.name))
        {
            return Some(ability.ability_id.as_str());
        }
    }
    None
}
