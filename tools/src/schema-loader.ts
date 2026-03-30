import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCHEMAS_ROOT = resolve(__dirname, "../../schemas");

/**
 * Recursively find all .schema.json files under a directory.
 */
function findSchemaFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findSchemaFiles(full));
    } else if (entry.endsWith(".schema.json")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Create and configure an AJV instance with all project schemas loaded.
 * Schemas are registered by their $id so $ref resolution works across files.
 */
export function createValidator(): Ajv2020 {
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
  });
  addFormats(ajv);

  const schemaFiles = findSchemaFiles(SCHEMAS_ROOT);
  const schemas = schemaFiles.map((file) => {
    const raw = readFileSync(file, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  });

  // Register all schemas by $id
  for (const schema of schemas) {
    const id = schema["$id"] as string | undefined;
    if (id) {
      ajv.addSchema(schema, id);
    }
  }

  return ajv;
}

/**
 * Return the list of all loaded schema $id values.
 */
export function listSchemaIds(): string[] {
  const schemaFiles = findSchemaFiles(SCHEMAS_ROOT);
  const ids: string[] = [];
  for (const file of schemaFiles) {
    const raw = readFileSync(file, "utf-8");
    const schema = JSON.parse(raw) as Record<string, unknown>;
    if (schema["$id"]) {
      ids.push(schema["$id"] as string);
    }
  }
  return ids;
}
