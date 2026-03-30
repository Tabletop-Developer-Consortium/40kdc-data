# 40kdc-data

Community-owned data schemas for Warhammer 40,000 developer tooling.

## What This Is

The shared schema layer for the [Tabletop Developer Consortium](https://tabletop-developer-consortium.github.io) ecosystem. Tools built by consortium members reference these schemas for interoperability.

## What This Is Not

This is not a database of game rules. Ability text is never stored here — it's replaced by the [Ability DSL](#ability-dsl), a community-authored structured language that expresses what abilities *do* without reproducing copyrighted text.

Stat lines and point costs are included. These are numerical facts, not creative expression.

## IP Stance

| Content | Included? | Rationale |
|---------|-----------|-----------|
| Stat lines (M, T, W, Sv, etc.) | Yes | Numerical facts |
| Point costs | Yes | Numerical facts |
| Weapon stats (A, S, AP, D) | Yes | Numerical facts |
| Ability text | **No** | Creative expression — replaced by DSL |
| Rules text | **No** | Creative expression |
| Artwork / logos | **No** | Creative IP |

## Quick Start

Validate data against schemas:

```bash
cd tools
npm install
npm run validate
```

Validate only core or enrichment data:

```bash
npm run validate:core
npm run validate:enrichment
```

## Schemas

### Core (structural entities)

| Schema | Description |
|--------|-------------|
| [faction](schemas/core/faction.schema.json) | Playable factions and sub-factions |
| [unit](schemas/core/unit.schema.json) | Unit datasheets with stat profiles and points |
| [weapon](schemas/core/weapon.schema.json) | Weapons with stat lines |
| [game-version](schemas/core/game-version.schema.json) | Edition and dataslate tracking |

### Enrichment (community-authored intelligence)

| Schema | Description |
|--------|-------------|
| [phase-mapping](schemas/enrichment/phase-mapping.schema.json) | Maps abilities to game phases |
| [timing-flag](schemas/enrichment/timing-flag.schema.json) | Precise within-phase timing |
| [interaction-flag](schemas/enrichment/interaction-flag.schema.json) | Ability conflicts, combos, sequencing |
| [ability](schemas/enrichment/ability-dsl/ability.schema.json) | Structured ability definitions (DSL) |

### Shared Definitions

| Schema | Description |
|--------|-------------|
| [common](schemas/$defs/common.schema.json) | Entity IDs, keywords, stat values |
| [game-version-ref](schemas/$defs/game-version-ref.schema.json) | Edition + dataslate reference |

## Ability DSL

Instead of storing ability text, the consortium builds structured game trees that express what abilities *do*. Game mechanics aren't copyrightable — only their expression is. The DSL is a new expression authored by the community.

An ability entry composes four primitives:

- **Trigger**: when it activates (phase, timing, type)
- **Condition**: prerequisites (recursive AND/OR/NOT tree)
- **Effect**: what it does (stat modifiers, re-rolls, mortal wounds, etc.)
- **Scope**: targeting range and duration

Effects support composition: `choice` (pick one of N) and `sequence` (ordered steps).

See [schemas/enrichment/ability-dsl/](schemas/enrichment/ability-dsl/) and [data/enrichment/_example/abilities.example.json](data/enrichment/_example/abilities.example.json) for examples.

## Versioning

Everything is tagged to edition + dataslate (e.g., `11th/2025-q3`). See [VERSIONING.md](VERSIONING.md).

## For Tool Developers

Reference these schemas from your project:

1. Add `40kdc-data` as a git submodule or npm dependency
2. Point your validator at `schemas/`
3. Use entity IDs from the consortium dataset for interoperability

All schemas use JSON Schema draft 2020-12.

## Licensing

| Directory | License |
|-----------|---------|
| `schemas/` | [CC0](LICENSE-SCHEMAS) (public domain) |
| `data/enrichment/` | [CC BY 4.0](LICENSE-DATA) (attribution required) |
| `tools/` | [MIT](LICENSE-TOOLS) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
