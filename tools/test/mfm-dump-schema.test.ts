/**
 * Descriptive MFM dump-schema generator tests. Exercises `buildDumpSchema`
 * against a hand-built mini dump (no private JSON), proving: type/`required`
 * inference is unchanged; the `x-40kdc-*` presence/count and foreign-key
 * extensions are correct; the committed annotations merge in; and — critically —
 * no row VALUE (name / localisation prose) ever reaches the generated schema.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { buildDumpSchema } from "../src/mfm/gen-dump-schema.js";
import type { DumpSchemaAnnotations } from "../src/mfm/gen-dump-schema.js";

const annotations = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/mfm/dump.schema.annotations.json", import.meta.url)), "utf8"),
) as DumpSchemaAnnotations;

// Distinctive sentinels: if either string leaks into the generated schema the
// generator is emitting VALUES, not just shape/counts.
const FIXTURE_NAME = "FIXTURE_DATASHEET_NAME_ZZZ";
const FIXTURE_RULES = "FIXTURE_RULES_PROSE_QWX";

const miniDump = {
  metadata: { data_version: 867 },
  data: {
    datasheet: [{ id: "ds-1", name: FIXTURE_NAME }],
    invulnerable_save: [
      {
        id: "inv-1",
        datasheetId: "ds-1",
        miniatureId: null,
        save: "5+",
        rangedSave: null,
        meleeSave: null,
        localisations: { en: { rules: FIXTURE_RULES } },
      },
      { id: "inv-2", datasheetId: "ds-2", save: "4+" },
      { id: "inv-3", datasheetId: "ds-3", miniatureId: "m-1", save: null, rangedSave: "5+", meleeSave: null },
    ],
  },
};

const schema = buildDumpSchema(miniDump, annotations);
const dataProps = (schema.properties as Record<string, any>).data.properties as Record<string, any>;
const invTable = dataProps.invulnerable_save;
const invFields = invTable.items.properties as Record<string, any>;

describe("buildDumpSchema — type + required inference (unchanged)", () => {
  it("infers primitive field types from row values", () => {
    expect(invFields.save.type).toBe("string");
    expect(invFields.datasheetId.type).toBe("string");
    expect((schema.properties as Record<string, any>).metadata.properties.data_version.type).toBe("number");
  });

  it("computes object `required` as the intersection of keys present in every row", () => {
    expect(invTable.items.required).toEqual(["datasheetId", "id", "save"]);
  });
});

describe("buildDumpSchema — x-40kdc presence/count extensions", () => {
  it("records the data version at the root", () => {
    expect(schema["x-40kdc-data-version"]).toBe(867);
  });

  it("records the per-table row count", () => {
    expect(invTable["x-40kdc-row-count"]).toBe(3);
  });

  it("counts present / null / json-type occurrences per field", () => {
    expect(invFields.save["x-40kdc-observed"]).toEqual({ present: 3, null: 1, string: 2 });
    expect(invFields.miniatureId["x-40kdc-observed"]).toEqual({ present: 2, null: 1, string: 1 });
    expect(invFields.rangedSave["x-40kdc-observed"]).toEqual({ present: 2, null: 1, string: 1 });
  });
});

describe("buildDumpSchema — foreign-key inference", () => {
  it("links a <name>Id field to an existing snake_case table", () => {
    expect(invFields.datasheetId["x-40kdc-foreign-key"]).toEqual({ table: "datasheet", field: "id" });
  });

  it("does not invent a foreign key when the referenced table is absent", () => {
    // No `miniature` table in the mini dump → no FK for miniatureId.
    expect(invFields.miniatureId["x-40kdc-foreign-key"]).toBeUndefined();
  });
});

describe("buildDumpSchema — annotation merge", () => {
  it("merges the committed invulnerable_save descriptions and scope metadata", () => {
    expect(typeof invTable.description).toBe("string");
    expect(invFields.save.description).toContain("Unconditional");
    expect(invFields.save["x-40kdc-scope"]).toBe("unconditional");
    expect(invFields.rangedSave["x-40kdc-scope"]).toBe("ranged");
    expect(invFields.meleeSave["x-40kdc-scope"]).toBe("melee");
  });
});

describe("buildDumpSchema — IP safety", () => {
  it("never emits any row value (name or localisation prose)", () => {
    const serialized = JSON.stringify(buildDumpSchema(miniDump, annotations));
    expect(serialized).not.toContain(FIXTURE_NAME);
    expect(serialized).not.toContain(FIXTURE_RULES);
  });
});
