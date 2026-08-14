/**
 * Helpers shared by the three NewRecruit text adapters (wtc-compact, wtc-full,
 * simple). These are pure string-massage utilities: they take format-specific
 * tokens and turn them into the format-agnostic {@link ParsedRoster} pieces.
 *
 * No business knowledge of dataset entities lives here — name resolution is
 * still {@link resolve}'s job downstream.
 *
 * @packageDocumentation
 */
import type { ParsedWargear } from "./types.js";

/** Tournament-standard battle sizes by points ceiling (10th ed). */
const BATTLE_SIZES: readonly { upper: number; label: string }[] = [
  { upper: 500, label: "Combat Patrol (500 Point limit)" },
  { upper: 1000, label: "Incursion (1000 Point limit)" },
  { upper: 2000, label: "Strike Force (2000 Point limit)" },
  { upper: 3000, label: "Onslaught (3000 Point limit)" },
];

/**
 * Synthesize a {@link ParsedRoster.battle_size_raw} from a points limit. The
 * wtc/simple formats don't carry the battle-size label explicitly — they only
 * report the total army points — so we map the limit to its standard label
 * (the same one {@link mapBattleSize} expects).
 */
export function inferBattleSizeRaw(limit: number | null): string | null {
  if (limit === null) return null;
  for (const { upper, label } of BATTLE_SIZES) {
    if (limit <= upper) return label;
  }
  return BATTLE_SIZES[BATTLE_SIZES.length - 1].label; // beyond Onslaught: cap at Onslaught
}

/** Outcome of classifying a comma-separated wargear list. */
export interface ClassifiedTokens {
  wargear: ParsedWargear[];
  is_warlord: boolean;
  is_character: boolean;
  keyword_overrides: string[];
  /** Enhancement raw name, when one was inlined in the wargear list (simple format). */
  enhancement_raw_name: string | null;
  /** Enhancement points cost when given inline (simple format), else null. */
  enhancement_points: number | null;
}

const NX_PREFIX = /^(\d+)x\s+(.+)$/;
const INLINE_PTS = /^(.+?)\s*\[\s*(\d+)\s*pts?\s*\]\s*$/i;
const INLINE_ENHANCEMENT = /^Enhancement:\s*(.+)$/i;
const CHARACTER_SUFFIX = " Character";
const INLINE_KEYWORD = /^40kdc Keywords?:\s*(.+)$/i;
const WARLORD_MARKER = "Warlord";

/**
 * Classify each token in a comma-separated wargear list. Strips the markers
 * that aren't real wargear — `Warlord`, the detachment "<Name> Character"
 * keyword, and the inline `Name [N pts]` enhancement (simple format) — and
 * collects everything else as {@link ParsedWargear} with optional `Nx` count.
 *
 * Tokens are pre-split: pass `["Armoured feet", "2x War Dog autocannon", ...]`.
 */
export function classifyWargearList(tokens: readonly string[]): ClassifiedTokens {
  const wargear: ParsedWargear[] = [];
  let is_warlord = false;
  let is_character = false;
  const keyword_overrides = new Set<string>();
  let enhancement_raw_name: string | null = null;
  let enhancement_points: number | null = null;

  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;

    if (token === WARLORD_MARKER) {
      is_warlord = true;
      continue;
    }
    if (token.endsWith(CHARACTER_SUFFIX)) {
      is_character = true;
      keyword_overrides.add("Character");
      continue;
    }
    const keyword = INLINE_KEYWORD.exec(token);
    if (keyword) {
      keyword_overrides.add(keyword[1].trim());
      continue;
    }

    // Simple format inlines the enhancement as `Name [15 pts]`.
    const pts = INLINE_PTS.exec(token);
    if (pts) {
      if (enhancement_raw_name === null) {
        enhancement_raw_name = pts[1].trim();
        enhancement_points = Number.parseInt(pts[2], 10);
      }
      continue;
    }
    // Our simple serializer uses an explicit marker when the source did not
    // report enhancement points; a bare name would be indistinguishable from
    // ordinary wargear and disappear on re-import.
    const enhancement = INLINE_ENHANCEMENT.exec(token);
    if (enhancement) {
      if (enhancement_raw_name === null) {
        enhancement_raw_name = enhancement[1].trim();
        enhancement_points = null;
      }
      continue;
    }

    const nx = NX_PREFIX.exec(token);
    if (nx) {
      const count = Number.parseInt(nx[1], 10);
      wargear.push({ raw_name: nx[2].trim(), count: count > 0 ? count : 1 });
    } else {
      wargear.push({ raw_name: token, count: 1 });
    }
  }

  return {
    wargear,
    is_warlord,
    is_character,
    keyword_overrides: [...keyword_overrides],
    enhancement_raw_name,
    enhancement_points,
  };
}

/**
 * Split a wargear list on top-level commas. (No nested parentheses with commas
 * are produced by NewRecruit, so a plain split is enough; the helper keeps
 * intent explicit for future format quirks.)
 */
export function splitWargearList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Strip a trailing parenthetical (e.g. "Houndpack Lance (Marked Prey)" → "Houndpack Lance"). */
export function stripParenthetical(name: string): string {
  const idx = name.indexOf("(");
  return idx >= 0 ? name.slice(0, idx).trim() : name.trim();
}

/** Pull the primary faction out of a "Super - Sub" keyword, e.g.
 * "Chaos - Chaos Knights" → "Chaos Knights". Shared by the wtc and GW headers. */
export function factionFromKeyword(value: string): string {
  const parts = value.split(" - ");
  return (parts[parts.length - 1] ?? value).trim();
}

/** Parse a `(\d+) pts` or `[\d+ pts]` suffix from a unit header line. */
export function pointsFrom(token: string): number | null {
  const m = /\(\s*(\d+)\s*pts?\s*\)|\[\s*(\d+)\s*pts?\s*\]/i.exec(token);
  if (!m) return null;
  return Number.parseInt(m[1] ?? m[2], 10);
}
