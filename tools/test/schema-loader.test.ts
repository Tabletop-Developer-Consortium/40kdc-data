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
    expect(ids).toContain(
      "https://40kdc.dev/schemas/defs/game-version-ref.schema.json",
    );
    expect(ids).toContain("https://40kdc.dev/schemas/core/faction.schema.json");
    expect(ids).toContain("https://40kdc.dev/schemas/core/unit.schema.json");
    expect(ids).toContain(
      "https://40kdc.dev/schemas/core/target-profile.schema.json",
    );
    expect(ids).toContain("https://40kdc.dev/schemas/core/weapon.schema.json");
    expect(ids).toContain(
      "https://40kdc.dev/schemas/core/weapon-keyword.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/core/unit-keyword.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/core/game-version.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/core/detachment.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/core/allied-rule.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/core/enhancement.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/core/stratagem.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/core/wargear-option.schema.json",
    );
    expect(ids).toContain("https://40kdc.dev/schemas/core/wargear.schema.json");
    expect(ids).toContain(
      "https://40kdc.dev/schemas/core/leader-attachment.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/core/unit-composition.schema.json",
    );
    expect(ids).toContain("https://40kdc.dev/schemas/core/roster.schema.json");
    expect(ids).toContain(
      "https://40kdc.dev/schemas/core/force-disposition.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/core/game-mode.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/core/deployment-pattern.schema.json",
    );
    expect(ids).toContain("https://40kdc.dev/schemas/core/mission.schema.json");
    expect(ids).toContain(
      "https://40kdc.dev/schemas/core/mission-matchup.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/core/secondary-card.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/core/terrain-template.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/core/terrain-layout.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/core/hull-shape.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/enrichment/phase-mapping.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/enrichment/interaction-flag.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/enrichment/ability-dsl/ability.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/enrichment/ability-dsl/condition.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/enrichment/ability-dsl/effect.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/enrichment/ability-dsl/scope.schema.json",
    );
    expect(ids).toContain(
      "https://40kdc.dev/schemas/enrichment/resource-pool.schema.json",
    );
  });

  it("can retrieve a schema by $id for validation", () => {
    const ajv = createValidator();
    const validate = ajv.getSchema(
      "https://40kdc.dev/schemas/core/faction.schema.json",
    );
    expect(validate).toBeDefined();
    expect(typeof validate).toBe("function");
  });

  it("resolves $ref across schema files", () => {
    const ajv = createValidator();
    const validate = ajv.getSchema(
      "https://40kdc.dev/schemas/core/faction.schema.json",
    );
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

  it("validates open, locally unique external references", () => {
    const ajv = createValidator();
    const validate = ajv.getSchema(
      "https://40kdc.dev/schemas/core/faction.schema.json",
    );
    expect(validate).toBeDefined();
    const faction = {
      id: "test-faction",
      name: "Test Faction",
      game_version: { edition: "11th", dataslate: "test" },
    };
    const refs = [
      { namespace: "future-source", id: "record-1" },
      { namespace: "future-source", id: "record-2" },
    ];

    expect(validate!({ ...faction, external_refs: refs })).toBe(true);
    expect(
      validate!({
        ...faction,
        external_refs: [refs[0], refs[0]],
      }),
    ).toBe(false);
    expect(
      validate!({
        ...faction,
        external_refs: [{ namespace: "", id: "record-1" }],
      }),
    ).toBe(false);
    expect(
      validate!({
        ...faction,
        external_refs: [{ namespace: "future-source", id: "" }],
      }),
    ).toBe(false);

    // Cross-entity fan-out is valid: uniqueness is intentionally local.
    expect(validate!({ ...faction, external_refs: [refs[0]] })).toBe(true);
    expect(
      validate!({
        ...faction,
        id: "second-faction",
        external_refs: [refs[0]],
      }),
    ).toBe(true);
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

  it("gates the optional game_modes field to the game-mode enum (absent implies matched-play)", () => {
    const ajv = createValidator();
    const validate = ajv.getSchema(
      "https://40kdc.dev/schemas/core/detachment.schema.json",
    );
    expect(validate).toBeDefined();

    const base = {
      id: "test-detachment",
      name: "Test Detachment",
      faction_id: "test-faction",
      game_version: { edition: "11th", dataslate: "pre-launch-provisional" },
    };

    // Absent game_modes is legal — the matched-play default keeps existing data valid.
    expect(validate!({ ...base })).toBe(true);
    // A known non-competitive mode is legal.
    expect(validate!({ ...base, game_modes: ["combat-patrol"] })).toBe(true);
    // The enum is closed — a fabricated mode must fail.
    expect(validate!({ ...base, game_modes: ["not-a-mode"] })).toBe(false);
    // The array must be non-empty and its members unique.
    expect(validate!({ ...base, game_modes: [] })).toBe(false);
    expect(
      validate!({ ...base, game_modes: ["combat-patrol", "combat-patrol"] }),
    ).toBe(false);
  });

  it("rejects empty required-any keyword restrictions", () => {
    const ajv = createValidator();
    const validate = ajv.getSchema(
      "https://40kdc.dev/schemas/core/weapon.schema.json",
    );
    expect(validate).toBeDefined();
    const profile = {
      name: "Test profile",
      stats: { A: 1, S: 4, AP: 0, D: 1 },
    };
    const weapon = {
      id: "test-weapon",
      name: "Test Weapon",
      type: "ranged",
      profiles: [profile],
      game_version: { edition: "11th", dataslate: "test" },
    };
    expect(validate!(weapon)).toBe(true);
    expect(
      validate!({
        ...weapon,
        profiles: [
          {
            ...profile,
            target_restrictions: { required_keywords_any: [] },
          },
        ],
      }),
    ).toBe(false);
    expect(
      validate!({
        ...weapon,
        profiles: [
          {
            ...profile,
            keywords: [
              {
                keyword_id: "lethal-hits",
                parameters: { required_target_keywords_any: [] },
              },
            ],
          },
        ],
      }),
    ).toBe(false);
  });

  it("validates closed dice-table effects", () => {
    const ajv = createValidator();
    const validate = ajv.getSchema(
      "https://40kdc.dev/schemas/enrichment/ability-dsl/effect.schema.json",
    );
    expect(validate).toBeDefined();
    const outcomes = [
      {
        results: [1, 2, 3],
        effect: {
          type: "mortal-wounds",
          target: "target",
          modifier: { count: "D3" },
        },
      },
      {
        results: [4, 5],
        effect: {
          type: "mortal-wounds",
          target: "target",
          modifier: { count: 3 },
        },
      },
      {
        results: [6],
        effect: {
          type: "mortal-wounds",
          target: "target",
          modifier: { count: "D3+3" },
        },
      },
    ];
    expect(validate!({ type: "dice-table", dice: "D6", outcomes })).toBe(true);
    expect(validate!({ type: "dice-table", dice: "D8", outcomes })).toBe(false);
    expect(
      validate!({
        type: "dice-table",
        dice: "D6",
        outcomes: [{ results: [1] }, outcomes[1]],
      }),
    ).toBe(false);
  });
  it("rejects named-region lifecycle, control, and precedence drift", () => {
    const ajv = createValidator();
    const validate = ajv.getSchema(
      "https://40kdc.dev/schemas/enrichment/ability-dsl/effect.schema.json",
    );
    expect(validate).toBeDefined();
    const regionRef = {
      region_id: "fixture-region",
      owner_faction: "fixture-faction",
    };
    const producer = {
      region_ref: regionRef,
      mode: "complete",
      parent_ref: null,
      baseline: [
        {
          kind: "fixed-zone",
          zone: "own-deployment-zone",
          activation: { event: "always-active" },
          expiry: { event: "never" },
        },
      ],
      phase_extensions: [
        {
          kind: "objective-majority-zone",
          zone: "no-mans-land",
          control_gate: {
            marker_scope: "markers-in-zone",
            controlled_by: "owner-army",
            threshold: { comparison: "at-least", fraction: 0.5 },
          },
          activation: {
            event: "phase-start",
            evaluation: "snapshot-once",
            canonical_condition_ids: ["timing-is", "objective-majority"],
          },
          expiry: { event: "phase-end" },
        },
        {
          kind: "objective-majority-zone",
          zone: "opponent-deployment-zone",
          control_gate: {
            marker_scope: "markers-in-zone",
            controlled_by: "owner-army",
            threshold: { comparison: "at-least", fraction: 0.5 },
          },
          activation: {
            event: "phase-start",
            evaluation: "snapshot-once",
            canonical_condition_ids: ["timing-is", "objective-majority"],
          },
          expiry: { event: "phase-end" },
        },
      ],
      additive_extensions: [],
    };
    const branch = (effect: Record<string, unknown>) => ({
      source: { role: "eligible-source", gate_ref: "beneficiary_gate" },
      beneficiary: {
        role: "eligible-beneficiary",
        gate_ref: "beneficiary_gate",
      },
      target: "attacker",
      timing: { event: "each-attack" },
      duration: "attack-resolution",
      effect,
      optional: true,
    });
    const valid = {
      type: "named-region-state",
      target: "all-friendly",
      modifier: {
        region_ref: regionRef,
        producer,
        consumer: {
          state_ref: regionRef,
          beneficiary_gate: {
            owner: "owner-army",
            faction: "fixture-faction",
            operator: "or",
            keywords: ["FIXTURE"],
          },
          membership: { unit_scope: "model", relation: "within" },
          qualified_condition: {
            type: "region-membership",
            parameters: { unit_scope: "model", relation: "within" },
          },
          default_branch: branch({
            type: "re-roll",
            target: "attacker",
            modifier: { roll: "hit", subset: "ones" },
          }),
          qualified_branch: branch({
            type: "roll-modifier",
            target: "attacker",
            modifier: { operation: "add", value: 1, roll: "wound" },
          }),
        },
        branch_precedence: "qualified-replaces-default",
      },
    };
    expect(validate!(valid)).toBe(true);
    expect(
      validate!({
        ...valid,
        modifier: {
          ...valid.modifier,
          producer: {
            ...producer,
            phase_extensions: [
              producer.phase_extensions[0],
              producer.phase_extensions[0],
            ],
          },
        },
      }),
    ).toBe(false);
    expect(
      validate!({
        ...valid,
        modifier: {
          ...valid.modifier,
          producer: {
            ...producer,
            phase_extensions: [
              {
                ...producer.phase_extensions[0],
                zone: "opponent-deployment-zone",
              },
              producer.phase_extensions[1],
            ],
          },
        },
      }),
    ).toBe(false);
    expect(
      validate!({
        ...valid,
        modifier: {
          ...valid.modifier,
          producer: {
            ...producer,
            phase_extensions: [producer.phase_extensions[0]],
          },
        },
      }),
    ).toBe(false);
    expect(
      validate!({
        ...valid,
        modifier: {
          ...valid.modifier,
          branch_precedence: "qualified-adds-to-default",
        },
      }),
    ).toBe(false);
    expect(
      validate!({
        ...valid,
        modifier: {
          ...valid.modifier,
          producer: {
            ...producer,
            baseline: [
              { ...producer.baseline[0], activation: { event: "phase-start" } },
            ],
          },
        },
      }),
    ).toBe(false);
    expect(
      validate!({
        ...valid,
        modifier: {
          ...valid.modifier,
          producer: {
            ...producer,
            phase_extensions: [
              {
                ...producer.phase_extensions[0],
                control_gate: {
                  ...producer.phase_extensions[0].control_gate,
                  threshold: { comparison: "at-least", fraction: 0.25 },
                },
              },
              producer.phase_extensions[1],
            ],
          },
        },
      }),
    ).toBe(false);
  });
  it("restricts persistent designations to the renderer-supported seed contract", () => {
    const validate = createValidator().getSchema(
      "https://40kdc.dev/schemas/enrichment/ability-dsl/effect.schema.json",
    );
    expect(validate).toBeDefined();
    const valid = {
      type: "persistent-designation",
      designation: "fixture-target",
      select: {
        scope: "enemy-unit",
        timing: "start-of-first-battle-round",
        selection_policy: "one-time",
      },
      consumer: {
        relation: "attacks-selected-unit",
        beneficiary: "bearer",
        effect: {
          type: "re-roll",
          target: "bearer",
          modifier: { roll: "hit", subset: "all-failures" },
        },
      },
      duration: "battle",
    };
    expect(validate!(valid)).toBe(true);
    expect(
      validate!({
        ...valid,
        consumer: { ...valid.consumer, beneficiary: "friendly-attackers" },
      }),
    ).toBe(false);
    expect(
      validate!({
        ...valid,
        consumer: { ...valid.consumer, relation: "within-selected-marker" },
      }),
    ).toBe(false);
    expect(
      validate!({
        ...valid,
        select: { ...valid.select, scope: "objective-marker" },
        consumer: { ...valid.consumer, relation: "within-selected-marker" },
      }),
    ).toBe(true);
  });
  it("enforces discriminated Transport occupancy contracts", () => {
    const validate = createValidator().getSchema(
      "https://40kdc.dev/schemas/enrichment/ability-dsl/effect.schema.json",
    );
    expect(validate).toBeDefined();
    const groupedSingle = {
      type: "transport-capacity-conversion",
      target: "self",
      modifier: {
        occupancy_kind: "grouped-models",
        subject_kind: "single-model",
        models_per_group: 1,
        spaces_per_group: 2,
        rounding: "up",
      },
    };
    expect(validate!(groupedSingle)).toBe(true);
    expect(
      validate!({
        ...groupedSingle,
        modifier: { ...groupedSingle.modifier, models_per_group: 2 },
      }),
    ).toBe(false);

    const fixed = {
      type: "transport-capacity-conversion",
      target: "unit",
      modifier: {
        occupancy_kind: "fixed-model-spaces",
        subject_kind: "unit-models",
        spaces_per_model: 3,
        transport_eligibility: { requires_capacity_keyword: "TERMINATOR" },
      },
    };
    expect(validate!(fixed)).toBe(true);
    expect(
      validate!({
        ...fixed,
        modifier: {
          ...fixed.modifier,
          transport_eligibility: {
            requires_capacity_keyword: "TERMINATOR",
            embark_as_keyword: "INFANTRY",
          },
        },
      }),
    ).toBe(false);

    const equivalent = {
      type: "transport-capacity-conversion",
      target: "unit",
      modifier: {
        occupancy_kind: "equivalent-model",
        subject_kind: "unit-models",
        equivalent_model_keyword: "TERMINATOR",
      },
    };
    expect(validate!(equivalent)).toBe(true);
    expect(
      validate!({
        ...equivalent,
        modifier: {
          ...equivalent.modifier,
          equivalent_model_count: 2,
        },
      }),
    ).toBe(false);
  });

  it("requires entity identity on reusable rules-bundle grants", () => {
    const validate = createValidator().getSchema(
      "https://40kdc.dev/schemas/enrichment/ability-dsl/effect.schema.json",
    );
    expect(validate).toBeDefined();
    const valid = {
      type: "ability-grant",
      target: "unit",
      modifier: { ability_id: "shared-rules", rules_bundle: true },
    };

    expect(validate!(valid)).toBe(true);
    expect(validate!({ ...valid, modifier: { rules_bundle: true } })).toBe(
      false,
    );
    expect(
      validate!({
        ...valid,
        modifier: { ability_id: "Not An Entity", rules_bundle: true },
      }),
    ).toBe(false);
  });
});
