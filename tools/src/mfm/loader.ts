/**
 * loader.ts — read the GW MFM data dump (_private/dump.json) once and
 * expose its ~120 relational tables behind typed, cached lookups.
 *
 * The dump is a GW-canon relational snapshot: every table is a flat array of
 * rows, rows are linked by UUID foreign keys, and display text lives under
 * `localisations.<lang>.name`. This module is the single source of joins for
 * every ingest phase — build an index once, reuse it everywhere.
 *
 * IMPORTANT (IP): the dump carries GW rules/lore prose (e.g. enhancement
 * `localisations.en.rules`). That prose must NEVER be written into this repo —
 * only numeric/structural fields. Prose routes to the out-of-repo store. This
 * loader exposes the raw rows; callers are responsible for taking only the
 * fields they're allowed to persist here.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
export const DEFAULT_DUMP_PATH = path.join(REPO_ROOT, "_private", "dump.json");

/** A localisations block: `{ en: { name, rules, lore, ... }, de: {...}, ... }`. */
export type Localisations = Record<string, Record<string, string> | undefined>;

/** Common shape: most dump entities carry an `id` and may be localised. */
export interface DumpRow {
  id?: string;
  localisations?: Localisations;
  [k: string]: unknown;
}

// ─────────────────── typed rows for the tables ingest touches ───────────────────

export interface PublicationRow extends DumpRow {
  factionKeywordId: string | null;
  isLegends: boolean;
  isCombatPatrol: boolean;
}
export interface FactionKeywordRow extends DumpRow {}
export interface DatasheetRow extends DumpRow {
  publicationId: string;
  isLegends: boolean;
  maxModelCount: number | null;
  displayOrder: number;
}
export interface DatasheetFactionKeywordRow {
  id: string;
  displayOrder: number;
  datasheetId: string;
  factionKeywordId: string;
}
export interface UnitCompositionRow extends DumpRow {
  datasheetId: string;
  isDefault: boolean;
  displayOrder: number;
  points: number | null;
  referenceGroupingKeywordId: string | null;
}
export interface UnitCompositionMiniatureRow {
  id: string;
  min: number;
  max: number;
  unitCompositionId: string;
  miniatureId: string;
}
export interface DatasheetPointsStepRow {
  id: string;
  datasheetId: string;
  stepAt: number;
  stepPoints: number;
}
export interface DetachmentRow extends DumpRow {
  publicationId: string;
  isCombatPatrol: boolean;
  detachmentPointsCost: number | null;
  pointsCost: number | null;
}
export interface DetachmentForceDispositionRow {
  detachmentId: string;
  forceDispositionId: string;
}
export interface DetachmentFactionDpCostRow {
  detachmentId: string;
  factionKeywordId: string;
  detachmentPointsCost: number;
}
export interface ForceDispositionRow extends DumpRow {}
export interface EnhancementRow extends DumpRow {
  detachmentId: string;
  basePointsCost: number;
  limit: number;
  enhancementType: string;
  isEquipableByEpicHero: boolean;
  isEquipableByNonCharacterUnit: boolean;
  cannotBeWarlord: boolean;
  isCombatPatrol: boolean;
}
export interface StratagemRow extends DumpRow {
  key: string;
  category: string | null;
  cpCost: string | null;
  detachmentId: string | null;
  publicationId: string;
}
export interface WargearOptionRow {
  id: string;
  inputType: string;
  defaultValue: number;
  points: number;
  displayOrder: number;
  wargearItemId: string;
  wargearOptionGroupId: string;
}

// ── wargear / loadout tables (phase 5) ──
// `miniature` also carries the model's stat line (as display strings) used by the
// seed-units ingest. `statlineHidden` marks a model that shares a visible model's
// statline (e.g. a sergeant on the trooper line) and so introduces no new profile.
export interface MiniatureRow extends DumpRow {
  datasheetId: string;
  displayOrder: number;
  statlineHidden: boolean;
  isIndividualModels: boolean;
  movement: string;
  toughness: string;
  save: string;
  wounds: string;
  leadership: string;
  objectiveControl: string;
}
export interface MiniatureKeywordRow {
  id: string;
  displayOrder: number;
  miniatureId: string;
  keywordId: string;
}
export interface WargearItemRow extends DumpRow {
  wargearType: string; // "weapon" | "other" | ...
}
export interface WargearOptionGroupRow {
  id: string;
  displayOrder: number;
  datasheetId: string;
  miniatureId: string | null;
  isStaticWargear: boolean;
}
export interface BaseMiniatureLoadoutRow {
  id: string;
  datasheetId: string;
  miniatureId: string;
}
export interface BaseMiniatureLoadoutWargearOptionRow {
  id: string;
  count: number;
  wargearOptionId: string;
  baseMiniatureLoadoutId: string;
}
export interface LoadoutChoiceSetRow {
  id: string;
  limit: number;
  allowDuplicates: boolean;
  datasheetId: string;
  miniatureId: string | null;
  alternate: boolean;
}
export interface LoadoutChoiceRow {
  id: string;
  loadoutChoiceSetId: string;
}
export interface LoadoutChoiceWargearItemRow {
  id: string;
  count: number;
  wargearItemId: string;
  loadoutChoiceId: string;
}
export interface LimitedWargearChoiceSetRow {
  id: string;
  mandatory: boolean;
  datasheetId: string;
  miniatureId: string | null;
}
export interface LimitedWargearChoiceRow {
  id: string;
  limitedWargearChoiceSetId: string;
}
export interface LimitedWargearChoiceWargearItemRow {
  id: string;
  count: number;
  wargearItemId: string;
  limitedWargearChoiceId: string;
}
export interface WargearLimitRow {
  id: string;
  modelCount: number;
  choiceLimit: number;
  duplicateLimit: number | null;
  limitedWargearChoiceSetId: string;
}

// ── leader/bodyguard attachment tables (attachment-role ingest) ──
// `datasheet_bodyguard_group.datasheetId` is the *leader* (the attaching
// character); `bodyguardType` is its role. The eligible bodyguards are the
// `datasheet_bodyguard_group_datasheet` rows joined by group id. `factionKeywordId`
// is null in this dump — faction scope comes from the leader datasheet's publication.
export interface DatasheetBodyguardGroupRow {
  id: string;
  datasheetId: string;
  bodyguardType: "leader" | "support";
  factionKeywordId: string | null;
  excludedDetachmentId: string | null;
  requiredDetachmentId: string | null;
  requiresAllUnitsHaveKeywordId: string | null;
}
export interface DatasheetBodyguardGroupDatasheetRow {
  datasheetBodyguardGroupId: string;
  datasheetId: string;
}

// ───────────────────────────── the loader ─────────────────────────────

export class MfmDump {
  readonly version: number | undefined;
  readonly tables: Record<string, DumpRow[]>;
  private readonly idIndexes = new Map<string, Map<string, DumpRow>>();
  private readonly groupIndexes = new Map<string, Map<string, DumpRow[]>>();

  constructor(payload: { metadata?: { data_version?: number }; data: Record<string, DumpRow[]> }) {
    this.version = payload.metadata?.data_version;
    this.tables = payload.data;
  }

  /** Raw rows of a table. Throws if the table is absent (typo guard). */
  table<T = DumpRow>(name: string): T[] {
    const t = this.tables[name];
    if (!t) throw new Error(`GW MFM dump has no table "${name}"`);
    return t as unknown as T[];
  }

  /** `id` → row index for a table, built once and cached. */
  byId<T = DumpRow>(name: string): Map<string, T> {
    let idx = this.idIndexes.get(name);
    if (!idx) {
      idx = new Map();
      for (const row of this.table(name)) if (row.id) idx.set(row.id, row);
      this.idIndexes.set(name, idx);
    }
    return idx as unknown as Map<string, T>;
  }

  /** Group a table's rows by an arbitrary foreign-key field, cached per (table, key). */
  groupBy<T = DumpRow>(name: string, key: string): Map<string, T[]> {
    const cacheKey = `${name}::${key}`;
    let idx = this.groupIndexes.get(cacheKey);
    if (!idx) {
      idx = new Map();
      for (const row of this.table(name)) {
        const fk = (row as Record<string, unknown>)[key];
        if (fk == null) continue;
        const k = String(fk);
        (idx.get(k) ?? idx.set(k, []).get(k)!).push(row);
      }
      this.groupIndexes.set(cacheKey, idx);
    }
    return idx as unknown as Map<string, T[]>;
  }

  /** English display name for a localised row (`localisations.en.name`). */
  enName(row: DumpRow | undefined): string | undefined {
    return row?.localisations?.en?.name?.trim() || undefined;
  }

  // ── domain joins ──

  /** The faction-keyword id that "owns" a datasheet, via its publication. */
  factionKeywordOfDatasheet(datasheetId: string): string | null {
    const ds = this.byId<DatasheetRow>("datasheet").get(datasheetId);
    if (!ds) return null;
    const pub = this.byId<PublicationRow>("publication").get(ds.publicationId);
    return pub?.factionKeywordId ?? null;
  }

  /** The faction-keyword id that "owns" a detachment, via its publication. */
  factionKeywordOfDetachment(detachmentId: string): string | null {
    const det = this.byId<DetachmentRow>("detachment").get(detachmentId);
    if (!det) return null;
    const pub = this.byId<PublicationRow>("publication").get(det.publicationId);
    return pub?.factionKeywordId ?? null;
  }

  /** The single force-disposition id mapped to a detachment (dump is 1:1), or null. */
  dispositionOfDetachment(detachmentId: string): string | null {
    const rows = this.groupBy<DetachmentForceDispositionRow>(
      "detachment_force_disposition",
      "detachmentId"
    ).get(detachmentId);
    return rows?.[0]?.forceDispositionId ?? null;
  }
}

/** Read and parse the dump from disk (defaults to _private/dump.json). */
export function loadDump(p: string = DEFAULT_DUMP_PATH): MfmDump {
  if (!fs.existsSync(p)) {
    throw new Error(
      `GW MFM dump not found at ${p}. Place the export there (it is .gitignored under _private/).`
    );
  }
  return new MfmDump(JSON.parse(fs.readFileSync(p, "utf8")));
}
