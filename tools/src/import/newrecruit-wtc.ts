/**
 * NewRecruit "wtc-compact" and "wtc-full" text adapters.
 *
 * Both formats open with a `++++++++` summary header carrying FACTION KEYWORD,
 * DETACHMENT, TOTAL ARMY POINTS, WARLORD, ENHANCEMENT(s), NUMBER OF UNITS, and
 * SECONDARY tournament-objective shorthand. The body diverges:
 *
 * - **wtc-compact** — one unit per line:
 *   `[CharN: ]Nx <Unit> (P pts): <comma-separated wargear>`
 *   followed optionally by `Enhancement: <Name> (+P pts)` on the next line.
 *
 * - **wtc-full** — uppercase section headers (`BATTLELINE`, `ALLIED UNITS`),
 *   two-line unit blocks (`[CharN: ]Nx <Unit> (P pts)` then `N with <wargear>`),
 *   `Enhancement: <Name> (+P pts)` on its own line, and per-model-type
 *   breakdowns with `• Nx <ModelType>` + indented `N with <wargear>` lines.
 *   Real exports also mix in compact-style lines: single-model units arrive as
 *   `[CharN: ]Nx <Unit> (P pts): <wargear>` on one line, and a model-type
 *   bullet may inline its loadout after a colon (`• 1x Champion: Chainblades`,
 *   `• 5x Eightbound: 5 with Chainblades`). The full-body parser accepts all
 *   of these.
 *
 * The {@link Roster} pivot stores units at unit granularity — per-model-type
 * wargear breakdowns and `CharN:` slot numbers aren't modelled, so this adapter
 * collapses them: the parsed unit's `model_count` is summed from the breakdown
 * and its `wargear` is the union of every loadout under it. The `WARLORD` /
 * `Houndpack Lance Character` tokens are stripped from the wargear list (and
 * set `is_warlord`/`is_character` instead) so resolution doesn't try to look
 * them up as weapons. Round-trips are at Roster level, not byte-for-byte.
 *
 * Enhancement points (`+15 pts`) are subtracted from the displayed unit total
 * so `ParsedUnit.points` is the *base* unit cost — matching the ListForge
 * convention where the unit's own cost line is base and the enhancement is a
 * sibling cost line. `total_computed` walks every cost line just like ListForge
 * (base unit pts + each enhancement pts).
 *
 * @packageDocumentation
 */
import type { FormatAdapter } from "./adapter.js";
import type {
  ParsedLeaderAttachment,
  ParsedRoster,
  ParsedUnit,
  ParsedWargear,
} from "./types.js";
import {
  classifyWargearList,
  factionFromKeyword,
  inferBattleSizeRaw,
  splitWargearList,
  stripParenthetical,
} from "./newrecruit-text.js";

const WTC_HEADER_PREFIX = "+ FACTION KEYWORD:";

// --- header parsing ---------------------------------------------------------

interface WtcHeader {
  name: string;
  faction_raw_name: string | null;
  detachment_raw_names: string[];
  force_disposition_raw_name: string | null;
  declared_limit: number | null;
  total_reported: number | null;
  battle_size_raw: string | null;
}

const HEADER_FIELDS = {
  faction: /^\+\s*FACTION KEYWORD:\s*(.+?)\s*$/i,
  detachment: /^\+\s*DETACHMENT:\s*(.+?)\s*$/i,
  disposition: /^\+\s*FORCE DISPOSITION:\s*(.+?)\s*$/i,
  totalPoints: /^\+\s*TOTAL ARMY POINTS:\s*(\d+)\s*pts?\s*$/i,
  pointsLimit: /^\+\s*POINTS LIMIT:\s*(\d+)\s*pts?\s*$/i,
  listName: /^\+\s*LIST NAME:\s*(.+?)\s*$/i,
} as const;

/** Parse the leading `++++ ... ++++` block. Returns `null` if no header is found. */
function parseWtcHeader(text: string): { header: WtcHeader; bodyStart: number } | null {
  const lines = text.split(/\r?\n/);
  let faction_raw_name: string | null = null;
  const detachment_raw_names: string[] = [];
  let force_disposition_raw_name: string | null = null;
  let totalReported: number | null = null;
  let pointsLimit: number | null = null;
  let listName: string | null = null;

  // Two `+++++…` fence lines wrap the header. Find them.
  const fenceIndices: number[] = [];
  for (let i = 0; i < lines.length && fenceIndices.length < 2; i += 1) {
    if (/^\++\s*$/.test(lines[i])) fenceIndices.push(i);
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
      const name = stripParenthetical(detMatch[1]);
      if (name !== "—") detachment_raw_names.push(name);
      continue;
    }
    const dispMatch = HEADER_FIELDS.disposition.exec(line);
    if (dispMatch) {
      force_disposition_raw_name = dispMatch[1];
      continue;
    }
    const ptsMatch = HEADER_FIELDS.totalPoints.exec(line);
    if (ptsMatch) {
      totalReported = Number.parseInt(ptsMatch[1], 10);
      continue;
    }
    const limitMatch = HEADER_FIELDS.pointsLimit.exec(line);
    if (limitMatch) {
      pointsLimit = Number.parseInt(limitMatch[1], 10);
      continue;
    }
    const nameMatch = HEADER_FIELDS.listName.exec(line);
    if (nameMatch) {
      listName = nameMatch[1];
    }
  }

  if (!sawFactionKeyword) return null;

  const bodyStart = fenceIndices.length >= 2 ? fenceIndices[1] + 1 : 0;
  // POINTS LIMIT — the round-trip-friendly companion to TOTAL ARMY POINTS —
  // is the army's points ceiling. When the source carries only a single
  // figure (the tournament default), fall back to it.
  const declared_limit = pointsLimit ?? totalReported;
  const battle_size_raw = inferBattleSizeRaw(declared_limit);

  return {
    header: {
      name: listName ?? "Imported roster",
      faction_raw_name,
      detachment_raw_names,
      force_disposition_raw_name,
      declared_limit,
      total_reported: totalReported,
      battle_size_raw,
    },
    bodyStart,
  };
}

// --- shared body helpers ----------------------------------------------------

const UNIT_HEADER_COMPACT =
  /^(?:Char\d+:\s*)?(\d+)x\s+(.+?)\s*\(\s*(\d+)\s*pts?\s*\)\s*:\s*(.*)$/i;
const UNIT_HEADER_FULL = /^(?:Char\d+:\s*)?(\d+)x\s+(.+?)\s*\(\s*(\d+)\s*pts?\s*\)\s*$/i;
const ENHANCEMENT_LINE =
  /^Enhancement:\s*(.+?)(?:\s*\(\+\s*(\d+)\s*pts?\s*\))?\s*$/i;
const ATTACHMENT_LINE =
  /^Attachment:\s*(leader|support)\s*->\s*(.+?)(\s+\[provisional\])?\s*$/i;
// The plain-text NewRecruit copy export (as opposed to the WTC-serialized
// `Attachment: leader -> X` line above) states the same pairing in prose on
// either end of the link: `Leading <bodyguard>` on the character's own block,
// or `  Attached to <character>` (indented, no bullet) on the bodyguard's
// block. Both are explicit — not inferred — so they're handled the same way
// as `ATTACHMENT_LINE`, not routed through resolve()'s support-only fallback.
const LEADING_LINE = /^Leading\s+(.+?)\s*$/i;
const ATTACHED_TO_LINE = /^Attached to\s+(.+?)\s*$/i;
const WITH_PREFIX = /^(\d+)\s+with\s+(.*)$/i;
// Optional trailing `: <wargear>` — NewRecruit inlines a model group's loadout
// after the model type (`• 1x Champion: Chainblades`, `• 5x Eightbound: 5 with
// Chainblades`) instead of always breaking it onto `N with` continuation lines.
const MODEL_BREAKDOWN =
  /^\s*•\s*(\d+)x\s+([^:]+?)(?:\s*\[[^\]]*\])?\s*(?::\s*(.+))?$/u;
const SECTION_HEADER = /^[A-Z][A-Z0-9 \-/&]+$/; // BATTLELINE, ALLIED UNITS, etc.
const HEADER_LINE = /^\+/;

/**
 * `N with X, Y, Z` means each of `N` models carries the same list — the weapon
 * counts in the list multiply by `N`. Returns `{multiplier:1, list:text}` when
 * the line has no `with` prefix.
 */
function parseWithGroup(text: string): { multiplier: number; list: string } {
  const m = WITH_PREFIX.exec(text);
  if (m) {
    const n = Number.parseInt(m[1], 10);
    return { multiplier: n > 0 ? n : 1, list: m[2] };
  }
  return { multiplier: 1, list: text };
}

interface UnitBuilder {
  raw_name: string;
  is_character: boolean;
  is_warlord: boolean;
  keyword_overrides: Set<string>;
  enhancement_raw_name: string | null;
  /** Total displayed pts from the header line; base computed once an enhancement is known. */
  displayed_pts: number | null;
  enhancement_pts: number | null;
  leader_attachment: ParsedLeaderAttachment | null;
  model_count: number;
  loadout_groups: {
    model_name: string | null;
    count: number;
    wargear: ParsedWargear[];
  }[];
  wargear: Map<string, number>;
}

function newUnit(name: string, displayed_pts: number, leading_count: number, is_character_prefix: boolean): UnitBuilder {
  return {
    raw_name: name,
    is_character: is_character_prefix,
    is_warlord: false,
    keyword_overrides: new Set(),
    enhancement_raw_name: null,
    displayed_pts,
    enhancement_pts: null,
    leader_attachment: null,
    model_count: leading_count > 0 ? leading_count : 1,
    loadout_groups: [],
    wargear: new Map(),
  };
}

function addWargear(unit: UnitBuilder, items: ParsedWargear[]): void {
  for (const { raw_name, count } of items) {
    unit.wargear.set(raw_name, (unit.wargear.get(raw_name) ?? 0) + count);
  }
}

function applyWithGroup(unit: UnitBuilder, listText: string, defaultMultiplier = 1): ParsedWargear[] {
  const parsedGroup = parseWithGroup(listText);
  const multiplier = WITH_PREFIX.test(listText) ? parsedGroup.multiplier : defaultMultiplier;
  const list = parsedGroup.list;
  const tokens = splitWargearList(list);
  const cls = classifyWargearList(tokens);
  if (cls.is_warlord) unit.is_warlord = true;
  if (cls.is_character) unit.is_character = true;
  for (const keyword of cls.keyword_overrides) unit.keyword_overrides.add(keyword);
  // wtc never inlines the enhancement points in the wargear list (that's the
  // simple format) but classifyWargearList silently absorbs it if it shows up;
  // wtc's enhancement is always parsed off the explicit "Enhancement:" line.
  addWargear(
    unit,
    cls.wargear.map((w) => ({ raw_name: w.raw_name, count: w.count * multiplier })),
  );
  return cls.wargear;
}

function finishUnit(unit: UnitBuilder): ParsedUnit {
  const displayed = unit.displayed_pts;
  const points = displayed === null ? null : displayed - (unit.enhancement_pts ?? 0);
  const wargear: ParsedWargear[] = [];
  for (const [raw_name, count] of unit.wargear) {
    wargear.push({ raw_name, count });
  }
  return {
    raw_name: unit.raw_name,
    is_character: unit.is_character,
    ...(unit.keyword_overrides.size
      ? { keyword_overrides: [...unit.keyword_overrides] }
      : {}),
    model_count: unit.model_count,
    points,
    is_warlord: unit.is_warlord,
    enhancement_raw_name: unit.enhancement_raw_name,
    enhancement_points:
      unit.enhancement_raw_name === null ? null : unit.enhancement_pts,
    leader_attachment: unit.leader_attachment,
    wargear,
    ...(unit.loadout_groups.length > 0
      ? { loadout_groups: unit.loadout_groups }
      : {}),
  };
}

/** Compute total_computed by walking every parsed unit cost line. */
function computeTotal(units: ParsedUnit[], enhancementPtsByIndex: (number | null)[]): number {
  let total = 0;
  for (let i = 0; i < units.length; i += 1) {
    total += units[i].points ?? 0;
    total += enhancementPtsByIndex[i] ?? 0;
  }
  return total;
}

function attachEnhancement(unit: UnitBuilder, raw_name: string, pts: number | null): void {
  unit.enhancement_raw_name = raw_name.trim();
  unit.enhancement_pts = pts;
}

/**
 * Resolve `Attached to <character>` refs collected while parsing (see
 * `pendingAttachedTo` in each body parser) against the fully-parsed unit
 * list. Only fills a gap left by an absent `Leading`/`Attachment:` line on
 * the character's own block — that signal already carries an explicit role
 * (leader/support) and takes precedence. `Attached to` alone doesn't state a
 * role, so it defaults to "leader" (the overwhelmingly common case; a
 * support character that *only* the bodyguard-side text names would be
 * mislabeled, a known best-effort limitation).
 */
function applyPendingAttachedTo(
  units: ParsedUnit[],
  pendingAttachedTo: { bodyguardRawName: string; characterRawName: string }[],
): void {
  for (const pending of pendingAttachedTo) {
    const character = units.find((u) => u.raw_name === pending.characterRawName);
    if (character && !character.leader_attachment) {
      character.leader_attachment = {
        role: "leader",
        bodyguard_raw_name: pending.bodyguardRawName,
        provisional: false,
      };
    }
  }
}

// --- compact body parser ----------------------------------------------------

function parseCompactBody(body: string): { units: ParsedUnit[]; enhancementPts: (number | null)[] } {
  const lines = body.split(/\r?\n/);
  const units: ParsedUnit[] = [];
  const enhancementPts: (number | null)[] = [];
  let current: UnitBuilder | null = null;
  // `Attached to <character>` names the character from the bodyguard's own
  // block, so it can't be resolved to `current.leader_attachment` inline (the
  // character unit may not exist yet). Deferred to a post-pass once every
  // unit has been parsed. Only fills a gap left by an absent `Leading` line —
  // see the post-pass below.
  const pendingAttachedTo: { bodyguardRawName: string; characterRawName: string }[] = [];

  const finalize = (): void => {
    if (current) {
      units.push(finishUnit(current));
      enhancementPts.push(current.enhancement_pts);
      current = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || HEADER_LINE.test(line) || /^\++$/.test(line)) continue;

    const enhMatch = ENHANCEMENT_LINE.exec(line);
    if (enhMatch && current) {
      attachEnhancement(
        current,
        enhMatch[1],
        enhMatch[2] ? Number.parseInt(enhMatch[2], 10) : null,
      );
      // Emit immediately so subsequent unit lines start fresh.
      finalize();
      continue;
    }
    const attachmentMatch = ATTACHMENT_LINE.exec(line);
    if (attachmentMatch && current) {
      current.leader_attachment = {
        role: attachmentMatch[1].toLowerCase() as "leader" | "support",
        bodyguard_raw_name: attachmentMatch[2],
        provisional: attachmentMatch[3] !== undefined,
      };
      continue;
    }
    const leadingMatch = LEADING_LINE.exec(line);
    if (leadingMatch && current) {
      current.leader_attachment = {
        role: "leader",
        bodyguard_raw_name: leadingMatch[1],
        provisional: false,
      };
      continue;
    }
    const attachedToMatch = ATTACHED_TO_LINE.exec(line);
    if (attachedToMatch && current) {
      pendingAttachedTo.push({ bodyguardRawName: current.raw_name, characterRawName: attachedToMatch[1] });
      continue;
    }
    const breakdown = MODEL_BREAKDOWN.exec(raw);
    if (breakdown && current) {
      const count = Number.parseInt(breakdown[1], 10);
      const groupWargear =
        breakdown[3] === undefined ? [] : applyWithGroup(current, breakdown[3], count);
      current.loadout_groups.push({
        model_name: breakdown[2].trim(),
        count,
        wargear: groupWargear,
      });
      continue;
    }


    const unitMatch = UNIT_HEADER_COMPACT.exec(line);
    if (unitMatch) {
      finalize();
      const leading_count = Number.parseInt(unitMatch[1], 10);
      const name = unitMatch[2].trim();
      const pts = Number.parseInt(unitMatch[3], 10);
      const is_character_prefix = /^Char\d+:/i.test(line);
      current = newUnit(name, pts, leading_count, is_character_prefix);
      applyWithGroup(current, unitMatch[4]);
      continue;
    }
  }

  finalize();
  applyPendingAttachedTo(units, pendingAttachedTo);
  return { units, enhancementPts };
}

// --- full body parser -------------------------------------------------------

function parseFullBody(body: string): { units: ParsedUnit[]; enhancementPts: (number | null)[] } {
  const lines = body.split(/\r?\n/);
  const units: ParsedUnit[] = [];
  const enhancementPts: (number | null)[] = [];
  let current: UnitBuilder | null = null;
  let breakdownModels = 0;
  let pendingBreakdown:
    | {
        model_name: string;
        count: number;
        assigned_count: number;
      }
    | null = null;
  // See `parseCompactBody`'s identical field for the rationale.
  const pendingAttachedTo: { bodyguardRawName: string; characterRawName: string }[] = [];

  // A full-format model bullet introduces a parent model type; every following
  // `N with` line is a separate exact subgroup of that parent. Delay an empty
  // fallback until its context closes, so repeated continuations do not get
  // collapsed onto the parent group's displayed count.
  const flushPendingBreakdown = (): void => {
    if (!current || !pendingBreakdown) return;
    const remaining = pendingBreakdown.count - pendingBreakdown.assigned_count;
    if (remaining > 0) {
      current.loadout_groups.push({
        model_name: pendingBreakdown.model_name,
        count: remaining,
        wargear: [],
      });
    }
    pendingBreakdown = null;
  };

  const finalize = (): void => {
    if (current) {
      flushPendingBreakdown();
      if (breakdownModels > 0) current.model_count = breakdownModels;
      units.push(finishUnit(current));
      enhancementPts.push(current.enhancement_pts);
      current = null;
      breakdownModels = 0;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || HEADER_LINE.test(line) || /^\++$/.test(line)) continue;
    if (SECTION_HEADER.test(line) && !UNIT_HEADER_FULL.test(line)) {
      finalize();
      continue;
    }

    const enhMatch = ENHANCEMENT_LINE.exec(line);
    if (enhMatch && current) {
      attachEnhancement(
        current,
        enhMatch[1],
        enhMatch[2] ? Number.parseInt(enhMatch[2], 10) : null,
      );
      continue;
    }
    const attachmentMatch = ATTACHMENT_LINE.exec(line);
    if (attachmentMatch && current) {
      current.leader_attachment = {
        role: attachmentMatch[1].toLowerCase() as "leader" | "support",
        bodyguard_raw_name: attachmentMatch[2],
        provisional: attachmentMatch[3] !== undefined,
      };
      continue;
    }
    const leadingMatch = LEADING_LINE.exec(line);
    if (leadingMatch && current) {
      current.leader_attachment = {
        role: "leader",
        bodyguard_raw_name: leadingMatch[1],
        provisional: false,
      };
      continue;
    }
    const attachedToMatch = ATTACHED_TO_LINE.exec(line);
    if (attachedToMatch && current) {
      pendingAttachedTo.push({ bodyguardRawName: current.raw_name, characterRawName: attachedToMatch[1] });
      continue;
    }


    const unitMatch = UNIT_HEADER_FULL.exec(line);
    if (unitMatch) {
      finalize();
      const leading_count = Number.parseInt(unitMatch[1], 10);
      const name = unitMatch[2].trim();
      const pts = Number.parseInt(unitMatch[3], 10);
      const is_character_prefix = /^Char\d+:/i.test(line);
      current = newUnit(name, pts, leading_count, is_character_prefix);
      continue;
    }

    // Single-model units (characters, vehicles) appear compact-style even in
    // full exports: `[CharN: ]Nx <Unit> (P pts): <wargear>` on one line.
    // Without this branch they fall through every matcher and vanish.
    const compactMatch = UNIT_HEADER_COMPACT.exec(line);
    if (compactMatch) {
      finalize();
      const leading_count = Number.parseInt(compactMatch[1], 10);
      const name = compactMatch[2].trim();
      const pts = Number.parseInt(compactMatch[3], 10);
      const is_character_prefix = /^Char\d+:/i.test(line);
      current = newUnit(name, pts, leading_count, is_character_prefix);
      applyWithGroup(current, compactMatch[4]);
      continue;
    }

    const breakdown = MODEL_BREAKDOWN.exec(raw);
    if (breakdown && current) {
      flushPendingBreakdown();
      const count = Number.parseInt(breakdown[1], 10);
      breakdownModels += count;
      const model_name = breakdown[2].trim();
      pendingBreakdown = { model_name, count, assigned_count: 0 };
      if (breakdown[3] !== undefined) {
        const groupWargear = applyWithGroup(current, breakdown[3], count);
        const { multiplier } = parseWithGroup(breakdown[3]);
        const groupCount = WITH_PREFIX.test(breakdown[3]) ? multiplier : count;
        current.loadout_groups.push({ model_name, count: groupCount, wargear: groupWargear });
        pendingBreakdown.assigned_count = groupCount;
      }
      continue;
    }

    if (WITH_PREFIX.test(line) && current) {
      const groupWargear = applyWithGroup(current, line);
      if (pendingBreakdown) {
        const { multiplier } = parseWithGroup(line);
        current.loadout_groups.push({
          model_name: pendingBreakdown.model_name,
          count: multiplier,
          wargear: groupWargear,
        });
        pendingBreakdown.assigned_count += multiplier;
      }
      continue;
    }
  }

  finalize();
  applyPendingAttachedTo(units, pendingAttachedTo);
  return { units, enhancementPts };
}

// --- multi-force detection --------------------------------------------------

/** Heuristic for `multi_force`: are there units with "ALLIED" decorating
 * the body? wtc-full has an explicit `ALLIED UNITS` section header; compact
 * has no section markers but the user-facing summary header counts every unit
 * together, so detect from explicit section presence. */
function detectMultiForce(text: string, format: "wtc-compact" | "wtc-full"): boolean {
  if (format === "wtc-full") {
    return /^ALLIED UNITS\s*$/im.test(text);
  }
  // wtc-compact has no section header. Multi-force surfaces only via the
  // primary-faction summary; assume single-force unless we add a richer marker.
  return false;
}

// --- adapters ---------------------------------------------------------------

function isWtcText(decoded: unknown): string | null {
  if (typeof decoded !== "string") return null;
  // Both wtc formats begin with the FACTION KEYWORD header line (possibly
  // after some leading whitespace/fence characters).
  if (!decoded.includes(WTC_HEADER_PREFIX)) return null;
  return decoded;
}

/** Distinguishes wtc-full from wtc-compact: full has a line starting with
 * `\d+ with ` at the start of a body line (compact only puts `N with` after
 * `:` on the same line as the unit header). */
function isFullFormat(text: string): boolean {
  return /^[\t ]*\d+\s+with\b/m.test(text);
}

/** `•`-prefixed body lines. wtc-full uses them for per-model breakdowns; the GW
 * app format uses them for every wargear entry. wtc-compact never emits them,
 * so it's the one matcher that must exclude them to stay disjoint from GW. */
function hasBullets(text: string): boolean {
  return /^[\t ]*•/mu.test(text);
}
function hasCompactUnit(text: string): boolean {
  return text.split(/\r?\n/).some((line) => UNIT_HEADER_COMPACT.test(line.trim()));
}

function isSerializedFullFormat(text: string): boolean {
  return /^\+\s*LIST NAME:/im.test(text) && /^BATTLELINE\s*$/m.test(text);
}

function parseWith(text: string, format: "wtc-compact" | "wtc-full"): ParsedRoster {
  const parsed = parseWtcHeader(text);
  if (!parsed) {
    throw new Error(`${format}: missing "+ FACTION KEYWORD:" header`);
  }
  const { header, bodyStart } = parsed;
  const body = text.split(/\r?\n/).slice(bodyStart).join("\n");
  const { units, enhancementPts } =
    format === "wtc-full" ? parseFullBody(body) : parseCompactBody(body);

  return {
    name: header.name,
    generated_by: null,
    faction_raw_name: header.faction_raw_name,
    detachment_raw_names: header.detachment_raw_names,
    force_disposition_raw_name: header.force_disposition_raw_name,
    battle_size_raw: header.battle_size_raw,
    declared_limit: header.declared_limit,
    total_reported: header.total_reported,
    total_computed: computeTotal(units, enhancementPts),
    units,
    multi_force: detectMultiForce(text, format),
  };
}

export const newRecruitWtcCompactAdapter: FormatAdapter = {
  id: "newrecruit-wtc-compact",

  matches(decoded: unknown): boolean {
    const text = isWtcText(decoded);
    if (text === null) return false;
    return !isFullFormat(text) && !isSerializedFullFormat(text) && hasCompactUnit(text);
  },

  parse(decoded: unknown): ParsedRoster {
    const text = isWtcText(decoded);
    if (text === null) throw new Error("newrecruit-wtc-compact: input is not a string");
    return parseWith(text, "wtc-compact");
  },
};

export const newRecruitWtcFullAdapter: FormatAdapter = {
  id: "newrecruit-wtc-full",

  matches(decoded: unknown): boolean {
    const text = isWtcText(decoded);
    if (text === null) return false;
    return isFullFormat(text) || isSerializedFullFormat(text);
  },

  parse(decoded: unknown): ParsedRoster {
    const text = isWtcText(decoded);
    if (text === null) throw new Error("newrecruit-wtc-full: input is not a string");
    return parseWith(text, "wtc-full");
  },
};
