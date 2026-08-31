import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExternalReference } from "./generated.js";
import {
  CoreExternalRefStore,
  EXTERNAL_REF_ENTITY_FILES,
  type ExternalRefEntityType,
} from "./core-external-refs.js";
import { externalRefKey } from "./external-refs.js";
import { REPO_ROOT } from "./mfm/repo-files.js";

const OUTPUT_PATH = path.join(
  REPO_ROOT,
  "data",
  "_audit",
  "external-refs.json",
);

interface Target {
  entity_type: ExternalRefEntityType;
  id: string;
  faction_id?: string;
}

interface CanonicalEntity {
  target: Target;
  refs: Map<string, ExternalReference>;
}

const FACTION_SCOPED = new Set<ExternalRefEntityType>([
  "unit",
  "detachment",
  "weapon",
]);

function canonicalEntities(store: CoreExternalRefStore): CanonicalEntity[] {
  const groups = new Map<string, CanonicalEntity>();
  for (const location of store.locations()) {
    const factionId =
      typeof location.record.faction_id === "string"
        ? location.record.faction_id
        : location.dir;
    const scoped = FACTION_SCOPED.has(location.entity_type);
    const key = scoped
      ? `${location.entity_type}\0${factionId}\0${location.record.id}`
      : `${location.entity_type}\0${location.record.id}`;
    const entity = groups.get(key) ?? {
      target: {
        entity_type: location.entity_type,
        id: location.record.id,
        ...(scoped && factionId ? { faction_id: factionId } : {}),
      },
      refs: new Map<string, ExternalReference>(),
    };
    for (const ref of location.record.external_refs ?? []) {
      entity.refs.set(externalRefKey(ref.namespace, ref.id), ref);
    }
    groups.set(key, entity);
  }
  return [...groups.values()];
}

export function buildExternalRefsAudit(
  store = new CoreExternalRefStore(),
): unknown {
  const entities = canonicalEntities(store);
  const fanOut = new Map<
    string,
    { namespace: string; id: string; targets: Target[] }
  >();
  const entityTypes = Object.fromEntries(
    (Object.keys(EXTERNAL_REF_ENTITY_FILES) as ExternalRefEntityType[]).map(
      (entityType) => {
        const typeEntities = entities.filter(
          (entity) => entity.target.entity_type === entityType,
        );
        const refsByNamespace = new Map<string, number>();
        const coveredByNamespace = new Map<string, number>();
        for (const entity of typeEntities) {
          const namespaces = new Set<string>();
          for (const ref of entity.refs.values()) {
            refsByNamespace.set(
              ref.namespace,
              (refsByNamespace.get(ref.namespace) ?? 0) + 1,
            );
            namespaces.add(ref.namespace);
            const key = externalRefKey(ref.namespace, ref.id);
            const entry = fanOut.get(key) ?? {
              namespace: ref.namespace,
              id: ref.id,
              targets: [],
            };
            entry.targets.push(entity.target);
            fanOut.set(key, entry);
          }
          for (const namespace of namespaces) {
            coveredByNamespace.set(
              namespace,
              (coveredByNamespace.get(namespace) ?? 0) + 1,
            );
          }
        }
        const sortedObject = (
          values: Map<string, number>,
        ): Record<string, number> =>
          Object.fromEntries(
            [...values].sort(([left], [right]) => left.localeCompare(right)),
          );
        return [
          entityType,
          {
            entities: typeEntities.length,
            with_external_refs: typeEntities.filter(
              (entity) => entity.refs.size > 0,
            ).length,
            covered_entities_by_namespace: sortedObject(coveredByNamespace),
            references_by_namespace: sortedObject(refsByNamespace),
          },
        ];
      },
    ),
  );

  const fan_out = [...fanOut.values()]
    .filter((entry) => entry.targets.length > 1)
    .map((entry) => ({
      namespace: entry.namespace,
      id: entry.id,
      targets: entry.targets.sort(
        (left, right) =>
          left.entity_type.localeCompare(right.entity_type) ||
          left.id.localeCompare(right.id) ||
          (left.faction_id ?? "").localeCompare(right.faction_id ?? ""),
      ),
    }))
    .sort(
      (left, right) =>
        left.namespace.localeCompare(right.namespace) ||
        left.id.localeCompare(right.id),
    );

  return {
    schema_version: 1,
    entity_types: entityTypes,
    fan_out,
  };
}

export function runExternalRefsAudit(check = false): void {
  const content = `${JSON.stringify(buildExternalRefsAudit(), null, 2)}\n`;
  if (check) {
    const current = fs.existsSync(OUTPUT_PATH)
      ? fs.readFileSync(OUTPUT_PATH, "utf8")
      : "";
    if (current !== content)
      throw new Error("data/_audit/external-refs.json is stale");
    console.log("External-reference audit is current.");
    return;
  }
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, content);
  console.log(
    `External-reference audit → ${path.relative(REPO_ROOT, OUTPUT_PATH)}`,
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    runExternalRefsAudit(process.argv.includes("--check"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
