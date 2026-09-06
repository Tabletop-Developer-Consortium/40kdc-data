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

/**
 * The faction key the corpus uses for the shared `data/enrichment/_core`
 * annotation pool, whose records deliberately carry no `faction_id` so the
 * linked API's faction-scoped lookup can fall back to them.
 */
export const CORE_FACTION_ID = "_core";

/** `$defs/common.schema.json#/$defs/entity-id` — the kebab-case id contract. */
const ENTITY_ID = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/**
 * Order two strings by UTF-16 code unit, not by locale.
 *
 * `localeCompare` would make finding order depend on the runner's ICU data and
 * would not agree on where `_core` sorts relative to a faction id; a code-unit
 * comparison is the same everywhere, which is what "deterministic order" has to
 * mean for output a contributor or CI diffs. Exported so every consumer of a
 * {@link SourceDigestKey} sorts the same way.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The composite identity a source digest is recorded against. A bare
 * `ability_id` is NOT an identity: the same id is authored in several factions
 * (that is exactly what faction stamping and `getAny` fallback exist for), so
 * a first-match bare-id join would fingerprint one faction's rule against
 * another faction's annotation.
 */
export interface SourceDigestKey {
  /** Owning faction directory, or {@link CORE_FACTION_ID} for shared abilities. */
  faction_id: string;
  ability_id: string;
}

/**
 * The contributor-owned corpus, as read from disk:
 * `{ "<faction-id>": { "<ability-id>": "printed rule text" } }`, with
 * {@link CORE_FACTION_ID} for shared abilities.
 *
 * The nesting is the point — it makes the repository's real composite identity
 * explicit rather than inviting an ambiguous flat `ability_id` map. The corpus
 * lives outside this repository and is only ever read.
 */
export type SourceDigestCorpus = Record<string, Record<string, string>>;

/** One corpus entry, already reduced to a digest — the prose is not retained. */
export interface SourceDigestCorpusEntry extends SourceDigestKey {
  /** `sourceDigest(<printed rule>)`; the rule text itself is discarded. */
  digest: string;
}

/**
 * A parsed corpus, keyed by {@link sourceIdentityKey} so callers join on the
 * composite identity. Iteration order is sorted by faction then ability rather
 * than by corpus file order, so every consumer renders deterministically
 * regardless of how the corpus happened to be serialised.
 */
export type ParsedSourceDigestCorpus = Map<string, SourceDigestCorpusEntry>;

/**
 * The map key for a composite identity. `/` is safe as the separator because
 * neither an entity id nor `_core` can contain one.
 */
export function sourceIdentityKey(key: SourceDigestKey): string {
  return `${key.faction_id}/${key.ability_id}`;
}

/** A valid corpus faction key: any entity id, plus the shared `_core` pool. */
function isFactionKey(value: string): boolean {
  return value === CORE_FACTION_ID || ENTITY_ID.test(value);
}

/**
 * Parse and validate a contributor-owned corpus, reducing every printed rule
 * to a {@link sourceDigest} as it is read.
 *
 * The reduction is immediate and total: the returned entries carry identity and
 * digest only, so no downstream audit row, report or error can retain prose
 * even by accident.
 *
 * Validation is strict and whole-corpus — a malformed corpus is an invocation
 * error, never an audit finding, because a partially-understood corpus would
 * silently under-report drift.
 *
 * @throws Error on a non-object corpus or faction level, an invalid faction or
 * ability id, a non-string value, or a value that normalises to nothing (which
 * would otherwise reach {@link sourceDigest}'s `RangeError`).
 *
 * Error messages name only identifiers that have already validated as
 * kebab-case ids. An *invalid* key is reported by its 1-based position instead,
 * because a mis-shaped corpus can put printed rule text in a key.
 */
export function parseSourceDigestCorpus(
  corpus: unknown,
): ParsedSourceDigestCorpus {
  if (typeof corpus !== "object" || corpus === null || Array.isArray(corpus)) {
    throw new Error(
      'source corpus: expected an object of the shape { "<faction-id>": { "<ability-id>": "<printed rule>" } }',
    );
  }

  const entries: SourceDigestCorpusEntry[] = [];
  const factions = Object.entries(corpus as Record<string, unknown>);
  factions.forEach(([faction_id, abilities], factionIndex) => {
    if (!isFactionKey(faction_id)) {
      throw new Error(
        `source corpus: faction key #${factionIndex + 1} is not a valid faction id (expected kebab-case or "${CORE_FACTION_ID}")`,
      );
    }
    if (
      typeof abilities !== "object" ||
      abilities === null ||
      Array.isArray(abilities)
    ) {
      throw new Error(
        `source corpus["${faction_id}"]: expected an object of ability ids to printed rules`,
      );
    }
    Object.entries(abilities as Record<string, unknown>).forEach(
      ([ability_id, source], abilityIndex) => {
        const where = `source corpus["${faction_id}"]`;
        if (!ENTITY_ID.test(ability_id)) {
          throw new Error(
            `${where}: ability key #${abilityIndex + 1} is not a valid ability id (expected kebab-case)`,
          );
        }
        if (typeof source !== "string") {
          throw new Error(
            `${where}["${ability_id}"]: expected a printed rule string`,
          );
        }
        if (normalizeSourceForDigest(source) === "") {
          throw new Error(
            `${where}["${ability_id}"]: printed rule is empty after normalisation`,
          );
        }
        entries.push({ faction_id, ability_id, digest: sourceDigest(source) });
      },
    );
  });

  entries.sort(
    (a, b) =>
      compareCodeUnits(a.faction_id, b.faction_id) ||
      compareCodeUnits(a.ability_id, b.ability_id),
  );
  return new Map(entries.map((entry) => [sourceIdentityKey(entry), entry]));
}
