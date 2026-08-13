<script lang="ts">
  import type {
    DiagramDivider,
    DiagramGuide,
    DiagramMarker,
    DiagramZone,
    ResolvedPiece,
    Vec2,
  } from "./layout-geometry.js";
  import { pieceRenderKey } from "./layout-geometry.js";

  // Read-only GW-style terrain card: the resolved layout drawn portrait
  // (board rotated 90° CW, like the printed cards and the layout editor) with
  // deployment zones, the territory divider, objective rings, and the
  // authored keystone dimension lines. Pure presentation — derive the props
  // with `diagramModel` from ./layout-geometry.
  //
  // Styling is self-contained (light tabletop on the shadowboxing dark
  // chrome) so the component works in any host app, Tailwind or not.
  let {
    pieces,
    pieceCategories = new Map(),
    zones = [],
    divider = null,
    markers = [],
    guides = [],
  }: {
    pieces: ResolvedPiece[];
    pieceCategories?: Map<string, string>;
    zones?: DiagramZone[];
    divider?: DiagramDivider | null;
    markers?: DiagramMarker[];
    guides?: DiagramGuide[];
  } = $props();

  const BOARD = { width: 60, height: 44 };

  const pts = (vs: Vec2[]): string => vs.map((v) => `${v.x},${v.y}`).join(" ");
  /** Board (x,y) → display, matching translate(44,0) rotate(90), for upright labels. */
  const toDisplay = (b: Vec2): Vec2 => ({ x: BOARD.height - b.y, y: b.x });
</script>

<svg class="diagram" viewBox="0 0 44 60" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Terrain layout card, 60 by 44 inch board shown portrait">
  <g transform="translate(44,0) rotate(90)">
    <rect x="0" y="0" width={BOARD.width} height={BOARD.height} class="bg" />

    {#each zones as z, i (z.player + i)}
      <polygon points={pts(z.points)} class="zone" style:fill={z.color ?? "#14b8a6"} style:stroke={z.color ?? "#14b8a6"} />
    {/each}

    <!-- 5" honor lines only: card-weight, not editor-weight -->
    {#each Array(BOARD.width / 5 + 1) as _, i (i)}
      <line x1={i * 5} y1="0" x2={i * 5} y2={BOARD.height} class="grid" />
    {/each}
    {#each Array(Math.floor(BOARD.height / 5) + 1) as _, i (i)}
      <line x1="0" y1={i * 5} x2={BOARD.width} y2={i * 5} class="grid" />
    {/each}

    {#if divider}
      <line x1={divider.from.x} y1={divider.from.y} x2={divider.to.x} y2={divider.to.y} class="divider" />
    {/if}

    {#each pieces as p, i (pieceRenderKey(p, i))}
      <polygon points={pts(p.vertices)} class="piece {p.piece_type} {pieceCategories.get(p.id ?? '') ?? ''}" />
    {/each}

    {#each markers as m, i (i)}
      <circle cx={m.at.x} cy={m.at.y} r="1.5" class="obj-ring" />
      <circle cx={m.at.x} cy={m.at.y} r="0.25" class="obj-dot" />
    {/each}

    {#each guides as g, i (i)}
      <line x1={g.from.x} y1={g.from.y} x2={g.to.x} y2={g.to.y} class="keystone" />
      <circle cx={g.to.x} cy={g.to.y} r="0.35" class="keystone-dot" />
    {/each}
  </g>

  <!-- upright labels (the svg itself is not rotated) -->
  <g>
    {#if divider}
      {#each divider.badges as b, i (i)}
        {@const d = toDisplay(b.at)}
        <circle cx={d.x} cy={d.y} r="1.4" class="badge" style:fill={b.color} />
        <text x={d.x} y={d.y} class="badge-text">{b.player}</text>
      {/each}
    {/if}
    {#each guides as g, i (i)}
      {@const d = toDisplay(g.mid)}
      <!-- facingAngle turns the label toward its owning player (0 = upright) -->
      <text x={d.x} y={d.y} transform="rotate({g.facingAngle}, {d.x}, {d.y})" class="keystone-label">{g.text}</text>
    {/each}
  </g>
</svg>

<style>
  .diagram {
    display: block;
    width: 100%;
    height: auto;
    border: 1px solid #66666f; /* --color-border-strong */
    border-radius: 4px;
    background: oklch(0.85 0.008 220);
  }
  .bg {
    fill: oklch(0.85 0.008 220);
  }
  .zone {
    fill-opacity: 0.14;
    stroke-opacity: 0.45;
    stroke-width: 0.18;
  }
  .grid {
    stroke: oklch(0.78 0.01 220);
    stroke-width: 0.07;
  }
  .divider {
    stroke: oklch(0.45 0.02 235);
    stroke-width: 0.16;
    stroke-dasharray: 0.9 0.6;
  }
  .piece {
    stroke-width: 0.18;
  }
  .piece.area {
    fill: oklch(0.62 0.13 250 / 0.28);
    stroke: oklch(0.62 0.15 250);
  }
  .piece.feature {
    fill: oklch(0.74 0.14 75 / 0.5);
    stroke: oklch(0.74 0.15 75);
  }
  .piece.feature.dense {
    fill: oklch(0.70 0.14 145 / 0.45);
    stroke: oklch(0.52 0.15 145);
  }
  .piece.feature.light {
    fill: oklch(0.74 0.14 75 / 0.5);
    stroke: oklch(0.74 0.15 75);
  }
  /* Empty area (terrain: false) — e.g. a 10th-ed objective marker on open
     ground: a dashed ring in the objective colour, never a terrain fill.
     Placed after .piece.area so it wins the equal-specificity override. */
  .piece.empty {
    fill: none;
    stroke: oklch(0.4 0.02 235);
    stroke-width: 0.16;
    stroke-dasharray: 0.45 0.3;
  }
  .obj-ring {
    fill: none;
    stroke: oklch(0.4 0.02 235);
    stroke-width: 0.14;
    stroke-dasharray: 0.45 0.3;
  }
  .obj-dot {
    fill: oklch(0.4 0.02 235);
  }
  .keystone {
    stroke: oklch(0.55 0.13 70);
    stroke-width: 0.16;
  }
  .keystone-dot {
    fill: oklch(0.55 0.13 70);
  }
  .badge {
    stroke: oklch(0.95 0.005 220);
    stroke-width: 0.18;
  }
  .badge-text {
    fill: oklch(0.98 0 0);
    font-size: 1.6px;
    font-weight: 700;
    text-anchor: middle;
    dominant-baseline: central;
    font-family: ui-monospace, monospace;
  }
  .keystone-label {
    fill: oklch(0.45 0.13 70);
    font-size: 1.7px;
    font-weight: 600;
    text-anchor: middle;
    /* Centre the glyph box on the anchor so facing rotation pivots cleanly. */
    dominant-baseline: central;
    font-family: ui-monospace, monospace;
    paint-order: stroke;
    stroke: oklch(0.85 0.008 220);
    stroke-width: 0.32px;
  }
</style>
