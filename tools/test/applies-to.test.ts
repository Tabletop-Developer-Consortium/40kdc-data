import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { unitMatchesAppliesTo } from "../src/scope.js";
import { Dataset } from "../src/data/dataset.js";
import { abilities, units } from "../src/data/index.js";

const CONFORMANCE = join(dirname(fileURLToPath(import.meta.url)), "../../conformance/applies-to");

interface AppliesToCase {
  caseId: string;
  applies_to: { required_keywords?: string[]; excluded_keywords?: string[] } | null;
  units: { id: string; keywords?: string[]; faction_keywords?: string[] }[];
  expected: { matchedIds: string[] };
}

describe("applies-to conformance golden", () => {
  const cases = JSON.parse(readFileSync(join(CONFORMANCE, "cases.json"), "utf-8")) as AppliesToCase[];

  it("ships cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(`matches ${c.caseId}`, () => {
      const matched = c.units
        .filter((u) => unitMatchesAppliesTo(c.applies_to ?? undefined, u))
        .map((u) => u.id);
      expect(matched).toEqual(c.expected.matchedIds);
    });
  }
});

describe("AbilityView applies_to (integration)", () => {
  const ds = Dataset.embedded();

  it("exposes brazen-fury's curated filter", () => {
    expect(ds.abilities.getAny("brazen-fury")?.appliesTo).toEqual({ required_keywords: ["Possessed"] });
  });

  it("resolves brazen-fury to exactly the World Eaters Possessed units", () => {
    const rule = abilities.get("brazen-fury")!;
    const worldEaters = units.all.filter((u) => u.raw.faction_id === "world-eaters");
    const affected = rule
      .affectedUnits(worldEaters)
      .map((u) => u.id)
      .sort();
    expect(affected).toEqual(["eightbound", "exalted-eightbound", "slaughterbound"]);
  });

  it("army-wide rules with no filter highlight nothing", () => {
    const rule = abilities.get("relentless-rage")!;
    expect(rule.appliesTo).toBeUndefined();
    expect(rule.affectedUnits(units.all)).toEqual([]);
  });
});
