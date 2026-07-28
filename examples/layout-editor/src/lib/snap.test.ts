/**
 * Keystone-grid snapping and the corner ("clock") picker.
 *
 * The load-bearing test here is "snapping leaves no roundness warning": it runs
 * the real resolver and the package's `keystoneMeasurements` over a snapped piece,
 * so it proves `snapToKeystoneGrid`'s inverse actually agrees with the forward
 * measurement. Everything else in this file is arithmetic that would otherwise be
 * plausible-looking and wrong.
 */
import { describe, it, expect } from "vitest";
import {
  snapAnchorOf,
  snapToKeystoneGrid,
  measureLine,
  nearestEdgesFor,
  cornerCandidates,
  pickCornerByDirection,
  keystonesForCorner,
  setCornerAnchor,
  replaceKeystone,
  suggestSolverSeed,
  isAxisAligned,
  cardEdgeName,
  layoutWarnings,
  movePiece,
  addTemplate,
  keystoneDisplays,
  isRoundKeystone,
  KEYSTONE_INCREMENT,
  DEFAULT_BOARD,
  worklistFor,
  loadEmbedded,
  addSet,
  type EditLayout,
  type EditPiece,
  type EditKeystone,
} from "./model.js";
import { TERRAIN_SETS } from "./sets.js";

const V = (index: number): EditKeystone["ref"] => ({ kind: "vertex", index });

/** An 8x8 rectangle whose vertex 0 is its (min-x, min-y) corner. */
function rectPiece(at = { x: 20, y: 15 }, extra: Partial<EditPiece> = {}): EditPiece {
  return {
    id: "p1",
    piece_type: "area",
    footprint: { type: "rectangle", width: 8, height: 8 },
    position: at,
    rotation_degrees: 0,
    mirror: "none",
    ...extra,
  };
}
const wrap = (pieces: EditPiece[], board?: { width: number; height: number }): EditLayout => ({
  id: "t",
  name: "T",
  pieces,
  ...(board ? { board } : {}),
});

describe("snapAnchorOf", () => {
  const cases: [string, EditKeystone[] | undefined, boolean][] = [
    ["one H + one V", [{ edge: "left", ref: V(0) }, { edge: "top", ref: V(0) }], true],
    ["H + V on different vertices", [{ edge: "left", ref: V(0) }, { edge: "top", ref: V(2) }], true],
    ["a face and a vertex", [{ edge: "left", ref: { kind: "face", side: "min-x" } }, { edge: "top", ref: V(0) }], true],
    ["two faces", [
      { edge: "left", ref: { kind: "face", side: "min-x" } },
      { edge: "bottom", ref: { kind: "face", side: "max-y" } },
    ], true],
    ["both on the x axis", [{ edge: "left", ref: V(0) }, { edge: "right", ref: V(1) }], false],
    ["a single keystone", [{ edge: "left", ref: V(0) }], false],
    ["none", undefined, false],
    ["three (a triangulation set)", [
      { edge: "left", ref: V(0) },
      { edge: "left", ref: V(1) },
      { edge: "top", ref: V(0) },
    ], false],
  ];
  it.each(cases)("%s -> armed=%s", (_label, keystones, armed) => {
    expect(snapAnchorOf(rectPiece(undefined, { keystones })) !== null).toBe(armed);
  });

  it("is not armed by a keystone whose vertex no longer exists", () => {
    expect(snapAnchorOf(rectPiece(undefined, {
      keystones: [{ edge: "left", ref: V(99) }, { edge: "top", ref: V(0) }],
    }))).toBeNull();
  });
});

describe("measureLine", () => {
  const p = rectPiece({ x: 20, y: 15 });
  // 8x8 centred at (20,15) => vertex 0 at (16,11); board 60x44.
  it.each([
    ["left", V(0), 16],
    ["top", V(0), 11],
    ["right", V(0), 60 - 16],
    ["bottom", V(0), 44 - 11],
    ["left", { kind: "face", side: "min-x" } as const, 16],
    ["right", { kind: "face", side: "max-x" } as const, 60 - 24],
  ])("%s -> %s", (edge, ref, want) => {
    expect(measureLine(p, DEFAULT_BOARD, p.position, { edge: edge as EditKeystone["edge"], ref })).toBeCloseTo(want as number, 9);
  });

  it("honours a per-layout board override", () => {
    expect(measureLine(p, { width: 36, height: 36 }, p.position, { edge: "right", ref: V(0) }))
      .toBeCloseTo(36 - 16, 9);
  });

  it("returns null for a stale vertex", () => {
    expect(measureLine(p, DEFAULT_BOARD, p.position, { edge: "left", ref: V(99) })).toBeNull();
  });
});

describe("snapToKeystoneGrid", () => {
  const armed = (extra: Partial<EditPiece> = {}): EditPiece =>
    rectPiece({ x: 20, y: 15 }, {
      keystones: [{ edge: "left", ref: V(0) }, { edge: "top", ref: V(0) }],
      ...extra,
    });

  it("rounds the printed distances and back-solves the centroid", () => {
    // 8x8 centred at (20.31, 15.12) => vertex 0 at (16.31, 11.12), so the printed
    // pair reads 16.31 / 11.12 and snaps to 16.25 / 11.00 => centroid (20.25, 15.00).
    const r = snapToKeystoneGrid(armed(), DEFAULT_BOARD, { x: 20.31, y: 15.12 })!;
    expect(r.before).toEqual({ x: 16.31, y: 11.12 });
    expect(r.distances).toEqual({ x: 16.25, y: 11 });
    expect(r.position.x).toBeCloseTo(20.25, 9);
    expect(r.position.y).toBeCloseTo(15, 9);
  });

  it("works off the far edges, landing on the same centroid as the near ones", () => {
    // right = 60 − 16.31 = 43.69 → 43.75; bottom = 44 − 11.12 = 32.88 → 33.00.
    // Both invert to the same placement the near-edge pair above resolves to,
    // which is the near/far arithmetic agreeing.
    const p = armed({ keystones: [{ edge: "right", ref: V(0) }, { edge: "bottom", ref: V(0) }] });
    const r = snapToKeystoneGrid(p, DEFAULT_BOARD, { x: 20.31, y: 15.12 })!;
    expect(r.before).toEqual({ x: 43.69, y: 32.88 });
    expect(r.distances).toEqual({ x: 43.75, y: 33 });
    expect(r.position.x).toBeCloseTo(20.25, 9);
    expect(r.position.y).toBeCloseTo(15, 9);
  });

  it.each([0.25, 0.5, 1])("quantizes to a %s inch step", (step) => {
    const r = snapToKeystoneGrid(armed(), DEFAULT_BOARD, { x: 20.31, y: 15.12 }, step)!;
    for (const d of [r.distances.x, r.distances.y]) {
      expect(Math.abs(d / step - Math.round(d / step))).toBeLessThan(1e-9);
    }
  });

  it("is idempotent — a snapped position does not creep", () => {
    const p = armed();
    const once = snapToKeystoneGrid(p, DEFAULT_BOARD, { x: 20.31, y: 15.12 })!;
    const twice = snapToKeystoneGrid(p, DEFAULT_BOARD, once.position)!;
    expect(twice.position).toEqual(once.position);
    expect(twice.distances).toEqual(once.distances);
  });

  it("returns null rather than throwing on an unsnappable piece", () => {
    expect(snapToKeystoneGrid(rectPiece(), DEFAULT_BOARD, { x: 1, y: 1 })).toBeNull();
    expect(snapToKeystoneGrid(armed({ footprint: undefined }), DEFAULT_BOARD, { x: 1, y: 1 })).toBeNull();
    expect(snapToKeystoneGrid(armed(), DEFAULT_BOARD, { x: 1, y: 1 }, 0)).toBeNull();
    expect(
      snapToKeystoneGrid(
        armed({ keystones: [{ edge: "left", ref: V(99) }, { edge: "top", ref: V(0) }] }),
        DEFAULT_BOARD,
        { x: 1, y: 1 },
      ),
    ).toBeNull();
  });

  it("snaps a rotated piece too (the anchor, not a centroid grid)", () => {
    const p = armed({ rotation_degrees: 37 });
    const r = snapToKeystoneGrid(p, DEFAULT_BOARD, { x: 20.31, y: 15.12 })!;
    for (const d of [r.distances.x, r.distances.y]) expect(isRoundKeystone(d)).toBe(true);
    // The solved centroid is NOT on a quarter-inch grid — that is the whole point.
    expect(Math.abs(r.position.x / 0.25 - Math.round(r.position.x / 0.25))).toBeGreaterThan(1e-6);
  });
});

describe("snapping through the real resolver", () => {
  // The money test: goes through movePiece -> resolveLayout -> keystoneMeasurements,
  // so it proves solveCentroid's inverse agrees with the forward measurement rather
  // than merely agreeing with this file's arithmetic.
  it.each([0, 90, 180, 270, 37])("leaves no roundness warning at rotation %s", (rot) => {
    const l = wrap([
      rectPiece({ x: 21.37, y: 16.09 }, {
        rotation_degrees: rot,
        keystones: [{ edge: "left", ref: V(0) }, { edge: "top", ref: V(0) }],
      }),
    ]);
    const snapped = snapToKeystoneGrid(l.pieces[0], DEFAULT_BOARD, l.pieces[0].position)!;
    movePiece(l, "p1", snapped.position);
    expect(layoutWarnings(l).filter((w) => w.kind === "keystone-not-round")).toEqual([]);
    const shown = keystoneDisplays(l);
    expect(shown).toHaveLength(2); // else the roundness assertions are vacuous
    for (const d of shown) expect(isRoundKeystone(d.distance!)).toBe(true);
  });

  it("keeps the symmetry twin's mirrored distances round too", () => {
    const l = wrap([]);
    const p = addTemplate(l, { id: "area-large", kind: "area" } as never, true, { x: 18.37, y: 13.09 });
    expect(setCornerAnchor(l, p.id, cornerCandidates(p, l)[0].index)).toBe(true);
    const snapped = snapToKeystoneGrid(p, DEFAULT_BOARD, p.position)!;
    movePiece(l, p.id, snapped.position);
    expect(l.pieces).toHaveLength(2);
    // 2 per piece: the mirror really landed, so the assertion below has teeth.
    expect(keystoneDisplays(l)).toHaveLength(4);
    expect(layoutWarnings(l).filter((w) => w.kind === "keystone-not-round")).toEqual([]);
  });
});

describe("nearestEdgesFor", () => {
  it.each([
    [{ x: 5, y: 5 }, "left", "top"],
    [{ x: 55, y: 5 }, "right", "top"],
    [{ x: 5, y: 40 }, "left", "bottom"],
    [{ x: 55, y: 40 }, "right", "bottom"],
  ])("%o -> %s/%s", (at, x, y) => {
    expect(nearestEdgesFor(at, DEFAULT_BOARD)).toEqual({ x, y });
  });

  it("respects a board override rather than assuming 60x44", () => {
    // (20,20) is past the centre of a 36x36 board but short of 60x44's on both axes.
    expect(nearestEdgesFor({ x: 20, y: 20 }, { width: 36, height: 36 })).toEqual({
      x: "right",
      y: "bottom",
    });
    expect(nearestEdgesFor({ x: 20, y: 20 }, DEFAULT_BOARD)).toEqual({ x: "left", y: "top" });
  });
});

describe("pickCornerByDirection", () => {
  const l = wrap([rectPiece({ x: 30, y: 22 }, { footprint: { type: "rectangle", width: 10, height: 6 } })]);
  const cands = cornerCandidates(l.pieces[0], l);
  const c = { x: 30, y: 22 };
  const at = (i: number): { x: number; y: number } => cands.find((k) => k.index === i)!.at;

  it("returns the corner the pointer aims at, in all four quadrants", () => {
    for (const cand of cands) {
      const dir = { x: cand.at.x - c.x, y: cand.at.y - c.y };
      const far = { x: c.x + dir.x * 5, y: c.y + dir.y * 5 };
      expect(pickCornerByDirection(cands, c, far)).toBe(cand.index);
    }
  });

  it("follows the piece's pose: the same screen direction picks a different vertex", () => {
    const rotated = wrap([
      rectPiece({ x: 30, y: 22 }, {
        footprint: { type: "rectangle", width: 10, height: 6 },
        rotation_degrees: 90,
      }),
    ]);
    const probe = { x: 40, y: 12 }; // up-and-right of the centroid
    const flat = pickCornerByDirection(cands, c, probe);
    const turned = pickCornerByDirection(cornerCandidates(rotated.pieces[0], rotated), c, probe);
    expect(turned).not.toBe(flat);
  });

  it("holds the previous pick inside the hysteresis margin", () => {
    const target = cands[0].index;
    const other = cands[1].index;
    // A pointer aimed almost exactly between two corners keeps `previous`.
    const mid = { x: (at(target).x + at(other).x) / 2, y: (at(target).y + at(other).y) / 2 };
    const dir = { x: (mid.x - c.x) * 8, y: (mid.y - c.y) * 8 };
    expect(pickCornerByDirection(cands, c, { x: c.x + dir.x, y: c.y + dir.y }, { previous: other }))
      .toBe(other);
  });

  it("keeps the previous pick inside the dead zone, and needs candidates", () => {
    expect(pickCornerByDirection(cands, c, { x: c.x + 0.1, y: c.y }, { previous: 2 })).toBe(2);
    expect(pickCornerByDirection(cands, c, { x: c.x + 0.1, y: c.y })).toBeNull();
    expect(pickCornerByDirection([], c, { x: 99, y: 99 })).toBeNull();
  });

  it("only ever offers cardinal corners of a nubbed area", () => {
    const nub = wrap([]);
    const p = addTemplate(nub, { id: "area-medium", kind: "area" } as never, false, { x: 20, y: 15 });
    const idx = cornerCandidates(p, nub).map((k) => k.index);
    expect(new Set(idx)).toEqual(new Set([0, 13, 14, 15]));
  });
});

describe("keystonesForCorner / setCornerAnchor", () => {
  it("pins one H and one V keystone on the chosen corner", () => {
    const l = wrap([rectPiece({ x: 10, y: 8 })]);
    const ks = keystonesForCorner(l.pieces[0], l, 0)!;
    expect(ks.map((k) => k.edge).sort()).toEqual(["left", "top"]);
    expect(ks.every((k) => k.ref.kind === "vertex" && k.ref.index === 0)).toBe(true);
  });

  it("arms the piece, and re-picking replaces the old anchor", () => {
    const l = wrap([rectPiece({ x: 10, y: 8 })]);
    expect(setCornerAnchor(l, "p1", 0)).toBe(true);
    expect(snapAnchorOf(l.pieces[0])).not.toBeNull();
    expect(l.pieces[0].keystones).toHaveLength(2);

    expect(setCornerAnchor(l, "p1", 2)).toBe(true);
    expect(l.pieces[0].keystones).toHaveLength(2);
    expect(l.pieces[0].keystones!.every((k) => k.ref.kind === "vertex" && k.ref.index === 2)).toBe(true);
  });

  it("refuses to destroy a hand-authored triangulation set", () => {
    const l = wrap([rectPiece({ x: 10, y: 8 }, {
      keystones: [
        { edge: "left", ref: V(0) },
        { edge: "left", ref: V(1) },
        { edge: "top", ref: V(0) },
      ],
    })]);
    expect(setCornerAnchor(l, "p1", 2)).toBe(false);
    expect(l.pieces[0].keystones).toHaveLength(3);
  });

  it("refuses an unknown piece or vertex", () => {
    const l = wrap([rectPiece()]);
    expect(setCornerAnchor(l, "nope", 0)).toBe(false);
    expect(setCornerAnchor(l, "p1", 99)).toBe(false);
  });

  it("mirrors the anchor onto the symmetry twin", () => {
    const l = wrap([]);
    const p = addTemplate(l, { id: "area-medium", kind: "area" } as never, true, { x: 15, y: 12 });
    expect(setCornerAnchor(l, p.id, cornerCandidates(p, l)[0].index)).toBe(true);
    const twin = l.pieces.find((q) => q.id === p.twin_id)!;
    expect(twin.keystones).toHaveLength(2);
    expect(twin.keystones!.map((k) => k.edge).sort()).toEqual(["bottom", "right"]);
  });
});

describe("suggestSolverSeed", () => {
  it("flags axis alignment so the right solver form opens", () => {
    for (const rot of [0, 90, 180, 270]) {
      const l = wrap([rectPiece({ x: 20, y: 15 }, { rotation_degrees: rot })]);
      expect(suggestSolverSeed(l.pieces[0], l, DEFAULT_BOARD)!.axisAligned).toBe(true);
    }
    const l = wrap([rectPiece({ x: 20, y: 15 }, { rotation_degrees: 43 })]);
    expect(suggestSolverSeed(l.pieces[0], l, DEFAULT_BOARD)!.axisAligned).toBe(false);
  });

  it("seeds distances already on the step", () => {
    const l = wrap([rectPiece({ x: 20.31, y: 15.12 }, { rotation_degrees: 43 })]);
    const seed = suggestSolverSeed(l.pieces[0], l, DEFAULT_BOARD)!;
    for (const line of [...seed.two, ...seed.three]) expect(isRoundKeystone(line.distance)).toBe(true);
  });

  it("builds a well-conditioned triangulation: distinct vertices, two sharing an edge", () => {
    const l = wrap([rectPiece({ x: 20, y: 15 }, {
      footprint: { type: "rectangle", width: 11.5, height: 7 },
      rotation_degrees: 43,
    })]);
    const { three } = suggestSolverSeed(l.pieces[0], l, DEFAULT_BOARD)!;
    expect(new Set(three.map((t) => t.vertex)).size).toBe(3);
    expect(three[0].edge).toBe(three[1].edge);
    expect(three[2].edge).not.toBe(three[0].edge);
  });

  it("prefers the piece's existing anchor for the two-line form", () => {
    const l = wrap([rectPiece({ x: 20, y: 15 }, {
      keystones: [{ edge: "right", ref: V(2) }, { edge: "bottom", ref: V(2) }],
    })]);
    const { two } = suggestSolverSeed(l.pieces[0], l, DEFAULT_BOARD)!;
    expect(two.map((t) => t.edge).sort()).toEqual(["bottom", "right"]);
  });

  it("returns null for a piece with no footprint", () => {
    const l = wrap([rectPiece({ x: 20, y: 15 }, { footprint: undefined })]);
    expect(suggestSolverSeed(l.pieces[0], l, DEFAULT_BOARD)).toBeNull();
  });
});

describe("small helpers", () => {
  it("isAxisAligned accepts quarter turns and wraps", () => {
    for (const d of [0, 90, 180, 270, 360, -90]) expect(isAxisAligned(d)).toBe(true);
    for (const d of [1, 43, 89.5, 225]) expect(isAxisAligned(d)).toBe(false);
  });

  it("cardEdgeName speaks card directions (the board renders rotated 90 degrees)", () => {
    expect(cardEdgeName("bottom")).toBe("left");
    expect(cardEdgeName("top")).toBe("right");
    expect(cardEdgeName("left")).toBe("top");
    expect(cardEdgeName("right")).toBe("bottom");
  });

  it("exports the quarter-inch increment as the default step", () => {
    expect(KEYSTONE_INCREMENT).toBe(0.25);
  });
});

// ── worklist ──────────────────────────────────────────────────────────────────

describe("worklistFor", () => {
  it("reads a committed layout as fully placed against itself", () => {
    const l = loadEmbedded("take-and-hold-mirror-1")!;
    const w = worklistFor(l, TERRAIN_SETS);
    expect(w.sourceId).toBe("take-and-hold-mirror-1");
    expect(w.expected).toBe(16); // 45 of the 46 layouts are 16 areas + 28 features
    expect(w.placed).toBe(w.expected);
    expect(w.rows.every((r) => r.placed >= r.expected)).toBe(true);
  });

  it("resolves the source from matchup+variant, so it works from a blank board", () => {
    const src = loadEmbedded("take-and-hold-mirror-1")!;
    const blank: EditLayout = {
      id: "brand-new",
      name: "Brand new",
      mission_matchup_id: src.mission_matchup_id,
      variant: src.variant,
      pieces: [],
    };
    const w = worklistFor(blank, TERRAIN_SETS);
    expect(w.sourceId).toBe("take-and-hold-mirror-1");
    expect(w.expected).toBe(16);
    expect(w.placed).toBe(0);
  });

  it("counts a stamped set against exactly one row", () => {
    const src = loadEmbedded("take-and-hold-mirror-1")!;
    const blank: EditLayout = {
      id: "brand-new",
      name: "Brand new",
      mission_matchup_id: src.mission_matchup_id,
      variant: src.variant,
      pieces: [],
    };
    const before = worklistFor(blank, TERRAIN_SETS);
    const set = TERRAIN_SETS.find((s) => before.rows.some((r) => r.setId === s.id));
    expect(set, "no worklist row names a set — the signature match is broken").toBeDefined();
    addSet(blank, set!, false, { x: 20, y: 15 });
    const after = worklistFor(blank, TERRAIN_SETS);
    expect(after.placed).toBe(before.placed + 1);
    const changed = after.rows.filter((r, i) => r.placed !== before.rows[i].placed);
    expect(changed).toHaveLength(1);
    expect(changed[0].setId).toBe(set!.id);
  });

  it("names a palette set on the rows a set can stamp", () => {
    const l = loadEmbedded("take-and-hold-mirror-1")!;
    const rows = worklistFor(l, TERRAIN_SETS).rows;
    expect(rows.filter((r) => r.setId).length).toBeGreaterThan(0);
    for (const r of rows) {
      if (!r.setId) continue;
      const s = TERRAIN_SETS.find((x) => x.id === r.setId)!;
      expect(s.area.template).toBe(r.areaTemplate);
      expect(s.features).toHaveLength(r.seats.reduce((n, x) => n + x.count, 0));
    }
  });

  it("reports no source for an unknown matchup, without throwing", () => {
    const w = worklistFor({ id: "nope", name: "Nope", pieces: [] });
    expect(w).toEqual({ sourceId: null, rows: [], expected: 0, placed: 0 });
  });
});

describe("replaceKeystone", () => {
  it("swaps in place, keeping the list order", () => {
    const l = wrap([rectPiece({ x: 10, y: 8 }, {
      keystones: [{ edge: "left", ref: V(0) }, { edge: "top", ref: V(0) }],
    })]);
    replaceKeystone(l, "p1", 0, { edge: "right", ref: V(0) });
    expect(l.pieces[0].keystones).toEqual([
      { edge: "right", ref: V(0) },
      { edge: "top", ref: V(0) },
    ]);
  });

  it("keeps the piece armed across an edge flip", () => {
    const l = wrap([rectPiece({ x: 10, y: 8 })]);
    setCornerAnchor(l, "p1", 0);
    replaceKeystone(l, "p1", 0, { edge: "right", ref: V(0) });
    expect(snapAnchorOf(l.pieces[0])).not.toBeNull();
    expect(snapAnchorOf(l.pieces[0])!.x.edge).toBe("right");
  });

  it("re-derives the twin's mirror rather than leaving the old one", () => {
    const l = wrap([]);
    const p = addTemplate(l, { id: "area-medium", kind: "area" } as never, true, { x: 15, y: 12 });
    setCornerAnchor(l, p.id, cornerCandidates(p, l)[0].index);
    const twin = l.pieces.find((q) => q.id === p.twin_id)!;
    const wasEdges = twin.keystones!.map((k) => k.edge).sort();
    const idx = p.keystones!.findIndex((k) => k.edge === "left" || k.edge === "right");
    replaceKeystone(l, p.id, idx, {
      edge: p.keystones![idx].edge === "left" ? "right" : "left",
      ref: p.keystones![idx].ref,
    });
    expect(twin.keystones).toHaveLength(2);
    expect(twin.keystones!.map((k) => k.edge).sort()).not.toEqual(wasEdges);
  });

  it("no-ops on a missing piece or index", () => {
    const l = wrap([rectPiece({ x: 10, y: 8 }, { keystones: [{ edge: "left", ref: V(0) }] })]);
    replaceKeystone(l, "nope", 0, { edge: "top", ref: V(0) });
    replaceKeystone(l, "p1", 7, { edge: "top", ref: V(0) });
    expect(l.pieces[0].keystones).toEqual([{ edge: "left", ref: V(0) }]);
  });
});

describe("piece ids are unique within a layout", () => {
  // Regression: a loaded layout keeps its AUTHORED ids while the id counter
  // restarts at 0, so adding an `area-large` to a committed layout re-used
  // `area-large-1`. Svelte's keyed {#each} threw each_key_duplicate and aborted
  // the board render, which looked like "adding a piece does nothing".
  it("does not collide with an authored id from a loaded layout", () => {
    const l = loadEmbedded("take-and-hold-mirror-1")!;
    expect(l.pieces.some((p) => p.id === "area-large-1")).toBe(true);
    const added = addTemplate(l, { id: "area-large", kind: "area" } as never, false, { x: 20, y: 15 });
    expect(added.id).not.toBe("area-large-1");
    expect(new Set(l.pieces.map((p) => p.id)).size).toBe(l.pieces.length);
  });

  it("stays unique across many adds, sets and twins", () => {
    const l = loadEmbedded("take-and-hold-mirror-1")!;
    for (const t of ["area-large", "area-medium", "area-short-line"]) {
      addTemplate(l, { id: t, kind: "area" } as never, true, { x: 20, y: 15 });
    }
    for (const s of TERRAIN_SETS) addSet(l, s, true, { x: 25, y: 18 });
    expect(new Set(l.pieces.map((p) => p.id)).size).toBe(l.pieces.length);
  });
});
