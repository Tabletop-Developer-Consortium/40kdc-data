/**
 * Generate a descriptive JSON Schema (draft-07) contract for the GW MFM dump
 * (`_private/dump.json`) — table names, field names, inferred types, and
 * deterministic, non-distributive presence statistics. This is the authoritative
 * map of the ~130 dump tables and the single reference the `tools/src/mfm/*`
 * passes should consult before reading a field, so we stop re-discovering the
 * structure ad-hoc (the recurring "is this field here / what shape is it"
 * problem — e.g. locale-keyed `localisations`, the unread `loadout_choice_set.limit`).
 *
 * Shape + counts only — no GW prose is read or emitted. We never traverse into
 * string VALUES (only keys/types), and the `x-40kdc-*` extensions carry only
 * counts and structural relationships, never row values, IDs, names, sample
 * records, or localisation text. The output is therefore IP-safe and committed
 * at `tools/src/mfm/dump.schema.json`. End users regenerate a local contract
 * from their OWN supplied dump (the repository never contains that JSON):
 *
 *   npx tsx tools/src/mfm/gen-dump-schema.ts --dump <path> [--out <path>]
 *
 * Human-authored descriptions and semantic metadata live in the committed
 * declarative source `tools/src/mfm/dump.schema.annotations.json` and are merged
 * into the generated schema.
 *
 * Inference mirrors a genson-style pass: an array's `items` is the merge of all
 * element schemas; an object's `required` is the set of keys present in EVERY
 * sibling; a `null`/absent value yields the permissive empty schema `{}`.
 *
 * Deterministic extensions (all counts, no values):
 *   - root  `x-40kdc-data-version` — the dump's `metadata.data_version`.
 *   - table `x-40kdc-row-count`    — number of rows in that `data.<table>` array.
 *   - field `x-40kdc-observed`     — `{ present, null, <json-type>: count }`.
 *   - field `x-40kdc-foreign-key`  — `{ table, field: "id" }` when a `<name>Id`
 *                                    field maps exactly to a table named by the
 *                                    camel-case-to-snake-case prefix.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

type Schema = Record<string, unknown>;

/**
 * Per-table / per-field descriptive annotations merged into the generated schema.
 * Committed at `tools/src/mfm/dump.schema.annotations.json`. It may contain ONLY
 * `description` strings and `x-40kdc-*` semantic metadata — never row values,
 * localisation prose, IDs, names, or sample records.
 */
export interface DumpFieldAnnotation {
  description?: string;
  [key: string]: unknown;
}
export interface DumpTableAnnotation {
  description?: string;
  fields?: Record<string, DumpFieldAnnotation>;
  [key: string]: unknown;
}
export interface DumpSchemaAnnotations {
  tables?: Record<string, DumpTableAnnotation>;
}

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_DUMP_PATH = `${REPO_ROOT}_private/dump.json`;
const DEFAULT_OUT_PATH = `${REPO_ROOT}tools/src/mfm/dump.schema.json`;
const ANNOTATIONS_PATH = `${REPO_ROOT}tools/src/mfm/dump.schema.annotations.json`;

/** Infer a schema for a single value. */
function infer(value: unknown): Schema {
  if (value === null || value === undefined) return {};
  if (Array.isArray(value)) {
    const items = value.map(infer);
    return { type: "array", items: items.length ? mergeAll(items) : {} };
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const properties: Record<string, Schema> = {};
    for (const [k, v] of Object.entries(obj)) properties[k] = infer(v);
    return { type: "object", properties, required: Object.keys(obj).sort() };
  }
  if (typeof value === "number") return { type: "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  return { type: "string" };
}

/** Merge two schemas (union of object properties; intersection of `required`). */
function merge(a: Schema, b: Schema): Schema {
  if (!Object.keys(a).length) return b;
  if (!Object.keys(b).length) return a;
  if (a.type === "object" && b.type === "object") {
    const ap = (a.properties ?? {}) as Record<string, Schema>;
    const bp = (b.properties ?? {}) as Record<string, Schema>;
    const properties: Record<string, Schema> = {};
    for (const k of new Set([...Object.keys(ap), ...Object.keys(bp)])) {
      properties[k] = ap[k] && bp[k] ? merge(ap[k], bp[k]) : (ap[k] ?? bp[k]);
    }
    const ar = new Set((a.required ?? []) as string[]);
    const required = ((b.required ?? []) as string[]).filter((k) => ar.has(k)).sort();
    return { type: "object", properties, required };
  }
  if (a.type === "array" && b.type === "array") {
    return { type: "array", items: merge((a.items ?? {}) as Schema, (b.items ?? {}) as Schema) };
  }
  return a.type ? a : b;
}

function mergeAll(schemas: Schema[]): Schema {
  return schemas.reduce((acc, s) => merge(acc, s), {} as Schema);
}

/**
 * A `<name>Id` field references the table named by its camel-case-to-snake-case
 * prefix (`datasheetId` → `datasheet`, `factionKeywordId` → `faction_keyword`).
 * Returns that table name, or `null` when the field is not a `<name>Id` form.
 */
function foreignKeyTable(field: string): string | null {
  const m = /^(.+)Id$/.exec(field);
  if (!m) return null;
  return m[1].replace(/([A-Z])/g, "_$1").toLowerCase();
}

/** Presence/null/json-type counts for one field across a table's object rows. */
function observeField(rows: readonly Record<string, unknown>[], field: string): Record<string, number> {
  const observed: Record<string, number> = { present: 0, null: 0 };
  for (const row of rows) {
    if (!(field in row)) continue;
    observed.present++;
    const v = row[field];
    if (v === null) {
      observed.null++;
      continue;
    }
    const type = Array.isArray(v) ? "array" : typeof v;
    observed[type] = (observed[type] ?? 0) + 1;
  }
  return observed;
}

/** Copy `description` + `x-40kdc-*` metadata from an annotation onto a schema node. */
function applyAnnotation(target: Schema, annotation: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(annotation)) {
    if (key === "fields") continue; // structural; merged per-field elsewhere
    target[key] = value;
  }
}

/** Build the schema for one `data.<table>` array, with the count/FK extensions. */
function buildTableSchema(
  rows: readonly unknown[],
  tableNames: ReadonlySet<string>,
  annotation: DumpTableAnnotation | undefined,
): Schema {
  const items = rows.length ? mergeAll(rows.map(infer)) : {};
  const objectRows = rows.filter(
    (r): r is Record<string, unknown> => r !== null && typeof r === "object" && !Array.isArray(r),
  );
  if (items.type === "object" && items.properties) {
    const properties = items.properties as Record<string, Schema>;
    for (const field of Object.keys(properties)) {
      const fieldSchema = properties[field];
      fieldSchema["x-40kdc-observed"] = observeField(objectRows, field);
      const fk = foreignKeyTable(field);
      if (fk && tableNames.has(fk)) fieldSchema["x-40kdc-foreign-key"] = { table: fk, field: "id" };
      const fieldAnnotation = annotation?.fields?.[field];
      if (fieldAnnotation) applyAnnotation(fieldSchema, fieldAnnotation);
    }
  }
  const table: Schema = { type: "array", items, "x-40kdc-row-count": rows.length };
  if (annotation) applyAnnotation(table, annotation);
  return table;
}

/**
 * Build the descriptive dump-shape schema from a parsed dump and the declarative
 * annotations. Pure and side-effect-free so it is unit-testable without the
 * private dump or any file I/O.
 */
export function buildDumpSchema(dump: unknown, annotations: DumpSchemaAnnotations): Schema {
  const root = (dump ?? {}) as Record<string, unknown>;
  const dataObject = (root.data ?? {}) as Record<string, unknown>;
  const tableNames = new Set(Object.keys(dataObject));

  const dataProperties: Record<string, Schema> = {};
  for (const [tableName, tableValue] of Object.entries(dataObject)) {
    const annotation = annotations.tables?.[tableName];
    if (Array.isArray(tableValue)) {
      dataProperties[tableName] = buildTableSchema(tableValue, tableNames, annotation);
    } else {
      dataProperties[tableName] = infer(tableValue);
      if (annotation) applyAnnotation(dataProperties[tableName], annotation);
    }
  }
  const dataSchema: Schema = {
    type: "object",
    properties: dataProperties,
    required: Object.keys(dataObject).sort(),
  };

  const rootProperties: Record<string, Schema> = {};
  for (const [key, value] of Object.entries(root)) {
    rootProperties[key] = key === "data" ? dataSchema : infer(value);
  }

  const metadata = root.metadata as Record<string, unknown> | undefined;
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "GW MFM dump shape (generated; IP-safe — keys/types + presence counts only, no values)",
    "x-40kdc-data-version": metadata?.data_version ?? null,
    type: "object",
    properties: rootProperties,
    required: Object.keys(root).sort(),
  };
}

function main(argv: string[]): void {
  const dumpFlag = argv.indexOf("--dump");
  const outFlag = argv.indexOf("--out");
  const dumpPath = dumpFlag >= 0 ? argv[dumpFlag + 1] : DEFAULT_DUMP_PATH;
  const outPath = outFlag >= 0 ? argv[outFlag + 1] : DEFAULT_OUT_PATH;

  const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
  const annotations = JSON.parse(readFileSync(ANNOTATIONS_PATH, "utf8")) as DumpSchemaAnnotations;
  const schema = buildDumpSchema(dump, annotations);
  writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n");
  const tables = Object.keys((dump.data ?? {}) as Record<string, unknown>);
  console.log(
    `Wrote ${outPath} — ${tables.length} dump tables described (data version ${schema["x-40kdc-data-version"]}).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
