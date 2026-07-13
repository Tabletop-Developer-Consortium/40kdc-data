//! Yellowscribe serializer (`yellowscribe`) — emits a BattleScribe-compatible
//! `.ros` XML document that Yellowscribe (github.com/ThePants999/Yellowscribe)
//! ingests to build an army in Tabletop Simulator.
//!
//! Unlike every other Rust exporter this one is **Dataset-backed**: the
//! [`Roster`] carries only entity ids, counts, and points, but Yellowscribe
//! needs full datasheet stat lines, weapon profiles, keywords, and ability text
//! for its TTS tooltips and mini-datasheets. So this serializer resolves each
//! unit against the [`Dataset`] (faction-first, then any) and reads the stats /
//! weapons / abilities off the linked records. It is reached through
//! [`export_roster_with_dataset`](super::export_roster_with_dataset) rather than
//! the Dataset-free [`export_roster`](super::export_roster), so the other
//! formats are untouched.
//!
//! **IP boundary.** No GW rules prose is ever emitted. Ability descriptions come
//! from the conformance-pinned DSL describer
//! ([`describe_ability`](crate::translate::describe_ability)); the dataset stores
//! no rules text. Everything else is a numeric fact (stat lines) or a
//! community-authored name.
//!
//! **Determinism** (byte-identical across the TS/Rust/Python/Go ports for
//! conformance): no sorting — units in `roster.units` order, models in
//! `loadout_groups` order, weapons/keywords/abilities in their stored array
//! order; fixed attribute order; fixed 2-space indent + LF; deterministic
//! synthetic ids (`unit{index}`, `unit{i}-m{g}`, `unit{i}-m{g}-w{w}`); integer
//! stats plain, string stats verbatim; one shared XML escaper.
//!
//! Rust mirror of `tools/src/export/yellowscribe.ts` (and the Python
//! `python/src/wh40kdc/export/yellowscribe.py`).

use crate::data::Dataset;
use crate::generated::{
    Unit, Weapon, WeaponProfilesItem, WeaponProfilesItemKeywordsItemParameters, WeaponType,
};
use crate::import::{Roster, RosterLoadoutGroup, RosterUnit, RosterWargear};
use crate::translate::describe_ability;

use super::helpers::title_case_id;

/// BattleScribe's Warhammer 40,000 10th-edition game-system id — Yellowscribe
/// rejects a roster whose `gameSystemId` isn't this.
const GAME_SYSTEM_ID: &str = "sys-352e-adc2-7639-d6a9";
const GAME_SYSTEM_NAME: &str = "Warhammer 40,000";

// ---------------------------------------------------------------------------
// Minimal deterministic XML tree + renderer (no library — a library would
// reorder attributes or normalise whitespace, breaking byte-parity).
// ---------------------------------------------------------------------------

/// A single XML element. Attributes are held in fixed emission order (never a
/// map/hash). `text` and `children` are mutually exclusive: a `text` node is a
/// leaf whose body is escaped character data; a `children` node nests further
/// elements; an empty node (no text, no children) renders self-closing.
struct XmlEl {
    tag: &'static str,
    attrs: Vec<(&'static str, String)>,
    children: Vec<XmlEl>,
    text: Option<String>,
}

fn el(tag: &'static str, attrs: Vec<(&'static str, String)>, children: Vec<XmlEl>) -> XmlEl {
    XmlEl {
        tag,
        attrs,
        children,
        text: None,
    }
}

fn leaf(tag: &'static str, attrs: Vec<(&'static str, String)>, text: String) -> XmlEl {
    XmlEl {
        tag,
        attrs,
        children: Vec::new(),
        text: Some(text),
    }
}

/// Escape text content: `& < >`.
fn esc_text(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Escape an attribute value: `& < > "`.
fn esc_attr(s: &str) -> String {
    esc_text(s).replace('"', "&quot;")
}

fn render_attrs(attrs: &[(&'static str, String)]) -> String {
    attrs
        .iter()
        .map(|(k, v)| format!(" {k}=\"{}\"", esc_attr(v)))
        .collect()
}

fn render(node: &XmlEl, depth: usize) -> String {
    let indent = "  ".repeat(depth);
    let open = format!("<{}{}", node.tag, render_attrs(&node.attrs));
    if let Some(text) = &node.text {
        return format!("{indent}{open}>{}</{}>", esc_text(text), node.tag);
    }
    if node.children.is_empty() {
        return format!("{indent}{open}/>");
    }
    let inner = node
        .children
        .iter()
        .map(|c| render(c, depth + 1))
        .collect::<Vec<_>>()
        .join("\n");
    format!("{indent}{open}>\n{inner}\n{indent}</{}>", node.tag)
}

// ---------------------------------------------------------------------------
// Stat-line rendering (datasheet conventions; deterministic across ports).
// ---------------------------------------------------------------------------

/// Movement: append the inch mark unless the stored value already carries one.
fn fmt_move(s: &str) -> String {
    if s.ends_with('"') {
        s.to_string()
    } else {
        format!("{s}\"")
    }
}

/// A "target-number" stat (Sv, Ld, BS, WS): append `+`.
fn fmt_target(v: i64) -> String {
    format!("{v}+")
}

/// A weapon keyword's display label: `Anti-Infantry 4+`, `Rapid Fire 1`, or a
/// bare `Devastating Wounds`. Mirrors the datasheet convention.
fn keyword_label(
    name: &str,
    parameters: Option<&WeaponProfilesItemKeywordsItemParameters>,
) -> String {
    if let Some(p) = parameters {
        if let (Some(tk), Some(th)) = (p.target_keyword.as_ref(), p.threshold) {
            return format!("{name}-{} {th}+", tk.as_str());
        }
        if let Some(value) = p.value.as_ref() {
            return format!("{name} {value}");
        }
    }
    name.to_string()
}

// ---------------------------------------------------------------------------
// Profile builders.
// ---------------------------------------------------------------------------

/// The `<profile typeName="Unit">` stat line(s). Emits one profile per unit stat
/// profile (degrading/wound-track units carry several).
fn unit_stat_profiles(unit: &Unit) -> Vec<XmlEl> {
    unit.profiles
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let name = p.name.clone().unwrap_or_else(|| {
                if i == 0 {
                    unit.name.as_str().to_string()
                } else {
                    format!("{} ({})", unit.name.as_str(), i + 1)
                }
            });
            el(
                "profile",
                vec![("name", name), ("typeName", "Unit".to_string())],
                vec![el(
                    "characteristics",
                    Vec::new(),
                    vec![
                        leaf(
                            "characteristic",
                            vec![("name", "M".to_string())],
                            fmt_move(&p.m.to_string()),
                        ),
                        leaf(
                            "characteristic",
                            vec![("name", "T".to_string())],
                            p.t.to_string(),
                        ),
                        leaf(
                            "characteristic",
                            vec![("name", "SV".to_string())],
                            fmt_target(p.sv),
                        ),
                        leaf(
                            "characteristic",
                            vec![("name", "W".to_string())],
                            p.w.to_string(),
                        ),
                        leaf(
                            "characteristic",
                            vec![("name", "LD".to_string())],
                            fmt_target(p.ld),
                        ),
                        leaf(
                            "characteristic",
                            vec![("name", "OC".to_string())],
                            p.oc.to_string(),
                        ),
                    ],
                )],
            )
        })
        .collect()
}

fn ability_profile(name: &str, description: &str) -> XmlEl {
    el(
        "profile",
        vec![
            ("name", name.to_string()),
            ("typeName", "Abilities".to_string()),
        ],
        vec![el(
            "characteristics",
            Vec::new(),
            vec![leaf(
                "characteristic",
                vec![("name", "Description".to_string())],
                description.to_string(),
            )],
        )],
    )
}

/// `<profile typeName="Abilities">` entries: the invuln save (a numeric fact)
/// followed by each ability's describer-rendered text.
fn ability_profiles(unit: &Unit, dataset: &Dataset) -> Vec<XmlEl> {
    let mut out: Vec<XmlEl> = Vec::new();
    if let Some(invuln) = unit.profiles.first().and_then(|p| p.invuln_sv) {
        out.push(ability_profile(
            "Invulnerable Save",
            &format!("{invuln}+ invulnerable save"),
        ));
    }
    for ability in dataset.abilities_of(unit) {
        out.push(ability_profile(&ability.name, &describe_ability(ability)));
    }
    out
}

/// A weapon's `<profile>` list — one per weapon stat profile (e.g. a plasma
/// gun's standard / supercharge). Ranged weapons carry `BS`, melee carry `WS`
/// and a `Melee` range.
fn weapon_profiles(weapon: &Weapon, dataset: &Dataset) -> Vec<XmlEl> {
    let ranged = weapon.type_ == WeaponType::Ranged;
    let type_name = if ranged {
        "Ranged Weapons"
    } else {
        "Melee Weapons"
    };
    weapon
        .profiles
        .iter()
        .map(|p| {
            let stats = &p.stats;
            let range = if ranged {
                let raw = p
                    .range
                    .as_ref()
                    .map(|r| r.to_string())
                    .unwrap_or_else(|| "0".to_string());
                fmt_move(&raw)
            } else {
                "Melee".to_string()
            };
            let skill_name = if ranged { "BS" } else { "WS" };
            let skill = if ranged { stats.bs } else { stats.ws };
            let skill_text = match skill {
                Some(v) => fmt_target(v),
                None => "N/A".to_string(),
            };
            let keywords = keywords_label(p, dataset);
            el(
                "profile",
                vec![
                    ("name", p.name.as_str().to_string()),
                    ("typeName", type_name.to_string()),
                ],
                vec![el(
                    "characteristics",
                    Vec::new(),
                    vec![
                        leaf("characteristic", vec![("name", "Range".to_string())], range),
                        leaf(
                            "characteristic",
                            vec![("name", "A".to_string())],
                            stats.a.to_string(),
                        ),
                        leaf(
                            "characteristic",
                            vec![("name", skill_name.to_string())],
                            skill_text,
                        ),
                        leaf(
                            "characteristic",
                            vec![("name", "S".to_string())],
                            stats.s.to_string(),
                        ),
                        leaf(
                            "characteristic",
                            vec![("name", "AP".to_string())],
                            stats.ap.to_string(),
                        ),
                        leaf(
                            "characteristic",
                            vec![("name", "D".to_string())],
                            stats.d.to_string(),
                        ),
                        leaf(
                            "characteristic",
                            vec![("name", "Keywords".to_string())],
                            keywords,
                        ),
                    ],
                )],
            )
        })
        .collect()
}

/// The comma-joined keyword labels for a single weapon profile. Unresolved
/// keyword ids are skipped (mirrors `WeaponView.keywordsAt`).
fn keywords_label(profile: &WeaponProfilesItem, dataset: &Dataset) -> String {
    profile
        .keywords
        .iter()
        .filter_map(|ref_| {
            dataset
                .weapon_keywords
                .get(ref_.keyword_id.as_str())
                .map(|kw| keyword_label(kw.name.as_str(), ref_.parameters.as_ref()))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

// ---------------------------------------------------------------------------
// Selection tree.
// ---------------------------------------------------------------------------

/// Resolve a roster unit to its datasheet, faction-first (matching how a
/// `UnitView` resolves its own ids).
fn resolve_unit<'d>(
    unit: &RosterUnit,
    dataset: &'d Dataset,
    faction: Option<&str>,
) -> Option<&'d Unit> {
    let id = unit.ref_.id.as_deref()?;
    if let Some(f) = faction {
        if let Some(u) = dataset.units.get_in_faction(id, f) {
            return Some(u);
        }
    }
    dataset.units.get_any(id)
}

/// Resolve a wargear ref to its weapon, faction-first (matching how a
/// `UnitView` resolves its own weapon ids).
fn resolve_weapon<'d>(
    w: &RosterWargear,
    dataset: &'d Dataset,
    faction: Option<&str>,
) -> Option<&'d Weapon> {
    let id = w.ref_.id.as_deref()?;
    if let Some(f) = faction {
        if let Some(weapon) = dataset.weapons.get_in_faction(id, f) {
            return Some(weapon);
        }
    }
    dataset.weapons.get_any(id)
}

/// One weapon `<selection type="upgrade">`. `number` is the TOTAL across the
/// group's models (`perModel × groupModelCount`) — Yellowscribe divides it back
/// out by the model count.
fn upgrade_selection(id: String, weapon: &Weapon, total_count: u64, dataset: &Dataset) -> XmlEl {
    el(
        "selection",
        vec![
            ("id", id),
            ("name", weapon.name.as_str().to_string()),
            ("type", "upgrade".to_string()),
            ("number", total_count.to_string()),
        ],
        vec![el("profiles", Vec::new(), weapon_profiles(weapon, dataset))],
    )
}

/// One `<selection type="model">` for a loadout group, with its per-model
/// weapons nested as upgrade selections.
fn model_selection(
    id_base: &str,
    model_name: &str,
    model_count: u64,
    wargear: &[RosterWargear],
    dataset: &Dataset,
    faction: Option<&str>,
) -> XmlEl {
    let mut upgrades: Vec<XmlEl> = Vec::new();
    for (wi, w) in wargear.iter().enumerate() {
        let Some(weapon) = resolve_weapon(w, dataset, faction) else {
            continue; // unresolved weapon — skip (already flagged in diagnostics)
        };
        upgrades.push(upgrade_selection(
            format!("{id_base}-w{wi}"),
            weapon,
            w.count * model_count,
            dataset,
        ));
    }
    let mut children: Vec<XmlEl> = Vec::new();
    if !upgrades.is_empty() {
        children.push(el("selections", Vec::new(), upgrades));
    }
    el(
        "selection",
        vec![
            ("id", id_base.to_string()),
            ("name", model_name.to_string()),
            ("type", "model".to_string()),
            ("number", model_count.to_string()),
        ],
        children,
    )
}

/// The nested `<selection type="model">` list for a unit — one per loadout
/// group, falling back to a single group over the flat `wargear` (whose counts
/// are already unit totals, so per-model = total / model_count, as Yellowscribe
/// expects).
fn model_selections(
    unit: &RosterUnit,
    unit_id: &str,
    view: &Unit,
    dataset: &Dataset,
    faction: Option<&str>,
) -> Vec<XmlEl> {
    // Borrow the real groups when present, else synthesize a single fallback
    // group over the flat wargear.
    let fallback: [RosterLoadoutGroup; 1] = [RosterLoadoutGroup {
        model_name: None,
        count: unit.model_count,
        wargear: unit.wargear.clone(),
    }];
    let groups: &[RosterLoadoutGroup] = match unit.loadout_groups.as_ref() {
        Some(g) if !g.is_empty() => g.as_slice(),
        _ => &fallback,
    };
    groups
        .iter()
        .enumerate()
        .map(|(gi, g)| {
            let model_name = g
                .model_name
                .as_deref()
                .unwrap_or_else(|| view.name.as_str());
            model_selection(
                &format!("{unit_id}-m{gi}"),
                model_name,
                g.count,
                &g.wargear,
                dataset,
                faction,
            )
        })
        .collect()
}

/// The unit categories (`<category>`): faction keywords (prefixed `"Faction: "`)
/// then general keywords, in stored order.
fn categories_el(view: &Unit) -> Option<XmlEl> {
    let mut cats: Vec<XmlEl> = Vec::new();
    if let Some(fk) = view.faction_keywords.as_ref() {
        for k in fk.iter() {
            cats.push(el(
                "category",
                vec![("name", format!("Faction: {}", k.as_str()))],
                Vec::new(),
            ));
        }
    }
    if let Some(kw) = view.keywords.as_ref() {
        for k in kw.iter() {
            cats.push(el(
                "category",
                vec![("name", k.as_str().to_string())],
                Vec::new(),
            ));
        }
    }
    if cats.is_empty() {
        None
    } else {
        Some(el("categories", Vec::new(), cats))
    }
}

/// One unit `<selection type="unit">`. Returns `None` for a unit that doesn't
/// resolve against the dataset (no datasheet to emit stats from).
fn unit_selection(
    unit: &RosterUnit,
    index: usize,
    dataset: &Dataset,
    faction: Option<&str>,
) -> Option<XmlEl> {
    let view = resolve_unit(unit, dataset, faction)?;
    let unit_id = format!("unit{index}");

    let mut profiles = unit_stat_profiles(view);
    profiles.extend(ability_profiles(view, dataset));
    let mut children: Vec<XmlEl> = vec![el("profiles", Vec::new(), profiles)];

    if let Some(cats) = categories_el(view) {
        children.push(cats);
    }

    let models = model_selections(unit, &unit_id, view, dataset, faction);
    children.push(el("selections", Vec::new(), models));

    Some(el(
        "selection",
        vec![
            ("id", unit_id),
            ("name", unit.ref_.raw_name.clone()),
            ("type", "unit".to_string()),
            ("number", "1".to_string()),
        ],
        children,
    ))
}

/// Serialize a [`Roster`] into Yellowscribe-ingestible BattleScribe `.ros` XML.
pub fn serialize(roster: &Roster, dataset: &Dataset) -> String {
    let faction = roster.faction_id.as_deref();
    let faction_name = title_case_id(faction).unwrap_or_else(|| "Unknown".to_string());

    let mut unit_selections: Vec<XmlEl> = Vec::new();
    for (i, unit) in roster.units.iter().enumerate() {
        if let Some(sel) = unit_selection(unit, i, dataset, faction) {
            unit_selections.push(sel);
        }
    }

    let force = el(
        "force",
        vec![
            ("id", "force0".to_string()),
            ("name", faction_name.clone()),
            ("catalogueName", faction_name),
        ],
        vec![el("selections", Vec::new(), unit_selections)],
    );

    let roster_el = el(
        "roster",
        vec![
            ("id", "roster0".to_string()),
            ("name", roster.name.clone()),
            ("gameSystemId", GAME_SYSTEM_ID.to_string()),
            ("gameSystemName", GAME_SYSTEM_NAME.to_string()),
        ],
        vec![el("forces", Vec::new(), vec![force])],
    );

    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{}\n",
        render(&roster_el, 0)
    )
}
