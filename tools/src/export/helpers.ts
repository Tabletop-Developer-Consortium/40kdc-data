/**
 * Shared helpers for the roster exporters.
 *
 * Exporters are deterministic and Dataset-free: they read the Roster only and
 * regenerate format-specific decoration (display names, Char-slot numbering,
 * displayed unit totals) from what's stored. Anything the Roster doesn't model
 * — char-slot numbers, the detachment "<X> Character" keyword, secondary-
 * objective summaries — is either derived heuristically here or dropped.
 *
 * @packageDocumentation
 */
import type { Roster, RosterUnit, RosterWargear } from "../import/types.js";

/** Convert a kebab-case entity id ("chaos-knights") to a Title Case display
 * name ("Chaos Knights"). This is the round-trip best-effort when the Roster
 * doesn't store the source's raw faction/detachment name. */
export function titleCaseId(id: string | null | undefined): string | null {
  if (id == null) return null;
  if (id.length === 0) return id;
  return id
    .split("-")
    .map((seg) => (seg.length === 0 ? seg : seg[0].toUpperCase() + seg.slice(1)))
    .join(" ");
}

/** Sum of unit base pts + enhancement pts (= the figure most text formats display). */
export function displayedUnitPoints(u: RosterUnit): number | null {
  if (u.points === null) return null;
  return u.points + (u.enhancement_points ?? 0);
}

/** Sum of every unit's displayed total + every enhancement cost line. */
export function totalArmyPoints(roster: Roster): number {
  let total = 0;
  for (const u of roster.units) {
    total += u.points ?? 0;
    total += u.enhancement_points ?? 0;
  }
  return total;
}
export function attachmentToken(u: RosterUnit): string | null {
  const attachment = u.leader_attachment;
  if (!attachment) return null;
  const provisional = attachment.provisional ? " [provisional]" : "";
  return `Attachment: ${attachment.role} -> ${attachment.bodyguard_ref.raw_name}${provisional}`;
}


/**
 * Heuristic re-derivation of which units would carry a `CharN:` prefix on
 * export to a wtc text format. The Roster doesn't track unit categories, so we
 * approximate "is a character" as "is the warlord OR has an enhancement OR has
 * a leader attachment". CharN: numbering follows declaration order.
 *
 * Returns a parallel array: `slot[i]` is the 1-based char index for unit i, or
 * `null` if that unit doesn't get a CharN: prefix.
 */
export function charSlotAssignment(units: readonly RosterUnit[]): (number | null)[] {
  const result: (number | null)[] = [];
  let next = 1;
  for (const u of units) {
    const isChar = u.is_warlord || u.enhancement !== null || u.leader_attachment !== null;
    if (isChar) {
      result.push(next);
      next += 1;
    } else {
      result.push(null);
    }
  }
  return result;
}

/** Render a loadout group's per-model weapons, sorted by display name, with `Nx` for counts >1. */
export function groupWeaponsText(wargear: readonly RosterWargear[]): string {
  return [...wargear]
    .sort((a, b) => a.ref.raw_name.localeCompare(b.ref.raw_name))
    .map((w) => (w.count > 1 ? `${w.count}x ${w.ref.raw_name}` : w.ref.raw_name))
    .join(", ");
}

/**
 * Coarsen a unit's fine per-model {@link RosterUnit.loadout_groups} by merging
 * groups that share an identical per-model weapon set (dropping the model-type
 * name) — the granularity the WTC `N with …` convention wants. Preserves first-seen
 * order. Returns `null` when the unit carries no loadout groups (caller renders from
 * the aggregate `wargear` instead).
 */
export function coarsenedLoadoutGroups(
  u: RosterUnit,
): { count: number; wargear: RosterWargear[] }[] | null {
  if (!u.loadout_groups || u.loadout_groups.length === 0) return null;
  const byLoadout = new Map<string, { count: number; wargear: RosterWargear[] }>();
  const order: string[] = [];
  for (const g of u.loadout_groups) {
    const key = [...g.wargear]
      .map((w) => `${w.ref.id ?? w.ref.raw_name}#${w.count}`)
      .sort()
      .join("|");
    const cur = byLoadout.get(key);
    if (cur) cur.count += g.count;
    else {
      byLoadout.set(key, { count: g.count, wargear: g.wargear });
      order.push(key);
    }
  }
  return order.map((k) => byLoadout.get(k)!);
}

/** Pretty JSON with a trailing newline — matches the repo's 2-space convention. */
export function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
