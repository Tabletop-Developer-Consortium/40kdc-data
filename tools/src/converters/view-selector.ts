/**
 * Handles multi-view data for shared units.
 *
 * Shared units (e.g., Chaos Land Raider) appear in multiple factions with the
 * same UUID. Their abilities, models, and weapons tables contain repeated entry
 * groups — one per faction "view". Views are delimited by the line number
 * resetting to 1.
 *
 * For World Eaters, the correct view is identified by having
 * "Blessings of Khorne" as a Faction-type ability.
 */

export interface SourceAbility {
  datasheet_id: string;
  line: string;
  ability_id: string;
  model: string;
  name: string;
  description: string;
  type: string;
  parameter: string;
  phases: string[];
}

interface ViewGroup<T extends { line: string }> {
  index: number;
  entries: T[];
}

/** Split an array of line-numbered entries into view groups by line-number resets. */
export function splitIntoViews<T extends { line: string }>(
  entries: T[]
): ViewGroup<T>[] {
  const views: ViewGroup<T>[] = [];
  let current: T[] = [];
  let lastLine = Infinity;

  for (const entry of entries) {
    const line = parseInt(entry.line, 10);
    if (line <= lastLine && current.length > 0) {
      views.push({ index: views.length, entries: current });
      current = [];
    }
    current.push(entry);
    lastLine = line;
  }
  if (current.length > 0) {
    views.push({ index: views.length, entries: current });
  }
  return views;
}

/**
 * Find the view index for a faction's shared unit.
 * Identifies the correct view by matching the faction's primary ability name
 * among the Faction-type abilities in each view.
 * Returns 0 for faction-exclusive units (single view).
 */
export function findFactionViewIndex(
  abilities: SourceAbility[],
  factionAbilityName: string
): number {
  const views = splitIntoViews(abilities);
  if (views.length === 1) return 0;

  for (const view of views) {
    const hasAbility = view.entries.some(
      (a) =>
        a.type === "Faction" &&
        a.name === factionAbilityName
    );
    if (hasAbility) return view.index;
  }

  throw new Error(
    `No "${factionAbilityName}" faction ability found in ${views.length} views ` +
      `for datasheet ${abilities[0]?.datasheet_id}`
  );
}

/** @deprecated Use findFactionViewIndex instead. */
export function findWEViewIndex(
  abilities: SourceAbility[]
): number {
  return findFactionViewIndex(abilities, "Blessings of Khorne");
}

/** Extract entries for a specific view index from a line-numbered array. */
export function getViewEntries<T extends { line: string }>(
  entries: T[],
  viewIndex: number
): T[] {
  const views = splitIntoViews(entries);
  if (viewIndex >= views.length) {
    throw new Error(
      `View index ${viewIndex} out of range (${views.length} views available)`
    );
  }
  return views[viewIndex].entries;
}

/**
 * Split points entries (no line field) into views for a shared unit.
 *
 * Points entries are ordered by view. For simple cases (1 entry per view),
 * indexing by viewIndex works. For multi-squad-size units, views are
 * delimited by the model count resetting (decreasing from prev entry).
 */
export function getPointsForView<T extends { models: string }>(
  entries: T[],
  viewIndex: number,
  numViews: number
): T[] {
  if (numViews <= 1) return entries;

  // Try splitting by model count resets (decrease signals new view)
  const views: T[][] = [[]];
  for (let i = 0; i < entries.length; i++) {
    const cur = parseInt(entries[i].models, 10);
    const prev =
      i > 0 ? parseInt(entries[i - 1].models, 10) : 0;
    if (i > 0 && cur <= prev) {
      views.push([]);
    }
    views[views.length - 1].push(entries[i]);
  }

  if (viewIndex < views.length) {
    return views[viewIndex];
  }

  // Fallback: evenly divide
  const perView = Math.ceil(entries.length / numViews);
  const start = viewIndex * perView;
  return entries.slice(start, start + perView);
}
