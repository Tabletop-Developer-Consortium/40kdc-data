import { describe, it, expect } from "vitest";

import {
  abilities,
  Collection,
  Dataset,
  dataset,
  emptyRawData,
  enhancements,
  factions,
  normalizeName,
  units,
  weapons,
} from "../src/data/index.js";
import { RAW_DATA } from "../src/data/bundle.generated.js";

describe("terrain (embedded catalog + layout resolution)", () => {
  it("embeds the 11e template catalog and imported layouts", () => {
    // 19 canonical/KOTC templates plus Battlemaster's 12 feature and 44 composed
    // area templates. Composed areas retain their source scenery as child features.
    expect(dataset.terrainTemplates.all.length).toBe(75);
    expect(
      dataset.terrainTemplates.get("bm-bm-terrain-11e-1-composite-01")?.features,
    ).toHaveLength(2);
    expect(dataset.terrainTemplates.get("area-large")).toBeDefined();
    expect(dataset.terrainTemplates.get("kotc-ruin-inner")?.terrain_category).toBe("dense");
    expect(dataset.terrainTemplates.get("kotc-ruin-deployment")?.terrain_category).toBe("dense");
    expect(dataset.terrainTemplates.get("corner-ruin-balanced-left")?.upper_floor).toBeDefined();
    expect(dataset.terrainTemplates.get("gantry")?.ground_accessible).toBe(false);
    expect(dataset.terrainTemplates.get("impassable-wall")?.ground_accessible).toBe(false);
    // removed in the catalog correction
    expect(dataset.terrainTemplates.get("wall-medium")).toBeUndefined();
    expect(dataset.terrainTemplates.get("scaffold")).toBeUndefined();
    expect(dataset.terrainLayouts.get("take-and-hold-mirror-1")).toBeDefined();
    // The KOTC colosseum is a first-class dataset layout on a 36×36 board.
    const colosseum = dataset.terrainLayouts.get("kotc-colosseum");
    expect(colosseum?.board).toEqual({ width: 36, height: 36 });
    // removed: non-grid layouts (reference migrations + standalone) with no mission_matchup_id
    expect(dataset.terrainLayouts.get("gw-11e-crucible")).toBeUndefined();
    expect(dataset.terrainLayouts.get("gw-11e-hammer-anvil")).toBeUndefined();
    expect(dataset.terrainLayouts.get("sweeping-engagement-1")).toBeUndefined();
  });

  it("exposes the new layout classification fields", () => {
    expect(dataset.terrainLayouts.get("take-and-hold-mirror-1")!.deployment_pattern_id).toBe(
      "tipping-point",
    );
    const sd = dataset.terrainLayouts.get("take-and-hold-vs-purge-the-foe-2")!;
    expect(sd.deployment_pattern_id).toBe("search-and-destroy");
    expect(sd.mission_matchup_id).toBe("take-and-hold-vs-purge-the-foe");
    expect(sd.variant).toBe(2);
  });

  it("resolveTerrain produces on-board polygons (mirror of Rust resolve_terrain)", () => {
    const layout = dataset.terrainLayouts.get("take-and-hold-mirror-1")!;
    const resolved = dataset.resolveTerrain(layout);
    expect(resolved.length).toBeGreaterThan(0);
    for (const p of resolved) {
      expect(p.vertices.length).toBeGreaterThanOrEqual(3);
      for (const v of p.vertices) {
        expect(v.x).toBeGreaterThanOrEqual(-1);
        expect(v.x).toBeLessThanOrEqual(61);
        expect(v.y).toBeGreaterThanOrEqual(-1);
        expect(v.y).toBeLessThanOrEqual(45);
      }
    }
  });
});

describe("normalizeName", () => {
  it("strips diacritics via NFD", () => {
    expect(normalizeName("Khârn the Betrayer")).toBe("kharn the betrayer");
    expect(normalizeName("Brôkhyr")).toBe("brokhyr");
    expect(normalizeName("Ûthar")).toBe("uthar");
  });

  it("removes apostrophe and quote variants", () => {
    expect(normalizeName("Be’lakor")).toBe("belakor");
    expect(normalizeName("Kor’sarro Khan")).toBe("korsarro khan");
    expect(normalizeName("Aetaos'rau'keres")).toBe("aetaosraukeres");
  });

  it("collapses whitespace and hyphens, then trims", () => {
    expect(normalizeName("Brôkhyr Iron-master")).toBe("brokhyr iron master");
    expect(normalizeName("  the   betrayer  ")).toBe("the betrayer");
  });

  it("is idempotent on already-normalized input", () => {
    expect(normalizeName(normalizeName("Khârn the Betrayer"))).toBe("kharn the betrayer");
  });
});

describe("Collection.find / findAll", () => {
  it("matches by exact id", () => {
    expect(units.find("kharn-the-betrayer")?.id).toBe("kharn-the-betrayer");
  });

  it("matches by exact normalized name", () => {
    expect(units.find("Khârn the Betrayer")?.id).toBe("kharn-the-betrayer");
  });

  it("falls back to a normalized-name substring", () => {
    expect(units.find("Betrayer")?.id).toBe("kharn-the-betrayer");
  });

  it("returns undefined on a miss", () => {
    expect(units.find("definitely-not-a-real-unit")).toBeUndefined();
    expect(units.find("")).toBeUndefined();
  });

  it("findAll surfaces every match for a shared name", () => {
    const all = units.findAll("Ministorum Priest");
    expect(all.length).toBe(3);
    expect(new Set(all.map((u) => u.faction?.id))).toEqual(
      new Set(["adepta-sororitas", "agents-of-the-imperium", "astra-militarum"]),
    );
  });

  it("byFaction disambiguates a unit shared across factions", () => {
    for (const f of ["adepta-sororitas", "agents-of-the-imperium", "astra-militarum"]) {
      expect(units.byFaction(f).some((u) => u.id === "ministorum-priest")).toBe(true);
    }
  });

  it("getInFaction returns the requested faction's copy of a shared chassis", () => {
    // `chaos-land-raider` exists under several Chaos factions; faction-blind
    // `get` returns whichever was registered first, so a consumer that knows
    // the faction must scope by it. (Regression guard for the World Eaters
    // "pick a unit" collision.)
    for (const f of ["chaos-space-marines", "death-guard", "world-eaters"]) {
      const u = units.getInFaction("chaos-land-raider", f);
      expect(u, `chaos-land-raider in ${f}`).toBeDefined();
      expect(u!.id).toBe("chaos-land-raider");
      expect(u!.raw.faction_id).toBe(f);
    }
  });

  it("get() throws for a shared weapon id resolved without a faction (dev guard)", () => {
    // lascannon exists under many factions with divergent stats; a
    // faction-less get() would silently crunch the wrong faction's profile.
    expect(() => weapons.get("lascannon")).toThrow(/Ambiguous weapon lookup/);
    expect(weapons.getAny("lascannon")).toBeDefined();
  });

  it("get() throws for a shared ability id resolved without a faction (dev guard)", () => {
    expect(() => abilities.get("idol-of-blessed-blood")).toThrow(/Ambiguous ability lookup/);
    expect(abilities.getAny("idol-of-blessed-blood")).toBeDefined();
  });

  it("getInFaction returns undefined when the id is absent from the faction", () => {
    expect(units.getInFaction("chaos-land-raider", "adepta-sororitas")).toBeUndefined();
  });

  it("get() throws for a shared chassis id resolved without a faction (dev guard)", () => {
    // The tripwire that turns the original silent mis-lookup into a loud error:
    // a faction-blind get() of an id under several factions would return the
    // first-registered copy (wrong keywords/points). vitest runs outside
    // production, so it throws.
    expect(() => units.get("chaos-land-raider")).toThrow(/Ambiguous unit lookup/);
    // getAny is the explicit opt-out for genuinely faction-unknown callers
    // (roster import, the conformance runner) — first-wins, never throws.
    expect(units.getAny("chaos-land-raider")).toBeDefined();
    // The scoped accessor is unaffected.
    expect(units.getInFaction("chaos-land-raider", "world-eaters")?.raw.faction_id).toBe(
      "world-eaters",
    );
  });
});

describe("Collection id-alias resolution (renamed ids)", () => {
  // The share-registry alias map (old id → current id) is wired into the
  // enhancements collection, so a persisted roster/share reference to a
  // since-renamed enhancement id still resolves to the current record.
  it("resolves a renamed enhancement id via get/getAny/has", () => {
    const renamed = "a-chink-in-their-armour"; // → …-host-of-ascension
    const current = "a-chink-in-their-armour-host-of-ascension";
    expect(enhancements.get(renamed)?.id).toBe(current);
    expect(enhancements.getAny(renamed)?.id).toBe(current);
    expect(enhancements.has(renamed)).toBe(true);
  });

  it("returns the record unchanged for a current (non-aliased) id", () => {
    const id = "a-chink-in-their-armour-host-of-ascension";
    expect(enhancements.get(id)?.id).toBe(id);
  });

  it("a bogus id still misses", () => {
    expect(enhancements.get("not-a-real-enhancement-xyz")).toBeUndefined();
    expect(enhancements.has("not-a-real-enhancement-xyz")).toBe(false);
  });

  it("consults idAliases only on a byId miss (canonical id always wins)", () => {
    // A synthetic collection: the alias must never shadow a live canonical id.
    const coll = new Collection<{ id: string; name: string }, { id: string; name: string }>({
      items: [
        { id: "new-x", name: "New X" },
        { id: "old-x", name: "Old X (still live)" },
      ],
      idOf: (i) => i.id,
      nameOf: (i) => i.name,
      idAliases: { "old-x": "new-x" },
      wrap: (i) => i,
    });
    // "old-x" is a live id → returns itself, NOT the aliased "new-x".
    expect(coll.get("old-x")?.name).toBe("Old X (still live)");
    // A dangling old id (no live record) resolves through the alias.
    const coll2 = new Collection<{ id: string }, { id: string }>({
      items: [{ id: "new-y" }],
      idOf: (i) => i.id,
      idAliases: { "old-y": "new-y" },
      wrap: (i) => i,
    });
    expect(coll2.get("old-y")?.id).toBe("new-y");
    expect(coll2.find("old-y")?.id).toBe("new-y");
    expect(coll2.get("nope")).toBeUndefined();
  });
});

describe("internationalization (diacritic- and punctuation-insensitive lookup)", () => {
  // [ascii query, exact-as-printed query, expected id]
  const cases: [string, string, string][] = [
    ["Kharn the Betrayer", "Khârn the Betrayer", "kharn-the-betrayer"],
    ["Belakor", "Be’lakor", "belakor"],
    ["Korsarro Khan", "Kor’sarro Khan", "korsarro-khan"],
    ["Brokhyr Iron-master", "Brôkhyr Iron-master", "brokhyr-iron-master"],
    ["Uthar the Destined", "Ûthar the Destined", "uthar-the-destined"],
  ];

  for (const [ascii, exact, id] of cases) {
    it(`resolves "${ascii}" and "${exact}" → ${id}`, () => {
      expect(units.find(ascii)?.id).toBe(id);
      expect(units.find(exact)?.id).toBe(id);
    });
  }

  it("is case-insensitive", () => {
    expect(units.find("KHÂRN THE BETRAYER")?.id).toBe("kharn-the-betrayer");
    expect(units.find("be'LAKOR")?.id).toBe("belakor");
  });

  it("does not over-collapse genuinely distinct names", () => {
    expect(normalizeName("Khârn")).not.toBe(normalizeName("Kâhl"));
    // an exact unique name must not pull in unrelated entities
    expect(units.findAll("Khârn the Betrayer").map((u) => u.id)).toEqual(["kharn-the-betrayer"]);
  });
});

describe("Kharn proof (the headline one-liner)", () => {
  const kharn = units.find("Kharn");

  it("resolves and links faction / weapons / abilities", () => {
    expect(kharn).toBeDefined();
    expect(kharn!.faction?.id).toBe("world-eaters");
    expect(kharn!.weapons.length).toBe(2);
    expect(kharn!.abilities.map((a) => a.id).sort()).toEqual(
      ["berzerker-frenzy", "leader", "legendary-killer", "the-betrayer"],
    );
  });

  it("filters abilities by phase", () => {
    const shooting = kharn!.abilities.filter((a) => a.phases.includes("shooting"));
    expect(shooting.map((a) => a.id)).toEqual(["berzerker-frenzy"]);
  });
});

describe("AbilityView.phases (joined via phase-mappings)", () => {
  it("unions phases across a mapping", () => {
    // deadly-demise-d3 is a shared id (per-faction copies) — phase-mappings
    // key on the bare ability id, so any copy carries the same phases.
    expect(abilities.getAny("deadly-demise-d3")?.phases.sort()).toEqual(["fight", "shooting"]);
  });

  it("is empty for an ability with no phase-mapping", () => {
    expect(abilities.getAny("leader")?.phases).toEqual([]);
  });
});

describe("reverse links", () => {
  it("AbilityView.units lists units that have the ability", () => {
    expect(abilities.get("berzerker-frenzy")?.units.map((u) => u.id)).toContain(
      "kharn-the-betrayer",
    );
  });

  it("WeaponView.units lists carriers", () => {
    const kharn = units.find("Kharn")!;
    const weapon = kharn.weapons[0];
    expect(weapon.units.some((u) => u.id === "kharn-the-betrayer")).toBe(true);
  });

  it("FactionView links units / weapons", () => {
    const we = factions.find("World Eaters")!;
    expect(we.units.length).toBeGreaterThan(0);
    expect(we.weapons.length).toBeGreaterThan(0);
  });
});

describe("leadersAttachableTo", () => {
  it("lists leaders whose attachment data covers the body unit, sorted by name", () => {
    const leaders = dataset.leadersAttachableTo("battle-sisters-squad");
    expect(leaders.map((l) => l.id)).toContain("palatine");
    const names = leaders.map((l) => l.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("returns an empty array for a leader unit (nothing attaches to it)", () => {
    expect(dataset.leadersAttachableTo("palatine")).toEqual([]);
  });

  it("returns an empty array for an unknown unit id", () => {
    expect(dataset.leadersAttachableTo("no-such-unit")).toEqual([]);
  });
});

describe("bodyguardsAttachableFrom", () => {
  it("lists the body units a leader can join, sorted by name", () => {
    const bodies = dataset.bodyguardsAttachableFrom("palatine");
    expect(bodies.map((b) => b.id)).toContain("battle-sisters-squad");
    const names = bodies.map((b) => b.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("is the inverse of leadersAttachableTo", () => {
    // palatine → battle-sisters-squad, and battle-sisters-squad → palatine.
    expect(dataset.bodyguardsAttachableFrom("palatine").map((b) => b.id)).toContain(
      "battle-sisters-squad",
    );
    expect(dataset.leadersAttachableTo("battle-sisters-squad").map((l) => l.id)).toContain(
      "palatine",
    );
  });

  it("returns an empty array for a non-leader unit", () => {
    expect(dataset.bodyguardsAttachableFrom("battle-sisters-squad")).toEqual([]);
  });

  it("returns an empty array for an unknown unit id", () => {
    expect(dataset.bodyguardsAttachableFrom("no-such-unit")).toEqual([]);
  });
});

describe("edge cases", () => {
  it("a Space Marine successor faction resolves without throwing (units may be inherited)", () => {
    const ultra = factions.get("ultramarines");
    expect(ultra).toBeDefined();
    expect(() => ultra!.units).not.toThrow();
  });

  it("skips dangling link ids rather than throwing", () => {
    const ds = new Dataset({
      ...emptyRawData(),
      units: [
        {
          id: "ghost",
          name: "Ghost",
          faction_id: "nowhere",
          profiles: [{ M: 1, T: 1, W: 1, Sv: 1, Ld: 1, OC: 1 } as never],
          weapon_ids: ["missing-weapon"],
          ability_ids: ["missing-ability"],
          game_version: { edition: "11th", dataslate: "test" },
        } as never,
      ],
    });
    const ghost = ds.units.get("ghost")!;
    expect(ghost.weapons).toEqual([]);
    expect(ghost.abilities).toEqual([]);
    expect(ghost.faction).toBeUndefined();
  });
});

describe("collection integrity", () => {
  it("exposes the embedded data", () => {
    expect(units.size).toBeGreaterThan(900);
    expect(factions.size).toBe(35);
    expect(weapons.size).toBeGreaterThan(0);
    expect(abilities.size).toBeGreaterThan(0);
  });

  it("deduplicates abilities by (faction_id, id) — every faction's copy retained", () => {
    // A shared ability_id keeps one copy per faction (the copies legitimately
    // diverge); only true within-faction duplicates collapse.
    const keys = abilities.all.map((a) => `${a.raw.faction_id ?? ""}::${a.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    // idol-of-blessed-blood exists under both world-eaters and
    // chaos-space-marines — both copies must survive dedupe.
    expect(abilities.all.filter((a) => a.id === "idol-of-blessed-blood").length).toBe(2);
  });

  it("folds shared _core abilities into the collection", () => {
    expect(abilities.get("benefit-of-cover")).toBeDefined();
  });

  it("resolves a shared ability_id to the unit's own faction's copy", () => {
    // `idol-of-blessed-blood` is authored in both world-eaters and
    // chaos-space-marines (the Khorne Lord of Skulls is a shared datasheet).
    // Each faction's Lord of Skulls must see its own faction's copy — the
    // regression this guards: a CSM stub silently shadowing the authored
    // world-eaters entry under first-wins dedupe.
    for (const f of ["world-eaters", "chaos-space-marines"]) {
      const unit = units.getInFaction("khorne-lord-of-skulls", f)!;
      const idol = unit.abilities.find((a) => a.id === "idol-of-blessed-blood");
      expect(idol, `idol-of-blessed-blood on ${f} lord of skulls`).toBeDefined();
      expect(idol!.raw.faction_id).toBe(f);
    }
  });

  it("falls back to the faction-less _core pool for ids outside the unit's faction", () => {
    const ability = { name: "Benefit of Cover", ability_id: "benefit-of-cover" };
    const ds = new Dataset({
      ...emptyRawData(),
      units: [
        {
          id: "scout",
          name: "Scout",
          faction_id: "test-faction",
          profiles: [{ M: 6, T: 3, W: 1, Sv: 4, Ld: 7, OC: 1 } as never],
          ability_ids: ["benefit-of-cover"],
          game_version: { edition: "11th", dataslate: "test" },
        } as never,
      ],
      // A _core-pool record carries no faction_id — getInFaction misses it,
      // the getAny fallback finds it.
      abilities: [ability as never],
    });
    const scout = ds.units.get("scout")!;
    expect(scout.abilities.map((a) => a.id)).toEqual(["benefit-of-cover"]);
  });

  it("is iterable", () => {
    const collected = [...factions];
    expect(collected.length).toBe(factions.size);
  });

  it("retains every faction's ability copy (no within-faction duplicates to collapse)", () => {
    // Cross-faction copies are kept by the (faction_id, id) dedupe key, and
    // integrity forbids within-faction duplicate ids — so the collection is
    // the raw bundle, record for record.
    expect(abilities.size).toBe(RAW_DATA.abilities.length);
  });
});

function emptyRaw() {
  return {
    units: [],
    weapons: [],
    weaponKeywords: [],
    factions: [],
    abilities: [],
    phaseMappings: [],
    detachments: [],
    stratagems: [],
    enhancements: [],
    leaderAttachments: [],
    unitCompositions: [],
    wargearOptions: [],
    gameVersions: [],
    missions: [],
    missionMatchups: [],
    missionCards: [],
    deploymentPatterns: [],
    forceDispositions: [],
    resourcePools: [],
    interactionFlags: [],
  };
}
