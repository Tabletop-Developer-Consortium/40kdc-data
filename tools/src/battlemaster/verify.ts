/**
 * Post-write invariants for the committed terrain layouts.
 *
 * Schema validation and referential integrity already run inside
 * `applyWrites`; this checks the things only geometry knows:
 *
 * - every layout resolves without a {@link resolveLayout} error;
 * - every resolved vertex lands on the board;
 * - every Chapter Approved card stays 180°-rotationally symmetric to within
 *   {@link SYMMETRY_LIMIT}, with any residual asymmetry reported.
 *
 * The symmetry check is the strong one. The 45 Chapter Approved cards are
 * 180°-symmetric by construction (GW prints them that way so both players get
 * mirror-image terrain), and it is a global property that no per-piece transform bug
 * survives: a wrong rotation offset, anchor compensation or instance assignment shows
 * up here even when every individual piece looks plausible.
 *
 * Also used as a pre-write gate by `extract.ts`, so a dry run fails on exactly what a
 * `--write` would have produced.
 */
import { resolveLayout } from "../terrain/resolve.js";
import { BOARD, loadRepoLayouts, loadRepoTemplates, type RepoLayout } from "./repo.js";
import { offBoard } from "./geometry.js";

/**
 * Asymmetry above this is treated as a transform bug, inches.
 *
 * The Chapter Approved cards are 180°-symmetric by design, and the committed corpus
 * was exactly so before the intake — which makes symmetry the best global check on a
 * geometry rewrite. But it is not exact upstream: Battlemaster's own data places the
 * paired centre trapezoids of `disruption-vs-disruption-1` and
 * `reconnaissance-vs-reconnaissance-2` 0.71″ off perfect symmetry. Faithfully
 * reproducing the source means reproducing that, so the gate allows a sub-inch source
 * quirk while still catching the failure mode it exists for — a wrong offset, anchor
 * or assignment displaces a piece by inches or flips it across the board.
 */
const SYMMETRY_LIMIT = 1.5;

export interface VerifyResult {
  ok: boolean;
  checked: number;
  resolveFailures: string[];
  offBoard: string[];
  asymmetric: string[];
  /** Worst sub-limit asymmetry seen, reported so a source quirk stays visible. */
  symmetryNotes: string[];
  /** Layouts skipped by the symmetry check because they are not CA cards. */
  skipped: string[];
}

/**
 * How far the layout is from 180°-rotational symmetry about the board centre, in
 * inches: the worst, over all area pieces, of the distance from a piece's 180° image
 * to the nearest same-template piece.
 */
export function symmetryError(layout: RepoLayout): { worst: number; pieceId: string | null } {
  const areas = (layout.pieces ?? []).filter((p) => (p.piece_type ?? "area") === "area");
  const w = layout.board?.width ?? BOARD.width;
  const h = layout.board?.height ?? BOARD.height;
  let worst = 0;
  let pieceId: string | null = null;
  for (const a of areas) {
    const tx = w - a.position.x;
    const ty = h - a.position.y;
    let nearest = Infinity;
    for (const b of areas) {
      if (b.template !== a.template) continue;
      nearest = Math.min(nearest, Math.hypot(b.position.x - tx, b.position.y - ty));
    }
    if (nearest > worst) {
      worst = nearest;
      pieceId = a.id ?? null;
    }
  }
  return { worst, pieceId };
}

export function verify(layouts: RepoLayout[], templates: ReturnType<typeof loadRepoTemplates>): VerifyResult {
  const resolveFailures: string[] = [];
  const offBoardIssues: string[] = [];
  const asymmetric: string[] = [];
  const symmetryNotes: string[] = [];
  const skipped: string[] = [];

  for (const layout of layouts) {
    let resolved;
    try {
      resolved = resolveLayout(layout as never, templates as never);
    } catch (e) {
      resolveFailures.push(`${layout.id}: ${(e as Error).message}`);
      continue;
    }
    const w = layout.board?.width ?? BOARD.width;
    const h = layout.board?.height ?? BOARD.height;
    for (const piece of resolved) {
      const bad = piece.vertices.filter((v) =>
        w === BOARD.width && h === BOARD.height
          ? offBoard(v)
          : v.x < -0.5 || v.y < -0.5 || v.x > w + 0.5 || v.y > h + 0.5,
      );
      if (bad.length > 0) {
        offBoardIssues.push(
          `${layout.id}/${piece.id ?? "?"}: ${bad.length} vertex/vertices off the ${w}×${h} board ` +
            `(e.g. ${bad[0]!.x.toFixed(2)}, ${bad[0]!.y.toFixed(2)})`,
        );
        break;
      }
    }
    // Symmetry applies to the Chapter Approved cards; `kotc-colosseum` is a
    // deliberately asymmetric arena and is not one.
    if (layout.mission_matchup_id && layout.variant !== undefined) {
      const sym = symmetryError(layout);
      if (sym.worst > SYMMETRY_LIMIT) {
        asymmetric.push(
          `${layout.id}: ${sym.worst.toFixed(3)}" at ${sym.pieceId ?? "?"} ` +
            `(limit ${SYMMETRY_LIMIT}")`,
        );
      } else if (sym.worst > 0.01) {
        symmetryNotes.push(`${layout.id}: ${sym.worst.toFixed(3)}" at ${sym.pieceId ?? "?"}`);
      }
    } else {
      skipped.push(layout.id);
    }
  }

  return {
    ok: resolveFailures.length === 0 && offBoardIssues.length === 0 && asymmetric.length === 0,
    checked: layouts.length,
    resolveFailures,
    offBoard: offBoardIssues,
    asymmetric,
    symmetryNotes,
    skipped,
  };
}

export function runVerify(): void {
  const layouts = loadRepoLayouts();
  const templates = loadRepoTemplates();
  const r = verify(layouts, templates);

  console.log("Terrain layout invariants");
  console.log("");
  console.log(`  layouts checked            ${r.checked}`);
  console.log(`  resolve failures           ${r.resolveFailures.length}`);
  console.log(`  layouts with off-board geo ${r.offBoard.length}`);
  console.log(
    `  180°-asymmetric CA cards   ${r.asymmetric.length}` +
      (r.skipped.length > 0 ? `   (skipped, not CA: ${r.skipped.join(", ")})` : ""),
  );

  for (const f of r.resolveFailures) console.error(`    ✗ resolve  ${f}`);
  for (const f of r.offBoard) console.error(`    ✗ off-board ${f}`);
  for (const f of r.asymmetric) console.error(`    ✗ asymmetric ${f}`);
  for (const n of r.symmetryNotes) console.log(`    · sub-limit asymmetry (matches source): ${n}`);

  console.log("");
  if (r.ok) {
    console.log("  ✓ all layouts resolve, sit on the board, and keep 180° symmetry.");
  } else {
    console.error("  ✗ VERIFY FAILED");
    process.exit(1);
  }
}
