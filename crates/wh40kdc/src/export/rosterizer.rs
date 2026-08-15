//! Rosterizer serializer — emits a Rosterizer-shaped roster JSON skeleton
//! that round-trips through [`RosterizerAdapter`](crate::import::RosterizerAdapter).
//!
//! The shape carries only fields the importer reads: `rulebook` (envelope),
//! `snapshot` (an `Asset` tree rooted at `Roster§Roster`), and per-unit
//! `item`/`name`/`quantity`/`stats.Points.value`/`assets.included`/`assets.traits`.
//! No `text`/`description`/`rules` ever appear — they aren't stored on the
//! Roster and emitting them could leak prose.
//!
//! Faction display names come from
//! [`title_case_id`](super::helpers::title_case_id); detachment display names
//! come from their resolved references.
//!
//! Rust mirror of `tools/src/export/rosterizer.ts`.

use serde::Serialize;

use crate::import::{BattleSize, Roster, RosterUnit, RosterWargear};

use super::helpers::{pretty_json, title_case_id, total_army_points};
use super::{ExportFormat, RosterSerializer};

const CLS_ROSTER: &str = "Roster";
const CLS_FACTION: &str = "Faction";
const CLS_DETACHMENT: &str = "Detachment";
const CLS_UNIT: &str = "Unit";
const CLS_MODEL: &str = "Model";
const CLS_WEAPON: &str = "Weapon";
const CLS_ENHANCEMENT: &str = "Enhancement";
const CLS_BATTLE_SIZE: &str = "Battle Size";
const CLS_TRAIT: &str = "Trait";
const CLS_FORCE_DISPOSITION: &str = "Force Disposition";
const CLS_ATTACHMENT: &str = "Attachment";
const CLS_CHARACTER: &str = "Character";
const CLS_KEYWORD_OVERRIDE: &str = "40kdc Keyword";
const DSG_WARLORD: &str = "Warlord";
const ITEM_SEPARATOR: char = '§';

const RULEBOOK_NAME: &str = "40kdc";
const RULEBOOK_GAME: &str = "Warhammer 40,000";
const RULEBOOK_PUBLISHER: &str = "Alpaca Software";
const RULEBOOK_URL: &str = "https://40kdc.dev";
const RULEBOOK_GENRE: &str = "wargame";

#[derive(Serialize)]
struct PointsStat {
    #[serde(rename = "Points")]
    points: StatValue,
}

#[derive(Serialize)]
struct StatValue {
    value: u64,
}

#[derive(Serialize, Default)]
struct AssetChildren {
    #[serde(skip_serializing_if = "Option::is_none")]
    included: Option<Vec<Asset>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    traits: Option<Vec<Asset>>,
}

#[derive(Serialize)]
struct Asset {
    item: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quantity: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stats: Option<PointsStat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    assets: Option<AssetChildren>,
}

#[derive(Serialize)]
struct Rulebook {
    name: &'static str,
    game: &'static str,
    publisher: &'static str,
    url: &'static str,
    genre: &'static str,
}

#[derive(Serialize)]
struct Envelope {
    slug: &'static str,
    key: &'static str,
    visible: &'static str,
    locked: bool,
    rulebook: Rulebook,
    snapshot: Asset,
}

fn item_key(classification: &str, designation: &str) -> String {
    format!("{classification}{ITEM_SEPARATOR}{designation}")
}

fn points_stat(value: Option<u64>) -> Option<PointsStat> {
    value.map(|v| PointsStat {
        points: StatValue { value: v },
    })
}

fn wargear_asset(w: &RosterWargear) -> Asset {
    Asset {
        item: item_key(CLS_WEAPON, &w.ref_.raw_name),
        name: Some(w.ref_.raw_name.clone()),
        quantity: Some(w.count),
        stats: None,
        assets: None,
    }
}

fn enhancement_asset(u: &RosterUnit) -> Option<Asset> {
    let enh = u.enhancement.as_ref()?;
    Some(Asset {
        item: item_key(CLS_ENHANCEMENT, &enh.raw_name),
        name: Some(enh.raw_name.clone()),
        quantity: Some(1),
        stats: points_stat(u.enhancement_points),
        assets: None,
    })
}

fn warlord_trait_asset() -> Asset {
    Asset {
        item: item_key(CLS_TRAIT, DSG_WARLORD),
        name: Some(DSG_WARLORD.to_string()),
        quantity: Some(1),
        stats: None,
        assets: None,
    }
}
fn attachment_asset(u: &RosterUnit) -> Option<Asset> {
    let attachment = u.leader_attachment.as_ref()?;
    let role = match attachment.role {
        crate::import::AttachmentRole::Leader => "leader",
        crate::import::AttachmentRole::Support => "support",
    };
    let provisional = if attachment.provisional {
        " [provisional]"
    } else {
        ""
    };
    let display = format!(
        "Attachment: {role} -> {}{provisional}",
        attachment.bodyguard_ref.raw_name
    );
    Some(Asset {
        item: item_key(CLS_ATTACHMENT, &display),
        name: Some(display),
        quantity: Some(1),
        stats: None,
        assets: None,
    })
}

fn keyword_trait_asset(keyword: &str) -> Asset {
    let (classification, designation) = if keyword == "Character" {
        (CLS_CHARACTER, "Detachment Character")
    } else {
        (CLS_KEYWORD_OVERRIDE, keyword)
    };
    Asset {
        item: item_key(classification, designation),
        name: Some(designation.to_string()),
        quantity: Some(1),
        stats: None,
        assets: None,
    }
}

fn loadout_group_assets(u: &RosterUnit) -> Option<Vec<Asset>> {
    let groups = u
        .loadout_groups
        .as_ref()
        .filter(|groups| !groups.is_empty())?;
    Some(
        groups
            .iter()
            .map(|group| {
                let name = group
                    .model_name
                    .as_deref()
                    .unwrap_or(&u.ref_.raw_name)
                    .to_string();
                Asset {
                    item: item_key(CLS_MODEL, &name),
                    name: Some(name),
                    quantity: Some(group.count),
                    stats: None,
                    assets: Some(AssetChildren {
                        included: Some(
                            group
                                .wargear
                                .iter()
                                .map(|item| {
                                    let mut total = item.clone();
                                    total.count *= group.count;
                                    wargear_asset(&total)
                                })
                                .collect(),
                        ),
                        traits: None,
                    }),
                }
            })
            .collect(),
    )
}

fn unit_asset(u: &RosterUnit) -> Asset {
    let mut included: Vec<Asset> = Vec::new();
    if let Some(attachment) = attachment_asset(u) {
        included.push(attachment);
    }
    if let Some(enh) = enhancement_asset(u) {
        included.push(enh);
    }
    if let Some(groups) = loadout_group_assets(u) {
        included.extend(groups);
    } else {
        included.extend(u.wargear.iter().map(wargear_asset));
    }

    let mut traits_vec: Vec<Asset> = Vec::new();
    if u.is_warlord {
        traits_vec.push(warlord_trait_asset());
    }
    traits_vec.extend(
        u.keyword_overrides
            .iter()
            .map(|keyword| keyword_trait_asset(keyword)),
    );
    let assets = if included.is_empty() && traits_vec.is_empty() {
        None
    } else {
        Some(AssetChildren {
            included: if included.is_empty() {
                None
            } else {
                Some(included)
            },
            traits: if traits_vec.is_empty() {
                None
            } else {
                Some(traits_vec)
            },
        })
    };

    Asset {
        item: item_key(CLS_UNIT, &u.ref_.raw_name),
        name: Some(u.ref_.raw_name.clone()),
        quantity: Some(u.model_count),
        stats: points_stat(u.points),
        assets,
    }
}

fn faction_asset(roster: &Roster) -> Option<Asset> {
    let display = title_case_id(roster.faction_id.as_deref())?;
    Some(Asset {
        item: item_key(CLS_FACTION, &display),
        name: Some(display),
        quantity: Some(1),
        stats: None,
        assets: None,
    })
}

fn detachment_assets(roster: &Roster) -> Vec<Asset> {
    roster
        .detachments
        .iter()
        .map(|d| {
            let display = d.ref_.raw_name.clone();
            Asset {
                item: item_key(CLS_DETACHMENT, &display),
                name: Some(display),
                quantity: Some(1),
                stats: None,
                assets: None,
            }
        })
        .collect()
}

fn battle_size_asset(roster: &Roster) -> Option<Asset> {
    let label = match roster.battle_size? {
        BattleSize::StrikeForce => format!(
            "Strike Force ({} Point limit)",
            roster.points.declared_limit.unwrap_or(2000)
        ),
        BattleSize::Incursion => format!(
            "Incursion ({} Point limit)",
            roster.points.declared_limit.unwrap_or(1000)
        ),
    };
    Some(Asset {
        item: item_key(CLS_BATTLE_SIZE, &label),
        name: Some(label),
        quantity: Some(1),
        stats: None,
        assets: None,
    })
}

fn force_disposition_asset(roster: &Roster) -> Option<Asset> {
    let display = title_case_id(roster.force_disposition.as_deref())?;
    Some(Asset {
        item: item_key(CLS_FORCE_DISPOSITION, &display),
        name: Some(display),
        quantity: Some(1),
        stats: None,
        assets: None,
    })
}

pub struct RosterizerSerializer;

impl RosterSerializer for RosterizerSerializer {
    fn id(&self) -> ExportFormat {
        ExportFormat::Rosterizer
    }

    fn serialize(&self, roster: &Roster) -> String {
        let mut included: Vec<Asset> = Vec::new();
        if let Some(f) = faction_asset(roster) {
            included.push(f);
        }
        included.extend(detachment_assets(roster));
        if let Some(disposition) = force_disposition_asset(roster) {
            included.push(disposition);
        }
        if let Some(b) = battle_size_asset(roster) {
            included.push(b);
        }
        for u in &roster.units {
            included.push(unit_asset(u));
        }

        let total = total_army_points(roster);
        let snapshot = Asset {
            item: item_key(CLS_ROSTER, CLS_ROSTER),
            name: Some(roster.name.clone()),
            quantity: Some(1),
            stats: if total > 0 {
                points_stat(Some(total))
            } else {
                None
            },
            assets: Some(AssetChildren {
                included: Some(included),
                traits: None,
            }),
        };

        let envelope = Envelope {
            slug: "",
            key: "",
            visible: "hidden",
            locked: false,
            rulebook: Rulebook {
                name: RULEBOOK_NAME,
                game: RULEBOOK_GAME,
                publisher: RULEBOOK_PUBLISHER,
                url: RULEBOOK_URL,
                genre: RULEBOOK_GENRE,
            },
            snapshot,
        };

        pretty_json(&envelope)
    }
}
