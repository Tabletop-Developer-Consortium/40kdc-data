<script lang="ts">
  import {
    type BoardDims,
    footprintOf,
    footprintVertices,
    cardinalCornerIndices,
    orientedOffsets,
    solveCentroid,
    solveCentroidTriangulated,
    solveCentroidAttached,
    solveCentroidAgainstFixed,
    templateById,
    type EditPiece,
    type EditKeystone,
    type KeystoneDisplay,
    type Mirror,
    type SolverRef,
    type SolverHover,
    type SolverLine,
    type SolverSeed,
    type ObjectiveRole,
  } from "./model.js";
  import { formatKeystoneDistance } from "../../../_shared/layout-geometry.js";

  interface Props {
    piece: EditPiece | null;
    /** The selected piece's board-space centroid (so the fields read board inches even when parented). */
    boardPos: { x: number; y: number };
    /** Active board extents (the keystone solver measures against these edges). */
    board: BoardDims;
    /** Area pieces the selected feature may be anchored to. */
    areaOptions: { id: string; name: string }[];
    /** Other top-level areas the attachment solver can attach the selection to. */
    attachTargets: EditPiece[];
    /** The selected piece's keystones with live derived distances. */
    keystones: KeystoneDisplay[];
    ondelete: (id: string) => void;
    onmove: (id: string, position: { x: number; y: number }) => void;
    onorient: (id: string, patch: { rotation_degrees?: number; mirror?: Mirror }) => void;
    onlinkgroup: (id: string, group: string | undefined) => void;
    onparent: (id: string, parentId: string | undefined) => void;
    onobjectiverole: (id: string, role: ObjectiveRole | undefined) => void;
    onsnapcenter: (id: string) => void;
    onsnapcorner: (id: string) => void;
    onseatcorner: (id: string) => void;
    onsolverhover: (hover: SolverHover | null) => void;
    onsolverlines: (lines: SolverLine[]) => void;
    onaddkeystone: (id: string, k: EditKeystone) => void;
    onremovekeystone: (id: string, index: number) => void;
    /** Replace the keystone at `index` in place (edge flip / corner↔face swap). */
    onreplacekeystone: (id: string, index: number, k: EditKeystone) => void;
    /** Bumped by the host (Escape out of a corner pick) to reveal + seed the solver. */
    solverFocus?: number;
    /** Seed for the solver form, derived from the piece's current rough pose. */
    solverSeed?: SolverSeed | null;
  }
  let {
    piece,
    boardPos,
    board,
    areaOptions,
    attachTargets,
    keystones,
    ondelete,
    onmove,
    onorient,
    onlinkgroup,
    onparent,
    onobjectiverole,
    onsnapcenter,
    onsnapcorner,
    onseatcorner,
    onsolverhover,
    onsolverlines,
    onaddkeystone,
    onremovekeystone,
    onreplacekeystone,
    solverFocus = 0,
    solverSeed = null,
  }: Props = $props();

  // The card is shown portrait (board rotated 90° CW), so the card's own
  // left/right run along the board Y axis and its top/bottom along board X — the
  // same orientation the edge labels now use. The solver below speaks in CARD
  // directions and maps them to the board edges `solveCentroid` expects:
  //   card left  → board y=44 (solver "bottom")   card right → board y=0  (solver "top")
  //   card top   → board x=0  (solver "left")      card bottom→ board x=60 (solver "right")
  type CardEdge = "left" | "right" | "top" | "bottom";
  const toBoardEdge = (e: CardEdge): SolverLine["edge"] =>
    e === "left" ? "bottom" : e === "right" ? "top" : e === "top" ? "left" : "right";
  const fromBoardEdge = (e: SolverLine["edge"]): CardEdge =>
    e === "bottom" ? "left" : e === "top" ? "right" : e === "left" ? "top" : "bottom";
  const refLabel = (r: SolverRef): string =>
    r.kind === "vertex" ? `v${r.index}` : r.side;

  // A keystone can measure from the NEAR or the FAR board edge on its axis. The
  // default is the nearest edge (which matches 1070 of the 1150 authored vertex
  // keystones in the committed corpus), but ~5% of pieces straddle the centre and
  // genuinely measure from the far one, so the flip has to be reachable.
  const oppositeEdge = (e: SolverLine["edge"]): SolverLine["edge"] =>
    e === "left" ? "right" : e === "right" ? "left" : e === "top" ? "bottom" : "top";
  /**
   * The face ref equivalent to a vertex ref on this keystone's axis, and back.
   * These are NOT interchangeable: on a nubbed footprint a cardinal corner sits up
   * to 0.6″ inside the bbox, so swapping changes the printed number. 228 of the
   * corpus's 1378 keystones are faces, and the clock picker only offers corners.
   */
  function swappedRef(k: EditKeystone): SolverRef | null {
    if (!piece) return null;
    const fp = footprintOf(piece);
    if (!fp) return null;
    const onX = k.edge === "left" || k.edge === "right";
    if (k.ref.kind === "face") {
      // Face → the cardinal corner nearest that face, on the measured axis.
      const o = orientedOffsets(fp as never, piece.rotation_degrees, piece.mirror) as { x: number; y: number }[];
      const wantMax = k.ref.side === "max-x" || k.ref.side === "max-y";
      const idx = cardinalCornerIndices(fp);
      let best = idx[0];
      for (const i of idx) {
        const a = onX ? o[i].x : o[i].y;
        const b = onX ? o[best].x : o[best].y;
        if (wantMax ? a > b : a < b) best = i;
      }
      return { kind: "vertex", index: best };
    }
    // Vertex → the face on the same side of the measured axis as this edge.
    const near = k.edge === "left" || k.edge === "top";
    return { kind: "face", side: onX ? (near ? "min-x" : "max-x") : near ? "min-y" : "max-y" };
  }

  // The keystone vertex pickers default to the 4 cardinal corners — the only
  // vertices anyone measures against — hiding the ~20 detail "nub" vertices a
  // high-accuracy area footprint carries. Toggle to reveal every vertex.
  let showAllVerts = $state(false);

  type FeatureChoice = { label: string; ref: SolverRef };
  // `line: "h"` is a horizontal card dimension (from a left/right edge, pins
  // board Y); `line: "v"` is vertical (top/bottom edge, pins board X). Faces are
  // named for the card and map to the matching board face.
  function featureChoices(line: "h" | "v"): FeatureChoice[] {
    if (!piece) return [];
    const fp = footprintOf(piece);
    if (!fp) return [];
    const n = footprintVertices(fp as never).length;
    const faces: FeatureChoice[] =
      line === "h"
        ? [
            { label: "left face", ref: { kind: "face", side: "max-y" } },
            { label: "right face", ref: { kind: "face", side: "min-y" } },
          ]
        : [
            { label: "top face", ref: { kind: "face", side: "min-x" } },
            { label: "bottom face", ref: { kind: "face", side: "max-x" } },
          ];
    const corners = new Set(cardinalCornerIndices(fp));
    const idx = showAllVerts ? Array.from({ length: n }, (_, i) => i) : [...corners];
    const verts: FeatureChoice[] = idx.map((i) => ({
      label: showAllVerts && corners.has(i) ? `v${i} · corner` : `v${i}`,
      ref: { kind: "vertex", index: i },
    }));
    return [...faces, ...verts];
  }
  const hFeatures = $derived(featureChoices("h"));
  const vFeatures = $derived(featureChoices("v"));

  // Solver form state, in card directions.
  let solverMode = $state<"two" | "three" | "attach">("two");
  let hEdge = $state<"left" | "right">("left");
  let hDist = $state<number>(0);
  let hRef = $state<SolverRef>({ kind: "face", side: "max-y" });
  let vEdge = $state<"top" | "bottom">("top");
  let vDist = $state<number>(0);
  let vRef = $state<SolverRef>({ kind: "face", side: "min-x" });
  let solveError = $state<string | null>(null);

  // Triangulation (3-corner) state — each row measures from a card edge to a
  // specific vertex; together they solve position AND angle for a rotated piece.
  let tri = $state<{ edge: CardEdge; dist: number; vertex: number }[]>([
    { edge: "left", dist: 0, vertex: 0 },
    { edge: "left", dist: 0, vertex: 1 },
    { edge: "top", dist: 0, vertex: 0 },
  ]);
  const vertexCount = $derived.by(() => {
    if (!piece) return 0;
    const fp = footprintOf(piece);
    return fp ? footprintVertices(fp as never).length : 0;
  });
  // Vertex indices the corner-picker button grids offer: the 4 cardinal corners
  // by default, or every vertex when `showAllVerts` is on. Keeps the triangulate
  // / attach pickers in step with the two-line dropdowns above.
  const vertIndices = $derived.by(() => {
    if (!piece) return [];
    const fp = footprintOf(piece);
    if (!fp) return [];
    return showAllVerts ? Array.from({ length: vertexCount }, (_, i) => i) : cardinalCornerIndices(fp);
  });

  // Attachment (lock + attach) state — the cluster-card pattern: each piece's
  // card pins ONE corner with two dimension lines; the attachment to the
  // neighbouring area supplies both rotations. The solve re-poses BOTH pieces.
  // "both" re-solves both pieces from cards (solveCentroidAttached); "fixed"
  // treats the attached-to area as already placed and solves only this piece
  // (solveCentroidAgainstFixed) — the contact removes 2 DOF, so a single lock
  // line pins the rest.
  let anchorMode = $state<"both" | "fixed">("both");
  let aLockVertex = $state(0);
  let aLockH = $state<{ edge: "left" | "right"; dist: number }>({ edge: "left", dist: 0 });
  let aLockV = $state<{ edge: "top" | "bottom"; dist: number }>({ edge: "top", dist: 0 });
  // The single lock line used in "fixed" anchor mode (any of the four edges).
  let aFixedLine = $state<{ edge: CardEdge; dist: number; vertex: number }>({ edge: "left", dist: 0, vertex: 0 });
  let attachKind = $state<"vertex" | "edge">("vertex");
  let aAttach = $state(0);
  let attachTargetId = $state("");
  let bAttach = $state(0);
  let bLockVertex = $state(0);
  let bLockH = $state<{ edge: "left" | "right"; dist: number }>({ edge: "left", dist: 0 });
  let bLockV = $state<{ edge: "top" | "bottom"; dist: number }>({ edge: "top", dist: 0 });

  const targetPiece = $derived(attachTargets.find((p) => p.id === attachTargetId) ?? null);

  // The host bumps `solverFocus` when the author escapes out of a corner pick —
  // "go to the keystone method". Open the form that can actually place this piece
  // (an off-axis area needs the 3-line triangulation, which solves angle as well
  // as position) and prefill it from the current rough pose, so the author edits
  // digits instead of typing from scratch.
  let solverEl = $state<HTMLFieldSetElement | null>(null);
  let seededAt = 0;
  $effect(() => {
    if (solverFocus === seededAt || !solverSeed || !piece) return;
    seededAt = solverFocus;
    if (solverSeed.axisAligned) {
      solverMode = "two";
      const [h, v] = solverSeed.two;
      hEdge = fromBoardEdge(h.edge) as "left" | "right";
      hRef = h.ref;
      hDist = h.distance;
      vEdge = fromBoardEdge(v.edge) as "top" | "bottom";
      vRef = v.ref;
      vDist = v.distance;
    } else {
      solverMode = "three";
      tri = solverSeed.three.map((t) => ({
        edge: fromBoardEdge(t.edge),
        dist: t.distance,
        vertex: t.vertex,
      }));
    }
    solveError = null;
    solverEl?.scrollIntoView({ block: "nearest" });
    solverEl?.querySelector<HTMLInputElement>("input[type=number]")?.focus();
  });
  const targetVertexCount = $derived.by(() => {
    if (!targetPiece) return 0;
    const fp = footprintOf(targetPiece);
    return fp ? footprintVertices(fp as never).length : 0;
  });
  const targetVertIndices = $derived.by(() => {
    if (!targetPiece) return [];
    const fp = footprintOf(targetPiece);
    if (!fp) return [];
    return showAllVerts ? Array.from({ length: targetVertexCount }, (_, i) => i) : cardinalCornerIndices(fp);
  });
  /** The attach picker's ref for slot i — a corner, or the edge v[i]→v[i+1]. */
  const attachRef = (i: number): SolverHover["ref"] =>
    attachKind === "vertex" ? { kind: "vertex", index: i } : { kind: "edge", index: i };

  const sameRef = (a: SolverRef, b: SolverRef): boolean =>
    a.kind === "vertex" && b.kind === "vertex"
      ? a.index === b.index
      : a.kind === "face" && b.kind === "face"
        ? a.side === b.side
        : false;

  // Push the current dimension lines (in board-edge terms) to the board so the
  // guides track live — two lines in known-angle mode, three in triangulation,
  // two per piece in attachment mode (the target's carry its pieceId).
  $effect(() => {
    if (solverMode === "three") {
      onsolverlines(
        tri.map((t) => ({
          edge: toBoardEdge(t.edge),
          distance: t.dist,
          ref: { kind: "vertex", index: t.vertex },
        })),
      );
    } else if (solverMode === "attach") {
      if (anchorMode === "fixed") {
        // One lock line for this piece; the anchor is fixed (no card lines).
        onsolverlines([
          { edge: toBoardEdge(aFixedLine.edge), distance: aFixedLine.dist, ref: { kind: "vertex", index: aFixedLine.vertex } },
        ]);
      } else {
        const lines: SolverLine[] = [
          { edge: toBoardEdge(aLockH.edge), distance: aLockH.dist, ref: { kind: "vertex", index: aLockVertex } },
          { edge: toBoardEdge(aLockV.edge), distance: aLockV.dist, ref: { kind: "vertex", index: aLockVertex } },
        ];
        if (targetPiece) {
          lines.push(
            { edge: toBoardEdge(bLockH.edge), distance: bLockH.dist, ref: { kind: "vertex", index: bLockVertex }, pieceId: targetPiece.id },
            { edge: toBoardEdge(bLockV.edge), distance: bLockV.dist, ref: { kind: "vertex", index: bLockVertex }, pieceId: targetPiece.id },
          );
        }
        onsolverlines(lines);
      }
    } else {
      onsolverlines([
        { edge: toBoardEdge(hEdge), distance: hDist, ref: hRef },
        { edge: toBoardEdge(vEdge), distance: vDist, ref: vRef },
      ]);
    }
  });

  function solve(): void {
    solveError = null;
    if (!piece) return;
    const fp = footprintOf(piece);
    if (!fp) {
      solveError = "piece has no footprint to solve against";
      return;
    }
    try {
      const pos = solveCentroid({
        footprint: fp as never,
        rotation: piece.rotation_degrees,
        mirror: piece.mirror,
        board,
        lines: [
          { edge: toBoardEdge(hEdge), distance: hDist, feature: hRef },
          { edge: toBoardEdge(vEdge), distance: vDist, feature: vRef },
        ],
      });
      onmove(piece.id, { x: Math.round(pos.x * 1e4) / 1e4, y: Math.round(pos.y * 1e4) / 1e4 });
    } catch (e) {
      solveError = (e as Error).message;
    }
  }

  // Triangulate position + angle from three corner measurements. The solved
  // rotation is the piece's board orientation — intended for top-level (area)
  // pieces; the current rotation seeds which of the two angle roots is taken.
  function solveTriangulatedPlace(): void {
    solveError = null;
    if (!piece) return;
    const fp = footprintOf(piece);
    if (!fp) {
      solveError = "piece has no footprint to solve against";
      return;
    }
    try {
      const res = solveCentroidTriangulated({
        footprint: fp as never,
        mirror: piece.mirror,
        board,
        lines: tri.map((t) => ({
          edge: toBoardEdge(t.edge),
          distance: t.dist,
          vertex: t.vertex,
        })) as never,
        rotationHint: piece.rotation_degrees,
      });
      onorient(piece.id, { rotation_degrees: Math.round(res.rotation * 100) / 100 });
      onmove(piece.id, { x: Math.round(res.x * 1e4) / 1e4, y: Math.round(res.y * 1e4) / 1e4 });
    } catch (e) {
      solveError = (e as Error).message;
    }
  }

  // Solve BOTH pieces of an attached pair from the cluster-card pattern: each
  // card pins one corner with two lines, and the attachment (corners coincide /
  // edges flush) supplies the rotations. Intended for top-level (area) pieces;
  // the current rotations of both pieces seed the root choice.
  function solveAttachedPlace(): void {
    solveError = null;
    if (!piece) return;
    const target = targetPiece;
    if (!target) {
      solveError = "pick the area this piece attaches to";
      return;
    }
    const fpA = footprintOf(piece);
    const fpB = footprintOf(target);
    if (!fpA || !fpB) {
      solveError = "both pieces need a footprint to solve against";
      return;
    }
    try {
      const res = solveCentroidAttached({
        board,
        a: {
          footprint: fpA as never,
          mirror: piece.mirror,
          lockVertex: aLockVertex,
          lines: [
            { edge: toBoardEdge(aLockH.edge), distance: aLockH.dist },
            { edge: toBoardEdge(aLockV.edge), distance: aLockV.dist },
          ],
          attach: { kind: attachKind, index: aAttach },
          rotationHint: piece.rotation_degrees,
        },
        b: {
          footprint: fpB as never,
          mirror: target.mirror,
          lockVertex: bLockVertex,
          lines: [
            { edge: toBoardEdge(bLockH.edge), distance: bLockH.dist },
            { edge: toBoardEdge(bLockV.edge), distance: bLockV.dist },
          ],
          attach: { kind: attachKind, index: bAttach },
          rotationHint: target.rotation_degrees,
        },
      });
      for (const [id, pose] of [
        [piece.id, res.a],
        [target.id, res.b],
      ] as const) {
        onorient(id, { rotation_degrees: Math.round(pose.rotation * 100) / 100 });
        onmove(id, { x: Math.round(pose.x * 1e4) / 1e4, y: Math.round(pose.y * 1e4) / 1e4 });
      }
    } catch (e) {
      solveError = (e as Error).message;
    }
  }

  // Solve THIS piece alone against an already-placed anchor area. The anchor's
  // resolved board vertices come from its current placement (a top-level area's
  // `position` is its board centroid). The contact (corner coincides / edge
  // flush) removes two DOF; the single lock line pins what remains. Only this
  // piece moves — the anchor is left exactly where it is.
  function solveAgainstFixedPlace(): void {
    solveError = null;
    if (!piece) return;
    const target = targetPiece;
    if (!target) {
      solveError = "pick the area this piece attaches to";
      return;
    }
    const fpA = footprintOf(piece);
    const fpB = footprintOf(target);
    if (!fpA || !fpB) {
      solveError = "both pieces need a footprint to solve against";
      return;
    }
    const anchorVerts = orientedOffsets(fpB as never, target.rotation_degrees, target.mirror).map((o) => ({
      x: o.x + target.position.x,
      y: o.y + target.position.y,
    }));
    try {
      const res = solveCentroidAgainstFixed({
        board,
        moving: {
          footprint: fpA as never,
          mirror: piece.mirror,
          attach: { kind: attachKind, index: aAttach },
          line: { edge: toBoardEdge(aFixedLine.edge), distance: aFixedLine.dist, vertex: aFixedLine.vertex },
          rotationHint: piece.rotation_degrees,
        },
        fixed: { vertices: anchorVerts, attach: { kind: attachKind, index: bAttach } },
      });
      onorient(piece.id, { rotation_degrees: Math.round(res.rotation * 100) / 100 });
      onmove(piece.id, { x: Math.round(res.x * 1e4) / 1e4, y: Math.round(res.y * 1e4) / 1e4 });
    } catch (e) {
      solveError = (e as Error).message;
    }
  }

  /** Persist this piece's single lock line as a printed card measurement. */
  function pinFixedKeystone(): void {
    if (!piece) return;
    onaddkeystone(piece.id, { edge: toBoardEdge(aFixedLine.edge), ref: { kind: "vertex", index: aFixedLine.vertex } });
  }

  /** Persist all four lock lines as printed card measurements, two per piece. */
  function pinAttachKeystones(): void {
    if (!piece) return;
    onaddkeystone(piece.id, { edge: toBoardEdge(aLockH.edge), ref: { kind: "vertex", index: aLockVertex } });
    onaddkeystone(piece.id, { edge: toBoardEdge(aLockV.edge), ref: { kind: "vertex", index: aLockVertex } });
    if (targetPiece) {
      onaddkeystone(targetPiece.id, { edge: toBoardEdge(bLockH.edge), ref: { kind: "vertex", index: bLockVertex } });
      onaddkeystone(targetPiece.id, { edge: toBoardEdge(bLockV.edge), ref: { kind: "vertex", index: bLockVertex } });
    }
  }

  const templateName = $derived(
    piece?.template ? templateById(piece.template)?.name ?? piece.template : "(inline footprint)",
  );
  const num = (e: Event): number => Number((e.currentTarget as HTMLInputElement).value);
</script>

{#if !piece}
  <p class="empty">Select a piece on the board, or add one from the palette.</p>
{:else}
  <div class="inspector">
    <header>
      <h3>{piece.name ?? piece.id}</h3>
      <button class="danger" onclick={() => ondelete(piece.id)}>Delete pair</button>
    </header>
    <dl class="meta">
      <dt>id</dt>
      <dd>{piece.id}</dd>
      <dt>type</dt>
      <dd>{piece.piece_type}</dd>
      <dt>template</dt>
      <dd>{templateName}</dd>
      <dt>twin</dt>
      <dd>{piece.twin_id ?? "— (independent)"}</dd>
      {#if piece.piece_type === "feature"}
        <dt>parent</dt>
        <dd>{piece.parent_area_id ?? "— (board)"}</dd>
      {/if}
      {#if piece.piece_type === "area"}
        <dt>objective</dt>
        <dd>{piece.objective_role ?? (piece.is_objective ? "yes" : "—")}</dd>
      {/if}
    </dl>

    <fieldset>
      <legend>Placement</legend>
      <label
        >centroid x
        <input type="number" step="0.05" value={boardPos.x} oninput={(e) => onmove(piece.id, { x: num(e), y: boardPos.y })} /></label
      >
      <label
        >centroid y
        <input type="number" step="0.05" value={boardPos.y} oninput={(e) => onmove(piece.id, { x: boardPos.x, y: num(e) })} /></label
      >
      <label
        >rotation°
        <input type="number" step="1" min="0" max="359" value={piece.rotation_degrees} oninput={(e) => onorient(piece.id, { rotation_degrees: num(e) })} /></label
      >
      <div class="snaps">
        {#each [0, 90, 180, 270] as deg (deg)}
          <button
            class="feat {piece.rotation_degrees === deg ? 'on' : ''}"
            onclick={() => onorient(piece.id, { rotation_degrees: deg })}>{deg}°</button
          >
        {/each}
      </div>
      <label
        >mirror
        <select value={piece.mirror} onchange={(e) => onorient(piece.id, { mirror: (e.currentTarget as HTMLSelectElement).value as Mirror })}>
          <option value="none">none</option>
          <option value="horizontal">horizontal</option>
          <option value="vertical">vertical</option>
        </select>
      </label>
      {#if piece.piece_type === "feature"}
        <label
          >parent area
          <select
            value={piece.parent_area_id ?? ""}
            onchange={(e) => onparent(piece.id, (e.currentTarget as HTMLSelectElement).value || undefined)}
          >
            <option value="">(none — board space)</option>
            {#each areaOptions as a (a.id)}
              <option value={a.id}>{a.name}</option>
            {/each}
          </select>
        </label>
        {#if piece.parent_area_id}
          <div class="snaps">
            <button class="feat" onclick={() => onsnapcenter(piece.id)} title="Centre in the area's artwork rectangle">⊙ center</button>
            <button class="feat" onclick={() => onseatcorner(piece.id)} title="Seat into the nearest plate corner at Battlemaster's 0.5″ inset">◻ seat</button>
            <button class="feat" onclick={() => onsnapcorner(piece.id)} title="Align the nearest vertex to the nearest area vertex (no inset)">◻ vertex</button>
          </div>
        {/if}
      {/if}
      <label
        >link group
        <input type="text" placeholder="(none)" value={piece.link_group ?? ""} oninput={(e) => onlinkgroup(piece.id, (e.currentTarget as HTMLInputElement).value)} /></label
      >
      {#if piece.piece_type === "area"}
        <label
          >objective role
          <select
            value={piece.objective_role ?? ""}
            onchange={(e) =>
              onobjectiverole(piece.id, ((e.currentTarget as HTMLSelectElement).value || undefined) as
                | ObjectiveRole
                | undefined)}
          >
            <option value="">(none)</option>
            <option value="home">home</option>
            <option value="expansion">expansion</option>
            <option value="center">center</option>
          </select>
        </label>
      {/if}
      <p class="hint">
        The centroid is rotation/mirror-invariant. Edits carry the 180° twin along.
        {#if piece.piece_type === "feature"}
          Anchor a feature to an area so moving or rotating the area carries it; its
          centroid is then in the area's local frame.
        {:else}
          An objective role marks this area — and its whole link group, which is one
          area slotted like puzzle pieces — as a single objective.
        {/if}
      </p>
    </fieldset>

    <fieldset class="solver">
      <legend>Solve centroid from a reference card</legend>
      <div class="mode">
        <button
          class="feat vtoggle {showAllVerts ? 'on' : ''}"
          title="The corner pickers list only the 4 cardinal corners by default; toggle to show every footprint vertex (nubs included)"
          onclick={() => (showAllVerts = !showAllVerts)}
          >{showAllVerts ? "vertices: all" : "vertices: corners"}</button
        >
      </div>
      <div class="mode">
        <button class="feat {solverMode === 'two' ? 'on' : ''}" onclick={() => (solverMode = "two")}
          >2 lines · known angle</button
        >
        <button class="feat {solverMode === 'three' ? 'on' : ''}" onclick={() => (solverMode = "three")}
          >3 corners · solve angle</button
        >
        <button class="feat {solverMode === 'attach' ? 'on' : ''}" onclick={() => (solverMode = "attach")}
          >lock corner · attach</button
        >
      </div>

      {#if solverMode === "two"}
        <p class="hint">
          Set rotation &amp; mirror to match the card, then enter the two dimension lines.
          Hover a face/corner to see it on the board; the guide shows which edge it measures from.
        </p>

        <div class="line">
          <select value={hEdge} onchange={(e) => (hEdge = (e.currentTarget as HTMLSelectElement).value as "left" | "right")}>
            <option value="left">from left edge</option>
            <option value="right">from right edge</option>
          </select>
          <input type="number" step="0.05" value={hDist} oninput={(e) => (hDist = num(e))} aria-label="distance from left/right edge" />″ to
        </div>
        <div class="features">
          {#each hFeatures as f (f.label)}
            <button
              class="feat {sameRef(hRef, f.ref) ? 'on' : ''}"
              onpointerenter={() => onsolverhover({ ref: f.ref })}
              onpointerleave={() => onsolverhover(null)}
              onclick={() => {
                hRef = f.ref;
                // A face names its card edge — pre-populate the dropdown to match.
                if (f.ref.kind === "face") hEdge = f.ref.side === "max-y" ? "left" : "right";
              }}>{f.label}</button
            >
          {/each}
        </div>

        <div class="line">
          <select value={vEdge} onchange={(e) => (vEdge = (e.currentTarget as HTMLSelectElement).value as "top" | "bottom")}>
            <option value="top">from top edge</option>
            <option value="bottom">from bottom edge</option>
          </select>
          <input type="number" step="0.05" value={vDist} oninput={(e) => (vDist = num(e))} aria-label="distance from top/bottom edge" />″ to
        </div>
        <div class="features">
          {#each vFeatures as f (f.label)}
            <button
              class="feat {sameRef(vRef, f.ref) ? 'on' : ''}"
              onpointerenter={() => onsolverhover({ ref: f.ref })}
              onpointerleave={() => onsolverhover(null)}
              onclick={() => {
                vRef = f.ref;
                // A face names its card edge — pre-populate the dropdown to match.
                if (f.ref.kind === "face") vEdge = f.ref.side === "min-x" ? "top" : "bottom";
              }}>{f.label}</button
            >
          {/each}
        </div>

        <div class="snaps">
          <button class="primary" onclick={solve}>Solve &amp; place</button>
          <button
            class="feat"
            title="Persist the H line's edge + feature on this piece as a printed card measurement (distance always derived from geometry)"
            onclick={() => onaddkeystone(piece.id, { edge: toBoardEdge(hEdge), ref: hRef })}
            >Pin H keystone</button
          >
          <button
            class="feat"
            title="Persist the V line's edge + feature on this piece as a printed card measurement (distance always derived from geometry)"
            onclick={() => onaddkeystone(piece.id, { edge: toBoardEdge(vEdge), ref: vRef })}
            >Pin V keystone</button
          >
        </div>
      {:else if solverMode === "three"}
        <p class="hint">
          For pieces at non-90° angles: set mirror to match the card, then enter the
          card's three corner measurements — two from the same pair of edges
          (left/right or top/bottom), one from the other. Solves position <em>and</em>
          rotation; the current rotation picks between the two mirror-image fits, so
          rough it in first.
        </p>

        {#each tri as t, i (i)}
          <div class="line">
            <select
              value={t.edge}
              onchange={(e) => (tri[i].edge = (e.currentTarget as HTMLSelectElement).value as CardEdge)}
            >
              <option value="left">from left edge</option>
              <option value="right">from right edge</option>
              <option value="top">from top edge</option>
              <option value="bottom">from bottom edge</option>
            </select>
            <input
              type="number"
              step="0.05"
              value={t.dist}
              oninput={(e) => (tri[i].dist = num(e))}
              aria-label={`triangulation distance ${i + 1}`}
            />″ to
            <span class="features inline">
              {#each vertIndices as vi (vi)}
                <button
                  class="feat {t.vertex === vi ? 'on' : ''}"
                  onpointerenter={() => onsolverhover({ ref: { kind: "vertex", index: vi } })}
                  onpointerleave={() => onsolverhover(null)}
                  onclick={() => (tri[i].vertex = vi)}>v{vi}</button
                >
              {/each}
            </span>
            <button
              class="feat"
              title="Persist this row's edge + corner on the piece as a printed card measurement"
              onclick={() => onaddkeystone(piece.id, { edge: toBoardEdge(t.edge), ref: { kind: "vertex", index: t.vertex } })}
              >Pin</button
            >
          </div>
        {/each}

        <button class="primary" onclick={solveTriangulatedPlace}>Triangulate &amp; place</button>
      {:else}
        <p class="hint">
          {#if anchorMode === "fixed"}
            The area is already placed: lock it, attach a corner or edge of this
            piece to it, and pin just <em>one</em> dimension line — the contact
            removes the rest. Only this piece moves. Rough its rotation in first;
            it picks the fit.
          {:else}
            For a cluster the card pins by single corners: lock one corner of this
            piece with its two card lines, attach a corner or edge to the
            neighbouring area, then lock that area's keystone corner the same way.
            Solves position <em>and</em> rotation of <em>both</em> pieces — corners
            pivot, edges slide. Rough both rotations in first; they pick the fit.
          {/if}
        </p>

        <span class="sub">Attachment anchor</span>
        <div class="mode">
          <button class="feat {anchorMode === 'both' ? 'on' : ''}" onclick={() => (anchorMode = "both")}
            >solve both from cards</button
          >
          <button class="feat {anchorMode === 'fixed' ? 'on' : ''}" onclick={() => (anchorMode = "fixed")}
            >area already placed (lock it)</button
          >
        </div>

        <span class="sub">Attachment kind</span>
        <div class="mode">
          <button class="feat {attachKind === 'vertex' ? 'on' : ''}" onclick={() => (attachKind = "vertex")}
            >corner ↔ corner</button
          >
          <button class="feat {attachKind === 'edge' ? 'on' : ''}" onclick={() => (attachKind = "edge")}
            >edge ↔ edge</button
          >
        </div>
        <div class="line">
          this piece's {attachKind === "vertex" ? "corner" : "edge"}:
          <span class="features inline">
            {#each Array.from({ length: vertexCount }, (_, i) => i) as i (i)}
              <button
                class="feat {aAttach === i ? 'on' : ''}"
                onpointerenter={() => onsolverhover({ ref: attachRef(i) })}
                onpointerleave={() => onsolverhover(null)}
                onclick={() => (aAttach = i)}>{attachKind === "vertex" ? "v" : "e"}{i}</button
              >
            {/each}
          </span>
        </div>

        {#if anchorMode === "fixed"}
          <span class="sub">This piece — lock line</span>
          <div class="line">
            <select value={aFixedLine.edge} onchange={(e) => (aFixedLine.edge = (e.currentTarget as HTMLSelectElement).value as CardEdge)}>
              <option value="left">from left edge</option>
              <option value="right">from right edge</option>
              <option value="top">from top edge</option>
              <option value="bottom">from bottom edge</option>
            </select>
            <input type="number" step="0.05" value={aFixedLine.dist} oninput={(e) => (aFixedLine.dist = num(e))} aria-label="this piece's lock line distance" />″ to
            <span class="features inline">
              {#each vertIndices as vi (vi)}
                <button
                  class="feat {aFixedLine.vertex === vi ? 'on' : ''}"
                  onpointerenter={() => onsolverhover({ ref: { kind: "vertex", index: vi } })}
                  onpointerleave={() => onsolverhover(null)}
                  onclick={() => (aFixedLine.vertex = vi)}>v{vi}</button
                >
              {/each}
            </span>
          </div>
        {:else}
          <span class="sub">This piece — locked corner</span>
          <div class="features">
            {#each vertIndices as vi (vi)}
              <button
                class="feat {aLockVertex === vi ? 'on' : ''}"
                onpointerenter={() => onsolverhover({ ref: { kind: "vertex", index: vi } })}
                onpointerleave={() => onsolverhover(null)}
                onclick={() => (aLockVertex = vi)}>v{vi}</button
              >
            {/each}
          </div>
          <div class="line">
            <select value={aLockH.edge} onchange={(e) => (aLockH.edge = (e.currentTarget as HTMLSelectElement).value as "left" | "right")}>
              <option value="left">from left edge</option>
              <option value="right">from right edge</option>
            </select>
            <input type="number" step="0.05" value={aLockH.dist} oninput={(e) => (aLockH.dist = num(e))} aria-label="this piece's lock distance from left/right edge" />″
          </div>
          <div class="line">
            <select value={aLockV.edge} onchange={(e) => (aLockV.edge = (e.currentTarget as HTMLSelectElement).value as "top" | "bottom")}>
              <option value="top">from top edge</option>
              <option value="bottom">from bottom edge</option>
            </select>
            <input type="number" step="0.05" value={aLockV.dist} oninput={(e) => (aLockV.dist = num(e))} aria-label="this piece's lock distance from top/bottom edge" />″
          </div>
        {/if}

        <span class="sub">Attached-to area</span>
        <label
          >area
          <select value={attachTargetId} onchange={(e) => (attachTargetId = (e.currentTarget as HTMLSelectElement).value)}>
            <option value="">(pick an area)</option>
            {#each attachTargets as t (t.id)}
              <option value={t.id}>{t.name ?? t.id}</option>
            {/each}
          </select>
        </label>
        {#if targetPiece}
          <div class="line">
            its {attachKind === "vertex" ? "corner" : "edge"}:
            <span class="features inline">
              {#each Array.from({ length: targetVertexCount }, (_, i) => i) as i (i)}
                <button
                  class="feat {bAttach === i ? 'on' : ''}"
                  onpointerenter={() => onsolverhover({ pieceId: targetPiece.id, ref: attachRef(i) })}
                  onpointerleave={() => onsolverhover(null)}
                  onclick={() => (bAttach = i)}>{attachKind === "vertex" ? "v" : "e"}{i}</button
                >
              {/each}
            </span>
          </div>
          {#if anchorMode === "both"}
            <span class="sub">Its keystone anchor corner</span>
            <div class="features">
              {#each targetVertIndices as vi (vi)}
                <button
                  class="feat {bLockVertex === vi ? 'on' : ''}"
                  onpointerenter={() => onsolverhover({ pieceId: targetPiece.id, ref: { kind: "vertex", index: vi } })}
                  onpointerleave={() => onsolverhover(null)}
                  onclick={() => (bLockVertex = vi)}>v{vi}</button
                >
              {/each}
            </div>
            <div class="line">
              <select value={bLockH.edge} onchange={(e) => (bLockH.edge = (e.currentTarget as HTMLSelectElement).value as "left" | "right")}>
                <option value="left">from left edge</option>
                <option value="right">from right edge</option>
              </select>
              <input type="number" step="0.05" value={bLockH.dist} oninput={(e) => (bLockH.dist = num(e))} aria-label="target area's lock distance from left/right edge" />″
            </div>
            <div class="line">
              <select value={bLockV.edge} onchange={(e) => (bLockV.edge = (e.currentTarget as HTMLSelectElement).value as "top" | "bottom")}>
                <option value="top">from top edge</option>
                <option value="bottom">from bottom edge</option>
              </select>
              <input type="number" step="0.05" value={bLockV.dist} oninput={(e) => (bLockV.dist = num(e))} aria-label="target area's lock distance from top/bottom edge" />″
            </div>
          {/if}
        {/if}

        <div class="snaps">
          {#if anchorMode === "fixed"}
            <button class="primary" onclick={solveAgainstFixedPlace}>Attach &amp; place this piece</button>
            <button
              class="feat"
              title="Persist this piece's single lock line as a printed card measurement. The contact (flush/touch) is a physical placement instruction, not a keystone."
              onclick={pinFixedKeystone}>Pin keystone</button
            >
          {:else}
            <button class="primary" onclick={solveAttachedPlace}>Attach &amp; place both</button>
            <button
              class="feat"
              title="Persist all four lock lines as printed card measurements, two on each piece (distances always derived from geometry)"
              onclick={pinAttachKeystones}>Pin keystones</button
            >
          {/if}
        </div>
      {/if}
      {#if solveError}<p class="error">{solveError}</p>{/if}
    </fieldset>

    <fieldset>
      <legend>Keystones</legend>
      {#if keystones.length === 0}
        <p class="hint">
          None pinned. Keystones are the dimension lines the printed card keeps —
          pin the solver's current edge + feature above. Distances are always
          derived from the geometry, so they follow the piece as it moves.
        </p>
      {:else}
        <ul class="keystones">
          {#each keystones as k (k.index)}
            <li>
              <span
                class="ks-label"
                role="img"
                aria-label="keystone from card {fromBoardEdge(k.keystone.edge)} edge to {refLabel(k.keystone.ref)}"
                onpointerenter={() => onsolverhover({ ref: k.keystone.ref })}
                onpointerleave={() => onsolverhover(null)}
              >
                {fromBoardEdge(k.keystone.edge)} → {refLabel(k.keystone.ref)}
              </span>
              {#if k.distance != null}
                <span class="ks-dist">{formatKeystoneDistance(k.distance, piece.rotation_degrees)}</span>
              {:else}
                <span class="ks-dist invalid" title="The referenced feature no longer exists on this footprint (re-authored template?). Remove and re-pin.">unmeasurable</span>
              {/if}
              <button
                class="small"
                title="Measure from the opposite board edge on this axis"
                aria-label="flip keystone {k.index + 1} to the opposite edge"
                onclick={() =>
                  onreplacekeystone(piece.id, k.index, {
                    edge: oppositeEdge(k.keystone.edge),
                    ref: k.keystone.ref,
                  })}>⇄</button
              >
              {#if swappedRef(k.keystone)}
                <button
                  class="small"
                  title={k.keystone.ref.kind === "vertex"
                    ? "Measure to the whole face instead of this corner"
                    : "Measure to a corner instead of the whole face"}
                  aria-label="swap keystone {k.index + 1} between corner and face"
                  onclick={() => {
                    const ref = swappedRef(k.keystone);
                    if (ref) onreplacekeystone(piece.id, k.index, { edge: k.keystone.edge, ref });
                  }}>{k.keystone.ref.kind === "vertex" ? "▭" : "◻"}</button
                >
              {/if}
              <button
                class="danger small"
                aria-label="remove keystone {k.index + 1}"
                onclick={() => onremovekeystone(piece.id, k.index)}>×</button
              >
            </li>
          {/each}
        </ul>
        <p class="hint">Edges named in card directions; distances derive live from geometry.</p>
      {/if}
    </fieldset>
  </div>
{/if}

<style>
  .empty {
    color: var(--text-mute);
    font-size: 0.9rem;
  }
  .inspector header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  h3 {
    margin: 0;
    font-family: "Barlow Condensed", sans-serif;
    font-size: 1.3rem;
  }
  .meta {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.1rem 0.75rem;
    font-size: 0.82rem;
    color: var(--text-dim);
    margin: 0.4rem 0 0.8rem;
  }
  .meta dt {
    color: var(--text-mute);
    font-family: "JetBrains Mono", monospace;
  }
  .meta dd {
    margin: 0;
  }
  fieldset {
    border: 1px solid var(--rim);
    border-radius: 6px;
    margin: 0 0 0.8rem;
    padding: 0.6rem 0.75rem 0.75rem;
  }
  legend {
    font-family: "Barlow Condensed", sans-serif;
    font-size: 0.95rem;
    color: var(--text);
    padding: 0 0.4rem;
  }
  label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    margin-bottom: 0.35rem;
  }
  input,
  select {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--rim-strong);
    border-radius: 4px;
    padding: 0.2rem 0.35rem;
    font: inherit;
    font-size: 0.82rem;
  }
  input[type="number"] {
    width: 5rem;
  }
  input[type="text"] {
    width: 8rem;
  }
  .hint {
    font-size: 0.74rem;
    color: var(--text-mute);
    margin: 0.3rem 0 0;
  }
  /* Sub-section label inside the attachment solver's longer form. */
  .sub {
    display: block;
    font-family: "Barlow Condensed", sans-serif;
    font-size: 0.82rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-dim);
    margin: 0.55rem 0 0.25rem;
  }
  .solver .line {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-bottom: 0.3rem;
    font-size: 0.8rem;
    flex-wrap: wrap;
  }
  .features {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-bottom: 0.5rem;
  }
  .features.inline {
    display: inline-flex;
    margin-bottom: 0;
  }
  .snaps {
    display: flex;
    gap: 0.25rem;
    justify-content: flex-end;
    margin: -0.15rem 0 0.35rem;
  }
  .mode {
    display: flex;
    gap: 0.25rem;
    margin-bottom: 0.4rem;
  }
  .feat {
    font: inherit;
    font-size: 0.72rem;
    background: var(--surface-2);
    color: var(--text-dim);
    border: 1px solid var(--rim-strong);
    border-radius: 4px;
    padding: 0.12rem 0.4rem;
    cursor: pointer;
  }
  .feat.on {
    border-color: var(--accent);
    background: var(--accent-fill);
    color: var(--accent-strong);
  }
  button {
    font: inherit;
    border-radius: 4px;
    border: 1px solid var(--rim-strong);
    padding: 0.3rem 0.7rem;
    cursor: pointer;
    background: var(--surface-2);
    color: var(--text);
  }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg);
    font-weight: 600;
  }
  button.danger {
    background: transparent;
    border-color: var(--danger-rim);
    color: var(--danger);
    font-size: 0.78rem;
    padding: 0.15rem 0.5rem;
  }
  .error {
    color: var(--danger);
    font-size: 0.78rem;
    margin: 0.4rem 0 0;
  }
  .keystones {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .keystones li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.82rem;
  }
  .ks-label {
    flex: 1 1 auto;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.78rem;
    color: var(--text-dim);
    cursor: help;
  }
  .ks-dist {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.82rem;
    color: var(--text);
  }
  .ks-dist.invalid {
    color: var(--danger);
    cursor: help;
  }
  button.small {
    line-height: 1;
    padding: 0.1rem 0.4rem;
  }
</style>
