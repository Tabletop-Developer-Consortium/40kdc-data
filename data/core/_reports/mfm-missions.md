# MFM missions — APPLIED

Reconciles mission scoring-card numbers (vp/vp_per, vp_max, cumulative) from the
GW MFM dump for both secondary cards and the 25 generic primary missions.
`exclusive_group` is an additive guard (filled only when missing). The mission
ENTITY (missions.json) additionally gets its `source` filled and its primary-VP
caps confirmed from the owning mission_pack (all 25 share one matched-play pack,
so the pack-global caps project per mission). Prose is never touched.

| Metric | Count |
|---|--:|
| Cards matched | 43 |
| Cards changed | 0 |
| vp / vp_per changes | 0 |
| vp_max changes | 0 |
| cumulative changes | 0 |
| exclusive_group added | 0 |
| exclusive_group review (dump-uncorroborated) | 0 |
| Shape mismatches (skipped) | 0 |
| Repo cards with no dump match | 0 |
| Dump cards with no repo match | 0 |
| Primary reskins excluded (by design) | 24 |
| Mission-entity matched | 25 |
| source filled | 0 |
| source review (dump differs, kept) | 0 |
| VP caps confirmed | 100 |
| VP caps review (dump differs, kept) | 0 |

