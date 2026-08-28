<script lang="ts">
  import Handles from "./Handles.svelte";
  import ClockPicker from "./ClockPicker.svelte";
  import {
    boardOf,
    orientedFootprint,
    upperFloorBoardVerts,
    isGroundBlocked,
    bbox,
    keystoneDisplays,
    snapToKeystoneGrid,
    KEYSTONE_INCREMENT,
    referenceImageBox,
    templateById,
    type EditLayout,
    type EditPiece,
    type Mirror,
    type Vec2,
    type SolverRef,
    type SolverLine,
    type SolverViz,
    type OrientedFootprint,
    type DeployZone,
    type TerritoryDivider,
    type ObjectiveMarker,
    type ReferenceFit,
  } from "./model.js";
  import type { ResolvedPiece } from "@alpaca-software/40kdc-data";
  import { facingAngle, formatKeystoneDistance } from "../../../_shared/layout-geometry.js";

  interface Props {
    layout: EditLayout;
    resolved: ResolvedPiece[];
    selectedId: string | null;
    selectedPiece: EditPiece | null;
    solver: SolverViz;
    zones: DeployZone[];
    divider: TerritoryDivider | null;
    markers: ObjectiveMarker[];
    /** Draw the pinned keystone dimension lines (the pins themselves stay on the pieces). */
    showKeystones?: boolean;
    /** Rotate keystone labels to face the player whose board half holds the piece — always an axis-aligned top/bottom or left/right split (needs `divider`). */
    keystoneFacing?: boolean;
    /** Resolved ids of pieces named by a "needs review" warning, outlined on the board. */
    warnPieceIds?: Set<string>;
    /** Ephemeral reference image: a rendered Event Companion page, or a chosen photo. */
    referenceImage?: string | null;
    referenceOpacity?: number;
    /** How that image is fitted over the board — turn, nudge and zoom. See `referenceImageBox`. */
    referenceFit?: ReferenceFit;
    /** Opacity of the authored terrain/grid overlay, leaving the reference image fully visible. */
    terrainOpacity?: number;
    /** ¼″ keystone-grid snapping for armed top-level areas. Alt suspends it live. */
    snap?: { enabled: boolean; step: number };
    /** The piece whose keystone anchor is being picked, if any (clock mode). */
    clockPiece?: EditPiece | null;
    /** The corner index under the pointer during a clock pick. */
    clockCandidate?: number | null;
    onselect: (id: string | null) => void;
    onmove: (id: string, position: Vec2) => void;
    onorient: (id: string, patch: { rotation_degrees?: number; mirror?: Mirror }) => void;
    onclockhover?: (index: number | null, pointer: Vec2) => void;
    onclockcommit?: (index: number) => void;
    onclockcancel?: () => void;
  }
  let {
    layout,
    resolved,
    selectedId,
    selectedPiece,
    solver,
    zones,
    divider,
    markers,
    showKeystones = true,
    keystoneFacing = false,
    warnPieceIds = new Set<string>(),
    referenceImage = null,
    referenceOpacity = 0.45,
    referenceFit = {},
    terrainOpacity = 1,
    snap = { enabled: true, step: KEYSTONE_INCREMENT },
    clockPiece = null,
    clockCandidate = null,
    onselect,
    onmove,
    onorient,
    onclockhover,
    onclockcommit,
    onclockcancel,
  }: Props = $props();

  // The board is shown rotated 90° CW for portrait terrain cards. Board coords stay
  // y-down; the content group carries the rotation, and we map pointers back
  // through its CTM so all geometry stays in true board space. `board` is the
  // active layout's extents (the 60×44 standard, or a per-layout override).
  const board = $derived(boardOf(layout));
  const centre = $derived({ x: board.width / 2, y: board.height / 2 });
  const referenceBox = $derived(referenceImageBox(board, referenceFit));
  let gEl = $state<SVGGElement | null>(null);
  let svgEl = $state<SVGSVGElement | null>(null);
  let drag = $state<{ id: string; offset: Vec2; from: Vec2; moved: boolean } | null>(null);
  // The clock picker shields the board, so a drag begun before it mounted could
  // never be released onto a piece — drop it rather than leave it live.
  $effect(() => {
    if (clockPiece) drag = null;
  });

  /**
   * Map a client-space point into board inches, for drops that originate
   * outside this component (palette drag). Null when the point is not over
   * the board svg — the caller treats that as "cancel".
   */
  export function clientToBoard(clientX: number, clientY: number): Vec2 | null {
    const ctm = gEl?.getScreenCTM();
    if (!ctm || !svgEl) return null;
    const r = svgEl.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
    const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  }

  function toBoard(e: PointerEvent): Vec2 {
    const ctm = gEl?.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  }
  function pxPerInch(): number {
    const ctm = gEl?.getScreenCTM();
    return ctm ? Math.hypot(ctm.a, ctm.b) : 12;
  }
  /** Board (x,y) → display, matching the group's translate(board.height,0) rotate(90), for upright labels. */
  function toDisplay(b: Vec2): Vec2 {
    return { x: board.height - b.y, y: b.x };
  }
  // 4-dp, matching `clampToBoard` — a snapped centroid is generally not a round
  // number, and rounding it to 2-dp would push its printed distance off the ¼″ mark
  // the snap just put it on.
  const clamp = (n: number, hi: number): number => Math.max(0, Math.min(hi, Math.round(n * 1e4) / 1e4));

  function onPointerDown(e: PointerEvent, p: ResolvedPiece): void {
    if (!p.id) return;
    e.stopPropagation();
    onselect(p.id);
    const piece = layout.pieces.find((q) => q.id === p.id);
    if (!piece) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const b = toBoard(e);
    // Drag in board space; for a parented feature the stored centroid is
    // area-local, so anchor the grab offset to its board-space centroid.
    const c = orientedFootprint(piece, layout)?.centroid ?? piece.position;
    drag = { id: p.id, offset: { x: b.x - c.x, y: b.y - c.y }, from: b, moved: false };
  }
  /** Board inches the pointer must travel before a press counts as a drag, so
   *  clicking a piece to select it never moves (or snaps) it. */
  const DRAG_EPS_IN = 0.05;
  function onPointerMove(e: PointerEvent): void {
    if (!drag) return;
    const b = toBoard(e);
    if (!drag.moved) {
      if (Math.hypot(b.x - drag.from.x, b.y - drag.from.y) < DRAG_EPS_IN) return;
      drag.moved = true;
    }
    const raw = { x: b.x - drag.offset.x, y: b.y - drag.offset.y };
    // Snap an ARMED top-level area to the ¼″ grid of its own printed distances —
    // never to a grid on the centroid, which would put every measurement off-mark.
    // Alt suspends it live (read per-move, so it can be pressed mid-drag), and a
    // parented feature or a piece with no 1H+1V anchor drags exactly as before.
    const piece = layout.pieces.find((q) => q.id === drag!.id);
    const snapped =
      snap.enabled && !e.altKey && piece && !piece.parent_area_id
        ? snapToKeystoneGrid(piece, board, raw, snap.step)
        : null;
    const at = snapped?.position ?? raw;
    onmove(drag.id, { x: clamp(at.x, board.width), y: clamp(at.y, board.height) });
  }
  function endDrag(): void {
    drag = null;
  }

  const pts = (p: ResolvedPiece): string => p.vertices.map((v) => `${v.x},${v.y}`).join(" ");
  const polyPts = (vs: Vec2[]): string => vs.map((v) => `${v.x},${v.y}`).join(" ");

  const twinId = $derived(selectedPiece?.twin_id ?? null);
  const editById = $derived(new Map(layout.pieces.map((p) => [p.id, p])));

  // Upper-floor platforms across the layout (dashed overlays).
  const uppers = $derived(
    layout.pieces
      .map((p) => ({ id: p.id, verts: upperFloorBoardVerts(p, layout) }))
      .filter((u): u is { id: string; verts: Vec2[] } => !!u.verts),
  );

  const selOriented = $derived<OrientedFootprint | null>(
    selectedPiece ? orientedFootprint(selectedPiece, layout) : null,
  );

  // The piece a solver line/hover draws against — the selection unless the
  // viz names another piece (the attachment solver points at both pieces).
  function orientedFor(pieceId: string | undefined): OrientedFootprint | null {
    if (!pieceId) return selOriented;
    const p = editById.get(pieceId);
    return p ? orientedFootprint(p, layout) : null;
  }
  const solverGuides = $derived(
    solver.lines
      .map((line) => ({ line, o: orientedFor(line.pieceId) }))
      .filter((g): g is { line: SolverLine; o: OrientedFootprint } => !!g.o),
  );
  const hoverView = $derived.by(() => {
    if (!solver.hover) return null;
    const o = orientedFor(solver.hover.pieceId);
    return o ? { ref: solver.hover.ref, o } : null;
  });
  /** The edge segment a viz edge ref names: vertex `index` → the next vertex. */
  function edgeSeg(o: OrientedFootprint, index: number): [Vec2, Vec2] | null {
    const v0 = o.verticesBoard[index];
    const v1 = o.verticesBoard[(index + 1) % o.verticesBoard.length];
    return v0 && v1 ? [v0, v1] : null;
  }

  function refPoint(o: OrientedFootprint, ref: SolverRef): Vec2 {
    if (ref.kind === "vertex") return o.verticesBoard[ref.index] ?? o.centroid;
    const b = bbox(o.verticesBoard);
    if (ref.side === "min-x") return { x: b.minX, y: (b.minY + b.maxY) / 2 };
    if (ref.side === "max-x") return { x: b.maxX, y: (b.minY + b.maxY) / 2 };
    if (ref.side === "min-y") return { x: (b.minX + b.maxX) / 2, y: b.minY };
    return { x: (b.minX + b.maxX) / 2, y: b.maxY };
  }
  function faceSeg(o: OrientedFootprint, side: string): [Vec2, Vec2] {
    const b = bbox(o.verticesBoard);
    if (side === "min-x") return [{ x: b.minX, y: b.minY }, { x: b.minX, y: b.maxY }];
    if (side === "max-x") return [{ x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }];
    if (side === "min-y") return [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }];
    return [{ x: b.minX, y: b.maxY }, { x: b.maxX, y: b.maxY }];
  }
  // Label anchor: near the dot end of a dimension line so each label reads as
  // belonging to its line, but never past the midpoint (on short lines the
  // text would sit on the dot itself).
  function labelAnchor(from: Vec2, to: Vec2): Vec2 {
    const dx = from.x - to.x;
    const dy = from.y - to.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return to;
    const back = Math.min(len / 2, 3);
    return { x: to.x + (dx / len) * back, y: to.y + (dy / len) * back };
  }
  function guide(o: OrientedFootprint, line: SolverViz["lines"][number]) {
    const t = refPoint(o, line.ref);
    const from: Vec2 =
      line.edge === "left"
        ? { x: 0, y: t.y }
        : line.edge === "right"
          ? { x: board.width, y: t.y }
          : line.edge === "top"
            ? { x: t.x, y: 0 }
            : { x: t.x, y: board.height };
    return { from, to: t, labelAt: labelAnchor(from, t), text: `${line.distance}″` };
  }

  // Persisted keystones — the card's printed dimension lines — render for
  // EVERY piece, always, with live derived distances. Solid amber, unlike the
  // dashed teal solver guides (which are ephemeral and selection-scoped). An
  // unmeasurable keystone (stale vertex index after a footprint change) draws
  // its anchor with a "?" label instead of crashing.
  const keystoneGuides = $derived.by(() => {
    const out: { from: Vec2; to: Vec2; labelAt: Vec2; text: string; invalid: boolean; angle: number }[] = [];
    if (!showKeystones) return out;
    const byPiece = new Map(layout.pieces.map((p) => [p.id, p]));
    for (const d of keystoneDisplays(layout)) {
      const p = byPiece.get(d.pieceId);
      if (!p) continue;
      const o = orientedFootprint(p, layout);
      if (!o) continue;
      const t = refPoint(o, d.keystone.ref);
      const from: Vec2 =
        d.keystone.edge === "left"
          ? { x: 0, y: t.y }
          : d.keystone.edge === "right"
            ? { x: board.width, y: t.y }
            : d.keystone.edge === "top"
              ? { x: t.x, y: 0 }
              : { x: t.x, y: board.height };
      out.push({
        from,
        to: t,
        labelAt: labelAnchor(from, t),
        text: d.distance != null ? formatKeystoneDistance(d.distance, p.rotation_degrees) : "?",
        invalid: d.distance == null,
        // Face the piece's player when the toggle is on and an overlay divider
        // exists; 0 keeps today's upright labels.
        angle: keystoneFacing && divider ? facingAngle(divider, o.centroid) : 0,
      });
    }
    return out;
  });

  // Edge labels named for where they sit ON SCREEN after the portrait rotation,
  // with the board coordinate they pin as a suffix (board x0 runs along the top of
  // the card, x60 along the bottom; y44/y0 are the left/right ends).
  const edgeLabels = $derived([
    { at: toDisplay({ x: 1.4, y: board.height / 2 }), text: "top · x0" },
    { at: toDisplay({ x: board.width - 1.4, y: board.height / 2 }), text: `bottom · x${board.width}` },
    { at: toDisplay({ x: board.width / 2, y: board.height - 0.8 }), text: `left · y${board.height}` },
    { at: toDisplay({ x: board.width / 2, y: 0.8 }), text: "right · y0" },
  ]);
</script>

<svg
  bind:this={svgEl}
  class="board"
  viewBox="0 0 {board.height} {board.width}"
  preserveAspectRatio="xMidYMid meet"
  role="application"
  aria-label="Terrain board, {board.width} by {board.height} inches, shown portrait"
  onpointermove={onPointerMove}
  onpointerup={endDrag}
  onpointerleave={endDrag}
  onpointerdown={() => onselect(null)}
>
  <g class="board-layer" bind:this={gEl} transform="translate({board.height},0) rotate(90)">
    <rect x="0" y="0" width={board.width} height={board.height} class="board-bg" />
    {#if referenceImage}
      <image
        href={referenceImage}
        x={referenceBox.x}
        y={referenceBox.y}
        width={referenceBox.width}
        height={referenceBox.height}
        transform={referenceBox.transform}
        preserveAspectRatio="none"
        opacity={referenceOpacity}
        pointer-events="none"
      />
    {/if}
    <g class="map-content" opacity={terrainOpacity}>

    <!-- deployment zones (under the grid, like the printed card) -->
    {#each zones as z, i (z.player + i)}
      <polygon
        points={z.points.map((p) => `${p.x},${p.y}`).join(" ")}
        class="zone"
        style:fill={z.color ?? "var(--accent)"}
        style:stroke={z.color ?? "var(--accent)"}
      />
    {/each}

    <!-- 1" grid with honor lines every 5" -->
    {#each Array(board.width + 1) as _, i (i)}
      <line x1={i} y1="0" x2={i} y2={board.height} class="grid {i % 5 === 0 ? 'major' : 'minor'}" />
    {/each}
    {#each Array(board.height + 1) as _, i (i)}
      <line x1="0" y1={i} x2={board.width} y2={i} class="grid {i % 5 === 0 ? 'major' : 'minor'}" />
    {/each}

    <!-- centre of symmetry -->
    <line x1={centre.x - 1} y1={centre.y} x2={centre.x + 1} y2={centre.y} class="centre" />
    <line x1={centre.x} y1={centre.y - 1} x2={centre.x} y2={centre.y + 1} class="centre" />

    <!-- territory divider: the dashed line splitting the two players' halves -->
    {#if divider}
      <line x1={divider.from.x} y1={divider.from.y} x2={divider.to.x} y2={divider.to.y} class="divider" />
    {/if}

    {#each resolved as p, pi}
      {@const ep = p.id ? editById.get(p.id) : undefined}
      {@const tplCat = templateById(ep?.template)?.terrain_category ?? ''}
      <polygon
        points={pts(p)}
        class="piece {p.piece_type} {tplCat} {ep?.terrain === false ? 'empty' : ''} {p.id === selectedId
          ? 'selected'
          : ''} {p.id === twinId
          ? 'twin'
          : ''} {ep && isGroundBlocked(ep) ? 'blocked' : ''} {p.id && warnPieceIds.has(p.id)
          ? 'needs-review'
          : ''}"
        role="button"
        tabindex="0"
        aria-label={p.name ?? p.id ?? "piece"}
        onpointerdown={(e) => onPointerDown(e, p)}
      />
    {/each}

    <!-- wall polylines: resolved board-space walls from feature templates -->
    {#each resolved as p, pi}
      {#if p.walls}
        {#each p.walls as w, wi}
          <polyline
            points={polyPts(w.points)}
            class="wall {p.terrain_category ?? ''}"
            stroke-width={w.thickness ?? 0.25}
          />
        {/each}
      {/if}
    {/each}

    {#each uppers as u (u.id)}
      <polygon points={polyPts(u.verts)} class="upper" />
    {/each}

    <!-- objective markers: one ring per objective (a link_group union is one) -->
    {#each markers as m, i (i)}
      <circle cx={m.at.x} cy={m.at.y} r="1.5" class="objective-ring" />
      <circle cx={m.at.x} cy={m.at.y} r="0.25" class="objective-dot" />
    {/each}

    <!-- persisted keystones: the card's printed dimension lines, every piece -->
    {#each keystoneGuides as g, gi (gi)}
      <line x1={g.from.x} y1={g.from.y} x2={g.to.x} y2={g.to.y} class="keystone {g.invalid ? 'invalid' : ''}" />
      <circle cx={g.to.x} cy={g.to.y} r="0.35" class="keystone-dot {g.invalid ? 'invalid' : ''}" />
    {/each}

    <!-- solver indicators: each line/hover draws on its own piece (the
         selection unless the attachment solver names the other piece) -->
    {#if hoverView}
      {#if hoverView.ref.kind === "vertex"}
        {@const v = hoverView.o.verticesBoard[hoverView.ref.index]}
        {#if v}<circle cx={v.x} cy={v.y} r="0.7" class="ind hover" />{/if}
      {:else if hoverView.ref.kind === "edge"}
        {@const seg = edgeSeg(hoverView.o, hoverView.ref.index)}
        {#if seg}<line x1={seg[0].x} y1={seg[0].y} x2={seg[1].x} y2={seg[1].y} class="ind-edge hover" />{/if}
      {:else}
        {@const seg = faceSeg(hoverView.o, hoverView.ref.side)}
        <line x1={seg[0].x} y1={seg[0].y} x2={seg[1].x} y2={seg[1].y} class="ind-edge hover" />
      {/if}
    {/if}
    <!-- keyed by index: triangulation lines can share a board edge -->
    {#each solverGuides as { line, o }, li (li)}
      <!-- always mark the selected feature so it's clear which corner/face the
           dimension draws to, even before a distance is typed -->
      {#if line.ref.kind === "vertex"}
        {@const v = o.verticesBoard[line.ref.index]}
        {#if v}<circle cx={v.x} cy={v.y} r="0.5" class="ind active" />{/if}
      {:else}
        {@const seg = faceSeg(o, line.ref.side)}
        <line x1={seg[0].x} y1={seg[0].y} x2={seg[1].x} y2={seg[1].y} class="ind-edge active" />
      {/if}
      {#if line.distance}
        {@const g = guide(o, line)}
        <line x1={g.from.x} y1={g.from.y} x2={g.to.x} y2={g.to.y} class="measure" />
      {/if}
    {/each}

    {#if selOriented}
      <circle cx={selOriented.centroid.x} cy={selOriented.centroid.y} r="0.3" class="anchor" />
    {/if}

    {#if selectedPiece && !clockPiece}
      <Handles piece={selectedPiece} {layout} {toBoard} {pxPerInch} onorient={(patch) => onorient(selectedPiece.id, patch)} />
    {/if}

    <!-- Last child of the rotated group: SVG paint/hit order puts the picker's
         shield above every polygon AND every handle grip. -->
    {#if clockPiece}
      <ClockPicker
        layer="board"
        piece={clockPiece}
        {layout}
        {toBoard}
        {toDisplay}
        {pxPerInch}
        candidate={clockCandidate}
        step={snap.step}
        onhover={(i, at) => onclockhover?.(i, at)}
        oncommit={(i) => onclockcommit?.(i)}
        oncancel={() => onclockcancel?.()}
      />
    {/if}
    </g>
  </g>

  <!-- upright label layer (not rotated) -->
  <g class="labels" opacity={terrainOpacity}>
    {#each edgeLabels as l (l.text)}
      <text x={l.at.x} y={l.at.y} class="edge-label">{l.text}</text>
    {/each}
    {#if divider}
      {#each divider.badges as b, i (i)}
        {@const d = toDisplay(b.at)}
        <circle cx={d.x} cy={d.y} r="1.4" class="terr-badge" style:fill={b.color} />
        <text x={d.x} y={d.y} class="terr-badge-text">{b.player}</text>
      {/each}
    {/if}
    {#each markers as m, i (i)}
      {#if m.role}
        {@const d = toDisplay(m.at)}
        <text x={d.x} y={d.y - 2.1} class="objective-label">{m.role}</text>
      {/if}
    {/each}
    {#each solverGuides as { line, o }, li (li)}
      {#if line.distance}
        {@const g = guide(o, line)}
        {@const d = toDisplay(g.labelAt)}
        <text x={d.x} y={d.y} class="measure-label">{g.text}</text>
      {/if}
    {/each}
    {#each keystoneGuides as g, gi (gi)}
      {@const d = toDisplay(g.labelAt)}
      <text x={d.x} y={d.y} transform="rotate({g.angle}, {d.x}, {d.y})" class="keystone-label {g.invalid ? 'invalid' : ''}">{g.text}</text>
    {/each}
    {#if clockPiece}
      <ClockPicker
        layer="labels"
        piece={clockPiece}
        {layout}
        {toBoard}
        {toDisplay}
        {pxPerInch}
        candidate={clockCandidate}
        step={snap.step}
        onhover={() => {}}
        oncommit={() => {}}
        oncancel={() => {}}
      />
    {/if}
  </g>
</svg>

<style>
  .board {
    width: 100%;
    height: 100%;
    background: var(--bg);
    border: 1px solid var(--rim);
    border-radius: 6px;
    touch-action: none;
    display: block;
  }
  /* A light tabletop surface so terrain, zones and grid read against the dark chrome. */
  .board-bg {
    fill: oklch(0.74 0.008 220);
  }
  .grid.minor {
    stroke: oklch(0.62 0.01 220);
    stroke-width: 0.035;
  }
  .grid.major {
    stroke: oklch(0.42 0.02 235);
    stroke-width: 0.09;
  }
  .zone {
    fill-opacity: 0.18;
    stroke-opacity: 0.7;
    stroke-width: 0.25;
    pointer-events: none;
  }
  .centre {
    stroke: oklch(0.34 0.03 25);
    stroke-width: 0.12;
    opacity: 0.8;
  }
  .divider {
    stroke: oklch(0.28 0.02 255);
    stroke-width: 0.18;
    stroke-dasharray: 0.9 0.7;
    opacity: 0.85;
    pointer-events: none;
  }
  .objective-ring {
    fill: oklch(0.75 0.14 85 / 0.12);
    stroke: oklch(0.55 0.13 85);
    stroke-width: 0.18;
    pointer-events: none;
  }
  .objective-dot {
    fill: oklch(0.45 0.13 85);
    pointer-events: none;
  }
  .objective-label {
    fill: oklch(0.42 0.12 85);
    font-size: 1.3px;
    font-weight: 600;
    text-anchor: middle;
    font-family: "JetBrains Mono", monospace;
    paint-order: stroke;
    stroke: oklch(0.85 0.008 220);
    stroke-width: 0.4px;
    pointer-events: none;
  }
  .terr-badge {
    stroke: oklch(0.97 0.01 220);
    stroke-width: 0.18;
    pointer-events: none;
  }
  .terr-badge-text {
    fill: oklch(0.98 0.01 220);
    font-size: 1.6px;
    font-weight: 700;
    text-anchor: middle;
    dominant-baseline: central;
    font-family: "Barlow Condensed", sans-serif;
    pointer-events: none;
  }
  .piece {
    stroke-width: 0.18;
    cursor: grab;
  }
  .piece:focus {
    outline: none;
  }
  .piece:focus-visible {
    outline: none;
    stroke: var(--accent-strong);
    stroke-width: 0.32;
  }
  /* Piece colours are tuned for the light tabletop surface (distinct from the
     dark-card thumbnails, which keep the token palette). */
  .piece.area {
    fill: oklch(0.55 0.15 258 / 0.42);
    stroke: oklch(0.42 0.16 262);
  }
  .piece.feature {
    fill: oklch(0.68 0.15 62 / 0.55);
    stroke: oklch(0.5 0.16 58);
  }
  .piece.feature.dense {
    fill: oklch(0.62 0.15 145 / 0.45);
    stroke: oklch(0.45 0.16 145);
  }
  .piece.feature.light {
    fill: oklch(0.68 0.15 62 / 0.55);
    stroke: oklch(0.5 0.16 58);
  }
  /* Empty area (terrain: false) — a 10th-ed objective marker on open ground:
     a dashed ring in the objective colour, no terrain fill. Equal specificity
     to .piece.area, placed after it so it wins. */
  .piece.empty {
    fill: none;
    stroke: oklch(0.55 0.13 85);
    stroke-width: 0.16;
    stroke-dasharray: 0.45 0.3;
  }
  .piece.blocked {
    stroke-dasharray: 0.5 0.4;
  }
  .piece.twin {
    stroke: oklch(0.52 0.13 195);
    stroke-width: 0.2;
    stroke-dasharray: 0.6 0.4;
  }
  .piece.selected {
    stroke: oklch(0.48 0.15 195);
    stroke-width: 0.36;
  }
  /* "Needs review" pieces (overlap / off-grid keystone): red dashed outline,
     placed after .selected/.twin so it wins when a flagged piece is also
     selected. */
  .piece.needs-review {
    stroke: oklch(0.58 0.21 25);
    stroke-width: 0.22;
    stroke-dasharray: 0.4 0.3;
  }
  .wall {
    fill: none;
    stroke: oklch(0.3 0.04 30);
    stroke-linecap: round;
    stroke-linejoin: round;
    pointer-events: none;
  }
  .wall.dense {
    stroke: oklch(0.28 0.06 150);
  }
  .wall.light {
    stroke: oklch(0.35 0.05 60);
    stroke-dasharray: 0.4 0.25;
  }
  .upper {
    fill: none;
    stroke: oklch(0.4 0.02 255);
    stroke-width: 0.1;
    stroke-dasharray: 0.5 0.35;
    pointer-events: none;
  }
  .anchor {
    fill: oklch(0.25 0.02 220);
    stroke: oklch(0.96 0.01 220);
    stroke-width: 0.08;
    pointer-events: none;
  }
  .ind {
    pointer-events: none;
  }
  /* Pinning-panel edge/vertex highlight: magenta (hue 330), deliberately clear of
     the teal (195) used by selected/twin outlines and measure guides — teal on
     teal made the pinned feature nearly impossible to pick out. */
  .ind.hover {
    fill: oklch(0.64 0.26 330);
    opacity: 0.95;
  }
  .ind.active {
    fill: oklch(0.55 0.27 330);
  }
  .ind-edge {
    pointer-events: none;
    fill: none;
  }
  .ind-edge.hover {
    stroke: oklch(0.64 0.26 330);
    stroke-width: 0.55;
    opacity: 0.95;
  }
  .ind-edge.active {
    stroke: oklch(0.55 0.27 330);
    stroke-width: 0.55;
  }
  .measure {
    stroke: oklch(0.4 0.15 195);
    stroke-width: 0.14;
    stroke-dasharray: 0.4 0.3;
    pointer-events: none;
  }
  /* Persisted keystones — solid amber, distinct from the dashed teal solver
     guides. `.invalid` marks a keystone whose ref no longer measures. */
  .keystone {
    stroke: oklch(0.55 0.13 70);
    stroke-width: 0.16;
    pointer-events: none;
  }
  .keystone-dot {
    fill: oklch(0.55 0.13 70);
    pointer-events: none;
  }
  .keystone.invalid,
  .keystone-dot.invalid {
    stroke: oklch(0.55 0.18 25);
    fill: oklch(0.55 0.18 25);
  }
  .keystone-label {
    fill: oklch(0.45 0.13 70);
    font-size: 1.5px;
    font-weight: 600;
    text-anchor: middle;
    /* Centre the glyph box on the anchor so facing rotation pivots cleanly. */
    dominant-baseline: central;
    font-family: "JetBrains Mono", monospace;
    paint-order: stroke;
    stroke: oklch(0.82 0.008 220);
    stroke-width: 0.3px;
    pointer-events: none;
  }
  .keystone-label.invalid {
    fill: oklch(0.5 0.18 25);
  }
  .edge-label {
    fill: oklch(0.32 0.02 235);
    font-size: 1.1px;
    text-anchor: middle;
    font-family: "JetBrains Mono", monospace;
    paint-order: stroke;
    stroke: oklch(0.82 0.008 220);
    stroke-width: 0.35px;
    pointer-events: none;
  }
  .measure-label {
    fill: oklch(0.34 0.15 195);
    font-size: 1.7px;
    font-weight: 600;
    text-anchor: middle;
    font-family: "JetBrains Mono", monospace;
    paint-order: stroke;
    stroke: oklch(0.85 0.008 220);
    stroke-width: 0.55px;
    pointer-events: none;
  }
</style>
