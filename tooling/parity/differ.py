#!/usr/bin/env python3
"""Cross-implementation differ for the 40kdc-data conformance corpus.

Drives two NDJSON runners (TS and Rust by default) against the same corpus
cases and asserts byte- or tolerance-equal responses. The runners speak the
wire protocol in ``conformance/RUNNER_PROTOCOL.md``; both implementations
embed the corpus ``SPEC_VERSION`` and refuse to participate on mismatch.

The differ is intentionally a single stdlib-only Python file. Per-language
conformance tests already exist (``tools/test/conformance.test.ts``,
``crates/wh40kdc/tests/*.rs``); this is the additional gate that catches
*co-drift* where both impls happen to agree with a regenerated golden that's
actually wrong.

Usage::

    python3 tooling/parity/differ.py                  # corpus parity, default impls
    python3 tooling/parity/differ.py --area normalize # filter to one area
    python3 tooling/parity/differ.py --mode fuzz --fuzz-target normalize --fuzz-seed 42

Exits 0 on full agreement, non-zero on the first divergence at the case level
(all cases run regardless; the exit code summarises). ``--fail-fast`` stops at
the first mismatch for local iteration.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shlex
import shutil
import subprocess
import sys
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Iterator

REPO_ROOT = Path(__file__).resolve().parents[2]
CORPUS_DEFAULT = REPO_ROOT / "conformance"
REGRESSIONS_DEFAULT = Path(__file__).resolve().parent / "regressions"
TOLERANCE_DEFAULT = 5e-4


# ----------------------------------------------------------------------------
# Runner subprocess wrapper
# ----------------------------------------------------------------------------


class Runner:
    """One NDJSON runner spawned as a subprocess.

    Sequential by design — ``call()`` writes a request and immediately reads
    one response line. The protocol allows pipelining; the differ MVP does
    not, because a one-shot bug on case N+1 is materially easier to diagnose
    when N+1's request is the most recent thing sent.
    """

    def __init__(self, cmd: list[str], cwd: Path, env: dict[str, str] | None = None):
        self.cmd = cmd
        self.cwd = cwd
        self.env = env
        self.proc: subprocess.Popen[str] | None = None
        self.impl: str = "?"
        self.impl_version: str = "?"

    def __enter__(self) -> "Runner":
        self.proc = subprocess.Popen(
            self.cmd,
            cwd=str(self.cwd),
            env={**os.environ, **self.env} if self.env else None,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",  # runners speak UTF-8 NDJSON; don't decode as the host locale
            bufsize=1,  # line-buffered
        )
        return self

    def __exit__(self, *_exc: Any) -> None:
        if self.proc is None:
            return
        if self.proc.poll() is None:
            try:
                self.call({"op": "shutdown"})
            except Exception:
                pass
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None

    def call(self, req: dict[str, Any]) -> dict[str, Any]:
        assert self.proc is not None and self.proc.stdin and self.proc.stdout
        line = json.dumps(req, ensure_ascii=False) + "\n"
        try:
            self.proc.stdin.write(line)
            self.proc.stdin.flush()
        except BrokenPipeError as e:
            stderr = self.proc.stderr.read() if self.proc.stderr else ""
            raise RuntimeError(f"runner {self.cmd!r} closed stdin: {stderr}") from e
        out = self.proc.stdout.readline()
        if not out:
            stderr = self.proc.stderr.read() if self.proc.stderr else ""
            raise RuntimeError(
                f"runner {self.cmd!r} produced no response for {req!r}; stderr: {stderr}"
            )
        return json.loads(out)


def spawn_runner(cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> Runner:
    return Runner(cmd, cwd, env)


def handshake(runner: Runner, spec_version: int) -> None:
    """Issue ``init``; populate ``runner.impl`` / ``impl_version`` or raise."""
    resp = runner.call(
        {
            "op": "init",
            "args": {"spec_version": spec_version, "locale": "C", "tz": "UTC", "seed": 0},
        }
    )
    if not resp.get("ok"):
        raise RuntimeError(f"runner {runner.cmd!r} init failed: {resp}")
    value = resp["value"]
    if value["spec_version"] != spec_version:
        raise RuntimeError(
            f"runner {runner.cmd!r} reported spec_version={value['spec_version']}, "
            f"corpus={spec_version}"
        )
    runner.impl = value["impl"]
    runner.impl_version = value["impl_version"]


# ----------------------------------------------------------------------------
# Compare modes
# ----------------------------------------------------------------------------


def _compare_bytes(a: Any, b: Any) -> str | None:
    if a == b:
        return None
    return f"bytes mismatch: {a!r} != {b!r}"


def _compare_struct(a: Any, b: Any) -> str | None:
    """Canonical JSON dump on both sides, then byte-equal."""
    sa = json.dumps(a, sort_keys=True, ensure_ascii=False)
    sb = json.dumps(b, sort_keys=True, ensure_ascii=False)
    if sa == sb:
        return None
    # Truncate to keep error messages tractable on big rosters.
    limit = 800
    return f"struct mismatch\n  lhs={sa[:limit]}\n  rhs={sb[:limit]}"


def _compare_floats_recursive(
    a: Any, b: Any, path: str, tol: float
) -> str | None:
    """Walk parallel trees; numeric leaves use tolerance, others strict.

    JSON has no separate int/float — bool is intentionally excluded from the
    numeric branch (``True == 1`` in Python). Strings, nulls, bools all use
    strict equality.
    """
    if isinstance(a, bool) or isinstance(b, bool):
        return None if a == b else f"{path}: {a!r} != {b!r}"
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if abs(float(a) - float(b)) > tol:
            return f"{path}: float diverged |{a} - {b}| = {abs(a - b)} > {tol}"
        return None
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return f"{path}: list len {len(a)} != {len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            d = _compare_floats_recursive(x, y, f"{path}[{i}]", tol)
            if d:
                return d
        return None
    if isinstance(a, dict) and isinstance(b, dict):
        if set(a.keys()) != set(b.keys()):
            return f"{path}: keys {sorted(a)} != {sorted(b)}"
        for k in a:
            d = _compare_floats_recursive(a[k], b[k], f"{path}.{k}", tol)
            if d:
                return d
        return None
    if a != b:
        return f"{path}: {a!r} != {b!r}"
    return None


def compare(mode: str, lhs: Any, rhs: Any, *, tol: float = TOLERANCE_DEFAULT) -> str | None:
    if mode == "bytes":
        return _compare_bytes(lhs, rhs)
    if mode == "struct":
        return _compare_struct(lhs, rhs)
    if mode == "floats":
        return _compare_floats_recursive(lhs, rhs, "$", tol)
    raise ValueError(f"unknown compare mode: {mode}")


# ----------------------------------------------------------------------------
# Corpus iteration
# ----------------------------------------------------------------------------


@dataclass(frozen=True)
class Case:
    area: str
    case_id: str
    op: str
    args: dict[str, Any]
    compare_mode: str  # "bytes" | "struct" | "floats"


ROSTER_EXPORT_FORMATS = (
    ("newrecruit-json", "expected.newrecruit-json.json"),
    ("newrecruit-wtc-compact", "expected.newrecruit-wtc-compact.txt"),
    ("newrecruit-wtc-full", "expected.newrecruit-wtc-full.txt"),
    ("newrecruit-simple", "expected.newrecruit-simple.txt"),
    ("roster-json", "expected.roster-json.json"),
    ("rosterizer", "expected.rosterizer.json"),
)


def iter_normalize_cases(corpus: Path) -> Iterator[Case]:
    path = corpus / "normalize.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    for i, entry in enumerate(data):
        yield Case(
            area="normalize",
            case_id=f"normalize#{i}:{entry['input'][:30]}",
            op="normalize",
            args={"input": entry["input"]},
            compare_mode="bytes",
        )


def iter_roster_cases(corpus: Path) -> Iterator[Case]:
    root = corpus / "roster"
    for fixture in sorted(p for p in root.iterdir() if p.is_dir()):
        # Import: every input.* file goes through the auto-detect path. We
        # use the `import` op for canonical seeds and `try_import` for text
        # round-trip seeds, but for parity it's enough to dispatch all of
        # them through `import` — the auto-detection logic is itself part of
        # what the differ pins.
        for input_path in sorted(fixture.iterdir()):
            if not input_path.name.startswith("input."):
                continue
            raw = input_path.read_text(encoding="utf-8")
            yield Case(
                area="roster",
                case_id=f"roster/{fixture.name}/{input_path.name}",
                op="import",
                args={"input": raw},
                compare_mode="struct",
            )

        # Export: load the resolved roster, ask each runner to serialize it
        # in every format, byte-compare.
        roster_path = fixture / "expected.roster.json"
        if not roster_path.exists():
            continue
        roster = json.loads(roster_path.read_text(encoding="utf-8"))
        for fmt, _expected_filename in ROSTER_EXPORT_FORMATS:
            yield Case(
                area="roster",
                case_id=f"roster/{fixture.name}/export.{fmt}",
                op="export",
                args={"format": fmt, "roster": roster},
                compare_mode="bytes",
            )


def iter_cruncher_cases(corpus: Path) -> Iterator[Case]:
    root = corpus / "cruncher"
    for case_path in sorted(root.glob("*.json")):
        case = json.loads(case_path.read_text(encoding="utf-8"))
        yield Case(
            area="cruncher",
            case_id=f"cruncher/{case_path.name}",
            op="crunch",
            args={
                "attacker": case["attacker"],
                "modelsFiring": case["modelsFiring"],
                "target": case["target"],
                "context": case["context"],
                "buffs": case.get("buffs", []),
            },
            compare_mode="floats",
        )


def iter_compare_cases(corpus: Path) -> Iterator[Case]:
    root = corpus / "compare"
    for case_path in sorted(root.glob("*.json")):
        case = json.loads(case_path.read_text(encoding="utf-8"))
        yield Case(
            area="compare",
            case_id=f"compare/{case_path.name}",
            op="compare",
            args={
                "attacker": case["attacker"],
                "targetProfileId": case["targetProfileId"],
                "distance": case["distance"],
                "phase": case["phase"],
                "modelsFiring": case.get("modelsFiring", 1),
            },
            # expectedKills is a float; reaches/withinHalfRange/modelCount are
            # exact. The recursive float comparison handles both.
            compare_mode="floats",
        )


def iter_loadout_cases(corpus: Path) -> Iterator[Case]:
    root = corpus / "loadout"
    for case_path in sorted(root.glob("*.json")):
        case = json.loads(case_path.read_text(encoding="utf-8"))
        yield Case(
            area="loadout",
            case_id=f"loadout/{case_path.name}",
            op="loadout",
            args={
                "lines": case["lines"],
                "targetProfileId": case["targetProfileId"],
                "distance": case["distance"],
                "phase": case["phase"],
            },
            compare_mode="floats",
        )


def iter_linked_api_cases(corpus: Path) -> Iterator[Case]:
    path = corpus / "linked-api" / "cases.json"
    cases = json.loads(path.read_text(encoding="utf-8"))
    for i, entry in enumerate(cases):
        comparison = entry.get("comparison", "struct")
        if comparison == "set":
            # Sort both sides before comparing — we model that by post-
            # processing in the run loop. For now mark as struct and sort
            # the actual responses with a small wrapper.
            mode = "set"
        elif comparison == "scalar":
            mode = "struct"
        else:
            mode = "struct"
        yield Case(
            area="linked-api",
            case_id=f"linked-api#{i}:{entry['name']}",
            op="linked_query",
            args={"query": entry["query"], "input": entry.get("args", {})},
            compare_mode=mode,
        )


def iter_attribution_cases(corpus: Path) -> Iterator[Case]:
    cases_path = corpus / "attribution" / "cases.json"
    cruncher_dir = corpus / "cruncher"
    cases = json.loads(cases_path.read_text(encoding="utf-8"))
    for entry in cases:
        crunch_case = json.loads((cruncher_dir / entry["cruncher_case"]).read_text(encoding="utf-8"))
        yield Case(
            area="attribution",
            case_id=f"attribution/{entry['name']}",
            op="attribution",
            args={
                "attacker": crunch_case["attacker"],
                "modelsFiring": crunch_case["modelsFiring"],
                "target": crunch_case["target"],
                "context": crunch_case["context"],
                "buffs": crunch_case.get("buffs", []),
            },
            compare_mode="floats",
        )


def iter_scoring_translation_cases(corpus: Path) -> Iterator[Case]:
    path = corpus / "scoring-translation" / "cases.json"
    cases = json.loads(path.read_text(encoding="utf-8"))
    for entry in cases:
        # The op echoes the awards verbatim; the goldens encode the expected
        # strings, but parity only needs the two impls to agree, so we compare
        # their responses structurally (exact string equality, no tolerance).
        yield Case(
            area="scoring-translation",
            case_id=f"scoring-translation/{entry['cardId']}",
            op="translate_scoring",
            args={"cardId": entry["cardId"]},
            compare_mode="struct",
        )


def iter_effect_translation_cases(corpus: Path) -> Iterator[Case]:
    path = corpus / "effect-translation" / "cases.json"
    cases = json.loads(path.read_text(encoding="utf-8"))
    for entry in cases:
        args = {"effect": entry["effect"]}
        if entry.get("scope") is not None:
            args["scope"] = entry["scope"]
        if entry.get("usage") is not None:
            args["usage"] = entry["usage"]
        if entry.get("applies_to") is not None:
            args["applies_to"] = entry["applies_to"]
        yield Case(
            area="effect-translation",
            case_id=f"effect-translation/{entry['caseId']}",
            op="translate_effect",
            args=args,
            compare_mode="struct",
        )


def iter_applies_to_cases(corpus: Path) -> Iterator[Case]:
    path = corpus / "applies-to" / "cases.json"
    cases = json.loads(path.read_text(encoding="utf-8"))
    for entry in cases:
        # The op intersects the `applies_to` keyword filter with each unit's
        # keywords + faction_keywords and returns the matched ids in input
        # order. `applies_to` may be null (no scope → no matches). matchedIds
        # are order-sensitive, so compare structurally (exact, no sort).
        yield Case(
            area="applies-to",
            case_id=f"applies-to/{entry['caseId']}",
            op="match_applies_to",
            args={"applies_to": entry["applies_to"], "units": entry["units"]},
            compare_mode="struct",
        )


def iter_scoring_cases(corpus: Path) -> Iterator[Case]:
    path = corpus / "scoring" / "cases.json"
    cases = json.loads(path.read_text(encoding="utf-8"))
    for entry in cases:
        # Each case carries its own op (score_event | score_state | wtc_result)
        # and args; the goldens are integers, so the two impls must agree
        # exactly (no tolerance).
        yield Case(
            area="scoring",
            case_id=f"scoring/{entry['name']}",
            op=entry["op"],
            args=entry["args"],
            compare_mode="struct",
        )


def iter_terrain_resolver_cases(corpus: Path) -> Iterator[Case]:
    path = corpus / "terrain-resolver" / "cases.json"
    cases = json.loads(path.read_text(encoding="utf-8"))
    for entry in cases:
        # Each case carries its own templates + layout; the op resolves them to
        # board-space vertices. Vertices are floats, so compare with tolerance
        # (string identity fields compared exactly by the recursive comparator).
        yield Case(
            area="terrain-resolver",
            case_id=f"terrain-resolver/{entry['name']}",
            op="resolve_terrain",
            args={"layout": entry["layout"], "templates": entry["templates"]},
            compare_mode="floats",
        )


def iter_terrain_keystones_cases(corpus: Path) -> Iterator[Case]:
    path = corpus / "terrain-keystones" / "cases.json"
    cases = json.loads(path.read_text(encoding="utf-8"))
    for entry in cases:
        # Each case carries its own templates + layout (+ optional board); the
        # op derives keystone distances from resolved geometry. Distances are
        # floats, so compare with tolerance.
        args = {"layout": entry["layout"], "templates": entry["templates"]}
        if "board" in entry:
            args["board"] = entry["board"]
        yield Case(
            area="terrain-keystones",
            case_id=f"terrain-keystones/{entry['name']}",
            op="keystones",
            args=args,
            compare_mode="floats",
        )


def iter_validator_cases(corpus: Path) -> Iterator[Case]:
    path = corpus / "validator" / "cases.json"
    cases = json.loads(path.read_text(encoding="utf-8"))
    for entry in cases:
        # The contract is the closed-enum (path, code) signature with set
        # semantics — both impls' outputs sort before comparing.
        yield Case(
            area="validator",
            case_id=f"validator/{entry['name']}",
            op="validate",
            args={"target": entry["target"], "value": entry["input"]},
            compare_mode="set",
        )


def iter_share_cases(corpus: Path) -> Iterator[Case]:
    path = corpus / "share" / "cases.json"
    cases = json.loads(path.read_text())
    for entry in cases:
        name = entry["name"]
        if "token" in entry:
            # Round-trip: encode must reproduce the golden token byte-for-byte
            # (string equality), and decode of that token must round-trip to the
            # input list (structural).
            yield Case(
                area="share",
                case_id=f"share/{name}/encode",
                op="share_encode",
                args={"list": entry["list"]},
                compare_mode="bytes",
            )
            yield Case(
                area="share",
                case_id=f"share/{name}/decode",
                op="share_decode",
                args={"token": entry["token"]},
                compare_mode="struct",
            )
        elif "decode_token" in entry:
            # Negative decode: both impls must agree on the malformed /
            # stale-registry verdict.
            yield Case(
                area="share",
                case_id=f"share/{name}/decode",
                op="share_decode",
                args={"token": entry["decode_token"]},
                compare_mode="struct",
            )


AREA_ITERATORS: dict[str, Any] = {
    "normalize": iter_normalize_cases,
    "roster": iter_roster_cases,
    "cruncher": iter_cruncher_cases,
    "compare": iter_compare_cases,
    "loadout": iter_loadout_cases,
    "linked-api": iter_linked_api_cases,
    "attribution": iter_attribution_cases,
    "scoring-translation": iter_scoring_translation_cases,
    "effect-translation": iter_effect_translation_cases,
    "applies-to": iter_applies_to_cases,
    "scoring": iter_scoring_cases,
    "terrain-resolver": iter_terrain_resolver_cases,
    "terrain-keystones": iter_terrain_keystones_cases,
    "validator": iter_validator_cases,
    "share": iter_share_cases,
}


# ----------------------------------------------------------------------------
# Report
# ----------------------------------------------------------------------------


@dataclass
class Diff:
    case: Case
    detail: str
    lhs: Any
    rhs: Any


@dataclass
class Report:
    cases_run: int = 0
    diffs: list[Diff] = field(default_factory=list)
    skipped: dict[str, int] = field(default_factory=dict)
    elapsed: float = 0.0

    def add_pass(self) -> None:
        self.cases_run += 1

    def add_diff(self, d: Diff) -> None:
        self.cases_run += 1
        self.diffs.append(d)

    def skip(self, area: str) -> None:
        self.skipped[area] = self.skipped.get(area, 0) + 1

    @property
    def ok(self) -> bool:
        return not self.diffs


# ----------------------------------------------------------------------------
# Driver
# ----------------------------------------------------------------------------


def negotiate_unsupported(
    lhs: Runner, rhs: Runner, probe_ops: Iterable[str]
) -> set[str]:
    """Return the set of op names at least one runner refuses with
    ``UNKNOWN_OP``. Sends a no-arg request so the result is purely about op
    recognition; an ``INVALID_INPUT`` reply still counts as "supported."
    """
    unsupported: set[str] = set()
    for op in probe_ops:
        for r in (lhs, rhs):
            resp = r.call({"op": op, "args": {}})
            if not resp.get("ok") and resp.get("error_kind") == "UNKNOWN_OP":
                unsupported.add(op)
                break
    return unsupported


def run_case(lhs: Runner, rhs: Runner, case: Case, tol: float) -> Diff | None:
    lhs_resp = lhs.call({"op": case.op, "args": case.args})
    rhs_resp = rhs.call({"op": case.op, "args": case.args})
    if lhs_resp.get("ok") != rhs_resp.get("ok"):
        return Diff(
            case=case,
            detail=f"ok flag diverged ({lhs_resp.get('ok')} vs {rhs_resp.get('ok')})",
            lhs=lhs_resp,
            rhs=rhs_resp,
        )
    if not lhs_resp.get("ok"):
        # Both failed; compare the error_kind only (closed enum). Payloads
        # are intentionally free-form per the protocol.
        if lhs_resp.get("error_kind") != rhs_resp.get("error_kind"):
            return Diff(
                case=case,
                detail=(
                    f"error_kind diverged "
                    f"({lhs_resp.get('error_kind')} vs {rhs_resp.get('error_kind')})"
                ),
                lhs=lhs_resp,
                rhs=rhs_resp,
            )
        return None
    lhs_v = lhs_resp["value"]
    rhs_v = rhs_resp["value"]
    if case.compare_mode == "set":
        # Sort both sides; then compare structurally.
        if isinstance(lhs_v, list):
            lhs_v = sorted(lhs_v, key=lambda x: json.dumps(x, sort_keys=True))
        if isinstance(rhs_v, list):
            rhs_v = sorted(rhs_v, key=lambda x: json.dumps(x, sort_keys=True))
        detail = compare("struct", lhs_v, rhs_v)
    else:
        detail = compare(case.compare_mode, lhs_v, rhs_v, tol=tol)
    if detail:
        return Diff(case=case, detail=detail, lhs=lhs_v, rhs=rhs_v)
    return None


def run_corpus(
    lhs: Runner,
    rhs: Runner,
    corpus_root: Path,
    areas: list[str],
    *,
    tol: float,
    fail_fast: bool,
    quiet: bool,
) -> Report:
    rep = Report()
    start = time.monotonic()
    # Probe for ops both runners must support across the selected areas.
    needed_ops = {
        "normalize": ["normalize"],
        "roster": ["import", "export"],
        "cruncher": ["crunch"],
        # Compare relies on defensiveBuffsFor, which Rust doesn't ship — its
        # runner answers UNKNOWN_OP and the area skips for rust pairings; ts↔py
        # exercises it (same pattern as the validator area).
        "compare": ["compare"],
        # Loadout ranking builds on compare/defensiveBuffsFor — same Rust
        # exemption as the compare area; ts↔py exercises it.
        "loadout": ["loadout"],
        "linked-api": ["linked_query"],
        "attribution": ["attribution"],
        "scoring-translation": ["translate_scoring"],
        "effect-translation": ["translate_effect"],
        "applies-to": ["match_applies_to"],
        # Rust doesn't ship a validator yet — its runner answers UNKNOWN_OP
        # and the area skips for rust pairings; ts↔py exercises it.
        "validator": ["validate"],
        # These areas weren't in needed_ops historically because every shipped
        # runner supported them; listing them lets a *partially* implemented
        # runner (e.g. a new port mid-build) skip the area on UNKNOWN_OP instead
        # of diffing on the ok flag.
        "scoring": ["score_event", "score_state", "wtc_result"],
        "terrain-resolver": ["resolve_terrain"],
        "terrain-keystones": ["keystones"],
        "share": ["share_encode", "share_decode"],
    }
    probes: set[str] = set()
    for a in areas:
        probes.update(needed_ops.get(a, []))
    unsupported = negotiate_unsupported(lhs, rhs, probes)
    skipped_areas = {
        a
        for a in areas
        if any(op in unsupported for op in needed_ops.get(a, []))
    }
    for area in areas:
        if area in skipped_areas:
            if not quiet:
                print(f"[skip] {area}: op not implemented in one runner", file=sys.stderr)
            rep.skip(area)
            continue
        iterator = AREA_ITERATORS.get(area)
        if iterator is None:
            print(f"unknown area: {area}", file=sys.stderr)
            continue
        for case in iterator(corpus_root):
            diff = run_case(lhs, rhs, case, tol)
            if diff is None:
                rep.add_pass()
                continue
            rep.add_diff(diff)
            if not quiet:
                print(
                    f"[diff] {case.case_id} ({case.op}): {diff.detail}",
                    file=sys.stderr,
                )
            if fail_fast:
                break
        if fail_fast and rep.diffs:
            break
    rep.elapsed = time.monotonic() - start
    return rep


# ----------------------------------------------------------------------------
# Output
# ----------------------------------------------------------------------------


def print_text_report(report: Report, lhs: Runner, rhs: Runner) -> None:
    if report.ok:
        print(
            f"OK: {report.cases_run} cases across {len({d.case.area for d in []}) or 'all'} "
            f"areas, {lhs.impl}={lhs.impl_version} {rhs.impl}={rhs.impl_version} "
            f"({report.elapsed:.2f}s)"
        )
    else:
        print(
            f"FAIL: {len(report.diffs)} diverging case(s) of {report.cases_run} "
            f"({lhs.impl}={lhs.impl_version} {rhs.impl}={rhs.impl_version}, "
            f"{report.elapsed:.2f}s)"
        )
        for d in report.diffs[:10]:
            print(f"  - {d.case.case_id} ({d.case.op}): {d.detail}")
        if len(report.diffs) > 10:
            print(f"  ... {len(report.diffs) - 10} more")
    for area, n in sorted(report.skipped.items()):
        print(f"  [skip] {area}: {n}")


def print_json_report(report: Report, lhs: Runner, rhs: Runner) -> None:
    out = {
        "ok": report.ok,
        "cases_run": report.cases_run,
        "elapsed_s": report.elapsed,
        "lhs": {"impl": lhs.impl, "impl_version": lhs.impl_version},
        "rhs": {"impl": rhs.impl, "impl_version": rhs.impl_version},
        "skipped": report.skipped,
        "diffs": [
            {
                "area": d.case.area,
                "case_id": d.case.case_id,
                "op": d.case.op,
                "detail": d.detail,
            }
            for d in report.diffs
        ],
    }
    print(json.dumps(out, indent=2))


# ----------------------------------------------------------------------------
# Command auto-detection
# ----------------------------------------------------------------------------


def default_ts_cmd() -> list[str]:
    built = REPO_ROOT / "tools" / "dist" / "runner.js"
    if built.exists():
        return ["node", str(built)]
    return ["npx", "tsx", str(REPO_ROOT / "tools" / "src" / "runner.ts")]


def default_rust_cmd() -> list[str]:
    built = REPO_ROOT / "target" / "release" / "wh40kdc-runner"
    if built.exists():
        return [str(built)]
    debug = REPO_ROOT / "target" / "debug" / "wh40kdc-runner"
    if debug.exists():
        return [str(debug)]
    return ["cargo", "run", "--quiet", "--release", "--bin", "wh40kdc-runner"]


def default_go_cmd() -> list[str]:
    # Prefer a prebuilt binary at go/wh40kdc-runner (CI builds it up front);
    # otherwise `go run -C go` so the in-repo module is used without an install.
    built = REPO_ROOT / "go" / "wh40kdc-runner"
    if built.exists():
        return [str(built)]
    return ["go", "run", "-C", "go", "./cmd/wh40kdc-runner"]


def default_py_cmd() -> list[str]:
    # `-m` (not a console script) so the Python runner can't collide with the
    # Rust `wh40kdc-runner` binary on PATH. The src tree is importable via the
    # PYTHONPATH from `py_env()`, so no install step is needed — but the
    # interpreter must have the package's runtime deps (jsonschema), so the
    # package venv wins when present.
    venv_python = REPO_ROOT / "python" / ".venv" / "bin" / "python"
    interpreter = str(venv_python) if venv_python.exists() else sys.executable
    return [interpreter, "-m", "wh40kdc.runner"]


def py_env() -> dict[str, str]:
    """Environment for the Python runner: prepend python/src to PYTHONPATH so
    the in-repo source tree is importable without an editable install (an
    installed wh40kdc still wins if PYTHONPATH ordering is overridden)."""
    src = str(REPO_ROOT / "python" / "src")
    existing = os.environ.get("PYTHONPATH")
    return {"PYTHONPATH": f"{src}{os.pathsep}{existing}" if existing else src}


def load_spec_version(corpus: Path) -> int:
    return int((corpus / "SPEC_VERSION").read_text(encoding="utf-8").strip())


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------


def main() -> int:
    p = argparse.ArgumentParser(
        description="Cross-implementation differ for the 40kdc conformance corpus."
    )
    p.add_argument("--ts-cmd", help="shlex-split command line for the TS runner")
    p.add_argument("--rust-cmd", help="shlex-split command line for the Rust runner")
    p.add_argument("--py-cmd", help="shlex-split command line for the Python runner")
    p.add_argument("--go-cmd", help="shlex-split command line for the Go runner")
    p.add_argument(
        "--pair",
        choices=["ts,rust", "ts,py", "rust,py", "ts,go", "rust,go", "py,go"],
        default="ts,rust",
        help="which two implementations to diff (default: ts,rust)",
    )
    p.add_argument("--corpus", default=str(CORPUS_DEFAULT), help="path to the conformance corpus")
    p.add_argument(
        "--area",
        action="append",
        choices=list(AREA_ITERATORS.keys()),
        help="restrict to one or more areas (default: all)",
    )
    p.add_argument(
        "--mode", choices=["corpus", "fuzz"], default="corpus", help="run mode"
    )
    p.add_argument("--fuzz-target", choices=["normalize", "crunch"], default="normalize")
    p.add_argument("--fuzz-seed", type=int, default=0)
    p.add_argument("--fuzz-count", type=int, default=1000)
    p.add_argument("--tol", type=float, default=TOLERANCE_DEFAULT)
    p.add_argument("--fail-fast", action="store_true")
    p.add_argument("--json", action="store_true", help="emit a JSON report on stdout")
    p.add_argument("--quiet", action="store_true")
    p.add_argument(
        "--regression-dir",
        default=str(REGRESSIONS_DEFAULT),
        help="where to dump fuzz repros on mismatch",
    )
    args = p.parse_args()

    corpus = Path(args.corpus).resolve()
    spec_version = load_spec_version(corpus)

    # Per-impl (command, env) resolution; --pair selects which two spawn.
    impl_spawns: dict[str, tuple[list[str], dict[str, str] | None]] = {
        "ts": (shlex.split(args.ts_cmd) if args.ts_cmd else default_ts_cmd(), None),
        "rust": (shlex.split(args.rust_cmd) if args.rust_cmd else default_rust_cmd(), None),
        "py": (shlex.split(args.py_cmd) if args.py_cmd else default_py_cmd(), py_env()),
        "go": (shlex.split(args.go_cmd) if args.go_cmd else default_go_cmd(), None),
    }
    lhs_name, rhs_name = args.pair.split(",")
    lhs_cmd, lhs_env = impl_spawns[lhs_name]
    rhs_cmd, rhs_env = impl_spawns[rhs_name]

    areas = args.area or list(AREA_ITERATORS.keys())

    with (
        spawn_runner(lhs_cmd, REPO_ROOT, lhs_env) as ts,
        spawn_runner(rhs_cmd, REPO_ROOT, rhs_env) as rs,
    ):
        try:
            handshake(ts, spec_version)
            handshake(rs, spec_version)
        except Exception as e:
            print(f"handshake error: {e}", file=sys.stderr)
            return 2

        if args.mode == "corpus":
            report = run_corpus(
                ts, rs, corpus, areas, tol=args.tol, fail_fast=args.fail_fast, quiet=args.quiet
            )
        else:
            from_fuzz = run_fuzz(  # noqa: F821  (defined below at module level)
                ts,
                rs,
                args.fuzz_target,
                seed=args.fuzz_seed,
                count=args.fuzz_count,
                tol=args.tol,
                regression_dir=Path(args.regression_dir),
                fail_fast=args.fail_fast,
                quiet=args.quiet,
                corpus=corpus,
            )
            report = from_fuzz

        if args.json:
            print_json_report(report, ts, rs)
        else:
            print_text_report(report, ts, rs)

    return 0 if report.ok else 1


# ----------------------------------------------------------------------------
# Fuzz mode (defined here so it's discoverable from main(); generator details
# live in their own functions).
# ----------------------------------------------------------------------------


# Character pool for the normalize fuzzer — every code point listed in the
# `normalize.json` per-area invariants in CONFORMANCE.md. Keeping it close to
# the curated cases means a fuzz failure is more likely to surface a real
# missed-edge-case bug than an unrelated Unicode rabbit hole.
NORMALIZE_POOL: list[str] = (
    list("abcdefghijklmnopqrstuvwxyz")
    + list("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    + list("0123456789")
    + [" ", " ", "　", "‍", "İ"]
    + [chr(c) for c in range(0x0300, 0x0370)]  # combining diacriticals
    + ["‘", "’", "‛", "`"]
    + ["-", "‐", "‑", "‒", "–", "—"]
)


def fuzz_normalize_inputs(rng: random.Random, n: int) -> Iterator[str]:
    for _ in range(n):
        length = rng.randint(5, 40)
        yield "".join(rng.choice(NORMALIZE_POOL) for _ in range(length))


# Buff templates the cruncher fuzzer can pick from. Each is the wire shape the
# `crunch` op accepts (matches the camelCase + kind-tagged BuffSource). Kept
# small on purpose; the goal is co-drift detection, not exhaustive coverage.
FUZZ_BUFFS: list[dict[str, Any]] = [
    {
        "source": {"kind": "manual", "label": "fuzz-plus1-hit"},
        "contribution": {"type": "hit-mod", "value": 1},
    },
    {
        "source": {"kind": "manual", "label": "fuzz-minus1-wound"},
        "contribution": {"type": "wound-mod", "value": -1},
    },
    {
        "source": {"kind": "manual", "label": "fuzz-cover"},
        "contribution": {"type": "cover"},
    },
    {
        "source": {"kind": "manual", "label": "fuzz-reroll-hits"},
        "contribution": {"type": "reroll", "roll": "hit", "subset": "ones"},
    },
    {
        "source": {"kind": "manual", "label": "fuzz-fnp5"},
        "contribution": {"type": "feel-no-pain", "threshold": 5},
    },
    {
        "source": {"kind": "manual", "label": "fuzz-ap-extra"},
        "contribution": {"type": "ap-mod", "value": -1},
    },
]


def load_fuzz_dataset(corpus: Path) -> tuple[list[str], dict[str, list[int]]]:
    """Return ``(weapon_ids, unit_id_to_profile_indices)`` from the bundled
    dataset.

    Avoids a third reader of the dataset format by reading the TS bundle
    JSON (``tools/src/data/bundle.generated.ts``)? — no, that's TS source.
    We read the raw faction data files instead, which are JSON arrays the
    bundler walks. That's the same source-of-truth both impls read at
    codegen time, so this third reader is consistent by construction.

    For simplicity we accept slightly fewer ids than the runtime would (only
    units with at least one shooting/melee profile that has a save), since
    the fuzzer just needs *some* valid combinations.
    """
    data_root = REPO_ROOT / "data"
    weapons: list[str] = []
    unit_profiles: dict[str, list[int]] = {}
    for path in sorted((data_root / "core").rglob("weapons.json")):
        try:
            arr = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for w in arr:
            if isinstance(w, dict) and "id" in w and w.get("profiles"):
                weapons.append(w["id"])
    for path in sorted((data_root / "core").rglob("units.json")):
        try:
            arr = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for u in arr:
            if not isinstance(u, dict) or "id" not in u:
                continue
            profiles = u.get("profiles") or []
            # Indices of profiles that carry a save stat — required by crunch.
            keep = [
                i
                for i, p in enumerate(profiles)
                if isinstance(p, dict) and p.get("Sv")
            ]
            if keep:
                unit_profiles[u["id"]] = keep
    return weapons, unit_profiles


def fuzz_crunch_inputs(
    rng: random.Random, n: int, weapons: list[str], units: dict[str, list[int]]
) -> Iterator[dict[str, Any]]:
    unit_ids = list(units.keys())
    if not weapons or not unit_ids:
        return
    phases = ["shooting", "charge", "fight"]
    for _ in range(n):
        wid = rng.choice(weapons)
        uid = rng.choice(unit_ids)
        prof = rng.choice(units[uid])
        n_buffs = rng.randint(0, 4)
        chosen = rng.sample(FUZZ_BUFFS, k=min(n_buffs, len(FUZZ_BUFFS)))
        yield {
            "attacker": {"weaponId": wid, "profileIndex": 0},
            "modelsFiring": rng.randint(1, 30),
            "target": {"unitId": uid, "profileIndex": prof},
            "context": {
                "phase": rng.choice(phases),
                "attackerStationary": rng.choice([True, False]),
                "withinHalfRange": rng.choice([True, False]),
            },
            "buffs": chosen,
        }


def dump_regression(
    regression_dir: Path,
    target: str,
    seed: int,
    idx: int,
    payload: dict[str, Any],
) -> Path:
    regression_dir.mkdir(parents=True, exist_ok=True)
    out = regression_dir / f"{target}-seed{seed}-{idx:04d}.json"
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    return out


def run_fuzz(
    lhs: Runner,
    rhs: Runner,
    target: str,
    *,
    seed: int,
    count: int,
    tol: float,
    regression_dir: Path,
    fail_fast: bool,
    quiet: bool,
    corpus: Path,
) -> Report:
    rep = Report()
    rng = random.Random(seed)
    start = time.monotonic()
    if target == "normalize":
        inputs: list[Any] = list(fuzz_normalize_inputs(rng, count))
        op = "normalize"
        mode = "bytes"
        args_fn = lambda x: {"input": x}  # noqa: E731
    elif target == "crunch":
        weapons, units = load_fuzz_dataset(corpus)
        inputs = list(fuzz_crunch_inputs(rng, count, weapons, units))
        op = "crunch"
        mode = "floats"
        args_fn = lambda x: x  # noqa: E731
    else:
        raise ValueError(f"unknown fuzz target: {target}")

    for i, raw in enumerate(inputs):
        args = args_fn(raw)
        lhs_resp = lhs.call({"op": op, "args": args})
        rhs_resp = rhs.call({"op": op, "args": args})
        if lhs_resp.get("ok") != rhs_resp.get("ok"):
            diff = Diff(
                case=Case(
                    area=f"fuzz/{target}",
                    case_id=f"fuzz-{target}#{i}",
                    op=op,
                    args=args,
                    compare_mode=mode,
                ),
                detail=f"ok flag diverged ({lhs_resp.get('ok')} vs {rhs_resp.get('ok')})",
                lhs=lhs_resp,
                rhs=rhs_resp,
            )
            rep.add_diff(diff)
            dump_regression(
                regression_dir,
                target,
                seed,
                i,
                {
                    "args": args,
                    "lhs": lhs_resp,
                    "rhs": rhs_resp,
                    "lhs_impl": f"{lhs.impl}={lhs.impl_version}",
                    "rhs_impl": f"{rhs.impl}={rhs.impl_version}",
                },
            )
            if fail_fast:
                break
            continue
        if not lhs_resp.get("ok"):
            # Symmetric failure (both rejected). The fuzz generators don't
            # try to land in error paths, so this is fine — count as a pass.
            rep.add_pass()
            continue
        detail = compare(mode, lhs_resp["value"], rhs_resp["value"], tol=tol)
        if detail:
            diff = Diff(
                case=Case(
                    area=f"fuzz/{target}",
                    case_id=f"fuzz-{target}#{i}",
                    op=op,
                    args=args,
                    compare_mode=mode,
                ),
                detail=detail,
                lhs=lhs_resp["value"],
                rhs=rhs_resp["value"],
            )
            rep.add_diff(diff)
            dump_regression(
                regression_dir,
                target,
                seed,
                i,
                {
                    "args": args,
                    "lhs": lhs_resp,
                    "rhs": rhs_resp,
                    "lhs_impl": f"{lhs.impl}={lhs.impl_version}",
                    "rhs_impl": f"{rhs.impl}={rhs.impl_version}",
                    "detail": detail,
                },
            )
            if not quiet:
                print(f"[fuzz-diff] #{i}: {detail}", file=sys.stderr)
            if fail_fast:
                break
        else:
            rep.add_pass()
    rep.elapsed = time.monotonic() - start
    return rep


if __name__ == "__main__":
    sys.exit(main())
