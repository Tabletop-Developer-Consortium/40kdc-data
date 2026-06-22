# Ability-DSL shape backlog (ranked)

Highest-value *new DSL shapes* still missing — recurring mechanics no existing
effect/condition/trigger enum can express. From the embeddings-clustering
analysis (full-corpus run, model all-MiniLM-L6-v2, threshold 0.85; reports are
gitignored in ../40kdc-embeddings). Ranked by coverage × genuine
unexpressibility. Counts are abilities / factions.

| # | Shape | Kind | Coverage | Status |
|---|---|---|---|---|
| 1 | pooled-resource economy (tokens + valued dice) | effect + condition | 101 / 5 | **shape landed (1.0.8)** |
| 2 | `modifier-immunity` | effect | 46 / 25 | todo |
| 3 | `usage-limit` | meta-constraint field | 366 / 34 | todo |
| 4 | `stratagem-cost-modifier` | effect | 50 / 22 | todo |
| 5 | `targetable-only-if` | condition | 29 / 15 | todo |
| ~~6~~ | ~~sticky-objective~~ | — | — | **dropped — already expressible** |

## 1. Pooled-resource economy — tokens + valued dice (SHAPE LANDED, 1.0.8)

Shipped: `pool-add-die {value}` + `replace-roll-from-pool {rolls}` effects (the
latter revives the v1.0.0-retired dice-substitution), a `token-count-at-or-above
{pool_id, threshold}` condition, and a `cap {count, per}` field on `resource-spend`.
Schema + four byte-identical describers + cruncher fail-safe + conformance goldens.
Representative usages authored: Sororitas `acts-of-faith` (→ replace-roll-from-pool,
off the over-claiming guarantee-crit punt) and `solemn-procession` (→ pool-add-die
value 6); Drukhari `experimental-enhancements` (token-count gate + spend cap).

Incremental follow-up (data adoption, not new shape): broaden to the rest of
Drukhari Pain, Votann YP, Aeldari Battle Focus, and the remaining Sororitas
Miracle-dice abilities. Deliberately left as-is — neither new effect fits faithfully:
`stirring-rhetoric` (sets an existing die's value) and the Imagifier reroll
(re-rolls a die); both remain opaque ability-grant grant_type until a "modify a
pooled die" shape exists.

## 2. modifier-immunity (effect)

"Ignore any/all modifiers to characteristics and/or rolls", "cannot be affected
by enemy Stratagems/abilities". Negates *applied* modifiers — not `stat-modifier`
(adds/sets a value), not a condition. Clusters 41 / 13 / 8 (medoids
unyielding-might-ceramite-sentinels, champion-of-humanity-firestorm-assault-force,
inescapable-accuracy). New effect leaf: `scope: characteristics | rolls | both` +
optional exclusions.

## 3. usage-limit (meta-constraint field)

"Once per turn / phase / battle", per-unit vs per-army. Most pervasive (every
faction). `scope.duration: one-use` is too coarse to distinguish once-per-turn-
per-unit from once-per-battle-army — a correctness gap for availability
reasoning. Structured `usage_limit { count, per: turn|phase|battle, scope:
unit|army }` rather than prose.

## 4. stratagem-cost-modifier (effect)

"Stratagems cost 1 more CP to target this unit", "use [X] for 0 CP". `cp-gain`/
`cp-refund` cover gaining CP, nothing modifies a Stratagem's *cost*. Size-23
cluster (medoid protection-protocols). New effect `{ delta | set-to, scope:
targeting | used-by, stratagem_filter? }`. Ex: shock-charge,
mirror-of-fates-lords-of-dread, homing-beacon, incensor-cherub.

## 5. targetable-only-if (condition)

"Cannot be targeted by ranged attacks unless the attacker is within X\"",
closest-target-only gates. Distinct from `attack-restriction` (fires at
resolution, not target *selection*) and the Lone Operative keyword (fixed 12",
already modeled). Clusters 12 / 8 (obfuscation-librarius-conclave,
fog-of-dreams-psychic). New condition evaluated at target-selection time.

## Dropped

- **sticky-objective** — already expressible via `objective-control-modifier
  {sticky:true}` (26 uses across nearly every faction; describer renders the
  "retains control until the enemy retakes" prose). The loose match regex
  inflated it; its "example" ids (liberator-armoured-speartip,
  hunters-trail-company-of-hunters) do not exist in the data.
- **rule-replacement / transformation** — 0 real battle-time matches; the lone
  daemonic-allegiance is a list-building keyword choice (re-type bucket), now
  covered by `rule-state`.

## How each shape gets added

Same cross-language parity path #1 takes: schema enum → four describers
(byte-identical) → cruncher (handle or fail-safe `unsupported`) → conformance
golden (driven by re-authoring real abilities, since gen-conformance
auto-discovers types from data) → SPEC_VERSION bump → four version files in
lockstep. Patch releases (additive tool-surface + SPEC bump), not minors.
