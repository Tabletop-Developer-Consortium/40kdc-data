# MFM missions — DRY RUN

Reconciles mission scoring-card numbers (vp/vp_per, vp_max, cumulative) from the
GW MFM dump for both secondary cards and the 25 generic primary missions.
`exclusive_group` is an additive guard (filled only when missing). Primary
`vp_per_game_cap`/`vp_per_round_cap` are NOT reconciled — the dump carries no
per-mission cap (those are mission-pack-global rules). Prose is never touched.

| Metric | Count |
|---|--:|
| Cards matched | 43 |
| Cards changed | 0 |
| vp / vp_per changes | 0 |
| vp_max changes | 0 |
| cumulative changes | 0 |
| exclusive_group added | 0 |
| exclusive_group review (dump-uncorroborated) | 0 |
| Shape mismatches (skipped) | 2 |
| Repo cards with no dump match | 0 |
| Dump cards with no repo match | 0 |
| Primary reskins excluded (by design) | 24 |

## Shape mismatches — award/row counts differ, card left untouched

- immovable-object: none repo 3 vs dump 5
- surveil-the-foe: none repo 4 vs dump 2

