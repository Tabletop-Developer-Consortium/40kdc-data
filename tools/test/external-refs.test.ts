import { describe, expect, it } from "vitest";
import type { ExternalReference } from "../src/generated.js";
import { CoreExternalRefStore } from "../src/core-external-refs.js";
import {
  syncBsdataExternalRefs,
  syncGameDatacardsExternalRefs,
} from "../src/sync-external-refs.js";
import type { BsdataBackstopReport } from "../src/mfm/bsdata-backstop.js";
import { buildExternalRefsAudit } from "../src/audit-external-refs.js";

function refs(
  store: CoreExternalRefStore,
  entityType: "faction" | "unit" | "enhancement" | "weapon",
  dir: string,
  id: string,
): ExternalReference[] | undefined {
  return store
    .locations()
    .find(
      (location) =>
        location.entity_type === entityType &&
        location.dir === dir &&
        location.record.id === id,
    )?.record.external_refs;
}

function unitRefs(
  store: CoreExternalRefStore,
  id: string,
): ExternalReference[] | undefined {
  return refs(store, "unit", "world-eaters", id);
}

describe("external source identities", () => {
  it("deduplicates locally while allowing cross-entity fan-out", () => {
    const store = new CoreExternalRefStore();
    expect(
      store.add(
        "unit",
        "world-eaters",
        "kharn-the-betrayer",
        "test-source",
        "shared",
      ),
    ).toBe("added");
    expect(
      store.add(
        "unit",
        "world-eaters",
        "kharn-the-betrayer",
        "test-source",
        "shared",
      ),
    ).toBe("present");
    expect(
      store.add("unit", "world-eaters", "eightbound", "test-source", "shared"),
    ).toBe("added");

    expect(unitRefs(store, "kharn-the-betrayer")).toContainEqual({
      namespace: "test-source",
      id: "shared",
    });
    expect(unitRefs(store, "eightbound")).toContainEqual({
      namespace: "test-source",
      id: "shared",
    });
  });

  it("removes one namespace without disturbing other source identities", () => {
    const store = new CoreExternalRefStore();
    const before = unitRefs(store, "kharn-the-betrayer") ?? [];
    const retained = before.filter(
      (reference) => reference.namespace !== "game-datacards",
    );

    expect(before.length).toBeGreaterThan(retained.length);
    expect(store.removeNamespace("game-datacards")).toBeGreaterThan(0);
    expect(unitRefs(store, "kharn-the-betrayer")).toEqual(retained);
  });

  it("does not stage a write when namespace replacement is unchanged", () => {
    const store = new CoreExternalRefStore();

    expect(
      store.add(
        "unit",
        "world-eaters",
        "kharn-the-betrayer",
        "round-trip-test",
        "same-id",
      ),
    ).toBe("added");
    expect(store.removeNamespace("round-trip-test")).toBe(1);
    expect(store.stagedWrites()).toEqual([]);
  });

  it("preserves exact BSData ids on structurally classified entries", () => {
    const store = new CoreExternalRefStore();
    const report: BsdataBackstopReport = {
      schema_version: 1,
      source: {
        requested_ref: "fixture",
        resolved_commit: "fixture",
        files: 1,
      },
      mfm: { data_version: null },
      summary: {
        entries: 3,
        profiles: 1,
        resolved_links: 0,
        mechanical_differences: 0,
        heuristic_warnings: 0,
        parser_warnings: 0,
      },
      facts: [
        {
          source_file: "Chaos - World Eaters.json",
          pointer: "/selectionEntries/kharn",
          id: "exact-bsdata-id",
          name: "Kharn the Betrayer",
          entry_type: "unit",
          hidden: false,
          category_hints: [],
          profiles: [],
        },
        {
          source_file: "Imperium - Space Marines.json",
          pointer: "/selectionEntries/vanguard",
          id: "exact-bsdata-unit-id",
          name: "Vanguard Veteran Squad with Jump Packs",
          entry_type: "unit",
          hidden: false,
          category_hints: [],
          profiles: [],
        },
        {
          source_file: "Imperium - Space Marines.json",
          pointer:
            "/selectionEntries/vanguard/weapons/master-crafted-power-weapon",
          id: "exact-bsdata-weapon-id",
          name: "Master-crafted power weapon",
          hidden: false,
          category_hints: [],
          profiles: [
            {
              name: "Master-crafted power weapon",
              type: "melee-weapon",
              characteristics: {},
            },
          ],
        },
      ],
      links: [],
      mechanical_differences: [],
      heuristic_warnings: [],
      parser_warnings: [],
    };

    const stats = syncBsdataExternalRefs(store, report);
    expect(stats.added.unit).toBe(2);
    expect(unitRefs(store, "kharn-the-betrayer")).toContainEqual({
      namespace: "bsdata",
      id: "exact-bsdata-id",
    });
    expect(
      refs(
        store,
        "weapon",
        "adeptus-astartes",
        "master-crafted-power-weapon-vanguard-veteran-squad-with-jump-packs",
      ),
    ).toContainEqual({
      namespace: "bsdata",
      id: "exact-bsdata-weapon-id",
    });
    expect(
      refs(store, "weapon", "adeptus-astartes", "master-crafted-power-weapon"),
    ).not.toContainEqual({
      namespace: "bsdata",
      id: "exact-bsdata-weapon-id",
    });
  });

  it("backfills only explicit game-datacards node ids", () => {
    const store = new CoreExternalRefStore();
    const eightboundRefs = [...(unitRefs(store, "eightbound") ?? [])];
    const crimsonFistsRefs = [
      ...(refs(store, "faction", "crimson-fists", "crimson-fists") ?? []),
    ];
    const stats = syncGameDatacardsExternalRefs(
      store,
      new Map([
        [
          "worldeaters",
          {
            datasheets: [
              { id: "exact-game-datacards-id", name: "Kharn the Betrayer" },
              { name: "Eightbound" },
            ],
          },
        ],
        [
          "space_marines",
          {
            id: "exact-space-marines-faction-id",
            enhancements: [
              {
                id: "exact-artificer-armour-id",
                name: { en: "Artificer Armour" },
                detachment: "Gladius Task Force",
              },
            ],
          },
        ],
      ]),
    );

    expect(stats.added.unit).toBe(1);
    expect(stats.added.faction).toBe(1);
    expect(stats.added.enhancement).toBeGreaterThan(0);
    expect(unitRefs(store, "kharn-the-betrayer")).toContainEqual({
      namespace: "game-datacards",
      id: "exact-game-datacards-id",
    });
    expect(unitRefs(store, "eightbound")).toEqual(eightboundRefs);
    expect(
      refs(store, "faction", "adeptus-astartes", "adeptus-astartes"),
    ).toContainEqual({
      namespace: "game-datacards",
      id: "exact-space-marines-faction-id",
    });
    expect(
      refs(
        store,
        "enhancement",
        "adeptus-astartes",
        "artificer-armour-gladius-task-force",
      ),
    ).toContainEqual({
      namespace: "game-datacards",
      id: "exact-artificer-armour-id",
    });
    expect([
      ...(refs(store, "faction", "crimson-fists", "crimson-fists") ?? []),
    ]).toEqual(crimsonFistsRefs);
  });

  it("reports canonical entities rather than replicated file copies", () => {
    const store = new CoreExternalRefStore();
    const audit = buildExternalRefsAudit(store) as {
      entity_types: Record<string, { entities: number }>;
      fan_out: {
        targets: { entity_type: string; id: string; faction_id?: string }[];
      }[];
    };
    const physicalEnhancements = store.locations("enhancement");
    const uniqueEnhancements = new Set(
      physicalEnhancements.map((location) => location.record.id),
    );

    expect(physicalEnhancements.length).toBeGreaterThan(
      uniqueEnhancements.size,
    );
    expect(audit.entity_types.enhancement.entities).toBe(
      uniqueEnhancements.size,
    );
    for (const entry of audit.fan_out) {
      const keys = entry.targets.map(
        (target) =>
          `${target.entity_type}\0${target.faction_id ?? ""}\0${target.id}`,
      );
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
