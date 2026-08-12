<script lang="ts">
  import { resolveLayout } from "@alpaca-software/40kdc-data";
  import type { ResolvedPiece, TerrainLayout, TerrainTemplate } from "@alpaca-software/40kdc-data";
  import { referenceImageBox, type ReferenceFit } from "./model.js";

  interface Props {
    layout: TerrainLayout;
    templates: TerrainTemplate[];
    referenceImage?: string | null;
    referenceOpacity?: number;
    referenceFit?: ReferenceFit;
    terrainOpacity?: number;
  }

  let {
    layout,
    templates,
    referenceImage = null,
    referenceOpacity = 0.45,
    referenceFit = {},
    terrainOpacity = 1,
  }: Props = $props();

  const board = { width: 60, height: 44 } as const;
  const resolved = $derived(resolveLayout(layout, templates) as ResolvedPiece[]);
  const referenceBox = $derived(referenceImageBox(board, referenceFit));
  const areaIds = $derived(new Set((layout.pieces ?? []).map((piece) => piece.id).filter(Boolean)));
  const featureColor = (piece: ResolvedPiece): string => {
    const name = piece.name?.toLowerCase() ?? "";
    if (name.includes("generator") || name.includes("pipes") || name.includes("barrier")) return "#2d8b57";
    return "#b05a20";
  };
  const points = (piece: ResolvedPiece): string => piece.vertices.map((point) => `${point.x},${point.y}`).join(" ");
</script>

<svg class="projected-board" viewBox="0 0 44 60" role="img" aria-label={`Battlemaster projection: ${layout.name}`}>
  <g transform="translate(44 0) rotate(90)">
    <rect x="0" y="0" width="60" height="44" class="board-bg" />
    {#if referenceImage}
      <image
        href={referenceImage}
        x={referenceBox.x}
        y={referenceBox.y}
        width={referenceBox.width}
        height={referenceBox.height}
        opacity={referenceOpacity}
        preserveAspectRatio="none"
        transform={referenceBox.transform}
      />
    {/if}
    <g opacity={terrainOpacity}>
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
    </g>
  </g>
</svg>

<style>
  .projected-board {
    display: block;
    width: 100%;
    height: 100%;
    min-height: 0;
    background: #0b0d0f;
    border: 1px solid var(--rim-strong);
    border-radius: 4px;
  }
  .board-bg { fill: #d8e2e8; }
  polygon {
    vector-effect: non-scaling-stroke;
    stroke-linejoin: round;
  }
  .area {
    fill: #4f95dc26;
    stroke: #2876bd;
    stroke-width: 0.09;
    stroke-dasharray: 0.35 0.2;
  }
  .feature {
    fill: color-mix(in srgb, var(--piece-color) 24%, transparent);
    stroke: var(--piece-color);
    stroke-width: 0.16;
  }
</style>
