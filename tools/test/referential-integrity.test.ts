import { describe, it, expect } from "vitest";
import { checkReferentialIntegrity, diceTableInvariantErrors, FACTION_HOME_KEYWORD } from "../src/integrity.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = resolve(__dirname, "fixtures");
const REAL_DATA = resolve(__dirname, "../../data");

describe("referential integrity", () => {
  it(
    "passes on the real dataset (no dangling ability_ids, no foreign faction_keywords)",
    async () => {
      const result = await checkReferentialIntegrity(REAL_DATA);
      if (result.failed > 0) {
        // Surface the offending units to make regressions actionable.
        const detail = result.errors
          .flatMap((e) => e.errors.map((x) => x.message))
          .join("\n");
        throw new Error(`referential integrity failed:\n${detail}`);
      }
      expect(result.failed).toBe(0);
      expect(result.totalItems).toBeGreaterThan(0);
    },
    15_000,
  );

  it("flags a dangling ability_id and a foreign faction_keyword", async () => {
    const result = await checkReferentialIntegrity(resolve(FIXTURES, "integrity-bad"));
    // Only the contaminated unit fails; the clean one passes.
    expect(result.failed).toBe(1);
    expect(result.passed).toBe(1);

    const messages = result.errors.flatMap((e) => e.errors.map((x) => x.message));
    expect(messages.some((m) => m.includes('ability_id "sorcerous-support"'))).toBe(true);
    expect(messages.some((m) => m.includes('faction_keyword "Emperor’s Children"'))).toBe(true);
    // The legal "World Eaters" keyword on the same unit must NOT be flagged.
    expect(messages.some((m) => m.includes('faction_keyword "World Eaters"'))).toBe(false);
  });

  it("passes a clean single-unit fixture", async () => {
    const result = await checkReferentialIntegrity(resolve(FIXTURES, "integrity-good"));
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(1);
  });

  it("requires rules-bundle grants to resolve in their faction or the shared core pool", async () => {
    const result = await checkReferentialIntegrity(resolve(FIXTURES, "integrity-bundle-grant"));
    const messages = result.errors.flatMap((e) => e.errors.map((x) => x.message));

    expect(result.failed).toBe(3);
    expect(result.passed).toBe(1);
    expect(messages).toContain(
      'ability "dangling-bundle-grant": rules-bundle grant "missing-bundle" resolves to no ability entity in world-eaters enrichment or the shared core pool',
    );
    expect(messages).toContain(
      'ability "foreign-bundle-grant": rules-bundle grant "foreign-bundle" resolves to no ability entity in world-eaters enrichment or the shared core pool',
    );
    expect(messages).toContain(
      'ability "ordinary-bundle-grant": rules-bundle grant "ordinary-target" resolves to an ability whose effect is not rules-bundle',
    );
  });

  it("requires dice tables to cover each face exactly once", () => {
    const effect = {
      type: "dice-table",
      dice: "D6",
      outcomes: [
        { results: [1, 2, 3], effect: { type: "mortal-wounds" } },
        { results: [3, 4, 5], effect: { type: "mortal-wounds" } },
      ],
    };
    expect(diceTableInvariantErrors(effect)).toEqual([
      "dice-table D6 omits result 6",
      "dice-table D6 repeats result 3",
    ]);
    expect(diceTableInvariantErrors({
      ...effect,
      outcomes: [
        { results: [1, 2, 3], effect: { type: "mortal-wounds" } },
        { results: [4, 5, 6], effect: { type: "mortal-wounds" } },
      ],
    })).toEqual([]);
  });

  it("flags corrupt wargear-option weapon refs (dangling conjunction, captured qualifier, plural-of-weapon)", async () => {
    const result = await checkReferentialIntegrity(resolve(FIXTURES, "integrity-wargear"));
    // One clean option passes; the three corrupt ones fail.
    expect(result.failed).toBe(3);
    expect(result.passed).toBe(1);

    const messages = result.errors.flatMap((e) => e.errors.map((x) => x.message));
    expect(messages.some((m) => m.includes('"flamer-and"') && m.includes("dangling conjunction"))).toBe(true);
    expect(messages.some((m) => m.includes('"duplicates-are-not-allowed"') && m.includes("captured prose qualifier"))).toBe(true);
    expect(messages.some((m) => m.includes('"lascannons"') && m.includes("plural of weapon"))).toBe(true);
  });

  it("flags a duplicate unit id within a faction file (first-wins shadowing)", async () => {
    const result = await checkReferentialIntegrity(resolve(FIXTURES, "integrity-dup-unit"));
    const messages = result.errors.flatMap((e) => e.errors.map((x) => x.message));
    expect(messages.some((m) => m.includes('duplicate unit id "dup-unit"') && m.includes("first-wins"))).toBe(true);
    // The unique id must NOT be flagged.
    expect(messages.some((m) => m.includes('"solo-unit"'))).toBe(false);
  });

  it("enforces the cross-faction collision policy table (fixture)", async () => {
    const result = await checkReferentialIntegrity(resolve(FIXTURES, "integrity-collision"));
    const messages = result.errors.flatMap((e) => e.errors.map((x) => x.message));
    // Drifted replicated-identical copies fail (stratagem cp_cost differs).
    expect(
      messages.some((m) => m.includes('stratagems id "shared-strat"') && m.includes("drifted")),
    ).toBe(true);
    // A unique-class id in two faction dirs fails.
    expect(
      messages.some((m) => m.includes('factions id "clashing-faction"') && m.includes("unique")),
    ).toBe(true);
    // A within-faction duplicate ability_id fails (first-wins shadowing).
    expect(
      messages.some((m) => m.includes('duplicate ability_id "dup-ability"')),
    ).toBe(true);
    // An undeclared data file type fails until a policy is declared.
    expect(
      messages.some((m) => m.includes('"widgets.json"') && m.includes("collision policy")),
    ).toBe(true);
  });

  it("the real dataset satisfies the collision policy table", async () => {
    // The full-dataset run happens in the first test; this pins that no
    // policy-table failures exist in committed data (drift re-synced, no
    // within-faction dups, no undeclared file types).
    const result = await checkReferentialIntegrity();
    const messages = result.errors.flatMap((e) => e.errors.map((x) => x.message));
    expect(messages.filter((m) => m.includes("collision policy"))).toEqual([]);
    expect(messages.filter((m) => m.includes("drifted across factions"))).toEqual([]);
  });

  it("registers the chaos cult factions with bare-legion home keywords", () => {
    expect(FACTION_HOME_KEYWORD["world-eaters"]).toBe("World Eaters");
    expect(FACTION_HOME_KEYWORD["chaos-space-marines"]).toBe("Heretic Astartes");
  });
});
