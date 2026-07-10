/**
 * Geometry derivation for the read-only terrain-layout card (LayoutDiagram).
 *
 * Turns a canonical `terrain-layout` entity into everything the card draws:
 * resolved piece polygons (via the package's pinned resolver), deployment
 * zones and the territory divider for the layout's deployment pattern,
 * objective markers, and keystone dimension guides with distances derived by
 * the package's pinned `keystoneMeasurements`.
 *
 * The layout-editor keeps its own richer derivations in `lib/model.ts`
 * (selection, twins, editable pieces); this module is the consumer-side
 * subset shared by the example apps, working straight off the package types.
 */
import {
  keystoneMeasurements,
  type Dataset,
  type ResolvedPiece,
  type TerrainLayout,
} from "@alpaca-software/40kdc-data";

export interface Vec2 {
  x: number;
  y: number;
}

export const BOARD = { width: 60, height: 44 } as const;

export interface DiagramZone {
  player: string;
  color?: string;
  points: Vec2[];
}

export interface DiagramDivider {
  from: Vec2;
  to: Vec2;
  badges: { at: Vec2; player: string; color: string }[];
}

export interface DiagramMarker {
  at: Vec2;
  role?: string;
}

/** One keystone dimension line, ready to draw: edge anchor → feature point. */
export interface DiagramGuide {
  from: Vec2;
  to: Vec2;
  mid: Vec2;
  /** Display distance, rounded to 2 dp. */
  text: string;
  /**
   * Label rotation (degrees, display frame, about the label anchor): turns the
   * text to face the player whose board half holds the owning piece. Always
   * axis-aligned (0/±90/180) — the split is top/bottom or left/right, never
   * the deployment diagonal. 0 when player-facing is off or the layout has no
   * territory divider.
   */
  facingAngle: number;
}

export interface DiagramModel {
  pieces: ResolvedPiece[];
  /** Maps layout piece id → terrain_category ("dense" | "light" | "exposed"). */
  pieceCategories: Map<string, string>;
  zones: DiagramZone[];
  divider: DiagramDivider | null;
  markers: DiagramMarker[];
  guides: DiagramGuide[];
}

interface RawShape {
  type: string;
  width?: number;
  height?: number;
  points?: Vec2[];
}
interface RawRegion {
  player: string;
  color?: string;
  shape: RawShape;
  position: Vec2;
}

function shapeToPoints(shape: RawShape, pos: Vec2): Vec2[] {
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

function regions(ds: Dataset, patternId: string | undefined, key: "zones" | "territories"): DiagramZone[] {
  if (!patternId) return [];
  const p = ds.deploymentPatterns.get(patternId) as
    | { zones?: RawRegion[]; territories?: RawRegion[] }
    | undefined;
  return (p?.[key] ?? []).map((z) => ({
    player: z.player,
    color: z.color,
    points: shapeToPoints(z.shape, z.position),
  }));
}

const polyMean = (pts: Vec2[]): Vec2 => ({
  x: pts.reduce((s, p) => s + p.x, 0) / (pts.length || 1),
  y: pts.reduce((s, p) => s + p.y, 0) / (pts.length || 1),
});

/**
 * The territory divider from the pattern's explicit territories: the two
 * vertices the defender and attacker polygons share are the line's endpoints,
 * each end badged D/A on its own side. Null when territories are absent.
 */
function territoryDivider(ds: Dataset, patternId: string | undefined): DiagramDivider | null {
  const territories = regions(ds, patternId, "territories");
  const defT = territories.find((z) => z.player === "defender");
  const atkT = territories.find((z) => z.player === "attacker");
  if (!defT || !atkT) return null;
  const EPS = 0.01;
  const shared = defT.points.filter((d) =>
    atkT.points.some((a) => Math.hypot(a.x - d.x, a.y - d.y) < EPS),
  );
  if (shared.length < 2) return null;
  const from = shared[0]!;
  const to = shared[shared.length - 1]!;
  const u = { x: to.x - from.x, y: to.y - from.y };
  const len = Math.hypot(u.x, u.y) || 1;
  const nrm = { x: -u.y / len, y: u.x / len };
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const cD = polyMean(defT.points);
  const sideD = nrm.x * (cD.x - mid.x) + nrm.y * (cD.y - mid.y);
  const defDir = sideD >= 0 ? nrm : { x: -nrm.x, y: -nrm.y };
  const atkDir = { x: -defDir.x, y: -defDir.y };
  const OFF = 3;
  const badges = [from, to].flatMap((e) => [
    { at: { x: e.x + defDir.x * OFF, y: e.y + defDir.y * OFF }, player: "D", color: defT.color ?? "#3b82f6" },
    { at: { x: e.x + atkDir.x * OFF, y: e.y + atkDir.y * OFF }, player: "A", color: atkT.color ?? "#ef4444" },
  ]);
  return { from, to, badges };
}

type RawPiece = NonNullable<TerrainLayout["pieces"]>[number];

/** Objective markers: objective pieces grouped by link_group (one marker per group). */
function objectiveMarkers(layout: TerrainLayout): DiagramMarker[] {
  const groups = new Map<string, RawPiece[]>();
  (layout.pieces ?? []).forEach((p, i) => {
    if (!p.is_objective && !p.objective_role) return;
    const key = p.link_group ? `g:${p.link_group}` : `p:${p.id ?? i}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
  });
  const out: DiagramMarker[] = [];
  for (const members of groups.values()) {
    const anchors = members.map(
      (m) => (m.objective?.position ?? m.position) as Vec2,
    );
    out.push({
      at: polyMean(anchors),
      role: members.find((m) => m.objective_role)?.objective_role,
    });
  }
  return out;
}

/**
 * Map each `layout.pieces` index to its resolved piece, walking the
 * resolver's emission contract (one entry per explicit piece, an unparented
 * templated area followed by its template's composed features).
 */
function resolvedByPieceIndex(ds: Dataset, layout: TerrainLayout, resolved: ResolvedPiece[]): Map<number, ResolvedPiece> {
  const featureCount = new Map(
    ds.terrainTemplates.all.map((t) => [t.id, (t as { features?: unknown[] }).features?.length ?? 0]),
  );
  const out = new Map<number, ResolvedPiece>();
  let cursor = 0;
  (layout.pieces ?? []).forEach((p, i) => {
    const rp = resolved[cursor];
    if (rp) out.set(i, rp);
    cursor += 1;
    if (!p.parent_area_id && p.template) cursor += featureCount.get(p.template) ?? 0;
  });
  return out;
}

const round2 = (n: number): string => String(Math.round(n * 100) / 100);

/** Board (x,y) → display, matching the card's translate(44,0) rotate(90). */
const toDisplay = (b: Vec2): Vec2 => ({ x: BOARD.height - b.y, y: b.x });

/**
 * Rotation (degrees, display frame) that turns a keystone label to face the
 * player whose board half holds `centroidBoard`. The divider is snapped to
 * its dominant axis, so the split is always a plain top/bottom or left/right
 * halving of the board — diagonal deployments (Crucible of Battle, Search
 * and Destroy) read like their nearest orthogonal cousin instead of tilting
 * labels to match the diagonal. Returns exactly 0, ±90, or 180; 0 when the
 * divider is degenerate.
 */
export function facingAngle(divider: { from: Vec2; to: Vec2 }, centroidBoard: Vec2): number {
  const a = toDisplay(divider.from);
  const b = toDisplay(divider.to);
  const u = { x: b.x - a.x, y: b.y - a.y };
  if (Math.hypot(u.x, u.y) < 1e-6) return 0;
  // Side test against the snapped axis line through the divider midpoint
  // (the board centre for every current pattern). Descenders point toward
  // the reading player's table edge: SVG rotate(a) sends local-down (0,1)
  // to (−sin a, cos a), so up→180, down→0, left→90, right→−90.
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const c = toDisplay(centroidBoard);
  if (Math.abs(u.x) >= Math.abs(u.y)) return c.y < mid.y ? 180 : 0; // horizontal divider → top/bottom split
  return c.x < mid.x ? 90 : -90; // vertical divider → left/right split
}

/** Everything the LayoutDiagram draws for one layout entity. */
export function diagramModel(
  ds: Dataset,
  layout: TerrainLayout,
  opts?: { playerFacing?: boolean },
): DiagramModel {
  const pieces = ds.resolveTerrain(layout);
  const byIndex = resolvedByPieceIndex(ds, layout, pieces);
  const divider = territoryDivider(ds, layout.deployment_pattern_id);

  const guides: DiagramGuide[] = [];
  let measurements: ReturnType<typeof keystoneMeasurements> = [];
  try {
    measurements = keystoneMeasurements(
      layout as Parameters<typeof keystoneMeasurements>[0],
      ds.terrainTemplates.all as unknown as Parameters<typeof keystoneMeasurements>[1],
      layout.board,
    );
  } catch {
    // A stale keystone (re-authored footprint) must not take the card down;
    // the diagram simply renders without dimension lines.
    measurements = [];
  }
  for (const m of measurements) {
    const rp = byIndex.get(m.piece_index);
    if (!rp) continue;
    const onX = m.edge === "left" || m.edge === "right";
    const coord = (v: Vec2): number => (onX ? v.x : v.y);
    let to: Vec2;
    if (m.ref.kind === "vertex") {
      const v = rp.vertices[m.ref.index];
      if (!v) continue;
      to = v;
    } else {
      // Bounding-face anchor: the extreme on the measured axis, at the face's
      // midpoint on the other axis.
      const xs = rp.vertices.map((v) => v.x);
      const ys = rp.vertices.map((v) => v.y);
      const min = m.ref.side.startsWith("min");
      to = onX
        ? { x: min ? Math.min(...xs) : Math.max(...xs), y: (Math.min(...ys) + Math.max(...ys)) / 2 }
        : { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: min ? Math.min(...ys) : Math.max(...ys) };
    }
    const from: Vec2 =
      m.edge === "left"
        ? { x: 0, y: to.y }
        : m.edge === "right"
          ? { x: BOARD.width, y: to.y }
          : m.edge === "top"
            ? { x: to.x, y: 0 }
            : { x: to.x, y: BOARD.height };
    guides.push({
      from,
      to,
      mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
      text: `${round2(m.distance)}″`,
      facingAngle:
        opts?.playerFacing && divider ? facingAngle(divider, polyMean(rp.vertices)) : 0,
    });
  }

  const pieceCategories = new Map<string, string>();
  for (const piece of layout.pieces ?? []) {
    if (!piece.id) continue;
    // An empty area (terrain: false) is not terrain — e.g. a 10th-edition
    // objective marker on open ground. It renders as a ring, not a terrain fill.
    if ((piece as { terrain?: boolean }).terrain === false) {
      pieceCategories.set(piece.id, "empty");
      continue;
    }
    if (!piece.template) continue;
    const tpl = ds.terrainTemplates.get(piece.template) as { terrain_category?: string } | undefined;
    if (tpl?.terrain_category) pieceCategories.set(piece.id, tpl.terrain_category);
  }

  return {
    pieces,
    pieceCategories,
    zones: regions(ds, layout.deployment_pattern_id, "zones"),
    divider,
    markers: objectiveMarkers(layout),
    guides,
  };
}

// Type-only re-export so consumers don't need a second package import.
export type { ResolvedPiece };
