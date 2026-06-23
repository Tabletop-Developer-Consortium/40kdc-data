/**
 * ATC 2026 roster text exporters (`atc-2026-compact` / `atc-2026-full`).
 *
 * These reuse the WTC compact/full *bodies* verbatim (see
 * {@link wtcCompactBodyLines} / {@link wtcFullBodyLines}) but replace the
 * summary header with the block the American Team Championship 2026 list-
 * submission format asks for: player/team identification, the picked Force
 * Disposition, every enhancement-bearing model, and the leader/support
 * attachments spelled out.
 *
 * Provisional and **export-only** — there is no ATC import adapter, so the
 * format is additive and easily retired. The existing WTC formats (and real-
 * world WTC import) are untouched.
 *
 * Field sources (all read straight off the Roster; no model field was added):
 * - `PLAYER NAME` / `TEAM NAME` — static `—` placeholders the player fills in
 *   after export, mirroring the ATC fill-out form. The Roster models neither.
 * - `DISPOSITION` — {@link titleCaseId} of `roster.force_disposition` (the
 *   selected `force-disposition-id`), or `—` when none is picked.
 * - `ENHANCEMENT` — **every** enhancement-bearing unit, `"<name> (on CharN:
 *   <unit>)"` joined with `"; "` (the ATC "list on which model" intent), unlike
 *   the WTC header which prints only the first.
 * - `LEADER/SUPPORT` — every unit carrying a `leader_attachment`, rendered
 *   `"<character> attached to <unit>"` joined with `"; "`.
 *
 * @packageDocumentation
 */
import type { Roster, RosterUnit } from "../import/types.js";
import { charSlotAssignment, titleCaseId, totalArmyPoints } from "./helpers.js";
import { FENCE, wtcCompactBodyLines, wtcFullBodyLines } from "./newrecruit-wtc.js";
import type { RosterSerializer } from "./serializer.js";

const DASH = "—";

function atcHeader(roster: Roster, units: readonly RosterUnit[], slots: readonly (number | null)[]): string {
  const faction = titleCaseId(roster.faction_id) ?? "Unknown";
  const disposition = titleCaseId(roster.force_disposition) ?? DASH;
  const detachment = roster.detachments.length
    ? roster.detachments.map((d) => titleCaseId(d.ref.id) ?? d.ref.raw_name).join(", ")
    : DASH;
  const total = roster.points.total_reported ?? totalArmyPoints(roster);

  const warlordIdx = units.findIndex((u) => u.is_warlord);
  const warlord =
    warlordIdx >= 0 ? `Char${slots[warlordIdx]}: ${units[warlordIdx].ref.raw_name}` : DASH;

  const enhParts: string[] = [];
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    if (u.enhancement) enhParts.push(`${u.enhancement.raw_name} (on Char${slots[i]}: ${u.ref.raw_name})`);
  }
  const enhancement = enhParts.length > 0 ? enhParts.join("; ") : DASH;

  const attachParts: string[] = [];
  for (const u of units) {
    if (u.leader_attachment) {
      attachParts.push(`${u.ref.raw_name} attached to ${u.leader_attachment.bodyguard_ref.raw_name}`);
    }
  }
  const leaderSupport = attachParts.length > 0 ? attachParts.join("; ") : DASH;

  const lines: string[] = [
    FENCE,
    `+ PLAYER NAME: ${DASH}`,
    `+ TEAM NAME: ${DASH}`,
    `+ FACTIONS USED: ${faction}`,
    `+ DISPOSITION: ${disposition}`,
    `+ DETACHMENT: ${detachment}`,
    `+ ARMY POINTS: ${total}pts`,
    `+`,
    `+ WARLORD: ${warlord}`,
    `+ ENHANCEMENT: ${enhancement}`,
    `+ LEADER/SUPPORT: ${leaderSupport}`,
    `+ NUMBER OF UNITS: ${units.length}`,
    FENCE,
  ];
  return lines.join("\n");
}

export const atc2026CompactSerializer: RosterSerializer = {
  id: "atc-2026-compact",

  serialize(roster: Roster): string {
    const units = roster.units;
    const slots = charSlotAssignment(units);
    return [atcHeader(roster, units, slots), ...wtcCompactBodyLines(units, slots)].join("\n") + "\n";
  },
};

export const atc2026FullSerializer: RosterSerializer = {
  id: "atc-2026-full",

  serialize(roster: Roster): string {
    const units = roster.units;
    const slots = charSlotAssignment(units);
    return [atcHeader(roster, units, slots), ...wtcFullBodyLines(units, slots, roster.faction_id)].join("\n");
  },
};
