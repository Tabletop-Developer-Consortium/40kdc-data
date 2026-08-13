<script lang="ts" module>
  import type { Dataset, TerrainLayout } from "@alpaca-software/40kdc-data";
  import { BOARD, diagramModel, pieceRenderKey, type DiagramModel } from "./layout-geometry.js";

  // Memoized across every thumb instance: dataset layouts are immutable for
  // the life of the build, and a grid renders dozens of thumbs.
  const cache = new Map<string, DiagramModel>();
  function modelFor(ds: Dataset, l: TerrainLayout): DiagramModel {
    const hit = cache.get(l.id);
    if (hit) return hit;
    const m = diagramModel(ds, l);
    cache.set(l.id, m);
    return m;
  }
</script>

<script lang="ts">
  /**
   * Mini read-only render of a terrain layout: the deployment pattern (zones +
   * divider) under the resolved piece polygons on the portrait-rotated board.
   * No grid, no labels — it reads at thumbnail size. Built on `diagramModel`
   * (package types only), unlike the editor's LayoutThumb which rides the
   * editor model.
   */
  let { ds, layout }: { ds: Dataset; layout: TerrainLayout } = $props();

  const model = $derived(modelFor(ds, layout));
  const pts = (vs: { x: number; y: number }[]): string => vs.map((v) => `${v.x},${v.y}`).join(" ");
</script>

<svg class="thumb" viewBox="0 0 44 60" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
  <g transform="translate(44,0) rotate(90)">
    <rect x="0" y="0" width={BOARD.width} height={BOARD.height} class="bg" />
    {#each model.zones as z, i (z.player + i)}
      <polygon
        points={pts(z.points)}
        class="zone"
        style:fill={z.color ?? "#14b8a6"}
        style:stroke={z.color ?? "#14b8a6"}
      />
    {/each}
    {#if model.divider}
      <line
        x1={model.divider.from.x}
        y1={model.divider.from.y}
        x2={model.divider.to.x}
        y2={model.divider.to.y}
        class="divider"
      />
    {/if}
    {#each model.pieces as p, i (pieceRenderKey(p, i))}
      <polygon points={pts(p.vertices)} class="piece {p.piece_type} {model.pieceCategories.get(p.id ?? '') ?? ''}" />
    {/each}
  </g>
</svg>

<style>
  .thumb {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 3px;
  }
  .bg {
    fill: oklch(0.74 0.008 220);
  }
  /* Stronger than the full-size card's zone treatment so the pattern reads at
     thumb size. */
  .zone {
    fill-opacity: 0.3;
    stroke-opacity: 0.85;
    stroke-width: 0.5;
  }
  .divider {
    stroke: oklch(0.28 0.02 255);
    stroke-width: 0.35;
    stroke-dasharray: 1.4 1.1;
    opacity: 0.8;
  }
  .piece {
    stroke-width: 0.3;
  }
  .piece.area {
    fill: oklch(0.55 0.15 258 / 0.42);
    stroke: oklch(0.42 0.16 262);
  }
  .piece.feature {
    fill: oklch(0.68 0.15 62 / 0.55);
    stroke: oklch(0.5 0.16 58);
  }
  .piece.feature.dense {
    fill: oklch(0.70 0.14 145 / 0.45);
    stroke: oklch(0.52 0.15 145);
  }
  .piece.feature.light {
    fill: oklch(0.68 0.15 62 / 0.55);
    stroke: oklch(0.5 0.16 58);
  }
</style>
