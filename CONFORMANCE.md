# Cross-language conformance

`40kdc-data` ships in multiple languages. The `conformance/` directory is the contract that keeps them in agreement: inputs and expected outputs, language-agnostic, versioned. Any official implementation must reproduce every golden in `conformance/` within the documented tolerances.

This document is the high-level entry point. The runner wire format lives in [`conformance/RUNNER_PROTOCOL.md`](./conformance/RUNNER_PROTOCOL.md). The contributor workflow lives in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## The rule

> A new or changed golden in `conformance/` is not accepted until at least one implementation other than the one that produced it independently reproduces the same expected value.

This is the single load-bearing rule. Without it, whoever runs the generator first dictates behavior, and "TypeScript happens to do X" silently becomes "the spec says X." With it, a behavior change has to be reproduced by a second implementation in the same PR, which forces the conversation about whether the change is correct.

The same person *can* author both the implementation change and the second-impl verification — the rule is about evidence in the PR, not separation of duties.

## What gets pinned

| Area | What's pinned | Tolerance |
|---|---|---|
| `normalize.json` | `normalizeName(input) == expected` for every case | exact string match |
| `roster/<case>/` | Every `input.*` imports to the same `expected.roster.json`; every export reproduces `expected.<fmt>.{txt,json}` | byte-equal text; structural equality on JSON (re-serialized through each language's pretty-printer) |
| `cruncher/<case>.json` | Each named stage matches the golden float | `±5e-4` per stage |
| `compare/<case>.json` | One fleet-comparison cell (profile→unit resolution + defensive buffs + half-range + crunch) matches `{expectedKills, reaches, withinHalfRange, modelCount}` | `±5e-4` on `expectedKills`; exact on the rest |
| `loadout/<case>.json` | One loadout totalled at the damage level (sum post-FNP across weapon lines → kills once) matches `{damage, kills}` | `±5e-4` per field |
| `abilities-resolver/0?-*.json` | `eligibleAbilities(input, phase)` yields the expected `{kind, abilityId}` list in order | exact equality (order is part of the contract) |
| `abilities-resolver/from-dsl.json`, `defensive-from-dsl.json` | `effectToBuffs(effect, source, ctx, perspective)` yields the expected applied / unsupported / activatable triples | structural equality |
| `weapon-keywords/cases.json` | Each keyword maps to its catalog effect | structural equality |
| `linked-api/cases.json` | Each Dataset query (`find_*`, `abilities_of`, `weapons_of`, `wargear_options_of`, `base_loadout`, `maximal_loadout`, `phases_of`, `faction_of`, `abilities_of_faction`, `weapons_of_faction`) returns the expected result | per-case comparison mode: `scalar`, `ordered`, or `set` (sorted before compare) |
| `attribution/cases.json` | Each AttributedStage (per-stage leave-one-out decomposition from `attributeStages`) matches expected/baseline/lifts/residual/intrinsics | per-value `±5e-4` for floats; structural for `source` / `intrinsics` |
| `validator/cases.json` | Each input validates (or doesn't) against its target schema, emitting the expected closed-enum error codes | exact set match on `(path, code)` pairs after deduplication |
| `scoring-translation/cases.json` | `describeScoringCard(card)` humanizes each primary mission card's `awards` into the expected English lines | exact string equality (ASCII-only), `awards` order load-bearing |
| `scoring/cases.json` | The scoring engine's VP arithmetic — `score_event` (per-card `scoreTurn`/`scoreCap`/`scoreSecondaryEvent`/`scorePrimaryEvent`), `score_state` (per-round + per-game + grand-total caps, score/discard, undo), and `wtc_result` band mapping | exact integer equality (no tolerance); `awards`/op order load-bearing |
| `terrain-resolver/cases.json` | `resolveLayout(layout, templates)` resolves template-anchored, centroid-positioned pieces to absolute board-space vertices | per-value `±5e-4` on vertices; exact on `id`/`name`/`piece_type`/`floor`; piece emission order load-bearing |
| `terrain-keystones/cases.json` | `keystoneMeasurements(layout, templates, board)` derives each authored keystone's printed distance (board edge → piece feature) from resolved geometry | per-value `±5e-4` on distances; exact on `piece_index`/`piece_id`/`edge`/`ref`; emission order load-bearing; display rounding unpinned |
| `applies-to/cases.json` | `unitMatchesAppliesTo(applies_to, unit)` resolves which units an ability's curated keyword filter benefits — `match_applies_to` returns the matched ids | exact equality on `matchedIds` (input order load-bearing) |

## Implementation status

| Language | Package | Status | Runner binary |
|---|---|---|---|
| TypeScript | [`@alpaca-software/40kdc-data`](./tools/) | Stable. Currently the corpus oracle (`npm run gen:conformance`). | `40kdc-runner` (built from `tools/src/runner.ts`) |
| Rust | [`wh40kdc`](./crates/wh40kdc/) | Stable. Verifies the corpus in `crates/wh40kdc/tests/conformance.rs`, `cruncher_conformance.rs`, `linked_api_conformance.rs`, `attribution_conformance.rs`, `terrain_resolver_conformance.rs`, `scoring_conformance.rs`, `applies_to_conformance.rs`. | `wh40kdc-runner` (built from `crates/wh40kdc/src/bin/wh40kdc-runner.rs`) |
| Python | [`wh40kdc`](./python/) (PyPI) | Stable. Verifies the full corpus in `python/tests/conformance/` (every area, including the validator and abilities-resolver). | `python -m wh40kdc.runner` (no console script — avoids a PATH collision with the Rust binary) |
| Go | [`wh40kdc`](./go/) (Go module `github.com/wn-mitch/40kdc-data/go`) | Stable. Verifies the full corpus via the cross-impl differ (`--pair ts,go \| rust,go \| py,go`) plus Go-native tests in `go/conformance_test.go` (weapon-keywords, abilities-resolver, from-dsl). | `wh40kdc-runner` (built from `go/cmd/wh40kdc-runner`) |
| R | TBD | Planned. Likely an `extendr` wrapper around the Rust crate rather than a native port; see the FAQ. | Will ship with the package. |

## Per-area invariants

These notes document what is *currently load-bearing* about each corpus area. Future contributors should consult this section before assuming a golden is incidental.

### `normalize.json`

- Pipeline: NFD normalize → strip combining marks → strip apostrophes and quote variants (`'`, `'`, `'`, `` ` ``) → collapse runs of whitespace and hyphens to single space → trim → lowercase via ASCII table (never locale-aware).
- Distinctness anchors (e.g., `Khorne` vs `Khârn` lowercasing to different strings) are deliberate test cases. Do not collapse them.
- Idempotence is part of the contract: `normalizeName(normalizeName(x)) == normalizeName(x)`.
- Unicode whitespace beyond ASCII (NBSP U+00A0, ideographic space U+3000) collapses to a single space in both implementations. Pinned cases exercise this.
- Turkish dotted-I (`İ` U+0130) folds to ASCII `i` via the NFD pipeline: decompose to `I` + combining dot above, strip the dot, then locale-independent lowercase. Pinned to prevent any port from introducing locale-aware casefolding.
- Zero-width joiner (U+200D) passes through both implementations today (it is not a combining mark, not whitespace, and not a quote variant, so no rule matches it). A pinned case captures this behavior — if a future commit strips Cf-category characters, this golden updates in the same PR.

### `roster/`

- The canonical seed in each fixture is whichever of `input.json` (ListForge), `input.newrecruit-json.json` (NewRecruit JSON), or `input.gw.txt` (GW app text export) is present. The seed must import to `expected.roster.json` **exactly** (no field-stripping).
- Derived text inputs (e.g., `input.newrecruit-wtc-compact.txt`) are produced by re-exporting the seed. They must import back to the same resolved Roster after stripping `source` and `diagnostics` fields — those fields legitimately differ across formats and are not part of the round-trip contract.
- Export goldens (`expected.*.txt`, `expected.*.json`) are byte-identical contracts: text formats compare as raw strings; JSON formats compare after each language re-serializes the golden through its own pretty-printer (2-space indent, trailing newline). This tolerates filesystem CRLF and formatter incidentals while pinning structure and content.
- **Every fixture carries all eight export goldens** (the six round-trip-capable formats plus the two export-only ATC 2026 variants), including legacy ListForge fixtures whose canonical input is `input.json` (ListForge) or `input.gw.txt` (GW app). What legacy fixtures do *not* carry is the derived round-trip text input (`input.newrecruit-wtc-compact.txt`, etc.) — those are skipped because lossy multi-force decoration (provisional leader-attachment inference, multi-force warning emission) would cause the round-trip to fail structurally rather than surface a parser bug.
- **ATC 2026 (`atc-2026-compact` / `atc-2026-full`) is export-only.** Both reuse the WTC compact/full bodies byte-for-byte and only swap the summary header for the ATC list-submission block (player/team placeholders, picked Force Disposition, every enhancement-bearing model, and spelled-out leader/support attachments). There is no ATC import adapter, so these formats emit an `expected.atc-2026-*.txt` golden but **never** a derived `input.atc-2026-*.txt` round-trip seed. `PLAYER NAME` / `TEAM NAME` are static `—` placeholders (the Roster models neither); `DISPOSITION` is `titleCaseId(force_disposition)` or `—`.
- **Parsed-stage golden** (`expected.parsed.json`): each fixture pins the `ParsedRoster` intermediate produced by the adapter for the canonical seed, before resolution. Catches parser regressions that resolution would otherwise mask — e.g., a duplicate cost line that the parser emits as two units but the resolver deduplicates to one. Generated by re-running the same adapter the import pipeline would dispatch; both TS and Rust expose the underlying `ParsedRoster` via serde-derived serialization so structural comparison works directly.
- **Detachments are a list (11e multi-detachment).** A roster carries `detachments: [{ ref, dp_cost }]` — zero or more, in **source/parse order (load-bearing)** — not a single `detachment_id`. Each `ref` is the lossless resolved-ref shape (so an unresolved detachment keeps its raw name + candidates, like units). `dp_cost` is the detachment-point cost looked up from the **resolved detachment entity's `detachment_points`** (no import format reports DP); it is `null` when the detachment is unresolved or the entity records no cost. `ParsedRoster.detachment_raw_names` is likewise a list — tree formats (NewRecruit JSON, ListForge, Rosterizer) collect **every** `Detachment` selection; header formats (WTC, GW, simple) still carry zero or one.
- **`points.detachment_cap`** is derived from `battle_size` (strike-force → 3, incursion → 2, unknown → null) — not parsed from any source.
- **`detachment-points-exceeded`** is emitted when every detachment's `dp_cost` is known and their sum exceeds `detachment_cap`. The message is pinned verbatim (`Detachments cost <n> detachment points but the <battle-size> budget is <cap>.`, the battle size in its kebab serialized form), so every implementation must reproduce it byte-for-byte.
- **Multi-detachment round-trip is lossy for header formats.** The text exporters (WTC compact/full, simple) print every detachment but their parsers read only one, so a multi-detachment fixture emits the export goldens **without** the derived round-trip text inputs (the same skip the legacy ListForge fixtures get). NewRecruit JSON and Rosterizer round-trip losslessly (both collect every detachment), and the canonical `input.roster-json.json` / export round-trip is always exact.

### `cruncher/`

- Stage names and order: `attacks` → `hits` → `wounds` → `unsaved` → `damage` → `after-fnp` → `models-killed`. Each is a float; the golden encodes four decimal places.
- Tolerance `5e-4` is per-stage, not accumulated. Wide enough to absorb the rounded goldens; tight enough to catch any non-trivial engine drift.
- **Reduction order invariant (load-bearing):** buffs apply in the order they appear in the input `buffs` array. Stages evaluate left-to-right in the order above; each stage consumes the previous stage's `expected` value. Implementations must not reorder, parallelize, or memoize in a way that changes float reduction order — `(1/3 + 1/3) + 1/3` is not always equal to `1/3 + (1/3 + 1/3)` at float precision, and a 7-stage chain can drift past tolerance.
- All inputs reference entities by id (`weaponId`, `unitId`). The cruncher resolves them against the embedded dataset; no inline weapon/unit shapes today.
- **Range-gated abilities:** a buff may carry `applicableWhen.maxRangeInches` (from a DSL `scope.range_inches`, e.g. a "within 18\"" reroll). The resolver drops it only when `context.distanceInches` is **known and exceeds** the range; an unset `distanceInches` is permissive (the buff applies), so callers that don't track distance are unaffected. Pinned by `cruncher/13-*` (within range) and `cruncher/14-*` (beyond range).
- **Cover (11e contract):** the benefit of cover is **-1 to the hit roll**, applied in the `hits` stage — not a save bonus. It is ranged-only, negated by the `ignores-cover` keyword, and moot for auto-hitting `torrent` weapons. A `cover`-type buff in the stack drives it. (This replaced the 10e save-improvement rule; high-AP weapons that ignored the old save bump are now reduced by cover like everything else.) Pinned by `cruncher/11-*`, `cruncher/12-*`.

### `compare/`

- Each case pins one fleet-comparison cell: an attacker `{factionId, unitId, weaponId, profileIndex}` against a `targetProfileId` at a `distance` and `phase`. The op resolves the target profile to its referenced unit (faction-scoped — shared ids like `forgefiend`/`rhino` require it), stacks the target's defensive abilities via `defensiveBuffsFor`, sets `withinHalfRange = distance <= range/2`, and runs `crunch`. The pinned cell is `{expectedKills (float, ±5e-4), reaches, withinHalfRange, modelCount}`.
- Builds directly on the `cruncher` engine, so the reduction-order invariant above applies transitively. The only compare-specific arithmetic is the half-range predicate and the model-count override (`model_count_override ?? unit.model_count.min`).
- **Rust is exempt** from this area: the comparison depends on `defensiveBuffsFor`, which the Rust crate does not ship — its runner answers `compare` with `UNKNOWN_OP` and the differ skips the area for rust pairings. The second-impl rule is satisfied by the **ts↔py** pairing (the differ plus `tools/test/conformance.test.ts` and `python/tests/test_compare.py`). Rust's parity for the underlying **data entity** (that target profiles load and resolve to real units) is held by `crates/wh40kdc/tests/data_api.rs` instead.

### `loadout/`

- Each case pins one loadout (a list of `{weaponId, count, profileIndex}` lines) against a `targetProfileId` at a `distance`/`phase`, as `{damage, kills}`. **Totaling is at the damage level:** post-FNP wounds are summed across all lines (each fired by `count` models), then converted to models-killed *once* via `min(modelCount, damage / W)`. Summing per-weapon kills instead would over-count, because each weapon's models-killed caps independently — that ordering is the load-bearing invariant of this area.
- An out-of-range line contributes nothing (a ranged profile reaches only when `range >= distance`).
- Same **Rust exemption** as `compare/` (it composes `defensiveBuffsFor`): the runner answers `loadout` with `UNKNOWN_OP`, ts↔py exercises it (`tools/test/conformance.test.ts`, `python/tests/conformance/test_loadout.py`).
- **Not pinned:** loadout *enumeration* from wargear options (`enumerateLoadouts`). It is a data-derived heuristic over imperfect wargear data — the dataset records no per-model weapon counts, so it is advisory (counts default to 1), not a deterministic spec contract.

### `abilities-resolver/`

- `eligibleAbilities(input, phase)` returns a list of `{source, ability}` entries; the conformance corpus pins the **set of ability ids per source kind**, not the order. Each fixture's `expected` is shaped `{<kind>: [sorted-ability-ids]}`. Tests group the actual result by `source.kind`, sort each group's ids alphabetically, and compare structurally.
- This is deliberately weaker than "ordered list" — the resolver's internal iteration order is incidental (determined by dataset bundler iteration over data/ files) and forcing every port to reproduce it byte-for-byte would encode TS-bundler internals as a cross-language contract. A consumer that relies on a specific surface order must impose its own sort.
- Source kinds drawn from the resolver's enum: `army`, `detachment`, `detachment-stratagem`, `unit`, `attached`, `support`. Empty kinds are omitted from the expected object.
- Rust does not currently have an abilities-resolver port (it's planned as M2 — see `crates/wh40kdc/src/cruncher/from_keyword.rs`). Python ships one (`wh40kdc.abilities_resolver`), so the second-impl rule is **active** for this area: TS and Python verify each other via `python/tests/conformance/test_abilities_resolver.py`. The R port must reproduce the corpus before merging.
- `from-dsl.json` and `defensive-from-dsl.json` pin the DSL effect-translation pipeline: each case asserts the `applied` buff list, the `unsupportedReasons` list, and (when present) the `activatable` lever projections. List order is part of the contract for these (unlike the eligibility ordering above) — the buffs are emitted as a sequence and re-ordering would change the engine's reduction order.
- **Model scope (core rule 19.04) is part of the contract.** An effect whose `target` is `self` or `bearer` names a single *model*, so when the buff `source` is `{kind: "ability", abilityKind: "attached"}` — the ability was pooled in from another member of a combined unit — it contributes **no** buff and emits exactly one diagnostic: `model-scoped effect from an attached model: applies to that model only (core rule 19.04)`. The gate is keyed on the source kind (not on the DSL condition) and fires under **both** perspectives; the same effect read as the chosen unit's own ability (`abilityKind: "unit"`) still applies. Both directions are pinned (`shadowfield`/`psychic-gifts` for the drop, `mental-fortress-psychic`/`breakin-heads` for the unit-scoped counterpart) — the counterpart cases exist to catch the gate over-reaching onto `target: "unit"` rules. `abilityKind: "support"` is deliberately *not* gated.

### `weapon-keywords/cases.json`

- Each keyword id maps to a canonical effect shape. Re-roll effects must carry a `subset` field (post-M0 invariant from a prior schema change).
- Effect shapes are compared structurally; this includes nested DSL trees.

### `linked-api/cases.json`

- Each case carries a `comparison` discriminant. Implementations must honor it: `scalar` cases compare a single id-or-null value, `ordered` cases compare the actual result against the expected list element-by-element, `set` cases sort both sides before comparing.
- `abilities_of(unit)` and `weapons_of(unit)` are `ordered` because they iterate the unit's `ability_ids` / `weapon_ids` array in declared order — the data file is the contract, and any implementation that iterates the same array gets the same order for free.
- `wargear_options_of(unit)` is `ordered`: both impls build the per-unit index by scanning the `wargear_options` collection in bundle order, and a unit's options are contiguous in its faction file, so the per-unit order is the file order in either language.
- `base_loadout(unit, modelCount)` encodes the no-swaps loadout (every model in its out-of-the-box configuration) as sorted `"id:count"` strings, compared as a `set`. It pins the legal default a freshly-added unit ships with: when the composition records per-model `default_weapon_ids` those are authoritative (Σ over allocated model-types), else the derived base set. This is the load-bearing contract — `maximal_loadout` below is advisory by contrast. See `baseLoadout` in `src/data/loadout.ts` / `base_loadout` in `loadout.rs`.
- `maximal_loadout(unit, modelCount)` encodes the resulting per-weapon/wargear counts as sorted `"id:count"` strings and compares as a `set` (the id→count map has no inherent order). It pins the take-every-swap loadout maths (`optionCap` → base-minus-swaps, choices take their first declared branch); see `src/data/loadout.ts` / `loadout.rs`. Because multiple options can compete for one model's slot, the take-every-swap result is **advisory** for cap-contended units — pin `base_loadout` (the default a unit ships with), not `maximal_loadout`, for such units.
- `abilities_of_faction(faction_id)`, `weapons_of_faction(faction_id)`, and `phases_of(ability)` are `set` because they walk an index (collection `by_faction`, phase-mapping index) whose iteration order depends on bundler internals. Pinning the iteration order would force every port to reproduce TS's data-file iteration; the set semantics frees them from that.
- `find_*` and `faction_of(unit)` are `scalar`: a single id or null. Diacritic-insensitivity is part of the contract (`find_unit("Kharn")` resolves "Khârn the Betrayer") and is exercised by the corpus.
- `weapons_of_faction` aggregates by walking the faction's units and dedupes by weapon id — it is **not** `weapons.byFaction()` (which is a collection index lookup that returns weapons whose own `faction_id` is set, an unrelated query). Implementations must use the aggregation semantics.

### `attribution/cases.json`

- Each case references a cruncher input file via `cruncher_case` (avoids duplicating the `EngineInput`) and pins every `AttributedStage` the per-stage decomposition emits.
- **Float fields** (`expected`, `baseline`, `residual`, per-lift `delta`) compare with `±5e-4`, matching the cruncher tolerance. Implementations must use the same leave-one-out (LOO) algorithm — full crunch, baseline (all groupable buffs removed), one LOO crunch per group — so individual stage values stay deterministic across languages.
- **Lift order is load-bearing.** Lifts appear in the order their groups were first seen in the input `buffs` array. Implementations must iterate the input array in declared order to build the group ordering; reordering buffs internally would shift lift indices without changing stage values, which the corpus would silently miss.
- **Groupable vs. intrinsic buffs.** Only `ability` and `manual` buffs are groupable (drop-one-and-recompute). `weapon-keyword` buffs are intrinsic — they appear in `intrinsics` (a flat list of keyword ids) rather than `lifts`. Cases where the only buff is `weapon-keyword`-typed will have empty lifts and `baseline == expected`.
- **`residual`** is `expected − baseline − Σ lifts`. Non-zero when buffs collide under a cap (two `+1`s sharing a `±1` cap each show ≈0 lift; the real `+1` lands in the residual). The corpus pins residual within `5e-4`.
- **Comparison of `BuffSource`** uses serde-derived JSON shape: kind-tagged discriminated union with `kind` snake-cased (`"manual"`, `"ability"`, `"weapon-keyword"`) and field names camelCased on the wire.

### `validator/cases.json`

- Each case names a `target` schema (one of `unit`, `weapon`, `faction`, `ability`, `wargear`, `wargear-option`), an `input` value, and the **closed-enum error codes** the validator must emit on `(path, code)` pairs. AJV's free-form error messages are intentionally not part of the contract — implementations that produce different wording for the same constraint must still emit the same code.
- The closed enum is defined in `conformance/RUNNER_PROTOCOL.md` under the `validate` op. Adding a new code is a `SPEC_VERSION` bump.
- Comparison is set-based and deduplicated by `(path, code)`. AJV emits both a leaf-level error and a containing schema error for nested oneOf/anyOf failures; deduplication keeps the contract focused on what's user-meaningful.
- **Rust does not currently ship a validator** (the crate exposes `BUNDLED_SCHEMA` as a `&str` constant but no validation function; its runner answers `validate` with `UNKNOWN_OP`, and the differ skips the area for rust pairings). Python ships one (`wh40kdc.validator`, built on the `jsonschema` library with the closed-enum mapping), so the second-impl rule is **active** for this area: the ts↔py differ pairing exercises it, plus `python/tests/conformance/test_validator.py`. `jsonschema-rs` remains the leading candidate for Rust.

### `scoring-translation/cases.json`

- Each case is `{cardId, expected: {awards: [string, …]}}`. The op looks up the `secondary-card` by id and humanizes its scoring `awards` via `describeScoringCard` (TS) / `describe_scoring_card` (Rust). Generated by the TS oracle (`npm run gen:conformance`); the Rust port must reproduce every string byte-for-byte.
- **Exact string equality, no tolerance.** Output is **ASCII-only** by design — no en-dashes, middots, or smart quotes — so the two ports can't disagree on a multi-byte codepoint. Integers render with no separators.
- **`awards` order is load-bearing.** Awards are emitted in the card's `awards` array order (the card's printed top-to-bottom scoring rows, including the `cumulative` "+ " bonus rows). Reordering would change the readout without changing any single string, which the corpus would catch.
- **Phrasing is the contract.** `describeTrigger` (timing/phase/player-turn/battle-round window), `describeAward` (flat `vp` vs `vp_per`/`per`, `cumulative` "+ " prefix, `exclusive_group` "[highest tier]" suffix), and the shared `describeCondition` (the `when` clause, including the 12 scoring predicate types and `and`/`or`/`not` compounds) all pin their exact wording and the fixed order in which condition parameters render. Changing any phrase is a `SPEC_VERSION` bump.
- Only `card_type: "primary"` cards are in the corpus (the 25 mission cards). The 14-card secondary deck isn't revealed yet; when it lands, its cards join the same area under the same invariants.
- The community-authored `text` summary and the `actions` list are **verbatim data, not translation**, so they are not part of this area — only the structured `awards` strings are pinned.

### `scoring/cases.json`

- Each case is `{name, op, args, expected}`, dispatched through the runner op named by `op`. Generated by the TS oracle driving its own runner (`npm run gen:conformance`); the Rust port must reproduce every value exactly. **All values are integers — exact equality, no tolerance.**
- **Awards are referenced by index, never serialized.** `score_event` / `score-secondary` / `score-primary` carry `asserted: [{index, count?}]`, where `index` addresses the card's full `awards` array (approach affects only the cap, not which indices are valid). Both impls reconstruct the same `AssertedAward` from the shared embedded dataset, so the award shape can't drift on the wire.
- **`score_event`** → `{turn, cap, banked, primaryBanked?}`. `turn` is `scoreTurn` (exclusive-group "highest only", `vp_per × count` clamped to `per_max`, cumulative rows summed). `cap` is the per-score ceiling — tactical is the universal 5, fixed is the max printed `vp_max` or **`null` when uncapped** (`Infinity` has no JSON form). `banked = min(turn, cap)`. `primaryBanked = min(turn, roundCap)` appears only when the case supplies `roundCap` (primary cards). There is **no tactical 5-cap on primary**.
- **`score_state`** → `{rounds, handIds, log, primary, secondary, total}` after replaying `ops`. The cap contract is load-bearing: a round's primary is clamped to `roundCap` **and** to the remaining per-game room (`gameCap − other rounds' primary`, floored at 0), and `total = min(100, primary + secondary)`. `set-primary` with no caps is unclamped (floor at 0 only). `score-primary` computes the round's raw `scoreTurn` then stores it through the same clamp; `score-secondary` banks `min(turn, cap)`, logs it, and discards from hand; `remove-score` reverses a log entry and returns the card to hand. **Op order is load-bearing.**
- **`wtc_result`** → `{a, b}`. The 20-point band: equal totals → 10-10; margin 0-5 → 10-10; then one band per 5 VP (`10 ± ceil((diff−5)/5)`), capped at 20-0 for 51+.
- Changing any of these arithmetic contracts is a `SPEC_VERSION` bump.

### `terrain-resolver/cases.json`

- Each case is `{name, templates, layout, expected: {pieces: [...]}}`. The op resolves the layout's template-anchored, centroid-positioned pieces to absolute board-space vertices via `resolveLayout` (TS) / `resolve_layout` (Rust). Cases are self-contained — each carries its own `templates` — so the area is independent of the bundled catalog. Generated by the TS oracle (`npm run gen:conformance`); the Rust port must reproduce every vertex.
- **The transform contract is the spec.** Board frame is inches, origin at a board corner, **y-down**. A footprint is authored in natural local coordinates; the resolver derives its **polygon area centroid** (shoelace — *not* the vertex mean; the right-triangle's is `(w/3, h/3)` and the trapezoid's is pulled toward its wider base) and treats local vertices as `(v − centroid)`. So `position` denotes the centroid and is **invariant under rotation and mirror**. Local → board is `mirror → rotate → translate`: `board = position + R_cw(rotation) · M(mirror) · (v − centroid)`, with `M` horizontal → `(−x, y)`, vertical → `(x, −y)`, and `R_cw(θ)` the clockwise rotation in the y-down frame `[[cosθ, −sinθ], [sinθ, cosθ]]`. Changing any of these is a `SPEC_VERSION` bump.
- **Composition / parenting.** A feature with `parent_area_id` (and an area template's embedded composed `features`) is placed in the parent area's centroid-local frame, then carried through the area's placement: `board = T_area ∘ R_area ∘ M_area ( featurePos + R_feat · M_feat · (w − C_feat) )`. A composed feature and the same feature parented explicitly resolve identically.
- **Emission order is load-bearing.** Pieces are emitted in `layout.pieces` order; an area piece instancing a template with composed features emits those features immediately after it, in template-declaration order.
- **Comparison:** vertices are rounded to 4 dp (JS `Math.round` semantics, `floor(x·1e4 + 0.5)/1e4`, matched in Rust) and compared per-value with the `5e-4` float tolerance; `id`/`name`/`piece_type`/`floor` are compared exactly.

### `terrain-keystones/cases.json`

- Each case is `{name, templates, layout, board?, expected: {measurements: [...]}}`. The op derives the printed distance of every authored measurement keystone (a per-piece `{edge, ref}` selection: board edge → footprint vertex by index, or an axis-aligned bounding face of the placed footprint) via `keystoneMeasurements` (TS) / `keystone_measurements` (Rust). Cases are self-contained like the resolver corpus; `board` defaults to the 40kdc standard 60 × 44 inches.
- **Distances are derived, never stored.** The layout resolves through the `terrain-resolver` transform contract first; near edges (`left`/`top`) read the feature's board coordinate, far edges (`right`/`bottom`) read the remaining extent (`width − x` / `height − y`). A keystone can therefore never disagree with the layout's geometry. Vertex indices follow the resolver's pinned vertex order.
- **Emission order is load-bearing:** measurements appear in `layout.pieces` order, then per-piece keystone order. A vertex index out of range or a face whose axis disagrees with the edge is an error (`INVALID_INPUT` at the runner layer), not a skipped entry.
- **Display rounding is deliberately NOT pinned.** The corpus compares raw 4-dp distances with the `5e-4` float tolerance (`piece_index`/`piece_id`/`edge`/`ref` exactly); how an app formats them for a card (half-inch rounding and the like) is presentation and must not be folded into this contract.

### `applies-to/cases.json`

- Each case is `{caseId, applies_to, units: [{id, keywords, faction_keywords?}], expected: {matchedIds}}`. The `match_applies_to` op intersects the curated `applies_to` keyword filter with each unit and returns the matching ids. Cases are self-contained (no dataset lookup), so parity is independent of dataset state; the corpus mixes fabricated keyword sets with the real `Possessed` detachment-rule scope.
- **Matching is exact-string, case-sensitive, over the union of `keywords` + `faction_keywords`.** A unit matches iff it carries every `required_keywords` entry (an AND set) and none of the `excluded_keywords`. Faction-level keywords (e.g. `Adeptus Astartes`) live in `faction_keywords`, so the union is load-bearing — a required faction keyword must still match. No lower-casing or fuzzy matching: `infantry` ≠ `Infantry`.
- **The two empty forms are distinct and pinned.** `applies_to: null` (or absent) is "no resolvable scope" and matches **nothing** (the app renders no highlight rather than guess); a present `applies_to: {}` constrains nothing and matches **every** unit. Changing either is a `SPEC_VERSION` bump.
- **`matchedIds` order is load-bearing:** ids are emitted in input-unit order, not sorted. The differ compares structurally (exact, no sort), so a reordering would be caught.

### `share/cases.json`

- Each case is either a **round-trip** case `{name, list, token}` or a **negative decode** case `{name, decode_token, expected_decode}`. The `share_encode` op must turn `list` into exactly `token`; the `share_decode` op must turn `token` back into `list` (round-trip) or yield `expected_decode` (a `{ok:false, reason}` verdict). Input lists are derived from the embedded dataset deterministically (sorted, first-N) so the goldens are stable.
- **The token bytes are pinned exactly.** `share_encode` is compared as a string (no tolerance), so the entire `share-v1` wire layout — the format-version byte, LEB128 varints, registry indices, flag bitfield, and length-prefixed UTF-8 for `name`/`grants` — is load-bearing. The wire format and registry are specified in [`tools/docs/share-token.md`](tools/docs/share-token.md). The codec is deliberately gzip-free so the buffer is byte-identical across implementations without depending on a shared deflate.
- **Encode field order is load-bearing** and matches the doc: faction, battle size, disposition, detachments (count + indices), then per unit `unitIdx, modelCount, flags, [enh], [attachOrdinal], [allyFaction, allyRule], [grants], loadout`. `attachedToOrdinal` is an index into the case's own `units` array, never a datasheet id.
- **Registry indices are append-only.** Adding entities appends new ids (preserving existing indices), so older tokens keep decoding; a renamed id is carried in the registry `aliases` map (old slot → current id) and a removed id becomes a `tombstone`. A token that references a slot the decoder's registry lacks is `stale-registry`, never a silent misresolve. Regenerating `data/share-registry.json` (`npm run registry:build`) is a deliberate migration step and bumps its `version`.

## Tolerances and comparison rules

- **Text export comparison:** raw byte equality after both implementations have produced their output. No trailing-whitespace tolerance, no CRLF normalization at this layer.
- **JSON export comparison:** the golden file on disk is parsed by each implementation and re-serialized through its own pretty-printer (TS `JSON.stringify(value, null, 2) + "\n"`; Rust `serde_json::Serializer::with_formatter(buf, PrettyFormatter::new())` + manual `\n`). The actual export is compared as a string against the re-serialized golden. This is intentional: filesystem CRLF on Windows, BOM, and trailing-whitespace incidentals don't matter; key order and value content do.
- **Float comparison:** per-value, `abs(actual - expected) < 5e-4`. Not RMS, not max-of-batch. Documenting it this way means runners can stream stages as they're computed.

## `SPEC_VERSION` policy

- The `conformance/SPEC_VERSION` file contains a single integer.
- It bumps whenever a corpus diff changes semantics: a new case is added, an expected value changes, a case is removed, the runner protocol changes, or a per-area invariant changes.
- Pure format changes (re-pretty-printing, comment-only edits to invariant notes) do not bump it.
- Each implementation embeds the version it was tested against and refuses to participate in a cross-impl run if the differ's spec version doesn't match.

## FAQ

**Why don't error message strings have parity?**

Every language's validation library words errors differently (AJV: "must have required property 'name'"; pydantic: "field required"; jsonschema-rs: "is a required property"). Pinning strings would trap every port in re-implementing TypeScript's error wording. We pin error *codes* in a closed enum and accept that the human-readable message is the implementation's prerogative.

**Why isn't performance parity in scope?**

Cross-implementation correctness and cross-implementation performance are different projects. A Python port that is correct but 10× slower than Rust is fine; a Python port that is fast but disagrees with Rust on roster import is broken. Performance budgets, if needed, will live per-implementation rather than as cross-impl assertions.

**Why is R potentially a Rust wrapper instead of a native port?**

R has a long list of idioms that fight byte-identical JSON parity (`jsonlite::toJSON` auto-unbox traps, NA-vs-NULL serialization, integer-vs-double ambiguity in named lists, 1-indexing leaking through ordered-output queries). An `extendr` / `rextendr` wrapper around the Rust crate eliminates those issues for cruncher, dataset queries, importers, and exporters — R idiom only needs to be handled at the thin binding layer (returning `data.frame` where appropriate, accepting R-native types in arguments). The trade-off is that R users need the Rust toolchain at install time, partially mitigated by CRAN binary distribution. The decision to go wrapper-first vs. native-first will be made by prototyping the wrapper and evaluating its ergonomics; that decision happens after Python lands.

**Why is TypeScript still the generator if `conformance/` is the spec?**

Two impls means somebody has to be the source of the regenerator. TS is it for now because that's what exists. The promotion to a spec is about *authority*, not *source*: TS regenerates, but its output goes through human review and second-impl verification before merging. The eventual end-state is "any implementation can regenerate; the corpus is canonical." Until a second implementation has an equivalent generator, TS keeps that role.
