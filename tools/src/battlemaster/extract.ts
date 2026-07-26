/**
 * The `extract` subcommand: calibrate → map parts → project → report → persist.
 *
 * Dry run by default. Both modes apply the identical projection and route the same
 * projected file contents through `mfm/apply.ts` `applyWrites`, which validates the
 * whole dataset (AJV + referential integrity, exactly what `npm run validate` does)
 * and throws in *either* mode — so a clean dry run guarantees a clean `--write`, and
 * `--write` only persists after validation passes, atomically and all-or-nothing.
 *
 * The report is not decoration: it is how a human checks a 45-card geometry rewrite
 * they cannot eyeball. It carries the per-layout position/rotation corrections, the
 * keystone-distance drift each card's printed dimensions will show, and the drift
 * against `take-and-hold-vs-purge-the-foe-2` — the one card that was hand-authored
 * rather than scraped, and therefore the closest thing to an independent check.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { keystoneMeasurements } from "../terrain/keystones.js";
import { verify } from "./verify.js";
import { applyWrites } from "../mfm/apply.js";
import { calibrate, formatCalibrationReport, offsetMap } from "./calibrate.js";
import { formatPartMappingReport, learnPartMapping, PART_FIT_WARNINGS } from "./parts.js";
import { projectAll, type ProjectedLayout } from "./project.js";
import {
  LAYOUTS_PATH,
  REPORT_DIR,
  loadRepoLayouts,
  loadRepoTemplates,
  round4,
  type RepoLayout,
} from "./repo.js";
import { loadSnapshot } from "./source.js";

/** The card the intake claims as its provenance. */
const SOURCE_TAG = "battlemaster-11e";

export interface ExtractOptions {
  write: boolean;
}

interface LayoutDelta {
  id: string;
  piecesBefore: number;
  piecesAfter: number;
  added: number;
  orphaned: number;
  /** Position corrections over paired areas, inches. */
  positions: number[];
  /** Rotation corrections over paired areas, degrees (absolute, shortest arc). */
  rotations: number[];
  /** Keystone distance changes, inches. */
  keystones: number[];
  maxPosition: number;
  maxKeystone: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function angleGap(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

export async function runExtract(opts: ExtractOptions): Promise<void> {
  const snapshot = loadSnapshot();
  const layouts = loadRepoLayouts();
  const templates = loadRepoTemplates();

  // ── Gate on calibration and the part mapping before touching any data.
  const cal = calibrate(snapshot, layouts, templates);
  console.log(formatCalibrationReport(cal));
  if (!cal.ok) throw new Error("calibration failed — nothing projected");

  const mapping = learnPartMapping(snapshot, layouts, templates);
  console.log("");
  console.log(formatPartMappingReport(snapshot, mapping));
  if (!mapping.ok) throw new Error("part mapping failed — nothing projected");

  // ── Project.
  const projected = projectAll(snapshot, layouts, {
    offsets: offsetMap(cal),
    partMapping: mapping.mapping,
    templates,
  });
  const byId = new Map(projected.map((p) => [p.layout.id, p]));

  const before = new Map(layouts.map((l) => [l.id, l]));
  const next: RepoLayout[] = layouts.map((l) => {
    const p = byId.get(l.id);
    if (!p) return l;
    return { ...l, source: SOURCE_TAG, pieces: p.pieces };
  });

  // ── Measure what changed, per layout.
  const deltas: LayoutDelta[] = [];
  for (const p of projected) {
    const original = before.get(p.layout.id)!;
    const positions: number[] = [];
    const rotations: number[] = [];
    for (const pair of p.pairings) {
      if (!pair.existing) continue;
      const after = p.pieces.find((q) => q.id === pair.existing!.id);
      if (!after) continue;
      positions.push(
        Math.hypot(after.position.x - pair.existing.position.x, after.position.y - pair.existing.position.y),
      );
      rotations.push(angleGap(after.rotation_degrees ?? 0, pair.existing.rotation_degrees ?? 0));
    }
    const ksBefore = safeKeystones(original, templates);
    const ksAfter = safeKeystones({ ...original, pieces: p.pieces }, templates);
    const keystones: number[] = [];
    const keyOf = (m: { piece_id: string | null; edge: string; ref: unknown }): string =>
      `${m.piece_id}|${m.edge}|${JSON.stringify(m.ref)}`;
    const afterByKey = new Map(ksAfter.map((m) => [keyOf(m), m.distance]));
    for (const m of ksBefore) {
      const a = afterByKey.get(keyOf(m));
      if (a !== undefined) keystones.push(Math.abs(a - m.distance));
    }
    deltas.push({
      id: p.layout.id,
      piecesBefore: (original.pieces ?? []).length,
      piecesAfter: p.pieces.length,
      added: p.added,
      orphaned: p.orphaned.length,
      positions,
      rotations,
      keystones,
      maxPosition: positions.length ? Math.max(...positions) : 0,
      maxKeystone: keystones.length ? Math.max(...keystones) : 0,
    });
  }

  // ── Geometry invariants on the *projected* data, so a dry run catches them.
  //    `applyWrites` covers schema and referential integrity; these are the checks
  //    only the resolver can make, and 180° symmetry in particular is the global
  //    property no per-piece transform bug survives.
  const inv = verify(next, templates);
  if (!inv.ok) {
    const detail = [
      ...inv.resolveFailures.map((f) => `    resolve: ${f}`),
      ...inv.offBoard.map((f) => `    off-board: ${f}`),
      ...inv.asymmetric.map((f) => `    180°-asymmetric: ${f}`),
    ].join("\n");
    throw new Error(
      `projected layouts violate the geometry invariants — nothing written:\n${detail}`,
    );
  }
  console.log("");
  console.log(
    `  ✓ invariants: ${inv.checked} layouts resolve, sit on the board, and keep 180° symmetry.`,
  );
  for (const n of inv.symmetryNotes) {
    console.log(`    · sub-limit asymmetry, reproduced from the source: ${n}`);
  }
  for (const n of projected.flatMap((p) => p.symmetryFixes)) {
    console.log(`    · upstream symmetry slip corrected: ${n}`);
  }

  const report = buildReport(deltas, projected, cal, mapping, snapshot.layouts.length, inv.symmetryNotes);
  writeFileSync(join(REPORT_DIR, "battlemaster-layout-intake.md"), report);
  writeFileSync(
    join(REPORT_DIR, "battlemaster-part-mapping.md"),
    buildPartMappingDoc(snapshot, mapping),
  );

  console.log("");
  console.log(summarise(deltas, projected));
  console.log("");
  console.log(`  reports → data/core/_reports/battlemaster-{layout-intake,part-mapping}.md`);
  console.log("");

  await applyWrites([{ path: LAYOUTS_PATH, value: next }], {
    write: opts.write,
    label: "battlemaster",
  });

  if (!opts.write) {
    console.log(
      "\nDry run OK — the projected dataset validates. Re-run with --write to persist.",
    );
  }
}

/** Keystone measurements, tolerating a layout whose keystones cannot resolve. */
function safeKeystones(
  layout: RepoLayout,
  templates: ReturnType<typeof loadRepoTemplates>,
): { piece_id: string | null; edge: string; ref: unknown; distance: number }[] {
  try {
    return keystoneMeasurements(layout as never, templates as never) as never;
  } catch {
    return [];
  }
}

function summarise(deltas: LayoutDelta[], projected: ProjectedLayout[]): string {
  const pos = deltas.flatMap((d) => d.positions).sort((a, b) => a - b);
  const rot = deltas.flatMap((d) => d.rotations).sort((a, b) => a - b);
  const ks = deltas.flatMap((d) => d.keystones).sort((a, b) => a - b);
  const added = deltas.reduce((s, d) => s + d.added, 0);
  const orphaned = deltas.reduce((s, d) => s + d.orphaned, 0);
  const out: string[] = [];
  out.push(`  ${deltas.length} layouts projected, ${projected.reduce((s, p) => s + p.pieces.length, 0)} pieces`);
  out.push(
    `  position  p50=${percentile(pos, 0.5).toFixed(3)}″ p90=${percentile(pos, 0.9).toFixed(3)}″ ` +
      `max=${(pos[pos.length - 1] ?? 0).toFixed(3)}″   moved >0.15″: ${pos.filter((d) => d > 0.15).length}/${pos.length}`,
  );
  out.push(
    `  rotation  p50=${percentile(rot, 0.5).toFixed(2)}° p90=${percentile(rot, 0.9).toFixed(2)}° ` +
      `max=${(rot[rot.length - 1] ?? 0).toFixed(2)}°   changed >1°: ${rot.filter((d) => d > 1).length}/${rot.length}`,
  );
  out.push(
    `  keystones p50=${percentile(ks, 0.5).toFixed(3)}″ p90=${percentile(ks, 0.9).toFixed(3)}″ ` +
      `max=${(ks[ks.length - 1] ?? 0).toFixed(3)}″   over ${ks.length} measurement(s)`,
  );
  out.push(`  areas added: ${added}   committed areas with no Battlemaster counterpart: ${orphaned}`);
  return out.join("\n");
}

function buildPartMappingDoc(
  snapshot: ReturnType<typeof loadSnapshot>,
  mapping: ReturnType<typeof learnPartMapping>,
): string {
  const out: string[] = [];
  out.push("# Battlemaster part → 40kdc feature template");
  out.push("");
  out.push("Generated by `npm run ingest:battlemaster -- extract`. Do not edit by hand.");
  out.push("");
  out.push("Derived by constraint propagation over the Battlemaster composites whose observed");
  out.push("40kdc child-template multiset is unambiguous, then closed with the multiplicity,");
  out.push("size-class and nub constraints. See `tools/src/battlemaster/parts.ts` for the method.");
  out.push("");
  out.push("| Battlemaster part | Dimensions | 40kdc template | Basis | Evidence |");
  out.push("| --- | --- | --- | --- | --- |");
  for (const e of mapping.evidence) {
    const part = snapshot.catalog.parts.find((p) => p.name === e.part);
    const dims = part ? `${part.width}×${part.height}″` : "—";
    out.push(
      `| \`${e.part}\` | ${dims} | \`${mapping.mapping[e.part] ?? "—"}\` | ${e.basis} | ` +
        `${e.composites} pure composites, ${e.observations} obs |`,
    );
  }
  if (Object.keys(PART_FIT_WARNINGS).length > 0) {
    out.push("");
    out.push("## Known imperfect fits");
    out.push("");
    for (const [p, why] of Object.entries(PART_FIT_WARNINGS)) {
      if (mapping.mapping[p]) out.push(`- **${p} → \`${mapping.mapping[p]}\`** — ${why}`);
    }
  }
  if (mapping.warnings.length > 0) {
    out.push("");
    out.push("## Warnings");
    out.push("");
    for (const w of mapping.warnings) out.push(`- ${w.trim()}`);
  }
  out.push("");
  return out.join("\n");
}

function buildReport(
  deltas: LayoutDelta[],
  projected: ProjectedLayout[],
  cal: ReturnType<typeof calibrate>,
  mapping: ReturnType<typeof learnPartMapping>,
  snapshotLayouts: number,
  symmetryNotes: string[],
): string {
  const out: string[] = [];
  const pos = deltas.flatMap((d) => d.positions).sort((a, b) => a - b);
  const rot = deltas.flatMap((d) => d.rotations).sort((a, b) => a - b);
  const ks = deltas.flatMap((d) => d.keystones).sort((a, b) => a - b);

  out.push("# Battlemaster layout intake");
  out.push("");
  out.push("Generated by `npm run ingest:battlemaster -- extract`. Do not edit by hand.");
  out.push("");
  out.push(
    "Geometry for the 11e Chapter Approved terrain layouts, re-sourced from Battlemaster's " +
      "public TTS Map API. Card identity (`id`, `name`, `mission_matchup_id`, `variant`, " +
      "`deployment_pattern_id`, `game_version`) and authoring intent (`keystones`, " +
      "`link_group`, `objective_role`) are preserved from the committed records; every " +
      "`position`, `rotation_degrees` and child-feature placement comes from Battlemaster.",
  );
  out.push("");
  out.push("## Summary");
  out.push("");
  out.push(`- Battlemaster layouts in snapshot: **${snapshotLayouts}**; projected: **${deltas.length}**`);
  out.push(`- Instances already agreeing before the intake: **${cal.agreeing}/${cal.totalInstances}**`);
  out.push(
    `- Position correction: p50 **${percentile(pos, 0.5).toFixed(3)}″**, p90 ` +
      `**${percentile(pos, 0.9).toFixed(3)}″**, max **${(pos[pos.length - 1] ?? 0).toFixed(3)}″** ` +
      `(${pos.filter((d) => d > 0.15).length} of ${pos.length} areas moved >0.15″)`,
  );
  out.push(
    `- Rotation correction: p50 **${percentile(rot, 0.5).toFixed(2)}°**, max ` +
      `**${(rot[rot.length - 1] ?? 0).toFixed(2)}°** (${rot.filter((d) => d > 1).length} of ${rot.length} changed >1°)`,
  );
  out.push(
    `- Keystone distance drift: p50 **${percentile(ks, 0.5).toFixed(3)}″**, p90 ` +
      `**${percentile(ks, 0.9).toFixed(3)}″**, max **${(ks[ks.length - 1] ?? 0).toFixed(3)}″** ` +
      `over ${ks.length} measurements`,
  );
  out.push(`- Areas added: **${deltas.reduce((s, d) => s + d.added, 0)}**`);
  out.push("");
  out.push(
    "Keystone drift is expected to be large wherever a placement was wrong — the printed " +
      "dimension follows the corrected geometry. The number to watch is drift on cards whose " +
      "position barely moved, which would signal a vertex-index problem rather than a fix.",
  );

  // ── Calibration + mapping, inlined so the report stands alone.
  out.push("");
  out.push("## Calibration");
  out.push("");
  out.push("| Area template | Size class | Offset | Basis | Decision margin | 180° self-symmetry |");
  out.push("| --- | --- | --- | --- | --- | --- |");
  for (const t of cal.templates) {
    out.push(
      `| \`${t.areaTemplate}\` | \`${t.sizeClass}\` | ${t.offset}° | ${t.basis} | ` +
        `${Number.isFinite(t.margin) ? `${t.margin.toFixed(4)}″` : "n/a"} | ${t.symmetry.toFixed(4)}″ |`,
    );
  }
  out.push("");
  out.push(
    "The orientation offset carries Battlemaster's artwork orientation onto the 40kdc " +
      "footprint's. A bounding-box comparison narrows it to two candidates; position " +
      "residual then cannot separate them, because every Chapter Approved card is itself " +
      "180°-symmetric and the residual comes out exactly degenerate. The `Basis` column " +
      "records what did decide each one:",
  );
  out.push("");
  out.push(
    "- `bbox+on-board` — the alternative pushes terrain off the 60×44 board. Decisive for " +
      "`area-trapezoid`, the one strongly asymmetric footprint (its centroid sits 1.66″ off " +
      "its bounding-box centre), where the wrong choice overhangs by up to 0.93″.",
  );
  out.push(
    "- `bbox+reference-card` — taken from `take-and-hold-vs-purge-the-foe-2`, the only " +
      "hand-authored card, whose rotations are clean multiples of 90° where the scraped " +
      "cards' are not. The one independently trustworthy rotation source in the corpus.",
  );
  out.push(
    "- `bbox+keystones` — last resort, for a template the reference card cannot speak to. " +
      "A 180° change permutes footprint vertex indices and keystones reference vertices *by " +
      "index*, so the offset that least disturbs the printed dimensions keeps the author's " +
      "chosen corner. Mildly biased (a scraped card's own rotation may be 180° out), hence " +
      "last.",
  );

  out.push("");
  out.push("## Part mapping");
  out.push("");
  out.push("See `battlemaster-part-mapping.md`. Imperfect fits:");
  out.push("");
  for (const [p, why] of Object.entries(PART_FIT_WARNINGS)) {
    if (mapping.mapping[p]) out.push(`- **${p} → \`${mapping.mapping[p]}\`** — ${why}`);
  }

  // ── The independent check.
  const gt = deltas.find((d) => d.id === "take-and-hold-vs-purge-the-foe-2");
  out.push("");
  out.push("## Independent check: `take-and-hold-vs-purge-the-foe-2`");
  out.push("");
  out.push(
    "The only card that carried `source: \"gw-11e\"` — hand-authored rather than scraped, so " +
      "the closest thing to ground truth the repo had. Its pre-intake state is kept at " +
      "`tools/test/fixtures/terrain/gw-11e-ground-truth.json`. Battlemaster's drift from it:",
  );
  out.push("");
  if (gt) {
    const p = [...gt.positions].sort((a, b) => a - b);
    out.push(`- Areas: ${gt.piecesBefore} pieces → ${gt.piecesAfter}`);
    out.push(
      `- Position drift: p50 **${percentile(p, 0.5).toFixed(3)}″**, max **${gt.maxPosition.toFixed(3)}″**`,
    );
    out.push(
      `- Rotation drift: max **${(Math.max(...gt.rotations, 0)).toFixed(2)}°**; keystone drift max ` +
        `**${gt.maxKeystone.toFixed(3)}″**`,
    );
    out.push("");
    out.push(
      "Most of this card already agreed to hundredths of an inch; the outliers are its " +
        "`area-trapezoid` and `area-long-line` placements, which is consistent with " +
        "`area-trapezoid` having been held back as unfittable by the footprint ingest.",
    );
  } else {
    out.push("- Not present in the snapshot.");
  }

  out.push("");
  out.push("## Invariants");
  out.push("");
  out.push(
    "Every projected layout resolves, keeps all geometry on the 60×44 board, and stays " +
      "180°-rotationally symmetric. Symmetry is the load-bearing check: the Chapter Approved " +
      "cards are symmetric by design, so a wrong orientation offset, anchor compensation or " +
      "instance assignment shows up here even when each piece looks individually plausible.",
  );
  if (symmetryNotes.length > 0) {
    out.push("");
    out.push("Cards carrying a residual sub-limit asymmetry:");
    out.push("");
    for (const n of symmetryNotes) out.push(`- ${n}`);
  }
  const fixes = projected.flatMap((p) => p.symmetryFixes);
  if (fixes.length > 0) {
    out.push("");
    out.push("### Upstream symmetry slips corrected");
    out.push("");
    out.push(
      "43 of Battlemaster's 45 layouts are *exactly* 180°-symmetric. The pairs below were " +
        "not, and the evidence that this is an upstream slip rather than a design choice is " +
        "strong: the two affected cards carry byte-identical coordinates (one mistake, " +
        "copied), each pair's rotations differ by exactly 180° so only position is off, and " +
        "the error is exactly (−0.5, −0.5) — a round half-inch nudge. Propagating it would " +
        "break `keystone-pairing`, which requires a keystone's reflected vertex to land " +
        "within 0.25″ of its twin so both halves of a printed card measure alike. Each piece " +
        "was moved half the error onto the symmetric mean:",
    );
    out.push("");
    for (const n of fixes) out.push(`- ${n}`);
  }

  // ── Notes worth a human's eye.
  const notes = projected.flatMap((p) => p.objectiveNotes);
  if (notes.length > 0) {
    out.push("");
    out.push("## Objective-role notes");
    out.push("");
    for (const n of notes) out.push(`- ${n}`);
  }
  const orphans = projected.filter((p) => p.orphaned.length > 0);
  if (orphans.length > 0) {
    out.push("");
    out.push("## Committed areas with no Battlemaster counterpart");
    out.push("");
    for (const p of orphans) {
      out.push(`- \`${p.layout.id}\`: ${p.orphaned.map((o) => `\`${o.id}\``).join(", ")}`);
    }
  }
  const additions = projected.filter((p) => p.added > 0);
  if (additions.length > 0) {
    out.push("");
    out.push("## Areas added from Battlemaster");
    out.push("");
    out.push(
      "Areas Battlemaster places that the committed card was missing. They arrive with " +
        "geometry and children but no `keystones` — add dimension lines by hand if these " +
        "cards are to be printed.",
    );
    out.push("");
    for (const p of additions) out.push(`- \`${p.layout.id}\`: **${p.added}** area(s) added`);
  }

  // ── Per-layout table, sorted by how much moved.
  out.push("");
  out.push("## Per-layout deltas");
  out.push("");
  out.push("Sorted by largest position correction.");
  out.push("");
  out.push("| Layout | Pieces | Max Δposition | p50 Δposition | Max Δrotation | Max Δkeystone | Added |");
  out.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const d of [...deltas].sort((a, b) => b.maxPosition - a.maxPosition)) {
    const p = [...d.positions].sort((a, b) => a - b);
    out.push(
      `| \`${d.id}\` | ${d.piecesBefore}→${d.piecesAfter} | ${d.maxPosition.toFixed(3)}″ | ` +
        `${percentile(p, 0.5).toFixed(3)}″ | ${Math.max(...d.rotations, 0).toFixed(2)}° | ` +
        `${d.maxKeystone.toFixed(3)}″ | ${d.added} |`,
    );
  }
  out.push("");
  return out.join("\n");
}

export { round4 };
