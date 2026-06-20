import { describe, it, expect } from "vitest";
import { createValidator, listSchemaIds } from "../src/schema-loader.js";

describe("schema-loader", () => {
  it("loads all schemas without errors", () => {
    const ajv = createValidator();
    expect(ajv).toBeDefined();
  });

  it("finds all expected schema $id values", () => {
    const ids = listSchemaIds();
    expect(ids).toContain("https://40kdc.dev/schemas/defs/common.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/defs/game-version-ref.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/faction.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/unit.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/target-profile.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/weapon.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/weapon-keyword.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/unit-keyword.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/game-version.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/detachment.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/allied-rule.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/enhancement.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/stratagem.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/wargear-option.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/wargear.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/leader-attachment.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/unit-composition.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/roster.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/force-disposition.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/deployment-pattern.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/mission.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/mission-matchup.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/secondary-card.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/terrain-template.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/terrain-layout.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/hull-shape.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/enrichment/phase-mapping.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/enrichment/interaction-flag.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/enrichment/ability-dsl/ability.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/enrichment/ability-dsl/condition.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/enrichment/ability-dsl/effect.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/enrichment/ability-dsl/scope.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/enrichment/resource-pool.schema.json");
  });

  it("can retrieve a schema by $id for validation", () => {
    const ajv = createValidator();
    const validate = ajv.getSchema("https://40kdc.dev/schemas/core/faction.schema.json");
    expect(validate).toBeDefined();
    expect(typeof validate).toBe("function");
  });

  it("resolves $ref across schema files", () => {
    const ajv = createValidator();
    const validate = ajv.getSchema("https://40kdc.dev/schemas/core/faction.schema.json");
    expect(validate).toBeDefined();

    // A valid faction should pass
    const valid = validate!({
      id: "test-faction",
      name: "Test Faction",
      game_version: { edition: "10th", dataslate: "2025-q3" },
    });
    expect(valid).toBe(true);

    // An invalid entity-id should fail
    const invalid = validate!({
      id: "INVALID ID",
      name: "Test",
      game_version: { edition: "10th", dataslate: "2025-q3" },
    });
    expect(invalid).toBe(false);
  });

  it("accepts the was-hit-by-attack condition and still rejects unknown types", () => {
    const ajv = createValidator();
    const validate = ajv.getSchema(
      "https://40kdc.dev/schemas/enrichment/ability-dsl/condition.schema.json",
    );
    expect(validate).toBeDefined();

    // The reactive trigger added for "when this unit was hit" rules — the enum
    // gate is why such effect trees were schema-invalid before.
    expect(
      validate!({
        type: "was-hit-by-attack",
        parameters: { subject: "target", weapon_name: "graviton-crusher" },
      }),
    ).toBe(true);

    // The enum is still closed — a fabricated condition type must fail.
    expect(validate!({ type: "was-not-a-real-condition" })).toBe(false);
  });
});
