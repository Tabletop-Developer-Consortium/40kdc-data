import { describe, it, expect } from "vitest";
import { layoutWarnings, isRoundKeystone, type EditLayout, type EditPiece } from "./model.js";

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
