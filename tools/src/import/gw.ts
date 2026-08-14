/**
 * GW adapter: lower the Games Workshop 40K app's plain-text army-list export to
 * a {@link ParsedRoster}.
 *
 * The format opens with the same `++++…++++` summary fence as the NewRecruit WTC
 * formats (FACTION KEYWORD / DETACHMENT / TOTAL ARMY POINTS / WARLORD /
 * ENHANCEMENT / NUMBER OF UNITS / SECONDARY), then lists units grouped under
 * ALL-CAPS battlefield-role sections (`BATTLELINE`, `CHARACTERS`,
 * `ALLIED UNITS`, …). Each unit is a header line `Name (N pts)` followed by
 * `•`-bulleted entries:
 *
 * ```
 * War Dog Executioner (130 pts)
 * • 1x Armoured feet
 * • 2x War Dog autocannon
 * • Houndpack Lance Character, Warlord
 *
 * Nurglings (40 pts)
 * • 3x Nurgling Swarm
 *     • 3x Diseased claws and teeth
 * ```
 *
 * Bullet classification (the parsing crux):
 * - A top-level `• Nx Thing` *with* further-indented child bullets is a **model
 *   group** — `N` adds to the model count and the children are that group's
 *   wargear (Nurglings, Beasts of Nurgle).
 * - A top-level `• Nx Thing` *without* children is plain **wargear**.
 * - A bullet *without* an `Nx` count is an **annotation**: `… Character` flags a
 *   character, `Warlord` flags the warlord, `Name (+N pts)` is the enhancement.
 *
 * **Disjointness from the WTC matchers**: the GW format always carries `•`
 * bullets and never the WTC `N with` lines. wtc-full always has `N with` (so it
 * never collides), and wtc-compact never has bullets (its matcher now excludes
 * them). This adapter therefore matches on *bullets present* + *no `N with`*.
 *
 * The GW export carries no separate POINTS LIMIT line, so `declared_limit`
 * falls back to TOTAL ARMY POINTS (the round-trippable battle-size signal).
 *
 * @packageDocumentation
 */
import type { FormatAdapter } from "./adapter.js";
import type { ParsedRoster, ParsedUnit, ParsedWargear } from "./types.js";
import {
  factionFromKeyword,
  inferBattleSizeRaw,
  stripParenthetical,
} from "./newrecruit-text.js";

const FACTION_KEYWORD_PREFIX = "+ FACTION KEYWORD:";

const HEADER_FIELDS = {
  faction: /^\+\s*FACTION KEYWORD:\s*(.+?)\s*$/i,
  detachment: /^\+\s*DETACHMENT:\s*(.+?)\s*$/i,
  disposition: /^\+\s*(?:FORCE DISPOSITION|DISPO):\s*(.+?)\s*$/i,
  totalPoints: /^\+\s*TOTAL ARMY POINTS:\s*(\d+)\s*pts?\s*$/i,
} as const;

const FENCE = /^\++\s*$/;
const HEADER_LINE = /^\+/;
const SECTION_HEADER = /^[A-Z][A-Z0-9 \-/&]+$/; // BATTLELINE, ALLIED UNITS, …
const UNIT_HEADER = /^(.+?)\s*\(\s*(\d+)\s*(?:pts?|points?)\s*\)\s*$/i;
const BULLET_LINE = /^(\s*)([•◦])\s*(.+?)\s*$/u;
const NX_PREFIX = /^(\d+)x\s+(.+)$/;
const ENHANCEMENT_ANNOT = /^(.+?)\s*\(\+\s*(\d+)\s*pts?\s*\)\s*$/i;
const WITH_LINE = /^[\t ]*\d+\s+with\b/m;
const BULLET = /^[\t ]*•/mu;
const EMBEDDED_APP_BATTLE_SIZE =
  /^\s*(?:Combat Patrol|Incursion|Strike Force|Onslaught)\s*\(\s*[\d.,]+\s*Points?\s*\)\s*$/im;
const WTC_COMPACT_UNIT =
  /^(?:Char\d+:\s*)?\d+x\s+.+?\(\s*\d+\s*pts?\s*\)\s*:/im;

const ALLIED_SECTION = "ALLIED UNITS";
const CHARACTERS_SECTION = "CHARACTERS";
const CHARACTER_SUFFIX = " Character";
const WARLORD_MARKER = "Warlord";

/** Accept the input only when it carries the FACTION KEYWORD summary header,
 * has `•` bullets, and lacks the WTC `N with` body lines. */
function isGwText(decoded: unknown): string | null {
  if (typeof decoded !== "string") return null;
  if (!decoded.includes(FACTION_KEYWORD_PREFIX)) return null;
  if (!BULLET.test(decoded)) return null;
  if (WITH_LINE.test(decoded)) return null; // that's wtc-full
  if (WTC_COMPACT_UNIT.test(decoded)) return null;
  // BCP sometimes wraps a complete modern GW app export in the older `+`
  // summary fence. The body then carries its own faction/detachment/battle-size
  // preamble and belongs to gw-headerless, which strips the wrapper before
  // parsing. Claiming it here would parse zero units because this dialect uses
  // `Points`, not the framed format's `pts`.
  if (EMBEDDED_APP_BATTLE_SIZE.test(decoded)) return null;
  return decoded;
}

interface GwHeader {
  name: string;
  faction_raw_name: string | null;
  detachment_raw_name: string | null;
  force_disposition_raw_name: string | null;
  total_reported: number | null;
  declared_limit: number | null;
  battle_size_raw: string | null;
}

function parseHeader(lines: string[]): { header: GwHeader; bodyStart: number } | null {
  let faction_raw_name: string | null = null;
  let detachment_raw_name: string | null = null;
  let total_reported: number | null = null;
  let force_disposition_raw_name: string | null = null;

  const fenceIndices: number[] = [];
  for (let i = 0; i < lines.length && fenceIndices.length < 2; i += 1) {
    if (FENCE.test(lines[i])) fenceIndices.push(i);
  }

  let sawFactionKeyword = false;
  for (const line of lines) {
    if (!line.startsWith("+")) continue;
    const factionMatch = HEADER_FIELDS.faction.exec(line);
    if (factionMatch) {
      faction_raw_name = factionFromKeyword(factionMatch[1]);
      sawFactionKeyword = true;
      continue;
    }
    const detMatch = HEADER_FIELDS.detachment.exec(line);
    if (detMatch) {
      detachment_raw_name = stripParenthetical(detMatch[1]);
      continue;
    }
    const dispositionMatch = HEADER_FIELDS.disposition.exec(line);
    if (dispositionMatch) {
      force_disposition_raw_name = dispositionMatch[1];
      continue;
    }
    const ptsMatch = HEADER_FIELDS.totalPoints.exec(line);
    if (ptsMatch) {
      total_reported = Number.parseInt(ptsMatch[1], 10);
    }
  }

  if (!sawFactionKeyword) return null;

  const bodyStart = fenceIndices.length >= 2 ? fenceIndices[1] + 1 : 0;
  // The GW export has no POINTS LIMIT line — only TOTAL ARMY POINTS. Use it as
  // the declared limit so the inferred battle size stays round-trippable.
  const declared_limit = total_reported;
  return {
    header: {
      name: "Imported roster",
      faction_raw_name,
      detachment_raw_name,
      force_disposition_raw_name,
      total_reported,
      declared_limit,
      battle_size_raw: inferBattleSizeRaw(declared_limit),
    },
    bodyStart,
  };
}

interface Bullet {
  indent: number;
  count: number | null;
  text: string;
}

interface UnitAcc {
  raw_name: string;
  displayed_pts: number | null;
  section: string | null;
  bullets: Bullet[];
}

function finishUnit(acc: UnitAcc): ParsedUnit {
  const topIndent = acc.bullets.length
    ? Math.min(...acc.bullets.map((b) => b.indent))
    : 0;

  const wargear = new Map<string, number>();
  let model_count = 0;
  let is_warlord = false;
  let is_character = acc.section === CHARACTERS_SECTION;
  let enhancement_raw_name: string | null = null;
  let enhancement_points: number | null = null;

  const addWargear = (raw_name: string, count: number): void => {
    wargear.set(raw_name, (wargear.get(raw_name) ?? 0) + count);
  };

  for (let i = 0; i < acc.bullets.length; i += 1) {
    const b = acc.bullets[i];

    // A child bullet (deeper than the unit's top level) is a model group's
    // weapon — its `Nx` count is already the squad-wide total.
    if (b.indent > topIndent) {
      if (b.count !== null) addWargear(b.text, b.count);
      continue;
    }

    // Top-level annotation (no `Nx` count): enhancement / character / warlord.
    if (b.count === null) {
      const enh = ENHANCEMENT_ANNOT.exec(b.text);
      if (enh) {
        if (enhancement_raw_name === null) {
          enhancement_raw_name = enh[1].trim();
          enhancement_points = Number.parseInt(enh[2], 10);
        }
        continue;
      }
      for (const token of b.text.split(",").map((s) => s.trim()).filter(Boolean)) {
        if (token === WARLORD_MARKER) is_warlord = true;
        else if (token.endsWith(CHARACTER_SUFFIX)) is_character = true;
      }
      continue;
    }

    // Top-level `Nx` bullet: a model group when it has child bullets beneath
    // it, otherwise plain wargear.
    const next = acc.bullets[i + 1];
    if (next && next.indent > topIndent) {
      model_count += b.count;
    } else {
      addWargear(b.text, b.count);
    }
  }

  if (model_count === 0) model_count = 1;

  // The GW unit header points include the enhancement; back it out to the base.
  const displayed = acc.displayed_pts;
  const points =
    displayed === null
      ? null
      : enhancement_points !== null
        ? displayed - enhancement_points
        : displayed;

  const wargearList: ParsedWargear[] = [];
  for (const [raw_name, count] of wargear) wargearList.push({ raw_name, count });

  return {
    raw_name: acc.raw_name,
    is_character,
    model_count,
    points,
    is_warlord,
    enhancement_raw_name,
    enhancement_points,
    wargear: wargearList,
  };
}

function parseBody(lines: string[], bodyStart: number): {
  units: ParsedUnit[];
  multi_force: boolean;
} {
  const units: ParsedUnit[] = [];
  let current: UnitAcc | null = null;
  let section: string | null = null;
  let alliedUnits = 0;

  const finalize = (): void => {
    if (current) {
      units.push(finishUnit(current));
      current = null;
    }
  };

  for (let i = bodyStart; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || FENCE.test(line) || HEADER_LINE.test(line)) continue;

    const bulletMatch = BULLET_LINE.exec(raw);
    if (bulletMatch) {
      if (current) {
        const indent = bulletMatch[1].length + (bulletMatch[2] === "◦" ? 1 : 0);
        const rest = bulletMatch[3];
        const nx = NX_PREFIX.exec(rest);
        current.bullets.push({
          indent,
          count: nx ? Number.parseInt(nx[1], 10) : null,
          text: (nx ? nx[2] : rest).trim(),
        });
      }
      continue;
    }

    // A plain `Nx …` line with no `•` bullet is still that unit's wargear: the
    // GW app bullets only the first wargear entry per unit and emits the rest
    // unbulleted. Feed it through the same top-level-bullet path so it lands in
    // the unit's wargear. A unit header also lacks a bullet but carries a
    // `(N pts)` parenthetical, so it is excluded here and handled just below.
    const nxMatch = NX_PREFIX.exec(line);
    if (current && nxMatch && !UNIT_HEADER.test(line)) {
      current.bullets.push({
        indent: 0,
        count: Number.parseInt(nxMatch[1], 10),
        text: nxMatch[2].trim(),
      });
      continue;
    }

    const unitMatch = UNIT_HEADER.exec(line);
    if (unitMatch) {
      finalize();
      current = {
        raw_name: unitMatch[1].trim(),
        displayed_pts: Number.parseInt(unitMatch[2], 10),
        section,
        bullets: [],
      };
      if (section === ALLIED_SECTION) alliedUnits += 1;
      continue;
    }

    if (SECTION_HEADER.test(line)) {
      finalize();
      section = line;
    }
  }

  finalize();
  return { units, multi_force: alliedUnits > 0 };
}

export const gwAdapter: FormatAdapter = {
  id: "gw",

  matches(decoded: unknown): boolean {
    return isGwText(decoded) !== null;
  },

  parse(decoded: unknown): ParsedRoster {
    const text = isGwText(decoded);
    if (text === null) throw new Error("gw: input is not a GW app text export");

    const lines = text.split(/\r?\n/);
    const parsed = parseHeader(lines);
    if (!parsed) throw new Error('gw: missing "+ FACTION KEYWORD:" header');
    const { header, bodyStart } = parsed;

    const { units, multi_force } = parseBody(lines, bodyStart);

    let total_computed = 0;
    for (const u of units) {
      total_computed += u.points ?? 0;
      total_computed += u.enhancement_points ?? 0;
    }

    return {
      name: header.name,
      generated_by: null,
      faction_raw_name: header.faction_raw_name,
      detachment_raw_names: header.detachment_raw_name ? [header.detachment_raw_name] : [],
      force_disposition_raw_name: header.force_disposition_raw_name,
      battle_size_raw: header.battle_size_raw,
      declared_limit: header.declared_limit,
      total_reported: header.total_reported,
      total_computed,
      units,
      multi_force,
    };
  },
};

// Internals re-exported for unit tests.
export const _internals = {
  isGwText,
  parseHeader,
  parseBody,
};
