import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  enumerateEntityPointers,
  validateSourceMappings,
  type DumpCatalog,
} from "../src/mfm/gen-dump-schema.js";
import { REPO_ROOT } from "../src/mfm/repo-files.js";

const MFM_DIR = path.resolve(import.meta.dirname, "../src/mfm");
const MAPPINGS_DIR = path.join(MFM_DIR, "mappings");
const CATALOG = JSON.parse(readFileSync(path.join(MFM_DIR, "dump.catalog.json"), "utf8")) as DumpCatalog;
const UNIT_MAPPING = JSON.parse(
  readFileSync(path.join(MAPPINGS_DIR, "unit.mapping.json"), "utf8"),
) as { fields: Record<string, Record<string, unknown>> };
const temporaryDirectories: string[] = [];

function temporaryMappingDirectory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mfm-source-mappings-"));
  temporaryDirectories.push(root);
  cpSync(MAPPINGS_DIR, path.join(root, "mappings"), { recursive: true });
  cpSync(path.join(MFM_DIR, "mfm-source-map.schema.json"), path.join(root, "mfm-source-map.schema.json"));
  return path.join(root, "mappings");
}

function mutateUnitMapping(
  mappingsDirectory: string,
  mutate: (mapping: Record<string, unknown>) => void,
): void {
  const file = path.join(mappingsDirectory, "unit.mapping.json");
  const mapping = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  mutate(mapping);
  writeFileSync(file, `${JSON.stringify(mapping, null, 2)}\n`);
}

function unitMappingDiagnostic(mappingsDirectory: string, detail: string): string {
  const file = path.relative(REPO_ROOT, path.join(mappingsDirectory, "unit.mapping.json"));
  return `MFM source-map ${file}: ${detail}`;
}

function readMapping(name: string): {
  root_tables: string[];
  fields: Record<string, Record<string, unknown>>;
} {
  return JSON.parse(readFileSync(path.join(MAPPINGS_DIR, `${name}.mapping.json`), "utf8")) as {
    root_tables: string[];
    fields: Record<string, Record<string, unknown>>;
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("entity schema pointer enumeration", () => {
  it("walks nested objects, arrays, nullable unions, and local refs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mfm-pointer-walker-"));
    temporaryDirectories.push(root);
    const schemaPath = path.join(root, "fixture.schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({
        type: "object",
        properties: {
          scalar: { type: "string" },
          nested: { type: "object", properties: { value: { type: "integer" } } },
          list: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } },
          maybe: {
            oneOf: [
              { type: "null" },
              { type: "object", properties: { flag: { type: "boolean" } } },
            ],
          },
          shared: { $ref: "#/$defs/shared" },
        },
        $defs: { shared: { type: "object", properties: { x: { type: "number" } } } },
      }),
    );

    expect(enumerateEntityPointers(schemaPath)).toEqual([
      "/list",
      "/list/*",
      "/list/*/id",
      "/maybe",
      "/maybe/flag",
      "/nested",
      "/nested/value",
      "/scalar",
      "/shared",
      "/shared/x",
    ]);
  });
});

describe("committed MFM source mappings", () => {
  it("cover every core entity pointer and pass source, relation, purpose, and meta-schema checks", () => {
    const report = validateSourceMappings(CATALOG, MAPPINGS_DIR);
    expect(report.errors).toEqual([]);
    expect(report.present).toBe(report.total);
    expect(report.total).toBe(25);
  });

  it("pins the partial invulnerable-save provenance and consumer precedence", () => {
    expect(UNIT_MAPPING.fields["/profiles/*/invuln_sv"]).toEqual({
      provenance: "derived",
      coverage: "partial",
      sources: ["data.invulnerable_save.save"],
      joins: [
        {
          relation: "invulnerable_save.datasheetId",
          direction: "children",
          purpose: "general",
        },
      ],
      transforms: [
        {
          symbol: "tools/src/mfm/gear-projection.ts#parseSkill",
          operation: "Parse a structured save value into the nullable integer profile field.",
        },
      ],
      filters: [
        "Use only rows for the current datasheet and only whole-unit or safely normalizable scopes; seed a destination only when its profile field is null, except that a recognized scoped source clears a stale unconditional value.",
      ],
      precedence: [
        "Recognized scoped sources clear stale unconditional values; otherwise existing non-null profile values win. Conflicting universal source values fail.",
      ],
      consumers: [
        "tools/src/mfm/project-loadout.ts#projectUnit",
        "tools/src/mfm/project-loadout.ts#main",
      ],
      reason:
        "Coverage is partial: this pass seeds representable whole-unit profile fields, while model-specific rows and prose-only caveats remain unprojected warnings.",
    });
  });

  it("pins representative unit, roster-runtime, and mission source decisions", () => {
    expect(UNIT_MAPPING.fields["/points/*/unit_count_min"]).toMatchObject({
      provenance: "derived",
      coverage: "implemented",
      sources: expect.arrayContaining([
        "data.unit_composition.points",
        "data.datasheet_points_step.stepAt",
      ]),
    });
    expect(UNIT_MAPPING.fields["/wargear_budgets/*/per_models"]).toMatchObject({
      provenance: "derived",
      coverage: "partial",
      sources: ["data.wargear_limit.choiceLimit", "data.wargear_limit.modelCount", "data.wargear_limit.duplicateLimit"],
    });
    expect(UNIT_MAPPING.fields["/transport_capacity/capacity"]).toMatchObject({
      provenance: "not-in-mfm",
      coverage: "unimplemented",
      sources: [],
      joins: [],
    });
    expect(UNIT_MAPPING.fields["/game_version/edition"]).toMatchObject({
      provenance: "repo-authored",
      coverage: "implemented",
      sources: [],
    });
    expect(UNIT_MAPPING.fields["/game_modes/*"]).toMatchObject({
      provenance: "derived",
      coverage: "implemented",
      sources: ["data.publication.isCombatPatrol"],
    });

    const roster = readMapping("roster");
    const runtimeFields = Object.values(roster.fields).filter((field) => field.provenance === "runtime-input");
    expect(runtimeFields.length).toBeGreaterThan(0);
    for (const field of runtimeFields) {
      expect(field.coverage).toBe("not-applicable");
      expect(field.sources).toEqual([]);
      expect(field.joins).toEqual([]);
    }

    const mission = readMapping("mission");
    expect(mission.root_tables).toEqual(["primary_mission"]);
    const cards = readMapping("secondary-card");
    expect(cards.root_tables).toEqual(
      expect.arrayContaining(["primary_mission", "secondary_mission"]),
    );
    expect(cards.fields["/card_type"]).toMatchObject({
      provenance: "derived",
      sources: ["data.primary_mission.id", "data.secondary_mission.id"],
      filters: ["Exclude primary_mission rows whose detachmentId is non-null."],
    });
  });

  it("reports missing and extra entity pointers exactly", () => {
    const missingDirectory = temporaryMappingDirectory();
    mutateUnitMapping(missingDirectory, (mapping) => {
      delete (mapping.fields as Record<string, unknown>)["/id"];
    });
    expect(validateSourceMappings(CATALOG, missingDirectory).errors).toContain(
      unitMappingDiagnostic(missingDirectory, "missing field mapping for /id"),
    );

    const extraDirectory = temporaryMappingDirectory();
    mutateUnitMapping(extraDirectory, (mapping) => {
      (mapping.fields as Record<string, unknown>)["/not-in-schema"] = {
        provenance: "repo-authored",
        coverage: "unimplemented",
        sources: [],
        joins: [],
        transforms: [],
        filters: [],
        precedence: [],
        consumers: [],
        reason: "Fixture-only invalid pointer.",
      };
    });
    expect(validateSourceMappings(CATALOG, extraDirectory).errors).toContain(
      unitMappingDiagnostic(extraDirectory, "extra field mapping for /not-in-schema"),
    );
  });

  it("reports unknown source paths and non-verified implemented joins", () => {
    const sourceDirectory = temporaryMappingDirectory();
    mutateUnitMapping(sourceDirectory, (mapping) => {
      const id = (mapping.fields as Record<string, Record<string, unknown>>)["/id"];
      id.sources = ["data.not_a_table.not_a_field"];
    });
    expect(validateSourceMappings(CATALOG, sourceDirectory).errors).toContain(
      unitMappingDiagnostic(sourceDirectory, "unknown source path data.not_a_table.not_a_field"),
    );

    const joinDirectory = temporaryMappingDirectory();
    mutateUnitMapping(joinDirectory, (mapping) => {
      const alliedPoints = (mapping.fields as Record<string, Record<string, unknown>>)["/allied_points"];
      alliedPoints.joins = [
        { relation: "allied_faction.requiredWarlordMiniatureId", direction: "parent", purpose: "general" },
      ];
    });
    expect(validateSourceMappings(CATALOG, joinDirectory).errors).toContain(
      'Mapping "unit" field "/allied_points": implemented join "allied_faction.requiredWarlordMiniatureId" is not verified',
    );
  });

  it("fails closed on a missing meta-schema and enforces provenance/consumer invariants", () => {
    const missingSchemaDirectory = temporaryMappingDirectory();
    rmSync(path.join(path.dirname(missingSchemaDirectory), "mfm-source-map.schema.json"));
    expect(validateSourceMappings(CATALOG, missingSchemaDirectory).errors).toContain(
      `Missing MFM source-map schema "${path.relative(REPO_ROOT, path.join(path.dirname(missingSchemaDirectory), "mfm-source-map.schema.json"))}"`,
    );

    const noSourceDirectory = temporaryMappingDirectory();
    mutateUnitMapping(noSourceDirectory, (mapping) => {
      const id = (mapping.fields as Record<string, Record<string, unknown>>)["/id"];
      id.provenance = "direct";
      id.sources = [];
    });
    expect(validateSourceMappings(CATALOG, noSourceDirectory).errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/unit.*sources must NOT have fewer than 1 items/)]),
    );

    const noConsumerDirectory = temporaryMappingDirectory();
    mutateUnitMapping(noConsumerDirectory, (mapping) => {
      const id = (mapping.fields as Record<string, Record<string, unknown>>)["/id"];
      id.coverage = "implemented";
      id.consumers = [];
    });
    expect(validateSourceMappings(CATALOG, noConsumerDirectory).errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/unit.*consumers must NOT have fewer than 1 items/)]),
    );

    const runtimeDirectory = temporaryMappingDirectory();
    mutateUnitMapping(runtimeDirectory, (mapping) => {
      const id = (mapping.fields as Record<string, Record<string, unknown>>)["/id"];
      id.provenance = "runtime-input";
      id.coverage = "unimplemented";
      id.sources = [];
      id.joins = [];
    });
    expect(validateSourceMappings(CATALOG, runtimeDirectory).errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/unit.*coverage must be equal to constant/)]),
    );
  });

  it("rejects direct prose, implemented artwork, and ownership-mislabeled applicability joins", () => {
    const proseDirectory = temporaryMappingDirectory();
    mutateUnitMapping(proseDirectory, (mapping) => {
      const id = (mapping.fields as Record<string, Record<string, unknown>>)["/id"];
      id.provenance = "direct";
      id.sources = ["data.allegiance_ability.localisations.*.rules"];
    });
    expect(validateSourceMappings(CATALOG, proseDirectory).errors).toContain(
      'Mapping "unit" field "/id": prose source "data.allegiance_ability.localisations.*.rules" cannot be direct entity data',
    );

    const artworkDirectory = temporaryMappingDirectory();
    mutateUnitMapping(artworkDirectory, (mapping) => {
      const id = (mapping.fields as Record<string, Record<string, unknown>>)["/id"];
      id.coverage = "implemented";
      id.sources = ["data.datasheet.bannerImage"];
    });
    expect(validateSourceMappings(CATALOG, artworkDirectory).errors).toContain(
      'Mapping "unit" field "/id": artwork source "data.datasheet.bannerImage" cannot be implemented entity data',
    );

    const purposeDirectory = temporaryMappingDirectory();
    mutateUnitMapping(purposeDirectory, (mapping) => {
      const id = (mapping.fields as Record<string, Record<string, unknown>>)["/id"];
      id.joins = [
        {
          relation: "detachment_faction_keyword.detachmentId",
          direction: "parent",
          purpose: "ownership",
        },
      ];
    });
    expect(validateSourceMappings(CATALOG, purposeDirectory).errors).toContain(
      'Mapping "unit" field "/id": join "detachment_faction_keyword.detachmentId" purpose "ownership" differs from catalog meaning "applicability"',
    );
  });
});
