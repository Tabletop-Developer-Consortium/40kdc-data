<script lang="ts">
  import { resolveLayout } from "@alpaca-software/40kdc-data";
  import type { ResolvedPiece, ResolvedWall, TerrainLayout, TerrainTemplate } from "@alpaca-software/40kdc-data";


  interface Props {
    layout: TerrainLayout;
    templates: TerrainTemplate[];
    opacity?: number;
  }

  let {
    layout,
    templates,
    opacity = 0.6,
  }: Props = $props();

  const resolved = $derived(resolveLayout(layout, templates) as ResolvedPiece[]);

  const areaIds = $derived(new Set((layout.pieces ?? []).map((piece) => piece.id).filter(Boolean)));
  const featureColor = (piece: ResolvedPiece): string => {
    const name = piece.name?.toLowerCase() ?? "";
    if (name.includes("generator") || name.includes("pipes") || name.includes("barrier")) return "#2d8b57";
    return "#b05a20";
  };
  const points = (piece: ResolvedPiece): string => piece.vertices.map((point) => `${point.x},${point.y}`).join(" ");
  const wallPts = (pts: ResolvedWall["points"]): string => pts.map((p) => `${p.x},${p.y}`).join(" ");
</script>

<svg
  class="projected-board"
  viewBox="0 0 44 60"
  preserveAspectRatio="xMidYMid meet"
  role="img"
  aria-label={`Battlemaster comparison overlay: ${layout.name}`}
  {opacity}
>
  <g transform="translate(44 0) rotate(90)">
    {#each resolved as piece, index (`${piece.id ?? piece.name}-${index}`)}
      <polygon
        points={points(piece)}
        class:area={!!piece.id && areaIds.has(piece.id)}
        class:feature={!piece.id || !areaIds.has(piece.id)}
        style:--piece-color={featureColor(piece)}
      >
        <title>{piece.name ?? piece.id ?? "Battlemaster terrain"}</title>
      </polygon>
    {/each}
    {#each resolved as piece, pi}
      {#if piece.walls}
        {#each piece.walls as w, wi}
          <polyline
            points={wallPts(w.points)}
            class="wall"
            class:dense={piece.terrain_category === "dense"}
            class:light={piece.terrain_category === "light"}
            stroke-width={w.thickness ?? 0.25}
          />
        {/each}
      {/if}
    {/each}
  </g>
</svg>

<style>
  .projected-board {
    position: absolute;
    z-index: 2;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    min-height: 0;
    pointer-events: none;
  }

  polygon {
    vector-effect: non-scaling-stroke;
    stroke-linejoin: round;
  }
  .area {
    fill: oklch(0.68 0.18 205 / 0.12);
    stroke: oklch(0.5 0.2 205);
    stroke-width: 0.18;
    stroke-dasharray: 0.45 0.24;
  }
  .feature {
    fill: color-mix(in srgb, var(--piece-color) 12%, transparent);
    stroke: oklch(0.55 0.24 330);
    stroke-width: 0.22;
  }
  .wall {
    fill: none;
    stroke: oklch(0.38 0.18 330);
    stroke-linecap: round;
    stroke-linejoin: round;
    pointer-events: none;
  }
  .wall.dense { stroke: oklch(0.42 0.2 155); }
  .wall.light { stroke: oklch(0.48 0.19 70); stroke-dasharray: 0.4 0.25; }
</style>
