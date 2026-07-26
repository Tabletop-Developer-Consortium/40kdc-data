/**
 * The 40kdc side of the Battlemaster intake: loading the committed layouts and
 * template catalog, and the two identity maps that tie a Battlemaster layout to
 * the repo layout it replaces.
 *
 * Both maps are asserted, never inferred at runtime. They were derived by
 * comparing the full Battlemaster catalog against the committed corpus (45/45
 * agreement on both), so a disagreement means the upstream card set changed and
 * the intake must stop rather than silently relabel a card.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "../mfm/repo-files.js";
import type { Footprint, TerrainTemplate, Vec2 } from "../terrain/resolve.js";
import { footprintVertices, polygonCentroid } from "../terrain/resolve.js";
import type { Archetype, BmLayout } from "./source.js";

export const LAYOUTS_PATH = join(REPO_ROOT, "data", "core", "terrain-layouts.json");
export const TEMPLATES_PATH = join(REPO_ROOT, "data", "core", "terrain-templates.json");
/** Where the ingest reports land, alongside the MFM ingest's `mfm-*.md`. */
export const REPORT_DIR = join(REPO_ROOT, "data", "core", "_reports");

/** The board every Chapter Approved card is authored on. */
export const BOARD = { width: 60, height: 44 } as const;

/**
 * Battlemaster's five composite size classes → the 40kdc area template each one
 * denotes. Verified two ways: the class bounding boxes match the template
 * footprint bounding boxes (`br` 11.503x7.003 vs area-large 11.5x7.536 — the
 * template is taller because its footprint carries nubs), and every layout's
 * per-class instance multiset matches the committed layout's per-template area
 * multiset exactly.
 */
export const SIZE_CLASS_TO_AREA_TEMPLATE: Record<string, string> = {
  br: "area-large",
  tr: "area-trapezoid",
  sr: "area-medium",
  ll: "area-long-line",
  sl: "area-short-line",
};

/**
 * Battlemaster's Chapter Approved deployment key → the 40kdc deployment pattern.
 * Unanimous across all 45 layouts against the committed corpus.
 */
export const DEPLOYMENT_KEY_TO_PATTERN: Record<number, string> = {
  1: "search-and-destroy",
  2: "dawn-of-war",
  3: "hammer-and-anvil",
  4: "crucible-of-battle",
  5: "sweeping-engagement",
  6: "tipping-point",
};

/**
 * Battlemaster objective codes → the 40kdc `objective_role`. `c*` are the two
 * centre pieces of a linked centre objective, `n` the no-man's-land expansion
 * objectives, `h*` the two home objectives (the suffix names the board side).
 */
export const OBJECTIVE_CODE_TO_ROLE: Record<string, "home" | "expansion" | "center"> = {
  c: "center",
  c1: "center",
  c2: "center",
  n: "expansion",
  hb: "home",
  hr: "home",
  hl: "home",
  ht: "home",
};

/** A layout piece as committed, with the fields this ingest reads or preserves. */
export interface RepoPiece {
  id?: string;
  name?: string;
  piece_type?: "area" | "feature";
  template?: string;
  footprint?: Footprint;
  position: Vec2;
  rotation_degrees?: number;
  mirror?: "none" | "horizontal" | "vertical";
  parent_area_id?: string;
  floor?: number;
  height_inches?: number;
  terrain_area_keywords?: string[];
  link_group?: string;
  objective_role?: "home" | "expansion" | "center";
  is_objective?: boolean;
  objective?: { position?: Vec2; control_range_inches?: number };
  keystones?: { edge: string; ref: Record<string, unknown> }[];
  terrain?: boolean;
}

export interface RepoLayout {
  id: string;
  name: string;
  source?: string;
  description?: string;
  mission_matchup_id?: string;
  variant?: number;
  deployment_pattern_id?: string;
  board?: { width: number; height: number };
  pieces?: RepoPiece[];
  game_version: { edition: string; dataslate: string };
}

export function loadRepoLayouts(): RepoLayout[] {
  return JSON.parse(readFileSync(LAYOUTS_PATH, "utf8")) as RepoLayout[];
}

export function loadRepoTemplates(): TerrainTemplate[] {
  return JSON.parse(readFileSync(TEMPLATES_PATH, "utf8")) as TerrainTemplate[];
}

/**
 * The repo layout id a Battlemaster slot denotes. Mirror matchups (same
 * archetype both sides) are named `<archetype>-mirror-<n>` for take-and-hold and
 * `<a>-vs-<b>-<n>` otherwise — the corpus's own convention, reproduced here and
 * asserted against the committed ids by the caller.
 */
export function repoLayoutId(bm: Pick<BmLayout, "archetypeA" | "archetypeB" | "slotIndex">): string {
  const { archetypeA: a, archetypeB: b, slotIndex: n } = bm;
  if (a === b && a === "take-and-hold") return `${a}-mirror-${n}`;
  return `${a}-vs-${b}-${n}`;
}

/** The matchup id a Battlemaster slot denotes (drops the variant suffix). */
export function repoMatchupId(bm: Pick<BmLayout, "archetypeA" | "archetypeB">): string {
  return `${bm.archetypeA}-vs-${bm.archetypeB}`;
}

export type ArchetypePair = `${Archetype}|${Archetype}`;

// ── Geometry helpers shared by calibration and extraction ────────────────────

/**
 * Battlemaster's frame is centre-origin, y-up; the 40kdc `vec2` frame is
 * corner-origin, y-down (`common.schema.json#/$defs/vec2`). All 45 Chapter
 * Approved layouts are 180°-rotationally symmetric, so this and its 180°
 * counterpart are indistinguishable on positions alone — the rotation-offset
 * gate in `calibrate.ts` is what pins this one as correct.
 */
export function toBoardFrame(x: number, y: number): Vec2 {
  return { x: x + BOARD.width / 2, y: BOARD.height / 2 - y };
}

/** Axis-aligned bounding box of a footprint, in natural local coordinates. */
export function footprintBounds(fp: Footprint): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const verts = footprintVertices(fp);
  const xs = verts.map((v) => v.x);
  const ys = verts.map((v) => v.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

/**
 * The offset from a footprint's polygon area centroid to its bounding-box centre,
 * in natural local coordinates.
 *
 * This is the whole nub story. Battlemaster anchors a placement at the *bbox
 * centre* of the un-nubbed artwork; 40kdc anchors at the *area centroid* of the
 * nubbed die-cut footprint. For a symmetric footprint the two coincide (hence
 * positions that already agree to 0.01-0.06"), but a nubbed or asymmetric one
 * (area-trapezoid, the line areas) separates them by inches. Extraction adds
 * `R·M·(this)` to the transformed position so the piece lands where Battlemaster
 * put it — the same compensation `ingest-terrain-footprints.ts` applies when a
 * template footprint changes.
 */
export function centroidToBoundsCentre(fp: Footprint): Vec2 {
  const verts = footprintVertices(fp);
  const c = polygonCentroid(verts);
  const b = footprintBounds(fp);
  return { x: (b.minX + b.maxX) / 2 - c.x, y: (b.minY + b.maxY) / 2 - c.y };
}

/** Normalise any angle into `[0, 360)`. */
export function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Signed shortest angular difference `a - b`, in `(-180, 180]`. */
export function angleDelta(a: number, b: number): number {
  const d = norm360(a - b);
  return d > 180 ? d - 360 : d;
}

export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
