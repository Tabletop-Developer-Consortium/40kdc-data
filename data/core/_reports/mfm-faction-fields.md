# MFM faction fields — APPLIED

Fill-only reconcile of `faction_rule_id` (single owned army rule), `parent_faction_id`
(dump faction hierarchy), and `aliases` (localized common name, additive). Authored
values are confirmed or surfaced for review, never overwritten. Prose untouched.

| Dir | rule-fill | rule-ok | rule-rev | parent-fill | parent-ok | parent-rev | aliases+ |
|---|--:|--:|--:|--:|--:|--:|--:|
| adepta-sororitas | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| adeptus-astartes | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| adeptus-custodes | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| adeptus-mechanicus | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| agents-of-the-imperium | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| astra-militarum | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| black-templars | 0 | 1 | 0 | 0 | 1 | 0 | 0 |
| blood-angels | 0 | 1 | 0 | 0 | 1 | 0 | 0 |
| chaos-knights | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| chaos-space-marines | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| dark-angels | 0 | 1 | 0 | 0 | 1 | 0 | 0 |
| death-guard | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| deathwatch | 0 | 0 | 1 | 0 | 1 | 0 | 0 |
| drukhari | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| emperors-children | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| genestealer-cults | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| grey-knights | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| imperial-fists | 0 | 1 | 0 | 0 | 1 | 0 | 0 |
| imperial-knights | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| iron-hands | 0 | 1 | 0 | 0 | 1 | 0 | 0 |
| leagues-of-votann | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| necrons | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| orks | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| raven-guard | 0 | 1 | 0 | 0 | 1 | 0 | 0 |
| salamanders | 0 | 0 | 0 | 0 | 1 | 0 | 0 |
| space-wolves | 0 | 1 | 0 | 0 | 1 | 0 | 0 |
| tau-empire | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| thousand-sons | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| tyranids | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| ultramarines | 0 | 1 | 0 | 0 | 1 | 0 | 0 |
| white-scars | 0 | 1 | 0 | 0 | 1 | 0 | 0 |
| world-eaters | 0 | 1 | 0 | 0 | 0 | 0 | 0 |

## adeptus-custodes
- faction_rule_id REVIEW: authored martial-ka-tah vs owned [martial-katah]

## death-guard
- faction_rule_id REVIEW: authored nurgle-s-gift-aura vs owned [nurgles-gift, pact-of-decay]

## deathwatch
- faction_rule_id REVIEW: authored mission-tactics vs owned [kill-teams, oath-of-moment, space-marine-chapters]

## orks
- faction_rule_id REVIEW: authored waaagh vs owned [da-boss, unstable-energies]

## Repo faction dirs with no dump faction keyword (left as-is): 3

- aeldari
- chaos-daemons
- crimson-fists

