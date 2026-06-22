# `rule-state` — deferred migration candidates (RESOLVED)

All nine candidates that were originally left in their `ability-grant` /
`attack-restriction` encoding when the `rule-state` effect landed have now been
migrated. The load-bearing rule held: **`rule-state` stayed minimal** — none of
the deferred params were folded into it. Each was handled by decomposing into
existing sibling primitives, dropping a redundant field, or picking the correct
named rule. One new closed core-rule slug (`ordered-retreat`) was added.

## Resolved — Desperate Escape family (was: hazard/trigger/condition params)

The 11e Fall-Back move (core rules 09.07) exposes its toggle on **Ordered
Retreat** (the optional mode, selectable iff not battle-shocked), not on
Desperate Escape (the mandatory "otherwise" fallback, which has no switch of its
own). So "force Desperate Escape" = **suppress** `ordered-retreat`, and the Orks
mirror "ignore Desperate Escape while battle-shocked" = **grant**
`ordered-retreat`. The `-1`-when-battle-shocked is a modifier to the per-model
hazard roll (06.03) made during Desperate Escape, modeled as a sibling
`conditional(is-battle-shocked) → roll-modifier { roll: "desperate-escape", -1 }`.

| Faction | Ability id | New encoding |
|---|---|---|
| chaos-daemons | `inescapable-manifestations-cavalcade-of-chaos` | `sequence`: rule-state(`ordered-retreat`, suppressed) + conditional(is-battle-shocked)→roll-modifier(`desperate-escape`, −1) |
| world-eaters | `punish-the-craven-vessels-of-wrath` | same two-step sequence |
| death-guard | `enfeebling-miasma` | step 1 → rule-state(`ordered-retreat`, suppressed); step 2 leadership-modifier → roll-modifier(`desperate-escape`, −1) (10e mislabel corrected) |
| orks | `fortification` | step 2 → conditional(is-battle-shocked)→rule-state(`ordered-retreat`, granted). Also fixed step 1: the ranged −1-to-Hit was encoded `target: enemy-within-aura` (renders as the enemy's *own* Hit rolls) → corrected to `target: attacker` (the published rule penalizes attacks *against* the unit), matching the 66-case `attacker` convention. |

## Resolved — parameterized aura debuff (was: explicit `range`)

`no-advance` is `advance` suppressed; the explicit `range` was redundant with
`scope.range: aura-N` (the describer threads it onto the `enemy-within-aura`
subject), so it was dropped.

| Faction | Ability id | New encoding |
|---|---|---|
| death-guard | `putrefying-stink` | rule-state(`advance`, suppressed, enemy-within-aura), scope `aura-9` |
| tyranids | `bio-minefield` | rule-state(`advance`, suppressed, enemy-within-aura), scope `aura-6` |

## Resolved — better served by a different existing shape

| Faction | Ability id | Resolution |
|---|---|---|
| astra-militarum | `low-profile-abhuman-auxiliaries` | **No change** — `ability-grant` is the correct shape (granting an exception ability, not toggling a named rule). |
| emperors-children | `absolute-sensory-overload-frenzied-host` | **No change** — as above. |
| adeptus-astartes | `chapter-master-of-the-raven-guard` | `ability-grant{remove-chapter-master-keyword}` → rule-state(`keyword` "chapter-master", suppressed). `rule_kind: keyword` is a free open-set string (no entity resolution), pairing with the sibling `keyword-grant(CAPTAIN)`. |
