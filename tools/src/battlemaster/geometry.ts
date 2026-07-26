/**
 * Battlemaster → 40kdc frame conversion.
 *
 * Two frames meet here and every field of both was pinned empirically against the
 * snapshot before this was written (see `calibrate.ts` for the assertions that keep
 * it honest):
 *
 * | | Battlemaster | 40kdc |
 * |---|---|---|
 * | origin | board / composite **centre** | board **corner**, area **centroid** |
 * | y axis | **up** | **down** |
 * | rotation | **counter-clockwise** (y-up) | clockwise (y-down) |
 * | part anchor | the part's local **min corner** | the piece **centroid** |
 * | piece anchor | the template's artwork **bbox centre** | the nubbed **area centroid** |
 *
 * The last row is the whole "nub" story and the reason 196 of 720 committed
 * placements are wrong: 40kdc footprints are nubbed die-cut outlines whose polygon
 * area centroid sits off the artwork's bbox centre, by inches for an asymmetric
 * shape. `centroidToBoundsCentre` (in `repo.ts`) measures that offset and
 * {@link areaPositionFromInstance} applies it through the piece's own orientation.
 *
 * A y-flip turns counter-clockwise into clockwise, so a Battlemaster rotation is
 * *numerically* reusable as a 40kdc `rotation_degrees` once the per-template
 * orientation offset is added — but only because the flip and the handedness change
 * cancel. Do not "simplify" that away.
 */
import type { Footprint, Mirror, Vec2 } from "../terrain/resolve.js";
import { footprintVertices } from "../terrain/resolve.js";
import type { BmInstance, BmTemplate, BmTemplateCatalog } from "./source.js";
import { BOARD, centroidToBoundsCentre, norm360, toBoardFrame } from "./repo.js";

const DEG = Math.PI / 180;

/** Clockwise rotation in the y-down frame — the resolver's convention. */
export function rotateCw(v: Vec2, deg: number): Vec2 {
  if (deg === 0) return { x: v.x, y: v.y };
  const r = deg * DEG;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: c * v.x - s * v.y, y: s * v.x + c * v.y };
}

export function applyMirror(v: Vec2, m: Mirror): Vec2 {
  if (m === "horizontal") return { x: -v.x, y: v.y };
  if (m === "vertical") return { x: v.x, y: -v.y };
  return v;
}

/** mirror → rotate, no translation. Matches the resolver's `orient`. */
export function orient(v: Vec2, rotation: number, mirror: Mirror): Vec2 {
  return rotateCw(applyMirror(v, mirror), rotation);
}

/** Axis-aligned bounds of a point set. */
export function boundsOf(pts: Vec2[]): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/**
 * A part's bbox centre inside its composite's local frame, still **y-up**.
 *
 * The part is a `width × height` rectangle whose local origin is `(0,0)`; the
 * catalog gives that origin's position, and rotation is about it, counter-clockwise.
 * Verified against the catalog: recomputing every part this way puts all of them
 * inside their composite's declared bounding box, and the clockwise reading does not.
 */
export function partCentreYUp(
  width: number,
  height: number,
  px: number,
  py: number,
  rotation: number,
  mirror: number,
): Vec2 {
  let verts: Vec2[] = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  if (mirror) verts = verts.map((v) => ({ x: -v.x, y: v.y }));
  const r = rotation * DEG;
  const c = Math.cos(r);
  const s = Math.sin(r);
  // Counter-clockwise in the y-up frame.
  verts = verts.map((v) => ({ x: c * v.x - s * v.y, y: s * v.x + c * v.y }));
  verts = verts.map((v) => ({ x: v.x + px, y: v.y + py }));
  const b = boundsOf(verts);
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

/**
 * A part's centre expressed in its parent area's **centroid-local, y-down** frame —
 * exactly what a 40kdc child piece's `position` means.
 *
 * `offset` is the parent area template's orientation offset (see `calibrate.ts`):
 * the rotation carrying the Battlemaster artwork's natural orientation onto the
 * 40kdc footprint's. `anchorDelta` re-anchors from the artwork bbox centre to the
 * nubbed footprint's centroid.
 */
export function partPositionInArea(
  catalog: BmTemplateCatalog,
  template: BmTemplate,
  partIndex: number,
  offset: number,
  anchorDelta: Vec2,
): Vec2 {
  const p = template.parts[partIndex]!;
  const part = catalog.parts[p.partIndex]!;
  const cUp = partCentreYUp(part.width, part.height, p.x, p.y, p.rotation, p.mirror);
  const rotated = rotateCw({ x: cUp.x, y: -cUp.y }, offset);
  return { x: rotated.x + anchorDelta.x, y: rotated.y + anchorDelta.y };
}

/**
 * A part's own `rotation_degrees` in the parent area's frame. The part rotation and
 * the template offset compose additively once both are read in the same handedness.
 */
export function partRotation(template: BmTemplate, partIndex: number, offset: number): number {
  return norm360(template.parts[partIndex]!.rotation + offset);
}

/**
 * The 40kdc `position` (the piece **centroid**, in board inches, y-down) for a
 * placed Battlemaster composite.
 *
 * Battlemaster's `(x, y)` locates the artwork bbox centre; 40kdc's `position`
 * locates the nubbed footprint's area centroid. The two differ by
 * `centroidToBoundsCentre(footprint)` measured in the footprint's own local frame,
 * so it must be carried through the piece's orientation before being subtracted —
 * hence `orient(...)`, not a bare vector add. Same compensation shape as
 * `ingest-terrain-footprints.ts` uses when a footprint is re-authored.
 */
export function areaPositionFromInstance(
  inst: BmInstance,
  footprint: Footprint,
  rotation: number,
  mirror: Mirror,
): Vec2 {
  const raw = toBoardFrame(inst.x, inst.y);
  const delta = centroidToBoundsCentre(footprint);
  const carried = orient(delta, rotation, mirror);
  return { x: raw.x - carried.x, y: raw.y - carried.y };
}

/** The 40kdc `rotation_degrees` for a placed composite. */
export function areaRotationFromInstance(inst: BmInstance, offset: number): number {
  return norm360(inst.rotation + offset);
}

/** True when `pt` is inside the polygon (ray casting; boundary is unspecified). */
export function pointInPolygon(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** A footprint's vertices recentred on their polygon area centroid. */
export function centroidLocalPolygon(fp: Footprint): Vec2[] {
  const verts = footprintVertices(fp);
  const b = centroidToBoundsCentre(fp);
  const bounds = boundsOf(verts);
  // centroid = bboxCentre - centroidToBoundsCentre
  const cx = (bounds.minX + bounds.maxX) / 2 - b.x;
  const cy = (bounds.minY + bounds.maxY) / 2 - b.y;
  return verts.map((v) => ({ x: v.x - cx, y: v.y - cy }));
}

/**
 * Optimal one-to-one assignment between two equal-length point lists, minimising
 * total distance. Brute force over permutations — the lists are per (layout, area
 * template) and never exceed 4 in this dataset, so an exact solve is cheaper than a
 * Hungarian implementation and cannot mis-assign.
 *
 * Greedy nearest-neighbour is *not* good enough here: the placements that most need
 * correcting are off by 1-6", where greedy readily steals the wrong partner.
 */
export function optimalAssignment(from: Vec2[], to: Vec2[]): number[] {
  const n = from.length;
  if (n !== to.length) throw new Error(`assignment needs equal lengths, got ${n} and ${to.length}`);
  if (n === 0) return [];
  if (n > 8) throw new Error(`assignment group too large to solve exactly (${n})`);
  const idx = Array.from({ length: n }, (_, i) => i);
  let best: { cost: number; perm: number[] } | null = null;
  const permute = (rest: number[], acc: number[]): void => {
    if (rest.length === 0) {
      let cost = 0;
      for (let i = 0; i < n; i++) cost += Math.hypot(from[i]!.x - to[acc[i]!]!.x, from[i]!.y - to[acc[i]!]!.y);
      if (!best || cost < best.cost) best = { cost, perm: [...acc] };
      return;
    }
    for (let i = 0; i < rest.length; i++) {
      permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]!]);
    }
  };
  permute(idx, []);
  return best!.perm;
}

/** Every resolved vertex of a layout must sit on the board. */
export function offBoard(v: Vec2, slack = 0.5): boolean {
  return v.x < -slack || v.y < -slack || v.x > BOARD.width + slack || v.y > BOARD.height + slack;
}
