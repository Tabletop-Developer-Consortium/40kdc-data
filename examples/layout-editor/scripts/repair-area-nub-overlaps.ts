/**
 * Batch-repair terrain nub-vs-area overlaps by auto-reorienting areas.
 *
 * Background: commit e8e9d74e ("GW terrain-area nub footprints") swapped the four
 * rectangular area plates for GW's die-cut nub footprints. Plate corners + keystone
 * measurements were preserved, but the nubs protrude past the old rectangle, so
 * areas that used to sit flush now graze each other — small (~0.25-0.35 in²)
 * area-vs-area overlaps that trip `layoutWarnings()`'s collision check.
 *
 * The fix (what a human does in the editor): re-orient the offending area so its
 * asymmetric nub points at a clear edge. For a rectangular plate the Klein 4-group
 * {identity, 180°, mirror-h, mirror-v} keeps the plate's board footprint fixed
 * (position untouched) while relocating the nub. This script, for each area caught
 * in a collision, tries those plate-preserving orientations and keeps the one that
 * minimizes overlap — reusing the shipped editor primitives so the batch does
 * exactly what the ⚓/orient tooling does:
 *   - `orientPiece`   — set rotation/mirror, pin child features in board space,
 *                       and mirror the change onto the symmetric twin.
 *   - `layoutWarnings`— the exact collision + keystone-roundness gate.
 *   - `repairTwins`   — establish twin pairing so orientPiece propagates.
 * Keystones are measurement-only, so after each flip we remap every vertex-ref
 * keystone to the footprint vertex now nearest its original board position
 * (else the reference jumps to the flipped corner and reads non-round).
 *
 * Gate (never regress): a reorientation is accepted only if it strictly reduces
 * the layout's collision count, adds no new collision, and does not increase the
 * keystone-not-round count. Anything it can't clear (face-ref keystones that a nub
 * flip would de-round, nub-less trapezoids, larger Class-B overlaps) is left for the
 * user to finish manually and listed in the report.
 *
 * `take-and-hold-mirror-1` (the worked reference) is repaired like the rest; its
 * auto-repair reproduces the hand-fix (medium flipped, corner-shorts re-anchored).
 *
 * Usage (from examples/layout-editor):
 *   npx tsx scripts/repair-area-nub-overlaps.ts          # dry-run + report
 *   npx tsx scripts/repair-area-nub-overlaps.ts --write   # apply, surgical diff
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type EditLayout,
  type EditPiece,
  type LayoutWarning,
  orientPiece,
  movePiece,
  mirrorKeystone,
  reanchorAllFeatures,
  repairTwins,
  layoutWarnings,
  keystoneDisplays,
  isRoundKeystone,
  orientedFootprint,
} from "../src/lib/model.js";

const REPO_ROOT = join(new URL("../../..", import.meta.url).pathname);
const LAYOUTS_PATH = join(REPO_ROOT, "data", "core", "terrain-layouts.json");
const WRITE = process.argv.includes("--write");

/** Plate-rectangle corner indices in each template's footprint `points` order
 *  ([(0,0),(w,0),(w,h),(0,h)] — the same order ingest-terrain-footprints.ts uses).
 *  area-trapezoid is nub-less and never reoriented; inline-footprint areas skipped. */
const BASE_CORNER_IDX: Record<string, number[]> = {
  "area-medium": [13, 14, 15, 0],
  "area-short-line": [8, 1, 0, 9],
  "area-large": [25, 24, 23, 0],
  "area-long-line": [16, 1, 0, 17],
};
const ROTS = [0, 90, 180, 270] as const;
const MIRRORS = ["none", "horizontal", "vertical"] as const;
const CORNER_EPS = 0.2; // plate-corner set match tolerance (absorbs the ~0.1″ nub-centroid drift;
//                          still far below the width/height swap a 90° rotation would cause)
const VERT_EPS = 0.25; // keystone re-anchor: nearest vertex must land within this

type RawPiece = Record<string, unknown> & {
  id: string;
  piece_type?: string;
  template?: string;
  position: { x: number; y: number };
  rotation_degrees?: number;
  mirror?: string;
  keystones?: { edge: string; ref: { kind: string; index?: number; side?: string } }[];
};
type RawLayout = Record<string, unknown> & { id: string; name: string; pieces: RawPiece[] };

// ── build an EditLayout from the raw on-disk JSON (bundle-independent) ─────────
function toEdit(raw: RawLayout): EditLayout {
  const pieces: EditPiece[] = raw.pieces.map((p) => ({
    id: p.id,
    name: p.name as string | undefined,
    piece_type: (p.piece_type as "area" | "feature") ?? "area",
    template: p.template,
    footprint: (p as Record<string, unknown>).footprint as EditPiece["footprint"],
    position: { x: p.position.x, y: p.position.y },
    rotation_degrees: p.rotation_degrees ?? 0,
    mirror: (p.mirror as EditPiece["mirror"]) ?? "none",
    parent_area_id: (p as Record<string, unknown>).parent_area_id as string | undefined,
    floor: (p as Record<string, unknown>).floor as number | undefined,
    height_inches: (p as Record<string, unknown>).height_inches as number | undefined,
    link_group: (p as Record<string, unknown>).link_group as string | undefined,
    objective_role: (p as Record<string, unknown>).objective_role as EditPiece["objective_role"],
    is_objective: (p as Record<string, unknown>).is_objective as boolean | undefined,
    objective: (p as Record<string, unknown>).objective as EditPiece["objective"],
    keystones: p.keystones ? (JSON.parse(JSON.stringify(p.keystones)) as EditPiece["keystones"]) : undefined,
  }));
  const layout: EditLayout = {
    id: raw.id,
    name: raw.name,
    source: raw.source as string | undefined,
    description: raw.description as string | undefined,
    mission_matchup_id: raw.mission_matchup_id as string | undefined,
    variant: raw.variant as number | undefined,
    deployment_pattern_id: raw.deployment_pattern_id as string | undefined,
    board: (raw as Record<string, unknown>).board as EditLayout["board"],
    pieces,
  };
  repairTwins(layout);
  return layout;
}

const byId = (l: EditLayout, id: string): EditPiece | undefined => l.pieces.find((p) => p.id === id);
const collisions = (w: LayoutWarning[]): LayoutWarning[] => w.filter((x) => x.kind === "collision");
const collisionMsgs = (w: LayoutWarning[]): Set<string> =>
  new Set(collisions(w).map((c) => c.message));
const roundMsgs = (w: LayoutWarning[]): Set<string> =>
  new Set(w.filter((x) => x.kind === "keystone-not-round").map((x) => x.message));

/** Board centroid of an area's four plate corners in its CURRENT orientation. */
function plateCenter(layout: EditLayout, area: EditPiece): { x: number; y: number } | null {
  const idx = area.template ? BASE_CORNER_IDX[area.template] : undefined;
  const of = idx ? orientedFootprint(area, layout) : undefined;
  if (!idx || !of) return null;
  const c = idx.reduce((s, i) => ({ x: s.x + of.verticesBoard[i].x, y: s.y + of.verticesBoard[i].y }), { x: 0, y: 0 });
  return { x: c.x / idx.length, y: c.y / idx.length };
}

/**
 * The plate-corner vertex index whose board coordinate on the keystone edge's axis
 * is the plate extreme for that edge — the "cardinal" corner the edge was coterminant
 * with before nubbing. Measuring this corner restores the clean pre-nub distance
 * (the nub, if any, is ignored). Returns null for a template with no plate corners.
 */
function cardinalVertex(layout: EditLayout, area: EditPiece, edge: string): number | null {
  const idx = area.template ? BASE_CORNER_IDX[area.template] : undefined;
  const of = idx ? orientedFootprint(area, layout) : undefined;
  if (!idx || !of) return null;
  const axis: "x" | "y" = edge === "left" || edge === "right" ? "x" : "y";
  const wantMax = edge === "right" || edge === "bottom";
  let best = idx[0];
  for (const i of idx) {
    const better = wantMax ? of.verticesBoard[i][axis] > of.verticesBoard[best][axis] : of.verticesBoard[i][axis] < of.verticesBoard[best][axis];
    if (better) best = i;
  }
  return best;
}

/** Board positions of an area's four plate corners under a probed (rot, mirror). */
function plateCorners(layout: EditLayout, area: EditPiece, rot: number, mirror: string): { x: number; y: number }[] | null {
  const idx = area.template ? BASE_CORNER_IDX[area.template] : undefined;
  if (!idx) return null;
  const of = orientedFootprint({ ...area, rotation_degrees: rot, mirror: mirror as EditPiece["mirror"] }, layout);
  if (!of) return null;
  return idx.map((i) => of.verticesBoard[i]);
}

/** The (rot, mirror) states that keep the plate corners at the same board positions. */
function plateVariants(layout: EditLayout, area: EditPiece): { rot: number; mirror: string }[] {
  const cur = plateCorners(layout, area, area.rotation_degrees, area.mirror);
  if (!cur) return [];
  const same = (a: { x: number; y: number }[], b: { x: number; y: number }[]): boolean =>
    a.every((p) => b.some((q) => Math.hypot(p.x - q.x, p.y - q.y) <= CORNER_EPS));
  const out: { rot: number; mirror: string }[] = [];
  for (const rot of ROTS)
    for (const mirror of MIRRORS) {
      if (rot === area.rotation_degrees && mirror === area.mirror) continue;
      const cand = plateCorners(layout, area, rot, mirror);
      if (cand && same(cand, cur) && same(cur, cand)) out.push({ rot, mirror });
    }
  return out;
}

/**
 * Convert a face-ref keystone to the plate-corner vertex that realizes its extent,
 * when possible. A `min-x/max-x/min-y/max-y` face measures the outermost board
 * coordinate on that axis; if that extreme is a plate corner (a non-nubbed edge)
 * the vertex ref pins the identical distance but survives reorientation (nubs move,
 * plate corners don't). When the extreme is a nub tip there is no appropriate
 * vertex — leave it a face ref (the roundness gate then keeps that area manual).
 */
function convertFaceRefs(layout: EditLayout, area: EditPiece): number {
  if (!area.template || !BASE_CORNER_IDX[area.template]) return 0;
  const of = orientedFootprint(area, layout);
  if (!of) return 0;
  const corners = new Set(BASE_CORNER_IDX[area.template]);
  let converted = 0;
  for (const k of area.keystones ?? []) {
    if (k.ref.kind !== "face") continue;
    const axis: "x" | "y" = k.ref.side.includes("x") ? "x" : "y";
    const wantMax = k.ref.side.startsWith("max");
    const vals = of.verticesBoard.map((v) => v[axis]);
    const ext = wantMax ? Math.max(...vals) : Math.min(...vals);
    // A plate corner sitting at that extreme measures the identical distance.
    const cornerIdx = of.verticesBoard.findIndex(
      (v, i) => corners.has(i) && Math.abs(v[axis] - ext) <= 1e-3,
    );
    if (cornerIdx >= 0) {
      (k as { ref: { kind: string; index: number } }).ref = { kind: "vertex", index: cornerIdx };
      converted++;
    }
  }
  return converted;
}

/** For each vertex-ref keystone, the board position of its referenced vertex (null for face refs). */
function keystoneAnchors(layout: EditLayout, area: EditPiece): (({ x: number; y: number }) | null)[] {
  const of = orientedFootprint(area, layout);
  return (area.keystones ?? []).map((k) =>
    k.ref.kind === "vertex" && of ? of.verticesBoard[k.ref.index] ?? null : null,
  );
}

/** Re-point each vertex-ref keystone to the footprint vertex now nearest its recorded anchor. */
function remapKeystones(layout: EditLayout, area: EditPiece, anchors: (({ x: number; y: number }) | null)[]): void {
  const of = orientedFootprint(area, layout);
  if (!of) return;
  (area.keystones ?? []).forEach((k, i) => {
    const anchor = anchors[i];
    if (k.ref.kind !== "vertex" || !anchor) return;
    let best = Infinity;
    let bestIdx = k.ref.index;
    of.verticesBoard.forEach((v, vi) => {
      const d = Math.hypot(v.x - anchor.x, v.y - anchor.y);
      if (d < best) {
        best = d;
        bestIdx = vi;
      }
    });
    if (best <= VERT_EPS) k.ref.index = bestIdx;
  });
}

/**
 * Apply a reorientation to a CLONED layout: face→vertex, orient (twin + feature pin),
 * plate-preserving position correction, keystone remap. All keystone edits happen on
 * the PRIMARY area; the twin's keystones are then rebuilt as exact mirrors of the
 * primary's (via the shipped `mirrorKeystone`) so the twin-keystone-mirror invariant
 * (keystone-pairing.test.ts) is preserved. Returns false — and the caller rejects the
 * candidate — if that mirroring can't be done cleanly for every keystone.
 */
function applyReorient(layout: EditLayout, areaId: string, rot: number, mirror: string): boolean {
  const area = byId(layout, areaId)!;
  const twin = area.twin_id ? byId(layout, area.twin_id) : undefined;
  // Convert convertible face refs to plate-corner vertex refs first (so they survive
  // the flip and get remapped like other vertex refs); non-convertible faces stay.
  convertFaceRefs(layout, area);
  const aAnchors = keystoneAnchors(layout, area);
  // Plate-center board position BEFORE the flip — the invariant we restore afterwards.
  const plate0 = plateCenter(layout, area);
  orientPiece(layout, areaId, { rotation_degrees: rot, mirror: mirror as EditPiece["mirror"] });
  // A nub-shifted centroid means orienting about `position` drifts the plate ~0.1″.
  // Correct it: shift the area (movePiece carries features + the twin) so the plate
  // returns exactly, keeping keystone distances round.
  const plate1 = plateCenter(layout, area);
  if (plate0 && plate1) {
    const dx = plate0.x - plate1.x;
    const dy = plate0.y - plate1.y;
    if (Math.hypot(dx, dy) > 1e-6) movePiece(layout, areaId, { x: area.position.x + dx, y: area.position.y + dy });
  }
  remapKeystones(layout, area, aAnchors);
  // Rebuild the twin's keystones as exact mirrors of the (edited) primary's.
  if (twin && area.keystones && area.keystones.length > 0) {
    const mirrored = area.keystones.map((k) => mirrorKeystone(layout, area, twin, k));
    if (mirrored.some((m) => m === null)) return false; // not cleanly mirrorable → reject candidate
    twin.keystones = mirrored as NonNullable<(typeof mirrored)[number]>[];
  }
  return true;
}

// ── per-layout greedy repair ──────────────────────────────────────────────────
interface AreaChange {
  id: string;
  from: string;
  to: string;
}
interface FeatureChange {
  id: string;
  from: string | undefined;
  to: string | undefined;
}
interface KeystoneChange {
  pieceId: string;
  edge: string;
  fromKind: "vertex" | "face";
  fromRef: string; // "face:min-x" or "vertex:13"
  toIndex: number;
}
interface LayoutResult {
  id: string;
  before: LayoutWarning[];
  after: LayoutWarning[];
  changes: AreaChange[];
  featureChanges: FeatureChange[];
  keystoneChanges: KeystoneChange[];
  final: EditLayout;
  reverted: boolean;
}

function orient(p: EditPiece): string {
  return `rot${p.rotation_degrees}/${p.mirror}`;
}

function repairLayout(raw: RawLayout): LayoutResult {
  const original = toEdit(raw);
  const before = layoutWarnings(original);
  let working = original;
  const changes: AreaChange[] = [];

  const baseRoundSet = roundMsgs(before); // no reorientation may introduce a NEW non-round keystone
  const processed = new Set<string>();

  // A couple of passes: fixing one area can change which areas still collide.
  for (let pass = 0; pass < 3; pass++) {
    const curW = layoutWarnings(working);
    if (collisions(curW).length === 0) break;
    // Areas currently in a collision, that we know how to reorient.
    const colliding = new Set<string>();
    for (const c of collisions(curW)) for (const id of c.pieceIds) if (id) colliding.add(id);
    let improvedThisPass = false;

    for (const area of working.pieces) {
      if (area.piece_type !== "area" || !area.template || !BASE_CORNER_IDX[area.template]) continue;
      if (!colliding.has(area.id)) continue;
      if (processed.has(area.id)) continue;

      const curCount = collisions(layoutWarnings(working)).length;
      const curMsgs = collisionMsgs(layoutWarnings(working));
      let best: { clone: EditLayout; count: number; rot: number; mirror: string } | null = null;

      for (const { rot, mirror } of plateVariants(working, byId(working, area.id)!)) {
        const clone: EditLayout = toEditClone(working);
        if (!applyReorient(clone, area.id, rot, mirror)) continue;
        const w = layoutWarnings(clone);
        const count = collisions(w).length;
        const msgs = collisionMsgs(w);
        const noNewCollision = [...msgs].every((m) => curMsgs.has(m));
        const noNewNonRound = [...roundMsgs(w)].every((m) => baseRoundSet.has(m));
        if (count < curCount && noNewCollision && noNewNonRound) {
          if (!best || count < best.count) best = { clone, count, rot, mirror };
        }
      }

      if (best) {
        const twinId = byId(working, area.id)!.twin_id;
        const fromO = orient(byId(working, area.id)!);
        working = best.clone;
        const toO = orient(byId(working, area.id)!);
        changes.push({ id: area.id, from: fromO, to: toO });
        processed.add(area.id);
        if (twinId) processed.add(twinId); // twin handled by orientPiece
        improvedThisPass = true;
      }
    }
    if (!improvedThisPass) break;
  }

  // Pass 2: re-anchor mis-parented features (a distinct bug — a feature pointing at
  // the wrong/mirror-twin area overlaps the area it physically sits on). Whole-layout
  // sweep, gated the same way: accept only if it strictly reduces collisions without
  // adding any new collision or non-round keystone.
  const featureChanges: FeatureChange[] = [];
  {
    const curW = layoutWarnings(working);
    if (collisions(curW).length > 0) {
      const clone = toEditClone(working);
      reanchorAllFeatures(clone);
      const w = layoutWarnings(clone);
      const curMsgs = collisionMsgs(curW);
      const noNewCollision = [...collisionMsgs(w)].every((m) => curMsgs.has(m));
      const noNewNonRound = [...roundMsgs(w)].every((m) => baseRoundSet.has(m));
      if (collisions(w).length < collisions(curW).length && noNewCollision && noNewNonRound) {
        for (const p of clone.pieces) {
          if (p.piece_type !== "feature") continue;
          const old = byId(working, p.id);
          if (old && old.parent_area_id !== p.parent_area_id) {
            featureChanges.push({ id: p.id, from: old.parent_area_id, to: p.parent_area_id });
          }
        }
        working = clone;
      }
    }
  }

  // Pass 3: keystone roundness. A non-round FACE keystone now reads the nubbed edge;
  // bump it to the cardinal plate-corner vertex it was coterminant with pre-nub, which
  // restores the clean measurement. Also re-points the few non-round VERTEX keystones
  // that round at the correct cardinal corner. Keystones are measurement-only, so this
  // never changes geometry or collisions; gated to strictly reduce non-round keystones
  // without adding any, and the twin's keystones are rebuilt as exact mirrors.
  const keystoneChanges: KeystoneChange[] = [];
  {
    const processedKs = new Set<string>();
    for (const area of working.pieces) {
      if (area.piece_type !== "area" || !area.template || !BASE_CORNER_IDX[area.template]) continue;
      if (processedKs.has(area.id) || !area.keystones || area.keystones.length === 0) continue;

      const nonRound = new Set(
        keystoneDisplays(working)
          .filter((d) => d.pieceId === area.id && d.distance != null && !isRoundKeystone(d.distance))
          .map((d) => d.index),
      );
      if (nonRound.size === 0) continue;

      const clone = toEditClone(working);
      const a = byId(clone, area.id)!;
      const twin = a.twin_id ? byId(clone, a.twin_id) : undefined;
      const pending: KeystoneChange[] = [];
      for (const i of nonRound) {
        const k = a.keystones![i];
        const newIdx = cardinalVertex(clone, a, k.edge);
        if (newIdx == null) continue;
        if (k.ref.kind === "vertex" && k.ref.index === newIdx) continue; // already at cardinal → position issue, leave
        pending.push({
          pieceId: a.id,
          edge: k.edge,
          fromKind: k.ref.kind,
          fromRef: k.ref.kind === "face" ? `face:${k.ref.side}` : `vertex:${k.ref.index}`,
          toIndex: newIdx,
        });
        a.keystones![i] = { edge: k.edge, ref: { kind: "vertex", index: newIdx } };
      }
      if (pending.length === 0) continue;
      if (twin && a.keystones) {
        const mirrored = a.keystones.map((k) => mirrorKeystone(clone, a, twin, k));
        if (mirrored.some((m) => m === null)) continue; // not cleanly mirrorable → skip
        twin.keystones = mirrored as NonNullable<(typeof mirrored)[number]>[];
      }
      const curRound = roundMsgs(layoutWarnings(working));
      const w = layoutWarnings(clone);
      const newRound = roundMsgs(w);
      const noNew = [...newRound].every((m) => curRound.has(m));
      const noNewCollision = collisions(w).length <= collisions(layoutWarnings(working)).length;
      if (newRound.size < curRound.size && noNew && noNewCollision) {
        working = clone;
        keystoneChanges.push(...pending);
        processedKs.add(area.id);
        if (twin) processedKs.add(twin.id);
      }
    }
  }

  const after = layoutWarnings(working);
  // Final all-or-nothing gate: fewer collisions and/or fewer non-round keystones, with
  // no NEW collision and no NEW non-round keystone introduced.
  const beforeMsgs = collisionMsgs(before);
  const afterMsgs = collisionMsgs(after);
  const anyChange = changes.length > 0 || featureChanges.length > 0 || keystoneChanges.length > 0;
  const noNewCollision = [...afterMsgs].every((m) => beforeMsgs.has(m));
  const noNewNonRound = [...roundMsgs(after)].every((m) => baseRoundSet.has(m));
  const improved =
    collisions(after).length < collisions(before).length || roundMsgs(after).size < baseRoundSet.size;
  const netImproved = anyChange && noNewCollision && noNewNonRound && improved;
  const reverted = anyChange && !netImproved;
  return {
    id: raw.id,
    before,
    after: reverted ? before : after,
    changes: reverted ? [] : changes,
    featureChanges: reverted ? [] : featureChanges,
    keystoneChanges: reverted ? [] : keystoneChanges,
    final: reverted ? original : working,
    reverted,
  };
}

/** structuredClone the layout and re-establish twin pairing (twin_id survives the clone). */
function toEditClone(l: EditLayout): EditLayout {
  const clone = structuredClone(l) as EditLayout;
  repairTwins(clone);
  return clone;
}

// ── surgical write-back onto the raw JSON ─────────────────────────────────────
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
/** Patch only the fields the repair changed onto the raw piece objects. */
function patchRaw(raw: RawLayout, final: EditLayout): number {
  let touched = 0;
  const rawById = new Map(raw.pieces.map((p) => [p.id, p]));
  for (const ep of final.pieces) {
    const rp = rawById.get(ep.id);
    if (!rp) continue;
    let changed = false;
    // rotation_degrees: omit when 0 (file convention)
    const curRot = rp.rotation_degrees ?? 0;
    if (curRot !== ep.rotation_degrees) {
      if (ep.rotation_degrees === 0) delete rp.rotation_degrees;
      else rp.rotation_degrees = ep.rotation_degrees;
      changed = true;
    }
    // mirror: omit when "none"
    const curMir = rp.mirror ?? "none";
    if (curMir !== ep.mirror) {
      if (ep.mirror === "none") delete rp.mirror;
      else rp.mirror = ep.mirror;
      changed = true;
    }
    // parent_area_id (features re-anchored by pass 2)
    const curParent = (rp as { parent_area_id?: string }).parent_area_id;
    if (curParent !== ep.parent_area_id) {
      if (ep.parent_area_id === undefined) delete (rp as { parent_area_id?: string }).parent_area_id;
      else (rp as { parent_area_id?: string }).parent_area_id = ep.parent_area_id;
      changed = true;
    }
    // position (features get pinned / re-anchored; areas corrected by the plate re-solve)
    if (round4(rp.position.x) !== round4(ep.position.x) || round4(rp.position.y) !== round4(ep.position.y)) {
      rp.position = { x: round4(ep.position.x), y: round4(ep.position.y) };
      changed = true;
    }
    // keystones (ref.index remap)
    if (ep.keystones) {
      const newKs = ep.keystones.map((k) => ({ edge: k.edge, ref: { ...k.ref } }));
      if (JSON.stringify(newKs) !== JSON.stringify(rp.keystones)) {
        rp.keystones = newKs as RawPiece["keystones"];
        changed = true;
      }
    }
    if (changed) touched++;
  }
  return touched;
}

// ── run ───────────────────────────────────────────────────────────────────────
const rawData = JSON.parse(readFileSync(LAYOUTS_PATH, "utf8")) as RawLayout[];
const results = rawData.map(repairLayout);

const roundN = (w: LayoutWarning[]): number => w.filter((x) => x.kind === "keystone-not-round").length;
const changed = (r: LayoutResult): boolean =>
  r.changes.length > 0 || r.featureChanges.length > 0 || r.keystoneChanges.length > 0;
const touchedLayouts = results.filter((r) => changed(r) && !r.reverted);
const residual = results.filter((r) => collisions(r.after).length > 0);
const totalKs = results.reduce((s, r) => s + r.keystoneChanges.length, 0);
const faceConv = results.reduce((s, r) => s + r.keystoneChanges.filter((k) => k.fromKind === "face").length, 0);

console.log(`\n=== Terrain warning auto-repair (${WRITE ? "WRITE" : "dry-run"}) ===\n`);
console.log(`Layouts: ${rawData.length}   touched: ${touchedLayouts.length}`);
const colBefore = results.reduce((s, r) => s + collisions(r.before).length, 0);
const colAfter = results.reduce((s, r) => s + collisions(r.after).length, 0);
const rndBefore = results.reduce((s, r) => s + roundN(r.before), 0);
const rndAfter = results.reduce((s, r) => s + roundN(r.after), 0);
console.log(`Collisions: ${colBefore} -> ${colAfter}   Keystone-not-round: ${rndBefore} -> ${rndAfter}`);
console.log(`Keystone bumps: ${totalKs} (${faceConv} face->cardinal, ${totalKs - faceConv} vertex re-point)`);
console.log(`Reverted (net regression): ${results.filter((r) => r.reverted).length}   Still colliding: ${residual.length}\n`);

for (const r of touchedLayouts) {
  console.log(`${r.id}: collisions ${collisions(r.before).length}->${collisions(r.after).length}, non-round ${roundN(r.before)}->${roundN(r.after)}`);
  for (const ch of r.changes) console.log(`     reorient area ${ch.id}: ${ch.from} -> ${ch.to}`);
  for (const fc of r.featureChanges) console.log(`     re-anchor feature ${fc.id}: ${fc.from ?? "—"} -> ${fc.to ?? "—"}`);
  for (const c of collisions(r.after)) console.log(`     residual collision: ${c.message}`);
}

// Vertex-ref re-points get a dedicated diff — these change WHICH corner is measured
// (unlike face->cardinal, which just restores the intended plate corner). Review these.
const vtxRepoints = results.flatMap((r) => r.keystoneChanges.filter((k) => k.fromKind === "vertex").map((k) => ({ layout: r.id, ...k })));
if (vtxRepoints.length) {
  console.log(`\n▸ VERTEX keystone re-points (${vtxRepoints.length}) — review (changes which corner is measured):`);
  for (const v of vtxRepoints) console.log(`     ${v.layout} ${v.pieceId} ${v.edge}: ${v.fromRef} -> vertex:${v.toIndex}`);
}

// link_group spot-check (areas reoriented or features re-anchored onto/off a linked area)
const lgTouched: string[] = [];
for (const r of touchedLayouts) {
  const l = r.final;
  for (const ch of r.changes) {
    const p = byId(l, ch.id);
    if (p?.link_group) lgTouched.push(`${r.id}:${ch.id} (area link_group ${p.link_group})`);
  }
  for (const fc of r.featureChanges) {
    const to = fc.to ? byId(l, fc.to) : undefined;
    const from = fc.from ? byId(l, fc.from) : undefined;
    if (to?.link_group || from?.link_group)
      lgTouched.push(`${r.id}:${fc.id} (feature -> link_group ${to?.link_group ?? from?.link_group})`);
  }
}
if (lgTouched.length) {
  console.log(`\n⚠ link_group pieces touched (spot-check): ${lgTouched.join(", ")}`);
}

if (WRITE) {
  // Patch every genuinely-changed layout onto the raw JSON.
  let layoutsTouched = 0;
  const rawById = new Map(rawData.map((r) => [r.id, r]));
  for (const r of touchedLayouts) {
    const raw = rawById.get(r.id)!;
    const n = patchRaw(raw, r.final);
    if (n > 0) layoutsTouched++;
  }
  writeFileSync(LAYOUTS_PATH, JSON.stringify(rawData, null, 2) + "\n");
  console.log(`\nWROTE ${LAYOUTS_PATH} — ${layoutsTouched} layout(s) patched.`);
} else {
  console.log(`\n(dry-run — re-run with --write to apply)`);
}
