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
// Type-only circular dependency (sets.ts imports Vec2/Mirror back): erased at compile.
import type { TerrainSetDef } from "./sets.js";

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

function mirrorVec(v: Vec2, m: Mirror): Vec2 {
  if (m === "horizontal") return { x: -v.x, y: v.y };
  if (m === "vertical") return { x: v.x, y: -v.y };
  return v;
}
function rotateCw(v: Vec2, deg: number): Vec2 {
  if (!deg) return v;
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: c * v.x - s * v.y, y: s * v.x + c * v.y };
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
/** Clamp a board-space point to the table (2-dp), so pieces can't leave the map. */
function clampToBoard(p: Vec2, board: BoardDims = DEFAULT_BOARD): Vec2 {
  const c = (n: number, hi: number): number => Math.max(0, Math.min(hi, Math.round(n * 100) / 100));
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

const round2 = (n: number): number => Math.round(n * 100) / 100;
const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;

export function twinPosition(p: Vec2, board: BoardDims = DEFAULT_BOARD): Vec2 {
  return { x: round2(board.width - p.x), y: round2(board.height - p.y) };
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
function freshId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function makePiece(template: TerrainTemplate, position: Vec2): EditPiece {
  return {
    id: freshId(template.id),
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
  );
  layout.pieces.push(primary);
  if (symmetric && !isBoardCentre(primary.position, b)) {
    const twin = makePiece(template, twinPosition(primary.position, b));
    twin.rotation_degrees = twinRotation(primary.rotation_degrees);
    twin.mirror = primary.mirror;
    primary.twin_id = twin.id;
    twin.twin_id = primary.id;
    layout.pieces.push(twin);
  }
  return primary;
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
  );
  if (set.area.rotation) area.rotation_degrees = norm360(set.area.rotation);
  layout.pieces.push(area);

  let areaTwin: EditPiece | undefined;
  if (symmetric && !isBoardCentre(area.position, b)) {
    areaTwin = makePiece(areaTmpl, twinPosition(area.position, b));
    areaTwin.rotation_degrees = twinRotation(area.rotation_degrees);
    areaTwin.mirror = area.mirror;
    area.twin_id = areaTwin.id;
    areaTwin.twin_id = area.id;
    layout.pieces.push(areaTwin);
  }

  for (const f of set.features) {
    const ft = templateById(f.template);
    if (!ft) continue;
    const feat = makePiece(ft, { x: f.position.x, y: f.position.y });
    feat.rotation_degrees = norm360(f.rotation);
    feat.mirror = f.mirror ?? "none";
    feat.parent_area_id = area.id;
    layout.pieces.push(feat);
    if (areaTwin) {
      const featTwin = makePiece(ft, { x: f.position.x, y: f.position.y });
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
  const a = makePiece(tmpl, pos);
  a.rotation_degrees = rot;
  a.mirror = "horizontal";
  const b = makePiece(tmpl, twinPosition(pos));
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
  if (patch.rotation_degrees !== undefined) p.rotation_degrees = norm360(patch.rotation_degrees);
  if (patch.mirror !== undefined) p.mirror = patch.mirror;
  const t = twinOf(layout, p);
  if (!t) return;
  const parented = !!parentAreaOf(layout, p);
  if (patch.rotation_degrees !== undefined) {
    t.rotation_degrees = parented ? p.rotation_degrees : twinRotation(patch.rotation_degrees);
  }
  if (patch.mirror !== undefined) t.mirror = patch.mirror;
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

/** Snap a parented feature's centroid to the area's centroid (area-local {0,0}). */
export function snapToAreaCenter(layout: EditLayout, id: string): void {
  const p = byId(layout, id);
  if (!p || !p.parent_area_id) return;
  p.position = { x: 0, y: 0 };
  const t = twinOf(layout, p);
  if (t) t.position = { x: 0, y: 0 };
}

/**
 * Snap a parented feature so its nearest vertex aligns with the nearest corner of
 * the parent area. Template-agnostic: the feature is already approximately placed,
 * so the closest (featureVert, areaCorner) pair is always the intended one.
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

/** Card measurements are clean quarter-inch increments; anything off by more than
 *  this (in inches) is treated as a data-entry rounding error worth reviewing. */
const KEYSTONE_INCREMENT = 0.25;
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
  let cursor = 0;
  for (const p of pieces) {
    const self = cursor;
    cursor += 1;
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
