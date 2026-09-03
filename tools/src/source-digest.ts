/**
 * Source-rule fingerprints for Ability DSL annotations (#217).
 *
 * An authored annotation is a claim about a printed rule. `game_version`
 * records the dataslate the annotation was authored *for*, not whether *this*
 * rule's wording actually changed, so a reworded rule leaves the claim
 * silently stale. `source_digest` closes that gap: it is the SHA-256 of the
 * NORMALISED source rule, so the repository can detect drift while the rule
 * text itself stays outside the repository (the hash is one-way — see
 * `CONTRIBUTING.md`; nothing here reads, writes or logs prose).
 *
 * This module is pure: no filesystem, no process state, no output. It is the
 * single definition of source equality shared by `audit-source-digest.ts` and
 * `backfill-source-digests.ts`.
 *
 * It is deliberately NOT {@link normalizeName} from `data/normalize.ts`: that
 * key answers "did the user type this entity's name?" and throws away
 * punctuation and diacritics wholesale, which would erase the numbers and
 * comparisons a rule turns on. It is also NOT the `srcHash` resume key in
 * `author-batch.ts`, which is an unnormalised truncated SHA-1 whose whole
 * point is byte sensitivity.
 *
 * The normalisation contract is versioned by the field, not by a value inside
 * it: an incompatible future contract takes a new schema field rather than
 * reinterpreting `source_digest`.
 *
 * @packageDocumentation
 */
import { createHash } from "node:crypto";

/**
 * Punctuation and symbols kept verbatim because a rule's meaning turns on
 * them: `2+` vs `2`, `-1` vs `1`, `<=` vs `=`, `D6/2`, `50%`.
 */
const RULE_OPERATORS = "+-=<>/%";

/**
 * Dash and minus variants that carry the same meaning as ASCII `-`: hyphen,
 * non-breaking hyphen, figure/en/em dash, horizontal bar, hyphen bullet,
 * minus sign, heavy minus, and the small/fullwidth compatibility forms.
 */
const DASH_VARIANTS = /[‐‑‒–—―⁃−➖﹘﹣－]/g;

/** Multiplication signs that carry the same meaning as ASCII `x`. */
const MULTIPLICATION_VARIANTS = /[×✕✖⨯]/g;

/**
 * Format/invisible characters (`\p{Cf}`: zero-width space, ZWJ/ZWNJ, soft
 * hyphen, BOM, bidi controls). PDF reprints sprinkle these; they are never
 * rule-significant and `\s` does not match them, so they are dropped outright
 * rather than collapsed.
 */
const FORMAT_CHARS = /\p{Cf}/gu;

/** Every punctuation or symbol character — `\p{P}\p{S}` covers all ASCII punctuation. */
const PUNCTUATION_OR_SYMBOL = /[\p{P}\p{S}]/gu;

/** Any run of Unicode whitespace (includes NBSP, the U+2000 block and U+3000). */
const WHITESPACE_RUN = /\s+/gu;

/**
 * Reduce a printed rule to the canonical form that gets hashed.
 *
 * The transform, in order:
 * 1. Unicode NFKC-compose, so decomposed accents, ligatures and fullwidth
 *    forms agree with their canonical spelling.
 * 2. Drop format/zero-width characters, then casefold to lower case and
 *    re-apply NFKC (casefolding can decompose, e.g. `İ` → `i` + U+0307).
 * 3. Canonicalise dash/minus variants to `-` and multiplication signs to `x`,
 *    so an en dash or `×` reads as the operator it prints as.
 * 4. Keep each {@link RULE_OPERATORS} character, space-padded so `6+`, `6 +`
 *    and `6+ ` agree; replace every other punctuation or symbol character
 *    with a space, so quote style (`'` vs `’`), commas, brackets, bullets and
 *    sentence punctuation cannot churn the digest.
 * 5. Collapse whitespace runs to one space and trim.
 *
 * Diacritics are preserved (unlike name lookup) — a reprint does not silently
 * respell a word, and folding them would merge distinct rule vocabulary.
 *
 * The result is a comparison key, never a display or storage value: it is
 * hashed immediately by {@link sourceDigest} and must not be persisted or
 * printed, because it still contains the rule's words.
 *
 * @example
 * normalizeSourceForDigest("Add 1 to the Strength characteristic.");
 * // "add 1 to the strength characteristic"
 * normalizeSourceForDigest("Re-roll a  “Hit” roll of 1 — 6+ saves.");
 * // "re - roll a hit roll of 1 - 6 + saves"
 */
export function normalizeSourceForDigest(source: string): string {
  return source
    .normalize("NFKC")
    .replace(FORMAT_CHARS, "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(DASH_VARIANTS, "-")
    .replace(MULTIPLICATION_VARIANTS, "x")
    .replace(PUNCTUATION_OR_SYMBOL, (ch) =>
      RULE_OPERATORS.includes(ch) ? ` ${ch} ` : " ",
    )
    .replace(WHITESPACE_RUN, " ")
    .trim();
}

/**
 * Fingerprint a printed rule: SHA-256 of the UTF-8 bytes of
 * {@link normalizeSourceForDigest}, as 64 lowercase hexadecimal characters —
 * the exact shape the ability schema's `source_digest` pattern admits.
 *
 * The digest is one-way and fixed-width, so it reveals neither the rule's text
 * nor its length. Cosmetic differences covered by the normalisation contract
 * produce the same digest; a changed value, an added condition or any other
 * change to the rule's words produces a different one.
 *
 * @throws RangeError when `source` normalises to nothing. Every such rule
 * would otherwise share one meaningless sentinel digest and read as "current"
 * against any other empty source, which is worse than no digest at all. The
 * message never echoes the input.
 *
 * @example
 * sourceDigest("Add 1 to the Strength characteristic.").length; // 64
 */
export function sourceDigest(source: string): string {
  const normalized = normalizeSourceForDigest(source);
  if (normalized === "") {
    throw new RangeError(
      "source rule is empty after normalisation; refusing to digest it",
    );
  }
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
