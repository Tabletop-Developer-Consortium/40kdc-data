/**
 * backfill:source-digest — populate Ability DSL `source_digest` fields from a
 * contributor-owned corpus of printed rules (#217).
 *
 * This is the explicit write path that `audit:source-digest` deliberately is
 * not. An audit must not mutate tracked data, and waiting for digests to
 * accumulate as annotations happen to be reviewed would leave the audit failing
 * on nearly everything and preserve exactly the "reviewed versus never
 * revisited" ambiguity the field exists to remove. So the initial digest set is
 * populated in one deliberate pass from the same corpus the audit reads.
 *
 * It reuses {@link parseSourceDigestCorpus} and
 * {@link loadAbilityAnnotationFiles} rather than restating either contract: one
 * definition of source equality, one definition of composite identity, so the
 * data this command writes is by construction what the audit then calls
 * `current`.
 *
 * The new file text is produced by editing the original text, never by
 * re-serialising the parsed records: the committed faction files do not share
 * one JSON escape convention, so a serialiser would silently rewrite every
 * string in whichever half it does not match. See {@link
 * scanAbilityRecordSpans}.
 *
 * Privacy is the same as the audit's. Every corpus string is reduced to a digest
 * the moment it is parsed, so no report row, rendered line or error message can
 * carry prose. Output names repository-relative file paths, faction ids, ability
 * ids and counts — never source text, ability names, digest values or the
 * corpus's own path.
 *
 * The transaction boundary is validation, not the filesystem: a malformed
 * corpus, a malformed ability file, a duplicate composite identity, or any gap
 * in the one-to-one join aborts before the first byte is written. Once
 * validation passes, each changed file is written via a temporary file and
 * renamed into place, and an I/O fault reports how far the run got.
 *
 * Usage:
 *   npm run backfill:source-digest -- <corpus.json>
 *     [--root <repo-root>] [--dry-run] [--allow-untracked]
 *
 * `--allow-untracked` opts in to leaving annotations the corpus cannot resolve
 * untouched instead of aborting — see
 * {@link SourceDigestBackfillOptions.allowUntracked} for why a handful of
 * annotations can never have a corpus entry. It relaxes nothing else.
 *
 * Exit status: `0` when the corpus validated and the projected writes were
 * applied (or previewed under `--dry-run`); `1` on any validation or invocation
 * failure, in which case nothing was written.
 *
 * @packageDocumentation
 */
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_ROOT,
  loadAbilityAnnotationFiles,
  readSourceDigestCorpusFile,
  type AbilityAnnotationFile,
  type RawAbility,
} from "./audit-source-digest.js";
import {
  compareCodeUnits,
  parseSourceDigestCorpus,
  sourceIdentityKey,
} from "./source-digest.js";

/**
 * The schema neighbour `source_digest` is inserted after when a record does not
 * already carry the field. Anchoring the key position keeps the committed diff
 * to one added line in a predictable place, and matches the property order in
 * `schemas/enrichment/ability-dsl/ability.schema.json`. A record with no
 * `game_version` (which the schema requires, so only a fixture) gets the field
 * appended instead.
 */
const KEY_ANCHOR = "game_version";

/**
 * How many identities an abort message lists before falling back to a count.
 * The identities are safe to print, but a corpus that covers half the dataset
 * would otherwise produce thousands of lines; `audit:source-digest` already
 * renders the complete sorted list, so the message points there instead.
 */
const MAX_LISTED = 10;

/** One changed file, described only by its relative path and safe counts. */
export interface SourceDigestBackfillFile {
  /** Repository-relative path, e.g. `data/enrichment/necrons/abilities.json`. */
  file: string;
  /** Records gaining a `source_digest` they did not have. */
  added: number;
  /** Records whose existing `source_digest` this run brings up to date. */
  replaced: number;
}

/** Deterministic, privacy-safe account of what the backfill did (or would do). */
export interface SourceDigestBackfillReport {
  generated_from: "tools/src/backfill-source-digests.ts";
  summary: {
    /** Live annotations scanned. */
    annotations: number;
    /** Corpus entries parsed. */
    corpus_entries: number;
    /** Live ability files read. */
    files_scanned: number;
    /** Files whose contents change. */
    files_changed: number;
    /** Records whose stored digest already matched the corpus. */
    unchanged: number;
    /**
     * Annotations left untouched because the corpus has no entry for them.
     * Always `0` unless {@link SourceDigestBackfillOptions.allowUntracked} was
     * requested, since otherwise the gap aborts the run.
     */
    skipped: number;
    added: number;
    replaced: number;
  };
  /** Changed files only, sorted by relative path. */
  files: SourceDigestBackfillFile[];
}

/**
 * A file staged for writing: its absolute path and full serialised contents.
 *
 * Unlike a report row this carries the record bodies, because those bodies are
 * what gets written — they are public repository data, not source prose. It is
 * still not something to print: keep diagnostics to
 * {@link SourceDigestBackfillReport}.
 */
export interface StagedAbilityFile {
  /** Absolute destination path. Never printed. */
  path: string;
  /** Repository-relative path, safe to print. */
  relative: string;
  /**
   * The file's original text with the digest edits spliced in. Every byte the
   * digests do not occupy is byte-identical to what was read.
   */
  contents: string;
}

/** The validated projection: what to write, and the safe account of it. */
export interface SourceDigestBackfillPlan {
  report: SourceDigestBackfillReport;
  /** Empty when every stored digest already matched the corpus. */
  writes: StagedAbilityFile[];
}

/** Non-default behaviour, all of it narrowing rather than widening a gate. */
export interface SourceDigestBackfillOptions {
  /**
   * Leave an annotation the corpus has no entry for untouched, instead of
   * aborting the whole run.
   *
   * The default abort is the right contract for a corpus that is *supposed* to
   * be complete, and it stays the default. But some annotations can never have a
   * corpus entry, and no amount of better matching changes that:
   *
   * - A `unique-unit-limit` annotation describes a datasheet's structural
   *   uniqueness, which GW models on the datasheet rather than as rules prose.
   *   There is no printed rule to fingerprint, permanently.
   * - An annotation whose authored id does not match the printed name (a
   *   singular id against a plural name) cannot join until the id is renamed,
   *   and a rename needs a `data/share-registry.json` alias to keep old share
   *   links decoding — a separate change.
   * - A dump ability with no `datasheet_datasheet_ability` link cannot be
   *   disambiguated from its same-named sibling by the unit join, and guessing
   *   would fingerprint the wrong unit's prose.
   * - A globally keyed store entry owned by another faction cannot safely
   *   fingerprint a same-id annotation; when the MFM cannot disambiguate that
   *   faction's source either, the annotation remains intentionally untracked.
   *
   * So this flag relaxes *only* the annotation-side gap. Every other abort class
   * still aborts: an unknown corpus key (the corpus and the repository disagree
   * about what exists), a duplicate composite identity, a malformed ability
   * file, an invalid corpus value, a misaligned identity list. Skipping is
   * genuinely inert — no `source_digest` is written, and an existing one is
   * neither refreshed nor removed — and the count is reported so the gap stays
   * visible rather than becoming invisible.
   *
   * `audit:source-digest` is unaffected: it still classifies these as
   * `missing-source` findings and still exits `1`, because an audit's job is to
   * report the gap, not to bless it.
   */
  allowUntracked?: boolean;
}

/**
 * A byte-range replacement in a file's original text. An insertion is a
 * zero-width range.
 */
interface TextEdit {
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset; equal to {@link start} for an insertion. */
  end: number;
  text: string;
}

/** One member of a scanned JSON object, with the offsets of its key and value. */
interface JsonMemberSpan {
  key: string;
  /** Offset of the opening quote of the key. */
  keyStart: number;
  /** Offset of the value's first character. */
  valueStart: number;
  /** Offset just past the value's last character. */
  valueEnd: number;
}

/** One scanned record of the top-level array, with its member offsets. */
export interface AbilityRecordSpan {
  /** Offset of the record's `{`. */
  start: number;
  /** Offset just past the record's `}`. */
  end: number;
  /** Top-level members only, in authored order. */
  members: JsonMemberSpan[];
}

function isJsonWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function skipWhitespace(text: string, from: number): number {
  let i = from;
  while (i < text.length && isJsonWhitespace(text[i])) i += 1;
  return i;
}

/** Skip a JSON string starting at its opening quote; returns the offset past it. */
function skipString(text: string, from: number): number {
  let i = from + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      // Skip the escape and whatever it escapes, so an escaped quote (or an
      // escaped backslash before a quote) cannot end the string early.
      i += 2;
      continue;
    }
    if (text[i] === '"') return i + 1;
    i += 1;
  }
  throw new Error("unterminated string");
}

/** Skip any JSON value; returns the offset just past it. */
function skipValue(text: string, from: number): number {
  const ch = text[from];
  if (ch === '"') return skipString(text, from);
  if (ch === "{" || ch === "[") {
    let i = from;
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i = skipString(text, i);
        continue;
      }
      if (c === "{" || c === "[") depth += 1;
      else if (c === "}" || c === "]") {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      i += 1;
    }
    throw new Error("unterminated object or array");
  }
  // A number, `true`, `false` or `null`: runs to the next structural character.
  let i = from;
  while (i < text.length && !",}]".includes(text[i]) && !isJsonWhitespace(text[i])) {
    i += 1;
  }
  if (i === from) throw new Error("expected a value");
  return i;
}

/** Scan one object starting at its `{`, recording its top-level members. */
function scanObject(text: string, start: number): AbilityRecordSpan {
  let i = skipWhitespace(text, start + 1);
  const members: JsonMemberSpan[] = [];
  if (text[i] === "}") return { start, end: i + 1, members };
  for (;;) {
    i = skipWhitespace(text, i);
    if (text[i] !== '"') throw new Error("expected an object key");
    const keyStart = i;
    const keyEnd = skipString(text, i);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    i = skipWhitespace(text, keyEnd);
    if (text[i] !== ":") throw new Error("expected ':' after an object key");
    const valueStart = skipWhitespace(text, i + 1);
    const valueEnd = skipValue(text, valueStart);
    members.push({ key, keyStart, valueStart, valueEnd });
    i = skipWhitespace(text, valueEnd);
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    if (text[i] === "}") return { start, end: i + 1, members };
    throw new Error("expected ',' or '}' after an object member");
  }
}

/**
 * Locate every record of a `data/enrichment/<faction>/abilities.json` array in
 * its original text.
 *
 * This exists because the backfill must not re-serialise the file. The
 * committed tree does not share one JSON escape convention — some faction files
 * write `\uXXXX` escapes for typographic punctuation and others write the
 * literal UTF-8 — so any serialiser round-trips one half and rewrites the
 * other. `JSON.stringify` emits literal UTF-8 and would silently rewrite every
 * escaped `name` and `community_notes` value; an ASCII-escaping serialiser
 * would rewrite the literal ones. Neither is acceptable in a change that is
 * supposed to add one field.
 *
 * So the file is parsed to decide *what* to do and scanned to find *where*,
 * and the new text is the original text with digest edits spliced in. Every
 * other byte — escape style, spacing, key order, trailing newline — survives
 * untouched because it is never rewritten.
 *
 * @throws Error when the text is not a JSON array of objects. The caller has
 * already `JSON.parse`d the same text, so this only fires on a scanner bug.
 */
export function scanAbilityRecordSpans(text: string): AbilityRecordSpan[] {
  let i = skipWhitespace(text, 0);
  if (text[i] !== "[") throw new Error("expected a JSON array of annotations");
  i = skipWhitespace(text, i + 1);
  const spans: AbilityRecordSpan[] = [];
  if (text[i] === "]") return spans;
  for (;;) {
    i = skipWhitespace(text, i);
    if (text[i] !== "{") throw new Error("expected an annotation object");
    const span = scanObject(text, i);
    spans.push(span);
    i = skipWhitespace(text, span.end);
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    if (text[i] === "]") return spans;
    throw new Error("expected ',' or ']' after an annotation");
  }
}

/**
 * The indentation of the line `pos` sits on, or `undefined` when `pos` is not
 * the first non-whitespace thing on its line.
 *
 * `undefined` means the file packs several members onto one line, so inserting
 * a whole new line there would split an existing one.
 */
function lineIndentOf(text: string, pos: number): string | undefined {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const prefix = text.slice(lineStart, pos);
  return /^[ \t]*$/.test(prefix) ? prefix : undefined;
}

/**
 * The one edit that gives `span` the digest.
 *
 * Replacing an existing `source_digest` rewrites only the value, so the key
 * keeps its position (and this also covers an explicit `null`). Adding one
 * inserts a whole new line immediately after the {@link KEY_ANCHOR} member, at
 * that member's indentation, so the field lands in the schema's property
 * position and the diff is a single added line with nothing removed. A record
 * with no anchor member (only a fixture — the schema requires `game_version`)
 * gets the field after its last member instead.
 *
 * When the anchor is not alone on its line the file is packed rather than
 * line-per-key, and the member is inserted inline; that touches the one line it
 * has to, and no repository file is written that way.
 */
function sourceDigestEdit(
  text: string,
  span: AbilityRecordSpan,
  digest: string,
): TextEdit {
  const value = JSON.stringify(digest);

  const existing = span.members.find((m) => m.key === "source_digest");
  if (existing !== undefined) {
    return { start: existing.valueStart, end: existing.valueEnd, text: value };
  }

  const member = `"source_digest": ${value}`;
  const anchor =
    span.members.find((m) => m.key === KEY_ANCHOR) ??
    span.members[span.members.length - 1];
  if (anchor === undefined) {
    // An empty record. Nothing to anchor to, so sit between the braces.
    return { start: span.start + 1, end: span.start + 1, text: member };
  }

  // Insert after the anchor's separating comma when it has one, so the comma
  // ordering stays valid without moving any existing character.
  const afterValue = skipWhitespace(text, anchor.valueEnd);
  const hasComma = text[afterValue] === ",";
  const at = hasComma ? afterValue + 1 : anchor.valueEnd;
  const indent = lineIndentOf(text, anchor.keyStart);

  const inserted =
    indent === undefined
      ? hasComma
        ? ` ${member},`
        : `, ${member}`
      : hasComma
        ? `\n${indent}${member},`
        : `,\n${indent}${member}`;
  return { start: at, end: at, text: inserted };
}

/** Splice edits into the original text, left to right. */
function applyTextEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const edit of sorted) {
    if (edit.start < cursor) throw new Error("overlapping text edits");
    out += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + text.slice(cursor);
}

/**
 * Return `text` with a `source_digest` added to, or replaced on, each record
 * named by `digestsByIndex` (keys are indices into the file's record array).
 *
 * Every byte the digests do not occupy is preserved verbatim. For the
 * line-per-key formatting the repository uses, the diff against `text` is
 * exactly one added line per added digest and one changed value per replaced
 * digest — nothing else is added, removed or reordered.
 *
 * @throws Error when the scanner and `JSON.parse` disagree about how many
 * records the file holds, or when an index is out of range. Both would mean a
 * digest could be written onto the wrong record, so neither is recoverable.
 */
export function projectSourceDigestText(
  text: string,
  recordCount: number,
  digestsByIndex: Map<number, string>,
): string {
  if (digestsByIndex.size === 0) return text;

  const spans = scanAbilityRecordSpans(text);
  if (spans.length !== recordCount) {
    throw new Error(
      `annotation text scan found ${spans.length} records where parsing found ${recordCount}`,
    );
  }

  const edits: TextEdit[] = [];
  for (const [index, digest] of digestsByIndex) {
    const span = spans[index];
    if (span === undefined) {
      throw new Error(`annotation record #${index + 1} is not present in the text`);
    }
    edits.push(sourceDigestEdit(text, span, digest));
  }
  return applyTextEdits(text, edits);
}

/** `a, b, c and 4 more` — safe identifiers only, capped for readability. */
function summarizeIdentities(keys: string[]): string {
  const shown = keys.slice(0, MAX_LISTED).join(", ");
  const rest = keys.length - MAX_LISTED;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/**
 * Validate the whole corpus against the whole live annotation set and project
 * every `source_digest` update in memory.
 *
 * Pure: no filesystem, no process state, no output. Everything that can fail
 * fails here, which is what makes the write step all-or-nothing — the caller
 * either gets a complete plan or an exception, never a partial mutation.
 *
 * The join must be one-to-one on `(faction_id, ability_id)`. An annotation with
 * no corpus entry cannot be fingerprinted, and a corpus entry with no annotation
 * means the corpus and the repository disagree about what exists — either way,
 * writing the digests that *did* join would quietly bless a partial pass as a
 * completed one, so both abort. A bare `ability_id` is never used to close the
 * gap: the same id is authored in several factions, and a first-match join would
 * stamp one faction's rule onto another faction's annotation.
 *
 * {@link SourceDigestBackfillOptions.allowUntracked} relaxes the annotation side
 * of that requirement, and only that side, for the permanently unresolvable
 * annotations documented on the option. Those records are left byte-identical
 * and counted as `skipped`.
 *
 * The projection cannot make a file schema-invalid: `sourceDigest` always
 * returns the 64 lowercase hex characters the field's pattern admits, and no
 * other field is touched. It equally cannot *repair* a file that was already
 * invalid; that is what `npm run validate` is for.
 *
 * @throws Error on a malformed corpus, a duplicate composite identity, or an
 * incomplete join. Messages carry counts and already-validated identifiers only.
 */
export function planSourceDigestBackfill(
  corpus: unknown,
  files: AbilityAnnotationFile[],
  options: SourceDigestBackfillOptions = {},
): SourceDigestBackfillPlan {
  const allowUntracked = options.allowUntracked === true;
  const parsed = parseSourceDigestCorpus(corpus);

  // Belt and braces: `loadAbilityAnnotationFiles` already refuses duplicates,
  // but this function also accepts hand-built input, and an ambiguous identity
  // must never reach a write path.
  const claimed = new Set<string>();
  for (const file of files) {
    // `annotations` is index-aligned with `records` by construction in
    // `loadAbilityAnnotationFiles`, and the projection below relies on that to
    // decide which record gets which digest. A hand-built input that broke the
    // alignment would stamp a rule onto the wrong record, so check it.
    if (file.annotations.length !== file.records.length) {
      throw new Error(
        `${file.relative}: ${file.annotations.length} identities for ${file.records.length} records`,
      );
    }
    for (const annotation of file.annotations) {
      const key = sourceIdentityKey(annotation);
      if (claimed.has(key)) {
        throw new Error(`annotations: duplicate identity ${key}`);
      }
      claimed.add(key);
    }
  }

  // With `--allow-untracked` the annotation-side gap is expected, so it is not
  // collected as an abort reason; the projection loop counts it as `skipped`
  // instead. The corpus side is never relaxed.
  const missingSource: string[] = [];
  if (!allowUntracked) {
    for (const key of claimed) {
      if (!parsed.has(key)) missingSource.push(key);
    }
    missingSource.sort(compareCodeUnits);
  }
  const unknownSource = [...parsed.keys()].filter((key) => !claimed.has(key));
  if (missingSource.length > 0 || unknownSource.length > 0) {
    const parts = [
      missingSource.length > 0
        ? `${missingSource.length} annotation(s) have no corpus entry (${summarizeIdentities(missingSource)}; pass --allow-untracked to skip them instead)`
        : undefined,
      unknownSource.length > 0
        ? `${unknownSource.length} corpus entr(y/ies) have no annotation (${summarizeIdentities(unknownSource)})`
        : undefined,
    ].filter((part): part is string => part !== undefined);
    throw new Error(
      `backfill: refusing to write — the corpus is not a one-to-one match for the live annotations: ${parts.join("; ")}. ` +
        "Run `npm run audit:source-digest -- <corpus.json>` for the complete list.",
    );
  }

  const changes: SourceDigestBackfillFile[] = [];
  const writes: StagedAbilityFile[] = [];
  let annotations = 0;
  let unchanged = 0;
  let skipped = 0;
  let added = 0;
  let replaced = 0;

  for (const file of files) {
    annotations += file.annotations.length;
    let fileAdded = 0;
    let fileReplaced = 0;
    // Digests to splice into the file's ORIGINAL text, by record index. A file
    // with none is left completely alone — not even re-serialised to equivalent
    // bytes, since that would rewrite whichever escape convention it uses.
    const digestsByIndex = new Map<number, string>();

    file.annotations.forEach((annotation, index) => {
      const entry = parsed.get(sourceIdentityKey(annotation));
      if (entry === undefined) {
        // Only reachable under `--allow-untracked`; the join check aborted
        // otherwise. Leave the record exactly as authored — no digest written,
        // and any existing digest neither refreshed nor removed.
        skipped += 1;
        return;
      }
      const digest = entry.digest;
      if (annotation.source_digest === digest) {
        unchanged += 1;
        return;
      }
      digestsByIndex.set(index, digest);
      if (annotation.source_digest === undefined) fileAdded += 1;
      else fileReplaced += 1;
    });

    if (digestsByIndex.size === 0) continue;
    added += fileAdded;
    replaced += fileReplaced;
    changes.push({
      file: file.relative,
      added: fileAdded,
      replaced: fileReplaced,
    });
    writes.push({
      path: file.path,
      relative: file.relative,
      contents: projectSourceDigestText(
        file.text,
        file.records.length,
        digestsByIndex,
      ),
    });
  }

  changes.sort((a, b) => compareCodeUnits(a.file, b.file));
  writes.sort((a, b) => compareCodeUnits(a.relative, b.relative));

  return {
    report: {
      generated_from: "tools/src/backfill-source-digests.ts",
      summary: {
        annotations,
        corpus_entries: parsed.size,
        files_scanned: files.length,
        files_changed: changes.length,
        unchanged,
        skipped,
        added,
        replaced,
      },
      files: changes,
    },
    writes,
  };
}

/**
 * Persist a validated plan, all-or-nothing at the validation boundary.
 *
 * Each file is written to a sibling temporary path and renamed into place, so a
 * reader never observes a half-written ability file. Validation already passed
 * against this exact content, so a failure here is a genuine I/O fault rather
 * than bad data — it is surfaced with how far the run got.
 *
 * The fault is reported as the failing repository-relative path plus the errno
 * code, not the underlying error message: Node's `EACCES`/`ENOSPC` messages
 * embed the absolute path they were given, and this command's output must stay
 * free of absolute paths. The code and the relative path are the whole
 * diagnosis anyway.
 */
export function writeSourceDigestBackfill(
  plan: SourceDigestBackfillPlan,
): void {
  const written: string[] = [];
  for (const staged of plan.writes) {
    const temporary = `${staged.path}.backfill-tmp`;
    try {
      writeFileSync(temporary, staged.contents);
      renameSync(temporary, staged.path);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary file may never have been created; nothing to clean up.
      }
      const code = (error as { code?: unknown } | null)?.code;
      throw new Error(
        `backfill: I/O fault writing ${staged.relative} (${typeof code === "string" ? code : "unknown cause"}) ` +
          `after ${written.length}/${plan.writes.length} file(s) written; validation had passed. ` +
          `Written: ${written.join(", ") || "none"}.`,
      );
    }
    written.push(staged.relative);
  }
}

/**
 * Render the report as deterministic plain text: a count line, then one
 * `<added>+ <replaced>~ <file>` line per changed file.
 *
 * Every token printed is already a count or a repository-relative path in
 * {@link SourceDigestBackfillReport}, so the output is safe to paste anywhere
 * the report itself is.
 */
export function renderSourceDigestBackfill(
  report: SourceDigestBackfillReport,
  options: { dryRun?: boolean } = {},
): string {
  const s = report.summary;
  const verb = options.dryRun === true ? "would change" : "changed";
  const lines = [
    `source-digest backfill — ${s.annotations} annotations, ${s.corpus_entries} corpus entries, ${s.files_scanned} files scanned`,
    `added ${s.added}  replaced ${s.replaced}  unchanged ${s.unchanged}  skipped ${s.skipped}  ${verb} ${s.files_changed} file(s)`,
  ];
  if (report.files.length === 0) {
    lines.push("no changes");
  } else {
    for (const file of report.files) {
      lines.push(`${file.added}+ ${file.replaced}~ ${file.file}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const USAGE =
  "usage: npm run backfill:source-digest -- <corpus.json> [--root <repo-root>] [--dry-run] [--allow-untracked]";

/** Parsed invocation. Unknown flags are rejected rather than ignored. */
export interface BackfillArgs extends SourceDigestBackfillOptions {
  /** Absolute path to the corpus file. */
  corpus: string;
  /** Absolute repository root to backfill. */
  rootDir: string;
  /** Validate and project, but write nothing. */
  dryRun: boolean;
  /** `--allow-untracked`; see {@link SourceDigestBackfillOptions}. */
  allowUntracked: boolean;
}

/**
 * Parse the command line.
 *
 * @throws Error with {@link USAGE} on a missing corpus, an extra positional
 * argument, an unknown flag, or `--root` without a value. The message never
 * echoes an argument, because a mistyped invocation can put anything there.
 */
export function parseBackfillArgs(argv: string[]): BackfillArgs {
  const positional: string[] = [];
  let rootDir: string | undefined;
  let dryRun = false;
  let allowUntracked = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(USAGE);
      rootDir = value;
      index += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--allow-untracked") {
      allowUntracked = true;
    } else if (arg.startsWith("--")) {
      throw new Error(USAGE);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) throw new Error(USAGE);
  return {
    corpus: resolve(positional[0]),
    rootDir: rootDir === undefined ? DEFAULT_ROOT : resolve(rootDir),
    dryRun,
    allowUntracked,
  };
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).replace(/\.\w+$/, "") ===
    fileURLToPath(import.meta.url).replace(/\.\w+$/, "");

if (isMain) {
  try {
    const args = parseBackfillArgs(process.argv.slice(2));
    const plan = planSourceDigestBackfill(
      readSourceDigestCorpusFile(args.corpus),
      loadAbilityAnnotationFiles(args.rootDir),
      { allowUntracked: args.allowUntracked },
    );
    if (!args.dryRun) writeSourceDigestBackfill(plan);
    process.stdout.write(
      renderSourceDigestBackfill(plan.report, { dryRun: args.dryRun }),
    );
  } catch (error) {
    // Only the message, never a stack: a stack adds filesystem paths for no
    // diagnostic benefit. Reaching here means nothing was written, unless the
    // message says otherwise (the I/O-fault case).
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
