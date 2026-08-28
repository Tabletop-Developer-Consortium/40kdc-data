/**
 * Derive measurement keystones for the Battlemaster Chapter Approved layouts.
 *
 * The 45 `bm-*` layouts ship exact geometry but no keystones, so a reference
 * card has no dimension callouts to print. This tool authors the selection the
 * schema stores (board edge → footprint vertex); the printed distance is always
 * derived by `keystoneMeasurements`, so nothing here can disagree with the
 * layout.
 *
 * Heuristic (the hand-authored KOTC colosseum idiom, extended to rotated
 * pieces): every piece gets an anchor at vertex A — the vertex of the placed
 * outline nearest the piece's nearest board corner (the natural tape-measure
 * target) — measured to its nearest horizontal edge (top/bottom) and nearest
 * vertical edge (left/right), in that order. An axis-aligned piece (rotation
 * a multiple of 90°) is fully placeable from that one corner and stays at two
 * keystones. An obliquely rotated piece gets a SECOND anchor at vertex B, the
 * outline vertex farthest from A (the best lever), with a SINGLE measurement:
 * once A is pinned the piece itself fixes the distance A→B, so one more edge
 * distance pins the rotation (WTC-style three-number dimensioning). B measures
 * PERPENDICULAR to the A→B direction — rotating the piece about A swings B
 * along that perpendicular, so it is the direction the number actually
 * constrains (a measurement along A→B barely changes under rotation and is
 * near-redundant with A's own edge distance). It also lands the two circle
 * intersections the single measurement allows on opposite sides of A, where
 * the card's diagram trivially disambiguates them.
 *
 * `is_objective` pieces are included: in the Battlemaster data they are full
 * terrain composites that HOST an objective marker (the marker sits inside the
 * footprint), so a table crew places them by tape measure like any other
 * piece. Pieces that already carry authored keystones are never overwritten.
 *
 * The Battlemaster boards are 180°-rotationally symmetric, so the derivation
 * is validated by pairing: every terrain piece must have a twin whose centroid
 * reflects onto it, and the twins' derived distances must agree within 0.25″
 * (the same tolerance the layout intake's keystone-pairing check used) — both
 * halves of a printed card measure alike. Any violation fails the run.
 *
 * Usage: npx tsx tools/src/derive-keystones.ts [--write] [--rederive]
 * Dry run prints the per-layout summary; --write persists
 * data/core/terrain-layouts.json. --rederive clears the bm-* layouts'
 * keystones first (for re-runs after a geometry re-import or a heuristic
 * change) — hand-authored layouts like the KOTC colosseum are never touched.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveLayout,
  type Keystone,
  type ResolvedPiece,
  type TerrainLayout,
  type TerrainTemplate,
} from "./terrain/resolve.js";
import { keystoneMeasurements, BOARD_INCHES } from "./terrain/keystones.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LAYOUTS_PATH = join(ROOT, "data", "core", "terrain-layouts.json");
const TEMPLATES_PATH = join(ROOT, "data", "core", "terrain-templates.json");

const PAIR_TOLERANCE_IN = 0.25;
const TWIN_CENTROID_TOLERANCE_IN = 0.5;

function centroid(rp: ResolvedPiece): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const v of rp.vertices) {
    x += v.x;
    y += v.y;
  }
  return { x: x / rp.vertices.length, y: y / rp.vertices.length };
}

/** The two keystones for one anchor vertex: measured to its nearest
 * horizontal and vertical board edges (KOTC ordering). */
function keystonesForVertex(v: { x: number; y: number }, index: number): Keystone[] {
  return [
    {
      edge: v.y < BOARD_INCHES.height / 2 ? "top" : "bottom",
      ref: { kind: "vertex", index },
    },
    {
      edge: v.x < BOARD_INCHES.width / 2 ? "left" : "right",
      ref: { kind: "vertex", index },
    },
  ];
}

/** Whether a piece sits straight on the board (rotation a multiple of 90°) —
 * placeable from a single measured corner. */
export function isAxisAligned(piece: { rotation_degrees?: number }): boolean {
  const r = piece.rotation_degrees ?? 0;
  return ((r % 90) + 90) % 90 === 0;
}

/** The keystones for a placed piece: vertex A nearest the piece's nearest
 * board corner (pins a point) with two edge measurements — plus, for oblique
 * pieces only, one more at vertex B, farthest from A (pins the rotation). */
function deriveForPiece(rp: ResolvedPiece, axisAligned: boolean): Keystone[] {
  const c = centroid(rp);
  const corner = {
    x: c.x < BOARD_INCHES.width / 2 ? 0 : BOARD_INCHES.width,
    y: c.y < BOARD_INCHES.height / 2 ? 0 : BOARD_INCHES.height,
  };
  let aIndex = 0;
  let best = Infinity;
  for (let i = 0; i < rp.vertices.length; i++) {
    const v = rp.vertices[i]!;
    const d = (v.x - corner.x) ** 2 + (v.y - corner.y) ** 2;
    if (d < best - 1e-9) {
      best = d;
      aIndex = i;
    }
  }
  const a = rp.vertices[aIndex]!;
  if (axisAligned) return keystonesForVertex(a, aIndex);
  let bIndex = aIndex;
  let farthest = -Infinity;
  for (let i = 0; i < rp.vertices.length; i++) {
    const v = rp.vertices[i]!;
    const d = (v.x - a.x) ** 2 + (v.y - a.y) ** 2;
    if (d > farthest + 1e-9) {
      farthest = d;
      bIndex = i;
    }
  }
  const b = rp.vertices[bIndex]!;
  // Measure B perpendicular to A→B: rotation about A swings B along that
  // perpendicular, so it is the only direction the number constrains. For a
  // mostly-horizontal pair that means a top/bottom distance (a left/right one
  // would stay ~constant under rotation — near-redundant with A's own
  // measurement). Reflection-stable: point reflection preserves |Δx| and |Δy|.
  const bKeystone: Keystone =
    Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)
      ? {
          edge: b.y < BOARD_INCHES.height / 2 ? "top" : "bottom",
          ref: { kind: "vertex", index: bIndex },
        }
      : {
          edge: b.x < BOARD_INCHES.width / 2 ? "left" : "right",
          ref: { kind: "vertex", index: bIndex },
        };
  return [...keystonesForVertex(a, aIndex), bKeystone];
}

/** Walk the resolver's emission contract: the resolved piece for each explicit
 * layout piece, skipping the composed features an unparented templated piece
 * emits after itself (mirrors `keystoneMeasurements`). */
function explicitResolved(
  layout: TerrainLayout,
  templates: TerrainTemplate[],
): ResolvedPiece[] {
  const resolved = resolveLayout(layout, templates);
  const byTemplate = new Map(templates.map((t) => [t.id, t] as const));
  const pieces = layout.pieces ?? [];
  const out: ResolvedPiece[] = [];
  let cursor = 0;
  for (const piece of pieces) {
    const rp = resolved[cursor];
    if (!rp) throw new Error(`${layout.id}: resolved emission shorter than layout.pieces`);
    out.push(rp);
    cursor += 1;
    if (!piece.parent_area_id && piece.template) {
      cursor += byTemplate.get(piece.template)?.features?.length ?? 0;
    }
  }
  return out;
}

const flipEdge = (e: Keystone["edge"]): Keystone["edge"] =>
  e === "left" ? "right" : e === "right" ? "left" : e === "top" ? "bottom" : "top";

/** A keystone point-reflected onto the twin piece: flipped board edge, anchor
 * vertex resolved geometrically (the reflection must land within 0.25″ of a
 * twin vertex — the editor/audit convention; index arithmetic is unsafe since
 * twins often sit at the same angle rather than θ+180). */
function mirrorOntoTwin(
  k: Keystone,
  primary: ResolvedPiece,
  twin: ResolvedPiece,
): Keystone | null {
  if (k.ref.kind !== "vertex") return null;
  const v = primary.vertices[k.ref.index];
  if (!v) return null;
  const r = { x: BOARD_INCHES.width - v.x, y: BOARD_INCHES.height - v.y };
  let bestIndex = -1;
  let best = Infinity;
  twin.vertices.forEach((w, i) => {
    const d = Math.hypot(w.x - r.x, w.y - r.y);
    if (d < best) {
      best = d;
      bestIndex = i;
    }
  });
  if (bestIndex < 0 || best > 0.25) return null;
  return { edge: flipEdge(k.edge), ref: { kind: "vertex", index: bestIndex } };
}

/** Author keystones in place for every bare terrain piece of the `bm-*`
 * layouts. Each 180°-twin pair is derived ONCE and mirrored onto the twin, so
 * both halves of a card carry point-reflected keystones by construction (the
 * `pairKeystones` audit's invariant). Returns the number of pieces authored. */
export function authorKeystones(
  layouts: TerrainLayout[],
  templates: TerrainTemplate[],
): number {
  let piecesAuthored = 0;
  for (const layout of layouts) {
    if (!layout.id.startsWith("bm-")) continue;
    const pieces = layout.pieces ?? [];
    const resolved = explicitResolved(layout, templates);

    // Twin recovery by point-reflected centroid (same tolerance as the
    // pairing validation below).
    const twinOf = new Map<number, number>();
    for (let i = 0; i < pieces.length; i++) {
      if (twinOf.has(i)) continue;
      const c = centroid(resolved[i]!);
      const r = { x: BOARD_INCHES.width - c.x, y: BOARD_INCHES.height - c.y };
      for (let j = 0; j < pieces.length; j++) {
        if (j === i || twinOf.has(j)) continue;
        const cj = centroid(resolved[j]!);
        if (
          Math.abs(cj.x - r.x) <= TWIN_CENTROID_TOLERANCE_IN &&
          Math.abs(cj.y - r.y) <= TWIN_CENTROID_TOLERANCE_IN
        ) {
          twinOf.set(i, j);
          twinOf.set(j, i);
          break;
        }
      }
    }

    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      if (piece.keystones && piece.keystones.length > 0) continue;
      const derived = deriveForPiece(resolved[i]!, isAxisAligned(piece));
      piece.keystones = derived;
      piecesAuthored += 1;

      const j = twinOf.get(i);
      if (j === undefined || j === i) continue;
      const twinPiece = pieces[j]!;
      if (twinPiece.keystones && twinPiece.keystones.length > 0) continue;
      const mirrored = derived.map((k) => mirrorOntoTwin(k, resolved[i]!, resolved[j]!));
      if (mirrored.every((k): k is Keystone => k !== null)) {
        twinPiece.keystones = mirrored;
        piecesAuthored += 1;
      }
      // A failed mirror leaves the twin bare; the loop derives it
      // independently and the pairing validation reports any drift.
    }
  }
  return piecesAuthored;
}

/** Validate the 180°-pairing invariant on the `bm-*` layouts: every terrain
 * piece has a reflected twin, and the twins' derived distances agree within
 * {@link PAIR_TOLERANCE_IN} — both halves of a printed card measure alike.
 * Returns human-readable violations (empty when the invariant holds). */
export function keystonePairingViolations(
  layouts: TerrainLayout[],
  templates: TerrainTemplate[],
): string[] {
  const violations: string[] = [];
  for (const layout of layouts) {
    if (!layout.id.startsWith("bm-")) continue;
    const pieces = layout.pieces ?? [];
    const resolved = explicitResolved(layout, templates);
    const measured = keystoneMeasurements(layout, templates);
    const byPiece = new Map<number, number[]>();
    for (const m of measured) {
      const list = byPiece.get(m.piece_index) ?? [];
      list.push(m.distance);
      byPiece.set(m.piece_index, list);
    }
    const terrainIdx = pieces.map((_, i) => i);
    for (const i of terrainIdx) {
      const c = centroid(resolved[i]!);
      const reflected = { x: BOARD_INCHES.width - c.x, y: BOARD_INCHES.height - c.y };
      const twin = terrainIdx.find((j) => {
        const cj = centroid(resolved[j]!);
        return (
          Math.abs(cj.x - reflected.x) <= TWIN_CENTROID_TOLERANCE_IN &&
          Math.abs(cj.y - reflected.y) <= TWIN_CENTROID_TOLERANCE_IN
        );
      });
      if (twin === undefined) {
        violations.push(`${layout.id}: piece ${pieces[i]!.id ?? i} has no 180° twin`);
        continue;
      }
      // The twin's keystones anchor the reflected vertex to the opposite
      // edges, so the sorted distance pairs must match.
      const expected = isAxisAligned(pieces[i]!) ? 2 : 3;
      const a = [...(byPiece.get(i) ?? [])].sort((x, y) => x - y);
      const b = [...(byPiece.get(twin) ?? [])].sort((x, y) => x - y);
      if (a.length !== expected || b.length !== expected) {
        violations.push(
          `${layout.id}: piece ${pieces[i]!.id ?? i} expected ${expected} keystones`,
        );
        continue;
      }
      for (let k = 0; k < expected; k++) {
        if (Math.abs(a[k]! - b[k]!) > PAIR_TOLERANCE_IN) {
          violations.push(
            `${layout.id}: pieces ${pieces[i]!.id ?? i}/${pieces[twin]!.id ?? twin} measure apart ` +
              `(${a[k]!.toFixed(3)}″ vs ${b[k]!.toFixed(3)}″)`,
          );
        }
      }
    }
  }
  return violations;
}

function main(): void {
  const write = process.argv.includes("--write");
  const layouts = JSON.parse(readFileSync(LAYOUTS_PATH, "utf8")) as TerrainLayout[];
  const templates = JSON.parse(readFileSync(TEMPLATES_PATH, "utf8")) as TerrainTemplate[];

  if (process.argv.includes("--rederive")) {
    for (const layout of layouts) {
      if (!layout.id.startsWith("bm-")) continue;
      for (const piece of layout.pieces ?? []) delete piece.keystones;
    }
  }
  const piecesAuthored = authorKeystones(layouts, templates);
  const violations = keystonePairingViolations(layouts, templates);

  console.log(`pieces authored: ${piecesAuthored}`);
  if (violations.length > 0) {
    console.error(`\n${violations.length} pairing violations:`);
    for (const v of violations) console.error(`  ${v}`);
    process.exitCode = 1;
    return;
  }
  if (write) {
    writeFileSync(LAYOUTS_PATH, `${JSON.stringify(layouts, null, 2)}\n`);
    console.log(`wrote ${LAYOUTS_PATH}`);
  } else {
    console.log("dry run — pass --write to persist");
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  main();
}
