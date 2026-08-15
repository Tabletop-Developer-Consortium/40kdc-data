//! Integration tests for the ListForge importer over the real embedded data.
//!
//! Reuses the same fixtures the TypeScript suite uses
//! (`tools/test/fixtures/import/*`), so both implementations are pinned to one
//! corpus. Rust mirror of `tools/test/import/{listforge,resolve}.test.ts`.

#![cfg(feature = "import")]

use std::path::PathBuf;

use serde_json::Value;
use wh40kdc::import::{import_roster, FormatAdapter, ListForgeAdapter, Roster};
use wh40kdc::Dataset;

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tools/test/fixtures/import")
        .join(name);
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
    serde_json::from_str(&raw).expect("fixture is valid JSON")
}

fn import(name: &str) -> Roster {
    import_roster(&fixture(name), Dataset::embedded()).expect("import succeeds")
}

fn unit_by_id<'a>(r: &'a Roster, id: &str) -> Option<&'a wh40kdc::import::RosterUnit> {
    r.units.iter().find(|u| u.ref_.id.as_deref() == Some(id))
}

// --- adapter (parse only) ---------------------------------------------------

#[test]
fn detects_a_listforge_payload() {
    let adapter = ListForgeAdapter;
    assert!(adapter.detect(&fixture("gk-banishers.payload.json")));
    assert!(!adapter.detect(&serde_json::json!({ "not": "a roster" })));
}

#[test]
fn parse_extracts_faction_detachment_and_battle_size() {
    let parsed = ListForgeAdapter
        .parse(&fixture("gk-banishers.payload.json"))
        .unwrap();
    assert_eq!(parsed.faction_raw_name.as_deref(), Some("Grey Knights"));
    assert_eq!(parsed.detachment_raw_names, vec!["Banishers".to_string()]);
    assert!(parsed
        .battle_size_raw
        .as_deref()
        .unwrap()
        .contains("Strike Force"));
    assert_eq!(parsed.declared_limit, Some(2000));
}

#[test]
fn parse_sums_computed_total_across_cost_lines() {
    let parsed = ListForgeAdapter
        .parse(&fixture("gk-banishers.payload.json"))
        .unwrap();
    assert_eq!(parsed.total_reported, Some(585));
    assert_eq!(parsed.total_computed, 585); // 90 + 225 + 20 + 250
}

#[test]
fn parse_extracts_units_with_model_counts() {
    let parsed = ListForgeAdapter
        .parse(&fixture("gk-banishers.payload.json"))
        .unwrap();
    let names: Vec<&str> = parsed.units.iter().map(|u| u.raw_name.as_str()).collect();
    assert!(names.contains(&"Castellan Crowe"));
    assert!(names.contains(&"Grand Master in Nemesis Dreadknight"));
    assert!(names.contains(&"Purifier Squad"));

    let squad = parsed
        .units
        .iter()
        .find(|u| u.raw_name == "Purifier Squad")
        .unwrap();
    assert_eq!(squad.model_count, 10); // 1 Knight of the Flame + 9 Purifiers
}

#[test]
fn parse_flags_warlord_and_enhancement() {
    let parsed = ListForgeAdapter
        .parse(&fixture("gk-banishers.payload.json"))
        .unwrap();
    let gm = parsed
        .units
        .iter()
        .find(|u| u.raw_name.starts_with("Grand Master"))
        .unwrap();
    assert!(gm.is_warlord);
    assert_eq!(
        gm.enhancement_raw_name.as_deref(),
        Some("Pyresoul (Psychic)")
    );
    assert!(gm.is_character);
}

#[test]
fn parse_collects_wargear_without_enhancement_or_warlord() {
    let parsed = ListForgeAdapter
        .parse(&fixture("gk-banishers.payload.json"))
        .unwrap();
    let gm = parsed
        .units
        .iter()
        .find(|u| u.raw_name.starts_with("Grand Master"))
        .unwrap();
    let weapons: Vec<&str> = gm.wargear.iter().map(|w| w.raw_name.as_str()).collect();
    assert!(weapons.contains(&"Heavy psycannon"));
    assert!(weapons.contains(&"Nemesis daemon greathammer"));
    assert!(!weapons.contains(&"Pyresoul (Psychic)"));
    assert!(!weapons.contains(&"Warlord"));
}

#[test]
fn parsed_output_leaks_no_prose_field_names() {
    let parsed = ListForgeAdapter
        .parse(&fixture("gk-banishers.payload.json"))
        .unwrap();
    // ParsedRoster carries no serde derive; assert structurally that no raw
    // name smuggled a description/$text payload through.
    for unit in &parsed.units {
        assert!(!unit.raw_name.contains("description"));
        assert!(!unit.raw_name.contains("$text"));
    }
}

// --- resolve (against embedded grey-knights data) ---------------------------

#[test]
fn resolves_faction_detachment_and_battle_size() {
    let roster = import("gk-banishers.payload.json");
    assert_eq!(roster.faction_id.as_deref(), Some("grey-knights"));
    assert_eq!(
        roster
            .detachments
            .iter()
            .map(|d| d.ref_.id.as_deref())
            .collect::<Vec<_>>(),
        vec![Some("banishers")]
    );
    assert_eq!(
        roster.battle_size,
        Some(wh40kdc::import::BattleSize::StrikeForce)
    );
    assert_eq!(roster.points.declared_limit, Some(2000));
    assert_eq!(roster.points.total_reported, Some(585));
    assert_eq!(roster.points.total_computed, 585);
}

#[test]
fn resolves_units_to_entity_ids() {
    let roster = import("gk-banishers.payload.json");
    assert!(unit_by_id(&roster, "castellan-crowe").is_some());
    assert!(unit_by_id(&roster, "grand-master-in-nemesis-dreadknight").is_some());
    assert!(unit_by_id(&roster, "purifier-squad").is_some());
}

#[test]
fn resolves_enhancement_scoped_to_detachment() {
    let roster = import("gk-banishers.payload.json");
    let gm = unit_by_id(&roster, "grand-master-in-nemesis-dreadknight").unwrap();
    assert!(gm.is_warlord);
    let enh = gm.enhancement.as_ref().unwrap();
    assert_eq!(enh.id.as_deref(), Some("pyresoul-psychic-banishers"));
    assert!(enh.resolved);
}

#[test]
fn resolves_wargear_to_weapon_ids() {
    let roster = import("gk-banishers.payload.json");
    let gm = unit_by_id(&roster, "grand-master-in-nemesis-dreadknight").unwrap();
    let ids: Vec<&str> = gm
        .wargear
        .iter()
        .filter_map(|w| w.ref_.id.as_deref())
        .collect();
    assert!(ids.contains(&"heavy-psycannon"));
    assert!(ids.contains(&"nemesis-daemon-greathammer"));
    assert!(gm.wargear.iter().all(|w| w.ref_.resolved));
}

#[test]
fn reports_clean_diagnostics_for_fully_resolved_list() {
    let roster = import("gk-banishers.payload.json");
    assert_eq!(roster.diagnostics.resolved_units, 3);
    assert_eq!(roster.diagnostics.unresolved_units, 0);
    assert_eq!(roster.diagnostics.unresolved_weapons, 0);
}

// A "support" character (dump-sourced attachment_role) cannot be fielded solo,
// so it is auto-attached to an eligible bodyguard in the roster. A Painboy joins
// a Boyz mob. (A solo-capable "leader" is NOT auto-attached — see the next test.)
fn support_attachment_payload() -> serde_json::Value {
    serde_json::json!({
        "name": "Leader Test",
        "generatedBy": "List Forge",
        "roster": {
            "name": "Leader Test",
            "costs": [{ "name": "pts", "value": 0 }],
            "forces": [{
                "id": "f1",
                "name": "Army Roster",
                "selections": [
                    {
                        "id": "u-painboy", "name": "Painboy", "type": "model", "number": 1,
                        "categories": [{ "name": "Faction: Orks" }, { "name": "Character", "primary": true }]
                    },
                    {
                        "id": "u-boyz", "name": "Boyz", "type": "unit", "number": 10,
                        "categories": [{ "name": "Faction: Orks" }, { "name": "Infantry", "primary": true }]
                    }
                ]
            }]
        }
    })
}

#[test]
fn infers_a_provisional_leader_attachment() {
    let roster = import_roster(&support_attachment_payload(), Dataset::embedded()).unwrap();
    let pb = unit_by_id(&roster, "painboy").unwrap();
    let attachment = pb.leader_attachment.as_ref().expect("attachment inferred");
    assert_eq!(attachment.bodyguard_ref.id.as_deref(), Some("boyz"));
    assert_eq!(attachment.role, wh40kdc::import::AttachmentRole::Support);
    assert!(attachment.provisional);
    assert!(roster
        .diagnostics
        .warnings
        .iter()
        .any(|w| w.code == wh40kdc::import::WarningCode::LeaderAttachmentInferred));
}

#[cfg(feature = "export")]
#[test]
fn support_attachment_renders_supported_by_in_atc() {
    // An imported support character (bodyguard-first, no leader) renders as
    // "<bodyguard> supported by <support>". Cross-impl pin for the ATC wording.
    use wh40kdc::export::{export_roster, ExportFormat};
    let roster = import_roster(&support_attachment_payload(), Dataset::embedded()).unwrap();
    let out = export_roster(&roster, ExportFormat::Atc2026Compact);
    assert!(
        out.contains("+ LEADER/SUPPORT: Boyz supported by Painboy"),
        "ATC LEADER/SUPPORT line wrong:\n{out}"
    );
}

#[test]
fn does_not_auto_attach_a_solo_capable_leader() {
    // Grand Master's dump-sourced attachment_role is "leader" (solo-capable), so
    // the importer leaves it unattached even with an eligible bodyguard present.
    let payload = serde_json::json!({
        "name": "Leader Test",
        "generatedBy": "List Forge",
        "roster": {
            "name": "Leader Test",
            "costs": [{ "name": "pts", "value": 0 }],
            "forces": [{
                "id": "f1",
                "name": "Army Roster",
                "selections": [
                    {
                        "id": "u-gm", "name": "Grand Master", "type": "model", "number": 1,
                        "categories": [{ "name": "Faction: Grey Knights" }, { "name": "Character", "primary": true }]
                    },
                    {
                        "id": "u-paladins", "name": "Paladin Squad", "type": "unit", "number": 1,
                        "categories": [{ "name": "Faction: Grey Knights" }, { "name": "Infantry", "primary": true }]
                    }
                ]
            }]
        }
    });
    let roster = import_roster(&payload, Dataset::embedded()).unwrap();
    let gm = unit_by_id(&roster, "grand-master").unwrap();
    assert!(gm.leader_attachment.is_none());
    assert!(!roster
        .diagnostics
        .warnings
        .iter()
        .any(|w| w.code == wh40kdc::import::WarningCode::LeaderAttachmentInferred));
}

#[test]
fn attached_leader_for_looks_up_by_body_unit() {
    let roster = import_roster(&support_attachment_payload(), Dataset::embedded()).unwrap();

    // The body unit resolves to the leader attached to it.
    let leader = roster
        .attached_leader_for("boyz")
        .expect("leader attached to the body unit");
    assert_eq!(leader.ref_.id.as_deref(), Some("painboy"));

    // The leader itself has nothing attached to it, and unknown ids miss.
    assert!(roster.attached_leader_for("painboy").is_none());
    assert!(roster.attached_leader_for("no-such-unit").is_none());
}

#[test]
fn attachment_partners_for_resolves_from_either_end() {
    let roster = import_roster(&support_attachment_payload(), Dataset::embedded()).unwrap();

    // From the bodyguard's end → the attached leader.
    let from_body: Vec<&str> = roster
        .attachment_partners_for("boyz")
        .iter()
        .filter_map(|u| u.ref_.id.as_deref())
        .collect();
    assert_eq!(from_body, vec!["painboy"]);

    // From the leader's end → the bodyguard it joined.
    let from_leader: Vec<&str> = roster
        .attachment_partners_for("painboy")
        .iter()
        .filter_map(|u| u.ref_.id.as_deref())
        .collect();
    assert_eq!(from_leader, vec!["boyz"]);

    // A unit in no attachment yields nothing.
    assert!(roster.attachment_partners_for("no-such-unit").is_empty());
}

#[test]
fn primary_detachment_is_the_first_in_source_order() {
    let roster = import("gk-banishers.payload.json");

    // The accessor names what the wire format keeps as a list.
    let primary = roster
        .primary_detachment()
        .expect("the banishers list carries one detachment");
    assert_eq!(primary.ref_.id.as_deref(), Some("banishers"));
    assert_eq!(
        primary.ref_.id.as_deref(),
        roster.detachments[0].ref_.id.as_deref()
    );

    // The id shortcut matches.
    assert_eq!(roster.primary_detachment_id(), Some("banishers"));
}

#[test]
fn primary_detachment_is_none_when_no_detachment() {
    let payload = serde_json::json!({
        "name": "No Detachment",
        "generatedBy": "List Forge",
        "roster": {
            "name": "No Detachment",
            "costs": [{ "name": "pts", "value": 0 }],
            "forces": [{
                "id": "f1",
                "name": "Army Roster",
                "selections": [{
                    "id": "u-paladins", "name": "Paladin Squad", "type": "unit", "number": 1,
                    "categories": [{ "name": "Faction: Grey Knights" }, { "name": "Infantry", "primary": true }]
                }]
            }]
        }
    });
    let roster = import_roster(&payload, Dataset::embedded()).unwrap();
    assert!(roster.detachments.is_empty());
    assert!(roster.primary_detachment().is_none());
    assert_eq!(roster.primary_detachment_id(), None);
}

#[test]
fn retains_unresolved_unit_with_candidates_and_warning() {
    let payload = serde_json::json!({
        "name": "Miss Test",
        "generatedBy": "List Forge",
        "roster": {
            "name": "Miss Test",
            "costs": [{ "name": "pts", "value": 0 }],
            "forces": [{
                "id": "f1", "name": "Army Roster",
                "selections": [{
                    "id": "u-bogus", "name": "Definitely Not A Real Unit", "type": "model", "number": 1,
                    "categories": [{ "name": "Faction: Grey Knights" }, { "name": "Character" }]
                }]
            }]
        }
    });
    let roster = import_roster(&payload, Dataset::embedded()).unwrap();
    let miss = roster
        .units
        .iter()
        .find(|u| u.ref_.raw_name == "Definitely Not A Real Unit")
        .unwrap();
    assert!(miss.ref_.id.is_none());
    assert!(!miss.ref_.resolved);
    assert_eq!(roster.diagnostics.unresolved_units, 1);
    assert!(roster
        .diagnostics
        .warnings
        .iter()
        .any(|w| w.code == wh40kdc::import::WarningCode::UnitUnresolved));
}

#[test]
fn resolves_primary_faction_without_warning_for_valid_multi_force_list() {
    let roster = import("gk-allied-multiforce.payload.json");
    assert_eq!(roster.faction_id.as_deref(), Some("grey-knights"));
    assert!(!roster
        .diagnostics
        .warnings
        .iter()
        .any(|w| w.code == wh40kdc::import::WarningCode::MultiForce));
    assert_eq!(roster.units.len(), 2);
}

// --- schema conformance -----------------------------------------------------

/// Resolves the project's schema `$id` URLs to their on-disk files.
///
/// The schemas are authored so `$ref`s resolve against each file's `$id` URL
/// (`https://40kdc.dev/schemas/...`), not its filesystem path — and the shared
/// defs live in a `$defs/` directory exposed at the URL path `defs/`. This
/// retriever maps a `…/schemas/<path>` URI back to `schemas/<path>`, restoring
/// the `$` on the defs directory. Mirrors the resolution `bundle-schemas.ts`
/// performs for the AJV/codegen bundle.
struct RepoSchemaRetriever {
    schemas_root: PathBuf,
}

impl jsonschema::Retrieve for RepoSchemaRetriever {
    fn retrieve(
        &self,
        uri: &jsonschema::Uri<String>,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        let path = uri.path().as_str();
        let rel = path
            .rsplit_once("/schemas/")
            .map(|(_, r)| r)
            .unwrap_or(path)
            .trim_start_matches('/');
        // URL path `defs/...` ↔ on-disk `$defs/...`.
        let disk_rel = rel
            .strip_prefix("defs/")
            .map_or_else(|| rel.to_string(), |rest| format!("$defs/{rest}"));
        let full = self.schemas_root.join(disk_rel);
        let raw = std::fs::read_to_string(&full)
            .map_err(|e| format!("retrieve {uri}: reading {}: {e}", full.display()))?;
        Ok(serde_json::from_str(&raw)?)
    }
}

#[test]
fn resolved_roster_validates_against_roster_schema() {
    let schemas_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../schemas");
    let schema: Value = serde_json::from_str(
        &std::fs::read_to_string(schemas_root.join("core/roster.schema.json"))
            .expect("read schema"),
    )
    .expect("schema is valid JSON");

    // Real validation: the file-backed retriever resolves the external $defs
    // refs (entity-id, battle-size, game-version-ref), so this is the Rust
    // analogue of the TS AJV conformance check.
    let validator = jsonschema::options()
        .with_retriever(RepoSchemaRetriever { schemas_root })
        .build(&schema)
        .expect("roster schema compiles with external refs resolved");

    let roster = import("gk-banishers.payload.json");
    let value = serde_json::to_value(&roster).unwrap();

    if let Err(error) = validator.validate(&value) {
        panic!("resolved roster does not satisfy roster.schema.json: {error}");
    }
}

// --- WTC header disposition + wargear-item fallback --------------------------
// Mirror of the TS `wtc resolution end-to-end` block in
// tools/test/import/newrecruit-wtc.test.ts.

const SORORITAS_WTC: &str = "+++++++++++++++++++++++++++++++++++++++++++++++\n\
+ FACTION KEYWORD: Imperium - Adepta Sororitas\n\
+ DETACHMENT: Champions of Faith (Righteous Purpose)\n\
+ FORCE DISPOSITION: Disruption\n\
+ TOTAL ARMY POINTS: 150pts\n\
+\n\
+ WARLORD: Char1: Palatine\n\
+ NUMBER OF UNITS: 2\n\
+++++++++++++++++++++++++++++++++++++++++++++++\n\
\n\
Char1: 1x Palatine (50 pts): Palatine blade, Plasma pistol, Warlord\n\
\n\
10x Battle Sisters Squad (100 pts)\n\
\u{2022} 9x Battle Sister\n\
    7 with Bolt pistol, Boltgun, Close combat weapon\n\
    1 with Simulacrum Imperialis, Bolt pistol, Boltgun, Close combat weapon\n\
    1 with Bolt pistol, Close combat weapon, Multi-melta\n\
\u{2022} 1x Sister Superior: Bolt pistol, Close combat weapon, Power weapon, Boltgun\n";

#[test]
fn wtc_force_disposition_resolves_to_an_id() {
    let roster = wh40kdc::import::import_roster_text(SORORITAS_WTC, Dataset::embedded()).unwrap();
    assert_eq!(roster.force_disposition.as_deref(), Some("disruption"));
}

#[test]
fn wtc_unknown_disposition_warns_and_stays_null() {
    let bad = SORORITAS_WTC.replace("Disruption", "Total Mayhem");
    let roster = wh40kdc::import::import_roster_text(&bad, Dataset::embedded()).unwrap();
    assert_eq!(roster.force_disposition, None);
    assert!(roster
        .diagnostics
        .warnings
        .iter()
        .any(|w| format!("{:?}", w.code).contains("DispositionUnresolved")));
}

#[test]
fn wargear_item_resolves_via_the_wargear_fallback() {
    let roster = wh40kdc::import::import_roster_text(SORORITAS_WTC, Dataset::embedded()).unwrap();
    let squad = unit_by_id(&roster, "battle-sisters-squad").unwrap();
    let simulacrum = squad
        .wargear
        .iter()
        .find(|w| w.ref_.raw_name == "Simulacrum Imperialis")
        .unwrap();
    assert_eq!(simulacrum.ref_.id.as_deref(), Some("simulacrum-imperialis"));
    assert_eq!(roster.diagnostics.unresolved_weapons, 0);
}

#[test]
fn wtc_full_body_keeps_single_line_characters() {
    // Real WTC-full exports mix compact-style lines into the full layout:
    // single-model characters arrive as one `CharN: 1x Unit (pts): wargear`
    // line, and model-type bullets may inline their loadout after a colon.
    let roster = wh40kdc::import::import_roster_text(SORORITAS_WTC, Dataset::embedded()).unwrap();
    assert_eq!(roster.units.len(), 2);
    let palatine = unit_by_id(&roster, "palatine").expect("Palatine kept");
    assert!(palatine.is_warlord);
    let squad = unit_by_id(&roster, "battle-sisters-squad").unwrap();
    assert!(squad
        .wargear
        .iter()
        .any(|w| w.ref_.raw_name == "Power weapon"));
}
