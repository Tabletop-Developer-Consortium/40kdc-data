/**
 * Project a Battlemaster layout into 40kdc `pieces[]`.
 *
 * The pure core of the intake: snapshot + calibration + part mapping in, layout
 * pieces out, no I/O and no mutation of the committed corpus. `extract.ts` wraps it
 * with reporting and persistence, and the tests drive it directly.
 *
 * ## What is taken and what is kept
 *
 * Geometry is taken from Battlemaster — every `position`, `rotation_degrees` and
 * `mirror`, and which feature sits inside which area. Everything that identifies the
 * card or encodes authoring intent is kept from the committed record: `id`, `name`,
 * `objective_role`, `is_objective`, `link_group`, `keystones`, `height_inches`,
 * `terrain_area_keywords`, `floor`, `terrain`.
 *
 * Carrying those forward needs each Battlemaster instance paired with the committed
 * area it replaces, which is what `pairInstances` does — by **optimal assignment**
 * within each (layout, area template) group, not greedy nearest. Greedy is wrong
 * here: the placements most in need of correction are 1-6″ out, exactly where a
 * greedy pass steals another piece's partner.
 *
 * ## Piece ids
 *
 * Ids are stable and meaningful (`area-large-1`, `corner-short-3`) and other data
 * points at them (`parent_area_id`), so a paired area keeps its committed id and only
 * genuinely new pieces get a freshly minted one. Children are renumbered per layout
 * because their identity is positional, not semantic.
 */
import type { Mirror, TerrainTemplate, Vec2 } from "../terrain/resolve.js";
import {
  BOARD,
  OBJECTIVE_CODE_TO_ROLE,
  SIZE_CLASS_TO_AREA_TEMPLATE,
  centroidToBoundsCentre,
  norm360,
  repoLayoutId,
  round4,
  toBoardFrame,
  type RepoLayout,
  type RepoPiece,
} from "./repo.js";
import {
  areaPositionFromInstance,
  areaRotationFromInstance,
  optimalAssignment,
  partPositionInArea,
  partRotation,
} from "./geometry.js";
import type { BmInstance, BmLayout, BmSnapshot } from "./source.js";

export interface ProjectOptions {
  /** Area template id → orientation offset, from `calibrate.ts`. */
  offsets: Record<string, number>;
  /** Battlemaster part name → 40kdc feature template id, from `parts.ts`. */
  partMapping: Record<string, string>;
  templates: TerrainTemplate[];
}

/** One Battlemaster instance paired with the committed area it replaces. */
export interface Pairing {
  instance: BmInstance;
  areaTemplate: string;
  /** The committed piece, or null when Battlemaster has an area we lack. */
  existing: RepoPiece | null;
  /** Distance from Battlemaster's raw position to the committed one, inches. */
  drift: number;
}

export interface ProjectedLayout {
  layout: RepoLayout;
  pieces: RepoPiece[];
  pairings: Pairing[];
  /** Areas Battlemaster has that the committed card lacked. */
  added: number;
  /** Committed areas with no Battlemaster counterpart (should not happen). */
  orphaned: RepoPiece[];
  /** Objective-role disagreements, reported rather than silently overwritten. */
  objectiveNotes: string[];
  /** Upstream symmetry slips corrected by {@link symmetriseSlips}. */
  symmetryFixes: string[];
}

/**
 * Tolerance for treating a near-symmetric pair as an upstream slip, inches. Well
 * above the observed 0.707″ and far below any real transform error.
 */
const SLIP_LIMIT = 1.5;

/**
 * Repair an upstream 180°-symmetry slip in a Chapter Approved card.
 *
 * The cards are 180°-rotationally symmetric by design and 43 of Battlemaster's 45 are
 * *exactly* so. Two — `disruption-vs-disruption-1` and
 * `reconnaissance-vs-reconnaissance-2` — place their paired centre trapezoids 0.707″
 * off, and the evidence that this is a slip rather than a design choice is strong: both
 * carry byte-identical coordinates (one mistake, copied), the pair's rotations differ by
 * exactly 180° (so only position is off), and the error is exactly (−0.5, −0.5) — a
 * round half-inch nudge.
 *
 * Propagating it would break a real property of the deliverable: `keystone-pairing`
 * asserts that a keystone's reflected vertex lands within 0.25″ of its twin, which is
 * what makes the two halves of a printed card measure the same. So the pair is snapped
 * to its own symmetric mean — each piece moves half the error — and the correction is
 * reported rather than applied silently.
 *
 * Deliberately narrow: it only touches same-template pairs whose rotations are already
 * exactly 180° apart and whose position error is under {@link SLIP_LIMIT}. Anything
 * larger is a transform bug and must fail the verify gate, not get quietly averaged away.
 */
function symmetriseSlips(
  layout: RepoLayout,
  pieces: RepoPiece[],
): string[] {
  if (!layout.mission_matchup_id) return [];
  const w = layout.board?.width ?? BOARD.width;
  const h = layout.board?.height ?? BOARD.height;
  const areas = pieces.filter((p) => (p.piece_type ?? "area") === "area");
  const notes: string[] = [];
  const done = new Set<RepoPiece>();

  for (const a of areas) {
    if (done.has(a)) continue;
    let best: { piece: RepoPiece; err: number } | null = null;
    for (const b of areas) {
      if (b === a || done.has(b) || b.template !== a.template) continue;
      const rotGap = Math.abs(norm360((b.rotation_degrees ?? 0) - (a.rotation_degrees ?? 0)) - 180);
      if (rotGap > 0.01) continue;
      const err = Math.hypot(a.position.x + b.position.x - w, a.position.y + b.position.y - h);
      if (!best || err < best.err) best = { piece: b, err };
    }
    if (!best || best.err <= 1e-6 || best.err > SLIP_LIMIT) continue;
    const b = best.piece;
    const ex = a.position.x + b.position.x - w;
    const ey = a.position.y + b.position.y - h;
    a.position = { x: round4(a.position.x - ex / 2), y: round4(a.position.y - ey / 2) };
    b.position = { x: round4(b.position.x - ex / 2), y: round4(b.position.y - ey / 2) };
    done.add(a);
    done.add(b);
    notes.push(
      `${layout.id}: ${a.id}/${b.id} were ${best.err.toFixed(3)}″ off 180° symmetry ` +
        `(upstream slip of ${ex.toFixed(3)}, ${ey.toFixed(3)}); each moved ` +
        `${(best.err / 2).toFixed(3)}″ onto the symmetric mean`,
    );
  }
  return notes;
}

/**
 * Pair each Battlemaster instance with a committed area of the same template.
 *
 * Groups by area template, then solves the assignment exactly. When the counts
 * differ the surplus on either side is surfaced (`existing: null` / `orphaned`)
 * instead of being force-fitted — Battlemaster genuinely has two short-line areas
 * that `disruption-vs-reconnaissance-1` is missing, and that should read as "we were
 * short two areas", not as a mangled pairing.
 */
export function pairInstances(
  bm: BmLayout,
  repo: RepoLayout,
  snapshot: BmSnapshot,
): { pairings: Pairing[]; orphaned: RepoPiece[] } {
  const areas = (repo.pieces ?? []).filter((p) => (p.piece_type ?? "area") === "area");
  const byTemplate = new Map<string, { instances: BmInstance[]; existing: RepoPiece[] }>();
  const bucket = (t: string) => {
    const b = byTemplate.get(t) ?? { instances: [], existing: [] };
    byTemplate.set(t, b);
    return b;
  };
  for (const instance of bm.instances) {
    const composite = snapshot.catalog.templates[instance.templateIndex]!;
    bucket(SIZE_CLASS_TO_AREA_TEMPLATE[composite.sizeClass]!).instances.push(instance);
  }
  for (const a of areas) if (a.template) bucket(a.template).existing.push(a);

  const pairings: Pairing[] = [];
  const orphaned: RepoPiece[] = [];
  for (const [areaTemplate, group] of [...byTemplate].sort(([a], [b]) => a.localeCompare(b))) {
    const instances = group.instances;
    const existing = group.existing;
    const n = Math.min(instances.length, existing.length);

    if (n === 0) {
      orphaned.push(...existing);
      for (const instance of instances) {
        pairings.push({ instance, areaTemplate, existing: null, drift: Number.NaN });
      }
      continue;
    }

    // When the counts differ, *which* members of the longer side participate is part
    // of the problem — taking a prefix would pair a committed area against whichever
    // Battlemaster area happened to come first in the snapshot, which is how
    // `disruption-vs-reconnaissance-1` (4 Battlemaster short-lines vs 2 committed)
    // ended up pairing across the board. So choose the best subset, then assign
    // within it.
    const from = instances.map((i) => toBoardFrame(i.x, i.y));
    const to = existing.map((p) => p.position);
    const pickInstances = instances.length > n;
    const longer = pickInstances ? from : to;
    const shorter = pickInstances ? to : from;

    let bestSubset: number[] | null = null;
    let bestPerm: number[] | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const subset of combinations(longer.length, n)) {
      const candidate = subset.map((i) => longer[i]!);
      const perm = pickInstances
        ? optimalAssignment(candidate, shorter)
        : optimalAssignment(shorter, candidate);
      let cost = 0;
      for (let i = 0; i < n; i++) {
        const a = pickInstances ? candidate[i]! : shorter[i]!;
        const b = pickInstances ? shorter[perm[i]!]! : candidate[perm[i]!]!;
        cost += Math.hypot(a.x - b.x, a.y - b.y);
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestSubset = subset;
        bestPerm = perm;
      }
    }

    const usedInstances = new Set<number>();
    const usedExisting = new Set<number>();
    for (let i = 0; i < n; i++) {
      const instanceIdx = pickInstances ? bestSubset![i]! : i;
      const existingIdx = pickInstances ? bestPerm![i]! : bestSubset![bestPerm![i]!]!;
      usedInstances.add(instanceIdx);
      usedExisting.add(existingIdx);
      const raw = from[instanceIdx]!;
      const match = existing[existingIdx]!;
      pairings.push({
        instance: instances[instanceIdx]!,
        areaTemplate,
        existing: match,
        drift: Math.hypot(raw.x - match.position.x, raw.y - match.position.y),
      });
    }
    for (let i = 0; i < instances.length; i++) {
      if (!usedInstances.has(i)) {
        pairings.push({ instance: instances[i]!, areaTemplate, existing: null, drift: Number.NaN });
      }
    }
    for (let i = 0; i < existing.length; i++) {
      if (!usedExisting.has(i)) orphaned.push(existing[i]!);
    }
  }
  return { pairings, orphaned };
}

/** Index subsets of size `k` from `n`, in lexicographic order. */
function combinations(n: number, k: number): number[][] {
  if (k > n) return [];
  if (k === n) return [Array.from({ length: n }, (_, i) => i)];
  const out: number[][] = [];
  const walk = (start: number, acc: number[]): void => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < n; i++) walk(i + 1, [...acc, i]);
  };
  walk(0, []);
  return out;
}

/**
 * The key order the committed file uses. Emitting in this order keeps the diff to
 * changed *values* instead of a whole-file reshuffle — which matters when the change
 * spans 45 cards and someone has to review it.
 */
const PIECE_KEY_ORDER = [
  "id",
  "name",
  "piece_type",
  "terrain",
  "template",
  "footprint",
  "position",
  "rotation_degrees",
  "mirror",
  "parent_area_id",
  "floor",
  "height_inches",
  "terrain_area_keywords",
  "link_group",
  "objective_role",
  "is_objective",
  "objective",
  "keystones",
] as const;

/** Re-emit a piece with its keys in {@link PIECE_KEY_ORDER}. */
function orderKeys(piece: RepoPiece): RepoPiece {
  const out: Record<string, unknown> = {};
  for (const key of PIECE_KEY_ORDER) {
    const v = (piece as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = v;
  }
  // Anything not in the canonical list still has to survive.
  for (const [k, v] of Object.entries(piece)) {
    if (!(k in out) && v !== undefined) out[k] = v;
  }
  return out as RepoPiece;
}

/** Fields that encode authoring intent and survive a geometry rewrite. */
function carryOver(target: RepoPiece, source: RepoPiece): void {
  if (source.id !== undefined) target.id = source.id;
  if (source.name !== undefined) target.name = source.name;
  if (source.link_group !== undefined) target.link_group = source.link_group;
  if (source.is_objective !== undefined) target.is_objective = source.is_objective;
  if (source.objective !== undefined) target.objective = source.objective;
  if (source.height_inches !== undefined) target.height_inches = source.height_inches;
  if (source.terrain_area_keywords !== undefined) {
    target.terrain_area_keywords = source.terrain_area_keywords;
  }
  if (source.terrain !== undefined) target.terrain = source.terrain;
  if (source.floor !== undefined) target.floor = source.floor;
  if (source.keystones !== undefined) target.keystones = source.keystones;
}

/**
 * Project one layout. The committed record supplies identity and authoring intent;
 * Battlemaster supplies all geometry.
 */
export function projectLayout(
  bm: BmLayout,
  repo: RepoLayout,
  snapshot: BmSnapshot,
  opts: ProjectOptions,
): ProjectedLayout {
  const tmplById = new Map(opts.templates.map((t) => [t.id, t]));
  const { pairings, orphaned } = pairInstances(bm, repo, snapshot);
  const pieces: RepoPiece[] = [];
  const objectiveNotes: string[] = [];
  let added = 0;

  // Ids already spoken for, so a minted id can never collide with a carried one.
  const usedIds = new Set<string>();
  for (const p of pairings) if (p.existing?.id) usedIds.add(p.existing.id);
  const mintId = (base: string): string => {
    for (let i = 1; ; i++) {
      const candidate = `${base}-${i}`;
      if (!usedIds.has(candidate)) {
        usedIds.add(candidate);
        return candidate;
      }
    }
  };

  for (const pairing of pairings) {
    const { instance, areaTemplate, existing } = pairing;
    const composite = snapshot.catalog.templates[instance.templateIndex]!;
    const template = tmplById.get(areaTemplate);
    if (!template) throw new Error(`${repo.id}: unknown area template "${areaTemplate}"`);

    const offset = opts.offsets[areaTemplate];
    if (offset === undefined) {
      throw new Error(`${repo.id}: no calibrated orientation offset for "${areaTemplate}"`);
    }

    const rotation = areaRotationFromInstance(instance, offset);
    // Battlemaster never mirrors a part and does not mirror composites either; the
    // flag it does carry rides on the placement, so an unmirrored piece stays
    // unmirrored rather than inheriting a stale committed value.
    const mirror: Mirror = "none";
    const position = areaPositionFromInstance(instance, template.footprint, rotation, mirror);

    // Start from the carried-over intent, then let Battlemaster's geometry win. The
    // deletes matter: a stale `mirror` or inline `footprint` would silently override
    // the new placement (an inline footprint outranks `template` in the resolver).
    const area: RepoPiece = { position: { x: 0, y: 0 } };
    if (existing) carryOver(area, existing);
    area.id = existing?.id ?? mintId(areaTemplate);
    area.name = existing?.name ?? template.name;
    area.piece_type = "area";
    area.template = areaTemplate;
    area.position = { x: round4(position.x), y: round4(position.y) };
    if (rotation !== 0) area.rotation_degrees = round4(rotation);
    else delete area.rotation_degrees;
    delete area.mirror;
    delete area.parent_area_id;
    delete area.footprint;

    // Objective role: Battlemaster's code is authoritative for *whether* a piece is an
    // objective; a disagreement with the committed role is reported, not silenced.
    const code = instance.objectiveCode;
    if (code) {
      const role = OBJECTIVE_CODE_TO_ROLE[code];
      if (!role) {
        objectiveNotes.push(`${repo.id}/${area.id}: unknown Battlemaster objective code "${code}"`);
      } else {
        if (existing?.objective_role && existing.objective_role !== role) {
          objectiveNotes.push(
            `${repo.id}/${area.id}: Battlemaster code "${code}" means ${role}, card says ` +
              `${existing.objective_role} — keeping ${role}`,
          );
        }
        area.objective_role = role;
        area.is_objective = true;
      }
    } else if (existing?.objective_role) {
      objectiveNotes.push(
        `${repo.id}/${area.id}: card marks ${existing.objective_role} but Battlemaster has no ` +
          `objective code here — clearing`,
      );
      delete area.objective_role;
      delete area.is_objective;
    }

    if (!existing) added++;
    pieces.push(area);

    // Children, one per composite part, in the parent's centroid-local frame.
    const anchorDelta = template ? centroidDeltaFor(template) : { x: 0, y: 0 };
    for (let i = 0; i < composite.parts.length; i++) {
      const partName = snapshot.catalog.parts[composite.parts[i]!.partIndex]!.name;
      const childTemplate = opts.partMapping[partName];
      if (!childTemplate) {
        throw new Error(`${repo.id}: Battlemaster part "${partName}" has no template mapping`);
      }
      const childTmpl = tmplById.get(childTemplate);
      if (!childTmpl) throw new Error(`${repo.id}: unknown feature template "${childTemplate}"`);
      const pos = partPositionInArea(snapshot.catalog, composite, i, offset, anchorDelta);
      const rot = partRotation(composite, i, offset);
      const child: RepoPiece = {
        id: mintId(childTemplate),
        name: childTmpl.name,
        piece_type: "feature",
        template: childTemplate,
        position: { x: round4(pos.x), y: round4(pos.y) },
        parent_area_id: area.id,
      };
      if (rot !== 0) child.rotation_degrees = round4(norm360(rot));
      pieces.push(child);
    }
  }

  const symmetryFixes = symmetriseSlips(repo, pieces);

  // Emit areas in the order the committed card listed them, each followed by its
  // children, with genuinely-new areas appended. Keeps the diff to changed values
  // rather than a reshuffle of 1980 pieces.
  const committedOrder = new Map<string, number>();
  (repo.pieces ?? []).forEach((p, i) => {
    if (p.id) committedOrder.set(p.id, i);
  });
  const areas = pieces.filter((p) => (p.piece_type ?? "area") === "area");
  const childrenOf = new Map<string, RepoPiece[]>();
  for (const p of pieces) {
    if (!p.parent_area_id) continue;
    const list = childrenOf.get(p.parent_area_id) ?? [];
    childrenOf.set(p.parent_area_id, list);
    list.push(p);
  }
  const ordered: RepoPiece[] = [];
  const sortedAreas = [...areas].sort((a, b) => {
    const ai = committedOrder.get(a.id ?? "") ?? Number.MAX_SAFE_INTEGER;
    const bi = committedOrder.get(b.id ?? "") ?? Number.MAX_SAFE_INTEGER;
    return ai !== bi ? ai - bi : (a.id ?? "").localeCompare(b.id ?? "");
  });
  for (const area of sortedAreas) {
    ordered.push(orderKeys(area));
    for (const child of childrenOf.get(area.id ?? "") ?? []) ordered.push(orderKeys(child));
  }

  return {
    layout: repo,
    pieces: ordered,
    pairings,
    added,
    orphaned,
    objectiveNotes,
    symmetryFixes,
  };
}

/** Per-template centroid→bbox-centre offset; the footprints never change mid-run. */
const deltaCache = new Map<string, Vec2>();
function centroidDeltaFor(template: TerrainTemplate): Vec2 {
  let hit = deltaCache.get(template.id);
  if (!hit) {
    hit = centroidToBoundsCentre(template.footprint);
    deltaCache.set(template.id, hit);
  }
  return hit;
}

/** Project every layout in the snapshot that has a committed counterpart. */
export function projectAll(
  snapshot: BmSnapshot,
  layouts: RepoLayout[],
  opts: ProjectOptions,
): ProjectedLayout[] {
  const byId = new Map(layouts.map((l) => [l.id, l]));
  const out: ProjectedLayout[] = [];
  for (const bm of snapshot.layouts) {
    const repo = byId.get(repoLayoutId(bm));
    if (!repo) continue;
    out.push(projectLayout(bm, repo, snapshot, opts));
  }
  return out;
}
