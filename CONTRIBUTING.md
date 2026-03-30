# Contributing

## Schema Changes

Schema changes affect all downstream tools. Before modifying a schema:

1. Open an issue using the **Schema Change** template
2. Describe the change and motivation
3. Note whether it's breaking (requires migration)
4. Wait for discussion before submitting a PR

## Enrichment Data

Enrichment data (phase mappings, timing flags, interaction flags, ability DSL entries) is the consortium's primary output.

1. Fork the repository
2. Add or update data files under `data/enrichment/`
3. Run `cd tools && npm run validate` to verify your data
4. Submit a PR with a clear description of what's covered

## Core Data

Core data files (stat lines, point costs, faction/unit/weapon definitions) live under `data/core/`.

**The canonical repository does not ship core data.** The `_example/` directory contains fabricated examples demonstrating the schema shape.

If you need core data for your tools:

1. Fork the repository
2. Populate `data/core/` in your fork
3. Run `cd tools && npm run validate:core` to verify
4. **Do not submit PRs with real core data back to this repository**

## Tooling

The validation CLI lives under `tools/`. Standard PR workflow:

1. Fork and create a feature branch
2. Make changes, add tests
3. Run `npm test` and `npm run validate`
4. Submit a PR

## Style

- JSON files: 2-space indent
- Entity IDs: kebab-case (`space-marines`, not `SpaceMarines`)
- One entity per array element in data files
- Commit messages: conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)
