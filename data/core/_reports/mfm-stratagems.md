# MFM stratagems — APPLIED

APPLIED (first-class dump columns): `cp_cost` ← cpCost, `player_turn` ← key,
`type` ← category (fill-only), `category` ← detachmentId presence.
REVIEW ONLY (not written): `phases`, prose-derived — the structured
`stratagem_phase` table is a buggy index (Insane Bravery→charge, Holy
Avarice→command, Scriptural Prognosis→all-five), so authored phases win.
`timing` + `game_version` left authored.

| Dir | Matched | cp | turn | type fill | type conflict | category | phases (review) | repo-only |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| (core) | 9 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| adepta-sororitas | 39 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| adeptus-astartes | 85 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| adeptus-custodes | 48 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| adeptus-mechanicus | 54 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| aeldari | 81 | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| agents-of-the-imperium | 33 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| astra-militarum | 60 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| black-templars | 93 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| blood-angels | 106 | 0 | 0 | 0 | 0 | 0 | 3 | 0 |
| chaos-daemons | 46 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| chaos-knights | 39 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| chaos-space-marines | 96 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| crimson-fists | 66 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| dark-angels | 106 | 0 | 0 | 0 | 0 | 0 | 3 | 0 |
| death-guard | 48 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| deathwatch | 71 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| drukhari | 48 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| emperors-children | 54 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| genestealer-cults | 48 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| grey-knights | 48 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| imperial-fists | 71 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| imperial-knights | 39 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| iron-hands | 71 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| leagues-of-votann | 54 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| necrons | 66 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| orks | 69 | 0 | 0 | 0 | 0 | 0 | 0 | 9 |
| raven-guard | 71 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| salamanders | 68 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| space-wolves | 102 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| tau-empire | 34 | 0 | 0 | 0 | 0 | 0 | 0 | 9 |
| thousand-sons | 48 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| tyranids | 54 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| ultramarines | 77 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| white-scars | 71 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| world-eaters | 42 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **TOTAL** | **2215** | **0** | **0** | **0** | **0** | **0** | **23** | **31** |

## (core)

**Phases — authored vs prose-derived (review only, NOT applied):**
- fire-overwatch: [movement,charge] vs [movement]

## adeptus-astartes

**Phases — authored vs prose-derived (review only, NOT applied):**
- shock-assault-stormlance-task-force: [charge] vs [fight]

## adeptus-custodes

**Phases — authored vs prose-derived (review only, NOT applied):**
- unstoppable-solar-spearhead: [movement] vs [movement,charge]

## agents-of-the-imperium

**Phases — authored vs prose-derived (review only, NOT applied):**
- stun-grenades-ordo-hereticus-purgation-force: [command,movement,shooting,charge,fight] vs [command]

## astra-militarum

**Phases — authored vs prose-derived (review only, NOT applied):**
- on-my-position-bridgehead-strike: [fight] vs [charge]

## black-templars

**Phases — authored vs prose-derived (review only, NOT applied):**
- shock-assault-stormlance-task-force: [charge] vs [fight]

## blood-angels

**Phases — authored vs prose-derived (review only, NOT applied):**
- death-from-the-skies-the-angelic-host: [charge] vs [movement]
- no-barrier-to-retribution-wrath-of-the-doomed: [shooting] vs [charge]
- shock-assault-stormlance-task-force: [charge] vs [fight]

## chaos-space-marines

**Phases — authored vs prose-derived (review only, NOT applied):**
- seize-the-prize-hurons-marauders: [fight] vs [movement]

## crimson-fists

**Phases — authored vs prose-derived (review only, NOT applied):**
- shock-assault-stormlance-task-force: [charge] vs [fight]

## dark-angels

**Phases — authored vs prose-derived (review only, NOT applied):**
- death-on-the-wind-company-of-hunters: [shooting] vs [movement]
- shock-assault-stormlance-task-force: [charge] vs [fight]
- talon-strike-company-of-hunters: [fight,shooting] vs [fight]

## deathwatch

**Phases — authored vs prose-derived (review only, NOT applied):**
- shock-assault-stormlance-task-force: [charge] vs [fight]

## drukhari

**Phases — authored vs prose-derived (review only, NOT applied):**
- preternatural-agility-spectacle-of-spite: [charge,movement] vs [charge]

## imperial-fists

**Phases — authored vs prose-derived (review only, NOT applied):**
- shock-assault-stormlance-task-force: [charge] vs [fight]

## iron-hands

**Phases — authored vs prose-derived (review only, NOT applied):**
- shock-assault-stormlance-task-force: [charge] vs [fight]

## raven-guard

**Phases — authored vs prose-derived (review only, NOT applied):**
- shock-assault-stormlance-task-force: [charge] vs [fight]

## salamanders

**Phases — authored vs prose-derived (review only, NOT applied):**
- shock-assault-stormlance-task-force: [charge] vs [fight]

## space-wolves

**Phases — authored vs prose-derived (review only, NOT applied):**
- shock-assault-stormlance-task-force: [charge] vs [fight]

## ultramarines

**Phases — authored vs prose-derived (review only, NOT applied):**
- shock-assault-stormlance-task-force: [charge] vs [fight]

## white-scars

**Phases — authored vs prose-derived (review only, NOT applied):**
- shock-assault-stormlance-task-force: [charge] vs [fight]

Stratagems in dump with no repo match (author via faction-pack flow): 2

