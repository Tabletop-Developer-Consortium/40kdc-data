# Papercuts

Small repository frictions recorded while doing real work.

<<<<<<< conflict 1 of 1
+++++++ ksvsupxo cc0da337 "feat: add mechanic evidence graph" (rebase destination)
## 2026-08-11T19:09:50Z — openai-codex/gpt-5.6-sol

Cargo test accepts only one positional TESTNAME filter; passing two focused test names caused a dead-end invocation, so use a shared substring or separate calls.

## 2026-08-11T19:19:04Z — openai-codex/gpt-5.6-sol

Three requested specialist reviews failed immediately because the harness reported 'No model selected' despite the parent session having a model, preventing parallel test/failure/type review.

## 2026-08-12T02:57:45Z — openai-codex/gpt-5.6-sol

Rust LSP could not start because the pinned 1.91.1 toolchain lacks rust-analyzer, forcing manual reference tracing for exported campaign-domain variants.

## 2026-08-12T13:53:53Z — openai-codex

The terrain:project-battlemaster npm script emits npm's lifecycle banner before its JSON output unless invoked with --silent, breaking direct jq pipelines and surfacing an EPIPE after jq exits.

## 2026-08-12T13:58:10Z — openai-codex

The impeccable skill requires .claude/skills/impeccable/scripts/load-context.mjs, but skill://impeccable resolved while that project-relative loader path does not exist, blocking its prescribed preflight.

## 2026-08-12T17:14:44Z — openai-codex/gpt-5.6-sol

Switching this jj workspace from the rig branch to main exposed the rig's existing target/ directory because main lacked that branch-local ignore, causing jj to snapshot thousands of build artifacts until a local exclude and file untrack repaired the change.

## 2026-08-12T17:20:29Z — openai-codex/gpt-5.6-sol

Root just preflight selected Homebrew's externally managed Python even though the repository has a populated .venv, so its editable-install step failed until .venv/bin was placed first on PATH.

## 2026-08-13T05:04:25Z — openai-codex/gpt-5.6-sol

The full Rust suite intermittently failed terminal_invalid_output_is_not_replayed_on_retry with ApiKeyForbidden, while the exact test passed immediately afterward; provider environment tests appear to race under parallel execution.

## 2026-08-13T13:46:35Z — openai-codex/gpt-5.6-sol

A combined verification command ran layout-editor's  from tools, where that script does not exist; workspace-specific npm checks must use separate working directories.

## 2026-08-13T15:36:45Z — openai-codex/gpt-5.6-sol

A single gh pr list GraphQL query combining files, commits, closing issues, and checks across 14 PRs expanded to 1,000,000 possible author nodes and exceeded GitHub's 500,000-node limit; release triage must split the query.
%%%%%%% diff from: stzqssok b9ff0618 "fix: preserve trigger context in translate cli" (rebase destination)
\\\\\\\        to: mykukzoz cf32680b "feat: certify graph-backed ability reuse" (rebased revision)
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
+
+## 2026-08-06T02:42:10Z — openai-codex/gpt-5.6-sol
+
+Impeccable skill required .claude/skills/impeccable/scripts/load-context.mjs, but the prescribed project-relative path does not exist in this workspace, blocking its non-optional context loader.
+
+
+## 2026-08-06T15:26:09Z — gpt-5.6-sol
+
+Impeccable setup documents a repo-local .claude loader path, but this repository only exposes the skill through skill://, causing the prescribed command to fail before context loading.
+
+## 2026-08-06T20:55:48Z — gpt-5.6-sol
+
+The campaign skill and agent outputs referenced tools/src/translate/cli.ts, but that path does not exist; attempting the documented translation validation command failed before validation and required locating the current CLI.
>>>>>>> conflict 1 of 1 ends

## 2026-08-13T16:13:30Z — openai-codex/gpt-5.6-sol

macOS patch lacks the GNU --merge option, so a three-way semantic patch attempt failed before touching files; conflict integration needs a different path.

## 2026-08-13T16:17:31Z — openai-codex/gpt-5.6-sol

Vitest in this repo does not accept Jest's --runInBand flag; the build passed but the combined verification command stopped before tests.

## 2026-08-13T16:24:37Z — openai-codex/gpt-5.6-sol

The Justfile verify-regen-stable recipe emits literal $$(mktemp) into bash and fails with a syntax error before checking artifacts, so it cannot serve as the documented pre-commit drift gate.
