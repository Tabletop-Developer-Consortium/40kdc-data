//! Integration tests for the linked data API over the real embedded bundle.
//!
//! Rust mirror of `tools/test/data-model.test.ts`. Runs against
//! `Dataset::embedded()` so the assertions exercise the same real data the npm
//! package ships, proving the two implementations agree on the join graph.

#![cfg(feature = "bundled-data")]

use wh40kdc::{normalize_name, Dataset, Phase, RawData};

// --- normalize_name ---------------------------------------------------------

#[test]
fn normalize_strips_diacritics() {
    assert_eq!(normalize_name("Khârn the Betrayer"), "kharn the betrayer");
    assert_eq!(normalize_name("Brôkhyr"), "brokhyr");
    assert_eq!(normalize_name("Ûthar"), "uthar");
}

#[test]
fn normalize_removes_quote_variants() {
    assert_eq!(normalize_name("Be’lakor"), "belakor");
    assert_eq!(normalize_name("Kor’sarro Khan"), "korsarro khan");
    assert_eq!(normalize_name("Aetaos'rau'keres"), "aetaosraukeres");
}

#[test]
fn normalize_collapses_whitespace_and_hyphens() {
    assert_eq!(normalize_name("Brôkhyr Iron-master"), "brokhyr iron master");
    assert_eq!(normalize_name("  the   betrayer  "), "the betrayer");
}

#[test]
fn normalize_is_idempotent() {
    assert_eq!(
        normalize_name(&normalize_name("Khârn the Betrayer")),
        "kharn the betrayer"
    );
}

// --- find / find_all --------------------------------------------------------

#[test]
fn find_matches_by_exact_id() {
    let ds = Dataset::embedded();
    assert_eq!(
        ds.find_unit("kharn-the-betrayer").unwrap().id.as_str(),
        "kharn-the-betrayer"
    );
}

#[test]
fn find_matches_by_exact_normalized_name() {
    let ds = Dataset::embedded();
    assert_eq!(
        ds.find_unit("Khârn the Betrayer").unwrap().id.as_str(),
        "kharn-the-betrayer"
    );
}

#[test]
fn find_falls_back_to_substring() {
    let ds = Dataset::embedded();
    assert_eq!(
        ds.find_unit("Betrayer").unwrap().id.as_str(),
        "kharn-the-betrayer"
    );
}

#[test]
fn find_returns_none_on_miss() {
    let ds = Dataset::embedded();
    assert!(ds.find_unit("definitely-not-a-real-unit").is_none());
    assert!(ds.find_unit("").is_none());
}

#[test]
fn find_all_surfaces_every_match_for_a_shared_name() {
    let ds = Dataset::embedded();
    // ministorum-priest is shared across multiple factions; dedupe on
    // (faction_id, id) keeps each faction's copy.
    let all = ds.units.find_all("Ministorum Priest");
    assert!(
        all.len() >= 2,
        "expected the shared priest under several factions, got {}",
        all.len()
    );
    let factions: std::collections::HashSet<&str> =
        all.iter().map(|u| u.faction_id.as_str()).collect();
    assert!(
        factions.len() >= 2,
        "shared unit should span multiple factions"
    );
}

#[test]
fn by_faction_disambiguates_a_shared_unit() {
    let ds = Dataset::embedded();
    // Every faction the priest is listed under should surface it via by_faction.
    let priest_factions: Vec<&str> = ds
        .units
        .find_all("Ministorum Priest")
        .iter()
        .map(|u| u.faction_id.as_str())
        .collect();
    for f in priest_factions {
        assert!(
            ds.units
                .by_faction(f)
                .iter()
                .any(|u| u.id.as_str() == "ministorum-priest"),
            "by_faction({f}) should contain the priest"
        );
    }
}

// --- unscoped-lookup guard ---------------------------------------------------

#[test]
#[should_panic(expected = "Ambiguous unit lookup")]
fn get_panics_for_a_shared_unit_id_without_a_faction() {
    // The tripwire that turns a silent wrong-faction lookup into a loud error:
    // chaos-land-raider exists under several Chaos factions, so a faction-less
    // get() would return the first-registered copy (wrong divergent fields).
    // Debug builds (all test runs) panic; use get_in_faction or get_any.
    let ds = Dataset::embedded();
    let _ = ds.units.get("chaos-land-raider");
}

#[test]
fn get_any_is_the_explicit_first_wins_opt_out() {
    let ds = Dataset::embedded();
    let unit = ds
        .units
        .get_any("chaos-land-raider")
        .expect("get_any resolves the shared id first-wins");
    assert_eq!(unit.id.as_str(), "chaos-land-raider");
}

#[test]
fn get_still_works_for_unambiguous_ids_on_a_guarded_collection() {
    let ds = Dataset::embedded();
    assert!(ds.units.get("kharn-the-betrayer").is_some());
}

#[test]
#[should_panic(expected = "Ambiguous detachment lookup")]
fn get_panics_for_a_shared_detachment_id_without_a_faction() {
    let ds = Dataset::embedded();
    // Codex SM detachments are replicated into every chapter view.
    let shared = ds
        .detachments
        .all()
        .iter()
        .map(|d| d.id.as_str())
        .find(|id| {
            ds.detachments
                .all()
                .iter()
                .filter(|d| d.id.as_str() == *id)
                .count()
                > 1
        })
        .expect("at least one chapter-replicated detachment id exists");
    let _ = ds.detachments.get(shared);
}

#[test]
#[should_panic(expected = "Ambiguous weapon lookup")]
fn get_panics_for_a_shared_weapon_id_without_a_faction() {
    // lascannon exists under many factions with divergent stats; a
    // faction-less get() would silently crunch the wrong faction's profile.
    let ds = Dataset::embedded();
    let _ = ds.weapons.get("lascannon");
}

#[test]
#[should_panic(expected = "Ambiguous ability lookup")]
fn get_panics_for_a_shared_ability_id_without_a_faction() {
    let ds = Dataset::embedded();
    let _ = ds.abilities.get("idol-of-blessed-blood");
}

// --- internationalization ---------------------------------------------------

#[test]
fn diacritic_and_punctuation_insensitive_lookup() {
    let ds = Dataset::embedded();
    // (ascii query, exact query, expected id)
    let cases = [
        (
            "Kharn the Betrayer",
            "Khârn the Betrayer",
            "kharn-the-betrayer",
        ),
        ("Belakor", "Be’lakor", "belakor"),
        ("Korsarro Khan", "Kor’sarro Khan", "korsarro-khan"),
    ];
    for (ascii, exact, id) in cases {
        assert_eq!(
            ds.find_unit(ascii).map(|u| u.id.as_str()),
            Some(id),
            "ascii {ascii:?}"
        );
        assert_eq!(
            ds.find_unit(exact).map(|u| u.id.as_str()),
            Some(id),
            "exact {exact:?}"
        );
    }
}

#[test]
fn lookup_is_case_insensitive() {
    let ds = Dataset::embedded();
    assert_eq!(
        ds.find_unit("KHÂRN THE BETRAYER").map(|u| u.id.as_str()),
        Some("kharn-the-betrayer")
    );
}

#[test]
fn does_not_over_collapse_distinct_names() {
    assert_ne!(normalize_name("Khârn"), normalize_name("Khorne"));
    let ds = Dataset::embedded();
    let ids: Vec<&str> = ds
        .units
        .find_all("Khârn the Betrayer")
        .iter()
        .map(|u| u.id.as_str())
        .collect();
    assert_eq!(ids, ["kharn-the-betrayer"]);
}

// --- Kharn proof (the headline one-liner) -----------------------------------

#[test]
fn kharn_links_faction_weapons_abilities() {
    let ds = Dataset::embedded();
    let kharn = ds
        .find_unit("Kharn")
        .expect("Khârn resolves through diacritic folding");
    assert_eq!(ds.faction_of(kharn).unwrap().id.as_str(), "world-eaters");
    assert_eq!(ds.weapons_of(kharn).len(), 2);

    let mut ability_ids: Vec<&str> = ds
        .abilities_of(kharn)
        .iter()
        .map(|a| a.ability_id.as_str())
        .collect();
    ability_ids.sort_unstable();
    assert_eq!(
        ability_ids,
        [
            "berzerker-frenzy",
            "leader",
            "legendary-killer",
            "the-betrayer"
        ]
    );
}

#[test]
fn kharn_filters_abilities_by_phase() {
    let ds = Dataset::embedded();
    let kharn = ds.find_unit("Kharn").unwrap();
    let shooting: Vec<&str> = ds
        .abilities_of(kharn)
        .into_iter()
        .filter(|a| ds.phases_of(a).contains(&Phase::Shooting))
        .map(|a| a.ability_id.as_str())
        .collect();
    assert_eq!(shooting, ["berzerker-frenzy"]);
}

// --- phases (joined via phase-mappings) -------------------------------------

#[test]
fn phases_union_across_a_mapping() {
    let ds = Dataset::embedded();
    let ability = ds
        .abilities
        .get_any("deadly-demise-d3")
        .expect("deadly-demise-d3 exists");
    let mut phases: Vec<Phase> = ds.phases_of(ability).to_vec();
    phases.sort_unstable();
    assert_eq!(phases, [Phase::Shooting, Phase::Fight]);
}

#[test]
fn phases_empty_for_ability_without_a_mapping() {
    let ds = Dataset::embedded();
    let leader = ds
        .abilities
        .get_any("leader")
        .expect("the core `leader` ability exists");
    assert!(ds.phases_of(leader).is_empty());
}

// --- reverse links ----------------------------------------------------------

#[test]
fn ability_reverse_links_to_units() {
    let ds = Dataset::embedded();
    let units = ds.units_with_ability("berzerker-frenzy");
    assert!(units.iter().any(|u| u.id.as_str() == "kharn-the-betrayer"));
}

#[test]
fn weapon_reverse_links_to_carriers() {
    let ds = Dataset::embedded();
    let units = ds.units_with_weapon("gorechild");
    assert!(units.iter().any(|u| u.id.as_str() == "kharn-the-betrayer"));
}

#[test]
fn faction_links_units_and_weapons() {
    let ds = Dataset::embedded();
    assert!(!ds.units.by_faction("world-eaters").is_empty());
    assert!(!ds.weapons_of_faction("world-eaters").is_empty());
    assert!(!ds.abilities_of_faction("world-eaters").is_empty());
}

#[test]
fn leaders_attachable_to_lists_eligible_leaders_sorted() {
    let ds = Dataset::embedded();
    let leaders = ds.leaders_attachable_to("battle-sisters-squad");
    assert!(leaders.iter().any(|u| u.id.as_str() == "palatine"));
    let names: Vec<&str> = leaders.iter().map(|u| u.name.as_str()).collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted);
}

#[test]
fn leaders_attachable_to_is_empty_for_a_leader_unit() {
    let ds = Dataset::embedded();
    assert!(ds.leaders_attachable_to("palatine").is_empty());
}

#[test]
fn leaders_attachable_to_is_empty_for_unknown_id() {
    let ds = Dataset::embedded();
    assert!(ds.leaders_attachable_to("no-such-unit").is_empty());
}

#[test]
fn bodyguards_attachable_from_lists_body_units_sorted() {
    let ds = Dataset::embedded();
    let bodies = ds.bodyguards_attachable_from("palatine");
    assert!(bodies
        .iter()
        .any(|u| u.id.as_str() == "battle-sisters-squad"));
    let names: Vec<&str> = bodies.iter().map(|u| u.name.as_str()).collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted);
}

#[test]
fn bodyguards_attachable_from_is_the_inverse_of_leaders_attachable_to() {
    let ds = Dataset::embedded();
    assert!(ds
        .bodyguards_attachable_from("palatine")
        .iter()
        .any(|u| u.id.as_str() == "battle-sisters-squad"));
    assert!(ds
        .leaders_attachable_to("battle-sisters-squad")
        .iter()
        .any(|u| u.id.as_str() == "palatine"));
}

#[test]
fn bodyguards_attachable_from_is_empty_for_non_leader_and_unknown() {
    let ds = Dataset::embedded();
    assert!(ds
        .bodyguards_attachable_from("battle-sisters-squad")
        .is_empty());
    assert!(ds.bodyguards_attachable_from("no-such-unit").is_empty());
}

// --- edge cases -------------------------------------------------------------

#[test]
fn sm_successor_faction_resolves_without_panicking() {
    let ds = Dataset::embedded();
    let ultra = ds.factions.get("ultramarines");
    assert!(ultra.is_some(), "ultramarines is a known faction");
    // Successors may inherit units from adeptus-astartes; an empty list is fine,
    // the point is it must not panic.
    let _ = ds.units.by_faction("ultramarines");
}

#[test]
fn skips_dangling_link_ids_rather_than_panicking() {
    // Build a custom dataset with a unit whose links don't resolve.
    let raw: RawData = serde_json::from_value(serde_json::json!({
        "units": [{
            "id": "ghost",
            "name": "Ghost",
            "faction_id": "nowhere",
            "profiles": [{ "M": 6, "T": 4, "Sv": 3, "W": 1, "Ld": 6, "OC": 1 }],
            "weapon_ids": ["missing-weapon"],
            "ability_ids": ["missing-ability"],
            "game_version": { "edition": "11th", "dataslate": "2024-q1" }
        }]
    }))
    .expect("ghost RawData deserializes");

    let ds = Dataset::from_raw(raw);
    let ghost = ds.units.get_any("ghost").expect("ghost is present");
    assert!(ds.weapons_of(ghost).is_empty());
    assert!(ds.abilities_of(ghost).is_empty());
    assert!(ds.faction_of(ghost).is_none());
}

// --- collection integrity ---------------------------------------------------

#[test]
fn exposes_the_embedded_data() {
    let ds = Dataset::embedded();
    assert!(ds.units.len() > 900, "units = {}", ds.units.len());
    assert_eq!(ds.factions.len(), 35);
    assert!(!ds.weapons.is_empty());
    assert!(!ds.abilities.is_empty());
}

#[test]
fn deduplicates_abilities_by_faction_and_id() {
    // A shared ability_id keeps one copy per faction (the copies legitimately
    // diverge); only true within-faction duplicates collapse. Mirror of the TS
    // data-model test.
    let ds = Dataset::embedded();
    let keys: std::collections::HashSet<String> = ds
        .abilities
        .all()
        .iter()
        .map(|a| {
            format!(
                "{}::{}",
                a.faction_id.as_ref().map(|e| e.as_str()).unwrap_or(""),
                a.ability_id.as_str()
            )
        })
        .collect();
    assert_eq!(
        keys.len(),
        ds.abilities.len(),
        "no duplicate (faction_id, ability_id) pairs in .all()"
    );
    let idols = ds
        .abilities
        .all()
        .iter()
        .filter(|a| a.ability_id.as_str() == "idol-of-blessed-blood")
        .count();
    assert_eq!(
        idols, 2,
        "both factions' idol-of-blessed-blood copies survive dedupe"
    );
}

#[test]
fn resolves_a_shared_ability_id_to_the_units_own_factions_copy() {
    // `idol-of-blessed-blood` is authored in both world-eaters and
    // chaos-space-marines (shared Khorne Lord of Skulls datasheet); each
    // faction's unit must see its own faction's copy. Mirror of the TS test.
    let ds = Dataset::embedded();
    for faction in ["world-eaters", "chaos-space-marines"] {
        let unit = ds
            .units
            .get_in_faction("khorne-lord-of-skulls", faction)
            .expect("khorne-lord-of-skulls exists in both factions");
        let idol = ds
            .abilities_of(unit)
            .into_iter()
            .find(|a| a.ability_id.as_str() == "idol-of-blessed-blood")
            .unwrap_or_else(|| panic!("idol-of-blessed-blood on {faction} lord of skulls"));
        assert_eq!(idol.faction_id.as_ref().map(|e| e.as_str()), Some(faction));
    }
}

#[test]
fn folds_shared_core_abilities_into_the_collection() {
    let ds = Dataset::embedded();
    assert!(ds.abilities.get_any("benefit-of-cover").is_some());
}

#[test]
fn collection_is_iterable() {
    let ds = Dataset::embedded();
    assert_eq!(ds.factions.iter().count(), ds.factions.len());
    assert_eq!((&ds.factions).into_iter().count(), ds.factions.len());
}

// --- terrain ----------------------------------------------------------------

#[test]
fn terrain_catalog_and_layouts_are_embedded() {
    let ds = Dataset::embedded();
    // 13 canonical/KOTC templates plus Battlemaster's 12 feature and 44 composed
    // area variants. Composed areas retain their source scenery as child features.
    assert_eq!(ds.terrain_templates.len(), 69);
    assert_eq!(
        ds.terrain_templates
            .get("bm-bm-terrain-11e-1-composite-01-m0-p0")
            .unwrap()
            .features
            .len(),
        2
    );
    assert!(ds.terrain_templates.get("area-large").is_some());
    for ruin in ["kotc-ruin-inner", "kotc-ruin-deployment"] {
        assert_eq!(
            ds.terrain_templates
                .get(ruin)
                .unwrap()
                .terrain_category
                .as_ref()
                .map(|c| c.to_string())
                .as_deref(),
            Some("dense")
        );
    }
    assert!(ds
        .terrain_templates
        .get("corner-ruin-balanced-left")
        .unwrap()
        .upper_floor
        .is_some());
    assert!(
        !ds.terrain_templates
            .get("gantry")
            .unwrap()
            .ground_accessible
    );
    // The colosseum's impassable arena walls: solid, no ground placement.
    assert!(
        !ds.terrain_templates
            .get("impassable-wall")
            .unwrap()
            .ground_accessible
    );
    assert!(ds.terrain_templates.get("wall-medium").is_none());
    assert!(ds.terrain_templates.get("scaffold").is_none());
    assert!(ds.terrain_layouts.get("take-and-hold-mirror-1").is_some());
    // The KOTC colosseum is a first-class dataset layout on a 36×36 board.
    let colosseum = ds
        .terrain_layouts
        .get("kotc-colosseum")
        .expect("kotc-colosseum layout embedded");
    let board = colosseum.board.as_ref().expect("colosseum carries a board");
    assert_eq!((board.width, board.height), (36.0, 36.0));
    // removed: non-grid layouts (reference migrations + standalone) with no mission_matchup_id
    assert!(ds.terrain_layouts.get("gw-11e-crucible").is_none());
    assert!(ds.terrain_layouts.get("gw-11e-hammer-anvil").is_none());
    assert!(ds.terrain_layouts.get("sweeping-engagement-1").is_none());
}

#[test]
fn resolve_terrain_produces_board_vertices() {
    let ds = Dataset::embedded();
    let layout = ds
        .terrain_layouts
        .get("take-and-hold-mirror-1")
        .expect("take-and-hold-mirror-1 layout");
    let resolved = ds
        .resolve_terrain(layout)
        .expect("resolves against embedded catalog");
    assert!(!resolved.is_empty());
    // Every resolved piece is a polygon (>= 3 vertices) inside the 60x44 board.
    for p in &resolved {
        assert!(
            p.vertices.len() >= 3,
            "piece {:?} has too few vertices",
            p.id
        );
        for v in &p.vertices {
            assert!(
                v.x >= -1.0 && v.x <= 61.0 && v.y >= -1.0 && v.y <= 45.0,
                "vertex off-board: {v:?}"
            );
        }
    }
}

// --- target profiles --------------------------------------------------------

#[test]
fn target_profiles_reference_real_units() {
    let ds = Dataset::embedded();
    assert!(
        !ds.target_profiles.all().is_empty(),
        "target profiles should be bundled"
    );
    // Every profile must resolve to a unit that exists in its declared faction
    // (faction-scoped — shared ids like rhino appear under several factions).
    for p in ds.target_profiles.all() {
        let resolved = ds
            .units
            .by_faction(p.faction_id.as_str())
            .into_iter()
            .find(|u| u.id.as_str() == p.unit_id.as_str());
        assert!(
            resolved.is_some(),
            "target profile {} references missing unit {} in faction {}",
            p.id.as_str(),
            p.unit_id.as_str(),
            p.faction_id.as_str()
        );
    }
}

#[test]
fn teq_profile_resolves_to_terminator_stats() {
    let ds = Dataset::embedded();
    let p = ds
        .target_profiles
        .get("teq-terminators")
        .expect("teq-terminators profile present");
    let unit = ds
        .units
        .by_faction(p.faction_id.as_str())
        .into_iter()
        .find(|u| u.id.as_str() == p.unit_id.as_str())
        .expect("terminator-squad resolves in adeptus-astartes");
    let prof = &unit.profiles[0];
    assert_eq!(prof.t.get(), 5);
    assert_eq!(prof.sv, 2);
    assert_eq!(prof.invuln_sv, Some(4));
    assert_eq!(prof.w.get(), 3);
    // No override → the comparison would use the unit's minimum squad size.
    assert!(p.model_count_override.is_none());
    assert_eq!(unit.model_count.as_ref().unwrap().min.get(), 5);
}
