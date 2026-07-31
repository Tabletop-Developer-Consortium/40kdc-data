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
`workflows/wf-verify-batch.js`, `workflows/wf-review-batch.js`, `workflows/wf-shape-scout.js`, and
`workflows/wf-close-campaign.js` (invoke via `Workflow({scriptPath, args})`; each embeds
the agent Output contracts as JSON Schemas). Always pass
`repo_root: "/Users/will.mitchell/40kdc-dsl"` in every workflow's args — subagents inherit
the driver session's cwd, and every workflow hard-fails unless cwd and `jj root` both
resolve to that exact path. Prompt-only workspace pinning is not a safeguard. The worked example
of one converged campaign is `_private/loop-state/{roundtrip,inbox}-world-eaters.md`.

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
- `jj st` clean apart from `_private/` (reconcile, never clobber, if not); run `jj new` before
  any work, then capture the full **`@-`** commit id as `campaign_base_commit_id` (never `@`);
  never touch other
  workspaces' commits (`<name>@`); never move `main`.
- Before invoking a workflow, build one allowed-role manifest from the 16 discovered
  definitions and verify every role resolves to exactly `openai-codex/gpt-5.6-luna`.
  Every workflow repeats this hard check before spawning. Invoke no generic or
  unlisted reviewer. Directly spawning campaign roles to imitate a failed workflow is
  forbidden: it bypasses fixed workflow routing and is a blocking escalation. Treat
  OMP's invocation log—not a model-returned role name—as the runtime provenance record.

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
- **Evidence is immutable.** data-enginseer emits a SHA-256-bound source packet with a
  stable id for every independently testable clause. Every later role consumes that
  packet; the driver never re-summarizes the source between roles.
- **Architecture precedes decomposition.** Inquisitor classifies the global control
  structure and can route a mechanic to shape-scout before leaf assembly. Every
  mechanical clause must map exactly to DSL; note-only coverage is needs-schema.
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
  touches only worklist ids ∧ every target faction's independently computed mean has
  not regressed (no justification bypass) ∧ draft PR opened.

## Does NOT count as done (ten hard rejects — inquisitor enforces per batch AND at close)

1. **Placeholder lies** — valid DSL encoding a different mechanic.
2. **Cosine-chasing lever drops** — e.g. `charged-this-turn` → `timing-is charge-move`.
3. **APPROX-stuffing** — any mechanical clause evacuated into `[APPROX]` notes.
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

OMP gives direct task-tool agents the configured 30-minute `task.maxRuntimeMs`, but
workflow `agent()` calls currently ignore that setting. Until the runtime exposes
per-call cancellation, the driver MUST externally cancel and inspect any workflow role
with no terminal output by 20 minutes, and abort/restart the phase at 30 minutes.
Repeating blind waits is forbidden. Log the current phase, role label, and last artifact
before each wait so “running” is distinguishable from progress.

Shape-scout (`wf-shape-scout.js`): ≤ 3 cyclical review rounds per shape, then forced
terminal; the family bar is either lone-spear external `faithful_family_size` ≥ 4 or at
least four homogeneous internal children in one closed composite mechanic. Kroot leads
spawn leaf helpers only (spawn tree depth ≤ 2).

## Procedure

### 0 — Preflight

```bash
cd /Users/will.mitchell/40kdc-dsl
jj workspace update-stale 2>/dev/null; jj st   # reconcile surprises; never clobber
jj new -m "wip: dsl-campaign cNNN"             # NNN = next id from registry.json
campaign_base_commit_id=$(jj log -r @- --no-graph -T 'commit_id')
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
Record the snapshot's SHA-256. `wf-prioritize.js` reads the file and refuses a hash
mismatch, preventing a stale or replaced baseline from entering curation.

### 1 — Prioritize

Compute a `sub080_summary` from the report (per faction: mean, count below 0.80, worst ~15
ids+scores). Then:

```
Workflow({ scriptPath: ".omp/skills/dsl-campaign/workflows/wf-prioritize.js", args: {
  repo_root: "/Users/will.mitchell/40kdc-dsl",
  campaign_id: "cNNN",
  campaign_base_commit_id,
  scout_shapes: [ …recently shipped shapes + any user bias… ],
  artifacts: { roundtrip_report_path, roundtrip_report_sha256, sub080_summary,
               loop_state_paths, registry_excerpt },
  worklist_cap: 30 } })
```

From `curation.priorities`, materialize the worklist (ability_id, faction_id, cos_start,
prior_reject from the ledger). Honor a user targeting bias from `$ARGUMENTS` as round-1
priority. Then: append the campaign entry to `_private/loop-state/registry.json`
(`status:"open"`, `mean_before` from the report), create `roundtrip-<target>.md` in the
world-eaters table format, and file any `escalate_to_user` items into
`registry.escalations`. If an escalation **blocks** target choice, stop and ask the user.
Persist the workflow-returned `campaign_manifest_json` byte-for-byte in the session
scratchpad and record its returned SHA-256; closure requires that frozen manifest.
It freezes `campaign_base_commit_id`; prioritization verifies that id resolves and is
an ancestor of the current campaign commit.

### 2 — Author (per batch of 5–6)

```
Workflow({ scriptPath: ".omp/skills/dsl-campaign/workflows/wf-author-batch.js",
  args: { repo_root: "/Users/will.mitchell/40kdc-dsl", campaign_id: "cNNN", batch_id: "cNNN-bK",
          campaign_manifest_sha256, candidate_commit_id, // current pre-application @ commit
          new_shapes: […], abilities: […5–6 worklist entries…] } })
```

The workflow retrieves one immutable evidence packet, invokes inquisitor in
`architect` mode, and checks that the architecture accounts for every clause before
WHO/WHEN/WHAT decomposition. Unsupported menus, resource systems, state machines, or
actor/event bindings return `needs-schema` immediately. Arch-magos output is accepted
only when its clause-coverage matrix maps every mechanical clause exactly with
source-explicit or schema-derived evidence; dropped, inferred, unresolved, or note-only
mechanics route to shape-scout.

Statuses back: `accepted` → apply (step 3). `needs-schema` → **step 2a** (family check,
then shape-scout or inbox). A `rejected` result at the four-attempt budget is terminal
`abandoned`, with that author envelope as evidence. Before the budget is exhausted,
adjudication feedback must re-enter `wf-author-batch` and produce a fresh `accepted` or
`needs-schema` author status; adjudication can never relabel a rejected author artifact.
`no-prose` / `agent-error` → terminal
`abandoned` (reason recorded). Each result's `thread` is the FULL per-round revision
history (every attempt's divergences, not just the last) — record it in the
ledger/roundtrip notes so cyclical revisions stay auditable.

For terminal workflow evidence, the driver constructs inbox envelopes, never loose
one-key snippets. Each is `{binding,payload}` with
`kind,campaign_id,batch_id,campaign_manifest_sha256,ability_keys,candidate_commit_id,payload_sha256`;
`ability_keys` is the full referenced batch key set and `payload_sha256` hashes the exact
payload JSON. Inbox payload is `{entries:[{faction_id,ability_id,resisted_schema}]}`. Different
batches may legitimately bind different applied candidate commits; author artifacts bind
their earlier `author_candidate_commit_id`. Closure validates the full batch envelope and
then requires the terminal key's inclusion rather than pretending the envelope covered
only `[key]`.

### 2a — Shape-scout on a needs-schema result

A `needs-schema` is not automatically terminal. Use the architect output and inquisitor
to judge whether the resisted mechanic has either an external family (≥4 abilities,
exact+near) or an internal family (≥4 homogeneous children in one closed composite):
- **Singleton** → append the `resisted_schema` block to `inbox-<faction>.md` (own words),
  ledger `needs-schema`; committed entry untouched (never a placeholder). Terminal.
- **Family** → fork to the shape-scout, seeding the resisted_schema block:
  ```
  Workflow({ scriptPath: ".omp/skills/dsl-campaign/workflows/wf-shape-scout.js", args: {
    repo_root: "/Users/will.mitchell/40kdc-dsl",
    campaign_id: "cNNN", campaign_manifest_sha256,
    campaign_manifest_path,
    seed: { ability_id, faction_id, raw_text, evidence_packet, architecture,
            resisted_schema }, family_threshold: 4 } })
  ```
  The kroot suite (flesh-shaper → lone-spear → trail-shaper → war-shaper, each spawning
  its OWN helpers) returns `status`:
  - `shipped-ready` (war-shaper `accept` ∧ external or internal family threshold) →
    **auto-apply only its `faithful_family` entries already present in the frozen manifest**:
    hand `shape_package` to warpsmith (`implement`) to land the schema
    oneOf branch + all four describer ports + conformance cases + SPEC bump + version
    lockstep, then re-author the seed AND every `faithful_family` member onto the new
    shape as accepted candidates (step 3). Any family member discovered outside the
    manifest is recorded in loop-state for the next campaign and receives no tracked
    edit or render in this campaign; the frozen manifest is never amended. The campaign is now shape-led — expect a
    heavier PR, and the full close gate (step 4) must cover the port/SPEC work.
  - `existing-fits` → the scout proved an existing shape fits after all; re-enter step 2
    authoring with that shape named (the resist was a false alarm).
  - `rejected-sprawl` / `rejected-singleton` / `not-converged` → file the inbox block,
    ledger `needs-schema` (terminal); record the scout's reason.
  A thrown `spawn-unavailable` means nested spawning is off — set
  `task.maxRecursionDepth >= 2` in `.omp/config.yml` and restart; never hand-simulate the
  kroot agents (that is anti-condition 5, weakened verification).

### 3 — Apply + verify (per batch)

1. **warpsmith applies** the accepted candidates (Agent tool, sole writer), then performs
   **all regeneration** required by those edits before any verification identity is captured:
   `implement` decisions referencing each candidate's dsl JSON; it edits
   `data/enrichment/<faction>/abilities.json` only for data work. Before source work it
   must return a complete implementation matrix and exact changed-path allowlist.
2. Only after warpsmith edits and all regen are final, run
   `jj describe -m "feat: dsl-campaign cNNN batch K — <target>"`, capture the final full
   `@` commit id, and use that immutable candidate identity for verification, review,
   and rescore. No writer may run between identity capture and verification.
3. The side-effect-free TS build equivalent is
   `cd tools && npm run codegen:data && npx tsc` (never use the package lifecycle build
   script in a campaign; its postbuild writes audit coverage). Rebuild runners if any source changed. Audit docs
   are forbidden campaign outputs.
4. ```
   Workflow({ scriptPath: ".omp/skills/dsl-campaign/workflows/wf-verify-batch.js",
     args: { repo_root, campaign_id, batch_id, campaign_manifest_sha256,
             candidate_commit_id, ability_ids, faction_ids, touched_files,
             allowed_files, decision_kind, implementation_matrix,
             expected_candidate_dsl_hashes,
             baseline_commit_id, // explicit committed parent/current baseline
             sealed_head: false, campaign_base_commit_id: null } })
   ```
   The workflow inventories `jj diff --name-only -r @` itself and fails on any path
   outside warpsmith's exact-path allowlist. `new-shape` changes require exact rows for
   canonical schema, each port's actual describer source, each port's cruncher source,
   conformance, SPEC, generated types/schemas, each tracked language bundle, exact faction
   data, and version lockstep including `Cargo.lock` alongside the four declared version
    files. Scoring-describer surfaces are exactly `tools/src/translate/scoring.ts`,
    `python/src/wh40kdc/translate/scoring.py`, and `go/translate_scoring.go`; there is no
    Rust scoring-describer mirror, so none is invented.
   Ordinary `new-shape` and `describer-reword` neither require nor accept scoring files.
   A distinct `scoring-describer` decision requires exactly the TS/Python/Go scoring
   describers, scoring conformance, and SPEC mirrors (there is no Rust scoring mirror).
   `describer-reword` requires the four ordinary describer ports plus conformance/SPEC; `data`
   requires exact faction data and each tracked Rust/Python/Go bundle path. Verification
   recognizes `data-conformance` when data-generated conformance also changes: require
   data, all tracked bundles, conformance outputs, `conformance/SPEC_VERSION`,
   `python/src/wh40kdc/_spec.py`, and `go/spec.go`. Diff-derived decision validation
   distinguishes it from plain data.
   also requires format/lint (including Ruff) and six-pair
   parity; `not_run` is failure.
   Fail the batch on `!overall_pass` (≤2 re-runs after fixes), `verdict:"regressed"`
   (drop/fix the offending ability — levers outrank cosine), or any severity-3 psyker
   finding. Psyker `missing-clause-signal` routes to inquisitor as fidelity, not to
   warpsmith as wording.
5. Re-score just the batch:
   ```bash
   cd /Users/will.mitchell/40kdc-embeddings && .venv/bin/python -m wh40kdc_embeddings \
     roundtrip --faction <f> --ids <id,id,…> --scope batch-cNNN-bK \
     --enrichment-dir /Users/will.mitchell/40kdc-dsl/data/enrichment
   ```
   Save the unmodified `{kind:"roundtrip",abilities:[...]}` report. Put campaign/batch/
   manifest/key/commit binding in its artifact reference, never in embeddings JSON.
   Any ability below its `cos_start` needs a recorded correctness-first justification or
   another attempt (within its 4-attempt budget).
6. Invoke `wf-review-batch.js` with `repo_root,campaign_id,batch_id,
   campaign_manifest_sha256,candidate_commit_id,candidate_dsl_hashes,faction_ids,
   ability_keys,author_artifact,verify_artifact,rescore_artifact,agent_outputs`. It invokes
   inquisitor with Luna strict and emits a bound `{binding,payload}` with exactly one
   terminal review per key. `revise` or `reject` requires rollback/revision and then a
   fresh `wf-author-batch` result before any new apply; never directly relabel the
   previously accepted artifact terminal.
7. On accept: save artifact references for author workflow, verification workflow,
   inquisitor review, and rescore in every ledger row; then seal with plain `jj new`
   and update statuses/scores/attempts. Never use `jj commit -m` after verification.
   Author/verify/review files use `{binding,payload}`; binding contains
   `kind,campaign_id,batch_id,campaign_manifest_sha256,ability_keys,payload_sha256` plus
   its phase commit and candidate hashes. Author uses `author_candidate_commit_id` and
   per-key `candidate_dsl_hashes`; verify uses `candidate_commit_id` and independently
   recomputed applied hashes. The read-only author artifact binds the pre-application commit it actually inspected;
   verify/review bind the applied candidate commit. Never predict a future jj commit id.
   Canonical hashing is UTF-8 SHA-256 of compact JSON with object keys recursively sorted
   and array order preserved. The ledger stores `author_candidate_commit_id` and
   `candidate_dsl_sha256`. References include file hash, payload hash, and exact keys. Review rows include
   `faction_id`. A todo is complete only when its required artifact id/path or commit id exists.

### 4 — Close

1. All worklist entries terminal (anti-condition 6) — else keep batching. Each converged
   or improved row has author/verify/review/rescore artifact references and scores.
2. Fresh-run the whole-corpus roundtrip and normalize the comparison against the
   baseline into a scratchpad JSON artifact:
   `{baseline_sha256,current_sha256,changes:[{faction_id,ability_id}],
   non_worklist_changes:[],generated_at}`.
3. Seal the completed stack with plain `jj new`, capture `@-`'s commit id, and produce one
   final `wf-verify-batch` envelope (`sealed_head:true`, `decision_kind:"sealed-campaign"`)
   at that sealed head covering every converged/improved faction/ability pair. Pass every
   required argument: `campaign_id`, manifest hash, sealed candidate ID, expected candidate
   hashes, `decision_kind:"sealed-campaign"`, `sealed_head:true`,
   `campaign_base_commit_id`, exact paths, factions/abilities, and implementation matrix. It declares
   every changed path under its exact recognized matrix surface (intermediate verification
   is not closure evidence). It inventories `jj diff --from
   <campaign_base_commit_id> --to @-` and binds `sealed_head:true`, the frozen base, and
   exact sealed head in its envelope. Then invoke
   `wf-close-campaign.js` with the frozen campaign-manifest path/hash, hashed
   author/verify/review/rescore artifact files, baseline/current report paths, ledger,
   per-faction means, final verification, normalized prose diff, and expected head. It hard-runs jj-compatible `just preflight`, rebuilds all four runners, runs
   all six parity pairs, validates score/terminal artifacts, and invokes inquisitor in
   close mode over all ten anti-conditions.
4. Ship ONLY when the workflow returns `ready_to_publish:true`: `jj bookmark create
   wnmitch/dsl-cNNN-<slug> -r "commit_id(<publish_commit_id>)"` (never re-resolve
   symbolic `@-` after the gate), then `jj git push --bookmark
   wnmitch/dsl-cNNN-<slug> --allow-new`, `gh pr create --draft` — PR body:
   own-words summary, worklist table (ids, statuses, cos start→best), justifications for
   any cosine drops, inbox blocks filed, escalations. No GW prose, no personal info.
5. Before calling the campaign converged, confirm the PR has no merge conflict and all
   required CI checks pass. A red/conflicted draft remains `open`, never converged.
6. Persist: registry entry → `converged` (+pr, mean_after, finished); `memory_store`
   (tags: `40kdc-data`, `dsl-loop`) one-paragraph campaign summary.
7. Report to the user: PR link, mean before→after, statuses, escalations, and anything
   `blocked_shapes` gained. If aborted instead: exact reason, what converged first,
   registry state — never dress an abort as convergence.

## Registry (`_private/loop-state/registry.json`)

Machine source of truth; driver-written only; gitignored (never rides the PR).
`campaigns[]` {id, kind: faction-led|shape-led|inbox-led|describer-led|shape-scout, target, bookmark,
status: open|converged|aborted, pr, worklist_size, mean_before, mean_after, started,
finished, notes} · `blocked_shapes[]` {proposal, why, reopen_when} — dedup source for
swarmlord/warpsmith proposals (full seen-set; reopen only when `reopen_when` is met with
cited new evidence) · `ability_ledger` {"faction/id": {status, campaign, cos_start,
cos_best, attempts, justification, artifacts:{author,verify,review,rescore}}} ·
`escalations[]` {question, raised_by, campaign,
resolved}.

## Field notes

- Cull/stop driver-spawned agents as soon as their output is verified.
- A workflow failure is not permission to hand-simulate its roles. Diagnose/restart
  the workflow or abort with a blocking escalation; the fixed routing and OMP
  invocation log are part of the evidence.
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
