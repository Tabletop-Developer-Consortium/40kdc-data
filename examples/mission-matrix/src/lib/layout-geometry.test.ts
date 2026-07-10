import { describe, expect, it } from "vitest";
import { Dataset } from "@alpaca-software/40kdc-data";
import { diagramModel, facingAngle } from "../../../_shared/layout-geometry.js";

// Real divider endpoints (board frame, 60×44) for the patterns whose facing
// behavior matters: the orthogonal pair locks in the unchanged baseline, the
// diagonal pair locks in the axis-snap (no more ~45° tilted labels).
const HAMMER = { from: { x: 30, y: 0 }, to: { x: 30, y: 44 } };
const DAWN = { from: { x: 0, y: 22 }, to: { x: 60, y: 22 } };
const CRUCIBLE = { from: { x: 15, y: 0 }, to: { x: 45, y: 44 } };
const SEARCH = { from: { x: 0, y: 0 }, to: { x: 60, y: 44 } };

describe("facingAngle", () => {
  it("hammer-and-anvil splits top/bottom in display (board left/right)", () => {
    expect(facingAngle(HAMMER, { x: 10, y: 22 })).toBe(180);
    expect(facingAngle(HAMMER, { x: 50, y: 22 })).toBe(0);
  });

  it("dawn-of-war splits left/right in display (board top/bottom)", () => {
    expect(facingAngle(DAWN, { x: 30, y: 10 })).toBe(-90);
    expect(facingAngle(DAWN, { x: 30, y: 34 })).toBe(90);
  });

  it("crucible-of-battle snaps its diagonal to a top/bottom split", () => {
    expect(facingAngle(CRUCIBLE, { x: 10, y: 22 })).toBe(180);
    expect(facingAngle(CRUCIBLE, { x: 50, y: 22 })).toBe(0);
  });

  it("search-and-destroy snaps its corner diagonal to a left/right split", () => {
    expect(facingAngle(SEARCH, { x: 30, y: 10 })).toBe(-90);
    expect(facingAngle(SEARCH, { x: 30, y: 34 })).toBe(90);
  });

  it("only ever returns the four axis-aligned angles", () => {
    const dividers = [HAMMER, DAWN, CRUCIBLE, SEARCH];
    for (const d of dividers) {
      for (let x = 5; x < 60; x += 10) {
        for (let y = 5; y < 44; y += 10) {
          expect([0, 90, -90, 180]).toContain(facingAngle(d, { x, y }));
        }
      }
    }
  });

  it("degenerate divider yields 0", () => {
    expect(facingAngle({ from: { x: 30, y: 22 }, to: { x: 30, y: 22 } }, { x: 10, y: 10 })).toBe(0);
  });
});

describe("diagramModel classifies empty areas", () => {
  const ds = Dataset.embedded();

  it("marks KOTC objectives (terrain:false) as empty, so they render as markers not terrain", () => {
    const kotc = ds.terrainLayouts.get("kotc-colosseum")!;
    const { pieceCategories } = diagramModel(ds, kotc);
    for (const id of ["obj-center", "obj-west", "obj-east", "obj-north", "obj-south"]) {
      expect(pieceCategories.get(id)).toBe("empty");
    }
  });

  it("leaves 11e terrain-area objectives unclassified as empty", () => {
    const th = ds.terrainLayouts.get("take-and-hold-vs-disruption-2")!;
    const { pieceCategories } = diagramModel(ds, th);
    // The large-area objectives are real terrain areas — never "empty".
    for (const id of ["area-large-31", "area-large-37"]) {
      expect(pieceCategories.get(id)).not.toBe("empty");
    }
  });
});
