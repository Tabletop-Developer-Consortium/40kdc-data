import { describe, expect, it } from "vitest";
import { Dataset } from "../src/data/dataset.js";
import type { EngineContext } from "../src/cruncher/buffs.js";

const ds = Dataset.embedded();
const baseCtx: EngineContext = { phase: "shooting" };

describe("WeaponKeywordView", () => {
  it("exposes id/name/raw and lists weapons that reference it", () => {
    const heavy = ds.weaponKeywords.get("heavy");
    expect(heavy).toBeDefined();
    expect(heavy!.id).toBe("heavy");
    expect(heavy!.name).toBe("Heavy");
    expect(heavy!.raw.required_parameters).toEqual([]);
    // The catalog reverse-index should round-trip: every weapon listed under
    // a keyword view actually references that keyword in one of its profiles.
    const weapons = heavy!.weapons;
    expect(weapons.length).toBeGreaterThan(0);
    for (const weapon of weapons.slice(0, 5)) {
      const refsHeavy = weapon.raw.profiles.some((p) =>
        (p.keywords ?? []).some((k) => k.keyword_id === "heavy"),
      );
      expect(refsHeavy, `weapon ${weapon.id} listed under heavy but doesn't reference it`).toBe(
        true,
      );
    }
  });

  it("getBuffs() routes engine-dispatch keywords through extra-keyword", () => {
    const sustained = ds.weaponKeywords.get("sustained-hits")!;
    const buffs = sustained.getBuffs({ value: 2 }, "test-weapon", baseCtx);
    expect(buffs).toHaveLength(1);
    expect(buffs[0].contribution).toEqual({
      type: "extra-keyword",
      keywordRef: { keyword_id: "sustained-hits", parameters: { value: 2 } },
    });
  });

  it("getBuffs() walks the DSL for keywords with a non-null effect", () => {
    const twin = ds.weaponKeywords.get("twin-linked")!;
    const buffs = twin.getBuffs(undefined, "test-weapon", baseCtx);
    expect(buffs).toHaveLength(1);
    expect(buffs[0].contribution).toEqual({
      type: "reroll",
      roll: "wound",
      subset: "all-failures",
    });
  });
});

describe("WeaponView profile accessors", () => {
  it("profileAt(0) returns the schema profile directly", () => {
    const bolt = ds.weapons.getAny("bolt-rifle")!;
    const profile = bolt.profileAt(0);
    expect(profile.stats.S).toBe(4);
    expect(profile.stats.AP).toBe(-1);
  });

  it("profileAt with out-of-range index throws", () => {
    const bolt = ds.weapons.getAny("bolt-rifle")!;
    expect(() => bolt.profileAt(99)).toThrow(/profileAt\(99\)/);
  });

  it("profiles returns the full array and profileCount matches", () => {
    const bolt = ds.weapons.getAny("bolt-rifle")!;
    expect(bolt.profiles.length).toBeGreaterThanOrEqual(1);
    expect(bolt.profileCount).toBe(bolt.profiles.length);
    expect(bolt.profiles[0]).toEqual(bolt.profileAt(0));
  });

  it("type is a string", () => {
    const bolt = ds.weapons.getAny("bolt-rifle")!;
    expect(typeof bolt.type).toBe("string");
  });

  it("keywordsAt(0) resolves each reference against the catalog", () => {
    const bolt = ds.weapons.getAny("bolt-rifle")!;
    const kws = bolt.keywordsAt(0);
    expect(kws.map((k) => k.keyword.id).sort()).toEqual(["assault", "heavy"]);
  });

  it("profileBuffs(0, context) honours engine context for conditionals", () => {
    const bolt = ds.weapons.getAny("bolt-rifle")!;
    const off = bolt.profileBuffs(0, { ...baseCtx, attackerStationary: false });
    expect(off).toEqual([]); // Heavy gated off; Assault contributes nothing.
    const on = bolt.profileBuffs(0, { ...baseCtx, attackerStationary: true });
    expect(on).toHaveLength(1);
    expect(on[0].contribution).toEqual({ type: "hit-mod", value: 1 });
    expect(on[0].source).toMatchObject({
      kind: "weapon-keyword",
      weaponId: "bolt-rifle",
      keywordId: "heavy",
    });
  });
});

describe("UnitView profile accessors", () => {
  it("profileAt returns the unit's stat profile by index", () => {
    const someUnit = ds.units.all[0];
    const profile = someUnit.profileAt(0);
    expect(profile.T).toBeGreaterThan(0);
    expect(profile.W).toBeGreaterThan(0);
    expect(profile.Sv).toBeGreaterThan(0);
  });

  it("profiles returns the full array and profileCount matches", () => {
    const someUnit = ds.units.all[0];
    expect(someUnit.profiles.length).toBeGreaterThanOrEqual(1);
    expect(someUnit.profileCount).toBe(someUnit.profiles.length);
    expect(someUnit.profiles[0]).toEqual(someUnit.profileAt(0));
  });

  it("profileAt with out-of-range index throws", () => {
    const someUnit = ds.units.all[0];
    expect(() => someUnit.profileAt(99)).toThrow(/profileAt\(99\)/);
  });
});

describe("UnitView convenience getters", () => {
  it("factionId is a non-empty string", () => {
    const someUnit = ds.units.all[0];
    expect(someUnit.factionId).toBeTruthy();
    expect(typeof someUnit.factionId).toBe("string");
  });

  it("keywords is an array", () => {
    const someUnit = ds.units.all[0];
    expect(Array.isArray(someUnit.keywords)).toBe(true);
  });

  it("factionKeywords is an array", () => {
    const someUnit = ds.units.all[0];
    expect(Array.isArray(someUnit.factionKeywords)).toBe(true);
  });

  it("role is a string when present", () => {
    const withRole = ds.units.all.find((u) => u.role != null);
    expect(withRole).toBeDefined();
    expect(typeof withRole!.role).toBe("string");
  });
});

describe("AbilityView.getBuffs (M1 stub)", () => {
  it("returns an empty buff list until M2 lands the DSL translator", () => {
    const some = ds.abilities.all[0];
    const buffs = some.getBuffs({ kind: "ability", abilityId: some.id, abilityKind: "unit" });
    expect(buffs).toEqual([]);
  });
});

describe("Dataset.buffsFor", () => {
  it("collects buffs from the weapon profile keywords on the input", () => {
    const buffs = ds.buffsFor(
      { weaponProfiles: [{ weaponId: "bolt-rifle", profileIndex: 0 }] },
      { ...baseCtx, attackerStationary: true },
    );
    expect(buffs).toHaveLength(1);
    expect(buffs[0].contribution).toEqual({ type: "hit-mod", value: 1 });
  });

  it("skips unknown weapon ids without throwing", () => {
    const buffs = ds.buffsFor(
      { weaponProfiles: [{ weaponId: "no-such-weapon", profileIndex: 0 }] },
      baseCtx,
    );
    expect(buffs).toEqual([]);
  });
});
