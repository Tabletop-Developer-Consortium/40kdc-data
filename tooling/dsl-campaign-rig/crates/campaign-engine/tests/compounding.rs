use campaign_domain::{AbilityId, ExecutionLane, FactionId, Hash256, MechanicClusterId};
use campaign_engine::{
    BenchmarkKey, CompoundingCaseResult, CompoundingStratum, evaluate_compounding_benchmark,
};

fn result(index: usize, stratum: CompoundingStratum) -> CompoundingCaseResult {
    CompoundingCaseResult {
        key: BenchmarkKey {
            faction_id: FactionId::new("sample-faction").unwrap(),
            ability_id: AbilityId::new(format!("ability-{index}")).unwrap(),
        },
        stratum,
        lane: match stratum {
            CompoundingStratum::Straightforward => ExecutionLane::Fast,
            CompoundingStratum::Ambiguous => ExecutionLane::Review,
            CompoundingStratum::SchemaResistant => ExecutionLane::Full,
        },
        applied: true,
        mechanically_verified: true,
        shape_scouted: stratum == CompoundingStratum::SchemaResistant,
        reused_cluster: Some(MechanicClusterId::new("mc-0123456789abcdefabcd").unwrap()),
        reused_template_hash: Some(Hash256::digest("template")),
        canonical_levers_preserved: true,
        clauses_complete: true,
        non_worklist_render_drift: false,
        evidence_identity_exact: true,
        assignment_stable: true,
        token_activity: 1,
        quota_consumed: None,
    }
}

#[test]
fn representative_compounding_gate_requires_eighty_percent_fast_success() {
    let mut results = (0..20)
        .map(|index| result(index, CompoundingStratum::Straightforward))
        .collect::<Vec<_>>();
    results.extend((20..25).map(|index| result(index, CompoundingStratum::Ambiguous)));
    results.extend((25..27).map(|index| result(index, CompoundingStratum::SchemaResistant)));
    let report = evaluate_compounding_benchmark(&results).unwrap();
    assert!(report.passed);
    assert_eq!(report.straightforward_success_ratio, 1.0);

    for failed in results.iter_mut().take(5) {
        failed.mechanically_verified = false;
    }
    let report = evaluate_compounding_benchmark(&results).unwrap();
    assert!(!report.passed);
    assert!(
        report
            .failure_codes
            .contains("straightforward-success-below-80-percent")
    );
}

#[test]
fn review_lane_and_duplicate_rows_cannot_satisfy_the_fast_gate() {
    let mut results = (0..20)
        .map(|index| result(index, CompoundingStratum::Straightforward))
        .collect::<Vec<_>>();
    results.extend((20..25).map(|index| result(index, CompoundingStratum::Ambiguous)));
    results.extend((25..27).map(|index| result(index, CompoundingStratum::SchemaResistant)));
    for row in results.iter_mut().take(20) {
        row.lane = ExecutionLane::Review;
    }
    let report = evaluate_compounding_benchmark(&results).unwrap();
    assert!(!report.passed);
    assert_eq!(report.straightforward_verified_without_shape, 0);

    results.push(results[0].clone());
    assert!(evaluate_compounding_benchmark(&results).is_err());
}
