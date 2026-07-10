/**
 * Keystone twin pairing for `data/core/terrain-layouts.json`: every authored
 * measurement keystone should have its point-reflected counterpart on the
 * piece's 180°-symmetry twin, so a layout card prints dimension lines for
 * BOTH players' halves (the layout editor now maintains this invariant on
 * add/remove; this script back-fills the existing data and re-audits it).
 *
 * Twins are not stored — they are recovered the way the editor's
 * `autoPairTwins` does: same template, unparented, centroid within 0.75″ of
 * the point reflection through the board centre. The mirrored keystone flips
 * its board edge (left↔right, top↔bottom); a face ref flips its side, and a
 * vertex ref is resolved GEOMETRICALLY — reflect the source vertex through
 * the centre and take the twin's nearest vertex. Index arithmetic is not
 * safe: many layouts store the twin at the same angle (not θ+180), so vertex
 * i on one side need not be vertex i on the other. A reflection that lands
 * more than 0.25″ from every twin vertex is skipped with a warning rather
 * than guessed.
 *
 * Usage (from `tools/`):
 *   npx tsx src/migrate-keystone-twins.ts            # write missing mirrors
 *   npx tsx src/migrate-keystone-twins.ts --check    # report only; exit 1 if any are missing
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  orientedOffsets,
  type BoardEdge,
  type Footprint,
  type Keystone,
  type LayoutPiece,
  type TerrainLayout,
  type TerrainTemplate,
  type Vec2,
} from "./terrain/resolve.js";

const BOARD = { width: 60, height: 44 } as const;
/** Twin pairing tolerance on the point-reflected centroid (matches the editor). */
const POS_TOL = 0.75;
/** A piece this close to the board centre is self-symmetric and has no twin. */
const CENTRE_TOL = 0.3;
/** How close (inches) the reflected vertex must land to a twin vertex. */
const VERT_EPS = 0.25;

const REPO_ROOT = join(new URL("../..", import.meta.url).pathname);
const LAYOUTS_PATH = join(REPO_ROOT, "data", "core", "terrain-layouts.json");
const TEMPLATES_PATH = join(REPO_ROOT, "data", "core", "terrain-templates.json");

// ---- geometry --------------------------------------------------------------

const flipEdge = (e: BoardEdge): BoardEdge =>
  e === "left" ? "right" : e === "right" ? "left" : e === "top" ? "bottom" : "top";
const flipSide = (s: "min-x" | "max-x" | "min-y" | "max-y"): "min-x" | "max-x" | "min-y" | "max-y" =>
  s === "min-x" ? "max-x" : s === "max-x" ? "min-x" : s === "min-y" ? "max-y" : "min-y";

const sameRef = (a: Keystone["ref"], b: Keystone["ref"]): boolean =>
  a.kind === "vertex" && b.kind === "vertex"
    ? a.index === b.index
    : a.kind === "face" && b.kind === "face"
      ? a.side === b.side
      : false;
const hasKeystone = (p: LayoutPiece, k: Keystone): boolean =>
  (p.keystones ?? []).some((e) => e.edge === k.edge && sameRef(e.ref, k.ref));

/** Board-space vertices of an UNPARENTED piece (centroid + oriented offsets). */
function boardVertices(p: LayoutPiece, templates: Map<string, TerrainTemplate>): Vec2[] | null {
  const fp: Footprint | undefined = p.footprint ?? (p.template ? templates.get(p.template)?.footprint : undefined);
  if (!fp) return null;
  const offsets = orientedOffsets(fp, p.rotation_degrees ?? 0, p.mirror ?? "none");
  return offsets.map((o) => ({ x: p.position.x + o.x, y: p.position.y + o.y }));
}

/**
 * The keystone `k` mirrored from `primary` onto `twin`, or null (with a
 * reason) when the vertex reflection has no close-enough twin vertex.
 */
function mirrorKeystone(
  k: Keystone,
  primaryVerts: Vec2[],
  twinVerts: Vec2[],
  board: { width: number; height: number },
): { keystone: Keystone } | { error: string } {
  const edge = flipEdge(k.edge);
  if (k.ref.kind === "face") return { keystone: { edge, ref: { kind: "face", side: flipSide(k.ref.side) } } };
  const anchor = primaryVerts[k.ref.index];
  if (!anchor) return { error: `vertex index ${k.ref.index} out of range` };
  const reflected = { x: board.width - anchor.x, y: board.height - anchor.y };
  let bestIndex = -1;
  let best = Infinity;
  twinVerts.forEach((v, i) => {
    const d = Math.hypot(v.x - reflected.x, v.y - reflected.y);
    if (d < best) {
      best = d;
      bestIndex = i;
    }
  });
  if (bestIndex < 0 || best > VERT_EPS) {
    return { error: `reflected vertex lands ${best.toFixed(2)}″ from the nearest twin vertex (> ${VERT_EPS}″)` };
  }
  return { keystone: { edge, ref: { kind: "vertex", index: bestIndex } } };
}

// ---- pairing + audit -------------------------------------------------------

export interface PairingAddition {
  layoutId: string;
  /** The piece RECEIVING the mirrored keystone. */
  pieceId: string;
  /** The piece whose keystone was mirrored. */
  fromPieceId: string;
  keystone: Keystone;
}

export interface PairingReport {
  /** Mirrors that are missing (check mode) / were added (write mode). */
  additions: PairingAddition[];
  /** Keystone-bearing pieces we could not pair or mirror, with the reason. */
  warnings: string[];
}

/**
 * Scan every layout for keystones whose symmetry twin lacks the mirror.
 * `apply` mutates the layout objects in place (appending the mirrors);
 * check mode leaves them untouched. Either way the report lists every
 * addition and every piece that could not be handled.
 */
export function pairKeystones(
  layouts: TerrainLayout[],
  templates: TerrainTemplate[],
  apply: boolean,
): PairingReport {
  const byId = new Map(templates.map((t) => [t.id, t]));
  const additions: PairingAddition[] = [];
  const warnings: string[] = [];

  for (const layout of layouts) {
    const pieces = layout.pieces ?? [];
    // Twin reflection is through the board centre, so it must use THIS layout's
    // board (e.g. the 36×36 KOTC colosseum), not the 60×44 default — otherwise
    // a non-standard board reflects every piece into empty space and nothing pairs.
    const board = (layout as { board?: { width: number; height: number } }).board ?? BOARD;
    // Twin pairing pass (unparented, off-centre, same template, reflected centroid).
    const twin = new Map<LayoutPiece, LayoutPiece>();
    for (const p of pieces) {
      if (twin.has(p) || p.parent_area_id) continue;
      const onCentre =
        Math.abs(p.position.x - board.width / 2) < CENTRE_TOL &&
        Math.abs(p.position.y - board.height / 2) < CENTRE_TOL;
      if (onCentre) continue;
      const want = { x: board.width - p.position.x, y: board.height - p.position.y };
      const match = pieces.find(
        (q) =>
          q !== p &&
          !twin.has(q) &&
          !q.parent_area_id &&
          q.template === p.template &&
          Math.hypot(q.position.x - want.x, q.position.y - want.y) <= POS_TOL,
      );
      if (match) {
        twin.set(p, match);
        twin.set(match, p);
      }
    }

    for (const p of pieces) {
      if (!p.keystones?.length) continue;
      const label = `${layout.id}/${p.id ?? p.name ?? "?"}`;
      if (p.parent_area_id) {
        warnings.push(`${label}: keystones on a parented feature — pair by hand`);
        continue;
      }
      const t = twin.get(p);
      if (!t) {
        const onCentre =
          Math.abs(p.position.x - board.width / 2) < CENTRE_TOL &&
          Math.abs(p.position.y - board.height / 2) < CENTRE_TOL;
        if (!onCentre) warnings.push(`${label}: no symmetry twin found — pair by hand`);
        continue; // centre pieces are their own mirror; nothing to do
      }
      const pv = boardVertices(p, byId);
      const tv = boardVertices(t, byId);
      if (!pv || !tv) {
        warnings.push(`${label}: missing footprint on the pair — pair by hand`);
        continue;
      }
      for (const k of p.keystones) {
        const m = mirrorKeystone(k, pv, tv, board);
        if ("error" in m) {
          warnings.push(`${label} [${k.edge}/${JSON.stringify(k.ref)}]: ${m.error}`);
          continue;
        }
        if (hasKeystone(t, m.keystone)) continue;
        additions.push({
          layoutId: layout.id,
          pieceId: t.id ?? "?",
          fromPieceId: p.id ?? "?",
          keystone: m.keystone,
        });
        if (apply) t.keystones = [...(t.keystones ?? []), m.keystone];
      }
    }
  }
  return { additions, warnings };
}

// ---- CLI -------------------------------------------------------------------

function main(): void {
  const check = process.argv.includes("--check");
  const layouts = JSON.parse(readFileSync(LAYOUTS_PATH, "utf8")) as TerrainLayout[];
  const templates = JSON.parse(readFileSync(TEMPLATES_PATH, "utf8")) as TerrainTemplate[];

  const report = pairKeystones(layouts, templates, !check);

  for (const w of report.warnings) console.warn(`warn: ${w}`);
  const byLayout = new Map<string, number>();
  for (const a of report.additions) byLayout.set(a.layoutId, (byLayout.get(a.layoutId) ?? 0) + 1);
  for (const [id, n] of byLayout) console.log(`${check ? "missing" : "added"}: ${id} — ${n} keystone(s)`);
  console.log(
    `${report.additions.length} mirrored keystone(s) ${check ? "missing" : "added"} across ${byLayout.size} layout(s); ${report.warnings.length} warning(s)`,
  );

  if (check) {
    if (report.additions.length > 0) process.exit(1);
    return;
  }
  if (report.additions.length > 0) {
    writeFileSync(LAYOUTS_PATH, JSON.stringify(layouts, null, 2) + "\n");
    console.log(`wrote ${LAYOUTS_PATH}`);
  }
}

// Direct-invocation entry point (`npx tsx src/migrate-keystone-twins.ts [--check]`).
const isMain =
  process.argv[1] &&
  resolve(process.argv[1]).replace(/\.\w+$/, "") === fileURLToPath(import.meta.url).replace(/\.\w+$/, "");
if (isMain) main();
