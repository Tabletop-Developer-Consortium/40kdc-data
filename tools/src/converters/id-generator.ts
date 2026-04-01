/**
 * Generates kebab-case entity IDs from display names.
 */

const ENTITY_ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/** Convert a display name to a kebab-case entity ID. */
export function nameToId(name: string): string {
  const id = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[''\u2019]/g, "")      // strip apostrophes/right-quotes
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")     // non-alphanumeric → hyphens
    .replace(/^-+|-+$/g, "");         // trim leading/trailing hyphens

  if (!ENTITY_ID_PATTERN.test(id)) {
    throw new Error(
      `Generated ID "${id}" from name "${name}" does not match entity-id pattern`
    );
  }
  return id;
}

/** Convert a stratagem type string to the schema enum value and detachment ID. */
export function parseStratagemType(typeStr: string): {
  type: string;
  detachmentName: string;
} {
  // Format: "Berzerker Warband - Battle Tactic Stratagem"
  const match = typeStr.match(/^(.+?)\s*-\s*(.+?)\s*Stratagem$/i);
  if (!match) {
    throw new Error(`Cannot parse stratagem type: "${typeStr}"`);
  }
  const detachmentName = match[1].trim();
  const rawType = match[2].trim().toLowerCase();

  const typeMap: Record<string, string> = {
    "battle tactic": "battle-tactic",
    "strategic ploy": "strategic-ploy",
    "epic deed": "epic-deed",
    wargear: "wargear",
  };
  const type = typeMap[rawType];
  if (!type) {
    throw new Error(`Unknown stratagem type: "${rawType}" from "${typeStr}"`);
  }
  return { type, detachmentName };
}

/** Convert a player turn string to schema enum. */
export function parsePlayerTurn(turn: string): string {
  const lower = turn.toLowerCase().trim();
  if (lower.includes("either")) return "either";
  if (lower.includes("your")) return "your-turn";
  if (lower.includes("opponent")) return "opponent-turn";
  throw new Error(`Cannot parse player turn: "${turn}"`);
}

/** Map source phase names to schema phase enum values. Filters out invalid phases. */
export function mapPhases(phases: string[]): string[] {
  const phaseMap: Record<string, string> = {
    command: "command",
    movement: "movement",
    shooting: "shooting",
    charge: "charge",
    fight: "fight",
  };
  return phases
    .map((p) => phaseMap[p.toLowerCase()])
    .filter((p): p is string => p !== undefined);
}
