import type Ajv from "ajv";
import { readFileSync } from "node:fs";
import { glob } from "glob";
import { resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DATA_ROOT = resolve(__dirname, "../../data");

export interface ValidationError {
  file: string;
  index: number;
  errors: Array<{ path: string; message: string }>;
}

export interface ValidationResult {
  totalFiles: number;
  totalItems: number;
  passed: number;
  failed: number;
  errors: ValidationError[];
}

/**
 * Map from data file base-name prefix to schema $id.
 */
const SCHEMA_MAP: Record<string, string> = {
  factions: "https://40kdc.dev/schemas/core/faction.schema.json",
  units: "https://40kdc.dev/schemas/core/unit.schema.json",
  "target-profiles": "https://40kdc.dev/schemas/core/target-profile.schema.json",
  weapons: "https://40kdc.dev/schemas/core/weapon.schema.json",
  "weapon-keywords": "https://40kdc.dev/schemas/core/weapon-keyword.schema.json",
  "unit-keywords": "https://40kdc.dev/schemas/core/unit-keyword.schema.json",
  "game-versions": "https://40kdc.dev/schemas/core/game-version.schema.json",
  detachments: "https://40kdc.dev/schemas/core/detachment.schema.json",
  allies: "https://40kdc.dev/schemas/core/allied-rule.schema.json",
  enhancements: "https://40kdc.dev/schemas/core/enhancement.schema.json",
  stratagems: "https://40kdc.dev/schemas/core/stratagem.schema.json",
  "wargear-options": "https://40kdc.dev/schemas/core/wargear-option.schema.json",
  wargear: "https://40kdc.dev/schemas/core/wargear.schema.json",
  "leader-attachments": "https://40kdc.dev/schemas/core/leader-attachment.schema.json",
  "unit-compositions": "https://40kdc.dev/schemas/core/unit-composition.schema.json",
  "force-dispositions": "https://40kdc.dev/schemas/core/force-disposition.schema.json",
  "deployment-patterns": "https://40kdc.dev/schemas/core/deployment-pattern.schema.json",
  "mission-matchups": "https://40kdc.dev/schemas/core/mission-matchup.schema.json",
  missions: "https://40kdc.dev/schemas/core/mission.schema.json",
  "secondary-cards": "https://40kdc.dev/schemas/core/secondary-card.schema.json",
  "terrain-templates": "https://40kdc.dev/schemas/core/terrain-template.schema.json",
  "terrain-layouts": "https://40kdc.dev/schemas/core/terrain-layout.schema.json",
  "hull-shapes": "https://40kdc.dev/schemas/core/hull-shape.schema.json",
  "phase-mappings": "https://40kdc.dev/schemas/enrichment/phase-mapping.schema.json",
  "interaction-flags": "https://40kdc.dev/schemas/enrichment/interaction-flag.schema.json",
  abilities: "https://40kdc.dev/schemas/enrichment/ability-dsl/ability.schema.json",
  "resource-pools": "https://40kdc.dev/schemas/enrichment/resource-pool.schema.json",
};

/**
 * Determine which schema $id to use for a given data file path.
 * Convention: the file's base name starts with a SCHEMA_MAP prefix (real data is
 * `<prefix>.json`; test fixtures are `<prefix>-good.json` / `<prefix>-bad.json`).
 * Prefixes are tried longest-first so `wargear-options.json` resolves to the
 * wargear-option schema rather than the shorter `wargear` key (distinct entities).
 */
const SCHEMA_PREFIXES = Object.keys(SCHEMA_MAP).sort((a, b) => b.length - a.length);
function resolveSchemaId(filePath: string): string | null {
  const base = basename(filePath);
  for (const prefix of SCHEMA_PREFIXES) {
    if (base.startsWith(prefix)) return SCHEMA_MAP[prefix];
  }
  return null;
}

/**
 * Validate all data files matching the given glob pattern.
 * Each data file is expected to be a JSON array; each element is validated individually.
 */
export async function validateFiles(
  ajv: Ajv,
  pattern: string,
  cwd?: string,
): Promise<ValidationResult> {
  const root = cwd ?? DATA_ROOT;
  const files = await glob(pattern, { cwd: root, absolute: true });

  const result: ValidationResult = {
    totalFiles: files.length,
    totalItems: 0,
    passed: 0,
    failed: 0,
    errors: [],
  };

  for (const file of files) {
    // Underscore-prefixed files are scratch/reports (e.g. the converter's
    // `_wargear-options.unparsed.json`), not dataset entities — skip them.
    if (basename(file).startsWith("_")) continue;
    const schemaId = resolveSchemaId(file);
    if (!schemaId) {
      result.errors.push({
        file,
        index: -1,
        errors: [{ path: "", message: `No schema mapping found for file: ${basename(file)}` }],
      });
      result.failed++;
      continue;
    }

    const validate = ajv.getSchema(schemaId);
    if (!validate) {
      result.errors.push({
        file,
        index: -1,
        errors: [{ path: "", message: `Schema not found: ${schemaId}` }],
      });
      result.failed++;
      continue;
    }

    let data: unknown;
    try {
      const raw = readFileSync(file, "utf-8");
      data = JSON.parse(raw);
    } catch (err) {
      result.errors.push({
        file,
        index: -1,
        errors: [{ path: "", message: `Failed to parse JSON: ${(err as Error).message}` }],
      });
      result.failed++;
      continue;
    }

    if (!Array.isArray(data)) {
      result.errors.push({
        file,
        index: -1,
        errors: [{ path: "", message: "Data file must be a JSON array" }],
      });
      result.failed++;
      continue;
    }

    for (let i = 0; i < data.length; i++) {
      result.totalItems++;
      const valid = validate(data[i]);
      if (valid) {
        result.passed++;
      } else {
        result.failed++;
        result.errors.push({
          file,
          index: i,
          errors: (validate.errors ?? []).map((e) => ({
            path: e.instancePath || "/",
            message: e.message ?? "Unknown validation error",
          })),
        });
      }
    }
  }

  return result;
}
