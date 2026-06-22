# CLAUDE.md

## Project Overview

40kdc-data is two things for the
[40kdc](https://40kdc.alpacasoft.dev) ecosystem:
(1) the shared **schema layer** — JSON Schema files that model Warhammer 40K game
entities plus community-authored enrichment data describing what abilities do
(without reproducing copyrighted text); and (2) a **data-distribution package**
(`@alpaca-software/40kdc-data`) that ships the whole dataset embedded behind a
linked, typed API — find a unit, follow it to its weapons, abilities, phases, and
faction. The package also re-exports the generated entity types and an AJV
validator (a secondary feature; the package's primary purpose is data access).

This is a community-created dataset that mirrors Games Workshop's datasheet
structure. Stat lines and point costs are numerical facts and are included.
Ability text, rules text, and artwork are never stored — the Ability DSL is a
community-authored structured representation of game mechanics.

## Repository Structure

```
schemas/
  $defs/            Shared definitions (entity-id, keyword, stat-value, phase, etc.)
  core/             Structural entity schemas:
                      faction, unit, weapon, game-version,
                      detachment, enhancement, stratagem,
                      wargear-option, leader-attachment, unit-composition
  enrichment/       Community-authored intelligence:
    ability-dsl/      Ability DSL (ability, trigger, condition, effect, scope)
    *.schema.json     Phase-mapping, interaction-flag
data/
  core/_example/    Fabricated example data (not real GW data)
  enrichment/       Community enrichment data by edition/dataslate
tools/              TypeScript package @alpaca-software/40kdc-data:
                      src/data/       Linked typed API (Dataset, collections, views)
                      src/codegen-data.ts  Bundles data/ into the embedded module
                      src/generated.ts     Entity types (codegen'd from schemas)
                      schema-loader/cli    AJV validator + 40kdc-validate CLI
                      docs/api/       Auto-generated API reference (TypeDoc)
```

## Schema Conventions

- JSON Schema draft 2020-12.
- `$id` values: `https://40kdc.dev/schemas/{path}/{name}.schema.json`.
- Entity IDs: kebab-case matching `^[a-z0-9][a-z0-9-]*[a-z0-9]$`.
- Cross-schema refs use `$ref` with relative paths to `$defs/`.
- Nullable fields: `oneOf: [{ ...type }, { type: "null" }]`.
- `additionalProperties: false` on all entity schemas.
- Data files are JSON arrays — each element is one entity.
- File naming: plural entity name (e.g., `factions.json`, `stratagems.json`).
- Game phases: `command`, `movement`, `shooting`, `charge`, `fight` (the 5
  official 10th edition phases — no "morale", no "pregame" at the core level).
- Every entity carries a `game_version` ref (edition + dataslate) for
  multi-edition support.

## IP Safety

- NEVER commit GW ability text, rules text, or artwork.
- Ability DSL entries must be community-authored mechanic descriptions.
- Stat lines and points values ARE permitted (numerical facts).
- Example data in `_example/` directories uses fabricated names only.
- FAQ references cite the document, not reproduce its text.

## Licensing

- `schemas/`: CC0 (public domain)
- `data/enrichment/`: CC BY 4.0 (attribution required)
- `tools/`: MIT

## Validation

**The one pre-push gate is `just preflight`** (root `Justfile`, or `npm run
preflight` from `tools/`). It reproduces locally every check
`.github/workflows/validate.yml` fails on — for the data/library/parity jobs:
it regenerates all four-language artifacts in order, formats Rust/Go, runs the
TS/Rust/Python/Go suites + conformance, then gates on `git diff` of the
generated artifacts and on the four-file version lockstep. A green preflight
means a green CI. (It does **not** run CI's `examples`/`sync-worker` app jobs —
run those with their own workspace commands when you touch those apps. It needs
node, cargo, python3 + the `.[dev]` extras, and go on PATH.)

For quick inner-loop checks:

```bash
cd tools
npm install
npm test           # unit tests (vitest)
npm run validate   # validate all data files against schemas
```

CI runs on every push and PR via `.github/workflows/validate.yml`.

`npm test`/`npm run validate` are **not** sufficient before pushing — CI also
diff-checks committed generated artifacts and Rust formatting, which those
commands don't touch. `just preflight` covers all of it; the per-change
regen commands below are the manual equivalents:

- **Changed anything under `data/`** → regenerate the embedded bundles, or the
  `Validate Data` job's "artifacts up to date" steps fail:
  ```bash
  cd tools && npm run bundle:schemas
  cargo run -p xtask -- codegen        # crates/.../generated.rs (only drifts if schemas/ changed)
  cargo run -p xtask -- bundle-data    # crates/.../data/bundle.generated.json
  python3 python/codegen/sync_bundle.py  # python/.../_bundle.json
  bash go/codegen/sync.sh                 # go/{bundle.json,share_registry.json,schemas/,spec.go}
  ```
  (`npm run build`/`test` regenerate the TS bundle via `codegen:data`, but
  **not** the Rust/Python/Go ones.)
- **Edited any Rust** → run `cargo fmt --all` (CI runs `cargo fmt --all -- --check`).
- **Edited any Go** → run `gofmt -w go/` (CI runs `gofmt -l go/`).
- **Changed `schemas/`** → also `npm run codegen:types` (TS `generated.ts`),
  the Python `gen_typeddicts.py`, and `bash go/codegen/sync.sh` (copies the
  schema tree the Go validator embeds); CI diff-checks all.

Referential integrity beyond JSON Schema (unit `ability_id`s must resolve in the
same faction's enrichment; `faction_keywords` must match the faction's home
keyword) is enforced by `tools/src/integrity.ts`, run as part of
`npm run validate`.

## Cross-language parity

This repo holds the TypeScript, Rust, Python, and Go implementations in parity through the `conformance/` corpus, and the same mechanism extends to the upcoming R port. Full strategy: [`CONFORMANCE.md`](CONFORMANCE.md). Contributor workflow: [`CONTRIBUTING.md`](CONTRIBUTING.md). Runner wire format: [`conformance/RUNNER_PROTOCOL.md`](conformance/RUNNER_PROTOCOL.md).

The load-bearing rule: **a new or changed golden in `conformance/` is not accepted until at least one implementation other than the one that produced it independently reproduces the same expected value.** A PR that touches the TS reference impl and the corpus in the same commit must also include the Rust (or Python, or R) test passing against the updated goldens. The same person can do both halves of the verification.

`conformance/SPEC_VERSION` (single integer) bumps for any semantic corpus change — new case, changed expected value, removed case, runner-protocol change, per-area invariant change. Pure formatting changes don't bump it. Each implementation embeds the version it was tested against.

When editing the corpus or changing behavior that the corpus pins, read the per-area invariants in `CONFORMANCE.md` first — several ordering and reduction-order details are deliberate contracts, not incidental output.

## Adding a New Schema

1. Create the schema file in `schemas/core/` or `schemas/enrichment/`.
2. Set `$id` following the URL convention.
3. Reference shared definitions from `schemas/$defs/common.schema.json`.
4. Add an example data file in `data/{core,enrichment}/_example/`.
5. Add the file-prefix → schema-id mapping in `tools/src/validate.ts` SCHEMA_MAP.
6. Add the `$id` expectation to `tools/test/schema-loader.test.ts`.
7. Add valid/invalid test fixtures to `tools/test/fixtures/`.
8. To expose the new entity in the data package, add it in three places:
   the `RawData` interface + `emptyRawData()` in `tools/src/data/types.ts`, the
   filename→collection mapping in `tools/src/codegen-data.ts`
   (`FILE_TO_COLLECTION`), and a `Collection`/array field in
   `tools/src/data/dataset.ts` (+ an export in `tools/src/data/index.ts`).
9. Run `npm test && npm run validate`.

## For Downstream Consumers

Tools can consume this repo via:
- npm dependency on `@alpaca-software/40kdc-data` (embedded dataset + linked
  typed API + ListForge and NewRecruit importers + roster exporters for the
  same five formats + generated types + validator) — the primary path for
  JS/TS tools
- the `wh40kdc` Rust crate (`crates/wh40kdc`) — the Rust counterpart:
  generated types, the same embedded dataset behind a `Dataset` linked API,
  the ListForge + NewRecruit (JSON / wtc-compact / wtc-full / simple)
  importers, and the matching roster exporters. Default features
  `bundled-data`/`import`/`export`; `default-features = false` drops to
  types-only, and `--features export` alone is decode-free (no
  `base64`/`flate2`/`regex`) for embedded targets. The Rust and TS
  implementations are pinned together by the shared `conformance/` corpus,
  including byte-identical export goldens.
- the `wh40kdc` Python package (`python/`, PyPI) — the Python counterpart:
  the same embedded dataset behind a `Dataset` linked API (plain dicts +
  generated TypedDicts), all importers/exporters, cruncher + attribution,
  abilities resolver, scoring, terrain, the DSL/scoring describers, and a
  `jsonschema`-based validator with the closed-enum codes. Only runtime dep
  is `jsonschema`; conformance-pinned with TS and Rust via the same corpus
  (runner: `python -m wh40kdc.runner`).
- the `wh40kdc` Go module (`go/`, `github.com/wn-mitch/40kdc-data/go`) — the Go
  counterpart: the same embedded dataset behind a `Dataset` linked API (records
  as plain `map[string]any`), all importers/exporters, cruncher + attribution,
  abilities resolver, scoring, terrain, the DSL/scoring describers, and a
  hand-rolled draft-2020-12 validator with the closed-enum codes. Only external
  dep is `golang.org/x/text`; conformance-pinned with TS/Rust/Python via the
  same corpus (runner: `go/cmd/wh40kdc-runner`).
- Git submodule pointed at a tagged release (raw schemas + data)
- Direct `$id` URL references for JSON Schema validators

Entity IDs are the interoperability contract. If two tools use
`"space-marines"` as a faction ID, they can exchange data.

For exchanging a *whole list* compactly (e.g. a share URL another tool can
import), the three packages also expose the `share-v1` codec —
`encodeShareToken` / `decodeShareToken` (TS/Python) and
`encode_share_token` / `decode_share_token` (Rust) — which packs a list into a
short, URL-safe token over a versioned id registry. The wire format is
documented in [`tools/docs/share-token.md`](tools/docs/share-token.md) and pinned
across implementations by the `conformance/share/` corpus.

## Related Repositories

- **40kdc-editor**: Web-based UI for authoring enrichment data. Imports schemas
  from this repo for form validation. Changes here affect the editor's forms.
- **Project site**: https://40kdc.alpacasoft.dev

## Data Sources

- **army-assist** (`~/army-assist/src/assets/json/`): Normalized JSON extracted
  from community datasources. Used as source for mechanical data (stats, points,
  keywords, weapons). Contains UUID-based entity IDs. Shared units appear with
  per-faction "views" — select the view whose faction ability matches the target
  faction's faction rule. Run `npx tsx tools/src/convert-faction.ts <faction-id>`
  to regenerate core data from this source (e.g., `convert-faction.ts world-eaters`).
- **game-datacards** (`github.com/game-datacards/datasources`, `10th/json/`):
  community-extracted datasheet text. Source for the **raw-text store backfill**
  (`npm run author:backfill-store`) — populates the out-of-repo `40kdc-abilities`
  store with verbatim prose for ability_ids that have none, **fill-only** (never
  overwrites newer 11e text from `author:ingest`). 10e provenance is stamped on
  each entry. Coverage is tracked by `npm run audit:store-coverage`
  (`data/_audit/store-coverage.md`). As with all raw text, it lands ONLY in the
  out-of-repo store, never in this repo.
- **GW MFM dump** (`_private/dump.json`, gitignored): the official Munitorum Field
  Manual data export — a ~30MB UUID-keyed relational dump (`data_version 867`,
  ~130 tables: datasheets, loadouts, enhancements, detachment rules, stratagems,
  missions). **Authoritative** for the live game; supersedes army-assist →
  convert-faction as the upstream for mechanical data. Run
  `npx tsx tools/src/ingest-mfm.ts <subcommand>` (coverage / dispositions /
  enhancements / points / wargear / wargear-budgets / composition-names /
  composition-tiers / attachment-role / stratagems / missions / cull-legends /
  seed-units) — dry
  run + `_reports/mfm-*.md` report by default, `--write` to apply, unmatched rows
  to `_private/mfm/`. **`seed-units` is the only subcommand that CREATES new units**
  (skeleton id/name/profiles/points/keywords/role/model_count) for dump datasheets
  with no repo entity — every other subcommand only reconciles units that already
  exist. **Because seed-units emits a bare skeleton (no `weapon_ids`/`ability_ids`/
  composition) and the `wargear`/`composition-tiers` passes skip any datasheet
  whose unit didn't yet exist when they ran, a freshly-seeded unit keeps an EMPTY
  loadout until those passes are re-run now that it exists — then its abilities are
  authored.** seed-units prints this follow-through (with the seeded ids) on
  `--write`; the gap is tracked by `npm run audit:loadout-coverage`
  (`data/_audit/loadout-coverage.md`). It files shared-roster children (SM chapters) into their parent dir
  (adeptus-astartes) and, by default, holds back Combat-Patrol-box datasheets
  (`Combat Patrol: X` publications); pass `--include-combat-patrol` to seed those. Both modes apply the same in-memory mutations and route the
  projected file contents through `mfm/apply.ts` `applyWrites`, which validates
  the whole projected dataset (AJV + `integrity.ts`, the same checks as
  `npm run validate`) and **throws on any failure in either mode** — so a clean
  dry run guarantees a clean `--write`, and `--write` persists atomically
  (all-or-nothing) only after validation passes. The loader/faction-map live in
  `tools/src/mfm/`. Models 11e
  per-army-ordinal pricing via `unit_count_min`/`unit_count_max` on unit `points`.
  Numeric/structural fields land in the repo; GW prose routes to the out-of-repo
  store. NB: unrelated to the NewRecruit roster-builder import/export feature
  (`tools/src/{import,export}/newrecruit-*`), which keeps that name. The
  `attachment-role` subcommand (`mfm/attachment.ts`) is the **authoritative**
  source for unit `attachment_role` (leader/support) and `leader-attachments.json`
  eligibility, read from the dump's `datasheet_bodyguard_group` — it supersedes the
  10e `known-support-10e.ts` scrape (kept only as the fallback for dump-absent
  units). Leader-wins for the handful of datasheets the dump marks both
  leader+support (their support rows are detachment-scoped, which the flat
  `attachment_role` can't model); eligibility is merged by `leader_id` so the dump
  wins where it speaks and hand-curated records survive where it is silent.

## Ability ids, the raw-text store, and share tokens

- **Canonical ability_id pattern.** Detachment-scoped entities
  (stratagems, enhancements, detachment rules) use `<name-slug>-<detachment-slug>`
  (e.g. `prioritised-eradication-might-of-the-moritoi`) — the **full** detachment
  slug, applied even when the name is unique. This is required: stratagem/enhancement
  names repeat across detachments (e.g. two different `flawless-construction`s), so a
  bare name-slug collides. Unit/faction abilities (no detachment) stay bare
  (`deep-strike`, `oath-of-moment`). Run `npm run author:reconcile` to keep links in sync.
- **Raw-text store shape.** The out-of-repo `40kdc-abilities` store is keyed by
  `ability_id ?? id` (the app's lookup). **Stratagems** carry structured
  `when`/`target`/`effect`/`restrictions` (cost lives in core `cp_cost`, not the
  store); unit abilities + enhancements carry a single `raw_text` string. Fill
  precedence: an 11e PDF entry (`source.kind: pdf`) supersedes a game-datacards 10e
  entry; both are fill-only and never clobber existing 11e prose.
- **Two backfill sources.** `npm run author:backfill-store` pulls 10e text from
  game-datacards (fill-only). `npm run author:backfill-store`'s sibling
  `extract-pack-store` pulls **11e** text from the faction-pack PDFs in
  `_private/sources/` — this is the authoritative source for new-detachment content
  game-datacards lacks. After either, regenerate `index.json`
  (`tsx tools/src/build-abilities-index.ts`) and re-check `audit:store-coverage`.
- **Share tokens (`data/share-registry.json`).** The list-builder encodes lists as
  integer indices into this append-only registry (see `tools/docs/share-token.md`).
  **Renames are NOT just tombstones** — they MUST be added to the `aliases` map
  (`old-id → new-id`, applied on decode) or old share links break. Any id rename
  must populate `aliases` and re-run `npm run registry:build`, then regen the
  registry artifacts (`codegen:data` for TS, `cargo run -p xtask -- bundle-data` for
  Rust, `python codegen/sync_bundle.py`, `bash go/codegen/sync.sh`). Order matters:
  `registry:build` BEFORE `codegen:data` (which embeds the registry).

## PDF ingestion — always use the coordinate path (needs poppler)

**Source order:** prefer structured sources over PDFs. game-datacards 10e carries
both the detachment↔rule association and rule text in `rules.detachment[]`
(`reconcile-detachment-rules.ts` joins it; `author:backfill-store` for strat/enh/
unit prose). The PDF path is the **fallback** for new-11e content those sources lack.

**When you do read a pack PDF, use the coordinate foundation — never linearize.**
All pack prose (stratagems, enhancements, detachment rules) goes through
`extractPackCards()` (in `author-input-pack.ts`) → `detachmentSegments` /
`findAnchors` / `captureBody` (`extract-faction-pack.ts`, `pack-blocks.ts`), which
parse `pdftotext -bbox-layout` **per-word coordinates**. Cards are located inside
their detachment's coordinate *region*, so association is positional (not guessed
from the linear stream) and the 2-column layout never interleaves.
- **Do NOT write a new extractor that linearizes with plain `pdftotext -`.** That
  path mis-associates rules (it once put Sisters' "Hymns of Battle" on the wrong
  detachment) and mangles columns/drop-caps. The two store extractors
  (`extract-pack-store`, `extract-detachment-rules`) are built on `extractPackCards`.
- **`-bbox-layout` requires *poppler's* pdftotext.** The XPDF build (Glyph & Cog
  4.00) lacks it; the tools now **fail loudly** telling you to install poppler
  (`choco install poppler` / `brew install poppler` / `apt install poppler-utils`)
  and put it ahead of XPDF on PATH. If you're on XPDF you cannot run these tools.
- **No regex drop-cap repair.** A split drop-cap (`"P yromancy"`) is
  indistinguishable from a stat abbreviation (`"the S of"`, `"the T of"`) by regex;
  repairing it corrupts stat lines. Leave the rare residue; the coordinate path
  keeps most drop-caps intact.
- Pack quirk: new 11e detachments print `<DET> STRATAGEM` (no type word); existing
  ones print `<DET> – <TYPE> STRATAGEM` — match both.

## Authoring-time gotchas (Windows / tooling)

- **`execSync` runs via `cmd.exe` on Windows**, where `^` is the escape char — a git
  ref like `HEAD^` / `<sha>^` becomes `HEAD`/`<sha>`. Use `~1` or the explicit parent
  hash instead.
- Tool path args are resolved against the repo root, not the shell cwd — pass paths
  relative to the repo (or absolute), not `../`-relative from `tools/`.
- The store is a **sibling** repo (`../40kdc-abilities`), not under this one.

## Working with the upstream fork

`origin` is a personal fork; `upstream` is the canonical repo. `main` only ever
mirrors `upstream/main` — never commit to it or PR into it. Feature branches PR to
upstream. Resync with `git switch main && git fetch upstream && git merge --ff-only
upstream/main && git push origin main`. After a feature merges upstream, rebase any
descendant branch with `git rebase --onto main <old-base>` + `--force-with-lease`.
Commit/stash before switching branches — uncommitted changes follow you across `git switch`.

## Versioning

`1.0.0` is the stable baseline (declared when the BSData wargear regen retired the
army-assist lineage and the share registry reached v6). From here:

- **Patch** (`1.0.x`) — bugfixes and corrections to existing data/behavior. This
  is the default for almost everything, and explicitly **includes additive
  tool-surface work that ships alongside a fix**: new package API/functions,
  describer-wording corrections, and the conformance SPEC bumps they require. A
  new export or a moved golden does **not** by itself force a minor.
- **Minor** (`1.x.0`) — **reserved for points/MFM data drops only**: MFM dataslate
  ingests and new faction packs (the content that changes the game data itself).
  The next points change is the next minor; nothing bumps to a minor *before*
  then. Non-data features ride patch releases.
- **Major** (`x.0.0`) — reserved for breaking schema/API/wire-format changes.

The four version files move **together** — `tools/package.json`,
`crates/wh40kdc/Cargo.toml`, `python/src/wh40kdc/_version.py`, and `go/version.go`
(`const Version`). CI (`validate.yml`) hard-fails on any drift between them.

Pre-`1.0.0` share links carry **no** compatibility guarantee; the v6 registry is
the first baseline whose tokens are expected to keep decoding. Past v6, an id
rename must be carried in `data/share-registry.json` `aliases` (see the share-token
section above) rather than tombstoned.

## Commit Style

- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`.
- No scopes.
- Branch names: `wnmitch/<feature-name>`.
- JSON files: 2-space indentation.
