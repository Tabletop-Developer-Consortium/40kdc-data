/**
 * NewRecruit wtc-compact and wtc-full text exporters.
 *
 * Both formats lead with a `++++++++` summary header and then list units. The
 * compact body packs each unit onto one line; the full body uses section
 * headers (`BATTLELINE` / `ALLIED UNITS`) and two-line unit blocks with
 * `N with <wargear>` and `• Nx <ModelType>` per-model breakdowns.
 *
 * Faction & detachment display names are reconstructed via
 * {@link titleCaseId}. `CharN:` numbering is re-derived heuristically from
 * `is_warlord || enhancement || leader_attachment` (see
 * {@link charSlotAssignment}). The `+ SECONDARY:` summary line is omitted —
 * tournament secondaries aren't modelled in the Roster.
 *
 * @packageDocumentation
 */
import type { Roster, RosterUnit } from "../import/types.js";
import {
  charSlotAssignment,
  displayedUnitPoints,
  titleCaseId,
  totalArmyPoints,
} from "./helpers.js";
import type { RosterSerializer } from "./serializer.js";

export const FENCE = "+++++++++++++++++++++++++++++++++++++++++++++++";

function wargearListText(unit: RosterUnit, includeWarlordTag: boolean): string {
  const parts: string[] = [];
  for (const w of unit.wargear) {
    parts.push(w.count > 1 ? `${w.count}x ${w.ref.raw_name}` : w.ref.raw_name);
  }
  if (includeWarlordTag && unit.is_warlord) parts.push("Warlord");
  return parts.join(", ");
}

function header(roster: Roster, units: readonly RosterUnit[], charSlots: readonly (number | null)[]): string {
  const faction = titleCaseId(roster.faction_id) ?? "Unknown";
  const detachment = roster.detachments.length
    ? roster.detachments.map((d) => titleCaseId(d.ref.id) ?? d.ref.raw_name).join(", ")
    : null;
  const limit = roster.points.declared_limit ?? totalArmyPoints(roster);
  const total = roster.points.total_reported ?? totalArmyPoints(roster);

  const warlordIdx = units.findIndex((u) => u.is_warlord);
  const warlord =
    warlordIdx >= 0
      ? `Char${charSlots[warlordIdx]}: ${units[warlordIdx].ref.raw_name}`
      : "—";

  const enhancementIdx = units.findIndex((u) => u.enhancement !== null);
  let enhancement = "—";
  if (enhancementIdx >= 0) {
    const u = units[enhancementIdx];
    enhancement = `${u.enhancement!.raw_name} (on Char${charSlots[enhancementIdx]}: ${u.ref.raw_name})`;
  }

  const lines: string[] = [
    FENCE,
    `+ LIST NAME: ${roster.name}`,
    `+ FACTION KEYWORD: ${faction}`,
    `+ DETACHMENT: ${detachment ?? "—"}`,
    `+ TOTAL ARMY POINTS: ${total}pts`,
    `+ POINTS LIMIT: ${limit}pts`,
    `+`,
    `+ WARLORD: ${warlord}`,
    `+ ENHANCEMENT: ${enhancement}`,
    `+ NUMBER OF UNITS: ${units.length}`,
    FENCE,
  ];
  return lines.join("\n");
}

function isAlliedUnit(u: RosterUnit, factionId: string | null): boolean {
  // Heuristic: the Roster doesn't tag allied units explicitly, but the
  // multi-force diagnostic + the fact that we only carry the primary faction
  // means non-primary-faction units aren't recognisable. The only fact we *do*
  // have is `leader_attachment` and warlord/enhancement (which mark primary
  // characters). For unit grouping in wtc-full we simply place everything in
  // BATTLELINE unless the Roster's multi-force flag suggests there's an allied
  // detachment. Since the flag is a diagnostic warning, not a per-unit tag,
  // wtc-full export collapses to a single BATTLELINE section.
  void u;
  void factionId;
  return false;
}

/**
 * The compact body — one line per unit, wargear inline — that follows the
 * summary header. Returned as the lines *after* the header (the leading `""`
 * separator included) so any header variant (WTC or ATC 2026) can prepend its
 * own block and join. Compact callers append a trailing newline.
 */
export function wtcCompactBodyLines(units: readonly RosterUnit[], slots: readonly (number | null)[]): string[] {
  const lines: string[] = [""];
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    const prefix = slots[i] !== null ? `Char${slots[i]}: ` : "";
    const pts = displayedUnitPoints(u);
    const ptsText = pts === null ? "" : `${pts} pts`;
    lines.push(`${prefix}${u.model_count}x ${u.ref.raw_name} (${ptsText}): ${wargearListText(u, true)}`);
    if (u.enhancement) {
      const enhText =
        u.enhancement_points === null
          ? `Enhancement: ${u.enhancement.raw_name}`
          : `Enhancement: ${u.enhancement.raw_name} (+${u.enhancement_points} pts)`;
      lines.push(enhText);
    }
  }
  return lines;
}

export const newRecruitWtcCompactSerializer: RosterSerializer = {
  id: "newrecruit-wtc-compact",

  serialize(roster: Roster): string {
    const units = roster.units;
    const slots = charSlotAssignment(units);
    return [header(roster, units, slots), ...wtcCompactBodyLines(units, slots)].join("\n") + "\n";
  },
};

/**
 * For a multi-model unit, render its wargear as `N with <per-model list>` when
 * the wargear divides evenly across models (the natural NewRecruit form).
 * Otherwise emit `1 with <full Nx counts>` so the counts round-trip exactly.
 */
function multiModelWithLine(u: RosterUnit): string {
  // Homogeneous when every weapon count divides cleanly by model_count.
  const divisible = u.wargear.every((w) => w.count % u.model_count === 0);
  if (divisible) {
    const perModel = u.wargear
      .map((w) => {
        const c = w.count / u.model_count;
        return c > 1 ? `${c}x ${w.ref.raw_name}` : w.ref.raw_name;
      })
      .filter((s) => s.length > 0);
    if (u.is_warlord) perModel.push("Warlord");
    return `${u.model_count} with ${perModel.join(", ")}`;
  }
  return `1 with ${wargearListText(u, true)}`;
}

/**
 * The full body — section headers plus two-line unit blocks — that follows the
 * summary header. Returned as the lines *after* the header (the leading `""`
 * separator included). Unlike compact, full callers do not append a trailing
 * newline.
 */
export function wtcFullBodyLines(
  units: readonly RosterUnit[],
  slots: readonly (number | null)[],
  factionId: string | null,
): string[] {
  const battlelineIdxs: number[] = [];
  const alliedIdxs: number[] = [];
  for (let i = 0; i < units.length; i += 1) {
    if (isAlliedUnit(units[i], factionId)) alliedIdxs.push(i);
    else battlelineIdxs.push(i);
  }

  const lines: string[] = ["", "BATTLELINE", ""];

  const emitUnit = (i: number): void => {
    const u = units[i];
    const prefix = slots[i] !== null ? `Char${slots[i]}: ` : "";
    const pts = displayedUnitPoints(u);
    const ptsText = pts === null ? "" : `${pts} pts`;
    lines.push(`${prefix}${u.model_count}x ${u.ref.raw_name} (${ptsText})`);

    if (u.model_count > 1) {
      lines.push(multiModelWithLine(u));
    } else {
      lines.push(`1 with ${wargearListText(u, true)}`);
    }

    if (u.enhancement) {
      const enhText =
        u.enhancement_points === null
          ? `Enhancement: ${u.enhancement.raw_name}`
          : `Enhancement: ${u.enhancement.raw_name} (+${u.enhancement_points} pts)`;
      lines.push(enhText);
    }
    lines.push("");
  };

  for (const i of battlelineIdxs) emitUnit(i);

  if (alliedIdxs.length > 0) {
    lines.push("ALLIED UNITS", "");
    for (const i of alliedIdxs) emitUnit(i);
  }

  return lines;
}

export const newRecruitWtcFullSerializer: RosterSerializer = {
  id: "newrecruit-wtc-full",

  serialize(roster: Roster): string {
    const units = roster.units;
    const slots = charSlotAssignment(units);
    return [header(roster, units, slots), ...wtcFullBodyLines(units, slots, roster.faction_id)].join("\n");
  },
};
