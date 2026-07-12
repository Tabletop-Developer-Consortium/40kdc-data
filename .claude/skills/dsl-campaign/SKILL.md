---
name: dsl-campaign
description: Run ONE autonomous ability-DSL authoring campaign — inquisitor picks a ≤40-ability worklist from the sub-0.80 roundtrip corpus, the 12-agent suite authors and adversarially verifies it, and the campaign closes as a draft PR. Use for "run a dsl campaign", "launch the authoring loop", "next dsl-campaign round". Must run from the jj workspace /Users/will.mitchell/40kdc-dsl (agents register at session start).
argument-hint: "[--worklist-cap N] [--dry-run] [optional targeting bias, e.g. 'faction: orks' or 'shape: fight-eligibility-extension']"
---

# Skill: dsl-campaign

One launch = **one campaign**: prioritize → author in batches → apply+verify → close as a
draft PR. The loop never self-terminates; relaunching is the human heartbeat, PR review is
the second checkpoint. This file is the driver contract — a fresh session must be able to
run a campaign from it alone.

Companion files: `workflows/wf-prioritize.js`, `workflows/wf-author-batch.js`,
`workflows/wf-verify-batch.js` (invoke via `Workflow({scriptPath, args})`; each embeds the
frozen agent Output contracts as JSON Schemas — never redesign those). Always pass
`repo_root: "/Users/will.mitchell/40kdc-dsl"` in every workflow's args — subagents inherit
the driver session's cwd, and the preamble it generates pins them to the workspace even
when the driver was launched from another checkout. The worked example
of one converged campaign is `_private/loop-state/{roundtrip,inbox}-world-eaters.md`.

## Preconditions (fail loudly if unmet)

- cwd is `/Users/will.mitchell/40kdc-dsl` (jj workspace `dsl`). The 12 agents in
  `.claude/agents/` register only at session start — if `data-enginseer` isn't an
  available agent type, tell the user to restart the session here; do not simulate agents.
- Sibling repos: raw-text store `../40kdc-abilities`; embeddings harness
  `../40kdc-embeddings` (its own `.venv`).
- Toolchain in THIS workspace: `tools/node_modules` + `tools/dist`, `python/.venv`,
  `target/release/wh40kdc-runner`, `go/wh40kdc-runner`. Rebuild all three runners after
  ANY source edit before parity checks — stale runners give phantom verdicts.
- `jj st` clean apart from `_private/` (reconcile, never clobber, if not); `jj new` before
  any work; never touch other workspaces' commits (`<name>@`); never move `main`.

## Non-negotiables (pinned decisions)

- **Prose is authoritative; placeholder lies are banned.** An honest worse fit + a
  `resisted_schema` inbox block always beats a plausible wrong encoding.
- **Canonical condition ids are cruncher levers and outrank cosine.** Cogitator
  `regressed` fails the batch regardless of score gains.
- **New shapes need tortured-fit + family evidence** (swarmlord `estimated_family_size`
  ≥ 4, exact+near only).
- **Cosine selects and measures; it never gates.** The embeddings harness is advisory.
- **warpsmith is the only agent that writes repo files.** The driver writes loop-state,
  runs jj/gh. Workflow agents are read-only.
- **IP boundary:** GW prose may transit agent JSON, harness reports, and the session
  scratchpad; it must NEVER be written into any file inside this repo — including
  community_notes, [APPROX] notes, inbox entries, PR bodies, and commit messages
  (own-words paraphrase only). Breach ⇒ campaign abort + `jj undo`.

## Stop condition

- **Ability converged** = eversor panel has no un-rebutted `refuted:true` ∧ skitarius
  `overall_pass:true` ∧ cogitator `"clean"` ∧ no psyker severity-3 ∧ inquisitor review
  `accept` ∧ re-scored cosine ≥ start (or a recorded correctness-first justification).
- **Campaign done (draft PR opens)** = every worklist entry has a terminal status —
  `converged` / `improved` (skeptic PASS) / `needs-schema` (inbox block filed) /
  `abandoned` (reason recorded) — ∧ full gates green at head ∧ whole-dataset prose diff
  touches only worklist ids ∧ faction mean not regressed ∧ draft PR opened.

## Does NOT count as done (ten hard rejects — inquisitor enforces per batch AND at close)

1. **Placeholder lies** — valid DSL encoding a different mechanic.
2. **Cosine-chasing lever drops** — e.g. `charged-this-turn` → `timing-is charge-move`.
3. **APPROX-stuffing** — clauses evacuated into `[APPROX]` notes to dodge refutation.
4. **needs-schema as escape hatch** when an honest existing-shape fit exists.
5. **Weakened verification** — panel <2 voters, goldens loosened/deleted, unrun gates
   reported passed, "pending" counted as PASS.
6. **Silent worklist shrinkage** — any entry without a terminal status.
7. **Collateral render drift** — non-worklist describer output changed.
8. **Invented metadata** — `applies_to` on army-wide rules (pinned no-highlight),
   keyword gates or grant names not in prose.
9. **IP breach** — GW prose in any repo file ⇒ abort.
10. **Unjustified cosine drop** — ending below `cos_start` without a recorded
    correctness-first justification (the relentless-rage pattern).

## Caps (bounded by construction)

Worklist ≤ 40 (default ~30; `--dry-run` caps at 5). ≤ 4 assembly attempts per ability,
then forced terminal status. Eversor ≤ 3 voters (2 routine; 3 when new shape, arch-magos
confidence < 0.7, or prior reject). ≤ 2 full gate re-runs per batch. Batch grain 5–6
(wf-author-batch hard-fails > 8). One campaign per launch. Abort (registry `aborted`,
clean stop, never dressed as convergence): IP breach, gate failure surviving 2 re-runs,
blocking escalation.

## Procedure

### 0 — Preflight

```bash
cd /Users/will.mitchell/40kdc-dsl
jj workspace update-stale 2>/dev/null; jj st   # reconcile surprises; never clobber
jj new -m "wip: dsl-campaign cNNN"             # NNN = next id from registry.json
```

Refresh the full-corpus scores (fast when embedding cache is warm):

```bash
cd /Users/will.mitchell/40kdc-embeddings && .venv/bin/python -m wh40kdc_embeddings \
  roundtrip --faction all --scope all --enrichment-dir /Users/will.mitchell/40kdc-dsl/data/enrichment
```

Snapshot `_reports/roundtrip-all.json` to the session scratchpad as
`prose-baseline.json` — this is the **whole-dataset prose-diff baseline** (anti-condition
7): at close, a fresh `--faction all` run's describer outputs are diffed against it and
any changed non-worklist id fails the campaign. (Coverage is store-paired abilities; the
`drift`/conformance gates cover the goldens beyond it.)

### 1 — Prioritize

Compute a `sub080_summary` from the report (per faction: mean, count below 0.80, worst ~15
ids+scores). Then:

```
Workflow({ scriptPath: ".claude/skills/dsl-campaign/workflows/wf-prioritize.js", args: {
  scout_shapes: [ …recently shipped shapes + any user bias… ],
  artifacts: { roundtrip_report_path, sub080_summary, loop_state_paths, registry_excerpt },
  worklist_cap: 30 } })
```

From `curation.priorities`, materialize the worklist (ability_id, faction_id, cos_start,
prior_reject from the ledger). Honor a user targeting bias from `$ARGUMENTS` as round-1
priority. Then: append the campaign entry to `_private/loop-state/registry.json`
(`status:"open"`, `mean_before` from the report), create `roundtrip-<target>.md` in the
world-eaters table format, and file any `escalate_to_user` items into
`registry.escalations`. If an escalation **blocks** target choice, stop and ask the user.

### 2 — Author (per batch of 5–6)

```
Workflow({ scriptPath: ".claude/skills/dsl-campaign/workflows/wf-author-batch.js",
  args: { batch_id: "cNNN-bK", new_shapes: […], abilities: […5–6 worklist entries…] } })
```

Statuses back: `accepted` → apply (step 3). `needs-schema` → append the
`resisted_schema` block to `inbox-<faction>.md` (own words) and mark the ledger; the
committed entry stays untouched (never a placeholder). `rejected` → adjudicate: spawn
inquisitor (`mode:"review"`, the candidate + verdicts as `agent_outputs`); `accept`
overrides a bad refutation (record why), otherwise terminal `abandoned` with reason —
or `needs-schema` if the divergences show the schema can't express it. `no-prose` /
`agent-error` → terminal `abandoned` (reason recorded).

### 3 — Apply + verify (per batch)

1. **warpsmith applies** the accepted candidates (Agent tool, sole writer):
   `implement` decisions referencing each candidate's dsl JSON; it edits
   `data/enrichment/<faction>/abilities.json` only.
2. Regenerate + rebuild what the edit touches (TS bundle at minimum:
   `cd tools && npm run build`); rebuild runners if any source changed.
3. ```
   Workflow({ scriptPath: ".claude/skills/dsl-campaign/workflows/wf-verify-batch.js",
     args: { batch_id, ability_ids, faction_ids, touched_files } })
   ```
   Fail the batch on `!overall_pass` (≤2 re-runs after fixes), `verdict:"regressed"`
   (drop/fix the offending ability — levers outrank cosine), or any severity-3 psyker
   finding. Psyker `missing-clause-signal` routes to inquisitor as fidelity, not to
   warpsmith as wording.
4. Re-score just the batch:
   ```bash
   cd /Users/will.mitchell/40kdc-embeddings && .venv/bin/python -m wh40kdc_embeddings \
     roundtrip --faction <f> --ids <id,id,…> --scope batch-cNNN-bK \
     --enrichment-dir /Users/will.mitchell/40kdc-dsl/data/enrichment
   ```
   Any ability below its `cos_start` needs a recorded correctness-first justification or
   another attempt (within its 4-attempt budget).
5. Inquisitor batch review (`mode:"review"`, arch-magos outputs + verify results +
   scores). `revise` re-enters step 2 for that ability; `reject` → terminal per step 2.
6. On accept: `jj commit -m "feat: dsl-campaign cNNN batch K — <target>"`, update
   `roundtrip-<target>.md` + `registry.json` (statuses, cos_best, attempts).

### 4 — Close

1. All worklist entries terminal (anti-condition 6) — else keep batching.
2. Full gate: `PATH="$PWD/python/.venv/bin:$PATH" just regen fmt test-all
   version-lockstep` in the workspace, plus parity differ with **freshly rebuilt**
   runners. Drift-check by committing regen output and confirming `jj st` clean.
3. Prose diff: fresh `--faction all` run vs `prose-baseline.json`; any non-worklist id
   whose describer output changed ⇒ anti-condition 7, fix before closing.
4. Inquisitor close-out (`mode:"review"` over the campaign summary): re-checks all ten
   anti-conditions campaign-wide; faction mean ≥ `mean_before`.
5. Ship: `jj bookmark create wnmitch/dsl-cNNN-<slug> -r @-` (the batch stack), `jj git
   push --bookmark wnmitch/dsl-cNNN-<slug> --allow-new`, `gh pr create --draft` — PR body:
   own-words summary, worklist table (ids, statuses, cos start→best), justifications for
   any cosine drops, inbox blocks filed, escalations. No GW prose, no personal info.
6. Persist: registry entry → `converged` (+pr, mean_after, finished); `memory_store`
   (tags: `40kdc-data`, `dsl-loop`) one-paragraph campaign summary.
7. Report to the user: PR link, mean before→after, statuses, escalations, and anything
   `blocked_shapes` gained. If aborted instead: exact reason, what converged first,
   registry state — never dress an abort as convergence.

## Registry (`_private/loop-state/registry.json`)

Machine source of truth; driver-written only; gitignored (never rides the PR).
`campaigns[]` {id, kind: faction-led|shape-led|inbox-led|describer-led, target, bookmark,
status: open|converged|aborted, pr, worklist_size, mean_before, mean_after, started,
finished, notes} · `blocked_shapes[]` {proposal, why, reopen_when} — dedup source for
swarmlord/warpsmith proposals (full seen-set; reopen only when `reopen_when` is met with
cited new evidence) · `ability_ledger` {"faction/id": {status, campaign, cos_start,
cos_best, attempts, justification}} · `escalations[]` {question, raised_by, campaign,
resolved}.

## Field notes

- Cull/stop driver-spawned agents as soon as their output is verified.
- `execSync`-based repo tools resolve path args against the repo root, not shell cwd.
- The dump/store/report debugging rule applies to prose lookups: before concluding an
  ability "has no prose", make data-enginseer show the failing grep, not the theory.
- A dry run (`--dry-run`) runs the identical procedure with worklist_cap 5 and should
  include one known-hard multi-clause aura ability to probe the eversor floor.
