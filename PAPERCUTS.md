# Papercuts

Small repository frictions recorded while doing real work.

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
