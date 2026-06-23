---
name: faction-score
description: Score one faction's authored Ability-DSL by embedding veracity — the cosine similarity between each ability's describer-output and its raw GW prose — using the out-of-repo embeddings harness, then report the weakest abilities (the highest-value re-authoring targets) and how to open them in the data explorer. Use for "score world-eaters", "faction-score <faction>", "which world-eaters abilities have the worst DSL fidelity", "run the roundtrip report for <faction>".
argument-hint: <faction-id>   e.g. world-eaters, death-guard, orks
---

# Skill: faction-score

Run the embeddings harness's **roundtrip** scorer for one faction and surface the
weakest-fidelity abilities. A low cosine means the authored DSL lost or distorted the
real rule — i.e. the highest-value change to make next.

The harness lives in the sibling repo `../40kdc-embeddings` and is **advisory only**:
it reads raw GW prose from the out-of-repo `40kdc-abilities` store and the committed
DSL from `data/enrichment/`, and writes a **gitignored** report. Nothing it produces is
ever committed to this repo (the report carries GW-prose snippets — IP boundary).

## Inputs

- `$ARGUMENTS` — the faction id (directory name under `data/enrichment/`, e.g.
  `world-eaters`). If absent, ask for one.

## Run it (one command)

```bash
cd /Users/will.mitchell/40kdc-embeddings && \
  .venv/bin/python -m wh40kdc_embeddings roundtrip --faction <faction-id> --scope <faction-id>
```

This writes (gitignored, machine-local):
- `/Users/will.mitchell/40kdc-embeddings/_reports/roundtrip-<faction-id>.json`
- `/Users/will.mitchell/40kdc-embeddings/_reports/roundtrip-<faction-id>.md`

The stdout already lists every scored ability ascending (weakest first). The `.json`
is what the data explorer's Roundtrip QA mode loads.

## Report back

Summarize from stdout / the `.md`:
- mean / min / max cosine and how many abilities were scored;
- the ~10 weakest abilities (id + score) — these are the re-authoring targets;
- a one-line pointer: load `roundtrip-<faction-id>.json` via **Load veracity report…**
  in the data explorer (`cd examples/data-explorer && npm run dev`, Roundtrip QA mode)
  to rank/inspect them against source + describer side by side.

Don't quote the GW prose snippets from the report in any committed or shared output.

## If the harness isn't ready (first run only)

The `.venv` and the reference describer are normally already installed. If the command
fails with a missing venv or `ModuleNotFoundError: wh40kdc`, set it up once:

```bash
cd /Users/will.mitchell/40kdc-embeddings
uv venv --python 3.12
uv pip install -e ".[dev]"
VIRTUAL_ENV=.venv uv pip install -e ../40kdc-data/python   # the reference describer
```

First run for a model also downloads the `all-MiniLM-L6-v2` weights (local inference;
prose never leaves the machine). Re-runs are fast — embeddings are cached.

## Notes

- `--faction` selects which abilities to score; `--scope` only names the output file —
  pass the same faction id to both so the file is `roundtrip-<faction-id>.json`.
- Coverage is partial by design: only abilities with **both** raw store prose and a
  non-empty describer render are scored. Shared `core` rules and prose-less detachment
  rules are skipped — that's expected, not a failure.
