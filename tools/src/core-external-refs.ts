import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ExternalReference } from "./generated.js";
import {
  addExternalRef,
  externalRefKey,
  type ExternalReferenceCarrier,
} from "./external-refs.js";
import type { StagedWrite } from "./mfm/apply.js";
import { repoDirs } from "./mfm/faction-map.js";
import { CORE_DIR, readJsonArray } from "./mfm/repo-files.js";

export const EXTERNAL_REF_ENTITY_FILES = {
  faction: "factions.json",
  unit: "units.json",
  detachment: "detachments.json",
  enhancement: "enhancements.json",
  stratagem: "stratagems.json",
  weapon: "weapons.json",
  wargear: "wargear.json",
} as const;

export type ExternalRefEntityType = keyof typeof EXTERNAL_REF_ENTITY_FILES;

export interface ExternalRefCoreRecord extends ExternalReferenceCarrier {
  id: string;
  name?: string;
  faction_id?: string;
  detachment_id?: string | null;
  aliases?: string[];
  [key: string]: unknown;
}

export interface ExternalRefRecordLocation {
  entity_type: ExternalRefEntityType;
  dir: string;
  path: string;
  record: ExternalRefCoreRecord;
}

interface LoadedFile {
  entityType: ExternalRefEntityType;
  dir: string;
  path: string;
  records: ExternalRefCoreRecord[];
  dirty: boolean;
}

export type ExternalRefAddResult = "added" | "present" | "unmatched";

/** Shared loader/index/writer for every exact external-reference projection. */
export class CoreExternalRefStore {
  private readonly files: LoadedFile[] = [];
  private readonly byKey = new Map<
    string,
    { file: LoadedFile; record: ExternalRefCoreRecord }
  >();

  constructor() {
    const dirs = ["", ...[...repoDirs()].sort()];
    for (const [entityType, filename] of Object.entries(
      EXTERNAL_REF_ENTITY_FILES,
    ) as [ExternalRefEntityType, string][]) {
      for (const dir of dirs) {
        const filePath = dir
          ? path.join(CORE_DIR, dir, filename)
          : path.join(CORE_DIR, filename);
        if (!fs.existsSync(filePath)) continue;
        const file: LoadedFile = {
          entityType,
          dir,
          path: filePath,
          records: readJsonArray<ExternalRefCoreRecord>(filePath),
          dirty: false,
        };
        this.files.push(file);
        for (const record of file.records) {
          this.byKey.set(`${entityType}\0${dir}\0${record.id}`, {
            file,
            record,
          });
        }
      }
    }
  }

  add(
    entityType: ExternalRefEntityType,
    dir: string,
    entityId: string,
    namespace: string,
    sourceId: string,
  ): ExternalRefAddResult {
    const target = this.byKey.get(`${entityType}\0${dir}\0${entityId}`);
    if (!target) return "unmatched";
    if (!addExternalRef(target.record, namespace, sourceId)) return "present";
    target.file.dirty = true;
    return "added";
  }

  removeNamespace(namespace: string): number {
    let removed = 0;
    for (const file of this.files) {
      for (const record of file.records) {
        const refs = record.external_refs;
        if (!refs) continue;
        const retained = refs.filter((ref) => ref.namespace !== namespace);
        if (retained.length === refs.length) continue;
        removed += refs.length - retained.length;
        if (retained.length > 0) record.external_refs = retained;
        else delete record.external_refs;
        file.dirty = true;
      }
    }
    return removed;
  }

  get(
    entityType: ExternalRefEntityType,
    dir: string,
    entityId: string,
  ): ExternalRefCoreRecord | undefined {
    return this.byKey.get(`${entityType}\0${dir}\0${entityId}`)?.record;
  }

  locations(entityType?: ExternalRefEntityType): ExternalRefRecordLocation[] {
    const result: ExternalRefRecordLocation[] = [];
    for (const file of this.files) {
      if (entityType && file.entityType !== entityType) continue;
      for (const record of file.records) {
        result.push({
          entity_type: file.entityType,
          dir: file.dir,
          path: file.path,
          record,
        });
      }
    }
    return result;
  }

  /** Keep collections governed by replicated-identical collision policy equal. */
  synchronizeReplicated(): void {
    for (const entityType of ["enhancement", "stratagem", "wargear"] as const) {
      const refsById = new Map<string, Map<string, ExternalReference>>();
      for (const { record } of this.locations(entityType)) {
        const refs =
          refsById.get(record.id) ?? new Map<string, ExternalReference>();
        for (const ref of record.external_refs ?? []) {
          refs.set(externalRefKey(ref.namespace, ref.id), ref);
        }
        refsById.set(record.id, refs);
      }
      for (const location of this.locations(entityType)) {
        for (const ref of refsById.get(location.record.id)?.values() ?? []) {
          if (addExternalRef(location.record, ref.namespace, ref.id)) {
            const file = this.files.find(
              (candidate) => candidate.path === location.path,
            );
            if (file) file.dirty = true;
          }
        }
      }
    }
  }

  stagedWrites(): StagedWrite[] {
    return this.files
      .filter(
        (file) =>
          file.dirty &&
          !isDeepStrictEqual(readJsonArray(file.path), file.records),
      )
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({ path: file.path, value: file.records }));
  }
}
