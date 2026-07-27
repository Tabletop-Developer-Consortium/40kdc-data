import { describe, it, expect } from "vitest";
import {
  layoutWarnings,
  isRoundKeystone,
  keystoneDisplays,
  toCanonicalJson,
  orientPiece,
  verticesOf,
  boardCentroid,
  cardinalCornerIndices,
  reanchorToNearestArea,
  reanchorAllFeatures,
  templateById,
  eventCompanionPage,
  referenceImageBox,
  type EditLayout,
  type EditPiece,
} from "./model.js";

/** A rectangle piece placed centroid-at-`position` (inline footprint, no catalog dep). */
function rect(
  id: string,
  width: number,
  height: number,
  position: { x: number; y: number },
  extra: Partial<EditPiece> = {},
): EditPiece {
  return {
    id,
    piece_type: "area",
    footprint: { type: "rectangle", width, height },
    position,
    rotation_degrees: 0,
    mirror: "none",
    ...extra,
  };
}

function layout(pieces: EditPiece[]): EditLayout {
  return { id: "test", name: "Test", pieces };
}

describe("isRoundKeystone", () => {
  it("accepts clean quarter-inch marks", () => {
    for (const n of [16.25, 17.5, 16.0, 3, 21.0, 6.01]) {
      expect(isRoundKeystone(n)).toBe(true);
    }
  });
  it("rejects off-grid values (rounding errors)", () => {
    for (const n of [15.92, 21.12, 16.13]) {
      expect(isRoundKeystone(n)).toBe(false);
    }
  });
});

describe("collision warnings", () => {
  it("does not flag edge-abutting areas", () => {
    // Two 10×10 areas sharing the x=10 edge: centroids at (5,5) and (15,5).
    const l = layout([rect("a", 10, 10, { x: 5, y: 5 }), rect("b", 10, 10, { x: 15, y: 5 })]);
    expect(layoutWarnings(l).filter((w) => w.kind === "collision")).toHaveLength(0);
  });

  it("flags two overlapping areas", () => {
    // Second area shifted so it overlaps the first by a 3×10 strip.
    const l = layout([rect("a", 10, 10, { x: 5, y: 5 }), rect("b", 10, 10, { x: 12, y: 5 })]);
    const cols = layoutWarnings(l).filter((w) => w.kind === "collision");
    expect(cols).toHaveLength(1);
    expect(cols[0].pieceIds).toEqual(expect.arrayContaining(["a", "b"]));
    expect(cols[0].message).toContain("overlaps");
  });

  it("does not flag a feature sitting on its own parent area", () => {
    // Feature parented to area "a", centred on it (local origin = area centroid):
    // it overlaps the area, but they are one family, so no warning.
    const area = rect("a", 20, 20, { x: 30, y: 22 });
    const feat = rect("f", 4, 4, { x: 0, y: 0 }, { piece_type: "feature", parent_area_id: "a" });
    expect(layoutWarnings(layout([area, feat])).filter((w) => w.kind === "collision")).toHaveLength(0);
  });

  it("does not flag a feature spanning onto a linked (same link_group) area", () => {
    // Two baseplates that interlock as one logical area (shared link_group), like
    // the Take-and-Hold centre trapezoid pair. A ruin on one legitimately spans
    // onto its linked partner, so it must not warn.
    const a = rect("a", 10, 10, { x: 6, y: 6 }, { link_group: "Center" });
    const b = rect("b", 10, 10, { x: 15, y: 6 }, { link_group: "Center" });
    // a's centroid (6,6); local (5,0) → board (11,6), straddling a and b.
    const f = rect("f", 4, 4, { x: 5, y: 0 }, { piece_type: "feature", parent_area_id: "a" });
    expect(layoutWarnings(layout([a, b, f])).filter((w) => w.kind === "collision")).toHaveLength(0);
  });

  it("flags a feature that overlaps a different (non-parent) area", () => {
    // area "a" at left; area "b" at right; feature parented to "a" but placed far
    // enough (area-local) that it lands on top of "b" — the "flew across" bug.
    const a = rect("a", 10, 10, { x: 6, y: 6 });
    const b = rect("b", 10, 10, { x: 30, y: 6 });
    // a's centroid is (6,6); local (24,0) → board (30,6), centred on b.
    const f = rect("f", 4, 4, { x: 24, y: 0 }, { piece_type: "feature", parent_area_id: "a" });
    const cols = layoutWarnings(layout([a, b, f])).filter((w) => w.kind === "collision");
    expect(cols.length).toBeGreaterThanOrEqual(1);
    expect(cols.some((w) => w.pieceIds.includes("f") && w.pieceIds.includes("b"))).toBe(true);
  });
});

describe("keystone-not-round warnings", () => {
  function withLeftKeystone(minX: number): EditLayout {
    // Rectangle width 8 → min-x = position.x - 4. Left-edge keystone reads min-x.
    const p = rect("k", 8, 8, { x: minX + 4, y: 10 }, {
      keystones: [{ edge: "left", ref: { kind: "face", side: "min-x" } }],
    });
    return layout([p]);
  }

  it("does not flag a clean 16.25″ keystone", () => {
    const ks = layoutWarnings(withLeftKeystone(16.25)).filter((w) => w.kind === "keystone-not-round");
    expect(ks).toHaveLength(0);
  });

  it("flags an off-grid 15.92″ keystone", () => {
    const ks = layoutWarnings(withLeftKeystone(15.92)).filter((w) => w.kind === "keystone-not-round");
    expect(ks).toHaveLength(1);
    expect(ks[0].message).toContain("15.92");
    expect(ks[0].pieceIds).toEqual(["k"]);
  });
});

describe("keystoneDisplays honours the layout board", () => {
  // Regression: a far-edge keystone on the 36×36 KOTC board must measure against
  // 36, not the 60×44 package default. The bug read a near-centre ruin wall at
  // 21″ (44−23) instead of its true 13″ (36−23).
  function bottomFaceKeystoneAtY23(): EditPiece {
    // Rectangle height 8, centroid at y=19 → max-y face at board y=23.
    return rect("k", 8, 8, { x: 10, y: 19 }, {
      keystones: [{ edge: "bottom", ref: { kind: "face", side: "max-y" } }],
    });
  }

  it("measures against the layout's board, not the 60×44 default", () => {
    const on36: EditLayout = {
      id: "t",
      name: "T",
      board: { width: 36, height: 36 },
      pieces: [bottomFaceKeystoneAtY23()],
    };
    expect(keystoneDisplays(on36).find((d) => d.pieceId === "k")?.distance).toBe(13);
  });

  it("falls back to the 60×44 default when the layout has no board override", () => {
    const onDefault: EditLayout = { id: "t", name: "T", pieces: [bottomFaceKeystoneAtY23()] };
    expect(keystoneDisplays(onDefault).find((d) => d.pieceId === "k")?.distance).toBe(21);
  });
});

describe("empty-area (terrain:false) round-trips through canonical JSON", () => {
  it("emits terrain:false for an empty area and omits it for a terrain area", () => {
    const emptyObj = rect("obj-west", 6, 6, { x: 5.5, y: 18 }, {
      terrain: false,
      is_objective: true,
      objective_role: "expansion",
      objective: { control_range_inches: 3 },
    });
    const terrainArea = rect("cover", 6, 6, { x: 12, y: 12 });
    const json = toCanonicalJson(layout([emptyObj, terrainArea])) as [{ pieces: Record<string, unknown>[] }];
    const [obj, cover] = json[0].pieces;
    expect(obj.terrain).toBe(false);
    expect("terrain" in cover).toBe(false); // terrain area: default true, key omitted
  });
});

describe("cardinalCornerIndices", () => {
  it("returns every vertex of a 4-corner rectangle", () => {
    expect(cardinalCornerIndices({ type: "rectangle", width: 6, height: 4 })).toEqual([0, 1, 2, 3]);
  });

  it("collapses the nubbed area-medium footprint to its 4 cardinal corners", () => {
    const fp = templateById("area-medium")?.footprint;
    expect(fp).toBeTruthy();
    expect(new Set(cardinalCornerIndices(fp!))).toEqual(new Set([0, 13, 14, 15]));
  });
});

describe("orientPiece pins child features in place", () => {
  function areaWithFeature(patch: Partial<EditPiece> = {}): EditLayout {
    // A 20×20 area with an L-ish feature offset to one corner (rotated + off-centre
    // so a naive centroid-only pin would still spin or flip it).
    const area = rect("a", 20, 20, { x: 30, y: 22 });
    const feat = rect("f", 4, 6, { x: 5, y: -3 }, {
      piece_type: "feature",
      parent_area_id: "a",
      rotation_degrees: 90,
      ...patch,
    });
    return layout([area, feat]);
  }

  function expectFeatureUnmoved(before: EditLayout, run: (l: EditLayout) => void): void {
    const l = areaWithFeature();
    const v0 = verticesOf(before, "f");
    run(l);
    const v1 = verticesOf(l, "f");
    expect(v1).toHaveLength(v0.length);
    for (let i = 0; i < v0.length; i++) {
      expect(v1[i].x).toBeCloseTo(v0[i].x, 6);
      expect(v1[i].y).toBeCloseTo(v0[i].y, 6);
    }
  }

  it("flipping the area leaves the feature's board vertices unchanged", () => {
    expectFeatureUnmoved(areaWithFeature(), (l) => orientPiece(l, "a", { mirror: "horizontal" }));
  });

  it("rotating the area 90° leaves the feature's board vertices unchanged", () => {
    expectFeatureUnmoved(areaWithFeature(), (l) => orientPiece(l, "a", { rotation_degrees: 90 }));
  });

  it("does not fling a far-anchored feature off-table when its area is mirrored", () => {
    // Reproduce the "corner-short on the mirror-twin area" bug: a feature anchored
    // with a large area-local offset. A mirror must not translate it at all.
    const area = rect("a", 6, 4, { x: 49, y: 31 }, { rotation_degrees: 270 });
    const feat = rect("f", 2, 3, { x: 15.93, y: -38.52 }, {
      piece_type: "feature",
      parent_area_id: "a",
    });
    const l = layout([area, feat]);
    const before = boardCentroid(l, feat);
    orientPiece(l, "a", { mirror: "horizontal" });
    const after = boardCentroid(l, l.pieces.find((p) => p.id === "f")!);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });
});

describe("reanchorToNearestArea", () => {
  it("re-points a feature to the area it actually sits on, preserving board position", () => {
    // area "a" at left, area "b" at right; feature declared on "a" but its local
    // offset lands it on top of "b" (the swapped-parent bug).
    const a = rect("a", 10, 10, { x: 6, y: 6 });
    const b = rect("b", 10, 10, { x: 30, y: 6 });
    const f = rect("f", 4, 4, { x: 24, y: 0 }, { piece_type: "feature", parent_area_id: "a" });
    const l = layout([a, b, f]);
    const before = boardCentroid(l, f);
    reanchorToNearestArea(l, "f");
    const feat = l.pieces.find((p) => p.id === "f")!;
    expect(feat.parent_area_id).toBe("b");
    const after = boardCentroid(l, feat);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("is a no-op for a feature already on its nearest area", () => {
    const a = rect("a", 10, 10, { x: 6, y: 6 });
    const f = rect("f", 4, 4, { x: 0, y: 0 }, { piece_type: "feature", parent_area_id: "a" });
    const l = layout([a, f]);
    reanchorAllFeatures(l);
    expect(l.pieces.find((p) => p.id === "f")!.parent_area_id).toBe("a");
  });
});

describe("eventCompanionPage", () => {
  it.each([
    ["take-and-hold-vs-purge-the-foe", 1, 12],
    ["take-and-hold-vs-purge-the-foe", 3, 14],
    ["disruption-vs-purge-the-foe", 1, 27],
    ["disruption-vs-purge-the-foe", 3, 29],
    ["disruption-vs-reconnaissance", 1, 39],
    ["disruption-vs-reconnaissance", 3, 41],
  ])("maps %s variant %i to page %i", (mission_matchup_id, variant, page) => {
    expect(eventCompanionPage({ mission_matchup_id, variant })).toBe(page);
  });

  it.each([
    {},
    { mission_matchup_id: "unknown", variant: 1 },
    { mission_matchup_id: "take-and-hold-vs-purge-the-foe", variant: 0 },
    { mission_matchup_id: "take-and-hold-vs-purge-the-foe", variant: 4 },
    { mission_matchup_id: "take-and-hold-vs-purge-the-foe", variant: 1.5 },
  ])("rejects layouts without a mapped drawing", (layout) => {
    expect(eventCompanionPage(layout)).toBeNull();
  });
});

describe("referenceImageBox", () => {
  const board = { width: 60, height: 44 };

  it("fills the board unrotated", () => {
    const box = referenceImageBox(board, {});
    expect(box).toMatchObject({ x: 0, y: 0, width: 60, height: 44 });
    expect(box.transform).toContain("rotate(0 30 22)");
  });

  it("swaps the box dimensions on a quarter turn so it still covers the board", () => {
    // Sized board.height x board.width and centred: after rotate(90) about the centre it
    // lands back on 0,0..60,44. Keeping 60x44 here would leave the board uncovered.
    for (const turns of [1, 3]) {
      const box = referenceImageBox(board, { quarterTurns: turns });
      expect(box.width).toBe(44);
      expect(box.height).toBe(60);
      expect(box.x).toBeCloseTo(30 - 22, 6);
      expect(box.y).toBeCloseTo(22 - 30, 6);
      expect(box.transform).toContain(`rotate(${turns * 90} 30 22)`);
    }
  });

  it("keeps the full-board box on a half turn", () => {
    const box = referenceImageBox(board, { quarterTurns: 2 });
    expect(box).toMatchObject({ x: 0, y: 0, width: 60, height: 44 });
    expect(box.transform).toContain("rotate(180 30 22)");
  });

  it("normalises the turn count, including negatives", () => {
    expect(referenceImageBox(board, { quarterTurns: -1 }).transform).toContain("rotate(270");
    expect(referenceImageBox(board, { quarterTurns: 5 }).transform).toContain("rotate(90");
    expect(referenceImageBox(board, { quarterTurns: 4 }).transform).toContain("rotate(0");
  });

  it("maps a screen-space nudge onto the board's rotated axes", () => {
    // The board layer is rotated 90°, mapping board (x,y) to screen (height-y, x). So a
    // nudge of screen-right must translate board -y, and screen-down must translate +x.
    // Passing the numbers through unswapped would move the image at right angles to the
    // control the user pressed.
    expect(referenceImageBox(board, { offsetX: 3 }).transform).toContain("translate(0 -3)");
    expect(referenceImageBox(board, { offsetY: 2 }).transform).toContain("translate(2 0)");
    expect(referenceImageBox(board, { offsetX: 3, offsetY: 2 }).transform).toContain("translate(2 -3)");
  });

  it("scales about the board centre, and omits the scale entirely at 1", () => {
    expect(referenceImageBox(board, { scale: 1 }).transform).not.toContain("scale(");
    const zoomed = referenceImageBox(board, { scale: 1.25 }).transform;
    expect(zoomed).toContain("translate(30 22) scale(1.25) translate(-30 -22)");
  });

  it("ignores a non-positive scale rather than collapsing the image", () => {
    for (const scale of [0, -2, Number.NaN]) {
      expect(referenceImageBox(board, { scale }).transform).not.toContain("scale(");
    }
  });

  it("applies the nudge outermost so it stays screen-aligned under turn and zoom", () => {
    const t = referenceImageBox(board, { quarterTurns: 1, offsetX: 4, offsetY: -1, scale: 2 }).transform;
    expect(t.indexOf("translate(-1 -4)")).toBe(0);
    expect(t.indexOf("rotate(90")).toBeGreaterThan(0);
    expect(t.indexOf("scale(2)")).toBeGreaterThan(t.indexOf("rotate(90"));
  });
});
