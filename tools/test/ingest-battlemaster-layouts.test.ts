import { describe, expect, it } from "vitest";

import {
  applyMirror,
  areaPositionFromInstance,
  areaRotationFromInstance,
  offBoard,
  optimalAssignment,
  partCentreYUp,
  pointInPolygon,
  rotateCw,
} from "../src/battlemaster/geometry.js";
import {
  BOARD,
  DEPLOYMENT_KEY_TO_PATTERN,
  OBJECTIVE_CODE_TO_ROLE,
  SIZE_CLASS_TO_AREA_TEMPLATE,
  centroidToBoundsCentre,
  loadRepoLayouts,
  loadRepoTemplates,
  norm360,
  repoLayoutId,
  toBoardFrame,
} from "../src/battlemaster/repo.js";
import { PART_TO_TEMPLATE } from "../src/battlemaster/parts.js";
import { decodeTemplateCatalog } from "../src/battlemaster/source.js";
import { symmetryError, verify } from "../src/battlemaster/verify.js";
import type { Footprint } from "../src/terrain/resolve.js";

// Unit coverage for the Battlemaster intake's conversion primitives and for the
// invariants the ingested data must keep. The intake itself is authoring-time
// tooling that reads a gitignored snapshot, so these tests deliberately exercise
// the pure geometry + the committed result rather than the network path.

describe("frame conversion", () => {
  it("maps Battlemaster's centre-origin y-up frame onto board corner-origin y-down", () => {
    expect(toBoardFrame(0, 0)).toEqual({ x: 30, y: 22 });
    // +y is up for Battlemaster, so it must become a *smaller* board y.
    expect(toBoardFrame(0, 10)).toEqual({ x: 30, y: 12 });
    expect(toBoardFrame(-30, -22)).toEqual({ x: 0, y: 44 });
    expect(toBoardFrame(30, 22)).toEqual({ x: 60, y: 0 });
  });

  it("rotates clockwise in the y-down frame, matching the resolver", () => {
    const r = rotateCw({ x: 1, y: 0 }, 90);
    expect(r.x).toBeCloseTo(0, 10);
    expect(r.y).toBeCloseTo(1, 10);
  });

  it("mirrors before rotating", () => {
    expect(applyMirror({ x: 2, y: 3 }, "horizontal")).toEqual({ x: -2, y: 3 });
    expect(applyMirror({ x: 2, y: 3 }, "vertical")).toEqual({ x: 2, y: -3 });
    expect(applyMirror({ x: 2, y: 3 }, "none")).toEqual({ x: 2, y: 3 });
  });

  it("normalises rotations into [0, 360)", () => {
    expect(norm360(-90)).toBe(270);
    expect(norm360(360)).toBe(0);
    expect(norm360(450)).toBe(90);
  });
});

describe("part placement", () => {
  // A Battlemaster part's stored position is its local *min corner*, and rotation is
  // counter-clockwise about that corner in the y-up frame. Both were pinned by
  // checking that every catalog part lands inside its composite's declared bbox.
  it("treats the part position as its min corner, so a centred part comes out centred", () => {
    // The `pipes` composite: one 6x1 part at (-3, -0.5) fills a 6.003x2.003 box.
    expect(partCentreYUp(6, 1, -3, -0.5, 0, 0)).toEqual({ x: 0, y: 0 });
  });

  it("rotates counter-clockwise about the part origin", () => {
    // The `ef` part of an 11.503x7.003 composite: a 4.5x6 part whose origin sits at
    // (5.2485, -3.5015). Read counter-clockwise it spans x in [-0.7515, 5.2485] and so
    // fits the composite's +-5.7515 half-extent; read clockwise it would reach x =
    // 11.2485 and fall outside. That containment is how the handedness was pinned.
    const ccw = partCentreYUp(4.5, 6, 5.2485, -3.5015, 90, 0);
    expect(ccw.x).toBeCloseTo(2.2485, 4);
    expect(ccw.y).toBeCloseTo(-1.2515, 4);
    expect(ccw.x + 4.5 / 2).toBeLessThan(5.7515);
    // Sanity-check the contrast: a -90 (clockwise) reading escapes the composite.
    expect(partCentreYUp(4.5, 6, 5.2485, -3.5015, -90, 0).x + 3).toBeGreaterThan(5.7515);
  });

  it("keeps a 180-degree rotation centred on the same point", () => {
    const c = partCentreYUp(4.5, 2, 2.2485, 0.9985, 180, 0);
    expect(c.x).toBeCloseTo(-0.0015, 4);
    expect(c.y).toBeCloseTo(-0.0015, 4);
  });
});

describe("anchor compensation", () => {
  // The nub story: Battlemaster anchors the artwork bbox centre, 40kdc anchors the
  // nubbed footprint's polygon area centroid. For an asymmetric footprint they differ
  // by inches, which is why 196 committed placements were wrong.
  const trapezoid: Footprint = {
    type: "polygon",
    points: [
      { x: 0, y: 0 },
      { x: 8, y: 0 },
      { x: 2, y: 11.5 },
      { x: 0, y: 11.5 },
    ],
  };

  it("measures the centroid-to-bbox-centre offset", () => {
    const d = centroidToBoundsCentre(trapezoid);
    expect(d.x).toBeCloseTo(1.2, 6);
    expect(d.y).toBeCloseTo(1.15, 6);
  });

  it("is zero for a symmetric footprint", () => {
    const d = centroidToBoundsCentre({ type: "rectangle", width: 6, height: 4 });
    expect(d.x).toBeCloseTo(0, 10);
    expect(d.y).toBeCloseTo(0, 10);
  });

  it("places the piece so its bbox centre lands on Battlemaster's position", () => {
    // The contract: position = raw - R*M*(centroid->bboxCentre). Recovering the bbox
    // centre from the result must give Battlemaster's own coordinates back.
    const inst = { templateIndex: 0, x: 4, y: -6, rotation: 0, mirror: 0, objectiveCode: null };
    for (const rotation of [0, 90, 180, 270]) {
      const pos = areaPositionFromInstance(inst, trapezoid, rotation, "none");
      const back = rotateCw(centroidToBoundsCentre(trapezoid), rotation);
      const raw = toBoardFrame(inst.x, inst.y);
      expect(pos.x + back.x).toBeCloseTo(raw.x, 8);
      expect(pos.y + back.y).toBeCloseTo(raw.y, 8);
    }
  });

  it("adds the calibrated orientation offset to the instance rotation", () => {
    const inst = { templateIndex: 0, x: 0, y: 0, rotation: 310, mirror: 0, objectiveCode: null };
    expect(areaRotationFromInstance(inst, 180)).toBe(130);
    expect(areaRotationFromInstance(inst, 0)).toBe(310);
  });
});

describe("optimalAssignment", () => {
  // Greedy nearest-neighbour is not good enough: the placements needing correction are
  // 1-6" out, exactly where greedy steals another piece's partner.
  it("returns a minimum-cost pairing, and beats in-order greedy where they differ", () => {
    // Rather than a contrived example, assert the property the function promises:
    // its cost is the minimum over every permutation. Points are fixed, not random,
    // so a failure is reproducible.
    const from = [
      { x: 0, y: 0 },
      { x: 3, y: 1 },
      { x: 1, y: 4 },
      { x: 6, y: 6 },
    ];
    const to = [
      { x: 2.5, y: 1.2 },
      { x: 6.4, y: 5.5 },
      { x: 0.2, y: 0.4 },
      { x: 1.4, y: 3.6 },
    ];
    const cost = (perm: number[]): number =>
      perm.reduce((s, t, i) => s + Math.hypot(from[i]!.x - to[t]!.x, from[i]!.y - to[t]!.y), 0);

    const perms: number[][] = [];
    const walk = (rest: number[], acc: number[]): void => {
      if (rest.length === 0) return void perms.push(acc);
      rest.forEach((v, i) => walk([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, v]));
    };
    walk([0, 1, 2, 3], []);
    const best = Math.min(...perms.map(cost));

    expect(cost(optimalAssignment(from, to))).toBeCloseTo(best, 10);
  });

  it("beats in-order greedy, the failure mode it exists to avoid", () => {
    // Greedy lets the first piece claim its nearest partner even when a later piece
    // needs that partner far more — precisely what happens at the 1-6" errors the
    // intake corrects. Here greedy pays 11.9 where the optimum is 10.1.
    const from = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    const to = [
      { x: 0.9, y: 0 },
      { x: -1, y: 0 },
    ];
    const cost = (perm: number[]): number =>
      perm.reduce((s, t, i) => s + Math.hypot(from[i]!.x - to[t]!.x, from[i]!.y - to[t]!.y), 0);

    expect(optimalAssignment(from, to)).toEqual([1, 0]);
    expect(cost([1, 0])).toBeCloseTo(10.1, 10);
    // Greedy would take to[0] for from[0] (0.9 < 1.0) and strand from[1] with to[1].
    expect(cost([0, 1])).toBeCloseTo(11.9, 10);
  });

  it("is the identity when each point is already closest to its partner", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(optimalAssignment(pts, pts)).toEqual([0, 1]);
  });

  it("refuses mismatched lengths rather than silently truncating", () => {
    expect(() => optimalAssignment([{ x: 0, y: 0 }], [])).toThrow(/equal lengths/);
  });
});

describe("board helpers", () => {
  it("flags vertices past the board edge", () => {
    expect(offBoard({ x: 30, y: 22 })).toBe(false);
    expect(offBoard({ x: -1, y: 22 })).toBe(true);
    expect(offBoard({ x: 30, y: BOARD.height + 1 })).toBe(true);
  });

  it("tests point containment for a concave polygon", () => {
    const l = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 4 },
      { x: 0, y: 4 },
    ];
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, l)).toBe(true);
    expect(pointInPolygon({ x: 3, y: 3 }, l)).toBe(false);
  });
});

describe("wire-format decoding", () => {
  it("rejects a catalog that is not in inches or not centre-anchored", () => {
    const base = { id: "c", u: "in", a: "c", q: [], t: [] };
    expect(() => decodeTemplateCatalog({ ...base, u: "mm" })).toThrow(/units/);
    expect(() => decodeTemplateCatalog({ ...base, a: "tl" })).toThrow(/anchor/);
  });

  it("rejects a part reference outside the part table", () => {
    expect(() =>
      decodeTemplateCatalog({
        id: "c",
        u: "in",
        a: "c",
        q: [["Pipes", 6, 1]],
        t: [["tpl-x", 6, 2, [[7, 0, 0, 0, 0]], "sl", "d", "pipes"]],
      }),
    ).toThrow(/out of range/);
  });
});

describe("identity maps", () => {
  it("derives the repo layout id from a Battlemaster slot", () => {
    expect(
      repoLayoutId({ archetypeA: "take-and-hold", archetypeB: "take-and-hold", slotIndex: 2 }),
    ).toBe("take-and-hold-mirror-2");
    expect(
      repoLayoutId({ archetypeA: "disruption", archetypeB: "purge-the-foe", slotIndex: 1 }),
    ).toBe("disruption-vs-purge-the-foe-1");
  });

  it("maps every size class to a template that exists, and every part likewise", () => {
    const ids = new Set(loadRepoTemplates().map((t) => t.id));
    for (const [sizeClass, template] of Object.entries(SIZE_CLASS_TO_AREA_TEMPLATE)) {
      expect(ids, `size class ${sizeClass}`).toContain(template);
    }
    for (const [part, template] of Object.entries(PART_TO_TEMPLATE)) {
      expect(ids, `part ${part}`).toContain(template);
    }
  });

  it("maps every deployment key to a known pattern id", () => {
    const patterns = new Set(
      Object.values(DEPLOYMENT_KEY_TO_PATTERN).map((p) => p),
    );
    expect(patterns.size).toBe(Object.keys(DEPLOYMENT_KEY_TO_PATTERN).length);
    for (const role of Object.values(OBJECTIVE_CODE_TO_ROLE)) {
      expect(["home", "expansion", "center"]).toContain(role);
    }
  });
});

describe("ingested terrain layouts", () => {
  const layouts = loadRepoLayouts();
  const templates = loadRepoTemplates();

  it("resolves, stays on the board, and keeps 180-degree symmetry", () => {
    const r = verify(layouts, templates);
    expect(r.resolveFailures).toEqual([]);
    expect(r.offBoard).toEqual([]);
    expect(r.asymmetric).toEqual([]);
  });

  it("keeps the deployment pattern each Chapter Approved card ships with", () => {
    const known = new Set(Object.values(DEPLOYMENT_KEY_TO_PATTERN));
    for (const l of layouts) {
      if (!l.mission_matchup_id || l.deployment_pattern_id === undefined) continue;
      if (l.id === "kotc-colosseum") continue;
      expect(known, `${l.id}`).toContain(l.deployment_pattern_id);
    }
  });

  it("parents every feature piece to an area in its own layout", () => {
    for (const l of layouts) {
      const areas = new Set(
        (l.pieces ?? [])
          .filter((p) => (p.piece_type ?? "area") === "area" && p.id)
          .map((p) => p.id!),
      );
      for (const p of l.pieces ?? []) {
        if (!p.parent_area_id) continue;
        expect(areas, `${l.id}/${p.id}`).toContain(p.parent_area_id);
      }
    }
  });

  it("gives every piece in a layout a unique id", () => {
    for (const l of layouts) {
      const ids = (l.pieces ?? []).map((p) => p.id).filter(Boolean);
      expect(new Set(ids).size, `${l.id}`).toBe(ids.length);
    }
  });

  it("repairs the upstream symmetry slip on the two cards that carried one", () => {
    // Battlemaster places these cards' paired centre trapezoids 0.707" off the
    // symmetric ideal — an upstream slip (identical coordinates on both cards, exactly
    // 180-degree-apart rotations, a round (-0.5, -0.5) error). The intake snaps the
    // pair to its symmetric mean, because propagating it would break keystone-pairing.
    for (const id of ["disruption-vs-disruption-1", "reconnaissance-vs-reconnaissance-2"]) {
      const l = layouts.find((x) => x.id === id);
      expect(l, id).toBeDefined();
      expect(symmetryError(l!).worst, id).toBeLessThan(0.01);
    }
  });

  it("keeps every Chapter Approved card exactly 180-degree symmetric", () => {
    for (const l of layouts) {
      if (!l.mission_matchup_id || l.id === "kotc-colosseum") continue;
      expect(symmetryError(l).worst, l.id).toBeLessThan(0.01);
    }
  });
});
