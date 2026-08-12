import { BSON } from "bson";
import { describe, expect, it } from "vitest";

import {
  decodeBakedCache,
  decodeSpawnerSave,
  projectBattlemasterCache,
} from "../src/project-battlemaster.js";

function syntheticCache(): Record<string, unknown> {
  return {
    bakedAt: "2026-08-11T21:35:33Z",
    version: 2,
    templateCatalog: {
      v: 1,
      k: "bmtc",
      id: "bm-test@1",
      u: "in",
      a: "c",
      q: [["Wall", 2, 1]],
      t: [["tpl-test", 4, 3, [[0, -1, -0.5, 90, 0]], "sr", "d", "wall"]],
    },
    layoutCatalog: {
      layoutCount: 1,
      layouts: [
        {
          id: "terrain-test",
          name: "Take vs Take 01",
          missionPackId: "chapter-approved-2026",
          chapterApprovedSlot: {
            archetypeA: "take-and-hold",
            archetypeB: "take-and-hold",
            slotIndex: 1,
          },
          chapterApprovedDeploymentKey: 6,
        },
      ],
    },
    layoutPayloadCache: {
      test: {
        payload: {
          v: 1,
          k: "bml",
          id: "terrain-test",
          b: "sf60x44",
          a: "c",
          i: [[0, 5, -4, 90, 1, "c1"]],
        },
      },
    },
  };
}

function bakedLua(): string {
  return `-- BM_BAKED_CACHE_START
BM_BAKED_CACHE={}
BM_BAKED_CACHE["bakedAt"]="2026-08-11T21:35:33Z"
BM_BAKED_CACHE["layoutCatalog"]={ ["layoutCount"]=1, ["layouts"]={} }
BM_BAKED_CACHE["layoutPayloadCache"]={}
BM_BAKED_CACHE["layoutPayloadCache"]["key"]={ ["payload"]={ ["i"]={ [1]={ [1]=0, [2]=-5.5 } } } }
BM_BAKED_CACHE["templateCatalog"]={ ["id"]="bm-test@1", ["q"]={}, ["t"]={} }
BM_BAKED_CACHE["themePayload"]={}
BM_BAKED_CACHE["themePayload"]["m"][1]={ [1]=0 }
BM_BAKED_CACHE["version"]=2
-- BM_BAKED_CACHE_END`;
}

describe("Battlemaster read-only projector", () => {
  it("decodes only the geometry-bearing sections of the spawner's baked Lua cache", () => {
    const cache = decodeBakedCache(bakedLua());

    expect(cache).toEqual({
      bakedAt: "2026-08-11T21:35:33Z",
      layoutCatalog: { layoutCount: 1, layouts: {} },
      layoutPayloadCache: {
        key: { payload: { i: [[0, -5.5]] } },
      },
      templateCatalog: { id: "bm-test@1", q: {}, t: {} },
      version: 2,
    });
  });

  it("extracts the baked cache from a Tabletop Simulator BSON save", () => {
    const save = BSON.serialize({
      SaveName: "Battlemaster Map Spawner",
      ObjectStates: [
        { Nickname: "Unrelated", LuaScript: "" },
        { Nickname: "Battlemaster", LuaScript: bakedLua() },
      ],
    });

    const cache = decodeSpawnerSave(save);
    expect(cache.bakedAt).toBe("2026-08-11T21:35:33Z");
    expect(cache.version).toBe(2);
  });

  it("projects source composites without flattening their features into layout pieces", () => {
    const projection = projectBattlemasterCache(syntheticCache(), "synthetic.tts");

    expect(projection.readonly).toBe(true);
    expect(projection.summary).toMatchObject({
      layouts: 1,
      layout_instances: 1,
      feature_instances: 1,
      feature_templates: 1,
      composite_templates: 1,
      resolved_pieces: 2,
      worst_area_error_inches: 0,
      worst_feature_error_inches: 0,
    });
    expect(projection.terrain_templates).toHaveLength(2);
    expect(projection.terrain_templates[1].features).toHaveLength(1);

    const layout = projection.terrain_layouts[0]!;
    expect(layout).toMatchObject({
      id: "take-and-hold-mirror-1",
      mission_matchup_id: "take-and-hold-vs-take-and-hold",
      variant: 1,
      deployment_pattern_id: "tipping-point",
    });
    expect(layout.pieces).toHaveLength(1);
    expect(layout.pieces[0]).toMatchObject({
      position: { x: 35, y: 26 },
      rotation_degrees: 270,
      mirror: "horizontal",
      link_group: "center",
      objective_role: "center",
      is_objective: true,
    });
  });

  it("fails closed when a source coordinate contract changes", () => {
    const cache = syntheticCache();
    (cache.templateCatalog as Record<string, unknown>).a = "corner";

    expect(() => projectBattlemasterCache(cache, "synthetic.tts")).toThrow(
      'templateCatalog.a: expected centre anchor "c"',
    );
  });
});
