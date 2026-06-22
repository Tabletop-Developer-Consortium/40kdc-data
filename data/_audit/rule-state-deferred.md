# `rule-state` — deferred migration candidates

These ability effects are **rule on/off toggles in spirit** but were **left in
their original `ability-grant` / `attack-restriction` encoding** when the
`rule-state` effect landed, because the bare `rule-state` shape
(`direction` × `rule_kind` × `rule` + optional `scope`/`cost`) can't model their
extra parameters without either losing data or smuggling unstructured fields in.

They are **fully functional as-is** — this is a worklist for a future pass that
either extends `rule-state` (e.g. a desperate-escape / battle-shock-hazard
qualifier) or gives these their own dedicated shape. Grep the `grant_type` /
`restriction` slug to jump to each.

Regenerate this list: scan `data/enrichment/*/abilities.json` for the slugs below.

## Desperate Escape family — carries hazard/trigger/condition params

| Faction | Ability id | Encoding | Slug | Why deferred |
|---|---|---|---|---|
| chaos-daemons | `inescapable-manifestations-cavalcade-of-chaos` | ability-grant | `force-desperate-escape` | modifier carries `trigger` + `hazard_modifier_if_battle_shocked` |
| world-eaters | `punish-the-craven-vessels-of-wrath` | ability-grant | `forced-desperate-escape` | modifier carries `battle_shock_hazard_penalty` |
| death-guard | `enfeebling-miasma` | ability-grant | `forced-desperate-escape-on-fall-back` | condition (on fall back) encoded in slug + sibling battle-shock conditional |
| orks | `fortification` | ability-grant | `ignore-desperate-escape-when-battle-shocked` | condition (when battle-shocked) encoded in slug |

## Parameterized aura debuff — carries a range

| Faction | Ability id | Encoding | Slug | Why deferred |
|---|---|---|---|---|
| death-guard | `putrefying-stink` | attack-restriction | `no-advance` (range 9) | explicit `range`; per the boundary rule, parameterized constraints stay in `attack-restriction` |
| tyranids | `bio-minefield` | attack-restriction | `no-advance` (range 6) | explicit `range` (as above) |

## Better served by a different existing shape

| Faction | Ability id | Encoding | Slug | Why deferred |
|---|---|---|---|---|
| astra-militarum | `low-profile-abhuman-auxiliaries` | ability-grant | `remain-hidden-after-shooting` | granting an exception; cleaner as a keyword/ability grant than a rule toggle |
| emperors-children | `absolute-sensory-overload-frenzied-host` | ability-grant | `remain-hidden-after-shooting` | as above |
| adeptus-astartes | `chapter-master-of-the-raven-guard` | ability-grant | `remove-chapter-master-keyword` | `chapter-master` resolves to no ability entity, so it can't be `rule_kind: ability`; left until that ability is modelled |
