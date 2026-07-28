<script lang="ts">
  import {
    cornerCandidates,
    nearestEdgesFor,
    measureLine,
    cardEdgeName,
    orientedFootprint,
    boardOf,
    KEYSTONE_INCREMENT,
    type EditLayout,
    type EditPiece,
    type Vec2,
  } from "./model.js";

  /**
   * The corner ("clock") picker: swivel the pointer to a clock position around a
   * piece and click to pin its keystone anchor there.
   *
   * Two responsibilities, split by `layer` because the board draws its content in
   * a group rotated 90° while labels live in an un-rotated group:
   *   - `layer="board"` also renders the **modal shield**, a full-board rect that
   *     owns pointer events while the pick is live. That is load-bearing: without
   *     it the committing click would reach the piece polygon (starting a drag),
   *     or the svg background (whose pointerdown deselects — throwing away the
   *     piece that was just dropped), or a rotate/flip grip. The shield means no
   *     existing handler needs a mode check and no pointer capture changes.
   *   - `layer="labels"` draws the provisional distances upright.
   *
   * All direction maths is in board space: the pointer and the corners both come
   * through the same CTM, so the direction the user sees is the direction computed
   * and the 90° display rotation needs no special handling.
   */
  interface Props {
    layer: "board" | "labels";
    piece: EditPiece;
    layout: EditLayout;
    /** Client → board inches (the board owns the CTM). */
    toBoard: (e: PointerEvent) => Vec2;
    /** Board → display coords, for the un-rotated label layer. */
    toDisplay: (b: Vec2) => Vec2;
    pxPerInch: () => number;
    /** The vertex index currently under the pointer, owned by the host. */
    candidate: number | null;
    step?: number;
    onhover: (index: number | null, pointer: Vec2) => void;
    oncommit: (index: number) => void;
    oncancel: () => void;
  }
  let {
    layer,
    piece,
    layout,
    toBoard,
    toDisplay,
    pxPerInch,
    candidate,
    step = KEYSTONE_INCREMENT,
    onhover,
    oncommit,
    oncancel,
  }: Props = $props();

  const board = $derived(boardOf(layout));
  const candidates = $derived(cornerCandidates(piece, layout));
  const centroid = $derived(orientedFootprint(piece, layout)?.centroid ?? piece.position);
  const picked = $derived(candidates.find((c) => c.index === candidate) ?? null);
  let pointer = $state<Vec2 | null>(null);

  /** The two provisional dimension lines for the picked corner. */
  const lines = $derived.by(() => {
    if (!picked) return [];
    const edges = nearestEdgesFor(picked.at, board);
    return ([edges.x, edges.y] as const).map((edge) => {
      const raw = measureLine(piece, board, centroid, { edge, ref: { kind: "vertex", index: picked.index } });
      const snapped = raw === null ? null : Math.round(raw / step) * step;
      const from: Vec2 =
        edge === "left"
          ? { x: 0, y: picked.at.y }
          : edge === "right"
            ? { x: board.width, y: picked.at.y }
            : edge === "top"
              ? { x: picked.at.x, y: 0 }
              : { x: picked.at.x, y: board.height };
      return {
        edge,
        from,
        to: picked.at,
        text:
          snapped === null
            ? "?"
            : `card ${cardEdgeName(edge)} ${Math.round(snapped * 100) / 100}″`,
      };
    });
  });

  function move(e: PointerEvent): void {
    const b = toBoard(e);
    pointer = b;
    onhover(candidate, b);
  }
  function down(e: PointerEvent): void {
    e.stopPropagation();
    e.preventDefault();
    if (e.button === 2) {
      oncancel();
      return;
    }
    if (candidate !== null) oncommit(candidate);
  }

  const r = $derived(3.5 / pxPerInch());
</script>

{#if layer === "board"}
  <!-- Modal shield: swallows the commit click so no existing handler sees it. -->
  <rect
    class="shield"
    x="0"
    y="0"
    width={board.width}
    height={board.height}
    onpointermove={move}
    onpointerdown={down}
    oncontextmenu={(e) => e.preventDefault()}
    role="presentation"
  />

  {#each lines as l, i (i)}
    <line class="provisional" x1={l.from.x} y1={l.from.y} x2={l.to.x} y2={l.to.y} />
  {/each}

  {#if pointer}
    <line class="rubber" x1={centroid.x} y1={centroid.y} x2={pointer.x} y2={pointer.y} />
  {/if}

  {#each candidates as c (c.index)}
    <circle
      class="corner"
      class:picked={c.index === candidate}
      cx={c.at.x}
      cy={c.at.y}
      r={c.index === candidate ? r * 1.9 : r}
    />
  {/each}
{:else}
  {#each lines as l, i (i)}
    {@const d = toDisplay({
      x: (l.from.x + l.to.x) / 2,
      y: (l.from.y + l.to.y) / 2,
    })}
    <text class="provisional-label" x={d.x} y={d.y}>{l.text}</text>
  {/each}
{/if}

<style>
  .shield {
    fill: rgba(0, 0, 0, 0.28);
    cursor: crosshair;
  }
  .corner {
    fill: var(--rim, #8b93a7);
    stroke: none;
    pointer-events: none;
  }
  .corner.picked {
    fill: var(--pin, #e879f9);
  }
  .provisional {
    stroke: var(--pin, #e879f9);
    stroke-width: 1.5;
    stroke-dasharray: 3 2;
    vector-effect: non-scaling-stroke;
    pointer-events: none;
  }
  .rubber {
    stroke: var(--pin, #e879f9);
    stroke-width: 1;
    opacity: 0.5;
    vector-effect: non-scaling-stroke;
    pointer-events: none;
  }
  .provisional-label {
    fill: var(--pin, #e879f9);
    font-size: 1.6px;
    font-weight: 600;
    text-anchor: middle;
    paint-order: stroke;
    stroke: var(--bg, #14171f);
    stroke-width: 0.5px;
    pointer-events: none;
  }
</style>
