/**
 * Orchestrates an army-list import: decode → parse → resolve.
 *
 * The adapter seam ({@link FormatAdapter}) lets every supported source format
 * plug in here without touching {@link decode} or {@link resolve}. Adapters are
 * registered in priority order, and every adapter's `matches()` predicate is
 * tight enough that **at most one** matches any given decoded payload —
 * {@link tryImportRoster} relies on that disjointness to short-circuit on the
 * first match.
 *
 * @packageDocumentation
 */
import { Dataset } from "../data/dataset.js";
import type { FormatAdapter } from "./adapter.js";
import { selectAdapter } from "./adapter.js";
import { decodeListForge } from "./decode.js";
import { gwAdapter } from "./gw.js";
import { gwHeaderlessAdapter } from "./gw-headerless.js";
import { listForgeAdapter } from "./listforge.js";
import { listForgeTextAdapter } from "./listforge-text.js";
import { newRecruitJsonAdapter } from "./newrecruit-json.js";
import { newRecruitSimpleAdapter } from "./newrecruit-simple.js";
import {
  newRecruitWtcCompactAdapter,
  newRecruitWtcFullAdapter,
} from "./newrecruit-wtc.js";
import { resolve } from "./resolve.js";
import { rosterJsonAdapter } from "./roster-json.js";
import { rosterizerAdapter } from "./rosterizer.js";
import type { Roster, RosterFormat } from "./types.js";

/**
 * Adapters available to {@link importRoster}, in match-priority order.
 *
 * NewRecruit-JSON runs ahead of ListForge because both recognise a
 * `roster.forces` BattleScribe payload, and the NewRecruit signature is more
 * specific (`xmlns: rosterSchema` or `generatedBy: newrecruit.eu`). The text
 * adapters (`gw` / `wtc-compact` / `wtc-full` / `simple` / `listforge-text`)
 * only match strings and disambiguate among themselves via structural cues, so
 * their order amongst each other doesn't matter; wtc-full goes before
 * wtc-compact because its matcher is the more specific of the two. GW shares
 * the WTC summary header but carries `•` bullets and no `N with` lines, so it
 * stays disjoint from both wtc matchers; listforge-text requires the
 * `name - faction - detachment (N Points)` first line none of the others
 * accept. Rosterizer rides at the top of the JSON dispatch — its `rulebook` +
 * `snapshot` signature is structurally distinct from the BattleScribe
 * `roster.forces` shape.
 */
const ADAPTERS: readonly FormatAdapter[] = [
  // roster-json runs first: its matcher is the most specific (the canonical
  // source.format + game_version + diagnostics envelope), so a 40kdc-native
  // export is never mis-detected by a looser matcher.
  rosterJsonAdapter,
  rosterizerAdapter,
  newRecruitJsonAdapter,
  gwAdapter,
  newRecruitWtcFullAdapter,
  newRecruitWtcCompactAdapter,
  newRecruitSimpleAdapter,
  // listforge-text requires the `name - faction - detachment (N Points)` first
  // line none of the others accept; it runs right before the headerless
  // fallback so its framed header wins when present.
  listForgeTextAdapter,
  // Fallback for bullet-bearing plain text without a summary fence (GW app
  // export, NewRecruit copy-text, `##` markdown lists). Placed after the framed
  // text adapters so they win when their headers are present.
  gwHeaderlessAdapter,
  listForgeAdapter,
];

export interface ImportOptions {
  /** Dataset to resolve against. Defaults to the package's embedded dataset. */
  dataset?: Dataset;
}

/**
 * Import a ListForge share payload into a resolved 40kdc {@link Roster}.
 *
 * `input` may be a full ListForge URL, a bare base64 segment, or an
 * already-decoded JSON string — all are handled transparently. For NewRecruit
 * sources, use {@link importNewRecruit} (no base64/gzip decode).
 */
export function importListForge(input: string, opts: ImportOptions = {}): Roster {
  const decoded = decodeListForge(input);
  return importRoster(decoded, opts);
}

/**
 * Import a NewRecruit export (any of the four formats — JSON, wtc-compact,
 * wtc-full, simple) into a resolved 40kdc {@link Roster}.
 *
 * The JSON form is parsed when `input` is valid JSON; the text forms are
 * dispatched on string content. No base64/gzip decoding is attempted —
 * NewRecruit exports are not encoded.
 */
export function importNewRecruit(input: string, opts: ImportOptions = {}): Roster {
  const trimmed = input.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return importRoster(JSON.parse(input), opts);
    } catch {
      // Fall through to treating the input as raw text.
    }
  }
  return importRoster(input, opts);
}

/**
 * Import an already-decoded payload. Selects the matching format adapter and
 * resolves the result against the dataset. Accepts either a parsed JSON object
 * (NewRecruit JSON / ListForge) or a string (the three NewRecruit text formats).
 */
/**
 * Detect an already-resolved canonical {@link Roster} (the JSON shape produced
 * by `rosterJsonSerializer`). Lets a downstream consumer round-trip canonical
 * Roster JSON through `importRoster` without going through an adapter.
 */
function isCanonicalRoster(decoded: unknown): decoded is Roster {
  if (typeof decoded !== "object" || decoded === null) return false;
  const r = decoded as Record<string, unknown>;
  const source = r.source as Record<string, unknown> | undefined;
  return (
    typeof source === "object" &&
    source !== null &&
    typeof source.format === "string" &&
    Array.isArray(r.units) &&
    "diagnostics" in r
  );
}

export function importRoster(decoded: unknown, opts: ImportOptions = {}): Roster {
  if (isCanonicalRoster(decoded)) return decoded;
  const ds = opts.dataset ?? Dataset.embedded();
  const adapter = selectAdapter(decoded, [...ADAPTERS]);
  const parsed = adapter.parse(decoded);
  return resolve(parsed, ds, adapter.id);
}

// ---------------------------------------------------------------------------
// tryImportRoster — single string-in, structured-result-out entry point.
// ---------------------------------------------------------------------------

/** Why a {@link tryImportRoster} call did not produce a roster. */
export type ImportFailureReason =
  | "empty-input"
  | "decode-failed"
  | "no-adapter-matched"
  | "parse-failed";

/** Per-adapter outcome from a {@link tryImportRoster} dispatch. */
export interface AdapterTrial {
  id: RosterFormat;
  /** True iff this adapter's `matches()` predicate accepted the decoded input. */
  matched: boolean;
  /** Present when {@link matched} is true and `parse()` then threw — the matcher
   * violated its contract. Absent for clean rejections. */
  reason?: string;
}

/** Discriminated result returned by {@link tryImportRoster}. */
export type ImportResult =
  | { ok: true; roster: Roster; format: RosterFormat }
  | {
      ok: false;
      reason: ImportFailureReason;
      message: string;
      trials: AdapterTrial[];
    };

/** Cheap predicate: does the input look like ListForge's URL-or-base64 wrapper? */
function looksLikeListForgeEncoded(input: string): boolean {
  if (input.includes("/listforge/")) return true;
  // Every gzip-then-base64 payload starts with this prefix.
  if (input.startsWith("H4sIA")) return true;
  return false;
}

/**
 * Auto-detect and import any supported roster format from a single string.
 *
 * Pipeline:
 * 1. Empty input → `empty-input`.
 * 2. Looks like a ListForge URL / base64 payload → decode (base64 + gunzip + JSON.parse).
 * 3. Looks like raw JSON (starts with `{`/`[`) → JSON.parse.
 * 4. Otherwise treat as text.
 * 5. Greedy first-match adapter dispatch. The first adapter whose `matches()`
 *    accepts the decoded value wins; subsequent adapters are not tried.
 * 6. If the matched adapter's `parse()` throws, that's a matcher contract
 *    violation — surfaced as `parse-failed`, not silently retried.
 *
 * Caller never sees an exception; the discriminated {@link ImportResult} carries
 * either the resolved {@link Roster} (with the detected {@link RosterFormat})
 * or a typed failure plus per-adapter trial info for diagnostics.
 *
 * Prefer this over {@link importListForge} / {@link importNewRecruit} when the
 * caller doesn't know which format the user pasted.
 */
export function tryImportRoster(
  input: string,
  opts: ImportOptions = {},
): ImportResult {
  const trimmed = input.trim();
  if (trimmed === "") {
    return { ok: false, reason: "empty-input", message: "input is empty", trials: [] };
  }

  let decoded: unknown;
  if (looksLikeListForgeEncoded(trimmed)) {
    try {
      decoded = decodeListForge(trimmed);
    } catch (err) {
      const message = (err as Error).message;
      return {
        ok: false,
        reason: "decode-failed",
        message: `failed to decode ListForge payload: ${message}`,
        trials: [{ id: "listforge", matched: false, reason: message }],
      };
    }
  } else if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      decoded = JSON.parse(trimmed);
    } catch (err) {
      return {
        ok: false,
        reason: "decode-failed",
        message: `input looks like JSON but failed to parse: ${(err as Error).message}`,
        trials: [],
      };
    }
  } else {
    decoded = input;
  }

  const ds = opts.dataset ?? Dataset.embedded();
  const trials: AdapterTrial[] = [];
  for (const adapter of ADAPTERS) {
    if (!adapter.matches(decoded)) {
      trials.push({ id: adapter.id, matched: false });
      continue;
    }
    try {
      const parsed = adapter.parse(decoded);
      const roster = resolve(parsed, ds, adapter.id);
      return { ok: true, roster, format: adapter.id };
    } catch (err) {
      const message = (err as Error).message;
      trials.push({ id: adapter.id, matched: true, reason: message });
      return {
        ok: false,
        reason: "parse-failed",
        message: `${adapter.id}: ${message}`,
        trials,
      };
    }
  }

  return {
    ok: false,
    reason: "no-adapter-matched",
    message: `tried ${ADAPTERS.length} formats, none recognised the input`,
    trials,
  };
}

/** The adapter list, exposed for tests that need to walk every matcher (e.g.
 * the disjointness invariant test). */
export const REGISTERED_ADAPTERS: readonly FormatAdapter[] = ADAPTERS;
