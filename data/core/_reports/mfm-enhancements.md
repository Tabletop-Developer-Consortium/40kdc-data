# MFM enhancement reconcile — APPLIED

Reconciles source-owned fields and seeds source-complete matched-play
enhancements whose detachment already exists. `keyword_restriction_groups`
preserves exact OR-of-AND eligibility. `exclusion_keywords` and the legacy
flat `keyword_restrictions` remain fill-only. Prose is never read or written.

| Dir | Matched | Cost | upgrade | max_tgt | groups | excl-fill | excl-rev | restr-fill | restr-rev | Repo-only |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| adepta-sororitas | 27 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 7 | 0 |
| adeptus-astartes | 61 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 28 | 0 |
| adeptus-custodes | 32 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 11 | 0 |
| adeptus-mechanicus | 36 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 27 | 0 |
| aeldari | 54 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 48 | 3 |
| agents-of-the-imperium | 22 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 10 | 0 |
| astra-militarum | 40 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 38 | 1 |
| black-templars | 75 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 39 | 1 |
| blood-angels | 84 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 54 | 0 |
| chaos-daemons | 29 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 27 | 0 |
| chaos-knights | 28 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 7 | 0 |
| chaos-space-marines | 64 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 50 | 0 |
| crimson-fists | 56 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 28 | 0 |
| dark-angels | 84 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 53 | 0 |
| death-guard | 32 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 18 | 0 |
| deathwatch | 60 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 29 | 0 |
| drukhari | 32 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 22 | 0 |
| emperors-children | 36 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 15 | 1 |
| genestealer-cults | 32 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 12 | 0 |
| grey-knights | 32 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 14 | 1 |
| imperial-fists | 60 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 32 | 0 |
| imperial-knights | 26 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 2 |
| iron-hands | 60 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 32 | 0 |
| leagues-of-votann | 36 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 14 | 1 |
| necrons | 44 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 20 | 2 |
| orks | 45 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 28 | 7 |
| raven-guard | 59 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 29 | 1 |
| salamanders | 57 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 31 | 0 |
| space-wolves | 80 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 45 | 1 |
| tau-empire | 25 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 15 | 3 |
| thousand-sons | 32 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 11 | 0 |
| tyranids | 36 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 15 | 3 |
| ultramarines | 64 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 28 | 0 |
| white-scars | 60 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 29 | 0 |
| world-eaters | 28 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 12 | 0 |
| **TOTAL** | **1628** | **0** | **0** | **0** | **0** | **0** | **0** | **0** | **883** | **27** |

## adepta-sororitas

**keyword_restrictions — authored kept, REVIEW:**
- verse-of-holy-piety-penitent-host (differs): authored [Adepta Sororitas] vs dump-union [Penitent]
- refrain-of-enduring-faith-penitent-host (differs): authored [Adepta Sororitas] vs dump-union [Penitent]
- clarion-of-urgency-chorus-of-condemnation (differs): authored [Canoness with Jump Pack] vs dump-union [Adepta Sororitas, Canoness with Jump Pack]
- symphonic-payload-upgrade-chorus-of-condemnation (differs): authored [Exorcist] vs dump-union [Adepta Sororitas, Exorcist]
- writ-of-compunction-upgrade-sacred-champions (differs): authored [Celestian Sacresants] vs dump-union [Adepta Sororitas, Celestian Sacresants]
- hagiomnifex-upgrade-sanctified-orators (differs): authored [Adepta Sororitas Character] vs dump-union [Adepta Sororitas, Character]
- righteous-fervour-sanctuary-guardians (differs): authored [Adepta Sororitas, Sanctuary Canoness Adalya] vs dump-union [Adepta Sororitas, Canoness]

## adeptus-astartes

**keyword_restrictions — authored kept, REVIEW:**
- the-blade-driven-deep-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- adept-of-the-codex-gladius-task-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- execute-and-redeploy-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- shadow-war-veteran-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- indomitable-fury-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- fleet-commander-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- target-augury-web-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- adept-of-the-omnissiah-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- champion-of-humanity-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Tacticus]
- war-tempered-artifice-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- fury-of-the-storm-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- hunters-instincts-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- rites-of-war-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- iron-resolve-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- celerity-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- prescience-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- obfuscation-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- temporal-corridor-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- fusillade-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- bellicose-weapon-spirits-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- raptorial-cogitator-core-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- shroud-field-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- death-in-the-dark-upgrade-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Infantry, Phobos]
- honour-indefatigable-ceramite-sentinels (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- redoubtable-machine-spirit-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- gunnery-honours-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- firestorm-coordinators-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- astartes-tank-ace-aura-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]

## adeptus-custodes

**keyword_restrictions — authored kept, REVIEW:**
- from-the-hall-of-armouries-shield-host (differs): authored [Adeptus Custodes] vs dump-union [Shield-Captain]
- castellans-mark-shield-host (differs): authored [Adeptus Custodes] vs dump-union [Shield-Captain]
- raptor-blade-null-maiden-vigil (differs): authored [Adeptus Custodes] vs dump-union [Anathema Psykana]
- enhanced-voidsheen-cloak-null-maiden-vigil (differs): authored [Adeptus Custodes] vs dump-union [Anathema Psykana]
- huntress-eye-null-maiden-vigil (differs): authored [Adeptus Custodes] vs dump-union [Anathema Psykana]
- oblivion-knight-null-maiden-vigil (differs): authored [Adeptus Custodes] vs dump-union [Anathema Psykana]
- honoured-fallen-aura-solar-spearhead (differs): authored [Adeptus Custodes] vs dump-union [Adeptus Custodes, Vehicle]
- superior-creation-lions-of-the-emperor (differs): authored [Adeptus Custodes] vs dump-union [Adeptus Custodes, Infantry]
- fierce-conqueror-lions-of-the-emperor (differs): authored [Adeptus Custodes] vs dump-union [Shield-Captain]
- admonimortis-lions-of-the-emperor (differs): authored [Adeptus Custodes] vs dump-union [Shield-Captain]
- shattering-charge-tristraens-gilded-blades (differs): authored [Blade Champion, Tristraen's Gilded Blades] vs dump-union [Adeptus Custodes, Tristraen of the Gilded Blades]

## adeptus-mechanicus

**keyword_restrictions — authored kept, REVIEW:**
- cantic-thrallnet-skitarii-hunter-cohort (differs): authored [Adeptus Mechanicus] vs dump-union [Marshal]
- clandestine-infiltrator-skitarii-hunter-cohort (differs): authored [Adeptus Mechanicus] vs dump-union [Skitarii]
- veiled-hunter-skitarii-hunter-cohort (differs): authored [Adeptus Mechanicus] vs dump-union [Marshal]
- battle-sphere-uplink-skitarii-hunter-cohort (differs): authored [Adeptus Mechanicus] vs dump-union [Skitarii]
- mechanicus-locum-data-psalm-conclave (differs): authored [Adeptus Mechanicus] vs dump-union [Tech-Priest]
- mantle-of-the-gnosticarch-data-psalm-conclave (differs): authored [Adeptus Mechanicus] vs dump-union [Tech-Priest]
- data-blessed-autosermon-data-psalm-conclave (differs): authored [Adeptus Mechanicus] vs dump-union [Tech-Priest]
- temporcopia-data-psalm-conclave (differs): authored [Adeptus Mechanicus] vs dump-union [Tech-Priest]
- magos-explorator-maniple (differs): authored [Adeptus Mechanicus] vs dump-union [Tech-Priest]
- genetor-explorator-maniple (differs): authored [Adeptus Mechanicus] vs dump-union [Tech-Priest]
- logis-explorator-maniple (differs): authored [Adeptus Mechanicus] vs dump-union [Tech-Priest]
- artisan-explorator-maniple (differs): authored [Adeptus Mechanicus] vs dump-union [Tech-Priest]
- necromechanic-cohort-cybernetica (differs): authored [Adeptus Mechanicus] vs dump-union [Tech-Priest]
- lord-of-machines-cohort-cybernetica (differs): authored [Adeptus Mechanicus] vs dump-union [Tech-Priest]
- emotionless-clarity-cohort-cybernetica (differs): authored [Adeptus Mechanicus] vs dump-union [Tech-Priest]
- arch-negator-cohort-cybernetica (differs): authored [Adeptus Mechanicus] vs dump-union [Tech-Priest]
- transoracular-dyad-wafers-haloscreed-battle-clade (differs): authored [Adeptus Mechanicus] vs dump-union [Cybernetica Datasmith]
- explorator-dispensation-cohort-acquisitus (differs): authored [Skitarii Marshal] vs dump-union [Adeptus Mechanicus, Skitarii Marshal]
- stealth-screened-cybercanids-upgrade-cohort-acquisitus (differs): authored [Serberys Raiders] vs dump-union [Adeptus Mechanicus, Serberys Raiders]
- vinghs-wafers-of-dynamism-lords-of-the-forge (differs): authored [Cybernetica Datasmith] vs dump-union [Adeptus Mechanicus, Cybernetica Datasmith]
- tl-4-9-lords-of-the-forge (differs): authored [Tech-Priest] vs dump-union [Adeptus Mechanicus, Tech-Priest]
- voltagheist-reliquary-luminen-auto-choir (differs): authored [Tech-Priest] vs dump-union [Adeptus Mechanicus, Tech-Priest]
- electromiasmic-brazier-luminen-auto-choir (differs): authored [Tech-Priest] vs dump-union [Adeptus Mechanicus, Tech-Priest]
- omnicogitator-eradication-cohort (differs): authored [Skitarii Marshal] vs dump-union [Marshal, Skitarii]
- omnissiahs-fury-eradication-cohort (differs): authored [Skitarii Marshal] vs dump-union [Marshal, Skitarii]
- empowered-mechanisms-purge-corps-deltic-9 (differs): authored [Purge Corps Deltic-9, Serberys Sulphurhounds] vs dump-union [Purge Corps Serberys Sulphurhounds]
- miniaturised-autosimulacra-purge-corps-deltic-9 (differs): authored [Purge Corps Deltic-9, Tech-Priest Manipulus] vs dump-union [Manipulus Skand]

## aeldari

**keyword_restrictions — authored kept, REVIEW:**
- firstdrawn-blade-windrider-host (differs): authored [Aeldari] vs dump-union [Asuryani, Mounted]
- phoenix-gem-warhost (differs): authored [Aeldari] vs dump-union [Asuryani]
- mirage-field-windrider-host (differs): authored [Aeldari] vs dump-union [Asuryani, Mounted]
- seersight-strike-windrider-host (differs): authored [Aeldari] vs dump-union [Asuryani, Mounted, Psyker]
- echoes-of-ulthanesh-windrider-host (differs): authored [Aeldari] vs dump-union [Asuryani, Mounted]
- guiding-presence-armoured-warhost (differs): authored [Aeldari] vs dump-union [Aeldari, Psyker]
- light-of-clarity-spirit-conclave (differs): authored [Aeldari] vs dump-union [Spiritseer]
- rune-of-mists-spirit-conclave (differs): authored [Aeldari] vs dump-union [Spiritseer]
- spirit-stone-of-raelyth-armoured-warhost (differs): authored [Aeldari] vs dump-union [Aeldari, Psyker]
- higher-duty-spirit-conclave (differs): authored [Aeldari] vs dump-union [Spiritseer]
- cegorachs-coil-ghosts-of-the-webway (differs): authored [Aeldari] vs dump-union [Troupe Master]
- mask-of-secrets-ghosts-of-the-webway (differs): authored [Aeldari] vs dump-union [Harlequins]
- murders-jest-ghosts-of-the-webway (differs): authored [Aeldari] vs dump-union [Death Jester]
- mistweave-ghosts-of-the-webway (differs): authored [Aeldari] vs dump-union [Shadowseer]
- timeless-strategist-warhost (differs): authored [Aeldari] vs dump-union [Asuryani]
- gift-of-foresight-warhost (differs): authored [Aeldari] vs dump-union [Asuryani]
- psychic-destroyer-warhost (differs): authored [Aeldari] vs dump-union [Asuryani, Psyker]
- craftworlds-champion-guardian-battlehost (differs): authored [Aeldari] vs dump-union [Asuryani]
- ethereal-pathway-guardian-battlehost (differs): authored [Aeldari] vs dump-union [Asuryani]
- protector-of-the-paths-guardian-battlehost (differs): authored [Aeldari] vs dump-union [Asuryani]
- breath-of-vaul-guardian-battlehost (differs): authored [Aeldari] vs dump-union [Asuryani]
- gaze-of-ynnead-devoted-of-ynnead (differs): authored [Aeldari] vs dump-union [Farseer]
- storm-of-whispers-devoted-of-ynnead (differs): authored [Aeldari] vs dump-union [Warlock]
- borrowed-vigour-devoted-of-ynnead (differs): authored [Aeldari] vs dump-union [Archon]
- morbid-might-devoted-of-ynnead (differs): authored [Aeldari] vs dump-union [Succubus]
- lucid-eye-seer-council (differs): authored [Aeldari] vs dump-union [Asuryani, Psyker]
- runes-of-warding-seer-council (differs): authored [Aeldari] vs dump-union [Asuryani, Psyker]
- stone-of-eldritch-fury-seer-council (differs): authored [Aeldari] vs dump-union [Asuryani, Psyker]
- torc-of-morai-heg-seer-council (differs): authored [Aeldari] vs dump-union [Asuryani, Psyker]
- key-of-ghosts-serpents-brood (differs): authored [Aeldari] vs dump-union [Harlequins]
- weavers-wail-serpents-brood (differs): authored [Aeldari] vs dump-union [Troupe Master]
- fanged-leer-serpents-brood (differs): authored [Aeldari] vs dump-union [Death Jester]
- shedskin-raiment-serpents-brood (differs): authored [Aeldari] vs dump-union [Shadowseer]
- pirate-prince-eldritch-raiders (differs): authored [Aeldari] vs dump-union [Prince Yriel]
- alacritous-assault-eldritch-raiders (differs): authored [Aeldari] vs dump-union [Anhrathe]
- exotic-munitions-eldritch-raiders (differs): authored [Aeldari] vs dump-union [Anhrathe]
- adrenal-infusions-eldritch-raiders (differs): authored [Aeldari] vs dump-union [Anhrathe, Infantry]
- infamy-aura-corsair-coterie (differs): authored [Aeldari] vs dump-union [Anhrathe]
- webway-pathstone-corsair-coterie (differs): authored [Aeldari] vs dump-union [Anhrathe]
- archraider-corsair-coterie (differs): authored [Aeldari] vs dump-union [Anhrathe, Character]
- voidstone-corsair-coterie (differs): authored [Aeldari] vs dump-union [Anhrathe, Infantry]
- a-foot-in-the-future-fateful-performance (differs): authored [Aeldari] vs dump-union [Harlequins, Troupe Master]
- mistweave-fateful-performance (differs): authored [Aeldari] vs dump-union [Harlequins, Shadowseer]
- camouflaged-snipers-upgrade-path-of-the-outcast (differs): authored [Aeldari] vs dump-union [Asuryani, Rangers]
- shadowfall-masks-upgrade-twilight-flickers (differs): authored [Aeldari] vs dump-union [Harlequins, Troupe]
- prelude-performer-twilight-flickers (differs): authored [Aeldari] vs dump-union [Harlequins]
- guided-jump-kygharils-protectors (differs): authored [Kygharil's Protectors, Warp Spiders] vs dump-union [Kygharil's Protectors Warp Spiders]
- seers-hand-kygharils-protectors (differs): authored [Kygharil's Protectors, Spiritseer] vs dump-union [Spiritseer Kygharil]

**Repo enhancements absent from dump** (left as-is):
- stave-of-kurnos-spirit-conclave
- harmonisation-matrix-armoured-warhost
- guileful-strategist-armoured-warhost

## agents-of-the-imperium

**keyword_restrictions — authored kept, REVIEW:**
- beacon-angelis-ordo-xenos-alien-hunters (differs): authored [Agents of the Imperium] vs dump-union [Watch Master]
- amulet-of-auto-chastisement-ordo-xenos-alien-hunters (differs): authored [Agents of the Imperium] vs dump-union [Watch Master]
- no-escape-aura-ordo-hereticus-purgation-force (differs): authored [Agents of the Imperium] vs dump-union [Inquisitor]
- formidable-resolve-ordo-malleus-daemon-hunters (differs): authored [Agents of the Imperium] vs dump-union [Inquisitor]
- daemon-slayer-ordo-malleus-daemon-hunters (differs): authored [Agents of the Imperium] vs dump-union [Inquisitor]
- grimoire-of-true-names-aura-ordo-malleus-daemon-hunters (differs): authored [Agents of the Imperium] vs dump-union [Inquisitor]
- gift-of-the-prescient-ordo-malleus-daemon-hunters (differs): authored [Agents of the Imperium] vs dump-union [Inquisitor]
- fleetmaster-imperialis-fleet (differs): authored [Agents of the Imperium] vs dump-union [Voidfarers]
- combat-landers-imperialis-fleet (differs): authored [Agents of the Imperium] vs dump-union [Voidfarers]
- killer-reflexes-inquisitors-hand (differs): authored [Eversor Assassin, Inquisitor's Hand] vs dump-union [Inquisitor's Hand Eversor Assassin]

## astra-militarum

**keyword_restrictions — authored kept, REVIEW:**
- death-mask-of-ollanius-combined-arms (differs): authored [Astra Militarum] vs dump-union [Officer]
- bombast-class-vox-array-bridgehead-strike (differs): authored [Astra Militarum] vs dump-union [Astra Militarum, Militarum Tempestus, Officer]
- drill-commander-combined-arms (differs): authored [Astra Militarum] vs dump-union [Officer]
- priority-drop-beacon-bridgehead-strike (differs): authored [Astra Militarum] vs dump-union [Astra Militarum, Militarum Tempestus, Officer]
- grand-strategist-combined-arms (differs): authored [Astra Militarum] vs dump-union [Officer]
- reactive-command-combined-arms (differs): authored [Astra Militarum] vs dump-union [Officer]
- eager-advance-siege-regiment (differs): authored [Astra Militarum] vs dump-union [Infantry, Officer]
- flash-grenades-siege-regiment (differs): authored [Astra Militarum] vs dump-union [Infantry, Officer]
- legacy-sidearm-siege-regiment (differs): authored [Astra Militarum] vs dump-union [Infantry, Officer]
- stalwarts-honours-siege-regiment (differs): authored [Astra Militarum] vs dump-union [Officer]
- bold-leadership-mechanised-assault (differs): authored [Astra Militarum] vs dump-union [Infantry, Officer]
- sacred-unguents-mechanised-assault (differs): authored [Astra Militarum] vs dump-union [Astra Militarum, Tech-Priest Enginseer]
- smoke-grenades-mechanised-assault (differs): authored [Astra Militarum] vs dump-union [Infantry, Officer]
- vanguard-honours-mechanised-assault (differs): authored [Astra Militarum] vs dump-union [Infantry, Officer]
- calm-under-fire-hammer-of-the-emperor (differs): authored [Astra Militarum] vs dump-union [Officer, Vehicle]
- indomitable-steed-hammer-of-the-emperor (differs): authored [Astra Militarum] vs dump-union [Officer, Vehicle]
- regimental-banner-hammer-of-the-emperor (differs): authored [Astra Militarum] vs dump-union [Officer, Vehicle]
- veteran-crew-hammer-of-the-emperor (differs): authored [Astra Militarum] vs dump-union [Officer, Vehicle]
- guerrilla-honours-recon-element (differs): authored [Astra Militarum] vs dump-union [Infantry, Officer]
- scare-gas-grenades-recon-element (differs): authored [Astra Militarum] vs dump-union [Astra Militarum, Infantry]
- survival-gear-recon-element (differs): authored [Astra Militarum] vs dump-union [Astra Militarum, Infantry]
- tripwires-recon-element (differs): authored [Astra Militarum] vs dump-union [Astra Militarum, Infantry]
- abhuman-detail-grizzled-company (differs): authored [Astra Militarum] vs dump-union [Commissar]
- aquilan-eye-grizzled-company (differs): authored [Astra Militarum] vs dump-union [Astra Militarum, Officer]
- spec-ops-veteran-grizzled-company (differs): authored [Astra Militarum] vs dump-union [Astra Militarum, Infantry, Officer]
- laud-hailer-grizzled-company (differs): authored [Astra Militarum] vs dump-union [Astra Militarum, Officer]
- exemplar-of-duty-upgrade-abhuman-auxiliaries (differs): authored [Astra Militarum] vs dump-union [Commissar]
- long-range-scout-upgrade-designation-force (differs): authored [Astra Militarum] vs dump-union [Astra Militarum, Scout Sentinels]
- recon-star-upgrade-designation-force (differs): authored [Astra Militarum] vs dump-union [Astra Militarum, Infantry, Platoon]
- battalion-commander-steel-hammer (differs): authored [Astra Militarum] vs dump-union [Astra Militarum, Titanic]
- titan-killer-steel-hammer (differs): authored [Astra Militarum] vs dump-union [Astra Militarum, Titanic]
- engine-speaker-steel-hammer (differs): authored [Astra Militarum] vs dump-union [Astra Militarum, Tech-Priest Enginseer]
- assault-hatches-steel-hammer (differs): authored [Astra Militarum] vs dump-union [Astra Militarum, Titanic, Transport]
- exemplary-officer-armoured-infantry (differs): authored [Astra Militarum] vs dump-union [Infantry, Officer]
- master-manoeuvrist-armoured-infantry (differs): authored [Astra Militarum] vs dump-union [Infantry, Officer]
- omnissian-unguents-aura-armoured-infantry (differs): authored [Astra Militarum] vs dump-union [Astra Militarum, Tech-Priest Enginseer]
- grand-strategist-armoured-infantry (differs): authored [Astra Militarum] vs dump-union [Officer]
- draydens-drill-draydens-lance (differs): authored [Drayden's Lance, Kasrkin] vs dump-union [Drayden's Lance Kasrkin]

**Repo enhancements absent from dump** (left as-is):
- sharp-eyes-light-fingers-abhuman-auxiliaries

## black-templars

**keyword_restrictions — authored kept, REVIEW:**
- zealous-vanguard-companions-of-vehemence (differs): authored [Black Templars] vs dump-union [Adeptus Astartes]
- imperialis-of-the-eternal-crusade-vindication-task-force (differs): authored [Black Templars] vs dump-union [Ancient]
- consecrating-aura-vindication-task-force (differs): authored [Black Templars] vs dump-union [Adeptus Astartes]
- orb-of-the-emperors-aegis-vindication-task-force (differs): authored [Black Templars] vs dump-union [Adeptus Astartes]
- warden-of-honour-vindication-task-force (differs): authored [Black Templars] vs dump-union [Crusade Ancient]
- benediction-of-fury-wrathful-procession (differs): authored [Black Templars] vs dump-union [Chaplain]
- adaptable-executioner-wrathful-procession (differs): authored [Black Templars] vs dump-union [Black Templars, Execrator]
- fervent-exemplars-upgrade-marshals-household (differs): authored [Black Templars] vs dump-union [Black Templars, Sword Brethren Squad]
- inheritors-of-sigismund-upgrade-marshals-household (differs): authored [Black Templars] vs dump-union [Black Templars, Sword Brethren Squad]
- guiding-omens-the-living-miracle (differs): authored [Black Templars] vs dump-union [Black Templars, Emperor’s Champion]
- rites-of-war-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- iron-resolve-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- adept-of-the-codex-gladius-task-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- fury-of-the-storm-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- hunters-instincts-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- celerity-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- prescience-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- obfuscation-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- temporal-corridor-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- fusillade-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- the-blade-driven-deep-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- execute-and-redeploy-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- shadow-war-veteran-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- indomitable-fury-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- fleet-commander-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- champion-of-humanity-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Tacticus]
- war-tempered-artifice-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- target-augury-web-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- adept-of-the-omnissiah-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- bellicose-weapon-spirits-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- raptorial-cogitator-core-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- shroud-field-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- death-in-the-dark-upgrade-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Infantry, Phobos]
- honour-indefatigable-ceramite-sentinels (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- redoubtable-machine-spirit-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- gunnery-honours-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- firestorm-coordinators-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- astartes-tank-ace-aura-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- divine-protection-vow-sworn-of-vedrenn (differs): authored [Sword Brethren Squad, Vow-Sworn of Vedrenn] vs dump-union [Vow-Sworn Sword Brethren Squad]

**Repo enhancements absent from dump** (left as-is):
- oathbound-examplar-companions-of-vehemence

## blood-angels

**keyword_restrictions — authored kept, REVIEW:**
- sanguinius-grace-the-lost-brethren (differs): authored [Blood Angels] vs dump-union [Death Company]
- blood-shard-the-lost-brethren (differs): authored [Blood Angels] vs dump-union [Death Company]
- to-slay-the-warmaster-the-lost-brethren (differs): authored [Blood Angels] vs dump-union [Death Company]
- vengeful-onslaught-the-lost-brethren (differs): authored [Blood Angels] vs dump-union [Death Company]
- artisan-of-war-the-angelic-host (differs): authored [Blood Angels] vs dump-union [Adeptus Astartes, Jump Pack]
- visage-of-death-the-angelic-host (differs): authored [Blood Angels] vs dump-union [Adeptus Astartes, Jump Pack]
- archangels-shard-the-angelic-host (differs): authored [Blood Angels] vs dump-union [Adeptus Astartes, Jump Pack]
- gleaming-pinions-the-angelic-host (differs): authored [Blood Angels] vs dump-union [Adeptus Astartes, Jump Pack]
- prescient-flash-angelic-inheritors (differs): authored [Blood Angels] vs dump-union [Adeptus Astartes]
- troubling-visions-angelic-inheritors (differs): authored [Blood Angels] vs dump-union [Adeptus Astartes]
- blazing-icon-angelic-inheritors (differs): authored [Blood Angels] vs dump-union [Adeptus Astartes, Infantry]
- ordained-sacrifice-angelic-inheritors (differs): authored [Blood Angels] vs dump-union [Adeptus Astartes]
- carmine-reliquary-rage-cursed-onslaught (differs): authored [Blood Angels] vs dump-union [Chaplain]
- master-of-the-red-thirst-rage-cursed-onslaught (differs): authored [Blood Angels] vs dump-union [Adeptus Astartes]
- sanguinary-tear-aura-rage-cursed-onslaught (differs): authored [Blood Angels] vs dump-union [Adeptus Astartes]
- angels-fang-rage-cursed-onslaught (differs): authored [Blood Angels] vs dump-union [Adeptus Astartes]
- angelic-executioner-encarmine-speartip (differs): authored [Blood Angels] vs dump-union [Adeptus Astartes, Jump Pack]
- shadow-of-abomination-encarmine-speartip (differs): authored [Blood Angels] vs dump-union [Adeptus Astartes, Jump Pack]
- blood-boil-legacy-of-grace (differs): authored [Blood Angels] vs dump-union [Adeptus Astartes, Psyker]
- aureole-of-the-angel-legacy-of-grace (differs): authored [Blood Angels] vs dump-union [Adeptus Astartes]
- instinctive-interception-wrath-of-the-doomed (differs): authored [Blood Angels] vs dump-union [Death Company]
- speed-of-the-primarch-liberator-assault-group (differs): authored [Blood Angels] vs dump-union [Adeptus Astartes]
- rage-fuelled-warrior-liberator-assault-group (differs): authored [Blood Angels] vs dump-union [Adeptus Astartes]
- icon-of-the-angel-liberator-assault-group (differs): authored [Blood Angels] vs dump-union [Adeptus Astartes]
- gift-of-foresight-liberator-assault-group (differs): authored [Blood Angels] vs dump-union [Adeptus Astartes]
- rites-of-war-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- iron-resolve-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- adept-of-the-codex-gladius-task-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- fury-of-the-storm-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- hunters-instincts-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- celerity-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- prescience-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- obfuscation-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- temporal-corridor-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- fusillade-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- the-blade-driven-deep-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- execute-and-redeploy-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- shadow-war-veteran-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- indomitable-fury-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- fleet-commander-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- champion-of-humanity-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Tacticus]
- war-tempered-artifice-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- target-augury-web-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- adept-of-the-omnissiah-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- bellicose-weapon-spirits-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- raptorial-cogitator-core-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- shroud-field-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- death-in-the-dark-upgrade-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Infantry, Phobos]
- honour-indefatigable-ceramite-sentinels (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- redoubtable-machine-spirit-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- gunnery-honours-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- firestorm-coordinators-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- astartes-tank-ace-aura-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- overwhelming-charge-sanguinary-spearhead (differs): authored [Assault Intercessor Squad, Sanguinary Spearhead] vs dump-union [Sanguinary Spearhead Assault Intercessor Squad]

## chaos-daemons

**keyword_restrictions — authored kept, REVIEW:**
- argath-the-king-of-blades-daemonic-incursion (differs): authored [Chaos Daemons] vs dump-union [Khorne, Legiones Daemonica]
- the-everstave-daemonic-incursion (differs): authored [Chaos Daemons] vs dump-union [Legiones Daemonica, Tzeentch]
- the-endless-gift-daemonic-incursion (differs): authored [Chaos Daemons] vs dump-union [Legiones Daemonica, Nurgle]
- soulstealer-daemonic-incursion (differs): authored [Chaos Daemons] vs dump-union [Legiones Daemonica, Slaanesh]
- slaughterthirst-aura-blood-legion (differs): authored [Chaos Daemons] vs dump-union [Khorne, Legiones Daemonica]
- furys-cage-blood-legion (differs): authored [Chaos Daemons] vs dump-union [Khorne, Legiones Daemonica, Monster]
- brazenmaw-blood-legion (differs): authored [Chaos Daemons] vs dump-union [Khorne, Legiones Daemonica]
- gateway-unto-damnation-blood-legion (differs): authored [Chaos Daemons] vs dump-union [Khorne, Legiones Daemonica, Monster]
- inescapable-eye-scintillating-legion (differs): authored [Chaos Daemons] vs dump-union [Legiones Daemonica, Tzeentch]
- infernal-puppeteer-scintillating-legion (differs): authored [Chaos Daemons] vs dump-union [Legiones Daemonica, Monster, Tzeentch]
- neverblade-scintillating-legion (differs): authored [Chaos Daemons] vs dump-union [Legiones Daemonica, Monster, Tzeentch]
- improbable-shield-aura-scintillating-legion (differs): authored [Chaos Daemons] vs dump-union [Legiones Daemonica, Tzeentch]
- cankerblight-aura-plague-legion (differs): authored [Chaos Daemons] vs dump-union [Legiones Daemonica, Nurgle]
- maggot-maws-plague-legion (differs): authored [Chaos Daemons] vs dump-union [Legiones Daemonica, Nurgle]
- droning-shroud-aura-plague-legion (differs): authored [Chaos Daemons] vs dump-union [Legiones Daemonica, Monster, Nurgle]
- font-of-spores-aura-plague-legion (differs): authored [Chaos Daemons] vs dump-union [Legiones Daemonica, Monster, Nurgle]
- false-majesty-aura-legion-of-excess (differs): authored [Chaos Daemons] vs dump-union [Legiones Daemonica, Slaanesh]
- dreaming-crown-aura-legion-of-excess (differs): authored [Chaos Daemons] vs dump-union [Legiones Daemonica, Slaanesh]
- avatar-of-perfection-legion-of-excess (differs): authored [Chaos Daemons] vs dump-union [Legiones Daemonica, Monster, Slaanesh]
- soul-glutton-legion-of-excess (differs): authored [Chaos Daemons] vs dump-union [Legiones Daemonica, Monster, Slaanesh]
- leaping-shadows-shadow-legion (differs): authored [Chaos Daemons] vs dump-union [Shadow Legion]
- mantle-of-gloom-aura-shadow-legion (differs): authored [Chaos Daemons] vs dump-union [Shadow Legion]
- fade-to-darkness-shadow-legion (differs): authored [Chaos Daemons] vs dump-union [Shadow Legion]
- malice-made-manifest-shadow-legion (differs): authored [Chaos Daemons] vs dump-union [Shadow Legion]
- swollen-with-power-upgrade-lords-of-the-warp (differs): authored [Legiones Daemonica, Character] vs dump-union [Character, Legiones Daemonica]
- bane-forged-weapons-upgrade-warptide (differs): authored [Legiones Daemonica, Battleline] vs dump-union [Battleline, Legiones Daemonica]
- soul-hungry-slaughterers-upgrade-warptide (differs): authored [Legiones Daemonica, Battleline] vs dump-union [Battleline, Legiones Daemonica]

## chaos-knights

**keyword_restrictions — authored kept, REVIEW:**
- preyslayers-mantle-houndpack-lance (differs): authored [Chaos Knights] vs dump-union [War Dog]
- final-howl-aura-houndpack-lance (differs): authored [Chaos Knights] vs dump-union [War Dog]
- loping-predator-houndpack-lance (differs): authored [Chaos Knights] vs dump-union [War Dog]
- panoply-of-the-cursed-knights-houndpack-lance (differs): authored [Chaos Knights] vs dump-union [War Dog]
- pterrorshade-rookery-bastions-of-tyranny (differs): authored [Knight Tyrant] vs dump-union [Chaos Knights, Knight Tyrant]
- hate-filled-dominion-bastions-of-tyranny (differs): authored [Knight Tyrant] vs dump-union [Chaos Knights, Knight Tyrant]
- throne-tyrannicus-helhunt-lance (differs): authored [Chaos Knights] vs dump-union [Chaos Knights, Titanic]

## chaos-space-marines

**keyword_restrictions — authored kept, REVIEW:**
- warmasters-gift-veterans-of-the-long-war (differs): authored [Chaos Space Marines] vs dump-union [Chaos Lord]
- talisman-of-burning-blood-pactbound-zealots (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes, Khorne]
- eye-of-tzeentch-pactbound-zealots (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes, Tzeentch]
- eager-for-vengeance-veterans-of-the-long-war (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- eye-of-abaddon-veterans-of-the-long-war (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- orbs-of-unlife-pactbound-zealots (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes, Nurgle]
- mark-of-legend-veterans-of-the-long-war (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- intoxicating-elixir-pactbound-zealots (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes, Slaanesh]
- falsehood-deceptors (differs): authored [Chaos Space Marines] vs dump-union [Chaos Lord]
- cursed-fang-deceptors (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes, Infantry]
- shroud-of-obfuscation-deceptors (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes, Infantry]
- soul-link-deceptors (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes, Infantry]
- despots-claim-renegade-raiders (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- dread-reaver-renegade-raiders (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- mark-of-the-hound-renegade-raiders (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- tyrants-lash-renegade-raiders (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- nights-shroud-dread-talons (differs): authored [Chaos Space Marines] vs dump-union [Chaos Lord]
- willbreaker-dread-talons (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- warp-fuelled-thrusters-dread-talons (differs): authored [Chaos Space Marines] vs dump-union [Chaos Lord, Jump Pack]
- eater-of-dread-dread-talons (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- bastion-plate-fellhammer-siege-host (differs): authored [Chaos Space Marines] vs dump-union [Chaos Lord]
- warp-tracer-fellhammer-siege-host (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- ironbound-enmity-fellhammer-siege-host (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- iron-artifice-fellhammer-siege-host (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes, Infantry]
- amulet-of-tainted-vigour-chaos-cult (differs): authored [Chaos Space Marines] vs dump-union [Dark Apostle]
- invigorated-mechatendrils-soulforged-warpack (differs): authored [Chaos Space Marines] vs dump-union [Warpsmith]
- tempting-addendum-soulforged-warpack (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- forges-blessing-soulforged-warpack (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- soul-harvester-soulforged-warpack (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- surgical-precision-creations-of-bile (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- living-carapace-creations-of-bile (differs): authored [Chaos Space Marines] vs dump-union [Chaos Lord]
- helm-of-all-seeing-creations-of-bile (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes, Infantry]
- prime-test-subject-creations-of-bile (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes, Infantry]
- touched-by-the-warp-cabal-of-chaos (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- greyveil-hex-nightmare-hunt (differs): authored [Chaos Space Marines] vs dump-union [Chaos Lord]
- warp-fuelled-thrusters-nightmare-hunt (differs): authored [Chaos Space Marines] vs dump-union [Chaos Lord, Jump Pack]
- terrorglut-parasite-nightmare-hunt (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- sorrowscent-vulture-nightmare-hunt (differs): authored [Chaos Space Marines] vs dump-union [Chaos Lord, Jump Pack]
- voice-of-the-tyrant-hurons-marauders (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- raid-leader-hurons-marauders (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- dread-reputation-hurons-marauders (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- eager-for-bloodshed-hurons-marauders (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- weaponised-hatred-renegade-warband (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- eyes-of-the-hunter-renegade-warband (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- fratricidal-trophies-renegade-warband (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes, Terminator]
- empyric-symbiote-renegade-warband (differs): authored [Chaos Space Marines] vs dump-union [Heretic Astartes]
- conduit-of-chaos-cabal-of-chaos (differs): authored [Heretic Astartes, Daemon] vs dump-union [Daemon, Heretic Astartes]
- shadowcowl-talisman-murdertalon-raiders (differs): authored [Chaos Lord with Jump Pack] vs dump-union [Chaos Lord with Jump Pack, Heretic Astartes]
- pact-of-cursed-pinions-murdertalon-raiders (differs): authored [Chaos Lord with Jump Pack] vs dump-union [Chaos Lord with Jump Pack, Heretic Astartes]
- prey-on-the-weak-zarkans-daemonkin (differs): authored [Possessed, Zarkan's Daemonkin] vs dump-union [Zarkan's Daemonkin Possessed]

## crimson-fists

**keyword_restrictions — authored kept, REVIEW:**
- rites-of-war-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- iron-resolve-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- adept-of-the-codex-gladius-task-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- fury-of-the-storm-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- hunters-instincts-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- celerity-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- prescience-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- obfuscation-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- temporal-corridor-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- fusillade-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- the-blade-driven-deep-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- execute-and-redeploy-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- shadow-war-veteran-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- indomitable-fury-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- fleet-commander-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- champion-of-humanity-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Tacticus]
- war-tempered-artifice-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- target-augury-web-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- adept-of-the-omnissiah-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- bellicose-weapon-spirits-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- raptorial-cogitator-core-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- shroud-field-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- death-in-the-dark-upgrade-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Infantry, Phobos]
- honour-indefatigable-ceramite-sentinels (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- redoubtable-machine-spirit-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- gunnery-honours-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- firestorm-coordinators-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- astartes-tank-ace-aura-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]

## dark-angels

**keyword_restrictions — authored kept, REVIEW:**
- shroud-of-heroes-unforgiven-task-force (differs): authored [Dark Angels] vs dump-union [Adeptus Astartes]
- stubborn-tenacity-unforgiven-task-force (differs): authored [Dark Angels] vs dump-union [Adeptus Astartes]
- weapons-of-the-first-legion-unforgiven-task-force (differs): authored [Dark Angels] vs dump-union [Adeptus Astartes]
- champion-of-the-deathwing-inner-circle-task-force (differs): authored [Dark Angels] vs dump-union [Deathwing]
- eye-of-the-unseen-inner-circle-task-force (differs): authored [Dark Angels] vs dump-union [Deathwing]
- singular-will-inner-circle-task-force (differs): authored [Dark Angels] vs dump-union [Deathwing]
- deathwing-assault-inner-circle-task-force (differs): authored [Dark Angels] vs dump-union [Deathwing]
- calibanite-armaments-lions-blade-task-force (differs): authored [Dark Angels] vs dump-union [Adeptus Astartes]
- lord-of-the-hunt-lions-blade-task-force (differs): authored [Dark Angels] vs dump-union [Ravenwing]
- fulgus-magna-lions-blade-task-force (differs): authored [Dark Angels] vs dump-union [Deathwing]
- tempered-in-battle-aura-wrath-of-the-rock (differs): authored [Dark Angels] vs dump-union [Adeptus Astartes]
- ancient-weapons-wrath-of-the-rock (differs): authored [Dark Angels] vs dump-union [Adeptus Astartes]
- lord-of-the-ravenwing-wrath-of-the-rock (differs): authored [Dark Angels] vs dump-union [Ravenwing]
- petition-of-stability-upgrade-dark-age-arsenal (differs): authored [Dark Angels] vs dump-union [Adeptus Astartes]
- entreaty-of-perpetual-ardour-upgrade-dark-age-arsenal (differs): authored [Dark Angels] vs dump-union [Adeptus Astartes, Hellblaster Squad]
- thundercowl-turbines-upgrade-darkflight-pursuit (differs): authored [Dark Angels] vs dump-union [Fly, Ravenwing]
- nightforged-battery-upgrade-darkflight-pursuit (differs): authored [Dark Angels] vs dump-union [Dark Angels, Land Speeder Vengeance]
- limitless-zeal-interrogation-conclave (differs): authored [Dark Angels] vs dump-union [Chaplain]
- inescapable-interrogation-interrogation-conclave (differs): authored [Dark Angels] vs dump-union [Chaplain]
- master-crafted-weapon-company-of-hunters (differs): authored [Dark Angels] vs dump-union [Ravenwing]
- mounted-strategist-company-of-hunters (differs): authored [Dark Angels] vs dump-union [Ravenwing]
- master-of-manoeuvre-company-of-hunters (differs): authored [Dark Angels] vs dump-union [Ravenwing]
- recon-hunter-company-of-hunters (differs): authored [Dark Angels] vs dump-union [Ravenwing]
- rites-of-war-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- iron-resolve-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- adept-of-the-codex-gladius-task-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- fury-of-the-storm-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- hunters-instincts-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- celerity-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- prescience-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- obfuscation-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- temporal-corridor-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- fusillade-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- the-blade-driven-deep-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- execute-and-redeploy-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- shadow-war-veteran-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- indomitable-fury-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- fleet-commander-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- champion-of-humanity-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Tacticus]
- war-tempered-artifice-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- target-augury-web-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- adept-of-the-omnissiah-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- bellicose-weapon-spirits-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- raptorial-cogitator-core-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- shroud-field-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- death-in-the-dark-upgrade-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Infantry, Phobos]
- honour-indefatigable-ceramite-sentinels (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- redoubtable-machine-spirit-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- gunnery-honours-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- firestorm-coordinators-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- astartes-tank-ace-aura-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- dutiful-defenders-the-vengeful-brethren (differs): authored [Bladeguard Veteran Squad, Vengeful Brethren] vs dump-union [Vengeful Brethren Bladeguard Veteran Squad]
- supreme-combatant-the-vengeful-brethren (differs): authored [Gravis, Vengeful Brethren] vs dump-union [Captain, Gravis, Vengeful Brethren]

## death-guard

**keyword_restrictions — authored kept, REVIEW:**
- bilemaw-blight-mortarions-hammer (differs): authored [Death Guard] vs dump-union [Malignant Plaguecaster]
- insectile-murmuration-upgrade-flyblown-host (differs): authored [Death Guard] vs dump-union [Death Guard, Plague Marines]
- rejuvenating-swarm-paragons-of-putrescence (differs): authored [Death Guard] vs dump-union [Death Guard, Infantry]
- plagueveil-upgrade-flyblown-host (differs): authored [Death Guard] vs dump-union [Death Guard, Plague Marines]
- tendrilous-emissions-mortarions-hammer (differs): authored [Death Guard] vs dump-union [Lord of Virulence]
- final-ingredient-champions-of-contagion (differs): authored [Death Guard] vs dump-union [Biologus Putrifier]
- visions-of-virulence-champions-of-contagion (differs): authored [Death Guard] vs dump-union [Malignant Plaguecaster]
- needle-of-nurgle-champions-of-contagion (differs): authored [Death Guard] vs dump-union [Plague Surgeon]
- cornucophagus-champions-of-contagion (differs): authored [Death Guard] vs dump-union [Lord of Poxes]
- entropic-knell-tallyband-summoners (differs): authored [Death Guard] vs dump-union [Great Unclean One]
- tome-of-bounteous-blessings-tallyband-summoners (differs): authored [Death Guard] vs dump-union [Malignant Plaguecaster]
- witherbone-pipes-shamblerot-vectorium (differs): authored [Death Guard] vs dump-union [Noxious Blightbringer]
- sorrowsyphon-shamblerot-vectorium (differs): authored [Death Guard] vs dump-union [Malignant Plaguecaster]
- face-of-death-death-lords-chosen (differs): authored [Death Guard] vs dump-union [Terminator]
- vile-vigour-death-lords-chosen (differs): authored [Death Guard] vs dump-union [Terminator]
- warprot-talisman-death-lords-chosen (differs): authored [Death Guard] vs dump-union [Terminator]
- helm-of-the-fly-king-death-lords-chosen (differs): authored [Death Guard] vs dump-union [Terminator]
- parasitic-woe-reaper-upgrade-contagion-engines (differs): authored [Contagion Engine] vs dump-union [Contagion Engines]

## deathwatch

**keyword_restrictions — authored kept, REVIEW:**
- thief-of-secrets-black-spear-task-force (differs): authored [Deathwatch] vs dump-union [Adeptus Astartes]
- rites-of-war-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- iron-resolve-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- adept-of-the-codex-gladius-task-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- fury-of-the-storm-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- hunters-instincts-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- celerity-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- prescience-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- obfuscation-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- temporal-corridor-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- fusillade-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- the-blade-driven-deep-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- execute-and-redeploy-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- shadow-war-veteran-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- indomitable-fury-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- fleet-commander-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- champion-of-humanity-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Tacticus]
- war-tempered-artifice-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- target-augury-web-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- adept-of-the-omnissiah-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- bellicose-weapon-spirits-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- raptorial-cogitator-core-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- shroud-field-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- death-in-the-dark-upgrade-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Infantry, Phobos]
- honour-indefatigable-ceramite-sentinels (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- redoubtable-machine-spirit-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- gunnery-honours-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- firestorm-coordinators-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- astartes-tank-ace-aura-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]

## drukhari

**keyword_restrictions — authored kept, REVIEW:**
- labyrinthine-cunning-realspace-raiders (differs): authored [Drukhari] vs dump-union [Archon]
- eye-of-spite-realspace-raiders (differs): authored [Drukhari] vs dump-union [Succubus]
- crucible-of-malediction-realspace-raiders (differs): authored [Drukhari] vs dump-union [Haemonculus]
- reapers-cowl-reapers-wager (differs): authored [Drukhari] vs dump-union [Harlequins]
- pharmacophex-spectacle-of-spite (differs): authored [Drukhari] vs dump-union [Succubus]
- chronoshard-spectacle-of-spite (differs): authored [Drukhari] vs dump-union [Succubus]
- periapt-of-torments-spectacle-of-spite (differs): authored [Drukhari] vs dump-union [Succubus]
- morghennas-curse-spectacle-of-spite (differs): authored [Drukhari] vs dump-union [Succubus]
- master-regenesist-covenite-coterie (differs): authored [Drukhari] vs dump-union [Haemonculus]
- master-nemesine-covenite-coterie (differs): authored [Drukhari] vs dump-union [Haemonculus]
- master-artisan-covenite-coterie (differs): authored [Drukhari] vs dump-union [Haemonculus]
- master-repugnomancer-aura-covenite-coterie (differs): authored [Drukhari] vs dump-union [Haemonculus]
- leechbite-plate-kabalite-cartel (differs): authored [Drukhari] vs dump-union [Archon]
- webway-awl-kabalite-cartel (differs): authored [Drukhari] vs dump-union [Archon]
- informant-network-kabalite-cartel (differs): authored [Drukhari] vs dump-union [Archon]
- towering-arrogance-kabalite-cartel (differs): authored [Drukhari] vs dump-union [Archon]
- periapt-of-torments-exhibition-of-slaughter (differs): authored [Drukhari] vs dump-union [Drukhari, Succubus]
- hyperstimm-trafficker-exhibition-of-slaughter (differs): authored [Drukhari] vs dump-union [Drukhari, Succubus]
- towering-arrogance-kabalite-agonysts (differs): authored [Drukhari] vs dump-union [Archon, Drukhari]
- contempt-for-rivals-kabalite-agonysts (differs): authored [Drukhari] vs dump-union [Archon, Drukhari]
- gnarlskin-experimentor-tools-of-torment (differs): authored [Drukhari] vs dump-union [Drukhari, Haemonculus]
- superior-soulcraft-coven-of-agonies (differs): authored [Coven of Agonies, Cronos] vs dump-union [Coven of Agonies Cronos]

## emperors-children

**keyword_restrictions — authored kept, REVIEW:**
- rise-to-the-challenge-peerless-bladesmen (differs): authored [Emperor’s Children] vs dump-union [Emperor’s Children, Infantry]
- sublime-prescience-rapid-evisceration (differs): authored [Emperor’s Children] vs dump-union [Emperor’s Children, Infantry]
- spearhead-striker-rapid-evisceration (differs): authored [Emperor’s Children] vs dump-union [Emperor’s Children, Infantry]
- accomplished-tactician-rapid-evisceration (differs): authored [Emperor’s Children] vs dump-union [Emperor’s Children, Infantry]
- heretek-adept-rapid-evisceration (differs): authored [Emperor’s Children] vs dump-union [Emperor’s Children, Infantry]
- dark-blessings-carnival-of-excess (differs): authored [Emperor’s Children] vs dump-union [Emperor’s Children, Infantry]
- exalted-patron-court-of-the-phoenician (differs): authored [Emperor’s Children] vs dump-union [Lord Exultant]
- spiritsliver-court-of-the-phoenician (differs): authored [Emperor’s Children] vs dump-union [Daemon Prince, Emperor’s Children]
- cacophonic-accompaniment-elegant-brutes (differs): authored [Emperor's Children] vs dump-union [Emperor’s Children, Lord Kakophonist]
- frenzied-ferocity-upgrade-elegant-brutes (differs): authored [Emperor's Children, Terminator Squad] vs dump-union [Emperor’s Children, Terminator Squad]
- euphoric-crown-frenzied-host (differs): authored [Emperor's Children] vs dump-union [Emperor’s Children, Lord Exultant]
- howling-plate-frenzied-host (differs): authored [Emperor's Children] vs dump-union [Emperor’s Children, Lord Exultant]
- eager-patrons-upgrade-spectacle-of-slaughter (differs): authored [Emperor's Children, Flawless Blades] vs dump-union [Emperor’s Children, Flawless Blades]
- beguiling-grotesquerie-upgrade-spectacle-of-slaughter (differs): authored [Emperor's Children, Flawless Blades] vs dump-union [Emperor’s Children, Flawless Blades]
- martial-perfection-callous-blades (differs): authored [Callous Blades, Infractors] vs dump-union [Callous Blades Infractors]

**Repo enhancements absent from dump** (left as-is):
- pledge-to-eternal-servitude-coterie-of-the-conceited

## genestealer-cults

**keyword_restrictions — authored kept, REVIEW:**
- serpentine-tactics-outlander-claw (differs): authored [Genestealer Cults] vs dump-union [Genestealer Cults, Mounted]
- starfall-shells-outlander-claw (differs): authored [Genestealer Cults] vs dump-union [Genestealer Cults, Mounted]
- martial-espionage-brood-brothers-auxilia (differs): authored [Genestealer Cults] vs dump-union [Genestealer Cults, Infantry]
- adaptive-reprisal-brood-brothers-auxilia (differs): authored [Genestealer Cults] vs dump-union [Genestealer Cults, Infantry]
- the-hero-returned-brood-brothers-auxilia (differs): authored [Genestealer Cults] vs dump-union [Genestealer Cults, Infantry]
- fire-point-commander-brood-brothers-auxilia (differs): authored [Genestealer Cults] vs dump-union [Genestealer Cults, Infantry]
- synaptic-auger-final-day (differs): authored [Genestealer Cults] vs dump-union [Tyranids]
- vanguard-tyrant-final-day (differs): authored [Genestealer Cults] vs dump-union [Winged Hive Tyrant]
- mark-of-the-star-children-upgrade-purestrain-broodswarm (differs): authored [Genestealer Cults] vs dump-union [Genestealer Cults, Purestrain Genestealers]
- talons-of-the-sire-purestrain-broodswarm (differs): authored [Genestealer Cults] vs dump-union [Genestealer Cults, Patriarch]
- devious-disguises-upgrade-xenocult-masses (differs): authored [Genestealer Cults] vs dump-union [Genestealer Cults, Neophyte Hybrids]
- heavy-munitions-claw-of-ascension (differs): authored [Achilles Ridgerunners, Claw of Ascension] vs dump-union [Claw of Ascension Achilles Ridgerunner]

## grey-knights

**keyword_restrictions — authored kept, REVIEW:**
- driven-by-duty-sanctic-spearhead (differs): authored [Grey Knights] vs dump-union [Grey Knights, Walker]
- quickening-foci-sanctic-spearhead (differs): authored [Grey Knights] vs dump-union [Grey Knights, Infantry]
- spiritus-machina-sanctic-spearhead (differs): authored [Grey Knights] vs dump-union [Grey Knights, Infantry]
- sanctic-reaper-hallowed-conclave (differs): authored [Grey Knights] vs dump-union [Grey Knights, Terminator]
- nemesis-rounds-hallowed-conclave (differs): authored [Grey Knights] vs dump-union [Grey Knights, Terminator]
- ephemeral-tome-banishers (differs): authored [Grey Knights] vs dump-union [Grey Knights, Infantry]
- radiant-champion-warpbane-task-force (differs): authored [Grey Knights] vs dump-union [Grey Knights, Infantry]
- phial-of-the-abyss-warpbane-task-force (differs): authored [Grey Knights] vs dump-union [Grey Knights, Infantry]
- psychic-celerity-argent-assault (differs): authored [Grey Knights] vs dump-union [Terminator]
- vigilance-of-titan-argent-assault (differs): authored [Grey Knights] vs dump-union [Terminator]
- precognicient-volleys-upgrade-fires-of-purgation (differs): authored [Grey Knights] vs dump-union [Grey Knights, Purgation Squad]
- boons-of-deimos-upgrade-fires-of-purgation (differs): authored [Grey Knights] vs dump-union [Grey Knights, Purgation Squad]
- predestined-coordinates-upgrade-immaterial-interdiction (differs): authored [Grey Knights] vs dump-union [Grey Knights, Interceptor Squad]
- astral-overlap-upgrade-immaterial-interdiction (differs): authored [Grey Knights] vs dump-union [Grey Knights, Interceptor Squad]

**Repo enhancements absent from dump** (left as-is):
- eye-of-the-augurim-hallowed-conclave

## imperial-fists

**keyword_restrictions — authored kept, REVIEW:**
- champion-of-the-feast-emperors-shield (differs): authored [Imperial Fists] vs dump-union [Adeptus Astartes]
- disciple-of-rhetoricus-emperors-shield (differs): authored [Imperial Fists] vs dump-union [Adeptus Astartes, Terminator]
- indomitable-champion-emperors-shield (differs): authored [Imperial Fists] vs dump-union [Adeptus Astartes, Terminator]
- malodraxian-standard-emperors-shield (differs): authored [Imperial Fists] vs dump-union [Adeptus Astartes, Ancient]
- rites-of-war-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- iron-resolve-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- adept-of-the-codex-gladius-task-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- fury-of-the-storm-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- hunters-instincts-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- celerity-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- prescience-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- obfuscation-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- temporal-corridor-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- fusillade-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- the-blade-driven-deep-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- execute-and-redeploy-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- shadow-war-veteran-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- indomitable-fury-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- fleet-commander-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- champion-of-humanity-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Tacticus]
- war-tempered-artifice-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- target-augury-web-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- adept-of-the-omnissiah-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- bellicose-weapon-spirits-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- raptorial-cogitator-core-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- shroud-field-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- death-in-the-dark-upgrade-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Infantry, Phobos]
- honour-indefatigable-ceramite-sentinels (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- redoubtable-machine-spirit-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- gunnery-honours-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- firestorm-coordinators-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- astartes-tank-ace-aura-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]

## imperial-knights

**keyword_restrictions — authored kept, REVIEW:**
- magos-questoris-questor-forgepact (differs): authored [Imperial Knights] vs dump-union [Tech-Priest]
- blessed-plate-dominus-foebreakers (differs): authored [Imperial Knights] vs dump-union [Dominus, Imperial Knights]
- archeotech-autoloaders-dominus-foebreakers (differs): authored [Imperial Knights] vs dump-union [Dominus, Imperial Knights]
- gyro-optimised-actuators-upgrade-throne-bonded-outriders (differs): authored [Imperial Knights, Armiger] vs dump-union [Armiger]
- ancestral-overbleed-upgrade-throne-bonded-outriders (differs): authored [Imperial Knights, Armiger] vs dump-union [Armiger]

**Repo enhancements absent from dump** (left as-is):
- omnissian-champion-questor-forgepact
- vocifer-magnificat-aura-questor-forgepact

## iron-hands

**keyword_restrictions — authored kept, REVIEW:**
- spiritus-ferrum-hammer-of-avernii (differs): authored [Iron Hands] vs dump-union [Adeptus Astartes]
- medusan-roar-aura-hammer-of-avernii (differs): authored [Iron Hands] vs dump-union [Adeptus Astartes]
- iron-laurel-hammer-of-avernii (differs): authored [Iron Hands] vs dump-union [Adeptus Astartes]
- steel-font-hammer-of-avernii (differs): authored [Iron Hands] vs dump-union [Adeptus Astartes, Terminator]
- rites-of-war-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- iron-resolve-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- adept-of-the-codex-gladius-task-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- fury-of-the-storm-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- hunters-instincts-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- celerity-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- prescience-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- obfuscation-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- temporal-corridor-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- fusillade-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- the-blade-driven-deep-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- execute-and-redeploy-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- shadow-war-veteran-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- indomitable-fury-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- fleet-commander-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- champion-of-humanity-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Tacticus]
- war-tempered-artifice-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- target-augury-web-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- adept-of-the-omnissiah-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- bellicose-weapon-spirits-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- raptorial-cogitator-core-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- shroud-field-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- death-in-the-dark-upgrade-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Infantry, Phobos]
- honour-indefatigable-ceramite-sentinels (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- redoubtable-machine-spirit-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- gunnery-honours-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- firestorm-coordinators-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- astartes-tank-ace-aura-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]

## leagues-of-votann

**keyword_restrictions — authored kept, REVIEW:**
- quake-multigenerator-hearthband (differs): authored [Leagues of Votann] vs dump-union [Kâhl, Leagues of Votann]
- high-kahl-hearthband (differs): authored [Leagues of Votann] vs dump-union [Kâhl, Leagues of Votann]
- tactical-alchemy-brandfast-oathband (differs): authored [Leagues of Votann] vs dump-union [Kâhl]
- precursive-judgement-brandfast-oathband (differs): authored [Leagues of Votann] vs dump-union [Kâhl]
- signature-restoration-brandfast-oathband (differs): authored [Leagues of Votann] vs dump-union [Brôkhyr]
- mantle-of-elders-hearthfyre-arsenal (differs): authored [Leagues of Votann] vs dump-union [Memnyr Strategist]
- graviton-vault-hearthfyre-arsenal (differs): authored [Leagues of Votann] vs dump-union [Brôkhyr]
- mercenary-prospector-mercenary-oathband (differs): authored [Leagues of Votann] vs dump-union [Kâhl]
- metaphysical-brokerage-mercenary-oathband (differs): authored [Leagues of Votann] vs dump-union [Memnyr Strategist]
- saturation-rounds-upgrade-armoured-trailblazers (differs): authored [Leagues of Votann] vs dump-union [Leagues of Votann, Sagitaur]
- optimised-attack-lines-upgrade-armoured-trailblazers (differs): authored [Leagues of Votann] vs dump-union [Leagues of Votann, Sagitaur]
- pan-spectral-lockons-upgrade-farseekers (differs): authored [Leagues of Votann] vs dump-union [Pioneers]
- ironskein-hearthguard-covenant (differs): authored [Leagues of Votann] vs dump-union [Kâhl]
- brokhyr-barrage-bane-slayers-bulwark (differs): authored [Bane-Slayer's Bulwark, Thunderkyn] vs dump-union [Bane Slayer's Bulwark Brokhyr Thunderkyn]

**Repo enhancements absent from dump** (left as-is):
- farstryder-node-hearthfyre-arsenal

## necrons

**keyword_restrictions — authored kept, REVIEW:**
- soulless-reaper-annihilation-legion (differs): authored [Necrons] vs dump-union [Destroyer Cult]
- eldritch-nightmare-annihilation-legion (differs): authored [Necrons] vs dump-union [Destroyer Cult]
- dimensional-sanctum-canoptek-court (differs): authored [Necrons] vs dump-union [Cryptek]
- hyperphasic-fulcrum-canoptek-court (differs): authored [Necrons] vs dump-union [Cryptek]
- autodivinator-canoptek-court (differs): authored [Necrons] vs dump-union [Cryptek]
- metalodermal-tesla-weave-canoptek-court (differs): authored [Necrons] vs dump-union [Cryptek]
- honourable-combatant-obeisance-phalanx (differs): authored [Necrons] vs dump-union [Overlord]
- unflinching-will-obeisance-phalanx (differs): authored [Necrons] vs dump-union [Overlord]
- warrior-noble-obeisance-phalanx (differs): authored [Necrons] vs dump-union [Overlord]
- eternal-conqueror-obeisance-phalanx (differs): authored [Necrons] vs dump-union [Overlord]
- murdermind-cursed-legion (differs): authored [Necrons] vs dump-union [Cryptek]
- cursed-circlet-cursed-legion (differs): authored [Necrons] vs dump-union [Destroyer Cult]
- atomic-disintegrators-cryptek-conclave (differs): authored [Necrons] vs dump-union [Cryptek]
- gravitic-bolas-cryptek-conclave (differs): authored [Necrons] vs dump-union [Cryptek]
- enlivened-sentinels-upgrade-hand-of-the-dynasty (differs): authored [Necrons] vs dump-union [Necron Warriors, Necrons]
- tools-of-dominion-upgrade-hand-of-the-dynasty (differs): authored [Necrons] vs dump-union [Immortals, Necrons]
- recursive-reanimation-upgrade-skyshroud-spearhead (differs): authored [Necrons] vs dump-union [Necrons, Tomb Blades]
- deepening-madness-upgrade-skyshroud-spearhead (differs): authored [Necrons] vs dump-union [Destroyer Cult, Mounted]
- metalline-might-amonhotekhs-guard (differs): authored [Amonhotekh's Guard, Overlord] vs dump-union [Overlord Amonhotekh]
- unblemished-legions-amonhotekhs-guard (differs): authored [Amonhotekh's Guard, Necron Warriors] vs dump-union [Amonhotekh's Guard Necron Warriors]

**Repo enhancements absent from dump** (left as-is):
- mask-of-the-nekrosor-cursed-legion
- mortality-shroud-aura-the-phaerons-armoury

## orks

**keyword_restrictions — authored kept, REVIEW:**
- glory-hog-da-big-hunt (differs): authored [Orks] vs dump-union [Beastboss on Squigosaur]
- skrag-every-stash-da-big-hunt (differs): authored [Orks] vs dump-union [Beast Snagga]
- proper-killy-da-big-hunt (differs): authored [Orks] vs dump-union [Beast Snagga]
- surly-as-a-squiggoth-da-big-hunt (differs): authored [Orks] vs dump-union [Beastboss on Squigosaur]
- wazblasta-kult-of-speed (differs): authored [Orks] vs dump-union [Deffkilla Wartrike]
- fasta-than-yooz-kult-of-speed (differs): authored [Orks] vs dump-union [Infantry, Orks]
- squig-hide-tyres-kult-of-speed (differs): authored [Orks] vs dump-union [Deffkilla Wartrike]
- smoky-gubbinz-dread-mob (differs): authored [Orks] vs dump-union [Mek]
- supa-glowy-fing-dread-mob (differs): authored [Orks] vs dump-union [Mek]
- press-it-fasta-dread-mob (differs): authored [Orks] vs dump-union [Mek]
- gitfinder-gogglez-dread-mob (differs): authored [Orks] vs dump-union [Mek]
- ferocious-show-off-green-tide (differs): authored [Orks] vs dump-union [Infantry, Orks]
- brutal-but-kunnin-green-tide (differs): authored [Orks] vs dump-union [Infantry, Orks]
- bloodthirsty-belligerence-green-tide (differs): authored [Orks] vs dump-union [Infantry, Orks]
- raucous-warcaller-green-tide (differs): authored [Orks] vs dump-union [Infantry, Orks]
- tellyporta-bully-boyz (differs): authored [Orks] vs dump-union [Warboss in Mega Armour]
- big-gob-bully-boyz (differs): authored [Orks] vs dump-union [Infantry, Warboss]
- da-biggest-boss-bully-boyz (differs): authored [Orks] vs dump-union [Infantry, Warboss]
- eadstompa-bully-boyz (differs): authored [Orks] vs dump-union [Infantry, Warboss]
- da-gobshot-thunderbuss-more-dakka (differs): authored [Orks] vs dump-union [Infantry, Orks]
- dead-shiny-shootas-upgrade-more-dakka (differs): authored [Orks] vs dump-union [Infantry, Orks]
- da-kaptin-freebooter-krew (differs): authored [Orks] vs dump-union [Warboss]
- boarding-ramps-upgrade-rollin-deff (differs): authored [Orks] vs dump-union [Wagon]
- targetin-gizmos-upgrade-rollin-deff (differs): authored [Orks] vs dump-union [Wagon]
- runnin-boots-blitz-brigade (differs): authored [Orks] vs dump-union [Infantry, Orks]
- supercharged-squig-oil-blitz-brigade (differs): authored [Orks] vs dump-union [Mek]
- tuff-git-blitz-brigade (differs): authored [Orks] vs dump-union [Infantry, Orks]
- rallying-war-cry-ardmob (differs): authored ['Ardmob, Warboss] vs dump-union [’Ardmob Warboss, Orks]

**Repo enhancements absent from dump** (left as-is):
- skwad-leader-taktikal-brigade
- mek-kaptin-taktikal-brigade
- gob-boomer-taktikal-brigade
- targetin-squigs-more-dakka
- zog-off-and-eat-dakka-more-dakka
- dead-shiny-shootas-rollin-deff
- da-gobshot-thunderbuss-rollin-deff

## raven-guard

**keyword_restrictions — authored kept, REVIEW:**
- blackwing-shroud-shadowmark-talon (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- coronal-susurrant-shadowmark-talon (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- rites-of-war-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- iron-resolve-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- adept-of-the-codex-gladius-task-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- fury-of-the-storm-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- celerity-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- prescience-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- obfuscation-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- temporal-corridor-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- fusillade-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- the-blade-driven-deep-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- execute-and-redeploy-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- shadow-war-veteran-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- indomitable-fury-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- fleet-commander-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- champion-of-humanity-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Tacticus]
- war-tempered-artifice-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- target-augury-web-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- adept-of-the-omnissiah-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- bellicose-weapon-spirits-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- raptorial-cogitator-core-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- shroud-field-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- death-in-the-dark-upgrade-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Infantry, Phobos]
- honour-indefatigable-ceramite-sentinels (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- redoubtable-machine-spirit-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- gunnery-honours-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- firestorm-coordinators-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- astartes-tank-ace-aura-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]

**Repo enhancements absent from dump** (left as-is):
- unparalleled-tactician-shadowmark-talon

## salamanders

**keyword_restrictions — authored kept, REVIEW:**
- immolator-forgefathers-seekers (differs): authored [Salamanders] vs dump-union [Adeptus Astartes]
- war-tempered-artifice-forgefathers-seekers (differs): authored [Salamanders] vs dump-union [Adeptus Astartes, Infantry]
- forged-in-battle-forgefathers-seekers (differs): authored [Salamanders] vs dump-union [Adeptus Astartes]
- adamantine-mantle-forgefathers-seekers (differs): authored [Salamanders] vs dump-union [Adeptus Astartes]
- rites-of-war-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- iron-resolve-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- adept-of-the-codex-gladius-task-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- fury-of-the-storm-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- hunters-instincts-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- celerity-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- prescience-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- obfuscation-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- temporal-corridor-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- fusillade-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- the-blade-driven-deep-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- execute-and-redeploy-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- shadow-war-veteran-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- indomitable-fury-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- fleet-commander-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- champion-of-humanity-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Tacticus]
- target-augury-web-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- adept-of-the-omnissiah-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- bellicose-weapon-spirits-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- raptorial-cogitator-core-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- shroud-field-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- death-in-the-dark-upgrade-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Infantry, Phobos]
- honour-indefatigable-ceramite-sentinels (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- redoubtable-machine-spirit-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- gunnery-honours-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- firestorm-coordinators-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- astartes-tank-ace-aura-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]

## space-wolves

**keyword_restrictions — authored kept, REVIEW:**
- fenrisian-grit-saga-of-the-hunter (differs): authored [Space Wolves] vs dump-union [Adeptus Astartes]
- feral-rage-saga-of-the-hunter (differs): authored [Space Wolves] vs dump-union [Adeptus Astartes]
- skjald-saga-of-the-bold (differs): authored [Space Wolves] vs dump-union [Adeptus Astartes]
- thunderwolfs-fortitude-saga-of-the-bold (differs): authored [Space Wolves] vs dump-union [Adeptus Astartes]
- hunters-guile-saga-of-the-beastslayer (differs): authored [Space Wolves] vs dump-union [Adeptus Astartes]
- helm-of-the-beastslayer-saga-of-the-beastslayer (differs): authored [Space Wolves] vs dump-union [Adeptus Astartes]
- a-giant-amongst-giants-champions-of-fenris (differs): authored [Space Wolves] vs dump-union [Adeptus Astartes, Infantry]
- preyslayer-champions-of-fenris (differs): authored [Space Wolves] vs dump-union [Adeptus Astartes, Infantry]
- grimnars-mark-saga-of-the-great-wolf (differs): authored [Space Wolves] vs dump-union [Adeptus Astartes, Captain, Terminator]
- howlmaw-saga-of-the-great-wolf (differs): authored [Space Wolves] vs dump-union [Wolf Priest]
- chariots-of-the-storm-saga-of-the-great-wolf (differs): authored [Space Wolves] vs dump-union [Adeptus Astartes]
- skjalds-foretelling-saga-of-the-great-wolf (differs): authored [Space Wolves] vs dump-union [Battle Leader, Wolf Guard]
- thirst-for-glory-upgrade-legends-of-saga-and-song (differs): authored [Space Wolves] vs dump-union [Adeptus Astartes, Terminator]
- fierce-example-upgrade-legends-of-saga-and-song (differs): authored [Space Wolves] vs dump-union [Space Wolves, Wolf Guard Terminators]
- eye-of-the-hunter-veterans-of-the-fang (differs): authored [Space Wolves] vs dump-union [Space Wolves, Wolf Guard Battle Leader]
- weaver-of-sagas-veterans-of-the-fang (differs): authored [Space Wolves] vs dump-union [Space Wolves, Wolf Priest]
- rites-of-war-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- iron-resolve-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- adept-of-the-codex-gladius-task-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- fury-of-the-storm-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- hunters-instincts-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- celerity-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- prescience-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- obfuscation-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- temporal-corridor-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- fusillade-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- the-blade-driven-deep-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- execute-and-redeploy-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- shadow-war-veteran-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- indomitable-fury-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- fleet-commander-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- champion-of-humanity-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Tacticus]
- war-tempered-artifice-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- target-augury-web-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- adept-of-the-omnissiah-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- bellicose-weapon-spirits-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- raptorial-cogitator-core-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- shroud-field-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- death-in-the-dark-upgrade-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Infantry, Phobos]
- honour-indefatigable-ceramite-sentinels (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- redoubtable-machine-spirit-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- gunnery-honours-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- firestorm-coordinators-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- astartes-tank-ace-aura-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- aggressive-response-askars-wolfpack (differs): authored [Askar's Wolfpack, Wolf Guard Terminators] vs dump-union [Askar's Wolfpack, Terminator, Wolf Guard]

**Repo enhancements absent from dump** (left as-is):
- howling-onslaught-saga-of-the-great-wolf

## tau-empire

**keyword_restrictions — authored kept, REVIEW:**
- puretide-engram-neurochip-retaliation-cadre (differs): authored [T’au Empire] vs dump-union [Battlesuit, T’au Empire]
- starflare-ignition-system-retaliation-cadre (differs): authored [T’au Empire] vs dump-union [Battlesuit, T’au Empire]
- internal-grenade-racks-retaliation-cadre (differs): authored [T’au Empire] vs dump-union [Battlesuit, T’au Empire]
- prototype-weapon-system-retaliation-cadre (differs): authored [T’au Empire] vs dump-union [Battlesuit, T’au Empire]
- kroothawk-flock-kroot-hunting-pack (differs): authored [T’au Empire] vs dump-union [Kroot]
- nomadic-hunter-kroot-hunting-pack (differs): authored [T’au Empire] vs dump-union [Trail Shaper]
- root-carved-weapons-kroot-hunting-pack (differs): authored [T’au Empire] vs dump-union [War Shaper]
- borthrod-gland-kroot-hunting-pack (differs): authored [T’au Empire] vs dump-union [Flesh Shaper]
- student-of-kauyon-auxiliary-cadre (differs): authored [T’au Empire] vs dump-union [Kroot, Shaper]
- supernova-launcher-experimental-prototype-cadre (differs): authored [T’au Empire] vs dump-union [Battlesuit]
- thermoneutronic-projector-experimental-prototype-cadre (differs): authored [T’au Empire] vs dump-union [Battlesuit]
- plasma-accelerator-rifle-experimental-prototype-cadre (differs): authored [T’au Empire] vs dump-union [Battlesuit]
- negation-emitters-upgrade-advanced-acquisition-cadre (differs): authored [T’au Empire] vs dump-union [Stealth Battlesuits, T’au Empire]
- earth-caste-modifications-sudden-dawn-cadre (differs): authored [Commander in Enforcer Battlesuit, Sudden Dawn Cadre] vs dump-union [Commander Cloudspear]
- proximity-scanners-sudden-dawn-cadre (differs): authored [Devilfish, Sudden Dawn Cadre] vs dump-union [Sudden Dawn Cadre Devilfish]

**Repo enhancements absent from dump** (left as-is):
- fanatical-convert-auxiliary-cadre
- transponder-lock-module-auxiliary-cadre
- fusion-blades-experimental-prototype-cadre

## thousand-sons

**keyword_restrictions — authored kept, REVIEW:**
- lord-of-forbidden-lore-grand-coven (differs): authored [Thousand Sons] vs dump-union [Psyker, Thousand Sons]
- incandaeum-grand-coven (differs): authored [Thousand Sons] vs dump-union [Exalted Sorcerer]
- diabolic-savant-changehost-of-deceit (differs): authored [Thousand Sons] vs dump-union [Infantry, Thousand Sons]
- tome-of-true-names-changehost-of-deceit (differs): authored [Thousand Sons] vs dump-union [Infantry, Thousand Sons]
- warpmeld-dagger-warpmeld-pact (differs): authored [Thousand Sons] vs dump-union [Tzaangor Shaman]
- diamond-of-distortion-warpmeld-pact (differs): authored [Thousand Sons] vs dump-union [Tzaangor Shaman]
- flowing-flesh-warpmeld-pact (differs): authored [Thousand Sons] vs dump-union [Tzaangor Shaman]
- stave-abominus-rubricae-phalanx (differs): authored [Thousand Sons] vs dump-union [Infantry, Thousand Sons]
- perplexing-cloak-warpforged-cabal (differs): authored [Thousand Sons] vs dump-union [Infantry, Thousand Sons]
- unravelled-fates-servants-of-change (differs): authored [Thousand Sons] vs dump-union [Thousand Sons, Tzaangor Shaman]
- thicket-of-bladed-bone-upgrade-servants-of-change (differs): authored [Spawn] vs dump-union [Chaos Spawn]

## tyranids

**keyword_restrictions — authored kept, REVIEW:**
- ominous-presence-crusher-stampede (differs): authored [Tyranids] vs dump-union [Monster, Tyranids]
- enraged-reserves-crusher-stampede (differs): authored [Tyranids] vs dump-union [Monster, Tyranids]
- null-nodules-crusher-stampede (differs): authored [Tyranids] vs dump-union [Monster, Tyranids]
- monstrous-nemesis-crusher-stampede (differs): authored [Tyranids] vs dump-union [Monster, Tyranids]
- chameleonic-vanguard-onslaught (differs): authored [Tyranids] vs dump-union [Vanguard Invader]
- stalker-vanguard-onslaught (differs): authored [Tyranids] vs dump-union [Vanguard Invader]
- power-of-the-hive-mind-synaptic-nexus (differs): authored [Tyranids] vs dump-union [Psyker, Tyranids]
- psychostatic-disruption-synaptic-nexus (differs): authored [Tyranids] vs dump-union [Synapse, Tyranids]
- synaptic-control-synaptic-nexus (differs): authored [Tyranids] vs dump-union [Synapse, Tyranids]
- the-dirgeheart-of-kharis-aura-synaptic-nexus (differs): authored [Tyranids] vs dump-union [Synapse, Tyranids]
- trygon-prime-subterranean-assault (differs): authored [Tyranids] vs dump-union [Trygon]
- cryptophotaic-camouflage-upgrade-ambush-predators (differs): authored [Tyranids] vs dump-union [Tyranids, Von Ryan’s Leapers]
- destabilising-predation-upgrade-talons-of-the-norn-queen (differs): authored [Tyranids] vs dump-union [Norn Emissary, Tyranids]
- synaptoprescience-upgrade-talons-of-the-norn-queen (differs): authored [Tyranids] vs dump-union [Norn Assimilator, Tyranids]
- psychoclastic-overload-the-vardenghast-swarm (differs): authored [Psychophage, Vardenghast Swarm] vs dump-union [Vardenghast Swarm Psychophage]

**Repo enhancements absent from dump** (left as-is):
- synaptic-lynchpin-invasion-fleet
- synaptic-tyrant-warrior-bioform-onslaught
- sensory-assimilation-warrior-bioform-onslaught

## ultramarines

**keyword_restrictions — authored kept, REVIEW:**
- rites-of-war-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- iron-resolve-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- adept-of-the-codex-gladius-task-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- fury-of-the-storm-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- hunters-instincts-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- celerity-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- prescience-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- obfuscation-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- temporal-corridor-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- fusillade-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- the-blade-driven-deep-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- execute-and-redeploy-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- shadow-war-veteran-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- indomitable-fury-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- fleet-commander-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- champion-of-humanity-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Tacticus]
- war-tempered-artifice-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- target-augury-web-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- adept-of-the-omnissiah-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- bellicose-weapon-spirits-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- raptorial-cogitator-core-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- shroud-field-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- death-in-the-dark-upgrade-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Infantry, Phobos]
- honour-indefatigable-ceramite-sentinels (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- redoubtable-machine-spirit-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- gunnery-honours-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- firestorm-coordinators-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- astartes-tank-ace-aura-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]

## white-scars

**keyword_restrictions — authored kept, REVIEW:**
- chogorian-huntmaster-spearpoint-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- rites-of-war-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- iron-resolve-1st-company-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Terminator]
- adept-of-the-codex-gladius-task-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- fury-of-the-storm-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- hunters-instincts-stormlance-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Mounted]
- celerity-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- prescience-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- obfuscation-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- temporal-corridor-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- fusillade-librarius-conclave (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Psyker]
- the-blade-driven-deep-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- execute-and-redeploy-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- shadow-war-veteran-vanguard-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- indomitable-fury-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- fleet-commander-anvil-siege-force (differs): authored [Adeptus Astartes] vs dump-union [Captain]
- champion-of-humanity-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Tacticus]
- war-tempered-artifice-firestorm-assault-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Infantry]
- target-augury-web-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- adept-of-the-omnissiah-ironstorm-spearhead (differs): authored [Adeptus Astartes] vs dump-union [Techmarine]
- bellicose-weapon-spirits-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- raptorial-cogitator-core-upgrade-fulguris-task-force (differs): authored [Adeptus Astartes] vs dump-union [Speeder]
- shroud-field-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Phobos]
- death-in-the-dark-upgrade-subversion-assets (differs): authored [Adeptus Astartes] vs dump-union [Infantry, Phobos]
- honour-indefatigable-ceramite-sentinels (differs): authored [Adeptus Astartes] vs dump-union [Gravis]
- redoubtable-machine-spirit-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- gunnery-honours-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- firestorm-coordinators-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]
- astartes-tank-ace-aura-headhunter-task-force (differs): authored [Adeptus Astartes] vs dump-union [Adeptus Astartes, Vehicle]

## world-eaters

**keyword_restrictions — authored kept, REVIEW:**
- gateways-to-glory-vessels-of-wrath (differs): authored [World Eaters] vs dump-union [Daemon Prince, World Eaters]
- chosen-of-the-blood-god-cult-of-blood (differs): authored [World Eaters] vs dump-union [Monster, World Eaters]
- butcher-lord-cult-of-blood (differs): authored [World Eaters] vs dump-union [Infantry, World Eaters]
- brazen-form-cult-of-blood (differs): authored [World Eaters] vs dump-union [Monster, World Eaters]
- disciple-of-khorne-khorne-daemonkin (differs): authored [World Eaters] vs dump-union [Lord on Juggernaut]
- malicious-vigour-possessed-slaughterband (differs): authored [World Eaters] vs dump-union [Slaughterbound]
- killing-clarity-possessed-slaughterband (differs): authored [World Eaters] vs dump-union [Daemon, World Eaters]
- frenzied-focus-possessed-slaughterband (differs): authored [World Eaters] vs dump-union [Daemon, World Eaters]
- violent-demise-possessed-slaughterband (differs): authored [World Eaters] vs dump-union [Daemon, World Eaters]
- talons-of-butchery-upgrade-brazen-engines (differs): authored [Maulerfiend] vs dump-union [Maulerfiend, World Eaters]
- murder-forged-entity-upgrade-brazen-engines (differs): authored [Vehicle] vs dump-union [Vehicle, World Eaters]
- bane-of-the-craven-frenzied-reavers (differs): authored [Frenzied Reavers, Master of Executions] vs dump-union [Frenzied Reavers Master of Executions]

## Combat-Patrol enhancements held back (1 — pass --include-combat-patrol to author)

- extra-platin-ardmob

