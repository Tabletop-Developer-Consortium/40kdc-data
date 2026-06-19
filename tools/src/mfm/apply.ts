/**
 * apply.ts — the single seam through which every MFM-ingest subcommand persists
 * its result.
 *
 * The bug this exists to kill: the ingest used to gate both its in-memory
 * mutations AND its `fs.writeFileSync` calls behind `if (write)`, so a dry run
 * computed change *counts* but never built the post-ingest dataset — it could not
 * see an orphan, a duplicate id, or a schema violation, because none of those
 * exist until `--write` flips the mutations on. "Clean dry run → exception (or
 * silent corruption) on write" was therefore guaranteed, not bad luck.
 *
 * The fix is a strict split: subcommands now apply their mutations in BOTH modes
 * and hand the fully-projected file contents here as {@link StagedWrite}s. This
 * function validates that projected dataset with the exact AJV + referential
 * integrity checks `npm run validate` runs (against a throwaway overlay tree, so
 * the real data is never touched until it is known-good), and:
 *   - throws on any failure in BOTH modes, so a dry run fails on precisely what a
 *     write would have produced; and
 *   - only when valid AND `write` is requested, persists every file atomically
 *     (tmp + rename), all-or-nothing.
 *
 * Net contract: a clean dry run guarantees a clean write.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createValidator } from "../schema-loader.js";
import { validateFiles, type ValidationResult } from "../validate.js";
import { checkReferentialIntegrity } from "../integrity.js";
import { formatReport } from "../report.js";
import { REPO_ROOT } from "./loader.js";

const DATA_ROOT = path.join(REPO_ROOT, "data");

export interface StagedWrite {
  /** Absolute path, under {@link DATA_ROOT}, of the file to (re)write. */
  path: string;
  /** Full new contents — a JSON-serializable array of entities. */
  value: unknown;
  /**
   * Optional pre-serialized file text to persist verbatim instead of the default
   * `JSON.stringify(value, 2)`. Lets a subcommand preserve a file's hand-authored
   * formatting (so the diff is only the changed values). When present it MUST
   * `JSON.parse` to a value deep-equal to {@link value}; the validation overlay
   * uses this text, so a mismatch would validate something other than `value`.
   */
  text?: string;
}

export interface ApplyOptions {
  write: boolean;
  /** Short label for log lines, e.g. "wargear". */
  label: string;
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/** Combine the two `validateFiles` halves into one report for formatting. */
function mergeSchema(a: ValidationResult, b: ValidationResult): ValidationResult {
  return {
    totalFiles: a.totalFiles + b.totalFiles,
    totalItems: a.totalItems + b.totalItems,
    passed: a.passed + b.passed,
    failed: a.failed + b.failed,
    errors: [...a.errors, ...b.errors],
  };
}

/**
 * Validate the projected dataset (real tree + staged overlays) and, only if valid
 * and `write` is requested, persist the staged files atomically. See the file
 * header for the contract. Throws on validation failure in either mode.
 */
export async function applyWrites(staged: StagedWrite[], opts: ApplyOptions): Promise<void> {
  if (staged.length === 0) {
    console.log(`[${opts.label}] no file changes to apply.`);
    return;
  }

  // 1. Build a throwaway projected tree: copy data/, then overlay the staged files.
  //    Referential integrity cross-references the whole tree (units ↔ enrichment,
  //    shared core pools), so the overlay must sit in a complete copy, not a sparse
  //    one. The copy is a few MB — cheap for an occasional dev CLI, and the price of
  //    a dry run that actually means something.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "40kdc-ingest-"));
  const projRoot = path.join(tmpRoot, "data");
  try {
    fs.cpSync(DATA_ROOT, projRoot, { recursive: true });
    for (const s of staged) {
      const rel = path.relative(DATA_ROOT, s.path);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`[${opts.label}] staged path escapes the data root: ${s.path}`);
      }
      const dest = path.join(projRoot, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, s.text ?? serialize(s.value));
    }

    // 2. Validate the projected tree — identical to `npm run validate`.
    const ajv = createValidator();
    const core = await validateFiles(ajv, "core/**/*.json", projRoot);
    const enrich = await validateFiles(ajv, "enrichment/**/*.json", projRoot);
    const integrity = await checkReferentialIntegrity(projRoot);

    const failed = core.failed + enrich.failed + integrity.failed;
    if (failed > 0) {
      const detail =
        formatReport(mergeSchema(core, enrich), "pretty") +
        "\n" +
        formatReport(integrity, "pretty", "40kdc Referential Integrity Report");
      throw new Error(
        `[${opts.label}] projected dataset FAILS validation (${failed} error(s)). ` +
          (opts.write
            ? "Nothing was written."
            : "This is exactly what --write would have produced.") +
          `\n${detail}`,
      );
    }

    console.log(
      `[${opts.label}] projected dataset valid — ${staged.length} file(s), ` +
        `${core.totalItems + enrich.totalItems} entities checked.`,
    );

    // 3. Persist atomically, all-or-nothing. Validation already passed against the
    //    identical content, so a failure here is a genuine I/O fault, not bad data —
    //    surface it loudly with how far the write got.
    if (opts.write) {
      const written: string[] = [];
      try {
        for (const s of staged) {
          const tmp = `${s.path}.ingest-tmp`;
          fs.writeFileSync(tmp, s.text ?? serialize(s.value));
          fs.renameSync(tmp, s.path);
          written.push(s.path);
        }
      } catch (e) {
        throw new Error(
          `[${opts.label}] I/O FAULT after ${written.length}/${staged.length} files written ` +
            `(validation had passed). Written: ${written.map((p) => path.relative(DATA_ROOT, p)).join(", ")}. ` +
            `Cause: ${(e as Error).message}`,
        );
      }
      console.log(`[${opts.label}] wrote ${written.length} file(s).`);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}
