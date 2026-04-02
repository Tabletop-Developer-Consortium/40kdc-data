/**
 * Parses army-assist display-format stat strings into typed values
 * for the 40kdc-data schemas.
 */

/** Strip inch marks and parse to integer. "8\"" → 8, "14\"" → 14, "*" → 0 */
export function parseMove(s: string): number {
  const cleaned = s.replace(/["″]/g, "").trim();
  if (cleaned === "" || cleaned === "-" || cleaned === "*") return 0;
  const n = parseInt(cleaned, 10);
  if (isNaN(n)) throw new Error(`Cannot parse movement: "${s}"`);
  return n;
}

/** Parse target-number stat. "3+" → 3, "6+" → 6, "" → null */
export function parseTargetNumber(s: string): number | null {
  const cleaned = s.replace("+", "").trim();
  if (cleaned === "" || cleaned === "-" || cleaned === "N/A") return null;
  const n = parseInt(cleaned, 10);
  if (isNaN(n)) throw new Error(`Cannot parse target number: "${s}"`);
  return n;
}

/** Parse a stat-value field. Returns integer for fixed values, string for dice expressions. */
export function parseStatValue(s: string): number | string {
  const cleaned = s.trim();
  if (cleaned === "" || cleaned === "-") return 0;
  // Dice expressions: D6, 2D6, D6+2, D3+1, etc.
  if (/^\d*[dD]\d/i.test(cleaned)) return cleaned;
  const n = parseInt(cleaned, 10);
  if (isNaN(n)) throw new Error(`Cannot parse stat value: "${s}"`);
  return n;
}

/** Parse weapon range. "36\"" → 36, "Melee" → "Melee", "" → "Melee", "N/A" → "Melee" */
export function parseRange(s: string): number | "Melee" {
  const cleaned = s.replace(/["″]/g, "").trim();
  if (cleaned === "" || cleaned.toLowerCase() === "melee" || cleaned === "N/A") return "Melee";
  const n = parseInt(cleaned, 10);
  if (isNaN(n)) throw new Error(`Cannot parse range: "${s}"`);
  return n;
}

/** Parse BS/WS. "3+" → 3, "N/A" or "" → null */
export function parseBSWS(s: string): number | null {
  return parseTargetNumber(s);
}

/** Parse invulnerable save. "4+" → 4, "" → null */
export function parseInvuln(s: string): number | null {
  return parseTargetNumber(s);
}

/** Parse toughness, wounds, OC — always integers. */
export function parseIntStat(s: string): number {
  const cleaned = s.trim();
  if (cleaned === "" || cleaned === "-") return 0;
  const n = parseInt(cleaned, 10);
  if (isNaN(n)) throw new Error(`Cannot parse int stat: "${s}"`);
  return n;
}

/** Parse weapon keywords from the description field. "Pistol, Hazardous" → ["Pistol", "Hazardous"] */
export function parseWeaponKeywords(description: string): string[] {
  if (!description || description.trim() === "") return [];
  return description
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/** Parse AP value. "0" → 0, "-2" → -2 */
export function parseAP(s: string): number {
  const cleaned = s.trim();
  if (cleaned === "" || cleaned === "-" || cleaned === "0") return 0;
  const n = parseInt(cleaned, 10);
  if (isNaN(n)) throw new Error(`Cannot parse AP: "${s}"`);
  return n;
}
