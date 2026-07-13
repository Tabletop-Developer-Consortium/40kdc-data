import { describe, expect, it } from "vitest";
import { findRegressions, type AtcAuditReport } from "../src/audit-atc.js";

function report(overrides: Partial<AtcAuditReport["headline"]> = {}): AtcAuditReport {
  return {
    generatedFrom: "test",
    corpus: [],
    headline: {
      lists: 10,
      parse_failures: 1,
      lists_with_violations: 2,
      violating_units: 3,
      warnings_by_code: { "weapon-unresolved": 5 },
      violations_by_code: { "exceeds-max": 3 },
      grouping_by_outcome: {
        grouped: 4,
        "unit-unresolved": 1,
        "wargear-unresolved": 2,
        "single-model": 2,
        "no-recorded-defaults": 0,
        "solver-null": 1,
      },
      composition_drift_units: 2,
      ...overrides,
    },
    parse_failures: [],
    violations: [],
    unresolved_names: {},
    solver_null_units: [],
    composition_drift: [],
  };
}

describe("findRegressions", () => {
  it("returns nothing when counts are unchanged", () => {
    expect(findRegressions(report(), report())).toEqual([]);
  });

  it("treats decreases and disappearances as improvements", () => {
    const fresh = report({
      parse_failures: 0,
      violating_units: 0,
      warnings_by_code: {},
      violations_by_code: {},
      composition_drift_units: 0,
    });
    expect(findRegressions(report(), fresh)).toEqual([]);
  });

  it("flags scalar increases", () => {
    const fresh = report({ parse_failures: 2 });
    expect(findRegressions(report(), fresh)).toEqual(["parse_failures: 1 → 2"]);
  });

  it("flags per-code increases and newly-appearing codes", () => {
    const fresh = report({
      warnings_by_code: { "weapon-unresolved": 6, "loadout-illegal": 1 },
    });
    expect(findRegressions(report(), fresh)).toEqual([
      "warnings.weapon-unresolved: 5 → 6",
      "warnings.loadout-illegal: 0 → 1",
    ]);
  });

  it("never flags growth in the grouped bucket", () => {
    const fresh = report({
      grouping_by_outcome: {
        grouped: 9,
        "unit-unresolved": 1,
        "wargear-unresolved": 2,
        "single-model": 2,
        "no-recorded-defaults": 0,
        "solver-null": 1,
      },
    });
    expect(findRegressions(report(), fresh)).toEqual([]);
  });

  it("flags growth in a failure bucket", () => {
    const fresh = report({
      grouping_by_outcome: {
        grouped: 4,
        "unit-unresolved": 1,
        "wargear-unresolved": 2,
        "single-model": 2,
        "no-recorded-defaults": 0,
        "solver-null": 2,
      },
    });
    expect(findRegressions(report(), fresh)).toEqual(["grouping.solver-null: 1 → 2"]);
  });
});
