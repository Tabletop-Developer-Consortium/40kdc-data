# Papercuts

Small repository frictions recorded while doing real work.

## 2026-08-05T17:38:48Z — openai-codex/gpt-5.6-sol

A remembered .claude/skills/dsl-campaign path was absent in the current workspace, causing a parallel inspection batch to fail before returning independent results.

## 2026-08-05T19:17:02Z — openai-codex/gpt-5.6-sol

jj status refused to snapshot a 39.9 MiB untracked session HTML file, adding repeated warning noise and preventing a clean workspace snapshot.

## 2026-08-05T21:39:11Z — openai-codex/gpt-5.6-sol

Browser request interception did not surface EventSource stream requests, so the documented interception path could not drive staged SSE commits and required a localhost fixture server instead.

## 2026-08-05T22:07:50Z — openai-codex/gpt-5.6-sol

The required killport helper is unavailable, so a failed combined-server launch could not use the mandated port cleanup command.

## 2026-08-06T00:54:08Z — openai-codex/gpt-5.6-sol

Browser open waited on Vite networkidle0 and timed out because the dev UI keeps a connection open; the tab may still be usable, but the error obscures that state.

## 2026-08-06T02:42:10Z — openai-codex/gpt-5.6-sol

Impeccable skill required .claude/skills/impeccable/scripts/load-context.mjs, but the prescribed project-relative path does not exist in this workspace, blocking its non-optional context loader.


## 2026-08-06T15:26:09Z — gpt-5.6-sol

Impeccable setup documents a repo-local .claude loader path, but this repository only exposes the skill through skill://, causing the prescribed command to fail before context loading.

## 2026-08-06T20:55:48Z — gpt-5.6-sol

The campaign skill and agent outputs referenced tools/src/translate/cli.ts, but that path does not exist; attempting the documented translation validation command failed before validation and required locating the current CLI.

## 2026-08-07T15:27:24Z — openai-codex/gpt-5.6-sol

jq was invoked over multiple faction JSON files without slurping, producing one report per file and exiting 5 instead of one corpus-wide enum summary; use jq -s/add for this lookup.

## 2026-08-13T19:05:11Z — openai-codex/gpt-5.6-sol

Running the documented jj workspace update-stale precondition rebased this workspace onto a conflicted divergent parent and surfaced dozens of unrelated conflicts, blocking safe implementation until workspace lineage is reconciled.

## 2026-08-13T19:50:33Z — openai-codex/gpt-5.6-sol

A one-off Python text replacement against a truncated long line failed because the assumed literal occurred more than once after an earlier edit; anchored file edits are safer for long generated-style workflow lines.

## 2026-08-13T20:28:59Z — openai-codex/gpt-5.6-sol

Root just preflight invokes system pip install and fails under Homebrew's PEP 668 externally-managed environment instead of using the repository virtualenv, blocking the documented gate after artifact regeneration.

## 2026-08-13T23:32:19Z — openai-codex/gpt-5.6-sol

A jq schema-introspection query failed on a parenthesis error while enumerating effect wrapper child fields, adding an avoidable discovery round trip; use a simpler staged jq expression for nested  checks.

## 2026-08-14T15:49:00Z — gpt-5.6-sol

The extant claim importer timed out after an hour because every nested event rebuilt all node ability references; bulk graph transactions need one deferred reference rebuild at commit.

## 2026-08-14T18:57:39Z — gpt-5.6-sol

Live schema-five claim migration with candidate import exceeded the one-hour command timeout; candidate persistence is too slow for the 40k corpus and needs batching or indexing before retry.

## 2026-08-15T18:31:17Z — gpt-5.6-sol

The OMP Eval JavaScript runtime could not import the campaign GraphStore because Bun cannot resolve Node 22's node:sqlite module, so graph-backed workflow helpers cannot run directly in Eval despite the workflow scripts being JavaScript.

## 2026-08-15T19:25:38Z — gpt-5.6-sol

The installed jq-compatible CLI rejects the standard input_filename filter, so multi-file JSON diagnostics cannot label source files as expected; this forced a separate file-enumeration step.

## 2026-08-15T22:20:19Z — gpt-5.6-sol

The graph-backed verification workflow serializes a long skitarius gate before six review agents; the 30-minute subagent cap terminated the driver and subsequent agent calls hit the usage limit, leaving later request files unresolved. Long mechanical gates should run outside the model call or in a separately resumable wave.

## 2026-08-15T22:46:32Z — gpt-5.6-sol

tooling/parity/differ.py prefers an existing stale target/release runner over a freshly rebuilt target/debug runner, producing false cross-port divergences and an old version report. The CLI should detect freshness/version or prefer an explicitly rebuilt debug binary during local iteration.

## 2026-08-15T22:58:52Z — openai-codex/gpt-5.6-sol

Fresh Go runner build from the repository root failed because the Go module lives under go/. Use 'go -C go build' for parity runner rebuilds.

## 2026-08-15T23:01:09Z — openai-codex/gpt-5.6-sol

The Bun-backed JS eval cannot import the graph runtime because it depends on Node's built-in node:sqlite module. Campaign lifecycle repairs therefore require a temporary Node script or a graph CLI command.

## 2026-08-15T23:12:11Z — openai-codex/gpt-5.6-sol

gh pr create in the jj workspace failed because the workspace has no .git directory. Pass --repo explicitly when opening PRs from /Users/will.mitchell/40kdc-dsl.

## 2026-08-20T19:13:10Z — gpt-5.6

The Codex workspace ran out of disk space during a JSON write because a 335 MB OCR orientation scratch directory remained under /tmp; the failed write had to be verified before retrying after cleanup.

## 2026-08-20T22:37:07Z — gpt-5.6-sol

The pack extractor resolves PDF and store arguments against the repository root even when invoked from tools; passing ../_private from the tools cwd escaped the repo and failed before extraction.

## 2026-08-20T22:51:02Z — gpt-5.6-sol

python/.venv is editable-installed against /private/tmp/40kdc-maps-ci-fix rather than this workspace, so focused pytest silently exercised stale source until PYTHONPATH=python/src was set.

## 2026-08-20T22:57:16Z — gpt-5.6-sol

npm run mfm:golden silently rewrote the committed MFM 925 golden and gaps from the local stale data_version 895 dump; the command needs a downgrade guard before writing.

## 2026-08-21T00:00:39Z — openai-codex/gpt-5.6-sol

author:ingest resolves manifest paths from tools/ despite AGENTS.md saying tool path args resolve from the repo root; a documented repo-relative _private/manifests path was reported missing.

## 2026-08-21T00:17:58Z — openai-codex/gpt-5.6-sol

AGENTS.md documents an upstream remote for 40kdc-data, but this workspace has no upstream remote;  fails and the actual canonical remote must be inferred from repository metadata.

## 2026-08-21T00:37:55Z — openai-codex/gpt-5.6-sol

The advertised silent-failure-hunter and pr-test-analyzer agents failed immediately with 'No model selected', so their review slices could not run.

## 2026-08-21T04:19:52Z — codex

author:input hard-fails when the optional ~/army-assist checkout is absent, even though the sibling raw-text store already contains the required rules; this blocks refreshing source-grounded repair inputs.

## 2026-08-21T14:07:44Z — openai-codex/gpt-5.6-sol

tsx -e could not resolve a local TypeScript module imported with a .js suffix, despite repository source imports using extensionless TypeScript paths; the validation one-liner failed before execution.

## 2026-08-21T14:10:07Z — openai-codex/gpt-5.6-sol

Codex raw-store records can carry phases: null despite phase comparison code expecting arrays; jq phase audits must normalize with // [].

## 2026-08-21T14:30:08Z — openai-codex/gpt-5.6-sol

The new just regen recipe attempted a global editable pip install on macOS and failed under PEP 668, blocking preflight despite all Python tooling already being installed. Regeneration should not mutate the package environment.

## 2026-08-21T16:30:16Z — gpt-5.6-sol

Temporary model-adapter PATH omitted the active NVM bin, so npm failed before running; prepend /tmp to the inherited PATH instead.

## 2026-08-21T16:47:45Z — gpt-5.6-sol

The raw-text store's verification script writes a 4.9 MiB unignored dist/bundle-abilities.json, which jj refuses to snapshot; verification requires manually deleting this transient output.

## 2026-08-21T16:57:34Z — gpt-5.6-sol

gh cannot infer a repository from a colocated jj workspace that lacks a .git directory; raw-store PR commands must pass the explicit -R repository.

## 2026-08-28T15:11:14Z — openai-codex/gpt-5.6-sol

A live Battlemaster re-projection strips committed keystones, but the documented derive-keystones --rederive follow-up now fails on a 0.5-inch pairing difference in bm-disrupt-vs-disrupt-01, preventing the projected data from being restored.

## 2026-08-28T16:19:22Z — openai-codex

The layout-editor workspace has no local Prettier binary, so its ordinary npx prettier command fails; formatting must be invoked through the root tools workspace.

## 2026-08-28T16:29:49Z — openai-codex

The layout-editor production build emitted its bundle-size table but then hung until the 10-minute command timeout while a persistent Vite dev server was running; the same build normally exits in seconds.
