# 40kdc-data task runner.
#
# `just preflight` is THE pre-push gate: it reproduces, locally, every check that
# .github/workflows/validate.yml fails on (minus the main-only publish jobs). A
# green preflight means a green CI — the long-standing trap was that
# `npm test && npm run validate` covers only ~6 of the ~22 CI gates (the
# four-language artifact-drift diff-checks, formatting, version lockstep, and
# conformance are all CI-only), so "green locally, red in CI" was routine.
#
# Requires the toolchains CI uses: node, cargo, python3 (+ the python dev extras),
# and go. Heavy by design — correctness over speed.
#
# Scope: this covers the data/library/parity jobs (validate, rust, python, go,
# conformance) — the gates a schema/data/tooling change actually trips. CI's
# `examples` and `sync-worker` app jobs are intentionally NOT included: they're
# separate front-end/worker apps unaffected by ingest/data work. Run them with
# their own workspace commands when you touch those apps.

set shell := ["bash", "-uc"]

# The exact generated-artifact paths CI guards with `git diff --exit-code`.
ARTIFACTS := "tools/src/generated.ts \
crates/wh40kdc/schemas/bundled.schema.json crates/wh40kdc/src/generated.rs crates/wh40kdc/src/data/bundle.generated.json \
python/src/wh40kdc/_bundle.json python/src/wh40kdc/_spec.py python/src/wh40kdc/_types.py python/src/wh40kdc/schemas \
go/bundle.json go/share_registry.json go/schemas go/spec.go \
conformance"

# List recipes.
default:
    @just --list

# THE pre-push gate — reproduces all CI verification jobs (fail-fast on drift).
preflight: regen fmt verify-clean test-all version-lockstep
    @echo ""
    @echo "✅ preflight passed — this tree should be green in CI."

# Regenerate every derived artifact (order is load-bearing: Python copies the Rust bundle).
regen:
    @echo "▸ regenerating derived artifacts (TS → Rust → Python → Go → conformance)"
    cd tools && npm run bundle:schemas
    cd tools && npm run codegen:types
    cd tools && npm run codegen:data
    cargo run -p xtask -- codegen
    cargo run -p xtask -- bundle-data
    python3 python/codegen/sync_bundle.py
    python3 python/codegen/sync_spec.py
    cd python && python3 -m pip install -e ".[dev]" --quiet
    python3 python/codegen/gen_typeddicts.py
    bash go/codegen/sync.sh
    cd tools && npm run codegen:data && npx tsc && npm run gen:conformance

# Apply Rust + Go formatting (CI checks these; applying keeps a re-run clean).
fmt:
    @echo "▸ formatting rust + go"
    cargo fmt --all
    gofmt -w go/

# Drift gate: committed generated artifacts must equal what regen just produced.
verify-clean:
    @echo "▸ checking generated artifacts match regen output (CI drift gate)"
    @if jj root >/dev/null 2>&1; then \
        drift=$(jj diff --name-only -r @ -- {{ARTIFACTS}}); \
      elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then \
        drift=$(git diff --name-only -- {{ARTIFACTS}}); \
      else \
        echo "✗ neither a git worktree nor a jj workspace; cannot verify generated drift." >&2; \
        exit 1; \
      fi; \
      if [ -n "$drift" ]; then \
        echo "✗ generated artifacts drifted — regen changed them; commit the result (CI fails on this same diff)." >&2; \
        printf '%s\n' "$drift" >&2; \
        exit 1; \
    fi
    @echo "  artifacts up to date."

# Pre-commit drift gate: intended uncommitted generated outputs are the baseline.
# Snapshot their bytes, regenerate, and require byte-for-byte stability.
verify-regen-stable:
    @before=$$(mktemp); after=$$(mktemp); trap 'rm -f "$$before" "$$after"' EXIT; \
      find {{ARTIFACTS}} -type f -print0 2>/dev/null | sort -z | xargs -0 sha256sum >"$$before"; \
      just regen; \
      find {{ARTIFACTS}} -type f -print0 2>/dev/null | sort -z | xargs -0 sha256sum >"$$after"; \
      if ! cmp -s "$$before" "$$after"; then \
        echo "✗ regeneration changed the pre-gate generated snapshot." >&2; diff -u "$$before" "$$after" >&2 || true; exit 1; \
      fi

# All four language suites + conformance.
test-all: test-ts test-rust test-python test-go conformance

# TS: build + unit tests + data validation.
test-ts:
    @echo "▸ TS: build + unit tests + data validation"
    cd tools && npm run codegen:data && npx tsc && npm test && npm run validate

# Rust: fmt-check + build + test.
test-rust:
    @echo "▸ Rust: fmt-check + build + test"
    cargo fmt --all -- --check
    cargo build --workspace
    cargo test --workspace

# Python: ruff + mypy + pytest.
test-python:
    @echo "▸ Python: ruff + mypy + pytest"
    cd python && ruff check .
    cd python && mypy src
    cd python && pytest

# Go: gofmt-check + vet + build + test.
test-go:
    @echo "▸ Go: gofmt-check + vet + build + test"
    test -z "$(gofmt -l go/)" || { echo "gofmt drift:"; gofmt -l go/; exit 1; }
    cd go && go vet ./...
    cd go && go build ./...
    cd go && go test ./...

# Conformance: TS + Rust suites against the shared corpus.
conformance:
    @echo "▸ conformance: TS + Rust suites against the shared corpus"
    cd tools && npx vitest run test/conformance.test.ts
    cargo test -p wh40kdc --test conformance

# The four version files (npm/crate/python/go) must match exactly (hard CI gate).
version-lockstep:
    @echo "▸ checking npm/crate/python/go version lockstep"
    @npm_ver=$(node -p "require('./tools/package.json').version"); \
     crate_ver=$(awk -F'"' '/^version[[:space:]]*=/ { print $2; exit }' crates/wh40kdc/Cargo.toml); \
     py_ver=$(awk -F'"' '/^__version__/ { print $2; exit }' python/src/wh40kdc/_version.py); \
     go_ver=$(awk -F'"' '/^const Version/ { print $2; exit }' go/version.go); \
     if [ "$npm_ver" != "$crate_ver" ] || [ "$npm_ver" != "$py_ver" ] || [ "$npm_ver" != "$go_ver" ]; then \
        echo "✗ version mismatch: tools=$npm_ver crate=$crate_ver python=$py_ver go=$go_ver" >&2; \
        exit 1; \
     fi; \
     echo "  in sync: $npm_ver"

# Validate or regenerate the committed MFM source-shape contract.
mfm-contract mode="check":
    cd tools && npm run mfm:contract -- --{{mode}}

# Compare a pinned BSData checkout to MFM; warnings are written only under _private.
mfm-bsdata bsdata ref:
    cd tools && npm run mfm:bsdata -- --bsdata "{{bsdata}}" --source-ref "{{ref}}"

# Regenerate the MFM completeness golden (data/_audit/mfm-golden.json + mfm-gaps.json).
# Needs _private/dump.json locally; the artifacts are hand-committed and are NOT part of
# verify-clean (CI can't read the dump). Re-run and commit the diff when a new MFM lands,
# then curate mfm-gaps.json for any newly-authored data (see test/mfm-completeness.test.ts).
mfm-golden:
    cd tools && npm run mfm:golden
