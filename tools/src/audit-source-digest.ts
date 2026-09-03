/**
 * audit:source-digest — report Ability DSL annotations whose printed source
 * rule has drifted since the annotation was authored (#217).
 *
 * The command joins the public annotation set to a contributor-owned corpus of
 * printed rules, recomputes each rule's {@link sourceDigest}, and compares it
 * with the annotation's stored `source_digest`. It is READ-ONLY: the write path
 * is the separate `backfill:source-digest` command, because an audit must not
 * mutate tracked data.
 *
 * The corpus lives outside this repository and is only ever read. Every source
 * string is reduced to a digest by {@link parseSourceDigestCorpus} the moment it
 * is parsed, so no report row, rendered line or error message can carry prose —
 * findings are faction ids, ability ids, statuses and counts, nothing else. The
 * stored and computed digests are compared but never emitted either: a digest
 * is a fingerprint of the rule, and there is no reason for a public log to
 * carry one.
 *
 * It is a standalone `tsx` script rather than a `40kdc-validate` subcommand or
 * a `just preflight` step: its input is contributor-owned and absent from the
 * repository and from CI, so wiring it into either would break every
 * environment that does not have the corpus.
 *
 * Usage:
 *   npm run audit:source-digest -- <corpus.json> [--root <repo-root>]
 *
 * Exit status: `1` when any finding exists (`changed`, `untracked`,
 * `missing-source` or `unknown-source`) or when the input is malformed;
 * `0` only when every scanned annotation joined to a corpus entry and every
 * digest matched.
 *
 * @packageDocumentation
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareCodeUnits,
  CORE_FACTION_ID,
  parseSourceDigestCorpus,
  sourceIdentityKey,
  type SourceDigestKey,
} from "./source-digest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repository root, used when the caller does not pass `--root`. */
const DEFAULT_ROOT = resolve(__dirname, "../..");

/**
 * Enrichment directories that hold fabricated examples or scratch port audits.
 * They are excluded for the same reason `codegen-data.ts` refuses to bundle
 * them: they are not live annotations, so no contributor corpus can be expected
 * to describe them and they must not manufacture findings.
 */
const EXCLUDED_DIRS = new Set(["_example", "_port-audit"]);

/**
 * How an annotation's stored digest relates to the corpus.
 *
 * Only `current` is a clean outcome. Every other status is a finding, including
 * the two coverage gaps: a partially-covered corpus that still exited `0` would
 * leave "reviewed and still correct" indistinguishable from "never checked",
 * which is the ambiguity this audit exists to remove.
 */
export type SourceDigestStatus =
  /** Stored digest equals the digest of the corpus rule. */
  | "current"
  /** Stored digest differs — the printed rule changed since authoring. */
  | "changed"
  /** Annotation carries no `source_digest`; its source was never fingerprinted. */
  | "untracked"
  /** Annotation has no corpus entry, so the corpus cannot confirm it. */
  | "missing-source"
  /** Corpus entry has no annotation with that composite identity. */
  | "unknown-source";

/** Every status except the clean one; each of these sets exit status `1`. */
export type SourceDigestFindingStatus = Exclude<SourceDigestStatus, "current">;

/**
 * One reported row. Deliberately minimal: identity plus classification. No
 * source text, normalised text, digest, ability name or filesystem path.
 */
export interface SourceDigestFinding extends SourceDigestKey {
  status: SourceDigestFindingStatus;
}

/**
 * A public annotation reduced to what the audit needs. `faction_id` is the
 * effective owning faction ({@link loadAbilityAnnotations}), never a bare
 * ability id.
 */
export interface AbilityAnnotation extends SourceDigestKey {
  /** The stored fingerprint, or `undefined` when the field is absent or null. */
  source_digest?: string;
}

/** Deterministic, privacy-safe audit result. */
export interface SourceDigestAuditReport {
  generated_from: "tools/src/audit-source-digest.ts";
  summary: {
    /** Live annotations scanned. */
    annotations: number;
    /** Corpus entries parsed. */
    corpus_entries: number;
    current: number;
    changed: number;
    untracked: number;
    missing_source: number;
    unknown_source: number;
    /** Total findings; nonzero means exit status `1`. */
    findings: number;
  };
  /** Sorted by faction id, then ability id, then status. */
  findings: SourceDigestFinding[];
}

/** Shape of a raw annotation record, before validation. */
type RawAbility = Record<string, unknown>;

/**
 * Read every live `data/enrichment/<faction>/abilities.json` under `rootDir`
 * and reduce it to composite identities plus stored digests.
 *
 * The effective faction is the record's authored `faction_id` when it has one,
 * otherwise the enclosing directory — the same rule `codegen-data.ts` uses to
 * stamp faction ownership at bundle time, so the audit joins on exactly the
 * identity the linked API resolves by. Records in `_`-prefixed pools stay
 * faction-less at runtime and are keyed as {@link CORE_FACTION_ID}.
 *
 * @throws Error on a missing enrichment tree, a non-array ability file, a
 * record with no usable `ability_id`, a non-string `source_digest`, or two
 * records sharing one composite identity (which would make the join ambiguous
 * and silently fingerprint one faction's rule against another's annotation).
 * Paths in messages are relative to `rootDir`, never absolute.
 */
export function loadAbilityAnnotations(
  rootDir: string = DEFAULT_ROOT,
): AbilityAnnotation[] {
  const enrichment = join(rootDir, "data", "enrichment");
  if (!existsSync(enrichment)) {
    throw new Error(
      "annotations: data/enrichment does not exist under the given repository root",
    );
  }

  const annotations: AbilityAnnotation[] = [];
  const seen = new Map<string, string>();

  for (const dir of readdirSync(enrichment).sort()) {
    if (EXCLUDED_DIRS.has(dir)) continue;
    const factionDir = join(enrichment, dir);
    if (!statSync(factionDir).isDirectory()) continue;
    const file = join(factionDir, "abilities.json");
    if (!existsSync(file)) continue;
    const relative = `data/enrichment/${dir}/abilities.json`;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    } catch {
      throw new Error(`${relative}: not valid JSON`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${relative}: expected a JSON array of annotations`);
    }

    parsed.forEach((record, index) => {
      if (typeof record !== "object" || record === null || Array.isArray(record)) {
        throw new Error(`${relative}: record #${index + 1} is not an object`);
      }
      const raw = record as RawAbility;
      const ability_id = raw.ability_id;
      if (typeof ability_id !== "string" || ability_id === "") {
        throw new Error(`${relative}: record #${index + 1} has no ability_id`);
      }
      const authored = raw.faction_id;
      if (authored !== undefined && authored !== null && typeof authored !== "string") {
        throw new Error(
          `${relative}["${ability_id}"]: faction_id must be a string or null`,
        );
      }
      // The directory owns the record unless it authored a faction explicitly;
      // `_`-prefixed pools (`_core`) are never stamped, so they key as `_core`.
      const faction_id =
        typeof authored === "string" && authored !== ""
          ? authored
          : dir.startsWith("_")
            ? CORE_FACTION_ID
            : dir;

      const stored = raw.source_digest;
      if (stored !== undefined && stored !== null && typeof stored !== "string") {
        throw new Error(
          `${relative}["${ability_id}"]: source_digest must be a string`,
        );
      }

      const annotation: AbilityAnnotation = {
        faction_id,
        ability_id,
        ...(typeof stored === "string" ? { source_digest: stored } : {}),
      };
      const key = sourceIdentityKey(annotation);
      const previous = seen.get(key);
      if (previous !== undefined) {
        throw new Error(
          `annotations: duplicate identity ${key} in ${previous} and ${relative}`,
        );
      }
      seen.set(key, relative);
      annotations.push(annotation);
    });
  }

  annotations.sort(
    (a, b) =>
      compareCodeUnits(a.faction_id, b.faction_id) ||
      compareCodeUnits(a.ability_id, b.ability_id),
  );
  return annotations;
}

/**
 * Classify every annotation and every corpus identity, and reduce the result to
 * counts plus sorted identifier-only findings.
 *
 * Pure: it takes the already-loaded annotations and the unparsed corpus, does no
 * filesystem or process work, and returns a value the caller renders and gates
 * on. That is what makes the redaction contract testable without running the
 * CLI.
 *
 * @throws Error when the corpus is malformed or the annotations contain a
 * duplicate composite identity — malformed input is an invocation error, not a
 * finding, because a partially-understood corpus under-reports drift.
 */
export function auditSourceDigests(
  corpus: unknown,
  annotations: AbilityAnnotation[],
): SourceDigestAuditReport {
  const parsed = parseSourceDigestCorpus(corpus);

  const byIdentity = new Map<string, AbilityAnnotation>();
  for (const annotation of annotations) {
    const key = sourceIdentityKey(annotation);
    if (byIdentity.has(key)) {
      throw new Error(`annotations: duplicate identity ${key}`);
    }
    byIdentity.set(key, annotation);
  }

  const findings: SourceDigestFinding[] = [];
  let current = 0;

  for (const annotation of annotations) {
    const entry = parsed.get(sourceIdentityKey(annotation));
    const status: SourceDigestStatus =
      entry === undefined
        ? "missing-source"
        : annotation.source_digest === undefined
          ? "untracked"
          : annotation.source_digest === entry.digest
            ? "current"
            : "changed";
    if (status === "current") {
      current += 1;
      continue;
    }
    findings.push({
      faction_id: annotation.faction_id,
      ability_id: annotation.ability_id,
      status,
    });
  }

  for (const [key, entry] of parsed) {
    if (byIdentity.has(key)) continue;
    findings.push({
      faction_id: entry.faction_id,
      ability_id: entry.ability_id,
      status: "unknown-source",
    });
  }

  findings.sort(
    (a, b) =>
      compareCodeUnits(a.faction_id, b.faction_id) ||
      compareCodeUnits(a.ability_id, b.ability_id) ||
      compareCodeUnits(a.status, b.status),
  );

  const count = (status: SourceDigestFindingStatus): number =>
    findings.filter((finding) => finding.status === status).length;

  return {
    generated_from: "tools/src/audit-source-digest.ts",
    summary: {
      annotations: annotations.length,
      corpus_entries: parsed.size,
      current,
      changed: count("changed"),
      untracked: count("untracked"),
      missing_source: count("missing-source"),
      unknown_source: count("unknown-source"),
      findings: findings.length,
    },
    findings,
  };
}

/**
 * Render the report as deterministic plain text: a count line per status, then
 * one `<status> <faction_id>/<ability_id>` line per finding in report order.
 *
 * The rendering adds nothing to the report: every token it prints is already a
 * count or an identifier in {@link SourceDigestAuditReport}, so anything the
 * report is safe to serialise the output is safe to paste into an issue or a
 * CI log.
 */
export function renderSourceDigestAudit(
  report: SourceDigestAuditReport,
): string {
  const s = report.summary;
  const lines = [
    `source-digest audit — ${s.annotations} annotations, ${s.corpus_entries} corpus entries`,
    `current ${s.current}  changed ${s.changed}  untracked ${s.untracked}  missing-source ${s.missing_source}  unknown-source ${s.unknown_source}`,
  ];
  if (report.findings.length === 0) {
    lines.push("no findings");
  } else {
    for (const finding of report.findings) {
      lines.push(`${finding.status} ${sourceIdentityKey(finding)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Read a corpus file without ever naming its path — the path may be private. */
function readCorpusFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    throw new Error(
      "source corpus: cannot read the corpus file given as the first argument",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("source corpus: not valid JSON");
  }
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).replace(/\.\w+$/, "") ===
    fileURLToPath(import.meta.url).replace(/\.\w+$/, "");

if (isMain) {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf("--root");
  const rootDir = rootFlag >= 0 ? args[rootFlag + 1] : undefined;
  // Guard on `rootFlag >= 0`: with no `--root`, `indexOf` is -1 and a bare
  // `index !== rootFlag + 1` would silently drop the corpus argument at index 0.
  const positional =
    rootFlag >= 0
      ? args.filter((_, index) => index !== rootFlag && index !== rootFlag + 1)
      : args;

  try {
    if (positional.length !== 1 || (rootFlag >= 0 && rootDir === undefined)) {
      throw new Error(
        "usage: npm run audit:source-digest -- <corpus.json> [--root <repo-root>]",
      );
    }
    const report = auditSourceDigests(
      readCorpusFile(resolve(positional[0])),
      loadAbilityAnnotations(rootDir === undefined ? DEFAULT_ROOT : resolve(rootDir)),
    );
    process.stdout.write(renderSourceDigestAudit(report));
    if (report.findings.length > 0) process.exitCode = 1;
  } catch (error) {
    // Only the message, never a stack: a stack would add filesystem paths for
    // no diagnostic benefit here. Malformed input shares exit status `1` with
    // findings; the two are told apart by whether a summary reached stdout.
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
