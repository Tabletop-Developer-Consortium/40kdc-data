/**
 * Editor model + the thin seam onto the 40kdc-data terrain library.
 *
 * The whole point of this example: authoring a terrain layout is just building
 * the canonical `terrain-layout` data, and *seeing* it is one call to the same
 * `resolveLayout` the conformance corpus pins. The card-measurement solver
 * (`solveCentroid`) is the package's inverse of that placement, so transcribing
 * a reference card never requires guessing a canonical anchor.
 *
 * Two authoring affordances layer on top, both purely editor-side (they never
 * change the resolver, the stored JSON, or the conformance contract):
 *   - the board is *displayed* rotated 90° (terrain cards are portrait); board
 *     coordinates stay 60×44 y-down, so geometry maps 1:1.
 *   - GW deployments are 180°-rotationally symmetric about the board centre, so
 *     every piece keeps a live twin at (60−x, 44−y), +180°. Twins are real
 *     pieces; the editor just maintains the pairing through `twin_id`.
 */
import {
  Dataset,
  resolveLayout,
  solveCentroid,
  solveCentroidTriangulated,
  solveCentroidAttached,
  solveCentroidAgainstFixed,
  footprintVertices,
  orientedOffsets,
  polygonCentroid,
  keystoneMeasurements,
} from "@alpaca-software/40kdc-data";
import type {
  ResolvedPiece,
  ResolvedVec2,
  SolveInput,
  AttachInput,
  SolveAgainstFixedInput,
  TerrainTemplate,
  TerrainLayout,
} from "@alpaca-software/40kdc-data";
// Type-only circular dependency (sets.ts imports Mirror/FeatureSeat back): erased
// at compile, so sets.ts stays a pure declarative data module with no runtime cycle.
import type { TerrainSetDef, SetFeatureDef } from "./sets.js";

/** Board extents in inches. Most 40kdc layouts use the standard 60×44; one-offs
 *  (the 36×36 KOTC colosseum) carry a per-layout `board` that overrides it. */
export interface BoardDims {
  width: number;
  height: number;
}
export const DEFAULT_BOARD: BoardDims = { width: 60, height: 44 };
/** Back-compat alias: the standard board, used as the fallback everywhere a
 *  layout-specific board isn't threaded (twin defaults, thumbnails). */
export const BOARD = DEFAULT_BOARD;
export const BOARD_CENTER = { x: BOARD.width / 2, y: BOARD.height / 2 } as const;
/** The active board for a layout (its override, or the 60×44 standard). */
export function boardOf(layout: EditLayout): BoardDims {
  return layout.board ?? DEFAULT_BOARD;
}

export type Mirror = "none" | "horizontal" | "vertical";
export interface Vec2 {
  x: number;
  y: number;
}

/** Which feature of a placed footprint a card dimension reaches. */
export type SolverRef =
  | { kind: "vertex"; index: number }
  | { kind: "face"; side: "min-x" | "max-x" | "min-y" | "max-y" };

/**
 * A footprint feature the solver UI can point at: a keystone ref, or — for the
 * attachment solver — the edge running from vertex `index` to `index + 1`.
 * Viz-only; never persisted (keystones keep the narrower {@link SolverRef}).
 */
export type SolverFeatureRef = SolverRef | { kind: "edge"; index: number };

/**
 * A highlighted solver feature. `pieceId` targets a piece other than the
 * selection — the attachment solver points at the attached-to area too.
 */
export interface SolverHover {
  pieceId?: string;
  ref: SolverFeatureRef;
}

/** One committed solver dimension line, for drawing the measurement guide on the board. */
export interface SolverLine {
  edge: "left" | "right" | "top" | "bottom";
  distance: number;
  ref: SolverRef;
  /** The piece the line measures to, when not the selection (attachment solver). */
  pieceId?: string;
}

/**
 * One authored measurement keystone: the dimension line the printed card keeps
 * (board edge → piece feature). Only the selection persists — distances are
 * always derived from geometry via the package's `keystoneMeasurements`.
 */
export interface EditKeystone {
  edge: SolverLine["edge"];
  ref: SolverRef;
}

/** What the board draws to make the solver's edge/corner measurements legible. */
export interface SolverViz {
  /** A feature being hovered in the picker (preview highlight). */
  hover: SolverHover | null;
  /** The committed x and y dimension lines. */
  lines: SolverLine[];
}

/** An editable terrain piece — the loose shape we mutate, serialize, and resolve. */
export interface EditPiece {
  id: string;
  name?: string;
  piece_type: "area" | "feature";
  /** Catalog template id, when this piece instances one. */
  template?: string;
  /** Inline footprint (baked geometry); authoritative when present. */
  footprint?: TerrainTemplate["footprint"];
  /**
   * Centroid. In board inches, unless this is a feature with `parent_area_id`,
   * in which case it is in the parent area's centroid-local frame (the same
   * convention the resolver uses), so moving/rotating the area carries it.
   */
  position: Vec2;
  rotation_degrees: number;
  mirror: Mirror;
  /** Whether this area is gameplay terrain. `false` = an empty area (e.g. a
   *  10th-ed objective marker on open ground): has a footprint but is not
   *  terrain and grants no cover. Absent means true. */
  terrain?: boolean;
  /** For a feature: the layout-local id of the area it is anchored to. */
  parent_area_id?: string;
  floor?: number;
  /** Piece height in inches (overrides the template default; gates Plunging Fire). */
  height_inches?: number;
  link_group?: string;
  /** Objective role of this area (or its link_group union): home/expansion/center. */
  objective_role?: "home" | "expansion" | "center";
  /** Whether this piece carries an objective marker (set by an objective role). */
  is_objective?: boolean;
  /** Opaque objective-marker metadata, round-tripped as authored. */
  objective?: { position?: Vec2; control_range_inches?: number };
  /** Authored measurement keystones (per piece, not mirrored to the twin). */
  keystones?: EditKeystone[];
  /** Editor-only: the id of this piece's symmetry twin. Never serialized. */
  twin_id?: string;
}

export interface EditLayout {
  id: string;
  name: string;
  source?: string;
  description?: string;
  mission_matchup_id?: string;
  variant?: number;
  deployment_pattern_id?: string;
  /** Per-layout board override (inches). Absent means the 60×44 standard. */
  board?: BoardDims;
  pieces: EditPiece[];
}

export const ds = Dataset.embedded();

/** The catalog, areas first then features, each alphabetical by name. */
export const CATALOG: TerrainTemplate[] = ds.terrainTemplates.all
  .slice()
  .sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "area" ? -1 : 1,
  );

export function templateById(id: string | undefined): TerrainTemplate | undefined {
  return id ? ds.terrainTemplates.get(id) ?? undefined : undefined;
}

/**
 * Whether a template is an elevated walkway (catwalk/gantry) that overhangs the
 * board — `ground_accessible: false` (elevated-only) AND carrying an `upper_floor`.
 * Such a piece's plan-view footprint legitimately spills over the areas below it,
 * so it is exempt from collision warnings. A solid ground obstacle (a generator,
 * also `ground_accessible: false`) has no `upper_floor` and is NOT exempt.
 */
function isOverhangFeature(templateId: string | undefined): boolean {
  const t = templateById(templateId) as
    | (TerrainTemplate & { ground_accessible?: boolean; upper_floor?: unknown })
    | undefined;
  return !!t && t.kind === "feature" && t.ground_accessible === false && t.upper_floor != null;
}

/** The footprint a piece resolves against (inline wins over template). */
export function footprintOf(piece: EditPiece): TerrainTemplate["footprint"] | undefined {
  return piece.footprint ?? templateById(piece.template)?.footprint;
}

/** Resolve the working layout to absolute board vertices via the shared resolver. */
export function resolve(layout: EditLayout): ResolvedPiece[] {
  return resolveLayout(
    layout as unknown as Parameters<typeof resolveLayout>[0],
    CATALOG as unknown as Parameters<typeof resolveLayout>[1],
  );
}

/** The board-space vertices of one piece (for hit-testing / selection outline). */
export function verticesOf(layout: EditLayout, pieceId: string): ResolvedVec2[] {
  return resolve(layout).find((p) => p.id === pieceId)?.vertices ?? [];
}

// ── oriented geometry (shared by handles, indicators, thumbnails) ─────────────
// All reuse the SAME frozen math the resolver uses, so on-canvas affordances can
// never drift from what the resolver will actually draw.

export interface OrientedFootprint {
  centroid: Vec2;
  /** Per-vertex offset from the centroid, after mirror→rotate (board frame). */
  offsets: Vec2[];
  /** Board-space vertices (centroid + offset). */
  verticesBoard: Vec2[];
}

/**
 * A piece's footprint placed in board space (centroid-anchored, like the
 * resolver). For a feature with `parent_area_id`, its stored centroid/offsets
 * live in the parent area's local frame, so we compose them through the area's
 * placement (the same `mirror→rotate→translate` the resolver applies) — that is
 * what keeps on-canvas handles and guides aligned with the resolved polygon
 * when the area is moved or rotated.
 */
export function orientedFootprint(
  piece: EditPiece,
  layout?: EditLayout,
): OrientedFootprint | null {
  const fp = footprintOf(piece);
  if (!fp) return null;
  const offsets = orientedOffsets(
    fp as never,
    piece.rotation_degrees,
    piece.mirror,
  ) as Vec2[];
  const area = layout ? parentAreaOf(layout, piece) : undefined;
  if (area) {
    const centroid = applyAreaFrame(piece.position, area);
    const verticesBoard = offsets.map((o) =>
      applyAreaFrame({ x: piece.position.x + o.x, y: piece.position.y + o.y }, area),
    );
    return {
      centroid,
      offsets: verticesBoard.map((v) => ({ x: v.x - centroid.x, y: v.y - centroid.y })),
      verticesBoard,
    };
  }
  const centroid = piece.position;
  return {
    centroid,
    offsets,
    verticesBoard: offsets.map((o) => ({ x: centroid.x + o.x, y: centroid.y + o.y })),
  };
}

export function bbox(verts: Vec2[]): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs = verts.map((v) => v.x);
  const ys = verts.map((v) => v.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/**
 * The footprint vertex indices closest to each of the 4 bounding-box corners —
 * the "cardinal corners" a keystone is almost always pinned against. Templates
 * with detail vertices ("nubs") carry ~20 extra points that are never used for
 * measurement; this collapses them to the 4 that matter (e.g. `area-medium`'s
 * 25 vertices → `{0,13,14,15}`). Footprints with ≤4 vertices are all corners.
 * Vertex order matches {@link footprintVertices}.
 */
export function cardinalCornerIndices(fp: TerrainTemplate["footprint"]): number[] {
  const verts = footprintVertices(fp as never) as Vec2[];
  if (verts.length <= 4) return verts.map((_, i) => i);
  const b = bbox(verts);
  const corners: Vec2[] = [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];
  const out: number[] = [];
  for (const c of corners) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < verts.length; i++) {
      const d = Math.hypot(verts[i].x - c.x, verts[i].y - c.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (!out.includes(best)) out.push(best);
  }
  return out;
}

// ── plate seating (the Battlemaster feature-placement rule) ───────────────────
// Every one of the 69 feature placements captured from Battlemaster's composites
// (`data/core/_reports/terrain-composite-prebuilds.json`, covering all 720 area
// placements across the 46 layouts) is reproduced to ≤0.005″ by ONE rule: seat the
// feature's oriented bounding box into a corner of the area's *artwork rectangle*
// with an inset. 60 of 69 use a 0.5″ inset on both axes, 5 (the `area-long-line`
// barricades) are flush on x and 0.5″ on y, and 4 are centred. Every gap
// measurement lands on a clean ¼″. So the placements are a rule, not a table —
// which is why `TERRAIN_SETS` declares seats rather than coordinates.

/** A rect in a piece's centroid-local frame. y-down: `minY` is the TOP edge. */
export interface LocalRect {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Which corner of an area's plate a feature seats into (AREA-LOCAL, y-down). */
export type PlateCorner = "top-left" | "top-right" | "bottom-right" | "bottom-left";
export const PLATE_CORNERS: readonly PlateCorner[] = [
  "top-left",
  "top-right",
  "bottom-right",
  "bottom-left",
];

/** Battlemaster's default corner inset — 60 of the 69 captured placements. */
export const DEFAULT_SEAT_INSET: Vec2 = { x: 0.5, y: 0.5 };

/** How a feature sits inside its parent area's plate. */
export type FeatureSeat =
  | { kind: "corner"; corner: PlateCorner; inset?: Vec2 }
  | { kind: "centred" };

/**
 * An area's *artwork rectangle* ("plate") in its centroid-local frame: the bbox of
 * its {@link cardinalCornerIndices} vertices, **not** of all its vertices. Nubbed
 * die-cut outlines bulge past the printed plate — `area-large` is 11.5 × 7.536
 * all-vertex but 11.5 × 7.0 as a plate, and Battlemaster's own editor reports
 * `11.503 × 7.003` for that piece — so seating against the all-vertex bbox would
 * inset every feature by an arbitrary nub depth.
 *
 * NOTE the plate centre is *not* the centroid (`area-large`: +0.0191, −0.0583),
 * which is exactly why quantizing a piece's `position` does not produce round
 * printed distances. See {@link snapToKeystoneGrid}.
 */
export function plateRect(fp: TerrainTemplate["footprint"]): LocalRect {
  // orientedOffsets at identity == vertices relative to the polygon-area centroid,
  // i.e. the same frame `position` is measured in. Reusing it keeps this on the
  // resolver's frozen math rather than re-deriving the centroid here.
  const local = orientedOffsets(fp as never, 0, "none") as Vec2[];
  const idx = cardinalCornerIndices(fp);
  return bbox(idx.map((i) => local[i]));
}

/** The inset a seat applies (defaulting to Battlemaster's 0.5″ on both axes). */
const seatInset = (seat: FeatureSeat): Vec2 =>
  seat.kind === "corner" ? seat.inset ?? DEFAULT_SEAT_INSET : { x: 0, y: 0 };

/**
 * The area-local centroid that seats a feature's oriented bounding box into `seat`
 * of the parent area's plate rect. The result drops straight into a parented
 * feature's `position`: a parented feature's position/rotation/mirror already live
 * in the area's centroid-local frame, so this is pure local algebra — no board
 * round-trip (which would also spend precision on `clampToBoard`'s rounding).
 *
 * The FEATURE side deliberately uses the plain bbox of `orientedOffsets`, **never**
 * `cardinalCornerIndices`: the corner-ruin templates are L-shaped, so their outer
 * bbox corner has no vertex anywhere near it (up to 4.0″ away for
 * `corner-ruin-balanced-right`, 3.25″ for `-balanced-left`, 2.5″/2.0″ for
 * `corner-ruin-right`/`-left`). Using cardinal vertices here would silently break
 * the snap for precisely the pieces it matters most for.
 */
export function seatPositionInPlate(
  areaFp: TerrainTemplate["footprint"],
  featureFp: TerrainTemplate["footprint"],
  rotation: number,
  mirror: Mirror,
  seat: FeatureSeat,
): Vec2 {
  const pr = plateRect(areaFp);
  const fb = bbox(orientedOffsets(featureFp as never, rotation, mirror) as Vec2[]);
  if (seat.kind === "centred") {
    return {
      x: (pr.minX + pr.maxX) / 2 - (fb.minX + fb.maxX) / 2,
      y: (pr.minY + pr.maxY) / 2 - (fb.minY + fb.maxY) / 2,
    };
  }
  const inset = seatInset(seat);
  const left = seat.corner === "top-left" || seat.corner === "bottom-left";
  const top = seat.corner === "top-left" || seat.corner === "top-right";
  return {
    x: left ? pr.minX + inset.x - fb.minX : pr.maxX - inset.x - fb.maxX,
    y: top ? pr.minY + inset.y - fb.minY : pr.maxY - inset.y - fb.maxY,
  };
}

/**
 * The plate corner whose *seat position* lands nearest `current` (area-local).
 *
 * Deliberately minimum-seat-displacement rather than nearest-corner-to-centroid:
 * nearest-corner picks the wrong corner for 13 of the 65 captured corner
 * placements (20%), and for the same reason as the bbox trap above — an L-shaped
 * ruin's centroid sits diagonally *away* from the corner it wraps. Minimum
 * displacement is 0/65 wrong on the corpus and degrades gracefully under the
 * jitter of a real drop.
 */
export function nearestPlateSeat(
  areaFp: TerrainTemplate["footprint"],
  featureFp: TerrainTemplate["footprint"],
  rotation: number,
  mirror: Mirror,
  current: Vec2,
  inset: Vec2 = DEFAULT_SEAT_INSET,
): PlateCorner {
  let best: PlateCorner = PLATE_CORNERS[0];
  let bestD = Infinity;
  for (const corner of PLATE_CORNERS) {
    const p = seatPositionInPlate(areaFp, featureFp, rotation, mirror, {
      kind: "corner",
      corner,
      inset,
    });
    const d = Math.hypot(p.x - current.x, p.y - current.y);
    if (d < bestD) {
      bestD = d;
      best = corner;
    }
  }
  return best;
}

function mirrorVec(v: Vec2, m: Mirror): Vec2 {
  if (m === "horizontal") return { x: -v.x, y: v.y };
  if (m === "vertical") return { x: v.x, y: -v.y };
  return v;
}
/**
 * Rotate a vector clockwise in the board's y-down frame — the same sense
 * `orientedOffsets` and the resolver use. Exported so callers that must compose an
 * area's rotation onto a child themselves (the set thumbnail) reuse this rather
 * than re-deriving a rotation and drifting from the resolver.
 */
export function rotateCw(v: Vec2, deg: number): Vec2 {
  if (!deg) return v;
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: c * v.x - s * v.y, y: s * v.x + c * v.y };
}

// ── orientation-only 2×2 helpers (for pose-preserving re-parenting) ───────────
// A piece's orientation is `rotate(mirror(v))`; as a linear map that's an
// orthogonal 2×2 (columns = images of the basis). Composing/inverting these lets
// us keep a feature's *board* orientation fixed when the area under it is
// flipped or rotated — the translation half is handled by `inverseAreaFrame`.
interface Mat2 {
  a: number; // col0.x — image of (1,0)
  b: number; // col0.y
  c: number; // col1.x — image of (0,1)
  d: number; // col1.y
}
/** The orientation of `rotate(mirror(·))` as a 2×2 linear map. */
function orientMatrix(rotation: number, mirror: Mirror): Mat2 {
  const c0 = rotateCw(mirrorVec({ x: 1, y: 0 }, mirror), rotation);
  const c1 = rotateCw(mirrorVec({ x: 0, y: 1 }, mirror), rotation);
  return { a: c0.x, b: c0.y, c: c1.x, d: c1.y };
}
/** m · n (apply n first, then m). */
function mat2Mul(m: Mat2, n: Mat2): Mat2 {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
  };
}
/** Inverse of an orthogonal matrix is its transpose. */
function mat2Transpose(m: Mat2): Mat2 {
  return { a: m.a, b: m.c, c: m.b, d: m.d };
}
/**
 * Recover `{ rotation, mirror }` from an orthogonal orientation matrix. A
 * reflection (det < 0) is expressed as a rotation composed with a horizontal
 * mirror (any axis-aligned reflection is equivalent to one, so a `vertical`
 * input may come back as `horizontal` + rotation — same resolved geometry).
 */
function decomposeOrient(m: Mat2): { rotation: number; mirror: Mirror } {
  const det = m.a * m.d - m.c * m.b;
  const clean = (deg: number): number => norm360(Math.round(deg * 1e4) / 1e4);
  if (det >= 0) {
    return { rotation: clean((Math.atan2(m.b, m.a) * 180) / Math.PI), mirror: "none" };
  }
  // reflection = rotate(θ) · mirror-horizontal ⇒ col0 = (−cosθ, −sinθ).
  return { rotation: clean((Math.atan2(-m.b, -m.a) * 180) / Math.PI), mirror: "horizontal" };
}

// ── parent-area composition (a feature anchored to an area) ───────────────────
// A parented feature stores its centroid/orientation in the area's centroid-local
// frame; the resolver re-applies the area's own mirror→rotate→translate. These
// helpers are the editor-side forward/inverse of exactly that, so the interactive
// layer (drag, handles, guides) and the stored data never disagree.

/** Area-local point → board space, through the area's placement. */
function applyAreaFrame(local: Vec2, area: EditPiece): Vec2 {
  const r = rotateCw(mirrorVec(local, area.mirror), area.rotation_degrees);
  return { x: area.position.x + r.x, y: area.position.y + r.y };
}
/** Board-space point → the area's centroid-local frame (inverse of applyAreaFrame). */
function inverseAreaFrame(board: Vec2, area: EditPiece): Vec2 {
  const d = { x: board.x - area.position.x, y: board.y - area.position.y };
  // mirror is its own inverse; undo rotate first, then mirror.
  return mirrorVec(rotateCw(d, -area.rotation_degrees), area.mirror);
}
/**
 * Clamp a board-space point to the table, so pieces can't leave the map.
 *
 * 4-dp, matching the committed layout corpus. This is load-bearing for the ¼″
 * keystone snap: the snap back-solves a centroid from rounded printed distances,
 * and at 2-dp that solved centroid was quantized by up to 0.005″ — enough to make
 * an exactly-solved 16.25″ export as 16.2503″.
 */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
function clampToBoard(p: Vec2, board: BoardDims = DEFAULT_BOARD): Vec2 {
  const c = (n: number, hi: number): number => Math.max(0, Math.min(hi, round4(n)));
  return { x: c(p.x, board.width), y: c(p.y, board.height) };
}
/** The area a feature is parented to, if any (and still present). */
function parentAreaOf(layout: EditLayout, piece: EditPiece): EditPiece | undefined {
  return piece.parent_area_id ? byId(layout, piece.parent_area_id) : undefined;
}
/** A piece's board-space centroid (composing through its parent area if parented). */
export function boardCentroid(layout: EditLayout, piece: EditPiece): Vec2 {
  const area = parentAreaOf(layout, piece);
  return area ? applyAreaFrame(piece.position, area) : { x: piece.position.x, y: piece.position.y };
}
/** The features parented to `areaId` (empty for a piece that has none). */
function childFeaturesOf(layout: EditLayout, areaId: string): EditPiece[] {
  return layout.pieces.filter((p) => p.parent_area_id === areaId);
}

/**
 * Board-space vertices of a piece's `upper_floor` platform, if any. The platform
 * footprint is authored in the same local frame as the ground footprint and
 * re-centred on the GROUND centroid, so we offset its vertices from the ground
 * local centroid and apply the same mirror→rotate→translate the resolver uses.
 */
export function upperFloorBoardVerts(piece: EditPiece, layout?: EditLayout): Vec2[] | null {
  const tpl = templateById(piece.template);
  const uf = (tpl as { upper_floor?: { footprint: TerrainTemplate["footprint"] } } | undefined)
    ?.upper_floor;
  const ground = footprintOf(piece);
  if (!uf || !ground) return null;
  const gc = polygonCentroid(footprintVertices(ground as never) as Vec2[]) as Vec2;
  const local = footprintVertices(uf.footprint as never) as Vec2[];
  const area = layout ? parentAreaOf(layout, piece) : undefined;
  return local.map((v) => {
    const t = rotateCw(mirrorVec({ x: v.x - gc.x, y: v.y - gc.y }, piece.mirror), piece.rotation_degrees);
    // `position + t` is the platform vertex in the piece's own frame; for a
    // parented feature that frame is area-local, so push it through the area.
    const framed = { x: piece.position.x + t.x, y: piece.position.y + t.y };
    return area ? applyAreaFrame(framed, area) : framed;
  });
}

/** True when a template's ground footprint can't hold models (gantry/catwalk/generator). */
export function isGroundBlocked(piece: EditPiece): boolean {
  const tpl = templateById(piece.template) as { ground_accessible?: boolean } | undefined;
  return tpl?.ground_accessible === false;
}

/** A template's upper-floor footprint, authored in the same local frame as `footprint`. */
export function upperFloorOf(
  template: TerrainTemplate,
): TerrainTemplate["footprint"] | undefined {
  return (template as { upper_floor?: { footprint: TerrainTemplate["footprint"] } }).upper_floor
    ?.footprint;
}

// ── deployment zones (drawn under the terrain to author against a card) ───────

export interface DeployZone {
  player: string;
  name?: string;
  color?: string;
  /** Absolute board-space polygon (position + shape applied). */
  points: Vec2[];
}

function shapeToPoints(
  shape: { type: string; width?: number; height?: number; points?: Vec2[] },
  pos: Vec2,
): Vec2[] {
  if (shape.type === "rectangle") {
    const w = shape.width ?? 0;
    const h = shape.height ?? 0;
    return [
      { x: pos.x, y: pos.y },
      { x: pos.x + w, y: pos.y },
      { x: pos.x + w, y: pos.y + h },
      { x: pos.x, y: pos.y + h },
    ];
  }
  return (shape.points ?? []).map((pt) => ({ x: pos.x + pt.x, y: pos.y + pt.y }));
}

/** The deployment zones of a pattern, as absolute board-space polygons. */
export function deploymentZones(patternId: string | null): DeployZone[] {
  if (!patternId) return [];
  const p = ds.deploymentPatterns.get(patternId) as
    | { zones?: { player: string; name?: string; color?: string; shape: never; position: Vec2 }[] }
    | undefined;
  if (!p?.zones) return [];
  return p.zones.map((z) => ({
    player: z.player,
    name: z.name,
    color: z.color,
    points: shapeToPoints(z.shape, z.position),
  }));
}

// ── territory divider (the dashed line splitting the two players' halves) ─────
// Derived from the deployment zones, the way the printed card draws it: the line
// runs between the two "no-man's-land" gaps on the board perimeter — the midpoint
// of each stretch of edge that separates one player's zone from the other's. For
// opposed bands this is a straight cross-board line; for corner deployments it is
// the diagonal. Each end carries a Defender/Attacker badge on its own side.

export interface TerritoryBadge {
  at: Vec2;
  player: string;
  color: string;
}
export interface TerritoryDivider {
  from: Vec2;
  to: Vec2;
  badges: TerritoryBadge[];
}

function pointInPolygon(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i].y;
    const yj = poly[j].y;
    const intersect =
      yi > pt.y !== yj > pt.y &&
      pt.x < ((poly[j].x - poly[i].x) * (pt.y - yi)) / (yj - yi) + poly[i].x;
    if (intersect) inside = !inside;
  }
  return inside;
}

const polyMean = (pts: Vec2[]): Vec2 => ({
  x: pts.reduce((s, p) => s + p.x, 0) / (pts.length || 1),
  y: pts.reduce((s, p) => s + p.y, 0) / (pts.length || 1),
});

/**
 * Midpoints of the perimeter gaps that separate the two zones. Walk the board
 * edge, classify each step by which zone owns the strip just inside it, and take
 * the centre of every uncovered run flanked by *different* players. Returns the
 * (normally two) divider endpoints.
 */
function perimeterGapMidpoints(def: Vec2[], atk: Vec2[], board: BoardDims = DEFAULT_BOARD): Vec2[] {
  const { width: W, height: H } = board;
  const STEP = 0.25;
  const EPS = 0.1;
  const samples: { p: Vec2; inward: Vec2 }[] = [];
  for (let x = 0; x < W; x += STEP) samples.push({ p: { x, y: 0 }, inward: { x: 0, y: 1 } });
  for (let y = 0; y < H; y += STEP) samples.push({ p: { x: W, y }, inward: { x: -1, y: 0 } });
  for (let x = W; x > 0; x -= STEP) samples.push({ p: { x, y: H }, inward: { x: 0, y: -1 } });
  for (let y = H; y > 0; y -= STEP) samples.push({ p: { x: 0, y }, inward: { x: 1, y: 0 } });

  const cls = samples.map((s) => {
    const q = { x: s.p.x + s.inward.x * EPS, y: s.p.y + s.inward.y * EPS };
    if (pointInPolygon(q, def)) return "d";
    if (pointInPolygon(q, atk)) return "a";
    return "n";
  });
  const n = cls.length;
  const start = cls.findIndex((c) => c !== "n");
  if (start < 0) return [];
  const at = (i: number): string => cls[(i + start) % n];
  const sampleAt = (i: number): Vec2 => samples[(i + start) % n].p;

  const mids: Vec2[] = [];
  let k = 0;
  while (k < n) {
    if (at(k) !== "n") {
      k++;
      continue;
    }
    let j = k;
    while (j < n && at(j) === "n") j++;
    const before = at(k - 1); // k>=1: index 0 is never a gap
    const after = j < n ? at(j) : at(0); // a trailing run wraps to the non-gap start
    if (before !== after) mids.push(sampleAt(k + Math.floor((j - k) / 2)));
    k = j;
  }
  return mids;
}

/**
 * Territory polygons for a deployment pattern — the large half-board shapes that
 * define which player controls which side. Distinct from the smaller `zones` (the
 * actual deployment areas). Read from the `territories` key of the pattern.
 */
function deploymentTerritories(patternId: string): DeployZone[] {
  const p = ds.deploymentPatterns.get(patternId) as
    | { territories?: { player: string; name?: string; color?: string; shape: never; position: Vec2 }[] }
    | undefined;
  if (!p?.territories) return [];
  return p.territories.map((z) => ({
    player: z.player,
    name: z.name,
    color: z.color,
    points: shapeToPoints(z.shape, z.position),
  }));
}

/** The dashed territory divider (line + per-end Attacker/Defender badges), or null. */
export function territoryDivider(
  patternId: string | null,
  board: BoardDims = DEFAULT_BOARD,
): TerritoryDivider | null {
  if (!patternId) return null;

  // Prefer the explicit territory boundary when territories are defined.
  // Find the two vertices shared between the defender and attacker territory polygons —
  // those are exactly the endpoints of the dividing line (e.g. the board diagonal for
  // Search and Destroy's corner-to-corner split).
  const territories = deploymentTerritories(patternId);
  const defT = territories.find((z) => z.player === "defender");
  const atkT = territories.find((z) => z.player === "attacker");
  if (defT && atkT) {
    const EPS = 0.01;
    const shared = defT.points.filter((d) =>
      atkT.points.some((a) => Math.hypot(a.x - d.x, a.y - d.y) < EPS),
    );
    if (shared.length >= 2) {
      const [from, to] = [shared[0], shared[shared.length - 1]];
      const u = { x: to.x - from.x, y: to.y - from.y };
      const len = Math.hypot(u.x, u.y) || 1;
      const nrm = { x: -u.y / len, y: u.x / len };
      const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
      const cD = polyMean(defT.points);
      const sideD = nrm.x * (cD.x - mid.x) + nrm.y * (cD.y - mid.y);
      const defDir = sideD >= 0 ? nrm : { x: -nrm.x, y: -nrm.y };
      const atkDir = { x: -defDir.x, y: -defDir.y };
      const OFF = 3;
      const defColor = defT.color ?? "#3b82f6";
      const atkColor = atkT.color ?? "#ef4444";
      const badges: TerritoryBadge[] = [];
      for (const e of [from, to]) {
        badges.push({ at: { x: e.x + defDir.x * OFF, y: e.y + defDir.y * OFF }, player: "D", color: defColor });
        badges.push({ at: { x: e.x + atkDir.x * OFF, y: e.y + atkDir.y * OFF }, player: "A", color: atkColor });
      }
      return { from, to, badges };
    }
  }

  // Fall back to zone-gap midpoints for patterns without territory data.
  const zones = deploymentZones(patternId);
  const def = zones.find((z) => z.player === "defender");
  const atk = zones.find((z) => z.player === "attacker");
  if (!def || !atk) return null;
  const ends = perimeterGapMidpoints(def.points, atk.points, board);
  if (ends.length < 2) return null;
  const [from, to] = ends;
  const u = { x: to.x - from.x, y: to.y - from.y };
  const len = Math.hypot(u.x, u.y) || 1;
  const nrm = { x: -u.y / len, y: u.x / len }; // unit perpendicular
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  // Which side of the line the defender's zone sits on (by its centroid).
  const cD = polyMean(def.points);
  const sideD = nrm.x * (cD.x - mid.x) + nrm.y * (cD.y - mid.y);
  const defDir = sideD >= 0 ? nrm : { x: -nrm.x, y: -nrm.y };
  const atkDir = { x: -defDir.x, y: -defDir.y };
  const OFF = 3;
  const defColor = def.color ?? "#3b82f6";
  const atkColor = atk.color ?? "#ef4444";
  const badges: TerritoryBadge[] = [];
  for (const e of [from, to]) {
    badges.push({ at: { x: e.x + defDir.x * OFF, y: e.y + defDir.y * OFF }, player: "D", color: defColor });
    badges.push({ at: { x: e.x + atkDir.x * OFF, y: e.y + atkDir.y * OFF }, player: "A", color: atkColor });
  }
  return { from, to, badges };
}

/** Patterns available for the deployment overlay dropdown. */
export const DEPLOYMENT_PATTERNS: { id: string; name: string }[] = ds.deploymentPatterns.all
  .map((p) => ({ id: p.id, name: p.name }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** A sensible default deployment overlay for a known layout id (best-effort name match). */
export function defaultDeploymentFor(layoutId: string): string | null {
  const ids = new Set(DEPLOYMENT_PATTERNS.map((p) => p.id));
  if (layoutId.includes("crucible") && ids.has("crucible-of-battle")) return "crucible-of-battle";
  if (layoutId.includes("hammer") && ids.has("hammer-and-anvil")) return "hammer-and-anvil";
  if (layoutId.includes("search") && ids.has("search-and-destroy")) return "search-and-destroy";
  if (layoutId.includes("sweeping") && ids.has("sweeping-engagement")) return "sweeping-engagement";
  if (layoutId.includes("colosseum") && ids.has("kotc-colosseum")) return "kotc-colosseum";
  return null;
}

/** Mission-matchup pairings for the layout's "card" dropdown, e.g. "Take and Hold vs Purge the Foe". */
const titleize = (id: string): string =>
  id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
export const MISSION_MATCHUPS: { id: string; label: string }[] = ds.missionMatchups.all
  .map((m) => {
    const mm = m as { id: string; disposition: string; opponent_disposition: string };
    return { id: mm.id, label: `${titleize(mm.disposition)} vs ${titleize(mm.opponent_disposition)}` };
  })
  .sort((a, b) => a.label.localeCompare(b.label));

// ── layout library (matchup × variant coverage grid) ──────────────────────────

/** The five force dispositions, in mission-matrix display order. */
export const DISPOSITIONS = [
  "take-and-hold",
  "disruption",
  "purge-the-foe",
  "priority-assets",
  "reconnaissance",
] as const;

export const dispositionLabel = titleize;

const DISPOSITION_INDEX = new Map<string, number>(DISPOSITIONS.map((d, i) => [d, i]));

interface MatchupRecord {
  id: string;
  disposition: string;
  opponent_disposition: string;
}
const MATCHUPS: MatchupRecord[] = ds.missionMatchups.all.map((m) => m as MatchupRecord);
const MATCHUP_BY_ID = new Map(MATCHUPS.map((m) => [m.id, m]));

/** Printed Event Companion ordering, deliberately distinct from the library grid ordering. */
const EVENT_COMPANION_DISPOSITIONS = [
  "take-and-hold",
  "purge-the-foe",
  "disruption",
  "reconnaissance",
  "priority-assets",
] as const;
const eventCompanionDispositionIndex = (disposition: string): number =>
  EVENT_COMPANION_DISPOSITIONS.indexOf(
    disposition as (typeof EVENT_COMPANION_DISPOSITIONS)[number],
  );

/**
 * The 1-based Event Companion PDF page for a standard layout, or `null` when
 * the layout has no official matchup/variant drawing.
 */
export function eventCompanionPage(
  layout: Pick<EditLayout, "mission_matchup_id" | "variant">,
): number | null {
  const matchup = layout.mission_matchup_id ? MATCHUP_BY_ID.get(layout.mission_matchup_id) : undefined;
  const variant = layout.variant;
  if (!matchup || typeof variant !== "number" || !Number.isInteger(variant) || variant < 1 || variant > 3) return null;

  const a = eventCompanionDispositionIndex(matchup.disposition);
  const b = eventCompanionDispositionIndex(matchup.opponent_disposition);
  if (a < 0 || b < 0) return null;
  const [i, j] = a <= b ? [a, b] : [b, a];
  const pairOrdinal = i * 5 - (i * (i - 1)) / 2 + (j - i);
  return 9 + pairOrdinal * 3 + (variant - 1);
}

/** How a reference background is fitted over the board. All fields optional; see {@link referenceImageBox}. */
export interface ReferenceFit {
  /** Quarter turns clockwise, as displayed. */
  quarterTurns?: number;
  /** Nudge right, in board inches, **as the board appears on screen**. */
  offsetX?: number;
  /** Nudge down, in board inches, **as the board appears on screen**. */
  offsetY?: number;
  /** Uniform zoom about the board centre; 1 fills the board. */
  scale?: number;
}

/**
 * Placement for a reference background image: the rectangle to stretch it into, plus the
 * SVG transform that turns, zooms and nudges it over the board.
 *
 * ## Why the dimensions swap on an odd turn
 *
 * The board is drawn portrait — `Board` wraps its content in a 90° rotation — so a landscape
 * reference (a Battlemaster card face is exactly the 60×44 board, no margin) arrives sideways
 * and needs a quarter turn. Under an odd number of turns the image's width and height
 * exchange roles, so a box sized `board.width × board.height` would no longer cover the board
 * once rotated. Sizing it swapped and centring it makes all four turns fill the board exactly.
 *
 * ## Why the nudge axes are swapped too
 *
 * `offsetX`/`offsetY` are what the user sees, not board axes. The board layer is rotated 90°,
 * which maps board `(x, y)` to screen `(board.height − y, x)`: board +x runs DOWN the screen
 * and board +y runs LEFT. So a screen-space nudge of `(sx, sy)` is a board-space translation
 * of `(sy, −sx)`. Passing the user's numbers straight through would send the image sideways
 * relative to the button they pressed.
 *
 * Rotation and a uniform scale about the same centre commute, so their order here is free;
 * the nudge is applied outermost so it stays a pure screen translation at any rotation.
 */
export function referenceImageBox(
  board: BoardDims,
  fit: ReferenceFit = {},
): { x: number; y: number; width: number; height: number; transform: string } {
  const turns = ((Math.round(fit.quarterTurns ?? 0) % 4) + 4) % 4;
  const scale = fit.scale && fit.scale > 0 ? fit.scale : 1;
  const swapped = turns % 2 === 1;
  const width = swapped ? board.height : board.width;
  const height = swapped ? board.width : board.height;
  const cx = board.width / 2;
  const cy = board.height / 2;

  // Screen-space nudge → board-space translation (see the doc comment).
  const dx = fit.offsetY ?? 0;
  const dy = -(fit.offsetX ?? 0);

  const r = (n: number): number => Math.round(n * 1e4) / 1e4;
  const parts = [`translate(${r(dx)} ${r(dy)})`, `rotate(${turns * 90} ${cx} ${cy})`];
  if (scale !== 1) {
    parts.push(`translate(${cx} ${cy})`, `scale(${r(scale)})`, `translate(${-cx} ${-cy})`);
  }
  return { x: cx - width / 2, y: cy - height / 2, width, height, transform: parts.join(" ") };
}

/** Unordered-pair key for a matchup grid cell: the two dispositions in DISPOSITIONS order. */
export function pairKey(a: string, b: string): string {
  const [lo, hi] = (DISPOSITION_INDEX.get(a) ?? 99) <= (DISPOSITION_INDEX.get(b) ?? 99) ? [a, b] : [b, a];
  return `${lo}|${hi}`;
}

/**
 * The canonical ordered matchup id for an unordered disposition pair (the form
 * with the lower-index disposition first; all 25 ordered ids exist in the data).
 */
export function canonicalMatchupId(a: string, b: string): string | undefined {
  const [lo, hi] = pairKey(a, b).split("|");
  return MATCHUPS.find((m) => m.disposition === lo && m.opponent_disposition === hi)?.id;
}

/** One embedded layout's library card. */
export interface LibraryEntry {
  id: string;
  name: string;
  matchupId?: string;
  variant?: number;
  deploymentPatternId?: string;
}

export interface LibraryCell {
  /** Layouts keyed by their variant number (collisions keep every claimant). */
  byVariant: Map<number, LibraryEntry[]>;
  /** Layouts tagged with this pairing but no variant number. */
  unnumbered: LibraryEntry[];
}

export interface LibraryIndex {
  /** pairKey → cell, only for pairings that have at least one layout. */
  cells: Map<string, LibraryCell>;
  /** Layouts with no mission_matchup_id (or one we can't place on the grid). */
  unassigned: LibraryEntry[];
}

/** Index every embedded layout into the matchup × variant grid. */
export function libraryIndex(): LibraryIndex {
  const cells = new Map<string, LibraryCell>();
  const unassigned: LibraryEntry[] = [];
  for (const raw of ds.terrainLayouts.all) {
    const l = raw as unknown as TerrainLayout;
    const entry: LibraryEntry = {
      id: l.id,
      name: l.name,
      matchupId: l.mission_matchup_id,
      variant: l.variant ?? undefined,
      deploymentPatternId: l.deployment_pattern_id,
    };
    const m = entry.matchupId ? MATCHUP_BY_ID.get(entry.matchupId) : undefined;
    if (!m) {
      unassigned.push(entry);
      continue;
    }
    const key = pairKey(m.disposition, m.opponent_disposition);
    const cell: LibraryCell = cells.get(key) ?? { byVariant: new Map(), unnumbered: [] };
    cells.set(key, cell);
    if (entry.variant && entry.variant >= 1) {
      const claimants = cell.byVariant.get(entry.variant) ?? [];
      claimants.push(entry);
      cell.byVariant.set(entry.variant, claimants);
    } else {
      cell.unnumbered.push(entry);
    }
  }
  const byName = (a: LibraryEntry, b: LibraryEntry): number => a.name.localeCompare(b.name);
  for (const cell of cells.values()) cell.unnumbered.sort(byName);
  unassigned.sort(byName);
  return { cells, unassigned };
}

// ── the re-authoring worklist ─────────────────────────────────────────────────
// The 46 committed layouts have an EXACT child/feature layer (every feature was
// authored in its Battlemaster part's own frame) but wrong board-level area
// placement, which is why they are being re-authored by hand. So the old data is
// authoritative for *what a layout contains* and worthless for *where it goes*.
//
// The worklist exposes exactly that split: the expected inventory of areas and
// the feature seats on each, as a checklist to stamp against. It deliberately
// does NOT surface the old rotations — essentially every layout has at least one
// footprint rotated wrong, so showing them would launder a known-bad number into
// the new authoring pass. Advisory throughout: it writes nothing.

/** One expected feature on a worklist row. */
export interface WorklistSeat {
  template: string;
  name: string;
  count: number;
}

/** One expected area configuration, with how many are placed so far. */
export interface WorklistRow {
  /** Signature: area template + its sorted child-template multiset. */
  key: string;
  areaTemplate: string;
  areaName: string;
  seats: WorklistSeat[];
  /** A `TERRAIN_SETS` id that stamps this exact configuration, when one does. */
  setId?: string;
  expected: number;
  placed: number;
}

export interface Worklist {
  /** The embedded layout the inventory came from, or null when there is none. */
  sourceId: string | null;
  rows: WorklistRow[];
  expected: number;
  placed: number;
}

/**
 * Which embedded layout describes the working layout's expected inventory: itself
 * by id, else the layout sharing its `mission_matchup_id` + `variant`. The latter
 * is what makes the worklist usable from a BLANK board, and it is the same key
 * {@link eventCompanionPage} uses for the reference background — so the worklist
 * and the card photo behind the board always describe the same layout.
 */
export function worklistSourceId(layout: EditLayout): string | null {
  if (ds.terrainLayouts.get(layout.id)) return layout.id;
  if (!layout.mission_matchup_id) return null;
  const hit = (ds.terrainLayouts.all as unknown as TerrainLayout[]).find(
    (l) =>
      l.mission_matchup_id === layout.mission_matchup_id &&
      (l.variant ?? undefined) === (layout.variant ?? undefined),
  );
  return hit?.id ?? null;
}

/** Group a layout's areas into `areaTemplate + sorted child templates` signatures. */
function inventorySignatures(pieces: EditPiece[]): Map<string, { areaTemplate: string; children: string[] }> {
  const out = new Map<string, { areaTemplate: string; children: string[] }>();
  for (const p of pieces) {
    if (p.piece_type !== "area" || !p.template) continue;
    const children = pieces
      .filter((c) => c.parent_area_id === p.id && c.template)
      .map((c) => c.template as string)
      .sort();
    // Rotation is deliberately NOT part of the key: it is edited after stamping
    // (and a twin carries +180°), so including it would make rows flicker between
    // matched and unmatched as the author works.
    out.set(`${p.id}`, { areaTemplate: p.template, children });
  }
  return out;
}
const signatureKey = (areaTemplate: string, children: string[]): string =>
  `${areaTemplate}|${children.join(",")}`;

/**
 * The expected-vs-placed inventory for the working layout. `sets` is passed in
 * rather than imported: `model.ts` only imports `sets.ts` as *types*, and a
 * runtime import would close a real module cycle.
 */
export function worklistFor(layout: EditLayout, sets: TerrainSetDef[] = []): Worklist {
  const sourceId = worklistSourceId(layout);
  const source = sourceId
    ? (ds.terrainLayouts.get(sourceId) as unknown as EditLayout | undefined)
    : undefined;
  if (!source) return { sourceId: null, rows: [], expected: 0, placed: 0 };

  const tally = (pieces: EditPiece[]): Map<string, { areaTemplate: string; children: string[]; n: number }> => {
    const m = new Map<string, { areaTemplate: string; children: string[]; n: number }>();
    for (const sig of inventorySignatures(pieces).values()) {
      const key = signatureKey(sig.areaTemplate, sig.children);
      const hit = m.get(key);
      if (hit) hit.n++;
      else m.set(key, { ...sig, n: 1 });
    }
    return m;
  };
  const want = tally(source.pieces);
  const have = tally(layout.pieces);

  // A set whose stamped configuration matches the signature, so a row can name
  // the palette card to grab.
  const setKeyOf = (s: TerrainSetDef): string =>
    signatureKey(s.area.template, s.features.map((f) => f.template).sort());
  const setByKey = new Map(sets.map((s) => [setKeyOf(s), s.id]));

  const rows: WorklistRow[] = [...want.entries()]
    .map(([key, w]) => {
      const seats = new Map<string, WorklistSeat>();
      for (const t of w.children) {
        const hit = seats.get(t);
        if (hit) hit.count++;
        else seats.set(t, { template: t, name: templateById(t)?.name ?? t, count: 1 });
      }
      return {
        key,
        areaTemplate: w.areaTemplate,
        areaName: templateById(w.areaTemplate)?.name ?? w.areaTemplate,
        seats: [...seats.values()].sort((a, b) => a.name.localeCompare(b.name)),
        setId: setByKey.get(key),
        expected: w.n,
        placed: have.get(key)?.n ?? 0,
      };
    })
    .sort((a, b) => a.areaName.localeCompare(b.areaName) || a.key.localeCompare(b.key));

  return {
    sourceId,
    rows,
    expected: rows.reduce((n, r) => n + r.expected, 0),
    // Cap per row: 3 placed against 2 expected shouldn't read as "over 100%".
    placed: rows.reduce((n, r) => n + Math.min(r.placed, r.expected), 0),
  };
}

/**
 * Resolved board geometry of an embedded layout, for library thumbnails.
 * Memoized: dataset layouts are immutable for the life of the build.
 */
const thumbCache = new Map<string, ResolvedPiece[]>();
/** The board extents of an embedded layout (its override, or the 60×44 standard). */
export function boardForEmbedded(id: string): BoardDims {
  const raw = ds.terrainLayouts.get(id) as TerrainLayout | undefined;
  return raw?.board ? { width: raw.board.width, height: raw.board.height } : DEFAULT_BOARD;
}

export function resolveEmbedded(id: string): ResolvedPiece[] {
  const hit = thumbCache.get(id);
  if (hit) return hit;
  const raw = ds.terrainLayouts.get(id) as TerrainLayout | undefined;
  const resolved = raw
    ? resolveLayout(
        raw as unknown as Parameters<typeof resolveLayout>[0],
        CATALOG as unknown as Parameters<typeof resolveLayout>[1],
      )
    : [];
  thumbCache.set(id, resolved);
  return resolved;
}

/** A blank layout pre-seeded for a grid slot (matchup pairing + variant number). */
export function blankLayoutFor(matchupId: string, variant: number): EditLayout {
  const layout = blankLayout();
  const m = MATCHUP_BY_ID.get(matchupId);
  const name = m
    ? `${titleize(m.disposition)} vs ${titleize(m.opponent_disposition)} ${variant}`
    : `Untitled Layout ${variant}`;
  layout.name = name;
  layout.id = slugify(name);
  layout.mission_matchup_id = matchupId;
  layout.variant = variant;
  return layout;
}

// ── symmetry twins (180° rotation about board centre) ─────────────────────────

/** 2-dp, for human-readable warning text only — geometry uses {@link round4}. */
const round2 = (n: number): number => Math.round(n * 100) / 100;
const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;

/** 4-dp like `clampToBoard`, so reflecting a snapped centroid keeps its printed
 *  distances exactly round on the twin as well as the primary. */
export function twinPosition(p: Vec2, board: BoardDims = DEFAULT_BOARD): Vec2 {
  return { x: round4(board.width - p.x), y: round4(board.height - p.y) };
}
export function twinRotation(deg: number): number {
  return norm360(deg + 180);
}
export function isBoardCentre(p: Vec2, board: BoardDims = DEFAULT_BOARD): boolean {
  return Math.abs(p.x - board.width / 2) < 0.3 && Math.abs(p.y - board.height / 2) < 0.3;
}

const byId = (layout: EditLayout, id: string): EditPiece | undefined =>
  layout.pieces.find((p) => p.id === id);
const twinOf = (layout: EditLayout, p: EditPiece): EditPiece | undefined =>
  p.twin_id ? byId(layout, p.twin_id) : undefined;

let counter = 0;
/**
 * A layout-unique `<template>-<n>` id.
 *
 * `layout` is not optional in practice: a loaded layout keeps its AUTHORED ids
 * (`area-large-1`, …) while the counter restarts at 0, so without the collision
 * skip the first `area-large` added to a committed layout re-used `area-large-1`
 * and Svelte's keyed `{#each}` threw `each_key_duplicate`, aborting the board
 * render — i.e. adding a piece to a loaded layout silently did nothing.
 */
function freshId(prefix: string, layout?: EditLayout): string {
  for (;;) {
    counter += 1;
    const id = `${prefix}-${counter}`;
    if (!layout?.pieces.some((p) => p.id === id)) return id;
  }
}

function makePiece(template: TerrainTemplate, position: Vec2, layout?: EditLayout): EditPiece {
  return {
    id: freshId(template.id, layout),
    name: template.name,
    piece_type: template.kind,
    template: template.id,
    position,
    rotation_degrees: 0,
    mirror: "none",
  };
}

/**
 * Add a catalog template to the layout, at `at` (board inches, clamped) when
 * given — e.g. a palette drag-drop — else at the default off-centre spot. In
 * symmetric mode a twin is created at the point-reflection so both halves appear.
 */
export function addTemplate(
  layout: EditLayout,
  template: TerrainTemplate,
  symmetric: boolean,
  at?: Vec2,
): EditPiece {
  const b = boardOf(layout);
  const primary = makePiece(
    template,
    at ? clampToBoard(at, b) : { x: b.width * 0.32, y: b.height * 0.32 },
    layout,
  );
  layout.pieces.push(primary);
  if (symmetric && !isBoardCentre(primary.position, b)) {
    const twin = makePiece(template, twinPosition(primary.position, b), layout);
    twin.rotation_degrees = twinRotation(primary.rotation_degrees);
    twin.mirror = primary.mirror;
    primary.twin_id = twin.id;
    twin.twin_id = primary.id;
    layout.pieces.push(twin);
  }
  return primary;
}

/**
 * A set feature's resolved area-local placement — the single seam `addSet` and the
 * palette thumbnail both go through, so the preview provably is what lands and
 * neither can drift from interactive seating (both end up in
 * {@link seatPositionInPlate}). Null when the template is unknown, which callers
 * skip; a set declares *seats*, not coordinates, so a re-measured plate re-derives
 * instead of going silently stale.
 */
export function resolveSetFeature(
  areaFp: TerrainTemplate["footprint"],
  def: SetFeatureDef,
): { template: TerrainTemplate; position: Vec2; rotation: number; mirror: Mirror } | null {
  const template = templateById(def.template);
  if (!template) return null;
  const rotation = norm360(def.rotation);
  const mirror = def.mirror ?? "none";
  return {
    template,
    rotation,
    mirror,
    position: seatPositionInPlate(areaFp, template.footprint, rotation, mirror, def.seat),
  };
}

/**
 * Stamp a terrain set: the area piece (at `at` when given, else the default
 * spot) plus its features parented to it at their area-local placements. In
 * symmetric mode the area gets a board twin and every feature gets a twin
 * parented to the area's twin at the IDENTICAL local placement — the same
 * invariants `setParentArea` maintains (the +180° lives on the area twin).
 * Returns the area piece for selection.
 */
export function addSet(
  layout: EditLayout,
  set: TerrainSetDef,
  symmetric: boolean,
  at?: Vec2,
): EditPiece | null {
  const areaTmpl = templateById(set.area.template);
  if (!areaTmpl) return null;
  const b = boardOf(layout);
  const area = makePiece(
    areaTmpl,
    at ? clampToBoard(at, b) : { x: b.width * 0.32, y: b.height * 0.32 },
    layout,
  );
  if (set.area.rotation) area.rotation_degrees = norm360(set.area.rotation);
  layout.pieces.push(area);

  let areaTwin: EditPiece | undefined;
  if (symmetric && !isBoardCentre(area.position, b)) {
    areaTwin = makePiece(areaTmpl, twinPosition(area.position, b), layout);
    areaTwin.rotation_degrees = twinRotation(area.rotation_degrees);
    areaTwin.mirror = area.mirror;
    area.twin_id = areaTwin.id;
    areaTwin.twin_id = area.id;
    layout.pieces.push(areaTwin);
  }

  for (const f of set.features) {
    const r = resolveSetFeature(areaTmpl.footprint, f);
    if (!r) continue;
    const feat = makePiece(r.template, { x: r.position.x, y: r.position.y }, layout);
    feat.rotation_degrees = r.rotation;
    feat.mirror = r.mirror;
    feat.parent_area_id = area.id;
    layout.pieces.push(feat);
    if (areaTwin) {
      const featTwin = makePiece(r.template, { x: r.position.x, y: r.position.y }, layout);
      featTwin.rotation_degrees = feat.rotation_degrees;
      featTwin.mirror = feat.mirror;
      featTwin.parent_area_id = areaTwin.id;
      feat.twin_id = featTwin.id;
      featTwin.twin_id = feat.id;
      layout.pieces.push(featTwin);
    }
  }
  return area;
}

/**
 * Stamp the near-universal centre objective: two trapezoid areas interlocked
 * about the board centre, linked as one objective ("Center", role `center`).
 * Placements are the consensus from the committed layouts; `rotated` is the
 * same pair turned 90°. Always stamps both halves (the pair IS the object),
 * regardless of the global symmetry toggle. Returns null — stamping nothing —
 * when the layout already has a centre objective.
 */
export function addCenterRuin(layout: EditLayout, rotated = false): EditPiece | null {
  if (layout.pieces.some((p) => p.objective_role === "center")) return null;
  const tmpl = templateById("area-trapezoid");
  if (!tmpl) return null;
  const pos = rotated ? { x: 28.85, y: 19.8 } : { x: 32.2, y: 20.85 };
  const rot = rotated ? 270 : 0;
  const a = makePiece(tmpl, pos, layout);
  a.rotation_degrees = rot;
  a.mirror = "horizontal";
  const b = makePiece(tmpl, twinPosition(pos), layout);
  b.rotation_degrees = twinRotation(rot);
  b.mirror = "horizontal";
  a.twin_id = b.id;
  b.twin_id = a.id;
  for (const p of [a, b]) {
    p.link_group = "Center";
    p.objective_role = "center";
    p.is_objective = true;
  }
  layout.pieces.push(a, b);
  return a;
}

/**
 * Move a piece's centroid. `position` is always a BOARD-space point (drag and
 * the inspector both work in board inches). For a parented feature we convert it
 * into the parent area's local frame before storing, and the twin — which is
 * parented to the AREA's twin — takes the *same* local centroid (a 180° board
 * rotation about centre maps area→twin and leaves the local coordinate fixed).
 * Unparented pieces keep the board-mirror twin convention.
 */
export function movePiece(layout: EditLayout, id: string, position: Vec2): void {
  const p = byId(layout, id);
  if (!p) return;
  // Clamp the board centroid to the table so no piece (or runaway edit) can leave
  // the map. Applies to every path: drag, inspector fields, and solver placement.
  const b = boardOf(layout);
  const board = clampToBoard(position, b);
  const area = parentAreaOf(layout, p);
  if (area) {
    p.position = inverseAreaFrame(board, area);
    const t = twinOf(layout, p);
    if (t) t.position = { x: p.position.x, y: p.position.y };
    return;
  }
  p.position = board;
  const t = twinOf(layout, p);
  if (t) t.position = twinPosition(board, b);
}

/**
 * Set rotation and/or mirror, keeping the twin in sync. For a parented feature
 * `rotation_degrees` is the feature's rotation *within* the area-local frame, and
 * its twin (parented to the area's twin) carries the identical local rotation —
 * the +180° already lives on the area twin. Unparented pieces keep the +180°
 * board-twin convention.
 */
export function orientPiece(
  layout: EditLayout,
  id: string,
  patch: { rotation_degrees?: number; mirror?: Mirror },
): void {
  const p = byId(layout, id);
  if (!p) return;
  const t = twinOf(layout, p);

  // Pin any features parented to this area (and its twin area) in place: flipping
  // or rotating an area changes only the area's OWN shape — the features sitting
  // on it keep their exact board pose (position AND orientation), so nothing
  // flies off or spins. Snapshot each child's board centroid + the area's old
  // orientation BEFORE the frame changes; afterwards re-express both halves of
  // the child's local pose against the new frame. (For a parented *feature* the
  // child list is empty, so it orients exactly as before.)
  const pinned: { child: EditPiece; area: EditPiece; board: Vec2; oldAreaLin: Mat2 }[] = [];
  const snapshot = (area: EditPiece): void => {
    const oldAreaLin = orientMatrix(area.rotation_degrees ?? 0, area.mirror ?? "none");
    for (const c of childFeaturesOf(layout, area.id)) {
      pinned.push({ child: c, area, board: boardCentroid(layout, c), oldAreaLin });
    }
  };
  snapshot(p);
  if (t && t.id !== p.id) snapshot(t);

  if (patch.rotation_degrees !== undefined) p.rotation_degrees = norm360(patch.rotation_degrees);
  if (patch.mirror !== undefined) p.mirror = patch.mirror;
  if (t && t.id !== p.id) {
    const parented = !!parentAreaOf(layout, p);
    if (patch.rotation_degrees !== undefined) {
      t.rotation_degrees = parented ? p.rotation_degrees : twinRotation(patch.rotation_degrees);
    }
    if (patch.mirror !== undefined) t.mirror = patch.mirror;
  }

  for (const { child, area, board, oldAreaLin } of pinned) {
    // newChildLin = newArea⁻¹ · oldArea · oldChild — the child orientation that,
    // composed through the area's NEW frame, reproduces its old board orientation.
    const newAreaLin = orientMatrix(area.rotation_degrees ?? 0, area.mirror ?? "none");
    const childLin = orientMatrix(child.rotation_degrees ?? 0, child.mirror ?? "none");
    const { rotation, mirror } = decomposeOrient(
      mat2Mul(mat2Mul(mat2Transpose(newAreaLin), oldAreaLin), childLin),
    );
    child.rotation_degrees = rotation;
    child.mirror = mirror;
    child.position = inverseAreaFrame(board, area);
  }
}

/**
 * Anchor a feature to an area (or clear it). Conversions keep the feature's
 * resolved board position fixed at the instant of (un)linking, so nothing jumps.
 * In symmetric mode the feature's twin is parented to the area's twin at the same
 * local placement; if the area has no twin the feature/twin pairing is dropped so
 * the board-mirror and parent conventions never fight.
 */
export function setParentArea(layout: EditLayout, id: string, parentId: string | undefined): void {
  const p = byId(layout, id);
  if (!p) return;
  const next = parentId || undefined;
  if (p.parent_area_id === next) return;
  const board = boardCentroid(layout, p); // board centroid under the *current* parent
  if (next) {
    const parent = byId(layout, next);
    if (!parent || parent.id === p.id) return;
    p.parent_area_id = next;
    p.position = inverseAreaFrame(board, parent);
    const t = twinOf(layout, p);
    if (t) {
      const areaTwin = parent.twin_id ? byId(layout, parent.twin_id) : undefined;
      if (areaTwin && areaTwin.id !== parent.id) {
        t.parent_area_id = areaTwin.id;
        t.position = { x: p.position.x, y: p.position.y };
        t.rotation_degrees = p.rotation_degrees;
        t.mirror = p.mirror;
      } else {
        // No consistent area twin to anchor the feature's twin to — unpair them.
        t.twin_id = undefined;
        p.twin_id = undefined;
      }
    }
    return;
  }
  // Clear: convert back to board space for the feature and its (parented) twin.
  p.parent_area_id = undefined;
  p.position = board;
  const t = twinOf(layout, p);
  if (t && t.parent_area_id) {
    const tBoard = boardCentroid(layout, t);
    t.parent_area_id = undefined;
    t.position = tBoard;
  }
}

/**
 * Centre a parented feature in the parent area's PLATE (its artwork rectangle) —
 * how the 4 centred captures (generator/pipe/catwalk/gantry) are actually laid out.
 * Not the raw centroid: a nubbed outline's polygon centroid is pulled off the plate
 * centre by the nubs, and the corpus says the plate centre is the intended anchor
 * (0.004″ vs 0.047″ error against the captured `area-medium` generator). Falls back
 * to area-local {0,0} when the area has no resolvable footprint.
 */
export function snapToAreaCenter(layout: EditLayout, id: string): void {
  const p = byId(layout, id);
  if (!p || !p.parent_area_id) return;
  const area = parentAreaOf(layout, p);
  const areaFp = area ? footprintOf(area) : undefined;
  const featureFp = footprintOf(p);
  p.position =
    areaFp && featureFp
      ? seatPositionInPlate(areaFp, featureFp, p.rotation_degrees, p.mirror, { kind: "centred" })
      : { x: 0, y: 0 };
  const t = twinOf(layout, p);
  if (t) t.position = { x: p.position.x, y: p.position.y };
}

/**
 * Seat a parented feature into a corner of the parent area's PLATE rect with an
 * inset — the rule that reproduces all 69 captured Battlemaster feature placements
 * to ≤0.005″ (see the plate-seating section above). `corner` defaults to the
 * minimum-displacement seat, so this can run unattended on a rough drop; `inset`
 * defaults to Battlemaster's 0.5″.
 *
 * Writes `position` in area-local coords directly and copies it onto the symmetry
 * twin, which is parented to the AREA's twin at the identical local placement —
 * the convention `movePiece`/`setParentArea` already maintain.
 *
 * Distinct from {@link snapFeatureToAreaCorner}, which is vertex-coincident with no
 * inset (and can reach a non-cardinal vertex). Both are exposed: this one
 * reproduces real Battlemaster boards, that one is the free-form nudge.
 */
export function seatFeatureInAreaCorner(
  layout: EditLayout,
  id: string,
  corner?: PlateCorner,
  inset: Vec2 = DEFAULT_SEAT_INSET,
): void {
  const p = byId(layout, id);
  if (!p || !p.parent_area_id) return;
  const area = parentAreaOf(layout, p);
  if (!area) return;
  const areaFp = footprintOf(area);
  const featureFp = footprintOf(p);
  if (!areaFp || !featureFp) return;
  const at =
    corner ??
    nearestPlateSeat(areaFp, featureFp, p.rotation_degrees, p.mirror, p.position, inset);
  p.position = seatPositionInPlate(areaFp, featureFp, p.rotation_degrees, p.mirror, {
    kind: "corner",
    corner: at,
    inset,
  });
  const t = twinOf(layout, p);
  if (t) t.position = { x: p.position.x, y: p.position.y };
}

/**
 * Snap a parented feature so its nearest vertex aligns with the nearest corner of
 * the parent area. Template-agnostic: the feature is already approximately placed,
 * so the closest (featureVert, areaCorner) pair is always the intended one.
 *
 * Vertex-coincident and inset-free, so it does NOT reproduce Battlemaster's 0.5″
 * seating and on a nubbed outline it can land on a nub — use
 * {@link seatFeatureInAreaCorner} to match a real board.
 */
export function snapFeatureToAreaCorner(layout: EditLayout, id: string): void {
  const p = byId(layout, id);
  if (!p || !p.parent_area_id) return;
  const area = parentAreaOf(layout, p);
  if (!area) return;
  const fp = orientedFootprint(p, layout);
  const afp = orientedFootprint(area, layout);
  if (!fp || !afp) return;
  let best = Infinity;
  let delta = { x: 0, y: 0 };
  for (const fv of fp.verticesBoard) {
    for (const av of afp.verticesBoard) {
      const d = Math.hypot(av.x - fv.x, av.y - fv.y);
      if (d < best) {
        best = d;
        delta = { x: av.x - fv.x, y: av.y - fv.y };
      }
    }
  }
  const newBoard = { x: fp.centroid.x + delta.x, y: fp.centroid.y + delta.y };
  p.position = inverseAreaFrame(newBoard, area);
  const t = twinOf(layout, p);
  if (t) t.position = { x: p.position.x, y: p.position.y };
}

/**
 * Re-anchor a feature to the area it actually sits on: pick the area whose
 * centroid is nearest the feature's current board centroid and re-parent to it,
 * keeping the feature's board position fixed (via `setParentArea`). Fixes a
 * feature mistakenly attached to the mirror-twin area — its stored area-local
 * offset balloons to ~half a board and a mirror/rotate then flings it off-table.
 * No-op when the nearest area is already the parent (or there are no areas).
 */
export function reanchorToNearestArea(layout: EditLayout, id: string): void {
  const p = byId(layout, id);
  if (!p || p.piece_type !== "feature") return;
  const c = boardCentroid(layout, p);
  let nearest: EditPiece | undefined;
  let bestD = Infinity;
  for (const a of layout.pieces) {
    if (a.piece_type !== "area" || a.id === p.id) continue;
    const d = Math.hypot(a.position.x - c.x, a.position.y - c.y);
    if (d < bestD) {
      bestD = d;
      nearest = a;
    }
  }
  if (nearest && nearest.id !== p.parent_area_id) setParentArea(layout, id, nearest.id);
}

/** Re-anchor every feature to the area it sits on (whole-layout repair sweep). */
export function reanchorAllFeatures(layout: EditLayout): void {
  for (const p of layout.pieces) {
    if (p.piece_type === "feature" && p.id) reanchorToNearestArea(layout, p.id);
  }
}

/** Set a piece's link group, mirroring the same value onto its twin. */
export function setLinkGroup(layout: EditLayout, id: string, group: string | undefined): void {
  const p = byId(layout, id);
  if (!p) return;
  p.link_group = group || undefined;
  const t = twinOf(layout, p);
  if (t) t.link_group = group || undefined;
}

// ── measurement keystones ─────────────────────────────────────────────────────
// Authoring keeps only the {edge, ref} selection on the piece; distances are
// always derived live through the package's `keystoneMeasurements` (the same
// pinned helper the cards render with), so a keystone can never drift from the
// geometry. Add/remove sync the point-reflected mirror onto the piece's
// symmetry twin (when paired), so every printed dimension has its counterpart
// on the opposing piece. The vertex mapping is resolved geometrically — see
// `mirrorKeystone` — because same-angle twins break index arithmetic.

export const sameSolverRef = (a: SolverRef, b: SolverRef): boolean =>
  a.kind === "vertex" && b.kind === "vertex"
    ? a.index === b.index
    : a.kind === "face" && b.kind === "face"
      ? a.side === b.side
      : false;

/**
 * Whether a keystone is measurable against the piece's current footprint: the
 * vertex index must exist, and a face ref's axis must match the edge's. Can go
 * false after a template's footprint is re-authored — surfaced as an inline
 * warning, never a crash.
 */
export function keystoneValid(piece: EditPiece, k: EditKeystone): boolean {
  if (k.ref.kind === "face") {
    const edgeOnX = k.edge === "left" || k.edge === "right";
    const sideOnX = k.ref.side === "min-x" || k.ref.side === "max-x";
    return edgeOnX === sideOnX;
  }
  const fp = footprintOf(piece);
  if (!fp) return false;
  return k.ref.index >= 0 && k.ref.index < footprintVertices(fp as never).length;
}

const flipEdge = (e: EditKeystone["edge"]): EditKeystone["edge"] =>
  e === "left" ? "right" : e === "right" ? "left" : e === "top" ? "bottom" : "top";
const flipSide = (s: "min-x" | "max-x" | "min-y" | "max-y"): "min-x" | "max-x" | "min-y" | "max-y" =>
  s === "min-x" ? "max-x" : s === "max-x" ? "min-x" : s === "min-y" ? "max-y" : "min-y";

/** How close (inches) the point-reflected vertex must land to a twin vertex. */
const MIRROR_VERT_EPS = 0.25;

/**
 * The keystone `k` point-reflected onto `twin`: edge and face refs flip
 * axis-symmetrically; a vertex ref is resolved geometrically — reflect the
 * primary's board-space vertex through the board centre and take the twin's
 * nearest vertex. Index arithmetic is NOT safe here: migrated layouts often
 * store the twin at the same angle (not θ+180), so index i on one side need
 * not be index i on the other. Null when the reflection lands more than
 * {@link MIRROR_VERT_EPS} from every twin vertex (a not-quite-symmetric pair)
 * — the caller skips rather than pins the wrong corner.
 */
export function mirrorKeystone(
  layout: EditLayout,
  primary: EditPiece,
  twin: EditPiece,
  k: EditKeystone,
): EditKeystone | null {
  const edge = flipEdge(k.edge);
  if (k.ref.kind === "face") return { edge, ref: { kind: "face", side: flipSide(k.ref.side) } };
  const pf = orientedFootprint(primary, layout);
  const tf = orientedFootprint(twin, layout);
  const anchor = pf?.verticesBoard[k.ref.index];
  if (!anchor || !tf) return null;
  const b = boardOf(layout);
  const reflected = { x: b.width - anchor.x, y: b.height - anchor.y };
  let bestIndex = -1;
  let best = Infinity;
  tf.verticesBoard.forEach((v, i) => {
    const d = Math.hypot(v.x - reflected.x, v.y - reflected.y);
    if (d < best) {
      best = d;
      bestIndex = i;
    }
  });
  if (bestIndex < 0 || best > MIRROR_VERT_EPS) return null;
  return { edge, ref: { kind: "vertex", index: bestIndex } };
}

const hasKeystone = (p: EditPiece, k: EditKeystone): boolean =>
  (p.keystones ?? []).some((e) => e.edge === k.edge && sameSolverRef(e.ref, k.ref));

/** Pin a keystone on a piece (no-op for an exact duplicate), mirroring it onto the twin. */
export function addKeystone(layout: EditLayout, id: string, k: EditKeystone): void {
  const p = byId(layout, id);
  if (!p) return;
  if (!hasKeystone(p, k)) p.keystones = [...(p.keystones ?? []), k];
  const t = twinOf(layout, p);
  if (!t || t.id === p.id) return;
  const mk = mirrorKeystone(layout, p, t, k);
  if (mk && !hasKeystone(t, mk)) t.keystones = [...(t.keystones ?? []), mk];
}

/** Remove the piece's keystone at `index`, and its mirror from the twin. */
export function removeKeystone(layout: EditLayout, id: string, index: number): void {
  const p = byId(layout, id);
  const k = p?.keystones?.[index];
  if (!p || !k) return;
  // Resolve the twin's mirror BEFORE mutating anything (it reads geometry only,
  // but keeping the read-then-write order makes that explicit).
  const t = twinOf(layout, p);
  const mk = t && t.id !== p.id ? mirrorKeystone(layout, p, t, k) : null;
  const next = p.keystones!.filter((_, i) => i !== index);
  p.keystones = next.length > 0 ? next : undefined;
  if (t && mk) {
    const tNext = (t.keystones ?? []).filter((e) => !(e.edge === mk.edge && sameSolverRef(e.ref, mk.ref)));
    t.keystones = tNext.length > 0 ? tNext : undefined;
  }
}

/**
 * Swap the keystone at `index` for `k`, keeping its position in the list and
 * re-deriving the twin's mirror. Used by the Inspector's near/far edge flip and
 * its corner↔face swap: the clock picker always guesses the nearest edge and a
 * corner, and both guesses are right most of the time but not always.
 */
export function replaceKeystone(
  layout: EditLayout,
  id: string,
  index: number,
  k: EditKeystone,
): void {
  const p = byId(layout, id);
  if (!p?.keystones?.[index]) return;
  const kept = [...p.keystones];
  removeKeystone(layout, id, index);
  addKeystone(layout, id, k);
  // `addKeystone` appends; restore the original slot so the list doesn't reorder
  // under the author's cursor mid-edit.
  const now = p.keystones ?? [];
  const added = now[now.length - 1];
  if (added && now.length === kept.length) {
    const reordered = [...now.slice(0, now.length - 1)];
    reordered.splice(index, 0, added);
    p.keystones = reordered;
  }
}

/** One keystone with its live derived distance (null when unmeasurable). */
export interface KeystoneDisplay {
  pieceId: string;
  /** Index into the owning piece's `keystones` array. */
  index: number;
  keystone: EditKeystone;
  distance: number | null;
}

/**
 * Every keystone in the layout with its live distance. Invalid keystones (and
 * all keystones, if the layout itself fails to resolve mid-edit) come back
 * with `distance: null` so the UI can warn instead of crashing.
 */
export function keystoneDisplays(layout: EditLayout): KeystoneDisplay[] {
  const order: { display: KeystoneDisplay; valid: boolean }[] = [];
  const pieces = layout.pieces.map((p) => {
    const valid: EditKeystone[] = [];
    for (const [i, k] of (p.keystones ?? []).entries()) {
      const ok = keystoneValid(p, k);
      order.push({ display: { pieceId: p.id, index: i, keystone: k, distance: null }, valid: ok });
      if (ok) valid.push(k);
    }
    return { ...p, keystones: valid };
  });
  let measured: number[] = [];
  try {
    measured = keystoneMeasurements(
      { ...layout, pieces } as unknown as Parameters<typeof keystoneMeasurements>[0],
      CATALOG as unknown as Parameters<typeof keystoneMeasurements>[1],
      boardOf(layout),
    ).map((m) => m.distance);
  } catch {
    // Layout doesn't resolve mid-edit (e.g. a piece lost its footprint):
    // distances read as unmeasurable until it does again.
    measured = [];
  }
  let mi = 0;
  return order.map(({ display, valid }) => ({
    ...display,
    distance: valid ? (measured[mi++] ?? null) : null,
  }));
}

// ── keystone-grid snapping and the corner ("clock") picker ────────────────────
// Printed card dimensions are clean ¼″ increments, so authoring wants to snap to
// them. Crucially that is NOT a grid on `position`: a piece's `position` is the
// centroid of its (nubbed) polygon, and the centroid→plate-corner offsets are not
// multiples of ¼″ — `area-large`'s are (−5.7309, −3.5583) and friends. Quantizing
// the centroid therefore lands every *measured* vertex off-grid and would trip
// `keystoneRoundnessWarnings` on every piece placed.
//
// So the snap quantizes the thing the card actually prints — the keystone
// distances — and back-solves the centroid through the package's `solveCentroid`,
// the pinned inverse of the resolver's placement. That is the same call the
// Inspector's "solve & place" uses, so the two placement routes cannot disagree.
//
// A piece is "armed" for snapping iff its OWN keystones pin exactly one x-axis and
// one y-axis measurement. That is derived, never stored: committing a corner pick
// is just `addKeystone` ×2, which already mirrors onto the symmetry twin and
// already renders live dimension lines. It also means a 3-keystone triangulation
// piece is automatically not armed, so off-axis areas fall through to the typed
// solver — which is the only thing that can place them anyway.

/**
 * Card measurements are clean quarter-inch increments; anything off by more than
 * {@link isRoundKeystone}'s tolerance is treated as a data-entry rounding error
 * worth reviewing. Exported because it is also the default snap step.
 */
export const KEYSTONE_INCREMENT = 0.25;

/** Which board axis a keystone edge measures along. */
const edgeAxis = (e: EditKeystone["edge"]): "x" | "y" =>
  e === "left" || e === "right" ? "x" : "y";
/** Whether an edge is the near one (distance reads the coordinate directly). */
const edgeIsNear = (e: EditKeystone["edge"]): boolean => e === "left" || e === "top";

/** The one x-axis and one y-axis keystone that arm a piece for grid snapping. */
export interface SnapAnchor {
  x: EditKeystone;
  y: EditKeystone;
}

/**
 * The snap anchor implied by a piece's own keystones: exactly one x-axis
 * (left/right) and one y-axis (top/bottom) measurement, both currently
 * measurable. Null for 0, 1, or 3+ keystones and for two on the same axis —
 * precisely the cases that belong to the typed solver instead.
 */
export function snapAnchorOf(piece: EditPiece): SnapAnchor | null {
  const ks = (piece.keystones ?? []).filter((k) => keystoneValid(piece, k));
  const xs = ks.filter((k) => edgeAxis(k.edge) === "x");
  const ys = ks.filter((k) => edgeAxis(k.edge) === "y");
  if (xs.length !== 1 || ys.length !== 1 || ks.length !== 2) return null;
  return { x: xs[0], y: ys[0] };
}

/**
 * The distance a keystone would read if `piece` were centred at `at` — the
 * forward measurement `keystoneMeasurements` performs, evaluated on a
 * hypothetical placement so a drag can be snapped before it is committed. Null
 * when the ref doesn't resolve against the current footprint.
 */
export function measureLine(
  piece: EditPiece,
  board: BoardDims,
  at: Vec2,
  k: EditKeystone,
): number | null {
  const fp = footprintOf(piece);
  if (!fp || !keystoneValid(piece, k)) return null;
  const offsets = orientedOffsets(fp as never, piece.rotation_degrees, piece.mirror) as Vec2[];
  const axis = edgeAxis(k.edge);
  let off: number;
  if (k.ref.kind === "vertex") {
    const v = offsets[k.ref.index];
    if (!v) return null;
    off = axis === "x" ? v.x : v.y;
  } else {
    const vals = offsets.map((o) => (axis === "x" ? o.x : o.y));
    off = k.ref.side === "min-x" || k.ref.side === "min-y" ? Math.min(...vals) : Math.max(...vals);
  }
  const coord = (axis === "x" ? at.x : at.y) + off;
  const extent = axis === "x" ? board.width : board.height;
  return edgeIsNear(k.edge) ? coord : extent - coord;
}

/** What {@link snapToKeystoneGrid} resolved: the placement and both distances. */
export interface SnapResult {
  position: Vec2;
  /** The snapped (printed) distances, x-axis then y-axis. */
  distances: { x: number; y: number };
  /** What they read before snapping, for a live delta readout. */
  before: { x: number; y: number };
}

/**
 * Round an armed piece's two keystone distances to `step` and back-solve the
 * centroid that produces them. `at` is the candidate board centroid (the raw drag
 * point), so a caller can snap a placement it has not committed yet.
 *
 * Returns null — never throws — when the piece isn't armed, has no footprint, or
 * carries a stale vertex index. Top-level pieces only: `position` must be a board
 * centroid, so callers gate on `!parent_area_id`.
 */
export function snapToKeystoneGrid(
  piece: EditPiece,
  board: BoardDims,
  at: Vec2,
  step: number = KEYSTONE_INCREMENT,
): SnapResult | null {
  const anchor = snapAnchorOf(piece);
  const fp = footprintOf(piece);
  if (!anchor || !fp || step <= 0) return null;
  const bx = measureLine(piece, board, at, anchor.x);
  const by = measureLine(piece, board, at, anchor.y);
  if (bx === null || by === null) return null;
  const q = (n: number): number => round4(Math.round(n / step) * step);
  const distances = { x: q(bx), y: q(by) };
  try {
    const pos = solveCentroid({
      footprint: fp as never,
      rotation: piece.rotation_degrees,
      mirror: piece.mirror,
      board,
      lines: [
        { edge: anchor.x.edge, distance: distances.x, feature: anchor.x.ref },
        { edge: anchor.y.edge, distance: distances.y, feature: anchor.y.ref },
      ],
    } as unknown as SolveInput);
    return {
      position: { x: round4(pos.x), y: round4(pos.y) },
      distances,
      before: { x: round4(bx), y: round4(by) },
    };
  } catch {
    return null;
  }
}

/**
 * The board edges a keystone pair should measure from, given the anchor vertex's
 * board position: the nearest edge on each axis.
 *
 * Measured against the committed corpus this agrees with 1070 of 1150 authored
 * vertex keystones. The tempting alternative — "the edge the corner faces" —
 * agrees with only 594, i.e. a coin flip, so do not "simplify" to it. The ~5%
 * that legitimately measure from the far edge are centre-straddling pieces; they
 * need the Inspector's per-axis flip.
 */
export function nearestEdgesFor(
  at: Vec2,
  board: BoardDims,
): { x: "left" | "right"; y: "top" | "bottom" } {
  return {
    x: at.x <= board.width / 2 ? "left" : "right",
    y: at.y <= board.height / 2 ? "top" : "bottom",
  };
}

/** A cardinal corner of a placed piece, in board space, with its vertex index. */
export interface CornerCandidate {
  index: number;
  at: Vec2;
}

/**
 * The vertices the corner picker offers: the piece's cardinal corners, in board
 * space. Confirmed against the corpus — all 1150 authored vertex keystones point
 * at a cardinal corner, never at a die-cut nub.
 */
export function cornerCandidates(piece: EditPiece, layout: EditLayout): CornerCandidate[] {
  const fp = footprintOf(piece);
  const of = orientedFootprint(piece, layout);
  if (!fp || !of) return [];
  return cardinalCornerIndices(fp)
    .map((index) => ({ index, at: of.verticesBoard[index] }))
    .filter((c): c is CornerCandidate => !!c.at);
}

/**
 * Which corner the pointer is aiming at, by direction from the piece's centroid —
 * the "clock" pick. Compares direction only (not distance), so it is independent
 * of the footprint's aspect ratio and of how far out the pointer has strayed.
 *
 * `previous` + `margin` give hysteresis so a pointer resting on a sector boundary
 * doesn't flicker; a pointer inside `deadZone` inches of the centroid has no
 * meaningful direction and keeps `previous`. All in board space, which is why the
 * board's 90° display rotation needs no special handling: the pointer and the
 * corners go through the same CTM, so the direction the user sees is this one.
 */
export function pickCornerByDirection(
  candidates: CornerCandidate[],
  centroid: Vec2,
  pointer: Vec2,
  opts: { previous?: number | null; margin?: number; deadZone?: number } = {},
): number | null {
  const { previous = null, margin = 0.03, deadZone = 0.5 } = opts;
  if (candidates.length === 0) return null;
  const d = { x: pointer.x - centroid.x, y: pointer.y - centroid.y };
  const len = Math.hypot(d.x, d.y);
  if (len < deadZone) return previous;
  const cosOf = (c: CornerCandidate): number => {
    const v = { x: c.at.x - centroid.x, y: c.at.y - centroid.y };
    const vl = Math.hypot(v.x, v.y);
    return vl === 0 ? -Infinity : (v.x * d.x + v.y * d.y) / (vl * len);
  };
  let best = candidates[0];
  let bestCos = cosOf(candidates[0]);
  for (const c of candidates.slice(1)) {
    const k = cosOf(c);
    if (k > bestCos) {
      bestCos = k;
      best = c;
    }
  }
  if (previous !== null) {
    const prev = candidates.find((c) => c.index === previous);
    if (prev && bestCos - cosOf(prev) < margin) return previous;
  }
  return best.index;
}

/**
 * The H+V keystone pair that measures a piece's vertex `index` from its two
 * nearest board edges — the 1-horizontal/1-vertical-on-the-same-corner shape 430
 * of the corpus's 432 two-keystone areas use.
 */
export function keystonesForCorner(
  piece: EditPiece,
  layout: EditLayout,
  index: number,
): EditKeystone[] | null {
  const of = orientedFootprint(piece, layout);
  const at = of?.verticesBoard[index];
  if (!at) return null;
  const edges = nearestEdgesFor(at, boardOf(layout));
  return [
    { edge: edges.x, ref: { kind: "vertex", index } },
    { edge: edges.y, ref: { kind: "vertex", index } },
  ];
}

/**
 * Pin a piece's snap anchor to cardinal corner `index`, replacing any existing
 * anchor (and its twin mirrors). Refuses — returning false — on a piece carrying
 * 3+ keystones rather than destroying a hand-authored triangulation set, and on a
 * piece whose vertex doesn't resolve.
 */
export function setCornerAnchor(layout: EditLayout, id: string, index: number): boolean {
  const p = byId(layout, id);
  if (!p) return false;
  if ((p.keystones ?? []).length >= 3) return false;
  const next = keystonesForCorner(p, layout, index);
  if (!next) return false;
  // Remove from the end so earlier indices stay valid; each removal also strips
  // the twin's mirror.
  for (let i = (p.keystones ?? []).length - 1; i >= 0; i--) removeKeystone(layout, id, i);
  for (const k of next) addKeystone(layout, id, k);
  return true;
}

/** A keystone edge named in CARD directions (the board is displayed rotated 90°). */
export function cardEdgeName(e: EditKeystone["edge"]): "left" | "right" | "top" | "bottom" {
  return e === "bottom" ? "left" : e === "top" ? "right" : e === "left" ? "top" : "bottom";
}

/** Whether a rotation is one of the four axis-aligned quarter turns. */
export function isAxisAligned(deg: number, tol = 0.01): boolean {
  const r = norm360(deg);
  return [0, 90, 180, 270].some((q) => Math.abs(r - q) < tol || Math.abs(r - q - 360) < tol);
}

/** A pre-filled solver form: two lines for an axis-aligned piece, three for a
 *  rotated one (which needs the angle solved too). */
export interface SolverSeed {
  axisAligned: boolean;
  two: { edge: EditKeystone["edge"]; ref: SolverRef; distance: number }[];
  three: { edge: EditKeystone["edge"]; vertex: number; distance: number }[];
}

/**
 * Seed the typed-distance solver from a piece's current rough pose, so the author
 * corrects digits instead of typing from scratch. Distances are rounded to `step`
 * because the printed card's are.
 *
 * The 3-line form is built so `solveCentroidTriangulated`'s precondition holds:
 * two corners extreme along one axis, measured from that axis' nearest edge (so
 * the vertices are distinct and the angle equation is well conditioned), plus the
 * extreme corner on the other axis.
 */
export function suggestSolverSeed(
  piece: EditPiece,
  layout: EditLayout,
  board: BoardDims,
  step: number = KEYSTONE_INCREMENT,
): SolverSeed | null {
  const candidates = cornerCandidates(piece, layout);
  if (candidates.length === 0) return null;
  const q = (n: number): number => round4(Math.round(n / step) * step);
  const at = orientedFootprint(piece, layout)?.centroid ?? piece.position;
  const dist = (edge: EditKeystone["edge"], ref: SolverRef): number =>
    q(measureLine(piece, board, at, { edge, ref }) ?? 0);

  const anchor = snapAnchorOf(piece);
  const seedCorner =
    anchor?.x.ref.kind === "vertex"
      ? anchor.x.ref.index
      : (pickCornerByDirection(candidates, at, candidates[0].at, { deadZone: 0 }) ??
        candidates[0].index);
  const seedAt = candidates.find((c) => c.index === seedCorner)?.at ?? candidates[0].at;
  const edges = nearestEdgesFor(seedAt, board);
  const two = anchor
    ? [
        { edge: anchor.x.edge, ref: anchor.x.ref, distance: dist(anchor.x.edge, anchor.x.ref) },
        { edge: anchor.y.edge, ref: anchor.y.ref, distance: dist(anchor.y.edge, anchor.y.ref) },
      ]
    : [
        {
          edge: edges.x,
          ref: { kind: "vertex" as const, index: seedCorner },
          distance: dist(edges.x, { kind: "vertex", index: seedCorner }),
        },
        {
          edge: edges.y,
          ref: { kind: "vertex" as const, index: seedCorner },
          distance: dist(edges.y, { kind: "vertex", index: seedCorner }),
        },
      ];

  // Pick the axis with the widest spread for the two same-edge lines: the larger
  // the separation between those vertices, the better conditioned the angle solve.
  const xs = candidates.map((c) => c.at.x);
  const ys = candidates.map((c) => c.at.y);
  const spreadX = Math.max(...xs) - Math.min(...xs);
  const useX = spreadX >= Math.max(...ys) - Math.min(...ys);
  const along = [...candidates].sort((a, b) => (useX ? a.at.x - b.at.x : a.at.y - b.at.y));
  const pairEdge = useX ? edges.x : edges.y;
  const otherEdge = useX ? edges.y : edges.x;
  const lo = along[0];
  const hi = along[along.length - 1];
  // The extreme corner on the OTHER axis, excluding the two already used.
  const rest = candidates.filter((c) => c.index !== lo.index && c.index !== hi.index);
  const third =
    rest.sort((a, b) =>
      otherEdge === "left" || otherEdge === "top"
        ? (useX ? a.at.y - b.at.y : a.at.x - b.at.x)
        : (useX ? b.at.y - a.at.y : b.at.x - a.at.x),
    )[0] ?? hi;

  return {
    axisAligned: isAxisAligned(piece.rotation_degrees),
    two,
    three: [
      { edge: pairEdge, vertex: lo.index, distance: dist(pairEdge, { kind: "vertex", index: lo.index }) },
      { edge: pairEdge, vertex: hi.index, distance: dist(pairEdge, { kind: "vertex", index: hi.index }) },
      { edge: otherEdge, vertex: third.index, distance: dist(otherEdge, { kind: "vertex", index: third.index }) },
    ],
  };
}

// ── layout warnings ("needs review" flag) ─────────────────────────────────────
// Advisory, editor-side checks that surface layouts a human should look at: two
// pieces that overlap when they shouldn't (a feature mirrored onto the wrong side
// "flies across the map"), and keystone distances that aren't clean ¼″ increments
// (a symptom of a coordinate that's slightly off — 15.92″ where the card says
// 16.25″). These are hints, never a gate: some overlaps/near-values are genuine, so
// false positives are tolerable and nothing here blocks saving or loading.

/** The kind of problem a {@link LayoutWarning} reports. */
export type LayoutWarningKind = "collision" | "keystone-not-round";

export interface LayoutWarning {
  kind: LayoutWarningKind;
  /** Human-readable summary for the banner/tooltip. */
  message: string;
  /** Resolved id(s) of the offending piece(s), for on-board highlighting (may be null when a piece has no id). */
  pieceIds: (string | null)[];
}

const KEYSTONE_ROUND_TOL = 0.03;
/** Minimum overlap area (in²) that counts as a collision. Edge-abutting pieces
 *  share vertices exactly and overlap by ~0, so they never trip this; a real
 *  overlap — even a small ruin nub onto a neighbouring baseplate — clears it. */
const COLLISION_MIN_AREA = 0.25;

const nearestIncrement = (n: number): number =>
  Math.round(n / KEYSTONE_INCREMENT) * KEYSTONE_INCREMENT;

/** Whether a keystone distance sits on (or within tolerance of) a clean ¼″ mark. */
export function isRoundKeystone(distance: number): boolean {
  return Math.abs(distance - nearestIncrement(distance)) <= KEYSTONE_ROUND_TOL;
}

const pieceLabel = (p: ResolvedPiece): string => p.name ?? p.id ?? "piece";

/** Signed polygon area (shoelace); sign encodes winding. */
function signedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Whether two polygons' axis-aligned bounding boxes overlap (cheap pre-filter). */
function bboxOverlap(a: Vec2[], b: Vec2[]): boolean {
  const ba = bbox(a);
  const bb = bbox(b);
  return ba.minX <= bb.maxX && bb.minX <= ba.maxX && ba.minY <= bb.maxY && bb.minY <= ba.maxY;
}

/** Barycentric-sign point-in-triangle (boundary counts as inside). */
function inTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const s = (u: Vec2, v: Vec2, w: Vec2): number =>
    (u.x - w.x) * (v.y - w.y) - (v.x - w.x) * (u.y - w.y);
  const d1 = s(p, a, b);
  const d2 = s(p, b, c);
  const d3 = s(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Ear-clipping triangulation of a simple polygon (handles the concave L-shaped
 * ruins). Returns CCW triangles; degenerate input yields no triangles rather than
 * throwing — a warning check must never crash the editor.
 */
function triangulate(poly: Vec2[]): [Vec2, Vec2, Vec2][] {
  const n = poly.length;
  if (n < 3) return [];
  // Normalise to CCW so the convex-vertex test below is orientation-independent.
  const verts = signedArea(poly) < 0 ? poly.slice().reverse() : poly.slice();
  const idx = verts.map((_, i) => i);
  const tris: [Vec2, Vec2, Vec2][] = [];
  let guard = n * n + 16;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const a = verts[idx[(k - 1 + idx.length) % idx.length]];
      const b = verts[idx[k]];
      const c = verts[idx[(k + 1) % idx.length]];
      // Convex (ear tip) in CCW winding: cross > 0.
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (cross <= 0) continue;
      let empty = true;
      for (const j of idx) {
        const v = verts[j];
        if (v === a || v === b || v === c) continue;
        if (inTriangle(v, a, b, c)) {
          empty = false;
          break;
        }
      }
      if (!empty) continue;
      tris.push([a, b, c]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // no ear found (self-intersecting / degenerate): bail
  }
  if (idx.length === 3) tris.push([verts[idx[0]], verts[idx[1]], verts[idx[2]]]);
  return tris;
}

/** Intersection point of segment s→e with the infinite line a→b. */
function lineIntersect(s: Vec2, e: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dc = { x: a.x - b.x, y: a.y - b.y };
  const dp = { x: s.x - e.x, y: s.y - e.y };
  const n1 = a.x * b.y - a.y * b.x;
  const n2 = s.x * e.y - s.y * e.x;
  const denom = dc.x * dp.y - dc.y * dp.x;
  return { x: (n1 * dp.x - n2 * dc.x) / denom, y: (n1 * dp.y - n2 * dc.y) / denom };
}

/** Clip convex polygon `subject` by convex polygon `clip` (both CCW) — Sutherland–Hodgman. */
function clipConvex(subject: Vec2[], clip: Vec2[]): Vec2[] {
  let output = subject;
  for (let i = 0; i < clip.length && output.length > 0; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const inside = (p: Vec2): boolean =>
      (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= 0;
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j];
      const prev = input[(j + input.length - 1) % input.length];
      const curIn = inside(cur);
      const prevIn = inside(prev);
      if (curIn) {
        if (!prevIn) output.push(lineIntersect(prev, cur, a, b));
        output.push(cur);
      } else if (prevIn) {
        output.push(lineIntersect(prev, cur, a, b));
      }
    }
  }
  return output;
}

/** Exact overlap area of two (possibly concave) polygons, via triangulation + clipping. */
function polygonOverlapArea(a: Vec2[], b: Vec2[]): number {
  let area = 0;
  for (const t1 of triangulate(a)) {
    for (const t2 of triangulate(b)) {
      const clipped = clipConvex(t1.slice(), t2);
      if (clipped.length >= 3) area += Math.abs(signedArea(clipped));
    }
  }
  return area;
}

/**
 * Overlapping-piece warnings. Resolves the layout, then assigns every resolved
 * piece a "collision group" keyed by the logical area it belongs to — an area and
 * everything anchored to it (its parented features + its template's composed
 * features), with linked areas (shared `link_group`) folded into one group. Pairs
 * within a group are expected to overlap and are skipped:
 *   - a ruin sits on its own baseplate (same area), and
 *   - two linked baseplates interlock as one piece, so a ruin on one legitimately
 *     spans onto its partner (the Take-and-Hold centre trapezoid pair).
 * Every other pair with a real overlap area is flagged. Returns [] if the layout
 * can't resolve mid-edit.
 */
function collisionWarnings(layout: EditLayout): LayoutWarning[] {
  let resolved: ResolvedPiece[];
  try {
    resolved = resolve(layout);
  } catch {
    return [];
  }
  const pieces = layout.pieces ?? [];

  // The governing-area id of each resolved piece: itself for a top-level piece,
  // the parent for a parented feature, the templated area for a composed feature.
  // Walk the resolver's emission contract (mirrored from keystones.ts): one slot
  // per layout piece, plus a templated unparented piece's composed features after.
  const linkByPieceId = new Map<string, string>();
  for (const p of pieces) if (p.id && p.link_group) linkByPieceId.set(p.id, p.link_group);
  const governingArea: (string | null)[] = new Array(resolved.length).fill(null);
  // Elevated walkways (catwalk/gantry) overhang the areas below them, so their
  // plan-view footprint legitimately spills onto ground pieces — they never
  // collide-warn. Marked by an elevated-only template: `ground_accessible: false`
  // WITH an `upper_floor` (which excludes a solid ground obstacle like a generator).
  const overhang: boolean[] = new Array(resolved.length).fill(false);
  let cursor = 0;
  for (const p of pieces) {
    const self = cursor;
    cursor += 1;
    overhang[self] = isOverhangFeature(p.template);
    if (p.parent_area_id) {
      governingArea[self] = p.parent_area_id;
    } else {
      governingArea[self] = p.id ?? `#${self}`;
      const fcount = p.template ? templateById(p.template)?.features?.length ?? 0 : 0;
      for (let f = 1; f <= fcount; f++) governingArea[self + f] = p.id ?? `#${self}`;
    }
  }
  // Pieces sharing a group key never collide-warn against each other.
  const groupKey = (i: number): string => {
    const aid = governingArea[i];
    const link = aid ? linkByPieceId.get(aid) : undefined;
    return link ? `lg:${link}` : `a:${aid ?? i}`;
  };

  const out: LayoutWarning[] = [];
  for (let a = 0; a < resolved.length; a++) {
    for (let b = a + 1; b < resolved.length; b++) {
      if (groupKey(a) === groupKey(b)) continue;
      if (overhang[a] || overhang[b]) continue; // catwalk/gantry overhang — not a collision
      const pa = resolved[a];
      const pb = resolved[b];
      if (!bboxOverlap(pa.vertices, pb.vertices)) continue;
      const overlap = polygonOverlapArea(pa.vertices, pb.vertices);
      if (overlap > COLLISION_MIN_AREA) {
        out.push({
          kind: "collision",
          message: `${pieceLabel(pa)} overlaps ${pieceLabel(pb)} (${round2(overlap)} in²)`,
          pieceIds: [pa.id, pb.id],
        });
      }
    }
  }
  return out;
}

/** Non-round keystone warnings: every derived distance that isn't a clean ¼″ mark. */
function keystoneRoundnessWarnings(layout: EditLayout): LayoutWarning[] {
  const out: LayoutWarning[] = [];
  for (const d of keystoneDisplays(layout)) {
    if (d.distance == null || isRoundKeystone(d.distance)) continue;
    const target = nearestIncrement(d.distance);
    out.push({
      kind: "keystone-not-round",
      message: `${d.keystone.edge} keystone ${round2(d.distance)}″ (nearest ¼″ is ${round2(target)}″)`,
      pieceIds: [d.pieceId],
    });
  }
  return out;
}

/**
 * Every "needs review" warning for a layout: overlapping pieces first, then
 * off-grid keystones. Symmetric twins produce the same warning on both board
 * halves, so identical messages are collapsed (their piece ids merged for the
 * board highlight). Pure and cheap; components call it in a `$derived`.
 */
export function layoutWarnings(layout: EditLayout): LayoutWarning[] {
  const raw = [...collisionWarnings(layout), ...keystoneRoundnessWarnings(layout)];
  const byMessage = new Map<string, LayoutWarning>();
  for (const w of raw) {
    const key = `${w.kind}|${w.message}`;
    const seen = byMessage.get(key);
    if (seen) {
      for (const id of w.pieceIds) if (!seen.pieceIds.includes(id)) seen.pieceIds.push(id);
    } else {
      byMessage.set(key, { ...w, pieceIds: [...w.pieceIds] });
    }
  }
  return [...byMessage.values()];
}

/** Warnings for an embedded (library) layout by id. Memoized — the dataset is
 *  immutable for the life of the build (same contract as {@link resolveEmbedded}). */
const warningCache = new Map<string, LayoutWarning[]>();
export function layoutWarningsFor(layoutId: string): LayoutWarning[] {
  const hit = warningCache.get(layoutId);
  if (hit) return hit;
  const raw = ds.terrainLayouts.get(layoutId) as unknown as EditLayout | undefined;
  const warnings = raw ? layoutWarnings(raw) : [];
  warningCache.set(layoutId, warnings);
  return warnings;
}

export type ObjectiveRole = "home" | "expansion" | "center";

/** Every piece that forms the same objective as `p`: its link_group union, else just itself — each with its twin. */
function objectiveUnion(layout: EditLayout, p: EditPiece): EditPiece[] {
  const base = p.link_group
    ? layout.pieces.filter((q) => q.link_group === p.link_group)
    : [p];
  const set = new Set<EditPiece>();
  for (const m of base) {
    set.add(m);
    const t = twinOf(layout, m);
    if (t) set.add(t);
  }
  return [...set];
}

/**
 * Mark a terrain area's objective role (home/expansion/center), applied across
 * its symmetry twin and its whole link_group union — linked areas are one area
 * "slotted like puzzle pieces", so the union reads as a single objective. A role
 * implies `is_objective`; clearing it drops the flag.
 */
export function setObjectiveRole(layout: EditLayout, id: string, role: ObjectiveRole | undefined): void {
  const p = byId(layout, id);
  if (!p) return;
  for (const m of objectiveUnion(layout, p)) {
    m.objective_role = role || undefined;
    m.is_objective = role ? true : undefined;
  }
}

export interface ObjectiveMarker {
  /** Board-space centre of the objective (the union's centroid). */
  at: Vec2;
  role?: ObjectiveRole;
}

/**
 * One marker per objective: pieces flagged `is_objective` grouped by link_group
 * (unlinked pieces stand alone), placed at the union's board centroid. Lets the
 * board draw a single marker for a puzzle-piece union.
 */
export function objectiveMarkers(layout: EditLayout): ObjectiveMarker[] {
  const groups = new Map<string, EditPiece[]>();
  for (const p of layout.pieces) {
    if (!p.is_objective) continue;
    const key = p.link_group ? `g:${p.link_group}` : `p:${p.id}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
  }
  const out: ObjectiveMarker[] = [];
  for (const members of groups.values()) {
    const cs = members.map((m) => boardCentroid(layout, m));
    const at = {
      x: cs.reduce((s, c) => s + c.x, 0) / cs.length,
      y: cs.reduce((s, c) => s + c.y, 0) / cs.length,
    };
    out.push({ at, role: members.find((m) => m.objective_role)?.objective_role });
  }
  return out;
}

/** Delete a piece and its twin, re-baking any features parented to them into board space. */
export function deletePiece(layout: EditLayout, id: string): void {
  const p = byId(layout, id);
  if (!p) return;
  const removed = new Set([id, p.twin_id].filter((x): x is string => !!x));
  // Detach children so no piece is left with a dangling parent_area_id.
  for (const q of layout.pieces) {
    if (q.parent_area_id && removed.has(q.parent_area_id)) {
      q.position = boardCentroid(layout, q);
      q.parent_area_id = undefined;
    }
  }
  layout.pieces = layout.pieces.filter((q) => !removed.has(q.id));
}

/**
 * Pair up pieces that are 180°-rotational twins, matching on point-reflected
 * centroid (within tolerance) + same template. We deliberately do NOT gate on
 * rotation/mirror: migrated layouts are point-symmetric in position but often
 * store asymmetric pieces at the same angle on both sides rather than θ+180.
 * Pairing leaves the loaded orientation untouched; the twin-aware setters enforce
 * the +180 convention on the first orientation edit (cleaning up the scaffold).
 * A piece sitting on the board centre is self-symmetric and stays unpaired.
 */
export function autoPairTwins(pieces: EditPiece[], board: BoardDims = DEFAULT_BOARD): void {
  const POS_TOL = 0.75;
  // Pass 1: board-space pieces (areas + unparented features) by point reflection.
  for (const p of pieces) {
    if (p.twin_id || p.parent_area_id || isBoardCentre(p.position, board)) continue;
    const want = twinPosition(p.position, board);
    const match = pieces.find(
      (q) =>
        q.id !== p.id &&
        !q.twin_id &&
        !q.parent_area_id &&
        q.template === p.template &&
        Math.hypot(q.position.x - want.x, q.position.y - want.y) <= POS_TOL,
    );
    if (match) {
      p.twin_id = match.id;
      match.twin_id = p.id;
    }
  }
  // Pass 2: parented features. Their twin is parented to the *area's* twin at the
  // identical area-local position, so we match on (parent's twin, local centroid).
  const local = new Map(pieces.map((p) => [p.id, p]));
  for (const p of pieces) {
    if (p.twin_id || !p.parent_area_id) continue;
    const parentTwinId = local.get(p.parent_area_id)?.twin_id;
    if (!parentTwinId) continue;
    const match = pieces.find(
      (q) =>
        q.id !== p.id &&
        !q.twin_id &&
        q.parent_area_id === parentTwinId &&
        q.template === p.template &&
        Math.hypot(q.position.x - p.position.x, q.position.y - p.position.y) <= POS_TOL,
    );
    if (match) {
      p.twin_id = match.id;
      match.twin_id = p.id;
    }
  }
}

/** Re-establish pairing across the whole layout (used when symmetry is toggled on). */
export function repairTwins(layout: EditLayout): void {
  for (const p of layout.pieces) p.twin_id = undefined;
  autoPairTwins(layout.pieces, boardOf(layout));
}

/** Drop all pairing, leaving every piece independent (used when symmetry is toggled off). */
export function unpairTwins(layout: EditLayout): void {
  for (const p of layout.pieces) p.twin_id = undefined;
}

/** A blank layout. */
export function blankLayout(): EditLayout {
  counter = 0;
  return {
    id: "untitled-layout",
    name: "Untitled Layout",
    source: "custom",
    board: { ...DEFAULT_BOARD },
    pieces: [],
  };
}

/** Kebab-case entity id from a title, matching the `entity-id` convention
 *  (`^[a-z0-9][a-z0-9-]*[a-z0-9]$`). Empty titles fall back to a stable slug. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled-layout";
}

/** Rename the working layout, keeping its `id` a slug of the title so the
 *  canonical export id and download filename track the title the author sees. */
export function renameLayout(layout: EditLayout, name: string): void {
  layout.name = name;
  layout.id = slugify(name);
}

/** Deep-clone an embedded layout into the editable model, pairing symmetric twins. */
export function loadEmbedded(id: string, symmetric = true): EditLayout | undefined {
  const raw = ds.terrainLayouts.get(id) as TerrainLayout | undefined;
  if (!raw) return undefined;
  counter = 0;
  const pieces: EditPiece[] = (raw.pieces ?? []).map((p, i) => ({
    id: p.id ?? `piece-${i + 1}`,
    name: p.name,
    piece_type: (p.piece_type ?? "area") as "area" | "feature",
    terrain: (p as { terrain?: boolean }).terrain,
    template: p.template,
    footprint: p.footprint,
    position: { x: p.position.x, y: p.position.y },
    rotation_degrees: p.rotation_degrees ?? 0,
    mirror: (p.mirror ?? "none") as Mirror,
    parent_area_id: p.parent_area_id,
    floor: p.floor,
    height_inches: p.height_inches,
    link_group: p.link_group,
    objective_role: p.objective_role,
    is_objective: p.is_objective,
    objective: p.objective,
    keystones: p.keystones as EditKeystone[] | undefined,
  }));
  const board = raw.board ? { width: raw.board.width, height: raw.board.height } : undefined;
  if (symmetric) autoPairTwins(pieces, board ?? DEFAULT_BOARD);
  return {
    id: raw.id,
    name: raw.name,
    source: raw.source,
    description: raw.description,
    mission_matchup_id: raw.mission_matchup_id,
    variant: raw.variant,
    deployment_pattern_id: raw.deployment_pattern_id,
    board,
    pieces,
  };
}

const round = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Canonical `terrain-layout` JSON for the working layout (drops editor defaults + twin_id). */
export function toCanonicalJson(layout: EditLayout): unknown {
  return [
    {
      id: layout.id,
      name: layout.name,
      ...(layout.source ? { source: layout.source } : {}),
      ...(layout.description ? { description: layout.description } : {}),
      ...(layout.mission_matchup_id ? { mission_matchup_id: layout.mission_matchup_id } : {}),
      ...(layout.variant ? { variant: layout.variant } : {}),
      ...(layout.deployment_pattern_id ? { deployment_pattern_id: layout.deployment_pattern_id } : {}),
      ...(layout.board && (layout.board.width !== DEFAULT_BOARD.width || layout.board.height !== DEFAULT_BOARD.height)
        ? { board: { width: layout.board.width, height: layout.board.height } }
        : {}),
      pieces: layout.pieces.map((p) => ({
        id: p.id,
        ...(p.name ? { name: p.name } : {}),
        piece_type: p.piece_type,
        ...(p.terrain === false ? { terrain: false } : {}),
        ...(p.template ? { template: p.template } : {}),
        ...(p.footprint ? { footprint: p.footprint } : {}),
        position: { x: round(p.position.x), y: round(p.position.y) },
        ...(p.rotation_degrees ? { rotation_degrees: round(p.rotation_degrees) } : {}),
        ...(p.mirror !== "none" ? { mirror: p.mirror } : {}),
        ...(p.parent_area_id ? { parent_area_id: p.parent_area_id } : {}),
        ...(p.floor ? { floor: p.floor } : {}),
        ...(p.height_inches ? { height_inches: round(p.height_inches) } : {}),
        ...(p.link_group ? { link_group: p.link_group } : {}),
        ...(p.objective_role ? { objective_role: p.objective_role } : {}),
        ...(p.is_objective ? { is_objective: true } : {}),
        ...(p.objective ? { objective: p.objective } : {}),
        ...(p.keystones?.length ? { keystones: p.keystones } : {}),
      })),
      game_version: { edition: "11th", dataslate: "pre-launch-provisional" },
    },
  ];
}

// Re-exports the inspector's solver panel and on-canvas affordances lean on.
export {
  solveCentroid,
  solveCentroidTriangulated,
  solveCentroidAttached,
  solveCentroidAgainstFixed,
  footprintVertices,
  orientedOffsets,
  polygonCentroid,
};
export type { SolveInput, AttachInput, SolveAgainstFixedInput };
