# Mechanic Evidence Graph: Adversarial Review

## Executive summary

**Recommendation:** Share the architecture and the failure-driven case study now. Do not announce a generic library yet.

The idea is viable. The current implementation is not yet a trustworthy generic evidence engine.

What is worth sharing is **not a novel graph data structure**. The ingredients already exist: content-addressed DAGs, provenance models, event histories, attestations, and materialized projections. The interesting contribution is their composition for **authority-bearing human and agent semantic work**:

- immutable evidence rather than transcript archaeology;
- explicit separation of similarity from authority;
- certificates tied to exact inputs and policy versions;
- stale-worker rejection;
- historical evidence retained after invalidation;
- correctness-first terminal outcomes, including no-change decisions.

That is a strong reference architecture and an honest technical story. Presenting it as a new graph primitive would overclaim. Presenting it as a **certified evidence-lineage pattern for agentic workflows** is defensible.

## Reframing: truth authoring as provenance-aware belief revision

**Yes.** The overarching goal is to author increasingly accurate representations of every game ability by assembling a growing corpus of facts. Each new fact, counterexample, checker result, or certified precedent updates the system's confidence in competing candidate representations.

Bayesian language is useful even if the implementation is not literally Bayesian. For ability $a$, imagine an unknown true mechanic $H_a$, candidate representations $h \in \mathcal{H}_a$, and accumulated evidence $E_t$:

$$
B_{t+1}(h)
=
\operatorname{update}\!\left(
B_t(h),
e_{t+1},
\operatorname{provenance}(e_{t+1}),
\operatorname{dependencies}(e_{t+1})
\right)
$$

The current authored representation is the strongest eligible hypothesis:

$$
h_a^*
=
\arg\max_{h \in \mathcal{H}_a}
B_t(h)
\quad
\text{subject to hard proof obligations}
$$

This is closer to a **provenance-aware truth-maintenance system** or **anytime inference process** than a one-shot certification pipeline. The corpus never has to claim final omniscience. It records the best warranted depiction currently available, why it is preferred, what alternatives lost, and what evidence could change the result.

### Accuracy is mostly process structure

Once the accepted source facts are fixed, the hill climb is governed by process:

1. decompose the source into atomic claims;
2. retrieve candidate mechanics and precedents;
3. assemble one or more hypotheses;
4. reject unsupported composition and incompatible lineage;
5. render and compare against the source;
6. adversarially search for divergences;
7. measure whole-corpus collateral effects;
8. accept, reject, or retain the incumbent;
9. revisit the result when new evidence or better shapes arrive.

Two distinct gates are required:

| Gate | Purpose | Examples |
|---|---|---|
| Hard validity | Prevent structurally invalid “high-confidence” answers | Schema validity, complete claim coverage, no foreign claims, compatible composition, current dependencies |
| Evidential confidence | Rank the valid candidates | Roundtrip fidelity, independent review, counterexample survival, precedent strength, cross-language agreement |

A soft score must never override a failed hard obligation. c010 is the canonical example: a change improved the target score but regressed many other outputs, so the globally stronger belief state retained the incumbent.

### The graph is what prevents fake Bayesianism

Naively adding evidence scores would double-count correlated observations. Five agents using the same source, prompt, model family, and precedent are not five independent confirmations. A renderer score and a reviewer that consumed that render are not independent either.

The evidence graph supplies the missing dependence structure:

- exact source and policy fingerprints;
- shared model, prompt, tool, and checker ancestry;
- support and refutation edges;
- authority and independence classes;
- supersession and invalidation;
- retained rejected hypotheses.

Similarity can propose a prior or candidate family. It cannot authorize reuse by itself. Certification means the current hypothesis crossed the acceptance threshold **and** satisfied every hard obligation; it does not mean its truth value can never be revised.

### Corpus-level hill climbing

The unit of optimization cannot be only one ability. Shared describers, schemas, and mechanic shapes couple many outputs. The useful objective is therefore global:

$$
\max \sum_a B(h_a)
\quad
\text{subject to no hard-invariant failures and explicit regression policy}
$$

The current corpus is the materialized set of accepted hypotheses, each carrying confidence dimensions, proof status, unresolved counterevidence, and complete derivation. Certified results then become evidence for later abilities, creating the recursive climb:

```text
facts → hypotheses → checks → accepted depictions
   ↑                                  ↓
new evidence ← reusable certified precedent
```

The strongest broader framing is an **epistemic build system**, **truth-maintenance graph**, or **truth-assembly kernel**. The graph is not the truth; it is the machinery that lets belief improve without losing provenance or mistaking correlated repetition for independent evidence.

### Readiness judgment

| Deliverable | Status |
|---|---|
| Technical article or design note | Ready |
| Domain-specific open-source prototype | Nearly ready after the P0 fixes |
| Reusable cross-domain library | Premature; the Rig pilot identifies the proof path |
| Generic workflow engine | Do not pursue |
| Generic graph database | Do not pursue |

## What is genuinely strong

### 1. It was derived from real failures

The c009 branch-mixing problem produced concrete invariants rather than speculative architecture. Exact lineage, typed evidence authority, stale-worker rejection, and invalidation all answer observed failure modes.

### 2. A no-change result counts as success

c010 rejected a renderer change that improved the target score but caused broad collateral drift. Certifying the existing implementation is healthier than rewarding visible code churn.

### 3. Authority and discovery are separated conceptually

“Looks similar” does not automatically mean “can authorize reuse.” That distinction is the most valuable part of the model.

### 4. The boundary protections are thoughtful

Lineage envelopes, active leases, recursive payload sanitization, private source-text handling, safe browser projections, and compatibility projections all fail in the conservative direction.

### 5. The implementation has meaningful automated coverage

The current graph suite exercises immutability, hash chains, stale leases, projection safety, pagination, graph caps, legacy intake, and IP checks. The UI also has substantial store and client coverage.

## P0 findings: fix before trusting reuse

### 1. The system is not actually event-sourced

`GraphStore.appendEvent()` accepts any event name and an arbitrary projection callback:

- `.omp/skills/dsl-campaign/graph/store.js:127-140`;
- the transition catalogue in `reducer.js` is not invoked by `appendEvent()`;
- projection behavior exists only as ephemeral callback code;
- projection tables are also mutated directly through public `store.db` access.

An adversarial probe appended an event named `not-in-transition-catalogue` and used its callback to move a run from `active` to `completed`. It was accepted and persisted.

Consequences:

- the transition matrix is advisory, not authoritative;
- events cannot rebuild projections from zero;
- “replay checksum” means “hash of the stored event hashes,” not deterministic state replay;
- two implementations can consume the same events and derive different states.

#### Recommended change

Replace `appendEvent(event, projectionCallback)` with a command dispatcher:

1. Load aggregate state and expected version.
2. Run the registered deterministic reducer.
3. Reject unknown or invalid transitions.
4. Append emitted events.
5. Apply registered projectors in the same SQLite transaction.
6. Support deleting all projection tables and rebuilding them solely from the event log.

Until that works, describe the implementation as an **append-only audit log with transactional projections**, not event sourcing.

### 2. Relationship semantics are outside content identity

`nodeIdentity()` hashes:

```text
kind + payload hash + sorted input_node_ids + producer contract version
```

It does not hash parent roles, edge types, or reuse authority:

- `.omp/skills/dsl-campaign/graph/canonical.js:34-45`;
- `.omp/skills/dsl-campaign/graph/store.js:97-121`.

An adversarial probe created the same child twice:

- first through `similar_mechanic`, non-authoritative;
- then through `satisfies`, authoritative.

Both calls returned the same node ID, while SQLite contained both contradictory relationship meanings.

Consequences:

- the object store is not a self-contained representation of the evidence graph;
- graph meaning depends on write history in `index.sqlite`;
- exporting the content-addressed objects loses authority semantics;
- the same node ID does not guarantee the same graph.

#### Recommended change

Choose one clean model:

1. Include typed parents in identity:
   `parents: [{ node_id, role, edge_type, authority_basis }]`; or
2. Make every relationship an immutable, content-addressed assertion node.

Do not let a caller set `authorizes_reuse: true` as an unproven edge flag. Authority should be derived from a current certificate and policy evaluation.

### 3. Certification is schema-shaped, not mechanically proven

`assertAllowedNode()` only checks top-level key names. It does not enforce required fields, field types, claim structure, uniqueness, or cross-field invariants:

- `.omp/skills/dsl-campaign/graph/schema.js:45-80`.

The intake certification gate uses truthiness:

- `.omp/skills/dsl-campaign/graph/intake.js:149-166`.

A certified outcome can currently carry:

- `claims: []`;
- an empty `coverage` object;
- no proof that `covered_claims` equals the claim set;
- no proof that claim IDs are unique;
- no proof that clause anchors cover the source;
- `unmatched_claims: []` because intake hardcodes it.

That can produce an authoritative certificate with no mechanically demonstrated coverage.

#### Recommended change

Introduce versioned schemas and a deterministic certificate evaluator. Certification should require:

$$
\text{covered claims} = \text{declared claims}
$$

It should also require:

- non-empty, uniquely identified claims;
- every required source clause anchored;
- no unmatched or foreign claim IDs;
- no unresolved blocking findings;
- exact current dependency fingerprints;
- explicit policy and checker versions;
- a recorded derivation of the verdict, not a submitted `status: certified`.

### 4. The construction planner can authorize structurally bad plans

`candidatePlans()` and `chooseConstructionPlan()` have several correctness problems:

- `.omp/skills/dsl-campaign/graph/retrieval.js:61-89`.

Observed adversarial results:

- it selected both a redundant exact match and a complete subfamily match, introducing an unnecessary composition seam;
- it accepted a candidate covering `["c1", "foreign-claim"]` and emitted `foreign-claim` as covered;
- exact-match count is prioritized before unmatched-claim count;
- overlapping ownership is not checked;
- ordered branches and incompatible seams are not modeled;
- the bitmask search silently caps its enumeration at 20 candidates, with JavaScript bit-shift aliasing above 31.

This is not yet a constrained graph cover. It is subset enumeration with a heuristic sort.

#### Recommended change

1. Reject coverage IDs not present in the target claim set.
2. Maximize complete target coverage before exactness.
3. Forbid overlapping ownership unless a declared composition rule allows it.
4. Model binding, ordering, quantifier, and consumer-port constraints explicitly.
5. Replace the silent bitmask cap with a deterministic solver or bounded branch-and-bound result that reports truncation as a blocking condition.

### 5. The implemented graph is still mostly workflow provenance

The initial review snapshot contained 232 nodes, 360 events, and 500 edges. The graph continued to grow while this report was being revised. A later live c011 snapshot showed:

| Metric | Count |
|---|---:|
| Nodes | 243 |
| Events | 408 |
| Edges | 560 |
| `workflow-output` nodes | 131 |
| Clause-map projections | 0 |
| Family instances | 0 |
| Apply transactions | 0 |
| Source-formalization certificates | 1 |
| Certified-ability-evidence nodes | 1 |
| c011 tasks | 163 |
| c011 tasks succeeded / running / invalid-output | 132 / 30 / 1 |
| c011 active claims | 15 |

c011 was actively writing during inspection, so those counts are a progress snapshot, not a stable fixture. They do prove that the graph is now carrying a substantial autonomous campaign: task state, failures, leases, and workflow outputs are visible while work is in flight.

They also preserve the original concern. The additional volume was operational lineage: the semantic projections remained empty and the store still had one certified ability. The graph currently demonstrates **durable campaign lineage** more strongly than the full proposed claim, family-reuse, invalidation, and apply model.

This does not invalidate the architecture. It means the architecture's most distinctive claim has not yet been exercised across enough successful domain paths. A generic library would still be extracting abstractions from mostly empty semantic tables and one certified domain result.

## Current implementation improvements

### 1. Make the safe UI explain evidence, not merely display topology

The interface is visually coherent and clearly marks itself local-only. The safe projection boundary is good. The evidence view does not yet answer the essential question:

> Why is this result certified?

In the live ability view:

- 118 nodes were fit onto one desktop canvas, making most labels microscopic;
- many nodes were generic `workflow output · <hash>`;
- the inspector showed kind, status, campaigns, and references, but not the safe claim summary, certificate basis, failed alternatives, checks, or invalidation risk;
- 120 of 232 stored nodes were workflow outputs.

The default view should be a semantic critical path:

```text
source fingerprint
→ formalized claims
→ selected and rejected precedents
→ construction or no-change decision
→ candidate
→ findings and checks
→ terminal certificate
```

Collapse agent invocations and lease activity into phase groups. Provide a separate provenance expansion for debugging.

The ongoing UI/API work materially improves the operational half of this recommendation:

- `campaignList()` now aggregates task, claim, finding, and check states;
- the client loads campaign progress independently of graph pagination;
- `selectCampaign()` now opens a real campaign projection instead of being a no-op;
- campaign graph pagination and revision-aware SSE invalidation are implemented;
- viewport changes trigger a re-fit instead of leaving stale geometry.

That reconciles the initial review with the implementation now in flight: current campaign progress is becoming inspectable. The remaining gap is semantic. A campaign dashboard can show that 132 tasks succeeded without yet showing which assertions those tasks established, which evidence authorized them, or why the current certificate is trustworthy.

The inspected in-flight diff changes campaign projection, query, streaming, and presentation code. It does not change the event reducer boundary, node identity, certificate evaluator, or planner. The four semantic P0 findings therefore remain open.

### 2. Move filtering and search to the server

The UI loads 100 alphabetically ordered abilities and filters them locally. At inspection time this exposed only one faction in the filter options, even though the catalog contains 3,122 abilities.

“Search” therefore means “search the currently loaded page,” which is misleading.

Add server-side query parameters for:

- search text;
- faction;
- evidence or certificate status;
- active campaign;
- minimum evidence count.

Return facet counts for the whole result set.

### 3. Close the API contract

The backend exposes `store.db` broadly. The frontend manually duplicates runtime decoders, and the new graph decoder validates nodes partially but does not fully validate edges, ability references, campaign references, or nested metadata.

Use one versioned schema to generate:

- server response validation;
- client types and decoders;
- conformance fixtures;
- compatibility tests.

Unknown response fields should be rejected or explicitly preserved through an extension map.

### 4. Replace global rebuilds with incremental projections

`createNode()` and every event call `rebuildNodeAbilityRefs()`. Graph queries scan all projection tables and recursively inspect node payloads for campaign references.

That is acceptable at 232 nodes. It will not remain acceptable for a generic artifact store. The 56 graph tests passed, but the suite took 11.58 seconds despite small fixtures; several individual end-to-end fixtures took more than a second.

Maintain incremental reference indexes from the newly inserted node and affected descendants. Add benchmarks before increasing the UI cap.

### 5. Tighten integrity and privacy claims

The hash chain catches accidental modification, but it is not tamper-proof:

- hashes have no signature or external checkpoint;
- `reconcile()` verifies file bytes against indexed byte hashes but does not recalculate the full node identity formula;
- source-text protection includes field-name rules and exact or contained store-string checks, not a general non-leakage proof.

Market these correctly as **integrity checks and local policy gates**. If hostile tampering matters, add signed checkpoints or export attestations suitable for an external transparency system.

## Process review

The process took the right first step and then expanded too many layers simultaneously.

### What worked

- Postmortem first: c009 supplied concrete counterexamples.
- Explicit invariants instead of more review agents.
- Legacy evidence imported as non-authoritative.
- Correctness-first terminal results.
- A UI was built early enough to expose that provenance volume is overwhelming semantic evidence.

### What to change

Use a hypothesis ladder rather than implementing storage, scheduling, retrieval, certification, query APIs, and visualization together:

1. **Lineage hypothesis:** Can incompatible parents ever be mixed?
2. **Certification hypothesis:** Can a verdict be recomputed from immutable evidence?
3. **Invalidation hypothesis:** Does changing any authority-bearing input revoke every descendant?
4. **Reuse hypothesis:** Does certified precedent improve a second ability without introducing an unsupported claim?
5. **Operational hypothesis:** Can the system crash, replay, and resume without manual SQLite repair?

The first three should be deterministic fixtures. The fourth requires at least one real cross-ability family. The fifth requires crash injection and replay, not only happy-path tests.

Also build a counterfactual baseline: an append-only manifest of artifacts and attestations without a graph database. If that simpler system cannot answer invalidation and family-reuse queries, the graph has justified its cost. If it can, reduce the architecture.

## Cross-domain check: Adversarial's Rig agents

The in-progress Rig migration is not merely analogous to the 40K agents. It is a credible second adapter for the same evidence lifecycle.

The local agent changeset inspected for this review (`af1211266f0b`) introduces:

- build-once, organization-agnostic `ArmAgent<P>` instances;
- `Skill` contracts that declare instructions, grounding documents, and tool allow-lists;
- per-request tenant scope through Rig `ToolContext`;
- `GroundingHook`, which refuses a run that skipped a declared policy document;
- `Runner` reconciliation, which rejects unrequested, duplicate, and missing score IDs;
- risk and incident agents that fetch current register records and delegate threat reasoning to a subagent;
- suggest-only A2A `SendMessage` endpoints.

That maps directly onto the evidence graph:

| Rig scoring concept | Evidence-graph role |
|---|---|
| Organization-scoped record | Subject/source snapshot |
| Policy-document fetch | Normative input snapshot |
| Agent profile + skill | Versioned producer and procedure |
| Tool or subagent result | Observation or derived evidence |
| Typed score | Candidate assertion |
| Grounding and ID reconciliation | Deterministic checks |
| Persisted accepted score | Current corpus projection |
| Re-score after changed input | Supersession and invalidation |

### The exact gap the graph closes

The proposed runner's cache identity hashes the organization ID and serialized item. It does not include the organization profile, rendered policy-document contents, skill prompt, model, tool definitions, or checker versions. `GroundingHook` proves that expected slugs were fetched, but not which content version grounded the answer. A policy or prompt change can therefore leave a cached score looking current when its authority-bearing context changed.

The evidence kernel should define one content-addressed **assessment envelope** containing references or fingerprints for:

1. the subject snapshot and linked records;
2. every normative policy snapshot;
3. agent, skill, prompt, model, tool, and schema versions;
4. tool and subagent observations used;
5. the candidate output;
6. deterministic checker results;
7. any human acceptance or override.

Changing any authority-bearing member invalidates the current projection while preserving the previous assessment as history. This is the same invariant that prevents branch mixing in the 40K campaign.

### Do not call every score a fact

Use an explicit assertion taxonomy:

- **source observation:** a versioned register or document state, without claiming the record is externally true;
- **normative premise:** an adopted policy statement;
- **agent assessment:** a derived, probabilistic judgment under named inputs;
- **human decision:** an acceptance, rejection, or override;
- **current organizational assertion:** the active projection selected by policy.

A defensible assertion is therefore scoped at least by subject, predicate, value, valid time, transaction time, provenance, and authority status. “Risk X has score Y” is too strong. “Agent A assessed risk X as Y under policy P and workflow W at time T; checks C passed” is inspectable and honest.

### Rig integration boundary

Do not fork or wrap Rig's runtime into the core library. Rig already exposes provider-neutral per-run `AgentRunner` hooks over tool and prompt lifecycle events. Add a thin hook that emits framework-neutral evidence events and receives graph-issued run/attempt/lease context.

Also export ordinary runtime telemetry using the developing [OpenTelemetry GenAI agent and framework semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md). OpenTelemetry should own spans, latency, token use, tool execution, and errors. The evidence kernel should own immutable inputs, proposition identity, authority, certification, invalidation, and corpus projection. Correlate them by run ID; do not turn observability spans into authority-bearing evidence automatically.

### Organizational privacy boundary

The 40K implementation protects private source prose for IP reasons. An organizational corpus raises the harder version of the same problem: register records, policy text, prompts, and tool results can be confidential.

The generic object layer should not require raw payloads. It should support tenant-scoped opaque references, encrypted private blobs, retention and deletion policy, payload classification, and redacted public projections. Plain content hashes are not anonymization: they can reveal equality or enable membership guesses. Use tenant-keyed digests or random object IDs where cross-tenant deduplication is not explicitly authorized.

### Second-domain proof

Use one Adversarial scoring path as the generic-library gate:

1. Capture a complete risk or incident assessment envelope through a Rig hook.
2. Project the checked output as an `agent-assessment`, not unquestioned truth.
3. Change one source record or policy revision.
4. Prove the old assessment leaves the current corpus but remains queryable historically.
5. Re-run and show exactly which evidence and authority path changed.

If the same kernel supports this and mechanic authoring without domain-specific core types, the generic boundary is real.

## Generic library viability

### Recommended positioning

Build a **truth-assembly and evidence-lineage kernel**, not an agent framework or graph database.

Its differentiator:

> Governed facts plus provenance-aware belief revision, typed derivations, hard proof obligations, confidence-bearing hypotheses, invalidation, and safe current-corpus projections for mixed human and automated work.

Existing standards already cover adjacent territory:

| Existing work | What it already owns |
|---|---|
| [W3C PROV-DM](https://www.w3.org/TR/prov-dm/) | Domain-neutral entities, activities, agents, and provenance relationships |
| [in-toto](https://in-toto.io/) | Open metadata for which steps ran, by whom, and in what order |
| [OpenLineage](https://openlineage.io/docs/spec/object-model/) | Runtime and design lineage events for jobs, runs, and datasets |
| [Temporal](https://docs.temporal.io/workflows) | Durable workflow execution and deterministic event-history replay |
| [OpenTelemetry GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md) | Agent, workflow, model, tool, error, and usage telemetry |
| [Rig](https://github.com/0xPlaygrounds/rig) | Provider-neutral agent execution, tools, subagents, typed prompting, and lifecycle hooks |
| [SLSA provenance](https://slsa.dev/spec/v1.2/provenance) | Verifiable artifact-production provenance |

### Proposed package boundary

```text
evidence-kernel-spec
  Canonical wire model, hypothesis and evidence semantics, dependency classes,
  identity formula, event semantics, assertion taxonomy, conformance corpus

evidence-kernel-core
  Pure canonicalization, reducers, hard-obligation evaluation, confidence
  updates, certification, invalidation, current-corpus projection

evidence-kernel-sqlite
  Transactions, migrations, projections, replay, export and import

evidence-kernel-agent
  Framework-neutral lifecycle sink, Rig hook adapter, OpenTelemetry correlation

evidence-kernel-attestations
  W3C PROV and in-toto or SLSA import-export adapters

mechanic-evidence-adapter
  40K claim schemas, IP policy, retrieval constraints, safe UI projections

organizational-assessment-adapter
  Tenant-scoped subject/policy references, assessment taxonomy, acceptance rules
```

Do not extract `GraphStore` wholesale. Define the domain-neutral contracts first, then port only the code that satisfies them.

### Five-phase open-source path

#### Phase 1: Freeze the specification

Define the threat model, canonical encoding, typed-parent identity, event versioning, hypothesis and evidence semantics, dependence/independence classes, hard proof obligations, confidence-update policy, invalidation, and authority rules. Prefer a recognized canonical encoding such as RFC 8785 JSON Canonicalization or deterministic CBOR over bespoke cross-language JSON rules.

#### Phase 2: Build the deterministic core

Exclude SQLite and workflow orchestration. Given hypotheses, evidence, commands, and policies, the core must emit the same events, obligation results, confidence state, certificates, and invalidations in every implementation.

#### Phase 3: Add a replayable storage adapter

Hide raw database access. Support migrations, atomic writes, crash recovery, export and import, full projection deletion, and deterministic replay.

#### Phase 4: Prove the Adversarial scoring adapter

Keep the mechanic graph as one adapter. Capture one complete Rig scoring path as the second: source and policy snapshots, skill/model/tool versions, subagent observations, candidate score, deterministic checks, and accepted projection. Then mutate one authority-bearing input and prove invalidation plus re-assessment. If the kernel requires 40K or risk-specific concepts, the abstraction is wrong.

#### Phase 5: Publish an alpha only after conformance

Include a specification, JSON Schemas, property tests, crash fixtures, malicious-input fixtures, benchmarks, a CLI inspector, and explicit compatibility guarantees. Keep the workflow UI and scheduler integrations optional.

### Go or no-go gates

- Rebuilding from immutable objects and events reproduces every projection byte-for-byte.
- Insertion order cannot change node identity, authority, or query results.
- Unknown events, invalid transitions, stale leases, and incomplete certificates fail closed.
- Every claim in an accepted representation closes onto governed facts or certified derivations.
- Correlated evidence is not counted as independent confirmation.
- A soft confidence improvement can never override failed coverage, composition, freshness, or regression obligations.
- A second domain uses the kernel without modifying its core types.
- The graph proves value over a plain artifact manifest on invalidation or certified reuse.
- Changing a source, policy, workflow, model, tool contract, or checker removes every dependent assertion from the current corpus while retaining its history.
- Agent traces can be recorded without persisting confidential source text in the public or content-addressed object layer.

If those conditions hold, the library is viable.

## Publication path

### Suggested title

> **From Facts to Better Truths: A Provenance Graph for Agentic Semantic Authoring**

### Recommended article structure

1. **The failure:** c009 combined individually plausible but jointly incompatible branches.
2. **The invariants:** exact lineage, authority separation, invalidation, leases, and certificates.
3. **The result:** c010 produced a correctness-first no-change certificate and rejected an attractive but globally harmful edit.
4. **The generalization:** Rig scoring agents perform the same evidence-to-assessment cycle against organization-scoped records and policies.
5. **The limitation:** deterministic replay is not implemented, semantic graph population is sparse, and the cross-domain adapter is not yet proven end to end.

### Claims to avoid for now

- “New graph data structure.”
- “Tamper-proof.”
- “Event-sourced.”
- “Generic agent memory.”
- “Solves hallucinations.”

### Defensible claim

> The prototype treats each authored mechanic as a revisable hypothesis: evidence updates its confidence, hard proof obligations gate acceptance, and the corpus retains the strongest currently warranted representation plus its complete derivation.

## Verification performed

### Automated checks

- Graph suite: **56 of 56 passed**, 11.58 seconds.
- Evidence UI: **35 of 35 tests passed**.
- `svelte-check`: **0 errors and 0 warnings**.
- Production UI build: passed, 406 modules transformed.

### Browser smoke checks

- Desktop at 1440 × 1000.
- Mobile at 390 × 844.
- Global index exercised.
- Search and ability selection exercised.
- Graph rendering and safe node detail exercised.

### Cross-repository inspection

- Live c011 store snapshot: 243 nodes, 408 events, 560 edges; 163 tasks with 132 succeeded, 30 running, and 1 invalid output at capture time.
- Current UI/API changes inspected for campaign progress aggregation, campaign projection navigation, pagination, and revision-aware streaming.
- Adversarial Rig agent changeset `af1211266f0b` inspected for agent/skill contracts, grounding hooks, tenant-scoped tools, score reconciliation, caching, subagent delegation, and A2A transport.
- Rig lifecycle-hook behavior checked against current upstream documentation.
- OpenTelemetry's GenAI agent/framework span conventions checked; their status is Development, so they are an interoperability target, not an authority model.

### Adversarial probes

- An unknown event can drive an arbitrary state transition.
- Contradictory edge semantics can share one node ID.
- The planner selects redundant coverage.
- Foreign claim IDs can enter `covered_claims`.

## Final recommendation

The architecture is worth sharing now as an honest, failure-driven approach to hill-climbing toward accurate depictions of every ability. Its central contribution is not merely provenance or certification, but provenance-aware belief revision: facts support or refute candidate representations, hard obligations constrain the search, and accepted hypotheses re-enter the corpus as reusable evidence. The generic library becomes worth shipping only after dependence-aware evidence updates, event replay, authority-bearing identity, mechanical coverage and composition checks, whole-corpus regression policy, and cross-domain invalidation are real rather than aspirational.
