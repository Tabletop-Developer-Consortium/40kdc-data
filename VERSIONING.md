# Versioning

All data in this repository is versioned by **edition + dataslate**.

## Game Version Format

Every entity and enrichment entry carries a `game_version` object:

```json
{
  "edition": "10th",
  "dataslate": "2025-q3"
}
```

- **edition**: The game edition (e.g., `10th`, `11th`)
- **dataslate**: Quarterly balance update identifier (e.g., `2025-q3`)

## Git Tags

Releases are tagged as `{edition}/{dataslate}`:

```
10th/2025-q3
11th/2025-q4
```

## Data File Organization

Enrichment data is organized by edition and dataslate:

```
data/enrichment/
├── 10th/
│   └── 2026-q1/
│       ├── phase-mappings/
│       ├── timing-flags/
│       ├── interaction-flags/
│       └── abilities/
└── 11th/
    └── 2025-q3/
        └── ...
```

A new dataslate creates a new subdirectory. Previous dataslate data can be copied forward and diff-edited.

## Schema Versioning

Schemas are versioned via git tags. Breaking schema changes bump the version in the `$id` URL (e.g., `v2/core/faction.schema.json`). Non-breaking additions maintain the same `$id`.

## Enrichment Entry Versioning

Each ability DSL entry has its own `version` field and a `supersedes` field. When a FAQ changes a mechanic:

1. The old entry remains for historical reference
2. A new entry is created with the updated `version` and `supersedes` pointing to the old one
3. Tools resolve the chain to find the current version for a given dataslate
