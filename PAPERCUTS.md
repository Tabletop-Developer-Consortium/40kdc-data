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
