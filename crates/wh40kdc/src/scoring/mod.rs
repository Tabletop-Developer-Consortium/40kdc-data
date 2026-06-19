//! Card-driven secondary-mission scoring engine — pure-function VP computation.
//!
//! Rust mirror of `tools/src/scoring/` in the TS package (the reference/oracle
//! implementation); the `conformance/scoring` corpus pins both ports to
//! identical output. Any change to the public shapes or arithmetic here is a
//! semantic corpus change (bump `conformance/SPEC_VERSION`).
//!
//! Drawn secondaries are *held* in hand across rounds and **scored once**: the
//! player asserts which of a card's awards they achieved, the engine computes
//! the VP (clamped to the card's cap), records it against the current battle
//! round, and the card is discarded. A primary, by contrast, is scored once
//! *per round* against the same card, capped at the per-round and per-game
//! ceilings. There is no board-state model: an award's `when` condition is a
//! human-readable label, not something the engine evaluates — the player ticks
//! the awards they made and the engine does the arithmetic, OR-tier resolution,
//! cumulative sums, and caps.
//!
//! Every public type is plain, JSON-serializable data so a UI can persist a
//! whole match and rehydrate it, and so the conformance differ can compare
//! states structurally.

use std::collections::BTreeMap;

use crate::generated::{
    SecondaryCard, SecondaryCardAwardsItem, SecondaryCardAwardsItemVariant0Mode,
    SecondaryCardAwardsItemVariant1Mode,
};

/// The Tactical approach caps a single secondary's score at this many VP.
pub const TACTICAL_CARD_CAP: u64 = 5;
/// Battle rounds in a game.
pub const ROUNDS: usize = 5;
/// Per-player VP ceiling (WTC sheet: grand total out of 100).
pub const GAME_VP_CAP: u64 = 100;

/// The scoring approach a card is played under. Filters `mode` awards and sets
/// the per-score cap.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Copy, Debug, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ScoringMode {
    Fixed,
    Tactical,
}

/// An award the player ticks when scoring, with a count for per-instance awards.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, PartialEq)]
pub struct AssertedAward {
    pub award: SecondaryCardAwardsItem,
    /// Instances achieved (for `vp_per` awards); defaults to 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
}

/// VP recorded against a single battle round.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct RoundCell {
    pub primary: u64,
    pub secondary: u64,
}

/// A scored secondary, kept so the record can be shown and undone.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScoreEntry {
    pub card_id: String,
    /// Battle round (1-based) the card was scored in.
    pub round: u64,
    pub vp: u64,
}

/// One player's whole-game scoring state. Plain data — safe to JSON round-trip.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerGame {
    /// Scoring approach: filters `mode` awards and sets the per-score cap.
    pub approach: ScoringMode,
    /// Drawn-but-unscored secondaries, by card id. Scoring removes a card here.
    pub hand_ids: Vec<String>,
    /// Per-round VP, index 0 = round 1. Always length [`ROUNDS`].
    pub rounds: Vec<RoundCell>,
    /// Log of scored secondaries, in scoring order — the editable record.
    pub log: Vec<ScoreEntry>,
}

/// A fresh player game for the given approach.
pub fn empty_player_game(approach: ScoringMode) -> PlayerGame {
    PlayerGame {
        approach,
        hand_ids: Vec::new(),
        rounds: vec![RoundCell::default(); ROUNDS],
        log: Vec::new(),
    }
}

// ── award accessors over the generated two-variant enum ─────────────────────

/// A card's `awards`, as a slice (the generated `SecondaryCard` carries them
/// directly).
pub fn awards_of(card: &SecondaryCard) -> &[SecondaryCardAwardsItem] {
    &card.awards
}

fn award_mode(a: &SecondaryCardAwardsItem) -> Option<ScoringMode> {
    match a {
        SecondaryCardAwardsItem::Variant0 { mode, .. } => mode.as_ref().map(|m| match m {
            SecondaryCardAwardsItemVariant0Mode::Fixed => ScoringMode::Fixed,
            SecondaryCardAwardsItemVariant0Mode::Tactical => ScoringMode::Tactical,
        }),
        SecondaryCardAwardsItem::Variant1 { mode, .. } => mode.as_ref().map(|m| match m {
            SecondaryCardAwardsItemVariant1Mode::Fixed => ScoringMode::Fixed,
            SecondaryCardAwardsItemVariant1Mode::Tactical => ScoringMode::Tactical,
        }),
    }
}

fn award_exclusive_group(a: &SecondaryCardAwardsItem) -> Option<&str> {
    match a {
        SecondaryCardAwardsItem::Variant0 {
            exclusive_group, ..
        } => exclusive_group.as_deref().map(String::as_str),
        SecondaryCardAwardsItem::Variant1 {
            exclusive_group, ..
        } => exclusive_group.as_deref().map(String::as_str),
    }
}

fn award_vp_max(a: &SecondaryCardAwardsItem) -> Option<u64> {
    match a {
        SecondaryCardAwardsItem::Variant0 { vp_max, .. }
        | SecondaryCardAwardsItem::Variant1 { vp_max, .. } => vp_max.map(|n| n.get()),
    }
}

/// The awards a player scores under `approach`. An award with no `mode` is flat
/// (it scores the same either way); an award tagged `fixed`/`tactical` scores
/// only under the matching approach.
pub fn awards_for_approach(
    card: &SecondaryCard,
    approach: ScoringMode,
) -> Vec<&SecondaryCardAwardsItem> {
    awards_of(card)
        .iter()
        .filter(|a| award_mode(a).map(|m| m == approach).unwrap_or(true))
        .collect()
}

/// VP for a single asserted award. A flat `vp` ignores `count`; a `vp_per`
/// award scores `vp_per × count`, with `count` clamped to `per_max` when present.
pub fn score_award(award: &SecondaryCardAwardsItem, count: u64) -> u64 {
    match award {
        SecondaryCardAwardsItem::Variant0 { vp, .. } => *vp,
        SecondaryCardAwardsItem::Variant1 {
            vp_per, per_max, ..
        } => {
            let capped = match per_max {
                Some(pm) => count.min(pm.get()),
                None => count,
            };
            vp_per * capped
        }
    }
}

/// VP from everything asserted in one scoring, before any cap. Awards sharing an
/// `exclusive_group` resolve as "only the highest scores" (the card's literal OR
/// between tier rows); everything else, including `cumulative` "+" rows, sums.
pub fn score_turn(asserted: &[AssertedAward]) -> u64 {
    let mut group_best: BTreeMap<&str, u64> = BTreeMap::new();
    let mut total: u64 = 0;
    for aa in asserted {
        let v = score_award(&aa.award, aa.count.unwrap_or(1));
        match award_exclusive_group(&aa.award) {
            Some(g) => {
                let entry = group_best.entry(g).or_insert(0);
                if v > *entry {
                    *entry = v;
                }
            }
            None => total += v,
        }
    }
    total + group_best.values().sum::<u64>()
}

/// A card's per-score VP ceiling under `approach`, or `None` when uncapped.
/// Tactical is the universal [`TACTICAL_CARD_CAP`]. Fixed uses the largest
/// `vp_max` printed on the card's scorable awards, or `None` (uncapped) when
/// none is printed.
pub fn score_cap(card: &SecondaryCard, approach: ScoringMode) -> Option<u64> {
    if approach == ScoringMode::Tactical {
        return Some(TACTICAL_CARD_CAP);
    }
    awards_for_approach(card, ScoringMode::Fixed)
        .iter()
        .filter_map(|a| award_vp_max(a))
        .max()
}

/// The VP a single scoring of `card` grants under `approach`: the asserted
/// awards' total, clamped to the card's cap (and discarded after).
pub fn score_secondary_event(
    asserted: &[AssertedAward],
    card: &SecondaryCard,
    approach: ScoringMode,
) -> u64 {
    let turn = score_turn(asserted);
    match score_cap(card, approach) {
        Some(c) => turn.min(c),
        None => turn,
    }
}

/// The primary VP a single battle round's scoring grants: the asserted awards'
/// total, clamped to the per-round cap (`mission.vp_per_round_cap`). There is no
/// tactical 5-VP rule on primary; the per-game cap is applied by [`set_primary`].
pub fn score_primary_event(asserted: &[AssertedAward], round_cap: u64) -> u64 {
    score_turn(asserted).min(round_cap)
}

fn round_index(round: u64) -> usize {
    (round.max(1) - 1).min(ROUNDS as u64 - 1) as usize
}

/// Add secondary VP to a battle round (1-based). Pure — returns new state.
pub fn record_secondary(pg: &PlayerGame, round: u64, vp: u64) -> PlayerGame {
    let i = round_index(round);
    let mut next = pg.clone();
    next.rounds[i].secondary += vp;
    next
}

/// Score a held secondary: add its VP to the round, append it to the log, and
/// discard it from hand. Pure. The caller computes `vp` via
/// [`score_secondary_event`].
pub fn score_secondary(pg: &PlayerGame, round: u64, card_id: &str, vp: u64) -> PlayerGame {
    let mut next = record_secondary(pg, round, vp);
    next.hand_ids.retain(|id| id != card_id);
    next.log.push(ScoreEntry {
        card_id: card_id.to_string(),
        round,
        vp,
    });
    next
}

/// Undo a logged scoring by index: subtract its VP from its round, drop the log
/// entry, and return the card to hand so it can be re-scored. Pure; a no-op for
/// an out-of-range index.
pub fn remove_score(pg: &PlayerGame, index: usize) -> PlayerGame {
    let Some(entry) = pg.log.get(index) else {
        return pg.clone();
    };
    let entry = entry.clone();
    let i = round_index(entry.round);
    let mut next = pg.clone();
    next.rounds[i].secondary = next.rounds[i].secondary.saturating_sub(entry.vp);
    next.log.remove(index);
    if !next.hand_ids.contains(&entry.card_id) {
        next.hand_ids.push(entry.card_id);
    }
    next
}

/// Set primary VP for a battle round (1-based) to a clamped value. Pure.
///
/// `round_cap` bounds the round's value (`mission.vp_per_round_cap`) and
/// `game_cap` (`mission.vp_per_game_cap`) the primary game total — the latter
/// computed against the *other* rounds, so no sequence of round scores can push
/// the primary game total past it. `None` for either means uncapped.
pub fn set_primary(
    pg: &PlayerGame,
    round: u64,
    vp: u64,
    round_cap: Option<u64>,
    game_cap: Option<u64>,
) -> PlayerGame {
    let i = round_index(round);
    let others: u64 = pg
        .rounds
        .iter()
        .enumerate()
        .filter(|(idx, _)| *idx != i)
        .map(|(_, c)| c.primary)
        .sum();
    let game_room = game_cap
        .map(|g| g.saturating_sub(others))
        .unwrap_or(u64::MAX);
    let room = round_cap.unwrap_or(u64::MAX).min(game_room);
    let mut next = pg.clone();
    next.rounds[i].primary = vp.min(room);
    next
}

/// Put a drawn card in hand (no duplicates). Pure.
pub fn add_to_hand(pg: &PlayerGame, card_id: &str) -> PlayerGame {
    let mut next = pg.clone();
    if !next.hand_ids.iter().any(|id| id == card_id) {
        next.hand_ids.push(card_id.to_string());
    }
    next
}

/// Remove a card from hand (e.g. on score or discard). Pure.
pub fn remove_from_hand(pg: &PlayerGame, card_id: &str) -> PlayerGame {
    let mut next = pg.clone();
    next.hand_ids.retain(|id| id != card_id);
    next
}

/// Total primary VP across the game.
pub fn player_primary(pg: &PlayerGame) -> u64 {
    pg.rounds.iter().map(|c| c.primary).sum()
}

/// Total secondary VP across the game.
pub fn player_secondary(pg: &PlayerGame) -> u64 {
    pg.rounds.iter().map(|c| c.secondary).sum()
}

/// Grand total VP, capped at [`GAME_VP_CAP`].
pub fn player_total(pg: &PlayerGame) -> u64 {
    GAME_VP_CAP.min(player_primary(pg) + player_secondary(pg))
}

/// A WTC 20-point result for two grand totals.
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Copy, Debug, Eq, PartialEq)]
pub struct WtcResult {
    pub a: u64,
    pub b: u64,
}

/// The WTC 20-point result from two grand totals. The winner's margin maps onto
/// 11 bands (0-5 → 10-10 draw, 6-10 → 11-9, … 51+ → 20-0); the loser gets the
/// complement. `a`/`b` correspond to the argument order.
pub fn wtc_result(total_a: u64, total_b: u64) -> WtcResult {
    if total_a == total_b {
        return WtcResult { a: 10, b: 10 };
    }
    let diff = total_a.abs_diff(total_b);
    // ceil((diff - 5) / 5), capped at 10 (0 within the 0-5 draw band).
    let band = if diff <= 5 {
        0
    } else {
        (diff - 5).div_ceil(5).min(10)
    };
    let winner = 10 + band;
    let loser = 10 - band;
    if total_a > total_b {
        WtcResult {
            a: winner,
            b: loser,
        }
    } else {
        WtcResult {
            a: loser,
            b: winner,
        }
    }
}

// The engine is data-free, but its tests use real cards from the embedded
// dataset as fixtures (mirroring `tools/test/scoring.test.ts`), so they need
// the `bundled-data` feature.
#[cfg(all(test, feature = "bundled-data"))]
mod tests {
    use super::*;
    use crate::Dataset;

    fn ds() -> &'static Dataset {
        Dataset::embedded()
    }
    fn card(ds: &Dataset, id: &str) -> SecondaryCard {
        ds.mission_cards
            .get(id)
            .unwrap_or_else(|| panic!("fixture card missing: {id}"))
            .clone()
    }
    fn assert_all(
        card: &SecondaryCard,
        approach: ScoringMode,
        counts: &[u64],
    ) -> Vec<AssertedAward> {
        awards_for_approach(card, approach)
            .into_iter()
            .enumerate()
            .map(|(i, a)| AssertedAward {
                award: a.clone(),
                count: counts.get(i).copied(),
            })
            .collect()
    }

    #[test]
    fn score_award_flat_and_per() {
        let ds = ds();
        let no_prisoners = card(ds, "no-prisoners");
        let per_kill = awards_for_approach(&no_prisoners, ScoringMode::Tactical)[0].clone();
        // 2 VP per kill scales with count.
        assert_eq!(score_award(&per_kill, 3), 6);
    }

    #[test]
    fn exclusive_group_takes_highest() {
        let ds = ds();
        let engage = card(ds, "engage-on-all-fronts");
        let asserted = assert_all(&engage, ScoringMode::Tactical, &[]);
        // 3 VP (3 fronts) OR 5 VP (4 fronts) — asserting both scores 5.
        assert_eq!(score_turn(&asserted), 5);
    }

    #[test]
    fn cumulative_and_independent_sum() {
        let ds = ds();
        let assassination = card(ds, "assassination");
        let fixed = awards_for_approach(&assassination, ScoringMode::Fixed);
        let asserted = vec![
            AssertedAward {
                award: fixed[0].clone(),
                count: Some(2),
            },
            AssertedAward {
                award: fixed[1].clone(),
                count: Some(1),
            },
        ];
        // 3 VP/char (×2 = 6) + 1 VP/W4+ char (×1) = 7.
        assert_eq!(score_turn(&asserted), 7);
    }

    #[test]
    fn caps_tactical_at_five_and_fixed_at_vp_max() {
        let ds = ds();
        let burden = card(ds, "burden-of-trust");
        assert_eq!(score_cap(&burden, ScoringMode::Tactical), Some(5));
        // Burden of Trust: 2 VP per guarded objective, capped at the printed 5 VP.
        assert_eq!(score_cap(&burden, ScoringMode::Fixed), Some(5));
        let assassination = card(ds, "assassination");
        assert_eq!(score_cap(&assassination, ScoringMode::Fixed), None);

        let per_obj = awards_for_approach(&burden, ScoringMode::Fixed)[0].clone();
        let asserted = vec![AssertedAward {
            award: per_obj,
            count: Some(10),
        }];
        assert_eq!(
            score_secondary_event(&asserted, &burden, ScoringMode::Fixed),
            5
        );
    }

    #[test]
    fn primary_event_clamps_to_round_cap() {
        let ds = ds();
        let no_prisoners = card(ds, "no-prisoners");
        let per_kill = awards_for_approach(&no_prisoners, ScoringMode::Tactical)[0].clone();
        let asserted = vec![AssertedAward {
            award: per_kill,
            count: Some(8),
        }];
        assert_eq!(score_primary_event(&asserted, 15), 15);
    }

    #[test]
    fn set_primary_respects_round_and_game_caps() {
        let mut pg = empty_player_game(ScoringMode::Tactical);
        pg = set_primary(&pg, 1, 30, Some(15), None);
        assert_eq!(pg.rounds[0].primary, 15);

        let mut g = empty_player_game(ScoringMode::Tactical);
        for r in [1u64, 2, 3] {
            g = set_primary(&g, r, 15, Some(15), Some(45));
        }
        assert_eq!(player_primary(&g), 45);
        g = set_primary(&g, 4, 15, Some(15), Some(45));
        assert_eq!(g.rounds[3].primary, 0);
        assert_eq!(player_primary(&g), 45);
    }

    #[test]
    fn caps_grand_total_at_100() {
        let mut pg = empty_player_game(ScoringMode::Tactical);
        for r in 1..=ROUNDS as u64 {
            pg = set_primary(&pg, r, 30, None, None);
        }
        assert_eq!(player_primary(&pg), 150);
        assert_eq!(player_total(&pg), GAME_VP_CAP);
    }

    #[test]
    fn score_secondary_logs_and_discards_and_remove_undoes() {
        let mut pg = add_to_hand(&empty_player_game(ScoringMode::Tactical), "centre-ground");
        pg = score_secondary(&pg, 1, "centre-ground", 5);
        assert_eq!(pg.rounds[0].secondary, 5);
        assert!(pg.hand_ids.is_empty());
        assert_eq!(pg.log.len(), 1);

        pg = remove_score(&pg, 0);
        assert_eq!(pg.rounds[0].secondary, 0);
        assert!(pg.log.is_empty());
        assert_eq!(pg.hand_ids, vec!["centre-ground".to_string()]);
        // out-of-range is a no-op
        assert_eq!(remove_score(&pg, 9), pg);
    }

    #[test]
    fn wtc_bands() {
        assert_eq!(wtc_result(50, 50), WtcResult { a: 10, b: 10 });
        assert_eq!(wtc_result(48, 45), WtcResult { a: 10, b: 10 }); // diff 3
        assert_eq!(wtc_result(56, 50), WtcResult { a: 11, b: 9 }); // diff 6
        assert_eq!(wtc_result(50, 61), WtcResult { a: 8, b: 12 }); // diff 11
        assert_eq!(wtc_result(100, 50), WtcResult { a: 19, b: 1 }); // diff 50
        assert_eq!(wtc_result(100, 49), WtcResult { a: 20, b: 0 }); // diff 51
        assert_eq!(wtc_result(0, 100), WtcResult { a: 0, b: 20 });
    }

    #[test]
    fn player_game_round_trips_through_json() {
        let mut pg = empty_player_game(ScoringMode::Tactical);
        pg = set_primary(&pg, 1, 8, Some(15), Some(45));
        pg = add_to_hand(&pg, "centre-ground");
        pg = record_secondary(&pg, 1, 5);
        let json = serde_json::to_string(&pg).unwrap();
        let back: PlayerGame = serde_json::from_str(&json).unwrap();
        assert_eq!(back, pg);
    }
}
