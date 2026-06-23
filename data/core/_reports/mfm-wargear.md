# MFM wargear — APPLIED

Dump-primary `default_weapon_ids` + wargear-options. BSData retained only for
dump-absent (repo-only) units. Unresolved weapon names are triaged, never guessed.

| Dir | Matched | Options | Defaults Δ | Synth | Unresolved | Fuzzy | Notes | New-in-dump | Repo-only (fallback) |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| adepta-sororitas | 33 | 56 | 2 | 0 | 2 | 0 | 0 | 4 | 0 |
| adeptus-astartes | 174 | 264 | 11 | 0 | 18 | 1 | 10 | 20 | 0 |
| adeptus-custodes | 31 | 22 | 0 | 0 | 8 | 0 | 0 | 4 | 0 |
| adeptus-mechanicus | 34 | 33 | 1 | 0 | 0 | 0 | 8 | 4 | 0 |
| aeldari | 72 | 92 | 12 | 0 | 28 | 3 | 1 | 4 | 0 |
| agents-of-the-imperium | 29 | 47 | 6 | 0 | 12 | 1 | 4 | 4 | 0 |
| astra-militarum | 72 | 159 | 7 | 0 | 15 | 0 | 7 | 3 | 0 |
| chaos-daemons | 53 | 14 | 0 | 0 | 6 | 0 | 1 | 92 | 0 |
| chaos-knights | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| chaos-space-marines | 54 | 91 | 7 | 0 | 28 | 3 | 6 | 103 | 0 |
| death-guard | 30 | 24 | 4 | 0 | 39 | 0 | 0 | 11 | 0 |
| drukhari | 23 | 39 | 0 | 0 | 3 | 1 | 0 | 4 | 0 |
| emperors-children | 17 | 24 | 0 | 0 | 0 | 0 | 2 | 9 | 0 |
| genestealer-cults | 24 | 17 | 1 | 0 | 2 | 1 | 0 | 4 | 0 |
| grey-knights | 26 | 39 | 1 | 0 | 8 | 1 | 2 | 4 | 0 |
| imperial-knights | 23 | 31 | 0 | 0 | 0 | 0 | 1 | 0 | 0 |
| leagues-of-votann | 22 | 31 | 1 | 0 | 8 | 1 | 1 | 4 | 0 |
| necrons | 52 | 25 | 5 | 0 | 15 | 0 | 1 | 5 | 0 |
| orks | 58 | 49 | 0 | 0 | 8 | 2 | 1 | 5 | 0 |
| tau-empire | 43 | 74 | 7 | 0 | 13 | 0 | 1 | 4 | 0 |
| thousand-sons | 28 | 36 | 3 | 0 | 39 | 0 | 0 | 10 | 0 |
| tyranids | 52 | 17 | 6 | 0 | 0 | 1 | 1 | 5 | 0 |
| world-eaters | 25 | 40 | 0 | 0 | 0 | 0 | 1 | 9 | 0 |
| **TOTAL** | **995** | **1244** | **74** | **0** | **252** | **15** | **48** | **312** | **0** |

## adepta-sororitas

**Unresolved weapon names (no repo id — option/default incomplete):**
- `Salvationist Medikit` — sanctifiers

## adeptus-astartes

**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**
- `Omnissian power axe` → `omnissiah-power-axe` (was `omnissian-power-axe`)

**Unresolved weapon names (no repo id — option/default incomplete):**
- `Banner of Macragge` — victrix-honour-guard
- `Book of Salvation` — ezekiel
- `Centurion assault launcher` — centurion-assault-squad
- `Death Totem` — wulfen, wulfen-with-storm-shields
- `Orbital Comms Array (Aura)` — impulsor
- `Refractor Field` — wardens-of-ultramar
- `Terminator Storm Shield` — ancient-in-terminator-armour
- `The Lion Helm` — azrael
- `Watcher in the Dark` — deathwing-knights, deathwing-terminator-squad

**Notes (cap approximations / alternates):**
- victrix-honour-guard: Chapter Ancient: no model_count — base_miniature_loadout fallback
- victrix-honour-guard: Chapter Champion: no model_count — base_miniature_loadout fallback
- outrider-squad: Invader ATV: no model_count — base_miniature_loadout fallback
- sword-brethren-squad: alternate loadout_choice_set f0e5f28e (Sword Brother) — review
- sword-brethren-squad: composition has row(s) absent from the dump (Sword Brethren Squad) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized
- fenrisian-wolves: composition has row(s) absent from the dump (Fenrisian Wolves) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized
- wulfen-with-storm-shields: composition has row(s) absent from the dump (Wulfen with Storm Shields) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized
- decimus-kill-team: Deathwatch Veteran: no model_count — base_miniature_loadout fallback
- decimus-kill-team: composition has row(s) absent from the dump (Watch Sergeant) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized
- talonstrike-kill-team: composition has row(s) absent from the dump (Kill Team Heavy Intercessor with Jump Pack) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized

## adeptus-custodes

**Unresolved weapon names (no repo id — option/default incomplete):**
- `Praesidium Shield` — custodian-guard, shield-captain
- `Tarsis buckler` — venatari-custodians
- `Vexilla` — allarus-custodians, custodian-guard, custodian-wardens

## adeptus-mechanicus

**Notes (cap approximations / alternates):**
- pteraxii-skystalkers: composition has row(s) absent from the dump (Pteraxii Alpha) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized
- pteraxii-sterylizors: composition has row(s) absent from the dump (Pteraxii Alpha) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized
- serberys-raiders: composition has row(s) absent from the dump (Serberys Alpha) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized
- serberys-sulphurhounds: composition has row(s) absent from the dump (Serberys Alpha) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized
- sicarian-infiltrators: composition has row(s) absent from the dump (Sicarian Princeps) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized
- sicarian-ruststalkers: composition has row(s) absent from the dump (Sicarian Princeps) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized
- sydonian-dragoons-with-radium-jezzails: composition has row(s) absent from the dump (Sydonian Dragoons with Radium Jezzails) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized
- sydonian-dragoons-with-taser-lances: composition has row(s) absent from the dump (Sydonian Dragoons with Taser Lances) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized

## aeldari

**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**
- `Blade of Destruction` → `strike` (was `blade-of-destruction`)
- `Fire Axe` → `the-fire-axe` (was `fire-axe`)
- `Kha-vir` → `kha-vir-the-sword-of-sorrows` (was `kha-vir`)

**Unresolved weapon names (no repo id — option/default incomplete):**
- `Aspect Shrine Token` — dark-reapers, dire-avengers, fire-dragons, howling-banshees, striking-scorpions, swooping-hawks, warp-spiders
- `Channeller Stones` — corsair-voidscarred
- `Faolchú` — corsair-voidscarred
- `Flip Belt` — death-jester, shadowseer, solitaire, troupe, troupe-master
- `Forceshield` — wraithblades
- `Serpent shield` — storm-guardians
- `Shadow Field` — ynnari-archon

**Notes (cap approximations / alternates):**
- warlock-conclave: composition has row(s) absent from the dump (Warlock Conclave) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized

## agents-of-the-imperium

**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**
- `Nuncio-acquila` → `nuncio-aquila` (was `nuncio-acquila`)

**Unresolved weapon names (no repo id — option/default incomplete):**
- `Arbites Medi-kit` — exaction-squad
- `Endurant Shield` — imperial-navy-breachers
- `Glovodan Psyber‐eagle` — inquisitor-coteaz
- `Healing serum` — rogue-trader-entourage
- `Salvationist Medikit` — sanctifiers
- `Simulacrum Imperialis` — sanctifiers, sisters-of-battle-squad
- `Soulguilt Scanner` — exaction-squad
- `Tome‐skull` — inquisitorial-agents

**Notes (cap approximations / alternates):**
- voidsmen-at-arms: Voidsman: 2 default loadout groups — base_miniature_loadout fallback
- aquila-kill-team: Deathwatch Veteran: no model_count — base_miniature_loadout fallback
- aquila-kill-team: composition has row(s) absent from the dump (Watch Sergeant) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized
- imperial-navy-breachers: Navis Armsman: 3 default loadout groups — base_miniature_loadout fallback

## astra-militarum

**Unresolved weapon names (no repo id — option/default incomplete):**
- `Alchemyk Counteragents` — krieg-command-squad
- `Aquiline Prow` — commissar-graves
- `Death Korps Medi-pack` — death-korps-of-krieg
- `Medi-pack` — cadian-command-squad, catachan-command-squad, militarum-tempestus-command-squad
- `Melta Mine` — kasrkin
- `Remote Mine` — krieg-combat-engineers
- `Servo-scribes` — krieg-command-squad
- `Vox‑relay Beacon` — cadian-recon-squad

**Notes (cap approximations / alternates):**
- attilan-rough-riders: composition has row(s) absent from the dump (Attilan Rough Rider) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized
- cadian-shock-troops: composition has row(s) absent from the dump (Cadian Sergeant, Cadian Shock Trooper) while 2 dump row(s) are missing — manual reconcile, not auto-synthesized
- death-korps-of-krieg: composition has row(s) absent from the dump (Watchmaster) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized
- catachan-jungle-fighters: composition has row(s) absent from the dump (Catachan Sergeant, Catachan Jungle Fighter) while 2 dump row(s) are missing — manual reconcile, not auto-synthesized
- ratlings: composition has row(s) absent from the dump (Ratlings) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized
- tempestus-aquilons: composition has row(s) absent from the dump (Tempestor) while 2 dump row(s) are missing — manual reconcile, not auto-synthesized
- krieg-command-squad: composition has row(s) absent from the dump (Veteran Guardsman (Chainsword), Veteran Guardsman (Servo-scribes), Veteran Guardsman (Master Vox), Veteran Guardsman (Regimental Standard), Veteran Guardsman (Boltgun)) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized

## chaos-daemons

**Unresolved weapon names (no repo id — option/default incomplete):**
- `Brass Collar of Bloody Vengeance` — karanak
- `Collar of Khorne` — flesh-hounds

**Notes (cap approximations / alternates):**
- nurglings: composition has row(s) absent from the dump (Nurglings) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized

## chaos-space-marines

**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**
- `Hades battle cannon` → `defiler-cannon` (was `hades-battle-cannon`)
- `Shearing claws` → `defiler-claws` (was `shearing-claws`)
- `Tyrant’s Claw heavy flamer` → `ranged` (was `tyrants-claw-heavy-flamer`)

**Unresolved weapon names (no repo id — option/default incomplete):**
- `Ectoplasma destructor` — defiler
- `Electroscourge` — defiler
- `Hades lascannon` — defiler
- `Heavy baleflamer` — defiler
- `Heavy missile launcher` — defiler
- `Heavy reaper autocannon` — defiler
- `Voice Eater` — nemesis-claw

**Notes (cap approximations / alternates):**
- cultist-mob: composition has row(s) absent from the dump (Cultist) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized
- havocs: Havoc: non-uniform default count — base_miniature_loadout fallback
- chaos-terminator-squad: alternate loadout_choice_set bbd655f9 (Chaos Terminator) — review
- chaos-terminator-squad: alternate loadout_choice_set c1fa45a8 (Terminator Champion) — review
- nemesis-claw: composition has row(s) absent from the dump (Nemesis Champion, Nemesis Claw) while 2 dump row(s) are missing — manual reconcile, not auto-synthesized
- red-corsairs-raiders: composition has row(s) absent from the dump (Corsair Champion, Red Corsair) while 2 dump row(s) are missing — manual reconcile, not auto-synthesized

## death-guard

**Unresolved weapon names (no repo id — option/default incomplete):**
- `Ectoplasma destructor` — defiler
- `Electroscourge` — defiler
- `Excruciator cannon` — defiler
- `Hades battle cannon` — defiler
- `Hades lascannon` — defiler
- `Heavy baleflamer` — defiler
- `Heavy missile launcher` — defiler
- `Heavy reaper autocannon` — defiler
- `Icon of Despair (Aura)` — deathshroud-terminators, plague-marines
- `Magma cutters` — defiler
- `Shearing claws` — defiler

## drukhari

**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**
- `Macro-scalpel` → `maco-scalpel` (was `macro-scalpel`)

**Unresolved weapon names (no repo id — option/default incomplete):**
- `Shadowfield` — archon
- `Stimm-needler` — hand-of-the-archon

## emperors-children

**Notes (cap approximations / alternates):**
- chaos-terminators: alternate loadout_choice_set ce82b2b8 (Chaos Terminator) — review
- chaos-terminators: alternate loadout_choice_set dc056a28 (Terminator Champion) — review

## genestealer-cults

**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**
- `Leader’s bio-weapons` → `leaders-cult-weapons` (was `leaders-bio-weapons`)

**Unresolved weapon names (no repo id — option/default incomplete):**
- `Alchemicus Familiar` — biophagus

## grey-knights

**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**
- `Omnissian power axe` → `omnissiah-power-axe` (was `omnissian-power-axe`)

**Unresolved weapon names (no repo id — option/default incomplete):**
- `Ancient’s Banner` — brotherhood-terminator-squad, paladin-squad

**Notes (cap approximations / alternates):**
- purgation-squad: composition has row(s) absent from the dump (Justicar) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized
- interceptor-squad: composition has row(s) absent from the dump (Justicar) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized

## imperial-knights

**Notes (cap approximations / alternates):**
- sir-hekhtur: Sir Hekhtur: no model_count — base_miniature_loadout fallback

## leagues-of-votann

**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**
- `Panspectral Scanner` → `pan-spectral-scanner` (was `panspectral-scanner`)

**Unresolved weapon names (no repo id — option/default incomplete):**
- `Multiwave Comms Array` — hernkyn-pioneers
- `Preymark Crest` — ironkin-steeljacks-with-heavy-volkanite-disintegrators, ironkin-steeljacks-with-melee-weapons
- `Rollbar Searchlight` — hernkyn-pioneers

**Notes (cap approximations / alternates):**
- brokhyr-iron-master: composition has row(s) absent from the dump (E-COG with Autoch-pattern Bolt Pistol, E-COG with Plasma Torch, E-COG with Manipulator Arms) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized

## necrons

**Unresolved weapon names (no repo id — option/default incomplete):**
- `Antimatter Meteor` — tesseract-vault
- `Blade tail and whip coils` — nekrosor-ammentar
- `Cosmic Fire` — tesseract-vault
- `Fabricator Claw Array (Aura)` — canoptek-spyders
- `Gloom Prism (Aura)` — canoptek-spyders
- `Nanoscarab Projector` — canoptek-macrocytes
- `Nullstone Field Generator (Aura)` — nekrosor-ammentar
- `Time’s Arrow` — tesseract-vault
- `Weapons of the Final Triarch` — the-silent-king

**Notes (cap approximations / alternates):**
- convergence-of-dominion: composition has row(s) absent from the dump (Convergence of Dominion) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized

## orks

**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**
- `Choppas` → `choppa` (was `choppas`)
- `Twin killsaws` → `twin-killsaw` (was `twin-killsaws`)

**Unresolved weapon names (no repo id — option/default incomplete):**
- `Ammo Runt` — flash-gitz, nobz
- `Bomb Squig` — kommandos, squighog-boyz
- `Distraction Grot` — kommandos
- `Grot Assistant` — big-mek-with-shokk-attack-gun
- `Grot Oiler` — big-mek-in-mega-armour
- `Pulsa Rokkit` — tankbustas

**Notes (cap approximations / alternates):**
- mek-gunz: composition has row(s) absent from the dump (Mek Gunz) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized

## tau-empire

**Unresolved weapon names (no repo id — option/default incomplete):**
- `Advanced Guardian Drone` — commander-shadowsun
- `Command-link Drone (Aura)` — commander-shadowsun
- `Hover Drone` — ethereal
- `MV15 Gun Drone` — the-twin-lance
- `Missile Drone` — broadside-battlesuits, riptide-battlesuit
- `Pech’ra` — kroot-farstalkers

**Notes (cap approximations / alternates):**
- kroot-farstalkers: composition has row(s) absent from the dump (Kill-Broker) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized

## thousand-sons

**Unresolved weapon names (no repo id — option/default incomplete):**
- `Ectoplasma destructor` — defiler
- `Electroscourge` — defiler
- `Excruciator cannon` — defiler
- `Hades battle cannon` — defiler
- `Hades lascannon` — defiler
- `Heavy baleflamer` — defiler
- `Heavy missile launcher` — defiler
- `Heavy reaper autocannon` — defiler
- `Pyraflux magma cutters` — defiler
- `Shearing claws` — defiler

## tyranids

**Fuzzy-resolved spelling drift (GW name → repo id, edit-distance ≤1):**
- `Screamer-Killer talons` → `scream-killer-talons` (was `screamer-killer-talons`)

**Notes (cap approximations / alternates):**
- carnifexes: composition has row(s) absent from the dump (Carnifexes) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized

## world-eaters

**Notes (cap approximations / alternates):**
- khorne-berzerkers: composition has row(s) absent from the dump (Berzerker Champion) while 1 dump row(s) are missing — manual reconcile, not auto-synthesized

