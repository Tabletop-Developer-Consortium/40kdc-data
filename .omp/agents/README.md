# Ability-authoring subagents

Subagent definitions for the Ability-DSL authoring loops. They live in
`.omp/agents/` — OMP task discovery skips `.claude/agents`, so the suite must sit
under `.omp/` to be spawnable. A main session or a Workflow script spawns these via
the task/Agent tool; each returns **a single JSON object as its final message** so
orchestrators can consume output mechanically (Workflow `schema:` and the `output:`
frontmatter both pin it). Some agents spawn helper agents themselves (see `spawns`).

## Conventions

- Frontmatter keys: `name`, `description`, `model`, `tools`, and optionally
  `spawns` and `output`. `name` matches the filename. `model` is the EXPLICIT
  provider/model selection point. All 16 roles are pinned to
  `openai-codex/gpt-5.6-luna`; do NOT use bare model aliases here, because OMP fuzzy
  matching can resolve them to stale provider ids and account-level rate limits can
  kill nested spawns mid-run.
- `spawns` (CSV/array of agent names) lets an agent spawn those helpers itself via
  the task tool — the kroot shape-scout agents and arch-magos use it. Nested spawns
  need `task.maxRecursionDepth >= 2` (set in `.omp/config.yml`); keep spawn trees ONE
  level deep — a lead spawns leaf helpers as siblings, never a grandchild chain, which
  the depth cap silently strips (the child loses its task tool with no error).
- `output` (a JSON Schema written as YAML) pins an agent's output shape on ANY spawn
  path. A workflow `agent(prompt, {schema})` forces the shape, but a nested
  agent→agent spawn carries NO per-call schema — so every agent that another agent
  spawns (the decomposers, data-enginseer, swarmlord, eversor, psyker, and the kroot
  agents) declares `output`, kept byte-identical to the contract the workflow embeds.
  Any opaque/pass-through object slot (`type: object` or `[object, "null"]` without
  explicit `properties`) MUST set `additionalProperties: true`; otherwise OpenAI/Codex
  schema validation strips nested child evidence to `{}` and the workflow loses proof
  that the spawned helper actually returned data.
- `description` is the only text the spawning session sees when routing: it
  carries (1) the one-line role, (2) trigger examples, (3) the input contract in
  one clause, and (4) "Returns a single JSON object as final message."
- Body section order, all agents:
  `## Role` → `## Inputs (prompt contract)` → `## Output (JSON contract)` →
  `## Tool inventory` → `## Design principles` → `## Failure modes` →
  `## Field notes (mined)` — or `## Field notes (design rationale)` for a new agent
  with no mined transcripts yet.
- `tools` is always explicit. Frontmatter cannot scope Bash read-only, so agents
  with Bash carry body-level rules: read-only commands; writes only under the
  session scratchpad. `warpsmith` is the only agent with repo write access.

## IP boundary (applies to every agent)

GW rules prose may be **read** (the out-of-repo store `../40kdc-abilities`, the
embeddings-harness reports) and **returned to the orchestrator** inside the JSON
final message, but must never be **written into any file inside this repo**.
Anything an agent writes to committed files — `community_notes`, `[APPROX]`
notes, inbox entries, field notes — is own-words paraphrase.

## The suite

| responsibility grouping | agents | job |
|---|---|---|
| retrieval and verification | data-enginseer, target-dummy, chronomancer, vox-hound, skitarius, eversor | retrieval, WHO/WHEN/WHAT decomposition, mechanical gating, adversarial refutation |
| engineering and expansion | psyker, warpsmith, swarmlord, cogitator, kroot-lone-spear, kroot-trail-shaper | describer QA, describer engineering, cross-faction expansion, cruncher-lever guarding, shape coverage-adjudication, shape describer-design |
| assembly and curation | arch-magos, inquisitor, kroot-flesh-shaper, kroot-war-shaper | DSL assembly, coverage curation + final review, new-shape proposal, adversarial shape review |

These groupings describe responsibilities only; they are not model tiers. Every listed role uses `openai-codex/gpt-5.6-luna`.

The four `kroot-*` agents are the **shape-scout sub-suite** (`workflows/wf-shape-scout.js`):
when an ability resists every existing shape, they design a NEW one rather than flatten
it onto an over-similar neighbour (the necron obelisk-vs-tau collision). flesh-shaper
proposes (spawning the decomposers + data-enginseer), lone-spear broadens the faithful
family without flattening (spawning swarmlord), trail-shaper specs the describer
(spawning psyker), and war-shaper adversarially reviews (spawning eversor + swarmlord)
and emits the warpsmith-ready shape package.

Typical author-loop wiring: inquisitor prioritizes → data-enginseer retrieves →
target-dummy + chronomancer + vox-hound decompose in parallel (deferred `lookups_needed`
route back to data-enginseer) → arch-magos assembles (revising on the FULL panel thread,
not just the last round) → eversor panel refutes → skitarius gates → cogitator diffs
levers → psyker/warpsmith handle describer findings → swarmlord scouts the next family →
inquisitor reviews and loops. On a `needs-schema` family, the driver forks to the kroot
shape-scout sub-loop.

## Cross-cutting field notes (mined)

Suite-wide rules mined from 30 ability-coverage session transcripts (2026-07-12):

- The IP boundary is absolute: raw GW prose lives only in the out-of-repo 40kdc-abilities store; the embeddings harness is a derivative that must live in the sibling ../40kdc-embeddings, use a local sentence-transformer (never an external API), never be committed, and be advisory triage only (never a deterministic conformance gate); all reports emit ids/scores/types/describer-English or de-IP'd fingerprints only.
- TypeScript is the byte-identical oracle (tools/src/translate/effect.ts, condition.ts, cruncher/from-dsl.ts) — Rust/Python/Go must reproduce identical output pinned by the conformance corpus; port logic faithfully, not approximately, and prove parity with tooling/parity/differ.py, not with each port's own suite.
- Adding a new effect shape is never a loose tweak: it requires a schema oneOf branch, four-language type regen, a describer arm in each language (inline AND container forms), cruncher recursion support, a conformance golden, a SPEC_VERSION bump, and the four-file version lockstep — ship it as a patch release, and prove one construct end-to-end (schema->codegen->4 describers->cruncher->conformance->differ) as a vertical slice before batch-applying the pattern.
- `just preflight` is THE pre-push CI mirror (regen drift + four suites + version lockstep); activate python/.venv on PEP-668 machines and seal jj work with `jj new` first, since git-based verify-clean falsely flags uncommitted work as drift under jj.
- SPEC_VERSION bumps on any semantic corpus change and is derived from generated corpus content, not chosen manually — on a merge, regenerate the corpus fresh from merged data and bump to the next integer past both sides rather than keeping either branch's number.
- The four version files (tools/package.json, crates/wh40kdc/Cargo.toml, python/src/wh40kdc/_version.py, go/version.go) move together and CI hard-fails on drift; check whether the target PR/branch already owns the bump before touching them.
- jj hygiene: run `jj new` before starting independent work so you don't amend into another session's in-progress commit (interleaved hunks can't be cleanly split after the fact); `jj git fetch` before trusting remote state; never commit to main (it only mirrors upstream); split unrelated work into its own commit; use `git cherry` (patch-id) not three-dot diff for branch triage.
- Before a big-bang migration or broad changeset, inspect the working tree for in-progress uncommitted work from a parallel session and reconcile rather than overwrite — green intentional work from another change is often present, and clobbering it is a regression.
- Batch re-authoring workflow: draft candidate shapes, probe each through the describer in isolation (write candidate JSON to a file, not an inline heredoc), apply with a restorable snapshot, run schema+integrity validation, re-score cosine for only the edited abilities, then fan the batch out to parallel adversarial skeptic sub-sessions (~5 abilities each) that return PASS/REJECT with named faults — only after skeptics PASS does the batch count as converged.
- Review the full git status and diff before committing a broad changeset — stray scratch/prototype files (tools/_proto_tmp.ts) and unrelated parallel-session work get swept in; confirm a source-only commit contains no leaked generated artifacts, and regenerate derived artifacts in dependency order (TS bundles schemas first, then Rust/Python/Go depend on it).
- Confirm the target of multi-part machinery+data work with the user before splitting into separate PRs, and when told to 'stack onto' an existing PR, advance that branch's bookmark rather than opening a second stacked PR.
- Triangulate three independent gate types after any data-shape migration — whole-dataset prose-diff (catches unintended abilities changing), the cross-impl differ (catches port-to-port divergence), and AJV+integrity validation (catches schema violations) — since each catches a failure class the others structurally cannot.
