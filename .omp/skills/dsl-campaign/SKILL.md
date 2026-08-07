---
name: dsl-campaign
description: Run ONE autonomous ability-DSL authoring campaign — inquisitor picks a ≤40-ability worklist from the sub-0.80 roundtrip corpus, the 16-agent suite (12 core + 4 kroot shape-scout) authors and adversarially verifies it, and the campaign closes as a draft PR. Use for "run a dsl campaign", "launch the authoring loop", "next dsl-campaign round". Must run from the jj workspace /Users/will.mitchell/40kdc-dsl (agents register at session start).
argument-hint: "[--worklist-cap N] [--dry-run] [optional targeting bias, e.g. 'faction: orks' or 'shape: fight-eligibility-extension']"
---

# Skill: dsl-campaign

One launch = **one campaign**: prioritize → author in batches → apply+verify → close as a
draft PR. The loop never self-terminates; relaunching is the human heartbeat, PR review is
the second checkpoint. This file is the driver contract — a fresh session must be able to
run a campaign from it alone.

Companion files: `workflows/wf-prioritize.js`, `workflows/wf-author-batch.js`,
`workflows/wf-verify-batch.js`, `workflows/wf-audit-batch.js`, and
`workflows/wf-shape-scout.js` (invoke via `Workflow({scriptPath, args})`; each embeds
the frozen agent Output contracts as JSON Schemas — never redesign those). Every workflow
invocation must pass `repo_root: "/Users/will.mitchell/40kdc-dsl"`,
`graph_root: "/Users/will.mitchell/40kdc-dsl/_private/claim-graph"`, and
`execution_envelopes: complete_graph_issued_execution_envelopes`. That variable means the
complete scheduler-issued map for every agent label the workflow can invoke; every value
must contain `run_id`, `task_id`, `attempt_id`, `lease_id`, `lease_expires_at`,
`input_node_ids`, and `producer_contract_version`. A partial/sample map is invalid.
Trusted output is not sealed or persisted without both `graph_root` and a matching active
graph-issued envelope. `repo_root` pins subagents to this workspace even when the driver
was launched elsewhere. The worked example of one converged campaign is
`_private/loop-state/{roundtrip,inbox}-world-eaters.md`.

## Preconditions (fail loudly if unmet)

- cwd is `/Users/will.mitchell/40kdc-dsl` (jj workspace `dsl`). The 16 agents in
  `.omp/agents/` (12 core + 4 kroot shape-scout) register only at session start — if
  `data-enginseer` isn't an available agent type, tell the user to restart the session
  here; do not simulate agents. Nested agent-spawning (the kroot suite, arch-magos)
  needs `task.maxRecursionDepth >= 2` in `.omp/config.yml`; wf-shape-scout throws
  `spawn-unavailable` and fails loud if it is unset.
- Sibling repos: raw-text store `../40kdc-abilities`; embeddings harness
  `../40kdc-embeddings` (its own `.venv`).
- Toolchain in THIS workspace: `tools/node_modules` + `tools/dist`, `python/.venv`,
  `target/release/wh40kdc-runner`, `go/wh40kdc-runner`. Rebuild all three runners after
  ANY source edit before parity checks — stale runners give phantom verdicts.
- `jj st` clean apart from `_private/` (reconcile, never clobber, if not). Create `jj new`
  only after the second readiness gate atomically starts the graph campaign; never touch
  other workspaces' commits (`<name>@`) and never move `main`.
- Prototype isolation is backend-explicit. In a colocated Git/JJ checkout, omit
  `prototype_workspaces` and the task runtime creates disposable isolation. In a pure-JJ
  secondary workspace, the driver MUST create one dedicated `jj workspace` per possible
  review round outside the repo, pass their absolute paths as `prototype_workspaces`, and
  verify both those workspaces and the parent checkout after the scout. Never disable
  isolation or reuse one prototype workspace across rounds.

## Non-negotiables (pinned decisions)

- **Prose is authoritative; placeholder lies are banned.** An honest worse fit + a
  `resisted_schema` inbox block always beats a plausible wrong encoding.
- **Canonical condition ids are cruncher levers and outrank cosine.** Cogitator
  `regressed` fails the batch regardless of score gains.
- **New shapes need tortured-fit + family evidence** — the kroot shape-scout
  (`wf-shape-scout.js`) designs them: flesh-shaper must prove every nearest existing
  shape flattens the mechanic, and lone-spear `faithful_family_size` ≥ 4 (exact+near,
  flatten-excluded) gates the ship. Never flatten onto an over-similar neighbour.
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

Shape-scout (`wf-shape-scout.js`): ≤ 3 cyclical review rounds per shape, then forced
terminal; the family bar counts unique canonical mechanics (`ability_id`) in the frozen
exact family with `fit:faithful|needs-param` and `match_strength:exact|near`.
Cross-faction copies remain mandatory evidence but do not add headcount;
stretch/flattened/outside members count zero. Kroot leads spawn leaf helpers only
(spawn tree depth ≤ 2).
- **Frozen shape charter:** before cycle one, inquisitor freezes `shape_charter` with
  the mechanic slice, exact acceptance family, required semantics, non-goals, deferred
  candidates, fabricated acceptance fixtures, and explicit reopening rules. Collections
  and members are deep-frozen; ordinary rounds may not change acceptance. Existing
  deferred candidates merge with later discoveries as follow-ups. Every revision carries
  `previous_shape` plus a finding ledger (`open|resolved|out-of-scope|superseded`) and
  must retain the shape name/kind. Exhaustion returns either
  `rounds-exhausted-unresolved-slice-tradeoff` (maintainer decision required) or the
  conservative `rounds-exhausted-conservative-defer`.
- **Prototype before acceptance:** each candidate receives a disposable, isolated,
  non-applied warpsmith vertical slice. Colocated checkouts use runtime
  `prototype.worktree_mode:"isolated-non-applied"`; pure-JJ secondary workspaces use a
  driver-created, round-specific `prototype.worktree_mode:"jj-isolated-non-applied"`.
  Warpsmith spawns skitarius in that same worktree for non-empty
  compiler/schema/positive-negative/render evidence and echoes the exact candidate and
  expected workspace it probed. Prototype diagnostics remain repair input and never
  land in the campaign checkout.
- **Closed blockers:** blocker closure derives only from evidence-gated ledger state,
  never a self-reported boolean. Supersession requires a real replacement finding.
  War-shaper may accept only after every finding is terminal, two distinct scoped
  eversors pass on distinct frozen mechanics, and the final package exactly matches
  the revised candidate, trail artifact, and prototype evidence.

## Procedure

### 0 — Preflight

```bash
cd /Users/will.mitchell/40kdc-dsl
node .omp/skills/dsl-campaign/graph/cli.js readiness --next --json
jj workspace update-stale 2>/dev/null; jj st   # reconcile surprises; never clobber
```

The readiness gate must report `ready:true`, `next_campaign_id:"c010"`, and the active
`excluded_claims`. Do not create a jj change yet. A missing/stale source formalization,
legacy recovery, projection checksum, repository identity, certificate, lease, or apply
transaction fails closed.

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
Workflow({ scriptPath: ".omp/skills/dsl-campaign/workflows/wf-prioritize.js", args: {
  repo_root: "/Users/will.mitchell/40kdc-dsl",
  graph_root: "/Users/will.mitchell/40kdc-dsl/_private/claim-graph",
  execution_envelopes: complete_graph_issued_execution_envelopes,
  scout_shapes: [ …recently shipped shapes + any user bias… ],
  excluded_claims: readiness.excluded_claims,
  artifacts: { roundtrip_report_path, sub080_summary, loop_state_paths, registry_excerpt },
  worklist_cap: 30 } })
```

From `curation.priorities`, materialize a private JSON worklist containing `ability_id`,
`faction_id`, `cos_start`, and `prior_reject`. Exclude every graph-issued active claim.
Honor a user targeting bias from `$ARGUMENTS` as round-1 priority. Immediately before
creation, run:

```bash
node .omp/skills/dsl-campaign/graph/cli.js readiness --next --worklist <worklist.json> --json
node .omp/skills/dsl-campaign/graph/cli.js start-campaign --id c010 --worklist <worklist.json>
jj new -m "wip: dsl-campaign c010"
```

Only `start-campaign` creates the run, claims, source-formalization tasks, readiness parent,
and registry projection. An overlap is rejected transactionally; rerun curation with the
new exclusion set. Never append or edit `registry.json` directly. Blocking escalations are
answered as graph decisions before retrying readiness.

Before authoring each ability, complete its graph tasks in dependency order:
`source-formalization certificate -> certified retrieval -> construction plan -> author`.
Primitive/embedding similarity is discovery-only. Pass `wf-author-batch.js` only selected
current certified ancestor node IDs, explicit unmatched claims, the construction-plan ID,
and graph-issued execution envelopes. Never replay a transcript or use c007–c009 legacy
observations as authority.

### 2 — Formalize source claims (per ready batch)

```
Workflow({ scriptPath: ".omp/skills/dsl-campaign/workflows/wf-formalize-batch.js", args: {
  repo_root: "/workspace/40kdc-dsl",
  graph_root: "/workspace/40kdc-dsl/_private/claim-graph",
  run_id: "cNNN",
  model_identities: {
    who: "provider/model-or-agent-manifest-digest",
    when: "provider/model-or-agent-manifest-digest",
    what: "provider/model-or-agent-manifest-digest",
    formalizer: "provider/model-or-agent-manifest-digest"
  },
  abilities: […ready worklist entries…] } })
```

`model_identities` is mandatory: every value is a non-empty immutable provider model ID
or configured agent-manifest digest. The workflow freezes the authoritative source snapshot
before any model call, then runs WHO/WHEN/WHAT against that source node and persists only
the formalizer's closed extraction-local propositions, evidence, derivation, unresolved,
signature, and completeness output. There is no LLM source-binding confirmation and no
default or `"unknown"` identity path.

### 3 — Author (per batch of 5–6)

```
Workflow({ scriptPath: ".omp/skills/dsl-campaign/workflows/wf-author-batch.js", args: {
  repo_root: "/Users/will.mitchell/40kdc-dsl",
  graph_root: "/Users/will.mitchell/40kdc-dsl/_private/claim-graph",
  execution_envelopes: complete_graph_issued_execution_envelopes,
  batch_id: "cNNN-bK", new_shapes: […], abilities: […5–6 worklist entries…] } })
```

Statuses back: `accepted` → apply (step 3). `needs-schema` → **step 2a** (family check,
then shape-scout or inbox). `rejected` → adjudicate: spawn inquisitor (`mode:"review"`,
the candidate + verdicts as `agent_outputs`); `accept` overrides a bad refutation (record
why), otherwise terminal `abandoned` with reason — or `needs-schema` (→ step 2a) if the
divergences show the schema can't express it. `no-prose` / `agent-error` → terminal
`abandoned` (reason recorded). Each result's `thread` is the FULL per-round revision
history (every attempt's divergences, not just the last) — record it in the
ledger/roundtrip notes so cyclical revisions stay auditable.

### 2a — Shape-scout on a needs-schema result

A `needs-schema` is not automatically terminal. Spawn inquisitor to judge whether the
resisted mechanic is a FAMILY (≥ ~4 abilities, exact+near) or a singleton:
- **Singleton** → append the `resisted_schema` block to `inbox-<faction>.md` (own words),
  ledger `needs-schema`; committed entry untouched (never a placeholder). Terminal.
- **Family** → fork to the shape-scout, seeding the resisted_schema block:
  ```
  Workflow({ scriptPath: ".omp/skills/dsl-campaign/workflows/wf-shape-scout.js", args: {
    repo_root: "/Users/will.mitchell/40kdc-dsl",
    graph_root: "/Users/will.mitchell/40kdc-dsl/_private/claim-graph",
    execution_envelopes: complete_graph_issued_execution_envelopes,
    seed: { ability_id, faction_id, raw_text, resisted_schema }, family_threshold: 4 } })
  ```
  In a pure-JJ secondary workspace, include `prototype_workspaces` with one absolute,
  driver-created workspace path per possible round.
  The shape-scout runs inquisitor charter → flesh-shaper → lone-spear →
  isolated warpsmith+skitarius prototype → trail-shaper → war-shaper; each lead
  spawns its own declared helpers. It returns `status`:
  - `shipped-ready` (war-shaper `accept` ∧ unique canonical exact/near mechanic count
    ≥ threshold ∧ every ledger finding terminal ∧ immutable-charter checks pass ∧
    isolated prototype skitarius evidence passes ∧ final package artifacts match) →
    **auto-apply**: hand `shape_package` to warpsmith (`implement`) to land the schema
    oneOf branch + all four describer ports + conformance cases + SPEC bump + version
    lockstep, then re-author the seed AND every `faithful_family` member onto the new
    shape as accepted candidates (step 3). The campaign is now shape-led — expect a
    heavier PR, and the full close gate (step 4) must cover the port/SPEC work.
  - `existing-fits` → the scout proved an existing shape fits after all; re-enter step 2
    authoring with that shape named (the resist was a false alarm).
  - `rejected-sprawl` / `rejected-singleton` / `not-converged` → file the inbox block,
    ledger `needs-schema` (terminal); record the scout's reason.
  A thrown `spawn-unavailable` means nested spawning is off — set
  `task.maxRecursionDepth >= 2` in `.omp/config.yml` and restart; never hand-simulate the
  kroot agents (that is anti-condition 5, weakened verification).

### 3 — Apply + verify (per batch)

1. **warpsmith applies** the accepted candidates (Agent tool, sole writer):
   `implement` decisions referencing each candidate's dsl JSON; it edits
   `data/enrichment/<faction>/abilities.json` only.
2. Regenerate + rebuild what the edit touches (TS bundle at minimum:
   `cd tools && npm run build`); rebuild runners if any source changed.
3. ```
   Workflow({ scriptPath: ".omp/skills/dsl-campaign/workflows/wf-verify-batch.js", args: {
     repo_root: "/Users/will.mitchell/40kdc-dsl",
     graph_root: "/Users/will.mitchell/40kdc-dsl/_private/claim-graph",
     execution_envelopes: complete_graph_issued_execution_envelopes,
     batch_id, ability_ids, faction_ids, touched_files } })
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
5. **Final maintainer audit — required before terminal review.** Invoke:
   ```
   Workflow({ scriptPath: ".omp/skills/dsl-campaign/workflows/wf-audit-batch.js", args: {
     repo_root: "/Users/will.mitchell/40kdc-dsl",
     graph_root: "/Users/will.mitchell/40kdc-dsl/_private/claim-graph",
     execution_envelopes: complete_graph_issued_execution_envelopes,
     batch_id, abilities: [{ ability_id, faction_id }, …],
     baseline_roundtrip_report_path, updated_roundtrip_report_path } })
   ```
   Present every returned entry to the maintainer in input order: verbatim original rule,
   baseline describer output + score, and updated describer output + score. The original
   rule is ephemeral session output; never persist it in the repo, loop-state, PR body, or
   commit message. Do not call the batch accepted until this comparison was surfaced.
6. Inquisitor batch review (`mode:"review"`, arch-magos outputs + verify results +
   scores + final audit). `revise` re-enters step 2 for that ability; `reject` → terminal
   per step 2.
7. On accept: seal the review, persist the apply transaction and post-apply repository
   snapshot/checks, then `jj commit -m "feat: dsl-campaign cNNN batch K — <target>"`.
   Advance leases/checkpoints and regenerate the registry projection through the graph;
   never write `registry.json` directly. Worker errors become durable `failed-final`,
   `invalid-output`, or `stale` transitions instead of bypassing the reducer.

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
6. Persist the terminal run/certificates through graph events, regenerate the compatibility
   registry with `graph/cli.js project-registry`, then `memory_store` (tags:
   `40kdc-data`, `dsl-loop`) one-paragraph campaign summary.
7. Report to the user: PR link, mean before→after, statuses, escalations, and anything
   `blocked_shapes` gained. If aborted instead: exact reason, what converged first,
   registry state — never dress an abort as convergence.

## Registry (`_private/loop-state/registry.json`)

Generated compatibility projection; `_private/claim-graph/index.sqlite` is authoritative.
The driver MUST NOT write this file. `graph/cli.js project-registry` is its sole writer and
preserves human fields while projecting graph lifecycle state. The graph owns campaigns,
active claims, decisions, findings, certificates, apply transactions, and authority edges;
legacy ledger status never grants reuse authority. c005 remains resumable through this same
event path, and its nine active claims remain excluded from every new campaign.

## Field notes

- Cull/stop driver-spawned agents as soon as their output is verified.
- `execSync`-based repo tools resolve path args against the repo root, not shell cwd.
- The dump/store/report debugging rule applies to prose lookups: before concluding an
  ability "has no prose", make data-enginseer show the failing grep, not the theory.
- A dry run (`--dry-run`) runs the identical procedure with worklist_cap 5 and should
  include one known-hard multi-clause aura ability to probe the eversor floor.
- The author loop records the FULL revision thread (every attempt's panel divergences,
  not just the last round); it feeds forward on revision and into loop-state, so a
  cyclical fix never silently re-breaks an earlier round's divergence.
- On a needs-schema FAMILY, the kroot shape-scout designs a distinct new shape — proving
  the nearest existing shapes flatten it — rather than reaching for an over-similar
  neighbour (the necron obelisk-vs-tau collision is the defect it prevents).
