/**
 * Generate a JSON Schema (draft-07) describing the SHAPE of the GW MFM dump
 * (`_private/dump.json`) — table names, field names, and inferred types. This is
 * the authoritative map of the ~130 dump tables and the single reference the
 * `tools/src/mfm/*` passes should consult before reading a field, so we stop
 * re-discovering the structure ad-hoc (the recurring "is this field here / what
 * shape is it" problem — e.g. locale-keyed `localisations`, the unread
 * `loadout_choice_set.limit`).
 *
 * Shape only — no GW prose is read or emitted (we never traverse into string
 * VALUES, only keys/types), so the output is IP-safe and committed at
 * `tools/src/mfm/dump.schema.json`. Re-run after a dump refresh:
 *
 *   npx tsx tools/src/mfm/gen-dump-schema.ts
 *
 * Inference mirrors a genson-style pass: an array's `items` is the merge of all
 * element schemas; an object's `required` is the set of keys present in EVERY
 * sibling; a `null`/absent value yields the permissive empty schema `{}`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Schema = Record<string, unknown>;

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DUMP_PATH = `${REPO_ROOT}_private/dump.json`;
const OUT_PATH = `${REPO_ROOT}tools/src/mfm/dump.schema.json`;

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

const dump = JSON.parse(readFileSync(DUMP_PATH, "utf8"));
const schema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "GW MFM dump shape (generated; IP-safe — keys/types only, no values)",
  ...infer(dump),
};
writeFileSync(OUT_PATH, JSON.stringify(schema, null, 2) + "\n");
const tables = Object.keys((dump.data ?? {}) as Record<string, unknown>);
console.log(`Wrote ${OUT_PATH} — ${tables.length} dump tables described.`);
