/**
 * Learn — and assert — the Battlemaster → 40kdc conversion before any data is
 * rewritten.
 *
 * One number per area template is not derivable from first principles: the
 * **orientation offset**, the rotation carrying the Battlemaster artwork's natural
 * orientation onto the 40kdc footprint's. The two catalogs were authored
 * independently, so each template has its own constant.
 *
 * It is pinned in four stages, strongest first:
 *
 * 1. **Bounding box** narrows the candidates to two. A footprint's bbox is
 *    orientation-bearing: if Battlemaster's composite bbox matches the 40kdc
 *    footprint's, the offset is 0 or 180; if it matches transposed, it is 90 or 270.
 * 2. **On-board placement** breaks the tie for an asymmetric footprint. Terrain sits
 *    on the table, so the right offset puts every resolved vertex of every actual
 *    placement inside the board. This is decisive for `area-trapezoid` — the one
 *    strongly asymmetric shape, whose centroid sits 1.66″ off its bounding-box centre
 *    — where the wrong choice pushes pieces up to 0.93″ over the edge.
 *
 *    A point-in-polygon check (are the composite's parts inside the parent footprint?)
 *    is *reported* but deliberately not used to decide: it re-anchors by the very
 *    offset under test, so it is not independent of the answer, and it does in fact
 *    prefer the wrong offset for the trapezoid.
 * 3. **The hand-authored reference card.** `take-and-hold-vs-purge-the-foe-2` was the
 *    only layout carrying `source: "gw-11e"` — authored by hand rather than scraped —
 *    and its rotations are clean multiples of 90° where the scraped cards' are not. So
 *    where it agrees with Battlemaster on a template's *position* (to 0.3″) and implies
 *    a single consistent offset, that offset is taken directly. It is the one
 *    independently trustworthy rotation source in the corpus. Its pre-intake state is
 *    committed at `tools/test/fixtures/terrain/gw-11e-ground-truth.json`, which is what
 *    this reads — the live record is about to be overwritten.
 * 4. **Keystone preservation** breaks anything still tied. Where a footprint is
 *    180°-near-symmetric, position residual cannot decide — every Chapter Approved
 *    layout is itself 180°-symmetric, so both candidates fit the *plate* equally
 *    well (measured margin: exactly 0.0000″). But the choice is not cosmetic:
 *    rotating by 180° permutes which **footprint vertex index** lands where, and a
 *    keystone references its vertex *by index*. Picking wrong silently re-points
 *    every dimension line on the printed card to the opposite corner.
 *
 *    So the last-resort tiebreak is the criterion that carries meaning: choose the
 *    offset that minimises total change in keystone-derived distances across the
 *    placements Battlemaster and the repo already agree on. That preserves the
 *    author's intent about which corner each card measures — the same invariance
 *    `ingest-terrain-footprints.ts` protects when a footprint is re-authored.
 *
 *    It is only a last resort because it is mildly biased: on a scraped card the
 *    committed rotation may itself be 180° out, and "least drift" then rewards
 *    reproducing that. Stage 3 is preferred wherever it can speak.
 *
 * The gate: every learned offset must be a clean multiple of 90°. An oblique offset
 * would mean the frame model itself is wrong, not that a template is unusual.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { orientedOffsets, type TerrainTemplate, type Vec2 } from "../terrain/resolve.js";
import { keystoneMeasurements } from "../terrain/keystones.js";
import { REPO_ROOT } from "../mfm/repo-files.js";
import {
  BOARD,
  DEPLOYMENT_KEY_TO_PATTERN,
  SIZE_CLASS_TO_AREA_TEMPLATE,
  centroidToBoundsCentre,
  footprintBounds,
  norm360,
  repoLayoutId,
  toBoardFrame,
  type RepoLayout,
  type RepoPiece,
} from "./repo.js";
import {
  areaPositionFromInstance,
  boundsOf,
  centroidLocalPolygon,
  partCentreYUp,
  pointInPolygon,
  rotateCw,
} from "./geometry.js";
import type { BmInstance, BmSnapshot } from "./source.js";

/** How an offset was decided — surfaced in the report so weak pins are visible. */
export type OffsetBasis =
  | "bbox+on-board"
  | "bbox+reference-card"
  | "bbox+keystones"
  | "bbox-only";

/** The hand-authored reference card, and where its pre-intake state is committed. */
export const REFERENCE_LAYOUT_ID = "take-and-hold-vs-purge-the-foe-2";
const REFERENCE_FIXTURE = join(
  REPO_ROOT,
  "tools",
  "test",
  "fixtures",
  "terrain",
  "gw-11e-ground-truth.json",
);

/**
 * Read the pre-intake reference card. Returns null when the fixture is absent, so the
 * calibration degrades to its other stages rather than failing.
 */
export function loadReferenceLayout(): RepoLayout | null {
  if (!existsSync(REFERENCE_FIXTURE)) return null;
  return JSON.parse(readFileSync(REFERENCE_FIXTURE, "utf8")) as RepoLayout;
}

/**
 * The orientation offset the reference card implies for one area template, or null
 * when it cannot speak: no placement of that template agrees on position, the implied
 * offsets disagree between placements, or the implied offset is not a clean multiple
 * of 90° (which means that card's own rotation for the piece was unreliable too).
 */
function referenceOffset(
  reference: RepoLayout,
  snapshot: BmSnapshot,
  sizeClass: string,
  areaTemplate: string,
): number | null {
  const bm = snapshot.layouts.find((l) => repoLayoutId(l) === reference.id);
  if (!bm) return null;
  const areas = (reference.pieces ?? []).filter(
    (p) => (p.piece_type ?? "area") === "area" && p.template === areaTemplate,
  );
  const implied = new Set<number>();
  for (const instance of bm.instances) {
    if (snapshot.catalog.templates[instance.templateIndex]!.sizeClass !== sizeClass) continue;
    const raw = toBoardFrame(instance.x, instance.y);
    let nearest: { piece: RepoPiece; d: number } | null = null;
    for (const a of areas) {
      const d = Math.hypot(raw.x - a.position.x, raw.y - a.position.y);
      if (!nearest || d < nearest.d) nearest = { piece: a, d };
    }
    // 0.3" allows the nub-centroid correction (up to ~0.27") without admitting a
    // genuinely displaced piece.
    if (!nearest || nearest.d > 0.3) continue;
    const off = norm360((nearest.piece.rotation_degrees ?? 0) - instance.rotation);
    if (Math.abs(off - Math.round(off / 90) * 90) > 0.01) return null;
    implied.add(norm360(Math.round(off / 90) * 90));
  }
  return implied.size === 1 ? [...implied][0]! : null;
}

export interface TemplateCalibration {
  sizeClass: string;
  areaTemplate: string;
  /** The learned orientation offset, degrees clockwise in the y-down frame. */
  offset: number;
  candidates: number[];
  basis: OffsetBasis;
  /** Offset → part centres inside the footprint. Reported only; see the header. */
  polygonScores: Record<number, string>;
  /** Offset → worst off-board overhang across all placements, inches. */
  overhang: Record<number, number>;
  /** Offset → number of placements with any vertex off the board. */
  offBoardPlacements: Record<number, number>;
  /** Offset → mean position residual against agreeing placements, inches. */
  residuals: Record<number, number>;
  /**
   * Offset → mean absolute keystone-distance change across agreeing placements that
   * carry keystones, inches. The stage-4 tiebreak; see the file header.
   */
  keystoneDrift: Record<number, number>;
  /** Agreeing placements of this template that carry keystones. */
  keystoneSamples: number;
  /**
   * Separation between the best and runner-up keystone drift, inches. A large margin
   * means the vertex-index semantics genuinely distinguish the two candidates.
   */
  margin: number;
  /** Max distance from the 180°-rotated footprint back to its own outline, inches. */
  symmetry: number;
  /** Offset from the nubbed centroid to the artwork bbox centre, local inches. */
  anchorDelta: Vec2;
  /** What the hand-authored reference card implies, or null when it cannot speak. */
  referenceOffset: number | null;
}

export interface Calibration {
  ok: boolean;
  templates: TemplateCalibration[];
  /** Layouts in the snapshot with no committed counterpart (must be empty). */
  unmatchedLayouts: string[];
  /** Deployment-key disagreements against the committed corpus (must be empty). */
  deploymentMismatches: string[];
  /** Instances whose transformed position already agrees with the repo. */
  agreeing: number;
  totalInstances: number;
  errors: string[];
}

/** Position agreement tolerance, inches — generous enough for nub noise. */
const AGREE_TOL = 0.15;

/**
 * The keystone-derived distances of a single area piece at a given rotation.
 *
 * Isolates the piece into a one-piece layout so the shared
 * {@link keystoneMeasurements} contract does the measuring — the point of the
 * tiebreak is to compare what the *printed card* would say, so it must go through
 * the same code the cards do rather than a local reimplementation.
 */
function pieceKeystoneDistances(
  piece: RepoPiece,
  rotation: number,
  template: TerrainTemplate,
): number[] {
  const solo = {
    id: "calibration-probe",
    name: "calibration probe",
    pieces: [
      {
        id: piece.id ?? "probe",
        piece_type: "area" as const,
        template: template.id,
        footprint: piece.footprint,
        position: piece.position,
        rotation_degrees: rotation,
        mirror: piece.mirror,
        keystones: piece.keystones as never,
      },
    ],
  };
  try {
    return keystoneMeasurements(solo as never, [template]).map((m) => m.distance);
  } catch {
    // A keystone whose vertex index is out of range for this footprint tells us
    // nothing about the offset; drop it rather than biasing the score.
    return [];
  }
}

function maxSelfDistanceUnder180(poly: Vec2[]): number {
  const distToSeg = (p: Vec2, a: Vec2, b: Vec2): number => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  let worst = 0;
  for (const p of poly.map((v) => ({ x: -v.x, y: -v.y }))) {
    let nearest = Infinity;
    for (let i = 0; i < poly.length; i++) {
      nearest = Math.min(nearest, distToSeg(p, poly[i]!, poly[(i + 1) % poly.length]!));
    }
    worst = Math.max(worst, nearest);
  }
  return worst;
}

/**
 * Learn the conversion. Reads only the snapshot and the committed corpus; mutates
 * nothing.
 */
export function calibrate(
  snapshot: BmSnapshot,
  layouts: RepoLayout[],
  templates: TerrainTemplate[],
): Calibration {
  const byId = new Map(layouts.map((l) => [l.id, l]));
  const tmplById = new Map(templates.map((t) => [t.id, t]));
  const errors: string[] = [];
  const unmatchedLayouts: string[] = [];
  const deploymentMismatches: string[] = [];
  const reference = loadReferenceLayout();

  // ── Identity: every snapshot layout must resolve to a committed card, and its
  //    deployment key must agree with what we already ship.
  for (const bm of snapshot.layouts) {
    const id = repoLayoutId(bm);
    const repo = byId.get(id);
    if (!repo) {
      unmatchedLayouts.push(`${id} (Battlemaster "${bm.name}")`);
      continue;
    }
    const expected = DEPLOYMENT_KEY_TO_PATTERN[bm.deploymentKey];
    if (!expected) {
      deploymentMismatches.push(`${id}: unknown Battlemaster deployment key ${bm.deploymentKey}`);
    } else if (repo.deployment_pattern_id && repo.deployment_pattern_id !== expected) {
      deploymentMismatches.push(
        `${id}: key ${bm.deploymentKey} means "${expected}" but the card ships ` +
          `"${repo.deployment_pattern_id}"`,
      );
    }
  }

  // ── Per-template orientation offset.
  const results: TemplateCalibration[] = [];
  let agreeing = 0;
  let totalInstances = 0;

  for (const [sizeClass, areaTemplate] of Object.entries(SIZE_CLASS_TO_AREA_TEMPLATE)) {
    const tmpl = tmplById.get(areaTemplate);
    if (!tmpl) {
      errors.push(`area template "${areaTemplate}" is missing from the catalog`);
      continue;
    }
    const bmTemplates = snapshot.catalog.templates.filter((t) => t.sizeClass === sizeClass);
    if (bmTemplates.length === 0) {
      errors.push(`Battlemaster has no composite for size class "${sizeClass}"`);
      continue;
    }

    // Stage 1 — bbox narrows to two candidates.
    const rb = footprintBounds(tmpl.footprint);
    const rw = rb.maxX - rb.minX;
    const rh = rb.maxY - rb.minY;
    const bm = bmTemplates[0]!;
    const same = Math.abs(bm.width - rw) + Math.abs(bm.height - rh);
    const swapped = Math.abs(bm.width - rh) + Math.abs(bm.height - rw);
    const candidates = same <= swapped ? [0, 180] : [90, 270];

    const poly = centroidLocalPolygon(tmpl.footprint);
    const anchorDelta = centroidToBoundsCentre(tmpl.footprint);
    const symmetry = maxSelfDistanceUnder180(poly);

    // Stage 2 — point-in-polygon over every part of every composite in the class.
    const polygonScores: Record<number, string> = {};
    const inside: Record<number, number> = {};
    let partTotal = 0;
    for (const off of candidates) {
      let hit = 0;
      partTotal = 0;
      for (const t of bmTemplates) {
        for (const p of t.parts) {
          const part = snapshot.catalog.parts[p.partIndex]!;
          const cUp = partCentreYUp(part.width, part.height, p.x, p.y, p.rotation, p.mirror);
          const r = rotateCw({ x: cUp.x, y: -cUp.y }, off);
          partTotal++;
          if (pointInPolygon({ x: r.x + anchorDelta.x, y: r.y + anchorDelta.y }, poly)) hit++;
        }
      }
      inside[off] = hit;
      polygonScores[off] = `${hit}/${partTotal}`;
    }

    // Stage 2b — on-board placement. Resolve every actual placement of this template
    // under each candidate and measure how far it overhangs the board. Unbiased: it
    // uses the real Battlemaster positions and asks only whether the terrain fits on
    // the table.
    const overhang: Record<number, number> = {};
    const offBoardPlacements: Record<number, number> = {};
    for (const off of candidates) {
      let worst = 0;
      let bad = 0;
      for (const bmLayout of snapshot.layouts) {
        for (const instance of bmLayout.instances) {
          const t = snapshot.catalog.templates[instance.templateIndex]!;
          if (t.sizeClass !== sizeClass) continue;
          const rotation = norm360(instance.rotation + off);
          const position = areaPositionFromInstance(instance, tmpl.footprint, rotation, "none");
          let pieceWorst = 0;
          for (const v of orientedOffsets(tmpl.footprint, rotation, "none")) {
            const x = v.x + position.x;
            const y = v.y + position.y;
            pieceWorst = Math.max(
              pieceWorst,
              Math.max(0, -x, -y, x - BOARD.width, y - BOARD.height),
            );
          }
          if (pieceWorst > 0.01) bad++;
          worst = Math.max(worst, pieceWorst);
        }
      }
      overhang[off] = worst;
      offBoardPlacements[off] = bad;
    }

    // Stage 3 — collect the agreeing placements, then score each candidate by
    // position residual (reported, though degenerate on symmetric layouts) and by
    // keystone drift (the tiebreak that actually carries meaning).
    const agreeingPieces: { piece: RepoPiece; instance: BmInstance }[] = [];
    for (const bmLayout of snapshot.layouts) {
      const repo = byId.get(repoLayoutId(bmLayout));
      if (!repo) continue;
      const areas = (repo.pieces ?? []).filter(
        (p) => (p.piece_type ?? "area") === "area" && p.template === areaTemplate,
      );
      for (const instance of bmLayout.instances) {
        const t = snapshot.catalog.templates[instance.templateIndex]!;
        if (t.sizeClass !== sizeClass) continue;
        const raw = toBoardFrame(instance.x, instance.y);
        let nearest: { piece: RepoPiece; d: number } | null = null;
        for (const a of areas) {
          const d = Math.hypot(raw.x - a.position.x, raw.y - a.position.y);
          if (!nearest || d < nearest.d) nearest = { piece: a, d };
        }
        if (nearest && nearest.d <= AGREE_TOL) agreeingPieces.push({ piece: nearest.piece, instance });
      }
    }

    const residuals: Record<number, number> = {};
    const keystoneDrift: Record<number, number> = {};
    let keystoneSamples = 0;
    for (const off of candidates) {
      let posSum = 0;
      let posN = 0;
      let ksSum = 0;
      let ksN = 0;
      const carried = rotateCw(anchorDelta, off);
      for (const { piece, instance } of agreeingPieces) {
        const raw = toBoardFrame(instance.x, instance.y);
        posSum += Math.hypot(raw.x - carried.x - piece.position.x, raw.y - carried.y - piece.position.y);
        posN++;
        if (!piece.keystones || piece.keystones.length === 0) continue;
        const before = pieceKeystoneDistances(piece, piece.rotation_degrees ?? 0, tmpl);
        const after = pieceKeystoneDistances(piece, norm360(instance.rotation + off), tmpl);
        if (before.length !== after.length) continue;
        for (let i = 0; i < before.length; i++) ksSum += Math.abs(before[i]! - after[i]!);
        ksN += before.length;
      }
      residuals[off] = posN > 0 ? posSum / posN : Number.POSITIVE_INFINITY;
      keystoneDrift[off] = ksN > 0 ? ksSum / ksN : Number.POSITIVE_INFINITY;
      keystoneSamples = ksN;
    }

    // Decide: on-board first (decisive for an asymmetric footprint), then the
    // hand-authored reference card, then keystones.
    const onBoard = candidates.filter((o) => offBoardPlacements[o] === 0);
    const fromReference =
      reference !== null ? referenceOffset(reference, snapshot, sizeClass, areaTemplate) : null;
    let offset: number;
    let basis: OffsetBasis;
    if (onBoard.length === 1) {
      offset = onBoard[0]!;
      basis = "bbox+on-board";
    } else if (fromReference !== null && candidates.includes(fromReference)) {
      offset = fromReference;
      basis = "bbox+reference-card";
    } else {
      const pool = onBoard.length > 0 ? onBoard : candidates;
      const sorted = [...pool].sort((a, b) => keystoneDrift[a]! - keystoneDrift[b]!);
      offset = sorted[0]!;
      basis = Number.isFinite(keystoneDrift[offset]!) ? "bbox+keystones" : "bbox-only";
    }
    const sortedAll = [...candidates].sort((a, b) => keystoneDrift[a]! - keystoneDrift[b]!);
    const margin =
      sortedAll.length > 1 && Number.isFinite(keystoneDrift[sortedAll[1]!]!)
        ? Math.abs(keystoneDrift[sortedAll[1]!]! - keystoneDrift[sortedAll[0]!]!)
        : Number.POSITIVE_INFINITY;

    if (offset % 90 !== 0) {
      errors.push(
        `${areaTemplate}: learned orientation offset ${offset}° is not a multiple of 90° — ` +
          `the frame model is wrong, not the template`,
      );
    }

    results.push({
      sizeClass,
      areaTemplate,
      offset,
      candidates,
      basis,
      polygonScores,
      overhang,
      offBoardPlacements,
      referenceOffset: fromReference,
      residuals,
      keystoneDrift,
      keystoneSamples,
      margin,
      symmetry,
      anchorDelta,
    });
  }

  // ── Corpus-wide agreement count, for the report's headline.
  for (const bmLayout of snapshot.layouts) {
    const repo = byId.get(repoLayoutId(bmLayout));
    totalInstances += bmLayout.instances.length;
    if (!repo) continue;
    for (const instance of bmLayout.instances) {
      const t = snapshot.catalog.templates[instance.templateIndex]!;
      const areaTemplate = SIZE_CLASS_TO_AREA_TEMPLATE[t.sizeClass];
      const raw = toBoardFrame(instance.x, instance.y);
      const areas = (repo.pieces ?? []).filter(
        (p) => (p.piece_type ?? "area") === "area" && p.template === areaTemplate,
      );
      const nearest = Math.min(
        ...areas.map((a) => Math.hypot(raw.x - a.position.x, raw.y - a.position.y)),
        Infinity,
      );
      if (nearest <= AGREE_TOL) agreeing++;
    }
  }

  if (unmatchedLayouts.length > 0) {
    errors.push(
      `${unmatchedLayouts.length} Battlemaster layout(s) have no committed card — the upstream ` +
        `card set changed; reconcile ids before ingesting`,
    );
  }
  if (deploymentMismatches.length > 0) {
    errors.push(`${deploymentMismatches.length} deployment-pattern disagreement(s)`);
  }

  return {
    ok: errors.length === 0,
    templates: results,
    unmatchedLayouts,
    deploymentMismatches,
    agreeing,
    totalInstances,
    errors,
  };
}

/** The learned offset per area template, for the other subcommands. */
export function offsetMap(cal: Calibration): Record<string, number> {
  return Object.fromEntries(cal.templates.map((t) => [t.areaTemplate, t.offset]));
}

export function formatCalibrationReport(cal: Calibration): string {
  const out: string[] = [];
  out.push("Battlemaster → 40kdc calibration");
  out.push("");
  out.push(`  board            ${BOARD.width}″ × ${BOARD.height}″, corner origin, y-down`);
  out.push(`  transform        x + ${BOARD.width / 2},  ${BOARD.height / 2} − y`);
  out.push(
    `  identity         ${cal.totalInstances - 0} instances across ${cal.templates.length} area templates; ` +
      `${cal.agreeing} already agree within ${AGREE_TOL}″`,
  );
  out.push("");
  out.push("  orientation offsets");
  for (const t of cal.templates) {
    const marginTxt = Number.isFinite(t.margin) ? `${t.margin.toFixed(4)}″` : "n/a";
    out.push(
      `    ${t.areaTemplate.padEnd(17)} ${t.sizeClass}  offset=${String(t.offset).padStart(3)}°  ` +
        `basis=${t.basis.padEnd(13)} candidates=${t.candidates.join("/")}`,
    );
    out.push(
      `      on-board  ${Object.entries(t.overhang)
        .map(([o, v]) => `${o}°:${v > 0.01 ? `${v.toFixed(3)}″ over (${t.offBoardPlacements[Number(o)]} placements)` : "clean"}`)
        .join("   ")}`,
    );
    out.push(
      `      reference card  ${t.referenceOffset === null ? "cannot speak (oblique or displaced)" : `implies ${t.referenceOffset}°`}`,
    );
    out.push(
      `      polygon (reported, not decisive)  ${Object.entries(t.polygonScores)
        .map(([o, s]) => `${o}°:${s}`)
        .join("  ")}`,
    );
    out.push(
      `      position residual  ${Object.entries(t.residuals)
        .map(([o, r]) => `${o}°:${Number.isFinite(r) ? `${r.toFixed(4)}″` : "—"}`)
        .join("  ")}` +
        (t.candidates.length > 1 &&
        Number.isFinite(t.residuals[t.candidates[0]!]!) &&
        Math.abs(t.residuals[t.candidates[0]!]! - t.residuals[t.candidates[1]!]!) < 1e-9
          ? "   (degenerate — every card is 180°-symmetric, so position cannot decide)"
          : ""),
    );
    out.push(
      `      keystone drift     ${Object.entries(t.keystoneDrift)
        .map(([o, r]) => `${o}°:${Number.isFinite(r) ? `${r.toFixed(4)}″` : "—"}`)
        .join("  ")}   over ${t.keystoneSamples} keystone(s)`,
    );
    out.push(
      `      180°-self-symmetry ${t.symmetry.toFixed(4)}″   decision margin ${marginTxt}` +
        (t.basis === "bbox+keystones"
          ? "   (chosen to preserve which vertex each card measures)"
          : t.basis === "bbox+on-board"
            ? "   (chosen because the alternative pushes terrain off the table)"
            : t.basis === "bbox+reference-card"
              ? "   (taken from the one hand-authored card)"
              : ""),
    );
  }

  if (cal.unmatchedLayouts.length > 0) {
    out.push("");
    out.push("  UNMATCHED LAYOUTS");
    for (const l of cal.unmatchedLayouts) out.push(`    ✗ ${l}`);
  }
  if (cal.deploymentMismatches.length > 0) {
    out.push("");
    out.push("  DEPLOYMENT MISMATCHES");
    for (const m of cal.deploymentMismatches) out.push(`    ✗ ${m}`);
  }

  out.push("");
  if (cal.ok) {
    out.push("  ✓ calibration clean — every offset is a multiple of 90°, ids and deployments agree.");
  } else {
    out.push("  ✗ CALIBRATION FAILED");
    for (const e of cal.errors) out.push(`      ${e}`);
  }
  return out.join("\n");
}
