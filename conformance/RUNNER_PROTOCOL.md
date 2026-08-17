# Conformance runner protocol

Every language port of `40kdc-data` ships a small **runner** binary that the cross-implementation differ in `tooling/parity/` drives. Runners exist so a single harness can replay the conformance corpus against any pair of implementations and assert byte-equal results — they are not part of the public API of any port.

This document is the protocol contract. Changes to it bump [`SPEC_VERSION`](./SPEC_VERSION).

## Status

The protocol is implemented in TypeScript (`tools/src/runner.ts`), Rust
(`crates/wh40kdc/src/bin/wh40kdc-runner.rs`), Python
(`python/src/wh40kdc/runner.py`, invoked as `python -m wh40kdc.runner`), and Go
(`go/cmd/wh40kdc-runner`); all report the `spec_version` in
[`SPEC_VERSION`](./SPEC_VERSION). The cross-impl differ in `tooling/parity/`
drives any pair of runners against the corpus
(`--pair ts,rust | ts,py | rust,py | ts,go | rust,go | py,go`).

## Wire format

Runners are stdin/stdout processes. The differ launches a runner once and reuses it for an entire corpus run — **no per-case process invocation** (R interpreter startup alone would make that intolerable). Communication is newline-delimited JSON (NDJSON):

- The differ writes one request per line on the runner's stdin.
- The runner writes one response per line on its stdout.
- The runner writes diagnostics on stderr; stdout is reserved for protocol messages only.

Each line is exactly one valid JSON object terminated by `\n`. UTF-8, no BOM. Lines are not pretty-printed.

## Handshake

The first request after launch is always:

```json
{"op":"init","spec_version":1,"locale":"C","tz":"UTC","seed":0}
```

The runner responds with:

```json
{"ok":true,"value":{"impl":"ts","spec_version":1,"impl_version":"0.4.2"}}
```

The differ fails the run if `spec_version` doesn't match between the request and the response, or if the runner's reported `impl_version` doesn't match what the differ expected based on the implementation under test. `impl` is one of `"ts"`, `"rust"`, `"py"`, `"r"`.

After a successful init the runner must honor the negotiated `locale`, `tz`, and `seed` for all subsequent requests. Implementations that cannot constrain these (e.g., a library that reads `$LANG` internally) must fail the init.

## Operations

After init, the differ issues operation requests. Every request has shape `{"op":"<name>","args":{…}}` and every response has shape `{"ok":true,"value":…}` or `{"ok":false,"error_kind":"<enum>","error_payload":…}`.

The minimum op set:

### `normalize`

```json
{"op":"normalize","args":{"input":"Khârn the Betrayer"}}
```

Response value is a string. Equivalent to TS `normalizeName(input)` / Rust `normalize_name(input)`.

### `import`

```json
{"op":"import","args":{"format":"newrecruit-wtc-compact","input":"…raw text or JSON-stringified object…"}}
```

`format` is one of `listforge`, `newrecruit-json`, `newrecruit-wtc-compact`, `newrecruit-wtc-full`, `newrecruit-simple`, `rosterizer`, `gw`. The `input` field is always a string — JSON formats carry their payload as a JSON-encoded string, text formats carry the raw text. Response value is the resolved `Roster` shape (matches `expected.roster.json` goldens after stripping `source` and `diagnostics` for non-canonical inputs — see CONFORMANCE.md).

A `tryImport` op also exists for auto-detection cases:

```json
{"op":"try_import","args":{"input":"…raw payload…"}}
```

The response value includes the detected `format` plus the imported roster.

### `export`

```json
{"op":"export","args":{"format":"newrecruit-wtc-compact","roster":{…Roster…}}}
```

`format` is one of `newrecruit-json`, `newrecruit-wtc-compact`, `newrecruit-wtc-full`, `newrecruit-simple`, `roster-json`, `rosterizer`, `atc-2026-compact`, `atc-2026-full`. The last two are **export-only** (no matching `import` format) — they reuse the WTC bodies under the ATC 2026 list-submission header. Response value is a string — the exported roster in the requested format. The differ asserts string equality across implementations.

### `linked_query`

```json
{"op":"linked_query","args":{"query":"abilities_of","input":{"unitId":"intercessor-squad"}}}
```

The `query` enum covers the read paths on `Dataset`:

| `query`                  | `input`                              | result type |
|--------------------------|--------------------------------------|-------------|
| `find_unit`              | `{"query":"<string>"}`               | unit id or null |
| `find_weapon`            | `{"query":"<string>"}`               | weapon id or null |
| `find_faction`           | `{"query":"<string>"}`               | faction id or null |
| `find_ability`           | `{"query":"<string>"}`               | ability id or null |
| `abilities_of`           | `{"unitId":"<id>"}`                  | ordered list of ability ids |
| `weapons_of`             | `{"unitId":"<id>"}`                  | ordered list of weapon ids |
| `wargear_options_of`     | `{"unitId":"<id>"}`                  | ordered list of wargear-option ids |
| `base_loadout`           | `{"unitId":"<id>","modelCount":"<n>"}` | sorted list of `"id:count"` strings |
| `maximal_loadout`        | `{"unitId":"<id>","modelCount":"<n>"}` | sorted list of `"id:count"` strings |
| `phases_of`              | `{"abilityId":"<id>"}`               | ordered list of phase enum values |
| `faction_of`             | `{"unitId":"<id>"}`                  | faction id or null |
| `abilities_of_faction`   | `{"factionId":"<id>"}`               | ordered list of ability ids |
| `weapons_of_faction`     | `{"factionId":"<id>"}`               | ordered list of weapon ids |
| `eligible_abilities`     | `{"input":…,"phase":"<phase>"}`      | ordered list of `{kind, abilityId}` |

Ordering semantics for each query are documented per-area in `CONFORMANCE.md`. The runner protocol itself is opaque to whether the order is load-bearing — it simply emits whatever the implementation's public API returns.

### `check_unit_legality`

```json
{"op":"check_unit_legality","args":{"unitId":"chaos-terminators","factionId":"world-eaters","modelCount":10,"counts":{"reaper-autocannon":2}}}
```

Tier-aware whole-unit loadout legality (the `roster_legality` corpus). `unitId` is resolved in `factionId` when supplied (shared chassis diverge per faction), else first-wins; the unit's faction-scoped composition supplies the `models` envelope and the discrete `tiers`. `counts` maps weapon/wargear id → count. The response `value` is the violation list as **sorted `"code:id"` strings** (codes: `exceeds-max`, `below-min`, `swap-conflict`, `exceeds-allowance`, `invalid-model-count`); an empty array means legal.

### `check_roster_legality`

```json
{"op":"check_roster_legality","args":{"factionId":"world-eaters","battleSize":"strike-force","forceDisposition":"purge-the-foe","detachments":[{"id":"berzerker-warband"}],"units":[{"unitId":"daemon-prince-of-khorne","modelCount":1,"isWarlord":true,"enhancementId":null,"leaderBodyguardId":null,"counts":{}}]}}
```

Whole-army legality over a compact roster spec (the `roster_validation` corpus). Points and detachment-point costs are looked up from the dataset (not caller-supplied). Each unit carries `unitId`, `modelCount`, `isWarlord`, `enhancementId` (or null), `leaderBodyguardId` (or null), and `counts` (weapon/wargear id → count, fed to the per-unit loadout check). The response `value` is **sorted `"<scope>|<severity>|<code>:<id>"` strings**: `scope` is `army` for army-wide violations or `u<index>` (0-based into `units`) for unit-scoped ones; `severity` is `error` or `warn`. A roster is **legal iff it has no `error` entries** (a warn-only result is legal). Codes — per-unit loadout (as above, all `error`); army-construction `error`: `enhancement-wrong-detachment`, `enhancement-on-non-character`, `enhancement-keyword-mismatch`, `enhancement-excluded-keyword`, `enhancement-over-max-targets`, `leader-attachment-illegal`, `leader-must-attach`, `points-over-limit`, `detachment-points-over`, `detachment-tag-conflict`, `detachment-restriction-required`, `detachment-restriction-excluded`, `no-warlord`, `multiple-warlords`, `unit-minimum-unmet`; and `warn` (advisory — provisional 11e Force-Disposition data): `disposition-not-picked`, `disposition-invalid`.

### `candidate_affordability`

```json
{"op":"candidate_affordability","args":{"factionId":"world-eaters","battleSize":"strike-force","pointsLimitOverride":null,"units":[{"unitId":"chaos-terminators","modelCount":5}],"candidateUnitIds":["jakhals","chaos-terminators"]}}
```

Cheapest-next-copy pricing + affordability for a set of candidate units (the `affordability` corpus). The points limit is `pointsLimitOverride` when set, else the battle-size default; `remaining = limit − Σ baseUnitPoints(current, ordinal) − Σ enhancement cost`. For each candidate, `nextCopyCost` is the ordinal-aware cheapest entry cost (the minimum over its points tiers of `baseUnitPoints(unit, tier.models, nextOrdinal)`, where `nextOrdinal` counts existing copies of that datasheet + 1), and `affordable = nextCopyCost ≤ remaining`. `candidateUnitIds` defaults to every unit in `factionId` when omitted. The response `value` is `[{ "unitId", "nextCopyCost", "affordable" }]` sorted ascending by `(nextCopyCost, unitId)`.

### `validate`

```json
{"op":"validate","args":{"target":"unit","value":{…raw entity…}}}
```

Response value is a list of error objects: `[{"path":"/profiles/0/Sv","code":"RANGE_VIOLATION"}]`. The empty list means "valid." Error message strings are intentionally not part of the protocol.

`code` is drawn from a closed enum:

- `REQUIRED_MISSING` — a schema-required property is absent. `path` is the parent path plus `/` plus the missing property name.
- `TYPE_MISMATCH` — value's JSON type doesn't satisfy the schema's `type` keyword.
- `ENUM_VIOLATION` — value isn't in the schema's `enum`.
- `PATTERN_MISMATCH` — string doesn't match the schema's `pattern` or `format` keyword.
- `RANGE_VIOLATION` — number outside the schema's `minimum` / `maximum` / `exclusiveMinimum` / `exclusiveMaximum`, or string/array outside `minLength` / `maxLength` / `minItems` / `maxItems`.
- `ADDITIONAL_PROPERTY` — object has a property not allowed by `additionalProperties: false`.
- `UNIQUE_VIOLATION` — array with `uniqueItems: true` has a duplicate.

Adding a new code is a semantic change to the spec and bumps `SPEC_VERSION`. `target` is one of `unit`, `weapon`, `faction`, `ability`, `wargear`, `wargear-option`; more schemas can be added as needed.

### `crunch`

```json
{"op":"crunch","args":{
  "attacker":{"weaponId":"bolt-rifle","profileIndex":0},
  "modelsFiring":5,
  "target":{"unitId":"intercessor-squad","profileIndex":0},
  "context":{"phase":"shooting","attackerStationary":false,"withinHalfRange":false},
  "buffs":[]
}}
```

Response value is the engine output with the `stages` array. The differ compares per-stage floats with tolerance `5e-4` (see CONFORMANCE.md for the reduction-order invariant).

### `attribution`

```json
{"op":"attribution","args":{
  "attacker":{"weaponId":"bolt-rifle","profileIndex":0},
  "modelsFiring":5,
  "target":{"unitId":"intercessor-squad","profileIndex":0},
  "context":{"phase":"shooting","attackerStationary":false,"withinHalfRange":false},
  "buffs":[],
  "epsilon":1e-6
}}
```

Same input envelope as `crunch`, plus an optional `epsilon` (default `1e-6`)
below which lifts and residuals collapse to zero. Response value is the array of
`AttributedStage`s — the per-stage leave-one-out decomposition documented in
[`CONFORMANCE.md`](../CONFORMANCE.md#attributioncasesjson). Floats compare with
`±5e-4` per value (`expected`, `baseline`, `residual`, each `lifts[].delta`);
`lifts` order is load-bearing (groups appear in first-seen order from the input
`buffs` array). `BuffSource` values inside `lifts[].source` use the serde
kind-tagged discriminated union (`"manual"` / `"ability"` / `"weapon-keyword"`
with camelCase fields).

### `translate_scoring`

```json
{"op":"translate_scoring","args":{"cardId":"death-trap"}}
```

Looks up the `secondary-card` with id `cardId` in the embedded dataset and
humanizes its scoring `awards` into plain English. Response value is
`{"awards": ["<line>", …]}` — one ASCII string per award, **in the card's
`awards` array order** (the order is load-bearing). Equivalent to TS
`describeScoringCard(card)` / Rust `describe_scoring_card(&card)`. The differ
compares the value structurally (exact string equality, no tolerance). An
unknown `cardId` returns `error_kind: "UNKNOWN_ENTITY"`. Only `card_type:
"primary"` cards are exercised by the corpus today (the secondary deck isn't
revealed yet, but the op works for any card present in the dataset).

### `translate_effect`

```json
{"op":"translate_effect","args":{"effect":{"type":"feel-no-pain","target":"unit","modifier":{"threshold":5}},"scope":{"range":"unit","duration":"phase"}}}
```

Humanizes an Ability-DSL `effect` tree (plus an optional `scope` and optional
`applies_to`) into the generated plain-English approximation — the dataset's
"ability.print()". The `effect` is embedded in the request verbatim (no dataset
lookup, so parity is independent of duplicate-ability-id resolution); `scope`
and `applies_to` may each be omitted or `null`. Response value is
`{"text": "<multi-line ASCII string>"}` — container nodes render block-style
with two-space indentation and an ASCII `-> ` arrow, the scope renders as a
`Scope: …. Duration: ….` line, and a present `applies_to` filter renders as a
trailing `Applies to: units with <kw>[, …][ (excluding <kw>[, …])].` line
(`required_keywords` is an AND set; an empty filter renders no line). Equivalent
to TS `describeAbility({effect, scope, applies_to})` / Rust
`describe_ability_parts(&effect, scope.as_ref(), applies_to.as_ref())`. The
differ compares the value structurally (exact string equality). A non-object
`effect` returns `error_kind: "INVALID_INPUT"`.

### `match_applies_to`

```json
{"op":"match_applies_to","args":{"applies_to":{"required_keywords":["Possessed"]},"units":[{"id":"eightbound","keywords":["Possessed"],"faction_keywords":["World Eaters"]}]}}
```

Resolves the roster-highlighting scope of a curated `applies_to` keyword filter
against a set of units, the data-free contract a list builder replicates to tint
the units a detachment rule benefits. For each unit, the filter matches iff the
unit carries every `required_keywords` entry and none of the `excluded_keywords`,
compared against the **union of its `keywords` and `faction_keywords`**
(exact-string, case-sensitive). `applies_to` may be `null` (no resolvable scope →
matches nothing) or `{}` (no constraints → matches every unit). Response value is
`{"matchedIds": [<id>, …]}`, the matching unit ids **in input order**. Equivalent
to filtering with TS `unitMatchesAppliesTo` / Rust `unit_matches_applies_to` /
Python `unit_matches_applies_to`. The differ compares structurally (exact, order
preserved). A non-array `units` returns `error_kind: "INVALID_INPUT"`.

### `score_event`

```json
{"op":"score_event","args":{"cardId":"battlefield-dominance","approach":"tactical","asserted":[{"index":0},{"index":1,"count":3}],"roundCap":15}}
```

Scores one asserted set of a card's `awards` under `approach` (`"fixed"` or
`"tactical"`). `asserted` references awards by `index` into the card's full
`awards` array (approach affects only the cap, never which indices are valid);
`count` defaults to 1 and matters only for `vp_per` awards. Response value is
`{"turn": <int>, "cap": <int|null>, "banked": <int>, "primaryBanked"?: <int>}`:
`turn` is the asserted total (exclusive-group "highest only", `vp_per × count`
clamped to `per_max`, cumulative rows summed); `cap` is the per-score ceiling
(tactical = 5, fixed = max printed `vp_max` or **`null` when uncapped** — there
is no JSON `Infinity`); `banked = min(turn, cap)`. `primaryBanked = min(turn,
roundCap)` is present only when `roundCap` is supplied (primary scoring has no
tactical 5-cap). Equivalent to TS `scoreTurn`/`scoreCap`/`scoreSecondaryEvent`/
`scorePrimaryEvent` / Rust `score_turn`/`score_cap`/`score_secondary_event`/
`score_primary_event`. Unknown `cardId` → `UNKNOWN_ENTITY`; an out-of-range
`asserted.index` → `INVALID_INPUT`.

### `score_state`

```json
{"op":"score_state","args":{"approach":"tactical","ops":[{"kind":"set-primary","round":1,"vp":30,"roundCap":15,"gameCap":45},{"kind":"draw","cardId":"no-prisoners"},{"kind":"score-secondary","cardId":"no-prisoners","round":2,"asserted":[{"index":0,"count":3}]},{"kind":"remove-score","index":0}]}}
```

Replays `ops` over a fresh `PlayerGame` and returns its state plus derived
totals: `{"rounds":[{"primary":<int>,"secondary":<int>}, …5],"handIds":[<string>,
…],"log":[{"cardId":<string>,"round":<int>,"vp":<int>}, …],"primary":<int>,
"secondary":<int>,"total":<int>}`. Op kinds: `draw` (`cardId`); `score-secondary`
(`cardId`, `round`, `asserted`, `roundCap?`, `gameCap?`) banks `min(turn, cap)`,
clamped by the optional per-round and per-game secondary ceilings, logs it,
discards from hand; `score-primary` (`cardId`, `round`, `asserted`, `roundCap?`, `gameCap?`)
stores the round's raw `scoreTurn` through the cap clamp; `set-primary` (`round`,
`vp`, `roundCap?`, `gameCap?`) clamps `vp` to the round cap **and** the remaining
per-game room; `remove-score` (`index`) reverses a logged scoring. `total` is
`min(100, primary + secondary)`. **Op order is load-bearing.** Unknown `cardId`
→ `UNKNOWN_ENTITY`; malformed op → `INVALID_INPUT`.

### `wtc_result`

```json
{"op":"wtc_result","args":{"a":100,"b":49}}
```

Maps two grand totals onto the WTC 20-point result. Response value is
`{"a": <int>, "b": <int>}` summing to 20. Equal totals → 10-10; margin 0-5 →
10-10; then one band per 5 VP (`10 ± ceil((diff−5)/5)`), capped at 20-0 for a
51+ differential. Equivalent to TS `wtcResult(a, b)` / Rust `wtc_result(a, b)`.

### `resolve_terrain`

```json
{"op":"resolve_terrain","args":{"layout":{…TerrainLayout…},"templates":[{…TerrainTemplate…}, …]}}
```

Resolves a template-anchored terrain layout to absolute board-space polygon
vertices (board inches, y-down). `layout` is a `terrain-layout` document;
`templates` is the catalog its piece `template` references resolve against
(passed inline so the op is dataset-independent). Response value is
`{"pieces": [{"id": <string|null>, "name": <string|null>, "piece_type":
"area"|"feature", "floor": <int>, "vertices": [{"x": <num>, "y": <num>}, …]},
…]}`.

Pieces are emitted in `layout.pieces` order; an area piece that instances a
template carrying composed `features` emits those features immediately after it,
in template-declaration order. Vertices are rounded to 4 dp; the differ compares
them with float tolerance (`5e-4`) and the identity fields exactly. Equivalent
to TS `resolveLayout(layout, templates)` / Rust `resolve_layout(&layout,
&templates)`. A layout that references a missing template, or a piece with
neither `footprint` nor `template`, returns `error_kind: "INVALID_INPUT"`.

The transform contract (mirror → rotate → translate about the footprint
centroid; clockwise rotation in the y-down frame) is specified in CONFORMANCE.md
under the `terrain-resolver` per-area invariants.

### `keystones`

```json
{"op":"keystones","args":{"layout":{…TerrainLayout…},"templates":[{…TerrainTemplate…}, …],"board":{"width":60,"height":44}}}
```

Derives the printed distance of every authored measurement keystone in the
layout (a keystone on a piece is `{"edge": "left"|"right"|"top"|"bottom",
"ref": {"kind":"vertex","index":<int>} | {"kind":"face","side":
"min-x"|"max-x"|"min-y"|"max-y"}}`). `board` is optional and defaults to the
40kdc standard 60 × 44 inches. Response value is `{"measurements":
[{"piece_index": <int>, "piece_id": <string|null>, "edge": <edge>, "ref":
<ref>, "distance": <num>}, …]}`, in `layout.pieces` order then per-piece
keystone order.

The layout resolves through `resolve_terrain`'s pinned transform first; near
edges (`left`/`top`) read the feature's board coordinate directly, far edges
(`right`/`bottom`) read the remaining extent. Distances are rounded to 4 dp
and compared with the `5e-4` float tolerance; identity fields exactly.
Equivalent to TS `keystoneMeasurements(layout, templates, board)` / Rust
`keystone_measurements(&layout, &templates, board)`. A vertex index out of
range or a face whose axis disagrees with the edge returns `error_kind:
"INVALID_INPUT"`, as do resolver failures.

### `share_encode`

```json
{"op":"share_encode","args":{"list":{…ShareList…}}}
```

Encodes a `ShareList` into a `share-v1` compact share token (registry-indexed
varints, base64url; see `tools/docs/share-token.md`). Response value is the
token **string** — the differ asserts byte-for-byte string equality across
implementations. A `ShareList` is `{name, factionId, detachmentIds, battleSize,
disposition, units}` where each unit is `{datasheetId, modelCount, isWarlord,
enhancementId, allyFactionId, allyRuleId, attachedToOrdinal, grants, loadout}`
and `loadout` is an array of `[wargearId, count]` pairs. An id absent from the
embedded share registry returns `error_kind: "INVALID_INPUT"`. Equivalent to TS
`encodeShareToken(list)` / Rust `encode_share_token(&list)` / Python
`encode_share_token(list)`.

### `share_decode`

```json
{"op":"share_decode","args":{"token":"AQESU3Ry…"}}
```

Decodes a `share-v1` token against the embedded registry. Response value is the
decode result — `{"ok":true,"list":{…ShareList…}}` or
`{"ok":false,"reason":"malformed"|"stale-registry"}`. A malformed or stale token
is a normal result, **not** a protocol error (so the inner `ok` is part of the
compared value). `stale-registry` means the token references a slot this
package's registry doesn't have (a token written by a newer registry);
`malformed` covers truncation, a bad format byte, or non-base64url input. The
differ compares the value structurally. Equivalent to TS
`decodeShareToken(token)` / Rust `decode_share_token(token)` / Python
`decode_share_token(token)`.

### `shutdown`

```json
{"op":"shutdown"}
```

Runner responds with `{"ok":true,"value":null}` and exits with code 0. The differ uses this for clean teardown; SIGKILL is the fallback if shutdown hangs.

## Error envelope

Every error response uses this shape:

```json
{"ok":false,"error_kind":"INVALID_INPUT","error_payload":{"detail":"…free-form, never compared…"}}
```

`error_kind` is a closed enum:

- `INVALID_INPUT` — malformed args for the requested op.
- `UNKNOWN_OP` — op name not recognized by this runner version.
- `UNKNOWN_ENTITY` — requested unit/weapon/ability/faction id not present in the embedded dataset.
- `IMPORT_FAILED` — adapter could not parse the input (importer-level failure, distinct from dataset-resolution failure).
- `EXPORT_FAILED` — serializer error.
- `VALIDATION_ERROR` — schema validator itself failed (the validator threw, not "input was invalid" — that returns `ok:true` with an error list).
- `CRUNCH_ERROR` — engine refused to run (e.g., target has no save profile).
- `INTERNAL_ERROR` — a bug in the runner that should never fire.

Adding a new `error_kind` is a semantic change to the spec and bumps `SPEC_VERSION`. Cross-implementation tests assert on `error_kind`, never on `error_payload`.

## Batching

The differ may pipeline requests — it does not wait for a response before sending the next request. Runners must handle this: parse stdin line by line, respond in order, never reorder responses. Implementations whose host language doesn't allow line-buffered stdout (R, looking at you) must explicitly flush after each response.

## Determinism

After init, runners must produce identical responses for identical requests across runs. Concretely:

- No reliance on system time, hostname, PID, or environment variables not surfaced through the `init` envelope.
- Iteration order over hash-based collections must be stable (use ordered maps or sort before emitting).
- Any randomness (currently only property-fuzz inputs from the differ side) is seeded via the `init` envelope's `seed`.

## Open questions

- Whether `crunch` should take an inline weapon/unit shape (full struct) in addition to id references. Today the corpus only uses id references; if Python's downstream users want to run crunch on synthetic entities, the op signature would need a discriminated union.
- Whether `import` should also accept a typed `Roster` shape as input (i.e., re-import from a structured roster, not a serialized string). The use case isn't clear yet.
- Streaming protocol (length-prefixed framing) versus NDJSON for the larger payloads (full roster exports). NDJSON works as long as no payload contains a literal newline outside a JSON string, which is guaranteed by JSON's grammar. Defer the switch until a concrete problem appears.
