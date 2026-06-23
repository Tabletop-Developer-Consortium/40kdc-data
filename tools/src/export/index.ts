/**
 * Roster exporters — the symmetric counterpart to the importer.
 *
 * `exportRoster(roster, format)` dispatches to one of five registered
 * serializers (NewRecruit JSON, the three NewRecruit text formats, and the
 * canonical Roster JSON). Each serializer is deterministic and Dataset-free,
 * so the TS and Rust mirrors can produce byte-identical output for
 * cross-implementation conformance.
 *
 * @packageDocumentation
 */
import type { Roster } from "../import/types.js";
import { atc2026CompactSerializer, atc2026FullSerializer } from "./atc-2026.js";
import { newRecruitJsonSerializer } from "./newrecruit-json.js";
import { newRecruitSimpleSerializer } from "./newrecruit-simple.js";
import {
  newRecruitWtcCompactSerializer,
  newRecruitWtcFullSerializer,
} from "./newrecruit-wtc.js";
import { rosterJsonSerializer } from "./roster-json.js";
import { rosterizerSerializer } from "./rosterizer.js";
import type { ExportFormat, RosterSerializer } from "./serializer.js";

export type { ExportFormat, RosterSerializer } from "./serializer.js";
export { newRecruitJsonSerializer } from "./newrecruit-json.js";
export { newRecruitSimpleSerializer } from "./newrecruit-simple.js";
export {
  newRecruitWtcCompactSerializer,
  newRecruitWtcFullSerializer,
} from "./newrecruit-wtc.js";
export { rosterJsonSerializer } from "./roster-json.js";
export { rosterizerSerializer } from "./rosterizer.js";
export { atc2026CompactSerializer, atc2026FullSerializer } from "./atc-2026.js";

/** All registered serializers, keyed by their {@link ExportFormat} id. */
const SERIALIZERS: readonly RosterSerializer[] = [
  newRecruitJsonSerializer,
  newRecruitWtcCompactSerializer,
  newRecruitWtcFullSerializer,
  newRecruitSimpleSerializer,
  rosterJsonSerializer,
  rosterizerSerializer,
  atc2026CompactSerializer,
  atc2026FullSerializer,
];

/**
 * Human-readable label for each export format. Typed as a total
 * `Record<ExportFormat, string>` so adding a format to the {@link ExportFormat}
 * union is a compile error until it is given a label here — the picker can
 * never silently drop a format.
 */
const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  "newrecruit-wtc-compact": "WTC — compact",
  "newrecruit-wtc-full": "WTC — full",
  "newrecruit-simple": "Simple text",
  "newrecruit-json": "NewRecruit JSON",
  "rosterizer": "Rosterizer JSON",
  "roster-json": "Roster JSON (canonical)",
  "atc-2026-compact": "ATC 2026 — compact",
  "atc-2026-full": "ATC 2026 — full",
};

/**
 * The full list of selectable export formats, `{ id, label }`, derived from the
 * registered {@link SERIALIZERS} so it always equals what {@link exportRoster}
 * can actually produce. UIs should iterate this rather than hand-maintain a
 * parallel list. Display order follows {@link SERIALIZERS}.
 */
export const EXPORT_FORMATS: readonly { id: ExportFormat; label: string }[] =
  SERIALIZERS.map((s) => ({ id: s.id, label: EXPORT_FORMAT_LABELS[s.id] }));

/** Serialize a {@link Roster} into the named target format. */
export function exportRoster(roster: Roster, format: ExportFormat): string {
  const s = SERIALIZERS.find((s) => s.id === format);
  if (!s) {
    throw new Error(
      `unknown export format: ${format} (registered: ${SERIALIZERS.map((s) => s.id).join(", ")})`,
    );
  }
  return s.serialize(roster);
}
