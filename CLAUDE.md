# CLAUDE.md

## Project Overview

40kdc-data is the shared schema layer for the
[Tabletop Developer Consortium](https://tabletop-developer-consortium.github.io).
It defines JSON Schema files that model Warhammer 40K game entities and hosts
community-authored enrichment data that describes what abilities do — without
reproducing copyrighted text.

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
    *.schema.json     Phase-mapping, timing-flag, interaction-flag
data/
  core/_example/    Fabricated example data (not real GW data)
  enrichment/       Community enrichment data by edition/dataslate
tools/              TypeScript validation CLI (@40kdc/validate)
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

```bash
cd tools
npm install
npm test           # unit tests (vitest)
npm run validate   # validate all data files against schemas
```

CI runs on every push and PR via `.github/workflows/validate.yml`.

## Adding a New Schema

1. Create the schema file in `schemas/core/` or `schemas/enrichment/`.
2. Set `$id` following the URL convention.
3. Reference shared definitions from `schemas/$defs/common.schema.json`.
4. Add an example data file in `data/{core,enrichment}/_example/`.
5. Add the file-prefix → schema-id mapping in `tools/src/validate.ts` SCHEMA_MAP.
6. Add the `$id` expectation to `tools/test/schema-loader.test.ts`.
7. Add valid/invalid test fixtures to `tools/test/fixtures/`.
8. Run `npm test && npm run validate`.

## For Downstream Consumers

Tools can reference these schemas via:
- Git submodule pointed at a tagged release
- npm dependency on `@40kdc/validate`
- Direct `$id` URL references for JSON Schema validators

Entity IDs are the interoperability contract. If two tools use
`"space-marines"` as a faction ID, they can exchange data.

## Related Repositories

- **40kdc-editor**: Web-based UI for authoring enrichment data. Imports schemas
  from this repo for form validation. Changes here affect the editor's forms.
- **Consortium site**: https://tabletop-developer-consortium.github.io

## Data Sources

- **army-assist** (`~/army-assist/src/assets/json/`): Normalized JSON extracted
  from community datasources. Used as source for mechanical data (stats, points,
  keywords, weapons). Contains UUID-based entity IDs. Shared units appear with
  per-faction "views" — select the view whose faction ability matches the target
  faction's faction rule. Run `npx tsx tools/src/convert-faction.ts <faction-id>`
  to regenerate core data from this source (e.g., `convert-faction.ts world-eaters`).

## Commit Style

- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`.
- No scopes.
- Branch names: `wnmitch/<feature-name>`.
- JSON files: 2-space indentation.
