/**
 * Source-text fingerprints for authored abilities.
 *
 * An annotation is a claim about a printed rule. When a dataslate rewords that rule the
 * claim may silently stop being true, and today nothing detects it: `version` records the
 * dataslate an ability was authored for, but not whether THIS ability's text actually
 * changed, so a consumer cannot tell "reviewed and still correct" from "never revisited".
 *
 * A digest of the source text closes that gap without the repo ever holding the text.
 * Contributors already bring their own core data (see CONTRIBUTING); this hashes it.
 */
export const NORMALISATION = 'v1' as const;

/** Casefold, collapse whitespace, drop punctuation that reprints vary freely. */
export function normaliseSourceText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[‘’“”]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9+\-'" ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function sourceDigest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(normaliseSourceText(text));
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SourceDigest {
  algo: 'sha256';
  value: string;
  normalisation: typeof NORMALISATION;
  source: string;
  checked_at?: string;
}

/** Does this ability's recorded digest still match the text we have in hand? */
export async function digestMatches(d: SourceDigest | undefined, text: string): Promise<boolean> {
  return !!d && d.value === (await sourceDigest(text));
}
