# MFM wargear — APPLIED

Dump-primary `default_weapon_ids` + wargear-options. BSData retained only for
dump-absent (repo-only) units. Unresolved weapon names are triaged, never guessed.

| Dir | Matched | Options | Defaults Δ | Weapon ids Δ | Weapon names Δ | Weapons + | Wargear + | Synth | Unresolved | Fuzzy | Notes | New-in-dump | Repo-only (fallback) |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| adepta-sororitas | 37 | 56 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| adeptus-astartes | 194 | 271 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 11 | 0 | 0 |
| adeptus-custodes | 35 | 23 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| adeptus-mechanicus | 38 | 34 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| aeldari | 80 | 102 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 1 | 0 | 0 |
| agents-of-the-imperium | 33 | 52 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 3 | 0 | 0 |
| astra-militarum | 75 | 160 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 |
| chaos-daemons | 53 | 14 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 92 | 0 |
| chaos-knights | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| chaos-space-marines | 58 | 96 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 3 | 99 | 0 |
| death-guard | 35 | 37 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 0 |
| drukhari | 27 | 40 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| emperors-children | 20 | 25 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 6 | 0 |
| genestealer-cults | 28 | 17 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| grey-knights | 30 | 44 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 0 |
| imperial-knights | 23 | 31 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 |
| leagues-of-votann | 26 | 33 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| necrons | 57 | 28 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| orks | 63 | 61 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| tau-empire | 47 | 94 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| thousand-sons | 32 | 41 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 0 |
| tyranids | 57 | 20 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| world-eaters | 29 | 40 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 0 |
| **TOTAL** | **1097** | **1339** | **0** | **0** | **0** | **0** | **0** | **0** | **0** | **12** | **23** | **214** | **0** |

## adeptus-astartes

**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**
- `Omnissian power axe` → `omnissiah-power-axe` (was `omnissian-power-axe`)

**Notes (cap approximations / alternates):**
- captain-in-terminator-armour: cross-product loadout set 09572c33 factored into 2 independent slot swaps (Captain in Terminator Armour)
- victrix-honour-guard: Chapter Ancient: no model_count — base_miniature_loadout fallback
- victrix-honour-guard: Chapter Champion: no model_count — base_miniature_loadout fallback
- scout-squad: cross-product loadout set 9f4b4632 factored into 1 independent slot swap (Scout Sergeant)
- assault-intercessors-with-jump-packs: cross-product loadout set c3f95b61 factored into 2 independent slot swaps (Assault Intercessor Sergeant with Jump Pack)
- outrider-squad: Invader ATV: no model_count — base_miniature_loadout fallback
- sword-brethren-squad: alternate loadout_choice_set f0e5f28e (Sword Brother) — review
- blood-claws: cross-product loadout set 619e340b factored into 2 independent slot swaps (Blood Claw Pack Leader)
- death-company-marines-with-jump-packs: cross-product loadout set 4613945b factored into 2 independent slot swaps (Death Company Marine with Jump Packs)
- decimus-kill-team: Deathwatch Veteran: no model_count — base_miniature_loadout fallback
- talonstrike-kill-team: cross-product loadout set 7f855f37 factored into 2 independent slot swaps (Kill Team Sergeant with Jump Pack)

## aeldari

**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**
- `Fire Axe` → `the-fire-axe` (was `fire-axe`)
- `Kha-vir` → `kha-vir-the-sword-of-sorrows` (was `kha-vir`)

**Notes (cap approximations / alternates):**
- dark-reapers: cross-product loadout set e2b678c5 factored into 1 independent slot swap (Dark Reaper Exarch)

## agents-of-the-imperium

**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**
- `Agent’s Firearm` → `agent-firearm` (was `agents-firearm`)

**Notes (cap approximations / alternates):**
- voidsmen-at-arms: Voidsman: 2 default loadout groups — base_miniature_loadout fallback
- imperial-navy-breachers: Navis Armsman: 3 default loadout groups — base_miniature_loadout fallback
- aquila-kill-team: Deathwatch Veteran: no model_count — base_miniature_loadout fallback

## astra-militarum

**Notes (cap approximations / alternates):**
- krieg-command-squad: cross-product loadout set ccf4871f factored into 1 independent slot swap (Veteran Guardsman)

## chaos-space-marines

**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**
- `Hades battle cannon` → `defiler-cannon` (was `hades-battle-cannon`)
- `Shearing claws` → `defiler-claws` (was `shearing-claws`)

**Notes (cap approximations / alternates):**
- havocs: Havoc: non-uniform default count — base_miniature_loadout fallback
- chaos-terminator-squad: alternate loadout_choice_set bbd655f9 (Chaos Terminator) — review
- chaos-terminator-squad: alternate loadout_choice_set c1fa45a8 (Terminator Champion) — review

## drukhari

**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**
- `Macro-scalpel` → `maco-scalpel` (was `macro-scalpel`)

## emperors-children

**Notes (cap approximations / alternates):**
- chaos-terminators: alternate loadout_choice_set ce82b2b8 (Chaos Terminator) — review
- chaos-terminators: alternate loadout_choice_set dc056a28 (Terminator Champion) — review

## genestealer-cults

**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**
- `Leader’s bio-weapons` → `leaders-cult-weapons` (was `leaders-bio-weapons`)

## grey-knights

**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**
- `Omnissian power axe` → `omnissiah-power-axe` (was `omnissian-power-axe`)

**Notes (cap approximations / alternates):**
- paladin-squad: cross-product loadout set f0d60da1 factored into 1 independent slot swap (Paladin)

## imperial-knights

**Notes (cap approximations / alternates):**
- sir-hekhtur: Sir Hekhtur: no model_count — base_miniature_loadout fallback

## orks

**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**
- `Choppas` → `choppa` (was `choppas`)
- `Twin killsaws` → `twin-killsaw` (was `twin-killsaws`)

## tyranids

**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**
- `Screamer-Killer talons` → `scream-killer-talons` (was `screamer-killer-talons`)

