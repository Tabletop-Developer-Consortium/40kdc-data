# Rig-backed DSL campaign harness

Contributor-only, crash-safe ability-DSL campaign orchestration. This workspace is intentionally standalone: run Cargo commands from this directory, not the repository root.

## Safety invariants

- State must live outside the repository and sibling raw-text/embeddings stores.
- Codex App Server with ChatGPT subscription authentication is the default transport. `OPENAI_API_KEY` is rejected.
- Campaign manifests freeze the executable, Rig lockfile, App Server binary/protocol, role prompts/schemas, policies, source hashes, baseline DSL hashes, and baseline score report.
- Repository writes require `--apply`. Schema-shape writes additionally require `--apply-shapes` and the exact authorized plan hash; provider-authored executable/source/build-manifest paths are rejected and must be handled outside the autonomous campaign.
- Publication requires a sealed campaign, close verification, and an explicit authorization for the exact sealed head.
- Raw source prose and provider conversations remain sensitive external artifacts. They are rejected from repository writes and publication bodies.

## Build

```bash
cd tooling/dsl-campaign-rig
cargo build --locked --bin dsl-campaign
export DSL_CAMPAIGN_STATE_ROOT="$HOME/.local/state/40kdc-dsl-campaign"
```

Use the same binary for planning and the full campaign. Rebuilding changes its frozen identity and intentionally prevents resuming an existing campaign with different code.

## Preflight

```bash
target/debug/dsl-campaign --repo ../.. init
target/debug/dsl-campaign --repo ../.. doctor
```

`doctor` verifies the external state root, tracked-tree privacy, role contracts, App Server protocol, and subscription-only authentication without starting a model turn.

## Freeze and plan

Generate the complete frozen manifest from an ordered worklist and an existing full baseline report:

```bash
target/debug/dsl-campaign --repo ../.. plan \
  --campaign c012 \
  --worklist faction-id/ability-one,faction-id/ability-two \
  --baseline-report ../../../40kdc-embeddings/_reports/roundtrip-batch-c012.json
```

The command resolves each raw source and current DSL entry, binds its score row, freezes every identity, creates the event stream, and queues the worklist. For a separately reviewed manifest, use `plan --manifest PATH` instead; every frozen hash is revalidated before it is accepted.

## Run without repository mutation

```bash
target/debug/dsl-campaign --repo ../.. run --campaign c012 --read-only
target/debug/dsl-campaign --repo ../.. status --campaign c012
target/debug/dsl-campaign --repo ../.. inspect --campaign c012 --ability faction-id/ability-one
```

Read-only execution performs retrieval, decomposition, assembly, and review work, then stops before a repository effect. The event store and sensitive CAS remain external.

## Apply and resume

```bash
target/debug/dsl-campaign --repo ../.. run --campaign c012 --apply
target/debug/dsl-campaign --repo ../.. worker --campaign c012 --until-idle --apply
```

Add `--apply-shapes` only for a campaign explicitly allowed to implement an approved first-class schema shape. Workers use deterministic work ids, leases, fencing tokens, and durable outbox receipts. Re-running the same command resumes from replayed state rather than repeating an observed effect.

If a worker reports an unreconciled effect, inspect the external SQLite outbox and repository head first. After independently confirming the side effect, reconcile only that exact outbox id:

```bash
target/debug/dsl-campaign --repo ../.. reconcile --outbox OUTBOX_ID
target/debug/dsl-campaign --repo ../.. replay --campaign c012
```

A failed terminal candidate is rolled back to its pre-ability head before the ability can become `needs-schema`.

## Seal and publish

When all abilities and shapes are terminal, the scheduler seals the exact repository head and runs the fixed close-verification bundle. Publication is a separate authorized operation:

```bash
target/debug/dsl-campaign --repo ../.. authorize publish \
  --campaign c012 --sealed-head SEALED_HEAD

target/debug/dsl-campaign --repo ../.. publish \
  --campaign c012 \
  --sealed-head SEALED_HEAD \
  --bookmark wnmitch/dsl-campaign-c012 \
  --base main \
  --title "feat: author DSL campaign c012" \
  --body-json /external/path/deidentified-pr-body.json

target/debug/dsl-campaign --repo ../.. worker \
  --campaign c012 --until-idle --publish
```

The publication executor verifies authorization, exact sealed head, bookmark/base validity, a conflict-free workspace, deidentified body bytes, and reconciles bookmark/push/draft-PR identities before recording `published`.

## Evidence and privacy checks

```bash
target/debug/dsl-campaign --repo ../.. privacy audit --campaign c012
target/debug/dsl-campaign --repo ../.. projection rebuild
target/debug/dsl-campaign --repo ../.. artifact verify --artifact SHA256
```

Do not copy the external state directory, raw-text store, provider output, source report prose, or scratch files into this repository. Legacy OMP evidence import copies artifacts into the external CAS and replays known c008/c009 failure classifications; it never treats imported evidence as publication authorization.
