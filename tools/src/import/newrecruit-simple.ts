/**
 * NewRecruit "simple" markdown-ish text adapter.
 *
 * Shape:
 * ```
 * <breadcrumb> - <faction> - <list name> - [N pts]
 *
 * # ++ Army Roster ++ [N pts]
 * ## Configuration
 * Battle Size: <Label>
 * Detachment: <Name>
 * Show/Hide Options: ...
 *
 * ## <Section> [N pts]
 * <Unit> [N pts]: <wargear>
 * <Unit> [N pts]:
 * • <count>x <ModelType>[ [N pts]]: <wargear>
 * ```
 *
 * Enhancements are inlined in the wargear list as `<Name> [N pts]` — the only
 * wargear token wearing a `[…]` pts suffix. `Warlord` and the detachment
 * "<X> Character" keyword are also stripped from the list and set as flags.
 * Per-model-type breakdowns under `•` lines are collapsed onto the parent unit.
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
import { classifyWargearList, splitWargearList, stripParenthetical } from "./newrecruit-text.js";

// Point brackets may carry comma-separated faction resources after the pts
// figure (e.g. `[4485pts, 29Cabal Points]`); the tail is recognized and
// discarded — only the pts figure is consumed.
const FIRST_LINE = /^(.+)\s-\s\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\]\s*$/i;
const ROSTER_HEADER =
  /^#\s*\+\+\s*Army Roster\s*\+\+\s*\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\]\s*$/i;
const SECTION_HEADER = /^##\s*(.+?)(?:\s*\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\])?\s*$/;
const UNIT_LINE = /^(.+?)\s*\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\](?:\s*:\s*(.*))?$/i;
const BULLET =
  /^\s*•\s*(\d+)x\s+(.+?)(?:\s*\[\s*(\d+)\s*pts?\s*(?:,[^\]]*)?\])?(?:\s*:\s*(.*))?\s*$/u;
const UNIT_TOTAL_PREFIX = /^Unit total:\s*/i;
const ATTACHMENT_TOKEN =
  /^Attachment:\s*(leader|support)\s*->\s*(.+?)(\s+\[provisional\])?$/i;

interface UnitBuilder {
  raw_name: string;
  is_character: boolean;
  is_warlord: boolean;
  keyword_overrides: Set<string>;
  enhancement_raw_name: string | null;
  enhancement_pts: number | null;
  displayed_pts: number | null;
  model_count: number;
  leader_attachment: ParsedLeaderAttachment | null;
  loadout_groups: {
    model_name: string | null;
    count: number;
    wargear: ParsedWargear[];
  }[];
  /** Aggregated wargear, keyed by name. Counts sum across `• Nx ModelType` breakdowns. */
  wargear: Map<string, number>;
}

function newUnit(name: string, displayed_pts: number | null): UnitBuilder {
  return {
    raw_name: name,
    is_character: false,
    is_warlord: false,
    keyword_overrides: new Set(),
    enhancement_raw_name: null,
    enhancement_pts: null,
    displayed_pts,
    model_count: 1,
    leader_attachment: null,
    loadout_groups: [],
    wargear: new Map(),
  };
}

function addWargear(unit: UnitBuilder, items: ParsedWargear[]): void {
  for (const { raw_name, count } of items) {
    unit.wargear.set(raw_name, (unit.wargear.get(raw_name) ?? 0) + count);
  }
}

function applyTokens(unit: UnitBuilder, tokensCsv: string, multiplier = 1): ParsedWargear[] {
  const wargearTokens: string[] = [];
  for (const token of splitWargearList(tokensCsv)) {
    const attachment = ATTACHMENT_TOKEN.exec(token);
    if (attachment) {
      unit.leader_attachment = {
        role: attachment[1].toLowerCase() as "leader" | "support",
        bodyguard_raw_name: attachment[2],
        provisional: attachment[3] !== undefined,
      };
    } else {
      wargearTokens.push(token);
    }
  }
  const cls = classifyWargearList(wargearTokens);
  if (cls.is_warlord) unit.is_warlord = true;
  if (cls.is_character) unit.is_character = true;
  for (const keyword of cls.keyword_overrides) unit.keyword_overrides.add(keyword);
  if (cls.enhancement_raw_name && unit.enhancement_raw_name === null) {
    unit.enhancement_raw_name = cls.enhancement_raw_name;
    unit.enhancement_pts = cls.enhancement_points;
  }
  addWargear(
    unit,
    cls.wargear.map((w) => ({
      raw_name: w.raw_name,
      count: w.count * multiplier,
    })),
  );
  return cls.wargear;
}

function finishUnit(unit: UnitBuilder): ParsedUnit {
  const points =
    unit.displayed_pts === null
      ? null
      : unit.displayed_pts - (unit.enhancement_pts ?? 0);
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
    wargear: [...unit.wargear].map(([raw_name, count]) => ({ raw_name, count })),
    ...(unit.loadout_groups.length > 0
      ? { loadout_groups: unit.loadout_groups }
      : {}),
  };
}

function parseFirstLine(line: string): { name: string; faction: string | null; declared_limit: number | null } | null {
  const m = FIRST_LINE.exec(line);
  if (!m) return null;
  const declared_limit = Number.parseInt(m[2], 10);
  const parts = m[1].split(" - ").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const list_name = parts[parts.length - 1];
  const faction = parts.length >= 2 ? parts[parts.length - 2] : null;
  return { name: list_name, faction, declared_limit };
}

type Section = "preamble" | "configuration" | "units";

export const newRecruitSimpleAdapter: FormatAdapter = {
  id: "newrecruit-simple",

  matches(decoded: unknown): boolean {
    if (typeof decoded !== "string") return false;
    const lines = decoded.split(/\r?\n/);
    const firstNonBlank = lines.find((l) => l.trim().length > 0);
    if (!firstNonBlank) return false;
    if (!FIRST_LINE.test(firstNonBlank)) return false;
    // Some exports omit the `# ++ Army Roster ++` line and open straight with
    // a `## Section` heading — accept either marker.
    return (
      /^#\s*\+\+\s*Army Roster\s*\+\+/m.test(decoded) ||
      /^##\s+/m.test(decoded)
    );
  },

  parse(decoded: unknown): ParsedRoster {
    if (typeof decoded !== "string") {
      throw new Error("newrecruit-simple: input is not a string");
    }
    const lines = decoded.split(/\r?\n/);

    let name = "Imported roster";
    let faction_raw_name: string | null = null;
    let declared_limit: number | null = null;
    let total_reported: number | null = null;
    const detachment_raw_names: string[] = [];
    let battle_size_raw: string | null = null;
    let force_disposition_raw_name: string | null = null;
    const units: ParsedUnit[] = [];
    let current: UnitBuilder | null = null;
    let multi_force = false;
    let section: Section = "preamble";
    const enhancementPts: (number | null)[] = [];

    const finalize = (): void => {
      if (current) {
        enhancementPts.push(current.enhancement_pts);
        units.push(finishUnit(current));
        current = null;
      }
    };

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const line = raw.trim();
      if (!line) continue;

      // First non-blank line carries `<breadcrumb> - <faction> - <list> - [N pts]`.
      if (section === "preamble" && name === "Imported roster") {
        const first = parseFirstLine(line);
        if (first) {
          name = first.name;
          faction_raw_name = first.faction;
          declared_limit = first.declared_limit;
          continue;
        }
      }

      const rosterMatch = ROSTER_HEADER.exec(line);
      if (rosterMatch) {
        total_reported = Number.parseInt(rosterMatch[1], 10);
        continue;
      }

      const sectionMatch = SECTION_HEADER.exec(line);
      if (sectionMatch) {
        finalize();
        const heading = sectionMatch[1].trim().toLowerCase();
        if (heading === "configuration") {
          section = "configuration";
        } else {
          section = "units";
          if (heading.includes("allied")) multi_force = true;
        }
        continue;
      }

      if (section === "configuration") {
        // Some exports list units directly after Configuration with no units
        // section heading; a `Name [N pts]` line ends the configuration block.
        if (UNIT_LINE.test(line)) {
          section = "units";
        } else {
          const idx = line.indexOf(":");
          if (idx > 0) {
            const key = line.slice(0, idx).trim().toLowerCase();
            const value = line.slice(idx + 1).trim();
            if (key === "battle size") battle_size_raw = value;
            else if (key === "list name") name = value;
            else if (key === "faction") faction_raw_name = value;
            else if (key === "force disposition") {
              force_disposition_raw_name = value;
            } else if (key === "detachment") {
              // Parenthetical suffixes ("(3 Detachment Points)") are
              // presentation, not part of the detachment name.
              detachment_raw_names.push(stripParenthetical(value));
            }
          }
          continue;
        }
      }

      // Unit section. A bullet line extends the *current* unit.
      const bulletMatch = BULLET.exec(raw);
      if (bulletMatch && current) {
        const count = Number.parseInt(bulletMatch[1], 10);
        // Bullets may add to the unit's model count beyond the implicit 1 we
        // set when we created it from the unit header.
        if (current.wargear.size === 0 && current.model_count === 1) {
          // First bullet: replace the implicit single-model assumption.
          current.model_count = count;
        } else {
          current.model_count += count;
        }
        if (bulletMatch[4]) {
          const unitTotal = UNIT_TOTAL_PREFIX.test(bulletMatch[4]);
          const groupWargear = applyTokens(
            current,
            bulletMatch[4].replace(UNIT_TOTAL_PREFIX, ""),
            unitTotal ? 1 : count,
          );
          if (!unitTotal) {
            current.loadout_groups.push({
              model_name: bulletMatch[2].trim(),
              count,
              wargear: groupWargear,
            });
          }
        }
        continue;
      }

      const unitMatch = UNIT_LINE.exec(line);
      if (unitMatch) {
        finalize();
        const unitName = unitMatch[1].trim();
        const pts = Number.parseInt(unitMatch[2], 10);
        current = newUnit(unitName, pts);
        const inlineWargear = unitMatch[3]?.trim() ?? "";
        if (inlineWargear.length > 0) {
          applyTokens(current, inlineWargear, 1);
        }
        // Leave model_count at the default 1. If `•` bullet lines follow, the
        // bullet handler resets model_count to the (summed) bullet counts.
        continue;
      }
    }
    finalize();

    let total_computed = 0;
    for (let i = 0; i < units.length; i += 1) {
      total_computed += units[i].points ?? 0;
      total_computed += enhancementPts[i] ?? 0;
    }

    return {
      name,
      generated_by: null,
      faction_raw_name,
      detachment_raw_names,
      battle_size_raw,
      force_disposition_raw_name,
      declared_limit,
      total_reported,
      total_computed,
      units,
      multi_force,
    };
  },
};
