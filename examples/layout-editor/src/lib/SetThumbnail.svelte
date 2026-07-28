<script lang="ts">
  import { templateById, orientedOffsets, resolveSetFeature, rotateCw } from "./model.js";
  import type { TerrainSetDef } from "./sets.js";

  /**
   * Composite thumbnail for a terrain set: the area footprint centred at the
   * origin with each feature's oriented footprint at its area-local placement.
   *
   * Feature placements come from `resolveSetFeature` — the same seam `addSet`
   * stamps through — so the preview provably is what lands. The area's own
   * `rotation` is composed onto each feature too (offsets rotate with it, and the
   * local centroid rotates about the area centroid at the origin); without that a
   * set declaring an area rotation would render its features detached from the
   * plate they sit on.
   */
  interface Props {
    set: TerrainSetDef;
    size?: number;
  }
  let { set, size = 56 }: Props = $props();

  interface Poly {
    kind: "area" | "feature";
    points: { x: number; y: number }[];
  }

  const polys = $derived.by((): Poly[] => {
    const out: Poly[] = [];
    const areaTmpl = templateById(set.area.template);
    if (!areaTmpl) return out;
    const areaRot = set.area.rotation ?? 0;
    out.push({ kind: "area", points: orientedOffsets(areaTmpl.footprint, areaRot, "none") });
    for (const f of set.features) {
      const r = resolveSetFeature(areaTmpl.footprint, f);
      if (!r) continue;
      const centroid = rotateCw(r.position, areaRot);
      out.push({
        kind: "feature",
        points: orientedOffsets(r.template.footprint, r.rotation + areaRot, r.mirror).map((o) => ({
          x: o.x + centroid.x,
          y: o.y + centroid.y,
        })),
      });
    }
    return out;
  });

  const view = $derived.by(() => {
    const all = polys.flatMap((p) => p.points);
    if (all.length === 0) return "0 0 1 1";
    const xs = all.map((v) => v.x);
    const ys = all.map((v) => v.y);
    const pad = 0.4;
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    const w = Math.max(...xs) - minX + pad;
    const h = Math.max(...ys) - minY + pad;
    return `${minX} ${minY} ${w} ${h}`;
  });

  const pts = (vs: { x: number; y: number }[]): string => vs.map((v) => `${v.x},${v.y}`).join(" ");
</script>

<svg class="thumb" width={size} height={size} viewBox={view} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
  {#each polys as p, i (i)}
    <polygon points={pts(p.points)} class="fp {p.kind}" />
  {/each}
</svg>

<style>
  .thumb {
    display: block;
  }
  .fp {
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .fp.area {
    fill: var(--piece-area-fill);
    stroke: var(--piece-area-stroke);
  }
  .fp.feature {
    fill: var(--piece-feature-fill);
    stroke: var(--piece-feature-stroke);
  }
</style>
