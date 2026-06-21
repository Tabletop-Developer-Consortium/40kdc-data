import { describe, it, expect } from "vitest";
import { toJson, toMarkdown, type FlaggedRecord } from "./export.js";

const records: FlaggedRecord[] = [
  {
    ability_id: "deadly-demise-d3",
    name: "Deadly Demise D3",
    faction_id: "necrons",
    flagged: true,
    note: "Threshold should be 6, not 5.",
    source_text: "When this model is destroyed, roll a D6...",
    dsl: { effect: { type: "dice-gated", threshold: 5 } },
    describer: "On a 5+, deal mortal wounds.",
  },
  {
    ability_id: "mystery-ability",
    name: "Mystery Ability",
    faction_id: null,
    flagged: true,
    note: "",
    source_text: "",
    dsl: { effect: null },
    describer: "",
  },
];

describe("toJson", () => {
  it("wraps records with a count and kind tag", () => {
    const parsed = JSON.parse(toJson(records));
    expect(parsed.kind).toBe("ability-dsl-review");
    expect(parsed.count).toBe(2);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].ability_id).toBe("deadly-demise-d3");
  });
});

describe("toMarkdown", () => {
  const md = toMarkdown(records);

  it("includes each ability id, name, note, source, describer and DSL", () => {
    expect(md).toContain("## Deadly Demise D3 `deadly-demise-d3`");
    expect(md).toContain("*Faction:* necrons");
    expect(md).toContain("**Note:** Threshold should be 6, not 5.");
    expect(md).toContain("When this model is destroyed");
    expect(md).toContain("On a 5+, deal mortal wounds.");
    expect(md).toContain('"threshold": 5');
  });

  it("falls back gracefully when source text and describer are empty", () => {
    expect(md).toContain("(no source text available)");
    expect(md).toContain("## Mystery Ability `mystery-ability`");
  });

  it("uses singular/plural correctly in the header", () => {
    expect(toMarkdown([records[0]])).toContain("1 flagged ability.");
    expect(md).toContain("2 flagged abilities.");
  });
});
