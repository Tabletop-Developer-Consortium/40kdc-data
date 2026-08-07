# Provenance-Aware Truth Assembly

## Working thesis

The goal is to author increasingly accurate representations of every game ability by assembling a growing corpus of facts.

Each ability has an underlying mechanic we are trying to depict. The system maintains competing structured representations of that mechanic, accumulates supporting and refuting evidence, and retains the strongest currently warranted representation. A certified representation can later become evidence for another ability, making the corpus recursively more useful.

The graph is not itself the truth. It is the machinery that allows beliefs to improve without losing provenance, confusing repetition with confirmation, or treating a locally attractive change as a global improvement.

## Bayesian intuition without requiring Bayesian machinery

For ability $a$, let:

- $H_a$ be the unknown true mechanic;
- $h \in \mathcal{H}_a$ be a candidate structured representation;
- $E_t$ be the evidence accumulated by time $t$;
- $B_t(h)$ be the system's confidence in candidate $h$.

A new observation updates the belief state:

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
\arg\max_{h \in \mathcal{H}_a} B_t(h)
\quad
\text{subject to hard proof obligations}
$$

This does not require calibrated probabilities or literal Bayesian inference. The essential properties are:

1. Evidence can support or refute candidates.
2. New evidence can overturn a certified incumbent.
3. Stronger and more independent evidence should move confidence further.
4. Correlated observations must not be counted as independent confirmations.
5. Rejected candidates remain available for reconsideration.
6. Uncertainty and unresolved counterevidence remain explicit.

Truth itself does not update. Our confidence that a representation accurately depicts it updates.

## The recursive corpus loop

```text
accepted facts
    ↓
candidate representations
    ↓
checks, experiments, and adversarial review
    ↓
accepted current depiction
    ↓
certified precedent for later abilities
    ↓
new candidates and revised beliefs
```

The corpus contains both atomic facts and certified composite representations. Composite truths become premises for later work, but their derivation and confidence remain attached. If an authority-bearing dependency changes, all dependent representations leave the current projection until re-evaluated.

## Accuracy as process structure

Once accepted source facts are fixed, accuracy becomes primarily a process-structure problem:

$$
\operatorname{accurate}(h)
=
\operatorname{source\ adequacy}
\land
\operatorname{provenance\ closure}
\land
\operatorname{transformation\ soundness}
\land
\operatorname{coverage}
\land
\operatorname{consistency}
\land
\operatorname{freshness}
$$

For an accepted representation, the system should demonstrate:

1. Every represented claim closes onto accepted source facts or certified derivations.
2. Every required source constraint appears in the representation.
3. Composition preserves meaning across the assembled parts.
4. Incompatible facts, branches, scopes, or bindings were not combined.
5. Every authority-bearing dependency is current.
6. Blocking counterevidence is absent or explicitly adjudicated.
7. Whole-corpus effects satisfy the regression policy.

This converts “the agent produced a plausible answer” into “this candidate satisfies explicit proof obligations over this corpus.”

## Hard validity versus evidential confidence

A single score must not decide acceptance.

### Hard validity

A candidate is ineligible if any required invariant fails:

- invalid schema;
- missing source claims;
- invented or foreign claims;
- incompatible composition;
- stale dependencies;
- unresolved blocking findings;
- forbidden collateral regression.

### Evidential confidence

Valid candidates can then be ranked using softer evidence:

- source-to-render fidelity;
- independent adversarial-review survival;
- precedent strength;
- cross-language agreement;
- experiment outcomes;
- whole-corpus score changes;
- uncertainty and remaining unmatched evidence.

A soft improvement can never rescue a hard-invalid candidate. Campaign c010 is the reference case: a renderer change improved the target score but regressed many other outputs, so the globally stronger belief state retained the incumbent.

## Why the evidence graph matters

Naive evidence aggregation produces fake confidence. Five agents using the same source, prompt, model family, retrieved precedent, or intermediate render are correlated descendants, not five independent confirmations.

The graph makes those dependencies explicit through:

- source and policy fingerprints;
- agent, model, prompt, tool, and checker ancestry;
- support and refutation relationships;
- correlation or shared-ancestor relationships;
- authority and independence classes;
- supersession and invalidation;
- retained rejected hypotheses.

Similarity may propose a prior, candidate family, or retrieval path. It does not authorize reuse. Authority comes from current evidence, valid composition, and passed proof obligations.

## Corpus-level hill climbing

The optimization unit cannot be one ability in isolation. Shared schemas, shapes, and describers couple many outputs.

A useful conceptual objective is:

$$
\max \sum_a B(h_a)
\quad
\text{subject to hard invariants and an explicit regression policy}
$$

This does not imply that confidence must collapse to one scalar. The system should retain a confidence vector such as:

- source coverage;
- semantic fidelity;
- composition validity;
- evidence independence;
- adversarial robustness;
- implementation parity;
- freshness;
- regression safety.

A scalar may prioritize work or compare otherwise valid candidates. Certification should still expose the underlying dimensions and hard-gate results.

## Truth modes

Not every terminal proposition has the same epistemic status.

| Mode | Example | What the process can establish |
|---|---|---|
| Derived truth | A structured mechanic assembled from authoritative rule facts | Coverage, entailment, consistency, and freshness |
| Semantic truth | A human/agent representation of source meaning | Bounded fidelity under explicit checks and adversarial review |
| Assessment | A policy-based urgency or risk score | A warranted judgment under named evidence and policy |

The 40K ability pipeline is directly a truth-authoring process: it attempts to produce a faithful structured depiction from atomic source claims. Organizational scoring uses the same evidence machinery, but its result must remain typed as an assessment rather than objective truth.

## Candidate and evidence model

### Candidate lifecycle

```text
proposed
→ eligible
→ preferred
→ certified
→ superseded | invalidated | refuted
```

Certification means “strongest currently warranted candidate that passed every hard obligation,” not “permanently and absolutely true.”

### Suggested node kinds

- `source-fact`
- `source-snapshot`
- `candidate-hypothesis`
- `derived-claim`
- `observation`
- `counterevidence`
- `checker-result`
- `composition-plan`
- `confidence-state`
- `certificate`
- `maintainer-decision`
- `current-corpus-entry`

### Suggested relationship kinds

- `derived_from`
- `supports`
- `refutes`
- `depends_on`
- `correlated_with`
- `satisfies`
- `violates`
- `supersedes`
- `invalidates`
- `authorizes_projection`

Relationship semantics and authority must be part of immutable identity or represented as immutable assertion nodes. An unproven mutable edge flag must not be able to authorize reuse.

## Minimal acceptance procedure

For each ability:

1. Freeze the source snapshot and formalize atomic claims.
2. Retrieve precedents as discovery evidence only.
3. Generate multiple candidate representations where meaningful.
4. Build explicit composition plans for each candidate.
5. Evaluate hard obligations deterministically.
6. Collect soft evidence and record its dependency ancestry.
7. Compare eligible candidates against the incumbent.
8. Evaluate whole-corpus collateral effects.
9. Certify the preferred candidate or certify no change.
10. Project the result into the current corpus.
11. Invalidate and reschedule when an authority-bearing input changes.

## Generic kernel boundary

The reusable component should be a **truth-assembly and evidence-lineage kernel**, not an agent framework, workflow engine, or graph database.

```text
evidence-kernel-spec
  Hypothesis and evidence semantics, dependency classes, canonical identity,
  events, proof obligations, confidence policy, conformance corpus

evidence-kernel-core
  Pure reducers, obligation evaluation, dependence-aware confidence updates,
  certification, supersession, invalidation, current-corpus projection

evidence-kernel-sqlite
  Transactions, migrations, replay, projections, export and import

evidence-kernel-agent
  Framework-neutral lifecycle sink, Rig hook adapter, telemetry correlation

evidence-kernel-attestations
  W3C PROV and in-toto/SLSA adapters

mechanic-evidence-adapter
  Ability claims, composition constraints, IP policy, retrieval, describers

organizational-assessment-adapter
  Tenant-scoped subjects and policies, assessment types, acceptance rules
```

OpenTelemetry should own operational traces, latency, token use, tool execution, and errors. The evidence kernel should own hypotheses, evidence identity, dependence, proof obligations, authority, certification, and corpus projection.

## Current implementation caveats

The existing Mechanic Evidence Graph already demonstrates durable workflow lineage, stale-worker rejection, private-source boundaries, safe projections, and correctness-first no-change outcomes. It does not yet implement the complete belief-revision model.

The existing adversarial findings remain load-bearing:

1. Events cannot deterministically rebuild projections from zero.
2. Relationship semantics are outside node content identity.
3. Certification is schema-shaped rather than mechanically derived.
4. Construction planning is heuristic subset enumeration rather than constrained composition.
5. Semantic graph population remains sparse relative to workflow-output volume.

The next implementation should not add confidence numbers on top of those gaps. That would quantify unsupported conclusions rather than improve accuracy.

## Smallest useful experiment

Prove the model on one mechanic family before extracting a library:

1. Select three abilities with related but non-identical mechanics.
2. Formalize their atomic facts and composition constraints.
3. Produce at least two candidate representations for one ability.
4. Attach supporting and refuting evidence with explicit shared ancestry.
5. Evaluate hard gates and a multidimensional confidence state.
6. Add one new counterexample or source fact.
7. Show the preferred candidate, confidence state, or certification changing.
8. Show a certified precedent affecting another ability without authorizing unsupported reuse.
9. Compare the result against a plain append-only artifact manifest.

The graph earns its complexity if it can answer dependence, invalidation, counterfactual, and certified-reuse questions that the manifest cannot.

## Open design questions

1. What exactly qualifies as an atomic fact in each domain?
2. Which proof obligations are universal and which belong to adapters?
3. How should evidence independence and shared ancestry affect confidence?
4. Should confidence be ordinal, vector-valued, calibrated, or policy-specific?
5. How are contradictory authoritative facts represented and adjudicated?
6. What whole-corpus regression policy permits intentional tradeoffs?
7. How does a certificate expose unresolved uncertainty without becoming meaningless?
8. When may a certified composite truth become a premise for another derivation?
9. How are private payloads referenced without leaking content through hashes?
10. What second domain proves the kernel without importing 40K-specific concepts?

## Immediate next session

Start by specifying the candidate-hypothesis, evidence, dependency, confidence-state, and certificate wire models. Keep hard proof obligations separate from soft confidence updates. Then encode the three-ability experiment as a conformance fixture before changing storage or orchestration.

Re-read `MECHANIC_EVIDENCE_GRAPH_ADVERSARIAL_REVIEW.md` for the implementation audit and generic-library path. The current workspace is based on `wnmitch/dsl-c011-certified-reuse`; `.omp/skills/dsl-campaign/graph/schema.js` has an uncommitted modification that must be treated as concurrent work and not overwritten.
