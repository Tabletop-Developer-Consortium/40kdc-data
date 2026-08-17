/**
 * Card-driven secondary-mission scoring, 10th-edition tactical model.
 *
 * Drawn secondaries are *held* in hand across rounds and **scored once**: the
 * player asserts which of a card's awards they achieved, the engine computes the
 * VP (clamped to the card's cap), records it against the current battle round,
 * and the card is then discarded. There is no multi-turn per-card accrual — a
 * card pays out exactly once.
 *
 * Why "asserted" rather than evaluated: there is no board-state model here, so
 * an award's `when` condition is a human-readable label (see
 * `translate/scoring.ts`'s `describeScoringCard`, which this module never
 * modifies), not something the engine checks. The player ticks the awards they
 * made; the engine does the arithmetic, the OR-tier resolution, the cumulative
 * sums, and the cap.
 *
 * Deck-level rules the card schema deliberately omits live here as constants —
 * chiefly the 5 VP-per-card ceiling of the Tactical approach. The Fixed approach
 * instead uses each award's printed `vp_max`.
 *
 * `PlayerGame` is a plain JSON-serializable object so a UI can persist a whole
 * match (two of them) to localStorage and rehydrate without a revival step.
 *
 * CONFORMANCE: mirrored by the Rust `wh40kdc::scoring` module and pinned by the
 * `conformance/scoring` corpus (this is the reference/oracle implementation).
 * The public shapes below are the surface that port mirrors — changing them is
 * a cross-impl, `SPEC_VERSION`-bumping change.
 */

import type { SecondaryCard } from "../generated.js";
import type { ScoringAward, ScoringMode } from "../translate/scoring.js";

/** The Tactical approach caps a single secondary's score at this many VP. */
export const TACTICAL_CARD_CAP = 5;
/** Battle rounds in a game. */
export const ROUNDS = 5;
/** Per-player VP ceiling (WTC sheet: grand total out of 100). */
export const GAME_VP_CAP = 100;

/** An award the player ticks when scoring, with a count for per-instance awards. */
export interface AssertedAward {
  award: ScoringAward;
  /** Instances achieved (for `vp_per` awards); defaults to 1. */
  count?: number;
}

/** VP recorded against a single battle round. */
export interface RoundCell {
  primary: number;
  secondary: number;
}

/** A scored secondary, kept so the record can be shown and undone. */
export interface ScoreEntry {
  cardId: string;
  /** Battle round (1-based) the card was scored in. */
  round: number;
  vp: number;
}

/** One player's whole-game scoring state. Plain data — safe to JSON round-trip. */
export interface PlayerGame {
  /** Scoring approach: filters `mode` awards and sets the per-score cap. */
  approach: ScoringMode;
  /** Drawn-but-unscored secondaries, by card id. Scoring removes a card from here. */
  handIds: string[];
  /** Per-round VP, index 0 = round 1. Always length {@link ROUNDS}. */
  rounds: RoundCell[];
  /** Log of scored secondaries, in scoring order — the editable record. */
  log: ScoreEntry[];
}

/** A fresh player game for the given approach (defaults to tactical). */
export function emptyPlayerGame(approach: ScoringMode = "tactical"): PlayerGame {
  return {
    approach,
    handIds: [],
    rounds: Array.from({ length: ROUNDS }, () => ({ primary: 0, secondary: 0 })),
    log: [],
  };
}

/** Read a card's `awards`, typed (the generated `SecondaryCard` leaves them opaque). */
export function awardsOf(card: SecondaryCard): ScoringAward[] {
  return (card.awards ?? []) as unknown as ScoringAward[];
}

/**
 * The awards a player scores under `approach`. An award with no `mode` is flat
 * (it scores the same either way); an award tagged `fixed`/`tactical` scores
 * only under the matching approach.
 */
export function awardsForApproach(card: SecondaryCard, approach: ScoringMode): ScoringAward[] {
  return awardsOf(card).filter((a) => a.mode == null || a.mode === approach);
}

/**
 * VP for a single asserted award. A flat `vp` ignores `count`; a `vp_per` award
 * scores `vp_per × count`, with `count` clamped to `per_max` when present.
 */
export function scoreAward(award: ScoringAward, count = 1): number {
  if (award.vp != null) return award.vp;
  if (award.vp_per != null) {
    const capped = award.per_max != null ? Math.min(count, award.per_max) : count;
    return award.vp_per * Math.max(0, capped);
  }
  return 0;
}

/**
 * VP from everything asserted in one scoring, before the card cap. Awards
 * sharing an `exclusive_group` resolve as "only the highest scores" (the card's
 * literal OR between tier rows); everything else, including `cumulative` "+"
 * rows, sums.
 */
export function scoreTurn(asserted: AssertedAward[]): number {
  const groupBest = new Map<string, number>();
  let total = 0;
  for (const { award, count } of asserted) {
    const v = scoreAward(award, count ?? 1);
    if (award.exclusive_group != null) {
      const prev = groupBest.get(award.exclusive_group) ?? 0;
      if (v > prev) groupBest.set(award.exclusive_group, v);
    } else {
      total += v;
    }
  }
  for (const v of groupBest.values()) total += v;
  return total;
}

/**
 * A card's per-score VP ceiling under `approach`. Tactical is the universal
 * {@link TACTICAL_CARD_CAP}. Fixed uses the largest `vp_max` printed on the
 * card's scorable awards, or `Infinity` when none is printed (uncapped).
 */
export function scoreCap(card: SecondaryCard, approach: ScoringMode): number {
  if (approach === "tactical") return TACTICAL_CARD_CAP;
  const caps = awardsForApproach(card, "fixed")
    .map((a) => a.vp_max)
    .filter((x): x is number => x != null);
  return caps.length > 0 ? Math.max(...caps) : Infinity;
}

/**
 * The VP a single scoring of `card` grants under `approach`: the asserted awards'
 * total, clamped to the card's cap. This is the amount banked when the card is
 * scored (and then discarded).
 */
export function scoreSecondaryEvent(
  asserted: AssertedAward[],
  card: SecondaryCard,
  approach: ScoringMode,
): number {
  return Math.min(scoreTurn(asserted), scoreCap(card, approach));
}

/**
 * The primary VP a single battle round's scoring grants: the asserted awards'
 * total, clamped to the per-round cap (`mission.vp_per_round_cap`, 15 by 11e
 * default). Unlike a secondary, a primary is scored once *per round* against the
 * same card, so the ceiling is the round cap rather than a per-card cap — there
 * is no tactical 5-VP rule on primary. The per-game primary cap
 * (`vp_per_game_cap`) is applied separately by {@link setPrimary}, which sees
 * the other rounds' totals.
 */
export function scorePrimaryEvent(asserted: AssertedAward[], roundCap: number): number {
  return Math.min(scoreTurn(asserted), roundCap);
}

function roundIndex(round: number): number {
  return Math.max(0, Math.min(ROUNDS - 1, Math.trunc(round) - 1));
}

/**
 * Add secondary VP to a battle round (1-based). Pure — returns new state.
 *
 * `caps` mirrors {@link setPrimary}: `roundCap` (`mission.secondary_vp_per_round_cap`)
 * bounds the round's cumulative secondary, `gameCap`
 * (`mission.secondary_vp_per_game_cap`) the game-wide secondary total.
 */
export function recordSecondary(
  pg: PlayerGame,
  round: number,
  vp: number,
  caps: { roundCap?: number; gameCap?: number } = {},
): PlayerGame {
  const i = roundIndex(round);
  const added = Math.max(0, vp);
  const others = pg.rounds.reduce((s, c, idx) => (idx === i ? s : s + c.secondary), 0);
  const gameRoom = Math.max(0, (caps.gameCap ?? Infinity) - others);
  const roundRoom = Math.max(0, (caps.roundCap ?? Infinity) - pg.rounds[i].secondary);
  const clamped = Math.min(added, roundRoom, gameRoom);
  const rounds = pg.rounds.map((c, idx) =>
    idx === i ? { ...c, secondary: c.secondary + clamped } : c,
  );
  return { ...pg, rounds };
}

/**
 * Score a held secondary: add its VP to the round, append it to the log, and
 * discard it from hand. Pure. The caller computes `vp` via
 * {@link scoreSecondaryEvent}.
 */
export function scoreSecondary(
  pg: PlayerGame,
  round: number,
  cardId: string,
  vp: number,
  caps: { roundCap?: number; gameCap?: number } = {},
): PlayerGame {
  const banked = Math.max(0, vp);
  const recorded = recordSecondary(pg, round, banked, caps);
  const actuallyBanked = recorded.rounds[roundIndex(round)].secondary - pg.rounds[roundIndex(round)].secondary;
  return {
    ...removeFromHand(recorded, cardId),
    log: [...pg.log, { cardId, round, vp: actuallyBanked }],
  };
}

/**
 * Undo a logged scoring by index: subtract its VP from its round, drop the log
 * entry, and return the card to hand so it can be re-scored. Pure; a no-op for
 * an out-of-range index.
 */
export function removeScore(pg: PlayerGame, index: number): PlayerGame {
  const entry = pg.log[index];
  if (!entry) return pg;
  const i = roundIndex(entry.round);
  const rounds = pg.rounds.map((c, idx) =>
    idx === i ? { ...c, secondary: Math.max(0, c.secondary - entry.vp) } : c,
  );
  const log = pg.log.filter((_, idx) => idx !== index);
  const handIds = pg.handIds.includes(entry.cardId)
    ? pg.handIds
    : [...pg.handIds, entry.cardId];
  return { ...pg, rounds, log, handIds };
}

/**
 * Set primary VP for a battle round (1-based) to a clamped value. Pure.
 *
 * `caps` bounds the stored value by both the per-round ceiling (`roundCap`,
 * `mission.vp_per_round_cap`) and the remaining per-game primary room
 * (`gameCap`, `mission.vp_per_game_cap`) — the latter computed against the
 * *other* rounds' primary, so no sequence of round scores can push the primary
 * game total past `gameCap`. With no caps both default to `Infinity`, leaving
 * only the floor-at-zero clamp (the historical behavior).
 */
export function setPrimary(
  pg: PlayerGame,
  round: number,
  vp: number,
  caps: { roundCap?: number; gameCap?: number } = {},
): PlayerGame {
  const i = roundIndex(round);
  const others = pg.rounds.reduce((s, c, idx) => (idx === i ? s : s + c.primary), 0);
  const room = Math.max(0, Math.min(caps.roundCap ?? Infinity, (caps.gameCap ?? Infinity) - others));
  const clamped = Math.max(0, Math.min(vp, room));
  const rounds = pg.rounds.map((c, idx) => (idx === i ? { ...c, primary: clamped } : c));
  return { ...pg, rounds };
}

/** Put a drawn card in hand (no duplicates). Pure. */
export function addToHand(pg: PlayerGame, cardId: string): PlayerGame {
  if (pg.handIds.includes(cardId)) return pg;
  return { ...pg, handIds: [...pg.handIds, cardId] };
}

/** Remove a card from hand (e.g. on score or discard). Pure. */
export function removeFromHand(pg: PlayerGame, cardId: string): PlayerGame {
  return { ...pg, handIds: pg.handIds.filter((id) => id !== cardId) };
}

/** Total primary VP across the game. */
export function playerPrimary(pg: PlayerGame): number {
  return pg.rounds.reduce((sum, c) => sum + c.primary, 0);
}

/** Total secondary VP across the game. */
export function playerSecondary(pg: PlayerGame): number {
  return pg.rounds.reduce((sum, c) => sum + c.secondary, 0);
}

/** Grand total VP, capped at {@link GAME_VP_CAP}. */
export function playerTotal(pg: PlayerGame): number {
  return Math.min(GAME_VP_CAP, playerPrimary(pg) + playerSecondary(pg));
}

/**
 * The WTC 20-point result from two grand totals. The winner's margin maps onto
 * 11 bands (0-5 → 10-10 draw, 6-10 → 11-9, ... 51+ → 20-0); the loser gets the
 * complement. `a`/`b` correspond to the argument order.
 */
export function wtcResult(totalA: number, totalB: number): { a: number; b: number } {
  const diff = Math.abs(totalA - totalB);
  const band = diff <= 5 ? 0 : Math.min(10, Math.ceil((diff - 5) / 5));
  const winner = 10 + band;
  const loser = 10 - band;
  if (totalA === totalB) return { a: 10, b: 10 };
  return totalA > totalB ? { a: winner, b: loser } : { a: loser, b: winner };
}
