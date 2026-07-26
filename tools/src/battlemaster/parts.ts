/**
 * Which 40kdc feature template each Battlemaster terrain *part* denotes.
 *
 * The two catalogs were authored independently and neither names the other's
 * pieces, so this cannot be read off a field — it has to be inferred and then
 * defended. {@link PART_TO_TEMPLATE} is the answer, written down explicitly so it is
 * greppable and a correction is a one-line change; {@link learnPartMapping}
 * *rederives* it from the data on every run and fails if the evidence has moved.
 *
 * ## How it was inferred
 *
 * The lever is that a Battlemaster composite template and a 40kdc area piece
 * describe the same physical ruin: the composite lists its parts, the area piece
 * carries child features. Where a composite's placement agrees with a committed
 * area's placement, the two child lists must denote the same pieces.
 *
 * 1. **Pure constraints.** For each composite, collect the child-template multisets
 *    observed across every agreeing placement. Composites with a single observed
 *    multiset (seen ≥2×) become set equations: `{parts} = {children}`.
 * 2. **Propagation.** A part's image must appear in the child multiset of *every*
 *    constraint containing it, so intersect. Then close: in a constraint whose part
 *    and child counts match, if all but one part is pinned the last is forced.
 * 3. **Multiplicity.** Two parts that only ever co-occur (`Short Barrier`×2 +
 *    `Tower`) are separated by count: 2 barriers ↔ 2 `barricade`, 1 tower ↔ 1
 *    `gantry`.
 * 4. **Size-class assignment.** Stages 1-3 need a placement Battlemaster and the repo
 *    already agree on, and `area-trapezoid` has *none* — every committed trapezoid is
 *    misplaced. So for a size class whose part set and observed child set are both
 *    small and balanced, solve the assignment directly from corpus-wide counts under
 *    the nub constraint, ignoring positions. This is what pins `AB` and `Corner`: of
 *    the trapezoid's two parts only `AB` (3.75×4.5) can occupy a `corner-ruin-*`
 *    footprint at all, so `Corner` takes `corner-tiny`, and the left/right hand comes
 *    from the corpus's one consistent big-ruin signal (`corner-ruin-balanced-left`,
 *    84 observations vs 6).
 * 5. **The nub constraint**, for what still remains. A 40kdc footprint is a nubbed
 *    die-cut outline and Battlemaster's dimensions are the artwork bbox the nubs
 *    extend past, so a valid pairing has `repo ≥ battlemaster` on both axes (either
 *    orientation). This holds for every part pinned by stages 1-4, which is what
 *    earns it the right to decide the rest.
 *
 * ## Where the corpus is wrong, and why we still trust the result
 *
 * Propagation returns an **empty domain** for `CO` and `EF`: `CO` appears in 10 pure
 * composites whose child sets have empty intersection. That is a proof that the
 * committed corpus labels those two ruins *inconsistently* — so their majority vote
 * is noise, not evidence, and the nub constraint decides them instead. It admits
 * exactly one placement for `CO` (`corner-ruin-left`), leaving `EF` by elimination.
 *
 * The corpus's *majority* actually points the other way (`CO`→`corner-ruin-balanced-right`),
 * and we overrule it deliberately: `CO` is 6″ on its long axis and
 * `corner-ruin-balanced-right` is 5×4.5″, so the piece physically cannot be that
 * footprint. A hard dimensional impossibility beats a vote taken over labels already
 * proven inconsistent. Every affected composite is listed in the report so the call is
 * auditable rather than buried.
 *
 * `EF` is the one genuinely unsatisfying row: at 4.5×6 it does not fit
 * `corner-ruin-balanced-right` (5×4.5) under the nub constraint in either
 * orientation. The catalog has no template that models this piece. We use the
 * leftover so the intake can proceed and {@link learnPartMapping} reports it as a
 * warning every run — authoring a real `EF` footprint is separate work.
 *
 * `Pipes`→`catwalk` reads backwards by name. It is right: scored as a whole
 * assignment against `Long Barrier`→`pipe` the alternative costs more total
 * dimensional error, and it is 100% pure over 68 observations. Battlemaster's part
 * names describe its own TTS models, not GW's pieces.
 */
import type { TerrainTemplate } from "../terrain/resolve.js";
import {
  SIZE_CLASS_TO_AREA_TEMPLATE,
  footprintBounds,
  repoLayoutId,
  toBoardFrame,
  type RepoLayout,
  type RepoPiece,
} from "./repo.js";
import type { BmSnapshot } from "./source.js";

/**
 * Battlemaster part name → 40kdc feature template id.
 *
 * Re-derived and re-asserted by {@link learnPartMapping} on every run. `EF` is a
 * known-imperfect fit; see the file header.
 */
export const PART_TO_TEMPLATE: Record<string, string> = {
  Generator: "generator",
  Pipes: "catwalk",
  "Long Barrier": "pipe",
  "Small L": "corner-short",
  "Small L flip": "corner-short",
  "Short Barrier": "barricade",
  Tower: "gantry",
  GH: "corner-ruin-right",
  Corner: "corner-tiny",
  AB: "corner-ruin-balanced-left",
  CO: "corner-ruin-left",
  EF: "corner-ruin-balanced-right",
};

/** Parts whose template is a known-imperfect fit, with the reason. */
export const PART_FIT_WARNINGS: Record<string, string> = {
  EF:
    "EF is 4.5×6″ but corner-ruin-balanced-right is 5×4.5″ — the 6″ axis does not fit in " +
    "either orientation, so the catalog has no template that really models this piece. " +
    "Assigned by elimination; author a proper EF footprint as follow-up.",
};

/** Position agreement tolerance, inches. Matches `calibrate.ts`. */
const AGREE_TOL = 0.15;

export interface PartEvidence {
  part: string;
  /** Template the solver derived, or null when its domain did not close. */
  derived: string | null;
  /** Domain remaining after propagation — >1 means ambiguous, 0 means contradictory. */
  domain: string[];
  /** Pure composites containing this part. */
  composites: number;
  /** Total agreeing observations behind those composites. */
  observations: number;
  basis: "propagation" | "multiplicity" | "size-class" | "nub-constraint" | "declared-only";
  /** True when the declared mapping matches what was derived. */
  agrees: boolean;
}

/**
 * Which stages are strong enough that contradicting the declared mapping is a hard
 * failure. `nub-constraint` and `size-class` resolve parts the corpus is provably
 * inconsistent about, so a disagreement there is reported, not fatal.
 */
const STRONG_BASES = new Set<PartEvidence["basis"]>(["propagation", "multiplicity"]);

export interface PartMapping {
  ok: boolean;
  mapping: Record<string, string>;
  evidence: PartEvidence[];
  /** Pure set-equations used, for the report. */
  constraints: { composite: number; label: string; parts: string[]; children: string[]; n: number }[];
  warnings: string[];
  errors: string[];
}

interface Constraint {
  composite: number;
  label: string;
  parts: string[];
  children: string[];
  n: number;
}

/** Sorted multiset of a piece list's template ids. */
function childSignature(pieces: RepoPiece[]): string[] {
  return pieces.map((p) => p.template ?? "").filter(Boolean).sort();
}

/** Does `repo` wrap `bm` on both axes, in either orientation? The nub constraint. */
function nubCompatible(
  bm: { width: number; height: number },
  repo: TerrainTemplate,
): boolean {
  const b = footprintBounds(repo.footprint);
  const rw = b.maxX - b.minX;
  const rh = b.maxY - b.minY;
  const eps = 1e-6;
  const fits = (w: number, h: number): boolean => rw + eps >= w && rh + eps >= h;
  return fits(bm.width, bm.height) || fits(bm.height, bm.width);
}

/**
 * Rederive the part mapping from the snapshot and the committed corpus, and check it
 * against {@link PART_TO_TEMPLATE}.
 */
export function learnPartMapping(
  snapshot: BmSnapshot,
  layouts: RepoLayout[],
  templates: TerrainTemplate[],
): PartMapping {
  const byId = new Map(layouts.map((l) => [l.id, l]));
  const tmplById = new Map(templates.map((t) => [t.id, t]));
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Observe: per composite, the child-template multisets of agreeing placements.
  const observed = new Map<number, Map<string, number>>();
  for (const bmLayout of snapshot.layouts) {
    const repo = byId.get(repoLayoutId(bmLayout));
    if (!repo) continue;
    const pieces = repo.pieces ?? [];
    const areas = pieces.filter((p) => (p.piece_type ?? "area") === "area");
    for (const instance of bmLayout.instances) {
      const composite = snapshot.catalog.templates[instance.templateIndex]!;
      const areaTemplate = SIZE_CLASS_TO_AREA_TEMPLATE[composite.sizeClass];
      const raw = toBoardFrame(instance.x, instance.y);
      let nearest: { piece: RepoPiece; d: number } | null = null;
      for (const a of areas) {
        if (a.template !== areaTemplate) continue;
        const d = Math.hypot(raw.x - a.position.x, raw.y - a.position.y);
        if (!nearest || d < nearest.d) nearest = { piece: a, d };
      }
      if (!nearest || nearest.d > AGREE_TOL) continue;
      const sig = childSignature(pieces.filter((p) => p.parent_area_id === nearest!.piece.id)).join("+");
      const hist = observed.get(instance.templateIndex) ?? new Map<string, number>();
      observed.set(instance.templateIndex, hist);
      hist.set(sig, (hist.get(sig) ?? 0) + 1);
    }
  }

  // ── Pure constraints only: a single observed signature, corroborated at least twice.
  const constraints: Constraint[] = [];
  for (const [composite, hist] of [...observed].sort((a, b) => a[0] - b[0])) {
    if (hist.size !== 1) continue;
    const [sig, n] = [...hist][0]!;
    if (n < 2) continue;
    const t = snapshot.catalog.templates[composite]!;
    constraints.push({
      composite,
      label: t.label,
      parts: t.parts.map((p) => snapshot.catalog.parts[p.partIndex]!.name).sort(),
      children: sig.split("+").filter(Boolean).sort(),
      n,
    });
  }

  const allParts = new Set<string>();
  for (const t of snapshot.catalog.templates) {
    for (const p of t.parts) allParts.add(snapshot.catalog.parts[p.partIndex]!.name);
  }
  const allChildren = new Set<string>();
  for (const c of constraints) for (const k of c.children) allChildren.add(k);

  // ── Propagate.
  const domain = new Map([...allParts].map((p) => [p, new Set(allChildren)]));
  const basis = new Map<string, PartEvidence["basis"]>();
  for (let pass = 0; pass < 8; pass++) {
    for (const c of constraints) {
      for (const p of c.parts) {
        const d = domain.get(p);
        if (!d) continue;
        for (const k of [...d]) if (!c.children.includes(k)) d.delete(k);
      }
    }
    // Close: in a balanced constraint, the last open part is forced.
    for (const c of constraints) {
      if (c.parts.length !== c.children.length) continue;
      const open = c.parts.filter((p) => (domain.get(p)?.size ?? 0) > 1);
      if (open.length !== 1) continue;
      const taken = new Set(
        c.parts.filter((p) => domain.get(p)?.size === 1).map((p) => [...domain.get(p)!][0]!),
      );
      const rest = c.children.filter((k) => !taken.has(k));
      if (rest.length === 1) domain.set(open[0]!, new Set(rest));
    }
  }
  for (const [p, d] of domain) if (d.size === 1) basis.set(p, "propagation");

  // ── Multiplicity: parts that only co-occur are separated by their counts.
  for (const c of constraints) {
    const openParts = c.parts.filter((p) => (domain.get(p)?.size ?? 0) > 1);
    if (openParts.length < 2) continue;
    const partCounts = new Map<string, number>();
    for (const p of c.parts) partCounts.set(p, (partCounts.get(p) ?? 0) + 1);
    const childCounts = new Map<string, number>();
    for (const k of c.children) childCounts.set(k, (childCounts.get(k) ?? 0) + 1);
    for (const p of new Set(openParts)) {
      const want = partCounts.get(p)!;
      const fits = [...(domain.get(p) ?? [])].filter((k) => childCounts.get(k) === want);
      // Only decisive when exactly one candidate has the matching multiplicity and no
      // other open part shares that count.
      const rivals = [...new Set(openParts)].filter((q) => q !== p && partCounts.get(q) === want);
      if (fits.length === 1 && rivals.length === 0) {
        domain.set(p, new Set(fits));
        basis.set(p, "multiplicity");
      }
    }
  }

  // ── Size-class assignment, for classes stages 1-3 could not reach (notably
  //    `tr`/area-trapezoid, which has no agreeing placement at all). Uses corpus-wide
  //    counts rather than matched placements, so it survives the trapezoid being
  //    entirely misplaced.
  const partsBySizeClass = new Map<string, Set<string>>();
  for (const t of snapshot.catalog.templates) {
    const set = partsBySizeClass.get(t.sizeClass) ?? new Set<string>();
    partsBySizeClass.set(t.sizeClass, set);
    for (const p of t.parts) set.add(snapshot.catalog.parts[p.partIndex]!.name);
  }
  const childCountsByArea = new Map<string, Map<string, number>>();
  for (const layout of layouts) {
    const areaOf = new Map(
      (layout.pieces ?? []).filter((p) => p.id && (p.piece_type ?? "area") === "area").map((p) => [p.id!, p]),
    );
    for (const p of layout.pieces ?? []) {
      if (!p.parent_area_id || !p.template) continue;
      const areaTemplate = areaOf.get(p.parent_area_id)?.template;
      if (!areaTemplate) continue;
      const hist = childCountsByArea.get(areaTemplate) ?? new Map<string, number>();
      childCountsByArea.set(areaTemplate, hist);
      hist.set(p.template, (hist.get(p.template) ?? 0) + 1);
    }
  }
  for (const [sizeClass, areaTemplate] of Object.entries(SIZE_CLASS_TO_AREA_TEMPLATE)) {
    const classParts = [...(partsBySizeClass.get(sizeClass) ?? [])];
    const open = classParts.filter((p) => (domain.get(p)?.size ?? 0) !== 1);
    if (open.length === 0) continue;
    const hist = childCountsByArea.get(areaTemplate);
    if (!hist) continue;
    // Children this class plausibly uses: dominant by count, and not already claimed
    // by a part pinned outside this class.
    const claimedElsewhere = new Set(
      [...domain]
        .filter(([p, d]) => d.size === 1 && !classParts.includes(p))
        .map(([, d]) => [...d][0]!),
    );
    const total = [...hist.values()].reduce((a, b) => a + b, 0);
    const pool = [...hist]
      .filter(([id, n]) => n / total >= 0.1 && !claimedElsewhere.has(id))
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    if (open.length !== pool.length) continue;
    // Assign under the nub constraint: a part may only take a footprint that wraps it.
    const viableFor = new Map(
      open.map((p) => {
        const part = snapshot.catalog.parts.find((q) => q.name === p)!;
        return [p, pool.filter((id) => { const t = tmplById.get(id); return t ? nubCompatible(part, t) : false; })];
      }),
    );
    // Repeatedly pin any part with a single viable child, or any child with a single
    // viable part. Deterministic and refuses to guess when neither holds.
    for (let pass = 0; pass < open.length + 1; pass++) {
      for (const p of open) {
        if ((domain.get(p)?.size ?? 0) === 1) continue;
        const taken = new Set(open.filter((q) => domain.get(q)?.size === 1).map((q) => [...domain.get(q)!][0]!));
        const left = (viableFor.get(p) ?? []).filter((id) => !taken.has(id));
        if (left.length === 1) {
          domain.set(p, new Set(left));
          basis.set(p, "size-class");
          continue;
        }
        // A child only this part can wrap is forced onto it.
        const exclusive = left.filter(
          (id) => open.filter((q) => domain.get(q)?.size !== 1 && (viableFor.get(q) ?? []).includes(id)).length === 1,
        );
        if (exclusive.length === 1 && left.length > 1) {
          // Only decisive when the remaining parts can cover the remaining children.
          const others = open.filter((q) => q !== p && domain.get(q)?.size !== 1);
          const rest = left.filter((id) => id !== exclusive[0]);
          if (others.every((q) => (viableFor.get(q) ?? []).some((id) => rest.includes(id)))) {
            domain.set(p, new Set(exclusive));
            basis.set(p, "size-class");
          }
        }
      }
    }
  }

  // ── Nub constraint for whatever remains open or contradictory.
  const pinned = new Set([...domain].filter(([, d]) => d.size === 1).map(([, d]) => [...d][0]!));
  const unpinnedTemplates = [...tmplById.values()]
    .filter((t) => t.kind === "feature" && !pinned.has(t.id))
    .map((t) => t.id);
  for (const [p, d] of domain) {
    if (d.size === 1) continue;
    const part = snapshot.catalog.parts.find((q) => q.name === p);
    if (!part) continue;
    const pool = d.size > 1 ? [...d] : unpinnedTemplates;
    const viable = pool.filter((id) => {
      const t = tmplById.get(id);
      return t ? nubCompatible(part, t) : false;
    });
    if (viable.length === 1) {
      domain.set(p, new Set(viable));
      basis.set(p, "nub-constraint");
    }
  }
  // Last resort: a single leftover template for a single unresolved part.
  {
    const stillOpen = [...domain].filter(([, d]) => d.size !== 1).map(([p]) => p);
    const nowPinned = new Set([...domain].filter(([, d]) => d.size === 1).map(([, d]) => [...d][0]!));
    const leftover = [...tmplById.values()]
      .filter((t) => t.kind === "feature" && !nowPinned.has(t.id))
      .map((t) => t.id);
    const used = new Set<string>();
    for (const t of snapshot.catalog.templates) {
      for (const p of t.parts) used.add(snapshot.catalog.parts[p.partIndex]!.name);
    }
    const openUsed = stillOpen.filter((p) => used.has(p));
    if (openUsed.length === 1 && leftover.length === 1) {
      domain.set(openUsed[0]!, new Set(leftover));
      basis.set(openUsed[0]!, "nub-constraint");
    }
  }

  // ── Report and compare against the declared mapping.
  const evidence: PartEvidence[] = [];
  const mapping: Record<string, string> = {};
  for (const p of [...allParts].sort()) {
    const d = [...(domain.get(p) ?? [])];
    const witnesses = constraints.filter((c) => c.parts.includes(p));
    const derived = d.length === 1 ? d[0]! : null;
    const declared = PART_TO_TEMPLATE[p];
    if (!declared) {
      errors.push(
        `Battlemaster part "${p}" has no entry in PART_TO_TEMPLATE — add one (or a new ` +
          `terrain template) before ingesting; guessing would silently corrupt geometry`,
      );
    } else if (!tmplById.has(declared)) {
      errors.push(`part "${p}" maps to "${declared}", which is not in the template catalog`);
    }
    if (declared) mapping[p] = declared;
    const partBasis = basis.get(p) ?? "declared-only";
    const agrees = derived === null ? declared !== undefined : derived === declared;
    if (derived !== null && declared !== undefined && derived !== declared) {
      const message =
        `part "${p}": the evidence derives "${derived}" but PART_TO_TEMPLATE declares ` +
        `"${declared}" (basis: ${partBasis})`;
      if (STRONG_BASES.has(partBasis)) {
        errors.push(`${message} — strong evidence contradicts the declaration; review before ingesting`);
      } else {
        // The weak stages exist precisely to resolve parts the corpus is inconsistent
        // about, so a disagreement here is a judgement call to surface, not a stop.
        warnings.push(`${message} — weak-stage disagreement; the declaration wins, see the header note`);
      }
    }
    evidence.push({
      part: p,
      derived,
      domain: d,
      composites: witnesses.length,
      observations: witnesses.reduce((s, c) => s + c.n, 0),
      basis: partBasis,
      agrees,
    });
  }

  // Injectivity, excluding Battlemaster's own chiral pair, which legitimately shares
  // one 40kdc template (handedness rides on the piece's `mirror`).
  const CHIRAL_PAIRS = [new Set(["Small L", "Small L flip"])];
  const inverse = new Map<string, string[]>();
  for (const [p, t] of Object.entries(mapping)) {
    const list = inverse.get(t) ?? [];
    inverse.set(t, list);
    list.push(p);
  }
  for (const [t, ps] of inverse) {
    if (ps.length < 2) continue;
    const set = new Set(ps);
    const isChiral = CHIRAL_PAIRS.some((pair) => ps.every((p) => pair.has(p)) && set.size === pair.size);
    if (!isChiral) {
      errors.push(`template "${t}" is claimed by ${ps.length} parts (${ps.join(", ")}) — not injective`);
    }
  }

  for (const [p, why] of Object.entries(PART_FIT_WARNINGS)) {
    if (mapping[p]) warnings.push(`${p} → ${mapping[p]}: ${why}`);
  }

  // Cross-check the declared mapping against every covered composite's modal
  // signature — the strongest global consistency test available.
  let agree = 0;
  let disagree = 0;
  const disagreements: string[] = [];
  for (const [composite, hist] of observed) {
    const t = snapshot.catalog.templates[composite]!;
    const names = t.parts.map((p) => snapshot.catalog.parts[p.partIndex]!.name);
    if (names.some((n) => !mapping[n])) continue;
    const predicted = names.map((n) => mapping[n]!).sort().join("+");
    const modal = [...hist].sort((a, b) => b[1] - a[1])[0]![0];
    if (predicted === modal) agree++;
    else {
      disagree++;
      disagreements.push(`tpl[${composite}] ${t.label}: predicted "${predicted}" vs modal "${modal}"`);
    }
  }
  if (disagree > 0) {
    warnings.push(
      `${disagree} of ${agree + disagree} covered composites disagree with their modal observed ` +
        `child set — expected where the corpus is self-inconsistent (see the CO/EF note), but ` +
        `review the list below.`,
    );
    warnings.push(...disagreements.map((d) => `    ${d}`));
  }

  return { ok: errors.length === 0, mapping, evidence, constraints, warnings, errors };
}

export function formatPartMappingReport(snapshot: BmSnapshot, m: PartMapping): string {
  const out: string[] = [];
  out.push("Battlemaster part → 40kdc feature template");
  out.push("");
  out.push(`  pure set-equations used: ${m.constraints.length}`);
  out.push("");
  out.push(
    `  ${"part".padEnd(15)} ${"dims".padEnd(11)} ${"→ template".padEnd(30)} basis            evidence`,
  );
  for (const e of m.evidence) {
    const part = snapshot.catalog.parts.find((p) => p.name === e.part);
    const dims = part ? `${part.width}×${part.height}″` : "";
    const target = m.mapping[e.part] ?? "(unmapped)";
    const flag = e.agrees ? " " : "✗";
    out.push(
      `  ${flag} ${e.part.padEnd(15)} ${dims.padEnd(11)} ${target.padEnd(30)} ` +
        `${e.basis.padEnd(15)} ${e.composites} composites, ${e.observations} obs` +
        (e.derived === null && e.domain.length > 1 ? `  [ambiguous: ${e.domain.join("|")}]` : "") +
        (e.derived === null && e.domain.length === 0 ? "  [corpus self-inconsistent]" : ""),
    );
  }

  if (m.warnings.length > 0) {
    out.push("");
    out.push("  WARNINGS");
    for (const w of m.warnings) out.push(`    ⚠ ${w}`);
  }
  out.push("");
  if (m.ok) {
    out.push(`  ✓ all ${m.evidence.length} parts mapped; declared mapping matches the evidence.`);
  } else {
    out.push("  ✗ PART MAPPING FAILED");
    for (const e of m.errors) out.push(`      ${e}`);
  }
  return out.join("\n");
}
