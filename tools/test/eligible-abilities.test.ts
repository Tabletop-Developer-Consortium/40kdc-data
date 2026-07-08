import { describe, expect, it } from "vitest";
import { Dataset } from "../src/data/dataset.js";

const ds = Dataset.embedded();

describe("Dataset.eligibleAbilities", () => {
  it("surfaces the Oath of Moment faction rule for adeptus-astartes units", () => {
    const intercessor = ds.units.find("Intercessor Squad");
    expect(intercessor, "intercessor-squad missing").toBeDefined();
    const result = ds.eligibleAbilities(
      { unitId: intercessor!.id, factionId: "adeptus-astartes" },
      "shooting",
    );
    const armyIds = result.filter((e) => e.source.kind === "army").map((e) => e.ability.id);
    expect(armyIds).toContain("oath-of-moment");
  });

  it("returns nothing for an unknown unit", () => {
    expect(ds.eligibleAbilities({ unitId: "no-such-unit" }, "shooting")).toEqual([]);
  });

  it("filters by phase", () => {
    const intercessor = ds.units.find("Intercessor Squad")!;
    // Pick a phase Oath of Moment doesn't trigger in — the faction rule is
    // phase-permissive (no explicit phase-mapping), so the resolver keeps it
    // available everywhere. This test pins that "no mapping = surface in
    // every phase" behaviour against accidental tightening.
    const inCommand = ds.eligibleAbilities(
      { unitId: intercessor.id, factionId: "adeptus-astartes" },
      "command",
    );
    const armyIds = inCommand.filter((e) => e.source.kind === "army").map((e) => e.ability.id);
    expect(armyIds).toContain("oath-of-moment");
  });

  it("includes the unit's own ability_ids", () => {
    // Use Khârn — first-wins by-id lookup returns the same record `units.all`
    // surfaces, and the record has abilities baked in. Avoids the
    // `(faction_id, id)`-dedup vs `byId` first-wins mismatch other units hit.
    const unitId = "kharn-the-betrayer";
    expect((ds.units.getAny(unitId)?.raw.ability_ids ?? []).length).toBeGreaterThan(0);
    const result = ds.eligibleAbilities({ unitId }, "fight");
    const unitAbilities = result.filter((e) => e.source.kind === "unit");
    expect(unitAbilities.length).toBeGreaterThan(0);
  });

  it("sorts entries by source kind (army → detachment → unit → attached → support)", () => {
    const intercessor = ds.units.find("Intercessor Squad")!;
    const result = ds.eligibleAbilities(
      { unitId: intercessor.id, factionId: "adeptus-astartes" },
      "shooting",
    );
    const order = ["army", "detachment", "detachment-stratagem", "unit", "attached", "support"];
    const positions = result.map((e) => order.indexOf(e.source.kind));
    // Each successive position must be >= the previous one (non-decreasing).
    for (let i = 1; i < positions.length; i++) {
      expect(
        positions[i] >= positions[i - 1],
        `entry ${i} (${result[i].source.kind}) breaks sort order`,
      ).toBe(true);
    }
  });

  // The combined-unit attachment is bidirectional: whichever half is the
  // selected unit, the *other* half's abilities are pooled in as `attached`.
  it("pools an attached leader's abilities onto the selected bodyguard", () => {
    const result = ds.eligibleAbilities(
      { unitId: "khorne-berzerkers", attachedUnitIds: ["kharn-the-betrayer"] },
      "fight",
    );
    const attached = result.filter(
      (e) => e.source.kind === "attached" && e.source.unitId === "kharn-the-betrayer",
    );
    expect(attached.length).toBeGreaterThan(0);
    // And the bodyguard's own abilities still come through as `unit`.
    expect(result.some((e) => e.source.kind === "unit")).toBe(true);
  });

  it("pools an attached bodyguard's abilities onto the selected leader (reverse direction)", () => {
    const result = ds.eligibleAbilities(
      { unitId: "kharn-the-betrayer", attachedUnitIds: ["khorne-berzerkers"] },
      "fight",
    );
    const attached = result.filter(
      (e) => e.source.kind === "attached" && e.source.unitId === "khorne-berzerkers",
    );
    expect(attached.length).toBeGreaterThan(0);
  });
});

describe("Dataset.buffsFor (M2 — abilities)", () => {
  it("Oath of Moment contributes a hit reroll", () => {
    const intercessor = ds.units.find("Intercessor Squad")!;
    const buffs = ds.buffsFor(
      { unitId: intercessor.id, factionId: "adeptus-astartes" },
      { phase: "shooting" },
    );
    // Oath of Moment marks one enemy unit; attacks against it re-roll the Hit
    // roll. (The +1 to Wound is a mono-codex roster precondition, carried in
    // community_notes rather than the runtime buff layer.)
    const rerolls = buffs.filter((b) => b.contribution.type === "reroll");
    const rerollTypes = rerolls.map((b) =>
      b.contribution.type === "reroll" ? b.contribution.roll : null,
    );
    expect(rerollTypes).toContain("hit");
    expect(rerollTypes).not.toContain("wound");
    // And it's tagged as army-source.
    const oathSourced = rerolls.filter(
      (b) => b.source.kind === "ability" && b.source.abilityId === "oath-of-moment",
    );
    expect(oathSourced.length).toBe(1);
  });

  it("respects optedInStratagemIds — stratagems are excluded by default", () => {
    const intercessor = ds.units.find("Intercessor Squad")!;
    const withoutStrat = ds.buffsFor(
      { unitId: intercessor.id, factionId: "adeptus-astartes", detachmentId: "gladius-task-force" },
      { phase: "shooting" },
    );
    const stratBuffs = withoutStrat.filter(
      (b) =>
        b.source.kind === "ability" && b.source.abilityKind === "detachment-stratagem",
    );
    expect(stratBuffs).toEqual([]);
  });

  it("concatenates weapon-profile keyword buffs with ability buffs", () => {
    const intercessor = ds.units.find("Intercessor Squad")!;
    const buffs = ds.buffsFor(
      {
        unitId: intercessor.id,
        factionId: "adeptus-astartes",
        weaponProfiles: [{ weaponId: "bolt-rifle", profileIndex: 0 }],
      },
      { phase: "shooting", attackerStationary: true },
    );
    // Heavy (stationary) buff from bolt-rifle + Oath of Moment rerolls.
    const sources = buffs.map((b) => `${b.source.kind}:${"keywordId" in b.source ? b.source.keywordId : b.source.kind === "ability" ? b.source.abilityId : ""}`);
    expect(sources).toContain("weapon-keyword:heavy");
    expect(sources).toContain("ability:oath-of-moment");
  });
});
