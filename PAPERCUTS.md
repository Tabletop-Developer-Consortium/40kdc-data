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
