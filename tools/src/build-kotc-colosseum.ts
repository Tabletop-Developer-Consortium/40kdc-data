/**
 * Re-authors the `kotc-colosseum` terrain layout in
 * `data/core/terrain-layouts.json` to match the real King-of-the-Colosseum
 * terrain (measurements supplied by a builder of the physical board):
 *
 *  - Four 6″-tall arena LoS-blocker walls: thin curved bands on the board
 *    diagonals, outer radius 13″ from the board centre (18,18), 14⅛″ (14.125″)
 *    of outer arc each, 0.5″ thick, leaving four entryways on the cardinals.
 *  - Four inner ruins: open L-walls (two 5.25″ legs at a right angle, 0.5″
 *    thick, 3″ tall), open toward the board corner (the L vertex points at the
 *    arena centre), their near-centre walls 13″ off the cardinal edges → L
 *    vertices at (13,13),(23,13),(23,23),(13,23). 4-fold rotational symmetry.
 *  - Four deployment ruins: open L-walls (a 5.25″ leg along the baseline + a
 *    3.25″ leg into the board, 0.5″ thick, 3″ tall), open toward the board
 *    corner, the baseline-facing wall 5.5″ off the baseline (y=0 / y=36). Two
 *    per 9″ strip; 2-fold reflective symmetry (the strips are top/bottom only).
 *  - Five octagonal objectives: centre plus four 5.5″ off the cardinal edges.
 *
 * Ruins keep the area+wall two-piece structure: the `area` piece references a
 * dense catalog template (`kotc-ruin-inner` / `kotc-ruin-deployment`), and the
 * L-shaped `feature` walls are inline, parented to the area. Pieces are
 * centroid-anchored (`board = position + R·M·(v − c)`), so each shape is
 * authored directly in board coordinates and stored as `footprint = board − c`
 * with `position = c`, rotation 0 — resolving to the authored board geometry.
 *
 * Verifies by resolving the rebuilt layout against the catalog and asserting
 * every wall feature reproduces its authored board polygon before writing.
 *
 * Usage: `npx tsx src/build-kotc-colosseum.ts` (run from `tools/`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  resolveLayout,
  polygonCentroid,
  type Vec2,
  type Footprint,
  type Keystone,
  type LayoutPiece,
  type TerrainTemplate,
  type TerrainLayout,
} from "./terrain/resolve.js";

const REPO_ROOT = join(new URL("../..", import.meta.url).pathname);
const CATALOG_PATH = join(REPO_ROOT, "data", "core", "terrain-templates.json");
const LAYOUTS_PATH = join(REPO_ROOT, "data", "core", "terrain-layouts.json");

const LAYOUT_ID = "kotc-colosseum";
const CENTER: Vec2 = { x: 18, y: 18 };
const WALL_T = 0.5; // wall thickness (GW-map convention)

// Arena walls
const ARC_RO = 13; // outer radius (from board centre)
const ARC_RI = ARC_RO - WALL_T; // 12.5
const ARC_LEN = 14.125; // 14 1/8″ of outer arc per wall
const ARC_THETA = ARC_LEN / ARC_RO; // subtended angle, radians
const ARC_STEPS = 16; // samples per radius edge (smooth curve; chord-sum ≈ true 14.125″ arc)
const ARENA_H = 6;

// Ruins
const INNER_LEG = 5.25;
const DEPLOY_LONG = 5.25; // along the baseline
const DEPLOY_SHORT = 3.25; // into the board
const INNER_OFF = 13; // near-centre walls 13″ off the cardinal edges
const DEPLOY_BASE_OFF = 5.5; // baseline-facing wall 5.5″ off the baseline
const DEPLOY_X = 4; // horizontal centre of each deployment ruin box
const RUIN_H = 3;

const DEG = Math.PI / 180;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const r4 = (v: Vec2): Vec2 => ({ x: round4(v.x), y: round4(v.y) });

function rotateCw(v: Vec2, deg: number): Vec2 {
  if (deg === 0) return { x: v.x, y: v.y };
  const r = deg * DEG;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: c * v.x - s * v.y, y: s * v.x + c * v.y };
}
const rotAboutCenter = (v: Vec2, deg: number): Vec2 => {
  const d = rotateCw({ x: v.x - CENTER.x, y: v.y - CENTER.y }, deg);
  return { x: d.x + CENTER.x, y: d.y + CENTER.y };
};
const reflectX = (v: Vec2): Vec2 => ({ x: 2 * CENTER.x - v.x, y: v.y }); // about x=18
const reflectY = (v: Vec2): Vec2 => ({ x: v.x, y: 2 * CENTER.y - v.y }); // about y=18

/** Build a piece authored directly in board coordinates: footprint = board − centroid, position = centroid. */
function boardPolygonPiece(
  base: Omit<LayoutPiece, "footprint" | "position">,
  boardVerts: Vec2[],
): LayoutPiece {
  const c = polygonCentroid(boardVerts);
  const footprint: Footprint = { type: "polygon", points: boardVerts.map((v) => r4({ x: v.x - c.x, y: v.y - c.y })) };
  return { ...base, footprint, position: r4(c) };
}

/** A thin curved arena-wall band centred on diagonal angle `a0deg` (measured from the board centre). */
function arenaArc(a0deg: number): Vec2[] {
  const a0 = a0deg * DEG;
  const half = ARC_THETA / 2;
  const pt = (r: number, a: number): Vec2 => ({ x: CENTER.x + r * Math.cos(a), y: CENTER.y + r * Math.sin(a) });
  const verts: Vec2[] = [];
  for (let i = 0; i <= ARC_STEPS; i++) verts.push(pt(ARC_RO, a0 - half + (ARC_THETA * i) / ARC_STEPS));
  for (let i = ARC_STEPS; i >= 0; i--) verts.push(pt(ARC_RI, a0 - half + (ARC_THETA * i) / ARC_STEPS));
  return verts;
}

/**
 * L-shaped wall polygon (two rectangular legs sharing a corner at `vertex`),
 * traced as a 6-point simple polygon. `dx`/`dy` (±1) point from the vertex
 * toward the opening (the board corner); legs run the opposite way.
 */
function lWall(vertex: Vec2, legA: number, legB: number, dx: number, dy: number): Vec2[] {
  // Horizontal leg runs in −dx from the vertex (length legA), thickness legB-side.
  // Vertical leg runs in −dy from the vertex (length legB... swapped below).
  // Here: legAlongX = the leg parallel to x, legAlongY = the leg parallel to y.
  const vx = vertex.x;
  const vy = vertex.y;
  const legX = legA; // wall parallel to x (its outer edge passes through the vertex in y)
  const legY = legB; // wall parallel to y
  // Outer edges pass through the vertex; walls are WALL_T thick toward the opening.
  const xOuter = vx;
  const xInner = vx - dx * WALL_T;
  const yOuter = vy;
  const yInner = vy - dy * WALL_T;
  const xFar = vx - dx * legX; // far end of the x-parallel leg
  const yFar = vy - dy * legY; // far end of the y-parallel leg
  // Trace: vertex → along y-leg outer → across y-leg end → down to inner corner
  //        → across x-leg inner → down x-leg far end → back to vertex.
  return [
    { x: xOuter, y: yOuter },
    { x: xOuter, y: yFar },
    { x: xInner, y: yFar },
    { x: xInner, y: yInner },
    { x: xFar, y: yInner },
    { x: xFar, y: yOuter },
  ];
}

interface RuinSpec {
  id: string;
  quadrant: string;
  areaTemplate: string;
  areaCenter: Vec2;
  wall: Vec2[];
  keystones?: Keystone[];
}

function ruinPieces(spec: RuinSpec): LayoutPiece[] {
  const area: LayoutPiece = {
    id: spec.id,
    name: `Ruin (${spec.quadrant})`,
    piece_type: "area",
    template: spec.areaTemplate,
    position: r4(spec.areaCenter),
    ...(spec.keystones ? { keystones: spec.keystones } : {}),
  };
  const wc = polygonCentroid(spec.wall);
  const walls: LayoutPiece = {
    id: `${spec.id}-walls`,
    name: `Ruin (${spec.quadrant}) Walls`,
    piece_type: "feature",
    footprint: { type: "polygon", points: spec.wall.map((v) => r4({ x: v.x - wc.x, y: v.y - wc.y })) },
    position: r4({ x: wc.x - spec.areaCenter.x, y: wc.y - spec.areaCenter.y }),
    parent_area_id: spec.id,
    height_inches: RUIN_H,
  };
  return [area, walls];
}

// Objective markers are drawn at the 3″ control radius (matches
// `control_range_inches` below), as a regular octagon centred on the marker.
const OBJ_R = 3;
const OBJ_DIAG = round4((OBJ_R * Math.SQRT1_2)); // 3 · √½ ≈ 2.1213
const OBJ_OCTAGON: Vec2[] = [
  { x: OBJ_R, y: 0 },
  { x: OBJ_DIAG, y: OBJ_DIAG },
  { x: 0, y: OBJ_R },
  { x: -OBJ_DIAG, y: OBJ_DIAG },
  { x: -OBJ_R, y: 0 },
  { x: -OBJ_DIAG, y: -OBJ_DIAG },
  { x: 0, y: -OBJ_R },
  { x: OBJ_DIAG, y: -OBJ_DIAG },
];
/** Layout pieces carry objective metadata the resolver's LayoutPiece type omits. */
type ObjectivePiece = LayoutPiece & {
  terrain: boolean;
  objective_role: string;
  is_objective: boolean;
  objective: { control_range_inches: number };
};
// KOTC objectives are 10th-edition markers on open ground — empty areas
// (`terrain: false`), not the 11e terrain-area objectives the mission-matrix
// layouts embed in cover. They keep the octagon footprint for extent/measurement
// but render as a marker ring, not terrain, and grant no cover.
function objectivePiece(id: string, name: string, pos: Vec2, role: string): ObjectivePiece {
  return {
    id,
    name,
    piece_type: "area",
    terrain: false,
    footprint: { type: "polygon", points: OBJ_OCTAGON.map((v) => ({ ...v })) },
    position: pos,
    objective_role: role,
    is_objective: true,
    objective: { control_range_inches: 3 },
  };
}

function buildPieces(): LayoutPiece[] {
  const pieces: LayoutPiece[] = [];

  // --- Arena walls (4-fold): NE −45°, SE 45°, SW 135°, NW 225° --------------
  const arenaAngles: Array<[string, number]> = [
    ["NE", -45],
    ["SE", 45],
    ["SW", 135],
    ["NW", 225],
  ];
  for (const [q, a] of arenaAngles) {
    pieces.push(
      boardPolygonPiece(
        {
          id: `colosseum-wall-${q.toLowerCase()}`,
          name: `Colosseum Wall (${q})`,
          piece_type: "feature",
          template: "impassable-wall",
          height_inches: ARENA_H,
        },
        arenaArc(a),
      ),
    );
  }

  // --- Inner ruins (4-fold): the four ruins ring the centre objective on the
  // cardinal midlines. Each ruin's NEAR corner (area vertex 0 — the corner
  // closest to the board edges) sits at the builder-measured offsets 8″ and
  // 13″ off its two nearest edges, and its two keystones print exactly those.
  // Base is the WEST ruin (near corner at board (8, 13)); the 90°/180°/270°
  // rotations carry it to N/E/S. The L-wall opens toward −x,−y, so its solid
  // corner sits at the box's far (centre-ward) corner.
  const INNER_NEAR = 8; // near-corner offset off the nearer edge (INNER_OFF = 13″ off the other)
  const innerBaseCenter: Vec2 = { x: INNER_NEAR + INNER_LEG / 2, y: INNER_OFF + INNER_LEG / 2 };
  const innerBaseVertex: Vec2 = { x: innerBaseCenter.x + INNER_LEG / 2, y: innerBaseCenter.y + INNER_LEG / 2 };
  const innerBaseWall = lWall(innerBaseVertex, INNER_LEG, INNER_LEG, 1, 1);
  const ks = (edge: Keystone["edge"], index: number): Keystone => ({ edge, ref: { kind: "vertex", index } });
  const innerQuadrants: Array<{ q: string; deg: number; keystones: Keystone[] }> = [
    { q: "nw", deg: 0, keystones: [ks("top", 0), ks("left", 0)] },
    { q: "ne", deg: 90, keystones: [ks("top", 1), ks("right", 1)] },
    { q: "se", deg: 180, keystones: [ks("bottom", 2), ks("right", 2)] },
    { q: "sw", deg: 270, keystones: [ks("bottom", 3), ks("left", 3)] },
  ];
  for (const { q, deg, keystones } of innerQuadrants) {
    pieces.push(
      ...ruinPieces({
        id: `ruin-inner-${q}`,
        quadrant: `inner ${q.toUpperCase()}`,
        areaTemplate: "kotc-ruin-inner",
        areaCenter: rotAboutCenter(innerBaseCenter, deg),
        wall: innerBaseWall.map((v) => rotAboutCenter(v, deg)),
        keystones,
      }),
    );
  }

  // --- Deployment ruins (2-fold reflective): base NW-top, open toward (0,0) --
  // Vertex points at the arena centre (SE of the box): x at box right, y at the
  // baseline-facing wall (5.5″ off y=0). 5.25″ leg along x, 3.25″ leg along y.
  const deployBaseVertex: Vec2 = { x: DEPLOY_X + DEPLOY_LONG / 2, y: DEPLOY_BASE_OFF };
  const deployBaseWall = lWall(deployBaseVertex, DEPLOY_LONG, DEPLOY_SHORT, 1, 1);
  const deployBaseCenter: Vec2 = { x: DEPLOY_X, y: DEPLOY_BASE_OFF - DEPLOY_SHORT / 2 };
  const deployVariants: Array<[string, (v: Vec2) => Vec2]> = [
    ["nw", (v) => v],
    ["ne", reflectX],
    ["sw", reflectY],
    ["se", (v) => reflectX(reflectY(v))],
  ];
  for (const [q, tf] of deployVariants) {
    pieces.push(
      ...ruinPieces({
        id: `ruin-deploy-${q}`,
        quadrant: `deployment ${q.toUpperCase()}`,
        areaTemplate: "kotc-ruin-deployment",
        areaCenter: tf(deployBaseCenter),
        wall: deployBaseWall.map(tf),
      }),
    );
  }

  // --- Objectives: centre + four 5.5″ off the cardinal edges -----------------
  const off = DEPLOY_BASE_OFF; // 5.5
  pieces.push(objectivePiece("obj-center", "Objective (Center)", { x: 18, y: 18 }, "center"));
  pieces.push(objectivePiece("obj-west", "Objective (West)", { x: off, y: 18 }, "expansion"));
  pieces.push(objectivePiece("obj-east", "Objective (East)", { x: 36 - off, y: 18 }, "expansion"));
  pieces.push(objectivePiece("obj-north", "Objective (North)", { x: 18, y: off }, "expansion"));
  pieces.push(objectivePiece("obj-south", "Objective (South)", { x: 18, y: 36 - off }, "expansion"));

  return pieces;
}

function main(): void {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as TerrainTemplate[];
  const layouts = JSON.parse(readFileSync(LAYOUTS_PATH, "utf8")) as (TerrainLayout & Record<string, unknown>)[];

  const layout = layouts.find((l) => l.id === LAYOUT_ID);
  if (!layout) throw new Error(`layout "${LAYOUT_ID}" not found`);
  for (const id of ["kotc-ruin-inner", "kotc-ruin-deployment", "impassable-wall"]) {
    if (!catalog.some((t) => t.id === id)) throw new Error(`catalog missing template "${id}"`);
  }

  const pieces = buildPieces();

  // Verify: resolve the rebuilt layout; every wall feature must reproduce its
  // authored board polygon (rotation 0, so footprint+position round-trips).
  const probe: TerrainLayout = { id: layout.id, name: layout.name, pieces };
  const resolved = resolveLayout(probe, catalog);
  const byId = new Map(resolved.map((r) => [r.id, r]));
  let failures = 0;
  // Unparented polygon pieces (arena walls, objectives) are authored as
  // footprint = board − centroid with position = centroid, so they must resolve
  // back to board = footprint.points + position exactly. Parented wall features
  // are validated by the absolute-coordinate sanity checks below instead.
  for (const p of pieces) {
    if (!p.footprint || p.footprint.type !== "polygon" || p.parent_area_id) continue;
    const res = byId.get(p.id ?? "");
    if (!res) {
      failures++;
      console.error(`  ✗ ${p.id}: not resolved`);
      continue;
    }
    const expected = p.footprint.points.map((v) => ({ x: v.x + p.position.x, y: v.y + p.position.y }));
    const maxErr = res.vertices.reduce((m, rv, i) => Math.max(m, Math.hypot(rv.x - expected[i].x, rv.y - expected[i].y)), 0);
    if (maxErr > 2e-4) {
      failures++;
      console.error(`  ✗ ${p.id}: resolved geometry drifted ${maxErr.toExponential(2)}`);
    }
  }

  // Independent sanity checks on the resolved geometry.
  const check = (label: string, ok: boolean) => {
    console.log(`  ${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failures++;
  };
  const wallNe = byId.get("colosseum-wall-ne")!;
  const outerRadii = wallNe.vertices.slice(0, ARC_STEPS + 1).map((v) => Math.hypot(v.x - 18, v.y - 18));
  check(
    `arena outer radius ≈ ${ARC_RO}`,
    outerRadii.every((r) => Math.abs(r - ARC_RO) < 1e-3),
  );
  const innerArea = byId.get("ruin-inner-nw")!;
  check(
    "inner NW (west) ruin near corner 8″ off the left edge & 13″ off the top",
    innerArea.vertices.some((v) => Math.abs(v.x - 8) < 1e-3 && Math.abs(v.y - 13) < 1e-3),
  );
  const deployWall = byId.get("ruin-deploy-nw-walls")!;
  check(
    "deployment NW baseline wall at y=5.5",
    deployWall.vertices.some((v) => Math.abs(v.y - 5.5) < 1e-3),
  );
  const objWest = byId.get("obj-west")!;
  const objWc = polygonCentroid(objWest.vertices);
  check("west objective 5.5″ off west edge", Math.abs(objWc.x - 5.5) < 1e-3);

  if (failures > 0) {
    console.error(`\nBUILD FAILED: ${failures} verification failures; file NOT written.`);
    process.exit(1);
  }

  layout.description =
    "King of the Colosseum (Play On Tabletop): 36″×36″ arena. Four 6″ LoS-blocking " +
    "arena walls (13″ radius, 14⅛″ arc) with entryways on the cardinals; four dense inner " +
    "ruins and four dense deployment ruins as open right-angle L-walls; five objectives; " +
    "9″ deployment strips.";
  layout.pieces = pieces;

  writeFileSync(LAYOUTS_PATH, `${JSON.stringify(layouts, null, 2)}\n`);
  console.log(`\n✓ Rebuilt "${LAYOUT_ID}" with ${pieces.length} pieces. Wrote ${LAYOUTS_PATH}.`);
}

main();
