# MFM chapter-scope — APPLIED

Reconciles Space Marine chapter access in the shared adeptus-astartes pool
from the GW MFM dump (issue #36): collapses Black Templars exclude-and-replace
twins back to generic `faction_keywords`, and stamps `excluded_faction_keywords`
where a chapter is barred from a generic unit with no same-name replacement.

| Metric | Count |
|---|--:|
| Units matched | 172 |
| faction_keywords collapsed | 10 |
| excluded_faction_keywords set | 10 |
| Repo units with no dump datasheet | 0 |
| Dump SM datasheets with no repo unit | 22 |

## faction_keywords collapsed to generic

- gladiator-lancer: [Adeptus Astartes, Black Templars] → [Adeptus Astartes]
- terminator-squad: [Adeptus Astartes, Black Templars] → [Adeptus Astartes]
- sternguard-veteran-squad: [Adeptus Astartes, Black Templars] → [Adeptus Astartes]
- land-raider-crusader: [Adeptus Astartes, Black Templars] → [Adeptus Astartes]
- impulsor: [Adeptus Astartes, Black Templars] → [Adeptus Astartes]
- repulsor-executioner: [Adeptus Astartes, Black Templars] → [Adeptus Astartes]
- gladiator-valiant: [Adeptus Astartes, Black Templars] → [Adeptus Astartes]
- repulsor: [Adeptus Astartes, Black Templars] → [Adeptus Astartes]
- gladiator-reaper: [Adeptus Astartes, Black Templars] → [Adeptus Astartes]
- venerable-dreadnought: [Adeptus Astartes] → [Adeptus Astartes, Space Wolves]

## excluded_faction_keywords (chapter bars)

- terminator-squad: [] → [Deathwatch]
- librarian: [] → [Black Templars]
- terminator-assault-squad: [] → [Deathwatch]
- librarian-in-terminator-armour: [] → [Black Templars]
- devastator-squad: [] → [Deathwatch, Space Wolves]
- scout-squad: [] → [Deathwatch]
- apothecary-biologis: [] → [Space Wolves]
- librarian-in-phobos-armour: [] → [Black Templars]
- apothecary: [] → [Space Wolves]
- tactical-squad: [] → [Deathwatch, Space Wolves]

## Dump SM-family datasheets with no repo unit (review)

- askars-wolfpack-blood-claws
- askars-wolfpack-wolf-guard-terminators
- askars-wolfpack-wulfen
- assault-force-captain
- assault-force-intercessor-squad
- assault-force-land-speeder
- assault-force-librarian
- assault-force-vanguard-veteran-squad-with-jump-packs
- captain-raldeo
- emperors-champion-vedrenn
- eradicator-squad-with-heavy-bolters
- fyrri-askar
- land-speeder
- master-zacharial
- sanguinary-spearhead-assault-intercessor-squad
- sanguinary-spearhead-sanguinary-guard
- vengeful-brethren-bladeguard-veteran-squad
- vengeful-brethren-hellblaster-squad
- vengeful-brethren-intercessor-squad
- vow-sworn-bladeguard-veteran-squad
- vow-sworn-crusader-squad
- vow-sworn-sword-brethren-squad

