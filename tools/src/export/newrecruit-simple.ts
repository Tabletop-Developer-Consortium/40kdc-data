/**
 * NewRecruit "simple" markdown-ish text exporter.
 *
 * Shape:
 * ```
 * <faction> - <list name> - [N pts]
 *
 * # ++ Army Roster ++ [N pts]
 * ## Configuration
 * Battle Size: <Label>
 * Detachment: <Name>
 *
 * ## Battleline [N pts]
 * <Unit> [pts]: <wargear, …, EnhName [N pts], …>
 * <Multi-Unit> [pts]:
 * • <Nx> <ModelType>: <wargear>
 * ```
 *
 * Enhancements are inlined as `Name [N pts]` (the only place we re-emit a
 * `[N pts]` bracket on a token).
 *
 * @packageDocumentation
 */
import type { Roster, RosterUnit } from "../import/types.js";
import { displayedUnitPoints, groupWeaponsText, titleCaseId, totalArmyPoints } from "./helpers.js";
import type { RosterSerializer } from "./serializer.js";

function battleSizeLabel(roster: Roster): string | null {
  if (roster.battle_size === "strike-force") {
    return `Strike Force (${roster.points.declared_limit ?? 2000} Point limit)`;
  }
  if (roster.battle_size === "incursion") {
    return `Incursion (${roster.points.declared_limit ?? 1000} Point limit)`;
  }
  return null;
}

/** Build the wargear list inline. For homogeneous multi-model units, divides
 * counts by model_count so the per-model render is clean. */
function wargearText(u: RosterUnit, perModelDivisor: number): string {
  const parts: string[] = [];
  if (u.enhancement) {
    const ptsTag = u.enhancement_points === null ? "" : ` [${u.enhancement_points} pts]`;
    parts.push(`${u.enhancement.raw_name}${ptsTag}`);
  }
  if (u.is_warlord) parts.push("Warlord");
  for (const w of u.wargear) {
    const c = perModelDivisor > 0 ? w.count / perModelDivisor : w.count;
    parts.push(c > 1 ? `${c}x ${w.ref.raw_name}` : w.ref.raw_name);
  }
  return parts.join(", ");
}

/** Unit-level tokens that lead the first wargear line: the enhancement then `Warlord`. */
function leadTokens(u: RosterUnit): string[] {
  const parts: string[] = [];
  if (u.enhancement) {
    const ptsTag = u.enhancement_points === null ? "" : ` [${u.enhancement_points} pts]`;
    parts.push(`${u.enhancement.raw_name}${ptsTag}`);
  }
  if (u.is_warlord) parts.push("Warlord");
  return parts;
}

function unitText(u: RosterUnit): string[] {
  const pts = displayedUnitPoints(u);
  const ptsText = pts === null ? "" : `${pts} pts`;

  if (u.model_count <= 1) {
    return [`${u.ref.raw_name} [${ptsText}]: ${wargearText(u, 1)}`];
  }
  // Multi-model with an exact per-model breakdown: one bullet per model-type group,
  // each named, with the enhancement/Warlord tokens leading the first group.
  if (u.loadout_groups && u.loadout_groups.length > 0) {
    const lead = leadTokens(u);
    const lines = [`${u.ref.raw_name} [${ptsText}]:`];
    u.loadout_groups.forEach((g, i) => {
      const name = g.model_name ?? u.ref.raw_name;
      const tokens = [...(i === 0 ? lead : []), groupWeaponsText(g.wargear)].filter((s) => s.length > 0);
      lines.push(`• ${g.count}x ${name}: ${tokens.join(", ")}`);
    });
    return lines;
  }
  // No exact breakdown: homogeneous units divide cleanly; otherwise a single bullet
  // with the full counts (the legacy fallback, unit-named).
  const divisor = u.wargear.every((w) => w.count % u.model_count === 0) ? u.model_count : 1;
  return [
    `${u.ref.raw_name} [${ptsText}]:`,
    `• ${u.model_count}x ${u.ref.raw_name}: ${wargearText(u, divisor)}`,
  ];
}

export const newRecruitSimpleSerializer: RosterSerializer = {
  id: "newrecruit-simple",

  serialize(roster: Roster): string {
    const faction = titleCaseId(roster.faction_id) ?? "Unknown";
    const detachments = roster.detachments.map((d) => titleCaseId(d.ref.id) ?? d.ref.raw_name);
    const battle = battleSizeLabel(roster);
    const total = totalArmyPoints(roster);

    const lines: string[] = [];
    // First line carries the *declared limit* (the army's points ceiling); the
    // `# ++ Army Roster ++` line carries the *reported total*. They differ
    // when the list isn't filled to the cap.
    const limit = roster.points.declared_limit ?? total;
    lines.push(`${faction} - ${roster.name} - [${limit} pts]`);
    lines.push("");
    lines.push(`# ++ Army Roster ++ [${total} pts]`);
    lines.push("## Configuration");
    if (battle) lines.push(`Battle Size: ${battle}`);
    for (const detachment of detachments) lines.push(`Detachment: ${detachment}`);
    lines.push("");

    // The Roster doesn't tag allied vs. battleline per unit; emit one section.
    const sectionTotal = roster.units.reduce(
      (acc, u) => acc + (u.points ?? 0) + (u.enhancement_points ?? 0),
      0,
    );
    lines.push(`## Battleline [${sectionTotal} pts]`);
    for (const u of roster.units) lines.push(...unitText(u));

    return lines.join("\n") + "\n";
  },
};
