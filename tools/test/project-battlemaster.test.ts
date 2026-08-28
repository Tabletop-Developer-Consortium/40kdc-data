import { BSON } from "bson";
import { describe, expect, it, vi } from "vitest";

import {
  decodeBakedCache,
  decodeSpawnerSave,
  mergeBattlemasterProjection,
  projectBattlemasterCache,
  projectBattlemasterRestApi,
} from "../src/project-battlemaster.js";
import type { TerrainLayout, TerrainTemplate } from "../src/terrain/resolve.js";
import { resolveLayout } from "../src/terrain/resolve.js";

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
      t: [
        ["tpl-test", 6.003, 4.003, [[0, -1, -0.5, 90, 0]], "sr", "d", "wall"],
      ],
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

function canonicalTemplates(): TerrainTemplate[] {
  return [
    {
      id: "area-medium",
      kind: "area",
      footprint: {
        type: "polygon",
        points: [
          { x: 0, y: 0 },
          { x: 6, y: 0 },
          { x: 6, y: 4 },
          { x: 3.5, y: 4 },
          { x: 3, y: 4.2 },
          { x: 2.5, y: 4 },
          { x: 0, y: 4 },
        ],
      },
    },
  ];
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
    const projection = projectBattlemasterCache(
      syntheticCache(),
      "synthetic.tts",
      canonicalTemplates(),
    );

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
    const footprint = projection.terrain_templates[1]!.footprint;
    expect(footprint.type).toBe("polygon");
    if (footprint.type !== "polygon") {
      throw new Error("projected area footprint must be a polygon");
    }
    expect(footprint.points.length).toBeGreaterThan(4);

    const layout = projection.terrain_layouts[0]!;
    expect(layout).toMatchObject({
      id: "take-and-hold-mirror-1",
      mission_matchup_id: "take-and-hold-vs-take-and-hold",
      variant: 1,
      deployment_pattern_id: "tipping-point",
    });
    expect(layout.pieces).toHaveLength(1);
    expect(layout.pieces[0]).toMatchObject({
      rotation_degrees: 270,
      mirror: "horizontal",
      link_group: "center",
      objective_role: "center",
      is_objective: true,
    });
    expect(layout.pieces[0]!.position.x).not.toBe(35);
    expect(layout.pieces[0]!.position.y).toBeCloseTo(25.9985);
  });

  it("projects REST API layouts with source metadata and composed walls", async () => {
    const meta = {
      slug: "take-vs-take-01",
      name: "Take vs Take 01",
      owner: "test-owner",
      chapterApprovedSlot: {
        slotIndex: 1,
        archetypeA: "take-and-hold",
        archetypeB: "take-and-hold",
      },
      chapterApprovedDeploymentKey: 6,
    };
    const detail = {
      layout: meta,
      units: { linear: "in", origin: "center", yAxis: "up" },
      terrain: [
        {
          name: "SmallRect Generator",
          kind: "area",
          footprint: {
            origin: { x: 0, y: 0 },
            widthIn: 6.003,
            heightIn: 4.003,
            rotationDeg: 0,
          },
          outline: {
            points: [
              { x: 0, y: 0 },
              { x: 6.003, y: 0 },
              { x: 6.003, y: 4.003 },
              { x: 0, y: 4.003 },
            ],
          },
          walls: [],
          parts: [
            {
              name: "Generator",
              material: "dense",
              hasRoof: true,
              origin: { x: 1, y: 1 },
              rotationDeg: 0,
              mirroredX: false,
              mirroredY: false,
              boundsWidthIn: 4,
              boundsHeightIn: 2,
              outline: null,
              walls: [
                {
                  points: [
                    { x: 0, y: 0 },
                    { x: 4, y: 0 },
                  ],
                  thicknessIn: 0.25,
                },
              ],
            },
          ],
        },
      ],
      deployment: {
        deploymentKey: 6,
        objectives: [{ index: 4, center: { x: 0, y: 1 }, diameterMm: null }],
        zones: [],
      },
    };
    const lite = {
      format: "battlemaster.tts.chapter-approved-layout-lite",
      version: 1,
      layout: {
        id: "terrain-test",
        name: meta.name,
        ownerUsername: "test-owner",
        chapterApprovedSlot: meta.chapterApprovedSlot,
        chapterApprovedDeploymentKey: 6,
      },
      litePayload: {
        v: 1,
        k: "bml",
        b: "sf60x44",
        a: "c",
        id: "terrain-test",
        s: ["take-and-hold", "take-and-hold", 1, 6],
        i: [[0, 3.0015, 2.0015, 0, 0, "n"]],
      },
    };
    const fetch = vi.fn(async function fetchFixture(
      input: string | URL | Request,
    ): Promise<Response> {
      const url = String(input);
      let body: unknown = { layouts: [meta], totalCount: 1 };
      if (url.includes("/chapter-approved-layout-lite")) {
        body = lite;
      } else if (url.includes("/layouts/test-owner/")) {
        body = detail;
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const projection = await projectBattlemasterRestApi({
      owner: "test-owner",
      fetch,
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(projection.source).toMatchObject({
      kind: "rest-api",
      owner: "test-owner",
    });
    expect(projection.summary).toMatchObject({
      source_kind: "rest-api",
      layouts: 1,
      layout_instances: 1,
      feature_instances: 2,
      feature_templates: 1,
      composite_templates: 1,
      resolved_pieces: 2,
    });
    const featureTemplate = projection.terrain_templates.find(
      (template) => template.kind === "feature",
    )!;
    const compositeTemplate = projection.terrain_templates.find(
      (template) => template.kind === "area",
    )!;
    expect(featureTemplate).toMatchObject({
      id: expect.stringMatching(/^bm-part-generator-[a-f0-9]{10}$/),
      has_roof: true,
      terrain_category: "dense",
      walls: [expect.objectContaining({ thickness: 0.25 })],
    });
    expect(compositeTemplate).toMatchObject({
      id: expect.stringMatching(
        /^bm-composite-smallrect-generator-[a-f0-9]{10}$/,
      ),
      features: [expect.objectContaining({ template: featureTemplate.id })],
    });

    const resolved = resolveLayout(
      projection.terrain_layouts[0]!,
      projection.terrain_templates,
    );
    // fp.origin (0, 0) is the piece-local corner, so the 6.003x4.003 footprint
    // spans board x [30, 36.003], y [17.997, 22]; the 4x2 part at part-local
    // origin (1, 1) lands at x [31, 35], y [19, 21].
    expect(resolved[1]).toMatchObject({
      id: "area-01--feature-1",
      vertices: [
        { x: 31, y: 21 },
        { x: 35, y: 21 },
        { x: 35, y: 19 },
        { x: 31, y: 19 },
      ],
      walls: [
        {
          points: [
            { x: 31, y: 21 },
            { x: 35, y: 21 },
          ],
          thickness: 0.25,
        },
      ],
    });
    expect(projection.terrain_layouts[0]).toMatchObject({
      id: "bm-take-vs-take-01",
      mission_matchup_id: "take-and-hold-vs-take-and-hold",
      deployment_pattern_id: "tipping-point",
      pieces: [
        expect.objectContaining({
          is_objective: true,
          objective_role: "expansion",
          objective: { position: { x: 33.0015, y: 19.9985 } },
        }),
      ],
    });

    lite.litePayload.i[0]![5] = 7;
    await expect(
      projectBattlemasterRestApi({ owner: "test-owner", fetch }),
    ).rejects.toThrow("litePayload.i[0][5]: expected a non-empty string");

    lite.litePayload.i[0]![5] = "n";
    lite.litePayload.i[0]![1] = 4;
    await expect(
      projectBattlemasterRestApi({ owner: "test-owner", fetch }),
    ).rejects.toThrow("lite instance pose does not match the REST terrain footprint");
  });

  it("replaces all projected layouts while preserving unrelated terrain", () => {
    const projection = projectBattlemasterCache(
      syntheticCache(),
      "synthetic.tts",
      canonicalTemplates(),
    );
    const existingLayouts: TerrainLayout[] = [
      {
        ...projection.terrain_layouts[0]!,
        name: "Superseded layout",
        source: "custom",
      },
      {
        id: "kotc-layout",
        name: "KOTC layout",
        source: "kotc",
        description: "Independent terrain.",
        pieces: [],
        game_version: { edition: "11th", dataslate: "pre-launch-provisional" },
      },
    ];
    const existingTemplates: TerrainTemplate[] = [
      {
        id: "bm-old-composite",
        name: "Stale Battlemaster template",
        kind: "area",
        source: "battlemaster-11e",
        footprint: { type: "rectangle", width: 1, height: 1 },
        game_version: { edition: "11th", dataslate: "pre-launch-provisional" },
      },
      {
        ...projection.terrain_templates[0]!,
        source: "custom",
      },
      {
        id: "kotc-template",
        name: "KOTC template",
        kind: "area",
        source: "kotc",
        footprint: { type: "rectangle", width: 1, height: 1 },
        game_version: { edition: "11th", dataslate: "pre-launch-provisional" },
      },
    ];

    const merged = mergeBattlemasterProjection(
      existingLayouts,
      existingTemplates,
      projection,
    );

    expect(merged.terrainLayouts.map((layout) => layout.id)).toEqual([
      "kotc-layout",
      "take-and-hold-mirror-1",
    ]);
    expect(merged.terrainLayouts[1]!.name).toBe("Take vs Take 01");
    expect(merged.terrainTemplates.map((template) => template.id)).toEqual([
      "bm-bm-test-1-composite-01-m1-p0",
      "bm-bm-test-1-part-wall",
      "kotc-template",
    ]);
  });

  it("fails closed when a source coordinate contract changes", () => {
    const cache = syntheticCache();
    (cache.templateCatalog as Record<string, unknown>).a = "corner";

    expect(() =>
      projectBattlemasterCache(cache, "synthetic.tts", canonicalTemplates()),
    ).toThrow('templateCatalog.a: expected centre anchor "c"');
  });

  it("fails closed when source version or kind discriminators drift", () => {
    for (const [mutate, expected] of [
      [
        (cache: Record<string, unknown>) => {
          cache.version = 3;
        },
        "version: expected 2",
      ],
      [
        (cache: Record<string, unknown>) => {
          (cache.templateCatalog as Record<string, unknown>).v = 2;
        },
        "templateCatalog.v: expected 1",
      ],
      [
        (cache: Record<string, unknown>) => {
          (cache.templateCatalog as Record<string, unknown>).k = "next";
        },
        'templateCatalog.k: expected "bmtc"',
      ],
      [
        (cache: Record<string, unknown>) => {
          const payload = (
            cache.layoutPayloadCache as Record<
              string,
              { payload: Record<string, unknown> }
            >
          ).test!.payload;
          payload.v = 2;
        },
        "layoutPayloadCache[].payload.v: expected 1",
      ],
      [
        (cache: Record<string, unknown>) => {
          const payload = (
            cache.layoutPayloadCache as Record<
              string,
              { payload: Record<string, unknown> }
            >
          ).test!.payload;
          payload.k = "next";
        },
        'layoutPayloadCache[].payload.k: expected "bml"',
      ],
    ] as const) {
      const cache = syntheticCache();
      mutate(cache);
      expect(() =>
        projectBattlemasterCache(cache, "synthetic.tts", canonicalTemplates()),
      ).toThrow(expected);
    }
  });

  it("fails closed when source dimensions or mirror encodings drift", () => {
    const dimensions = syntheticCache();
    (
      (dimensions.templateCatalog as Record<string, unknown>).t as unknown[][]
    )[0]![1] = 7;
    expect(() =>
      projectBattlemasterCache(
        dimensions,
        "synthetic.tts",
        canonicalTemplates(),
      ),
    ).toThrow("sr dimensions changed");

    const partMirror = syntheticCache();
    (
      (
        (partMirror.templateCatalog as Record<string, unknown>).t as unknown[][]
      )[0]![3] as unknown[][]
    )[0]![4] = 2;
    expect(() =>
      projectBattlemasterCache(
        partMirror,
        "synthetic.tts",
        canonicalTemplates(),
      ),
    ).toThrow("expected binary 0 or 1");

    const instanceMirror = syntheticCache();
    const payload = (
      instanceMirror.layoutPayloadCache as Record<
        string,
        { payload: { i: unknown[][] } }
      >
    ).test!.payload;
    payload.i[0]![4] = -1;
    expect(() =>
      projectBattlemasterCache(
        instanceMirror,
        "synthetic.tts",
        canonicalTemplates(),
      ),
    ).toThrow("expected binary 0 or 1");
  });

  it("fails closed when the canonical nub shape or every candidate pose is invalid", () => {
    const flattened = canonicalTemplates();
    flattened[0]!.footprint = { type: "rectangle", width: 6, height: 4 };
    expect(() =>
      projectBattlemasterCache(syntheticCache(), "synthetic.tts", flattened),
    ).toThrow("expected the canonical nubbed polygon footprint");

    const escaped = syntheticCache();
    const part = (
      (
        (escaped.templateCatalog as Record<string, unknown>).t as unknown[][]
      )[0]![3] as unknown[][]
    )[0]!;
    part[1] = 100;
    expect(() =>
      projectBattlemasterCache(escaped, "synthetic.tts", canonicalTemplates()),
    ).toThrow("no canonical area pose contains its source features");
  });
});
