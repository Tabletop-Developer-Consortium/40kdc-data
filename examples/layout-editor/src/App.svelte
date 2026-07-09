<script lang="ts">
  import {
    CATALOG,
    addTemplate,
    addSet,
    addCenterRuin,
    blankLayout,
    blankLayoutFor,
    footprintOf,
    loadEmbedded,
    resolve,
    toCanonicalJson,
    movePiece,
    orientPiece,
    setLinkGroup,
    addKeystone,
    removeKeystone,
    keystoneDisplays,
    layoutWarnings,
    setParentArea,
    snapToAreaCenter,
    snapFeatureToAreaCorner,
    setObjectiveRole,
    boardCentroid,
    boardOf,
    objectiveMarkers,
    deletePiece,
    repairTwins,
    unpairTwins,
    renameLayout,
    deploymentZones,
    territoryDivider,
    defaultDeploymentFor,
    DEPLOYMENT_PATTERNS,
    MISSION_MATCHUPS,
    type EditLayout,
    type EditPiece,
    type Mirror,
    type SolverHover,
    type SolverLine,
    type SolverViz,
    type DeployZone,
    type TerritoryDivider,
    type ObjectiveRole,
  } from "./lib/model.js";
  import type { TerrainTemplate } from "@alpaca-software/40kdc-data";
  import type { TerrainSetDef } from "./lib/sets.js";
  import Board from "./lib/Board.svelte";
  import Inspector from "./lib/Inspector.svelte";
  import Library from "./lib/Library.svelte";
  import Palette from "./lib/Palette.svelte";
  import Thumbnail from "./lib/Thumbnail.svelte";
  import SetThumbnail from "./lib/SetThumbnail.svelte";
  import SupportModal from "../../_shared/SupportModal.svelte";
  import AppHeader from "../../_shared/AppHeader.svelte";
  import AppFooter from "../../_shared/AppFooter.svelte";
  import { MISSION_MATRIX_URL, PATREON_URL, SALVO_URL } from "../../_shared/links.js";

  const initialLayout = loadEmbedded("take-and-hold-mirror-1", true) ?? blankLayout();
  let symmetric = $state(true);
  // Board-only visibility of the pinned keystone dimension lines; the pins
  // themselves stay on the pieces.
  let showKeystones = $state(true);
  // Rotate keystone labels to face each player (off: upright authoring view).
  let keystoneFacing = $state(false);
  let layout = $state<EditLayout>(initialLayout);
  let libraryOpen = $state(false);
  let selectedId = $state<string | null>(null);
  let deployment = $state<string | null>(
    initialLayout.deployment_pattern_id ?? defaultDeploymentFor(initialLayout.id),
  );
  const board = $derived(boardOf(layout));
  const zones = $derived<DeployZone[]>(deploymentZones(deployment));
  const divider = $derived<TerritoryDivider | null>(territoryDivider(deployment, board));

  let solverHover = $state<SolverHover | null>(null);
  let solverLines = $state<SolverLine[]>([]);
  const solverViz = $derived<SolverViz>({ hover: solverHover, lines: solverLines });

  const resolved = $derived(resolve(layout));
  const selectedPiece = $derived<EditPiece | null>(
    selectedId ? layout.pieces.find((p) => p.id === selectedId) ?? null : null,
  );
  /** Board-space centroid of the selection — the inspector fields always speak board inches. */
  const selectedBoardPos = $derived(
    selectedPiece ? boardCentroid(layout, selectedPiece) : { x: 0, y: 0 },
  );
  const markers = $derived(objectiveMarkers(layout));
  // "Needs review" warnings for the working layout: overlapping pieces + off-grid
  // keystones. The banner lists them; the board dims every piece one names.
  const warnings = $derived(layoutWarnings(layout));
  const warnPieceIds = $derived(
    new Set(warnings.flatMap((w) => w.pieceIds).filter((id): id is string => !!id)),
  );
  // The selected piece's keystones with live derived distances (inspector list).
  const selectedKeystones = $derived(
    selectedPiece ? keystoneDisplays(layout).filter((d) => d.pieceId === selectedPiece.id) : [],
  );
  const exportText = $derived(JSON.stringify(toCanonicalJson(layout), null, 2));

  const areas = CATALOG.filter((t) => t.kind === "area");
  const features = CATALOG.filter((t) => t.kind === "feature");

  // Area pieces the selected feature can be anchored to. In symmetric mode each
  // area has a twin; we list only one of each pair, since parenting to it carries
  // the feature's twin onto the area's twin automatically — the mirrored copy
  // isn't a separate choice. The selected feature's current parent is always kept
  // visible (even if it is the dropped twin) so the select never blanks out.
  const areaOptions = $derived.by(() => {
    const seenTwin = new Set<string>();
    const out: { id: string; name: string }[] = [];
    for (const p of layout.pieces) {
      if (p.piece_type !== "area" || p.id === selectedId) continue;
      if (seenTwin.has(p.id)) continue; // already represented by its twin
      out.push({ id: p.id, name: p.name ?? p.id });
      if (p.twin_id) seenTwin.add(p.twin_id);
    }
    const cur = selectedPiece?.parent_area_id;
    if (cur && !out.some((o) => o.id === cur)) {
      const a = layout.pieces.find((p) => p.id === cur);
      if (a) out.push({ id: a.id, name: a.name ?? a.id });
    }
    return out;
  });

  // Areas the attachment solver can attach the selection to. Unlike
  // `areaOptions`, twins are NOT collapsed — the author attaches to one
  // specific physical neighbour. The selection and its own twin are excluded.
  const attachTargets = $derived(
    layout.pieces.filter(
      (p) =>
        p.piece_type === "area" &&
        p.id !== selectedId &&
        p.id !== selectedPiece?.twin_id &&
        !!footprintOf(p),
    ),
  );

  function loadLayout(id: string): void {
    layout = loadEmbedded(id, symmetric) ?? blankLayout();
    selectedId = null;
    deployment = layout.deployment_pattern_id ?? defaultDeploymentFor(id);
  }
  function newLayoutFor(matchupId: string, variant: number): void {
    layout = blankLayoutFor(matchupId, variant);
    selectedId = null;
    deployment = null;
  }
  function newBlankLayout(): void {
    layout = blankLayout();
    selectedId = null;
    deployment = null;
  }
  function toggleSymmetry(): void {
    symmetric = !symmetric;
    if (symmetric) repairTwins(layout);
    else unpairTwins(layout);
  }

  // A feature added while an AREA is selected anchors to that area on arrival
  // (the usual flow: select the area, then stock it with features).
  function autoParentTarget(t: TerrainTemplate): EditPiece | null {
    return t.kind === "feature" && selectedPiece?.piece_type === "area" ? selectedPiece : null;
  }
  function add(t: TerrainTemplate): void {
    const parent = autoParentTarget(t);
    const added = addTemplate(layout, t, symmetric);
    if (parent) setParentArea(layout, added.id, parent.id);
    selectedId = added.id;
  }
  function addTerrainSet(s: TerrainSetDef): void {
    selectedId = addSet(layout, s, symmetric)?.id ?? selectedId;
  }
  function addCenter(rotated: boolean): void {
    selectedId = addCenterRuin(layout, rotated)?.id ?? selectedId;
  }
  const centerExists = $derived(layout.pieces.some((p) => p.objective_role === "center"));

  // ── palette drag-to-place ────────────────────────────────────────────────
  // The palette arms the drag (past a movement threshold); from there the app
  // tracks the pointer globally, floats a ghost thumbnail at the cursor, and
  // on release asks the board to map the point into board inches. Off-board
  // release cancels. The payload is a single template or a whole terrain set.
  type DragPayload = { kind: "template"; template: TerrainTemplate } | { kind: "set"; set: TerrainSetDef };
  let boardRef = $state<{ clientToBoard: (x: number, y: number) => { x: number; y: number } | null } | null>(null);
  let paletteDrag = $state<{ payload: DragPayload; x: number; y: number } | null>(null);

  function onPaletteDragStart(t: TerrainTemplate, e: PointerEvent): void {
    paletteDrag = { payload: { kind: "template", template: t }, x: e.clientX, y: e.clientY };
  }
  function onPaletteDragStartSet(s: TerrainSetDef, e: PointerEvent): void {
    paletteDrag = { payload: { kind: "set", set: s }, x: e.clientX, y: e.clientY };
  }
  function onDragPointerMove(e: PointerEvent): void {
    if (!paletteDrag) return;
    paletteDrag.x = e.clientX;
    paletteDrag.y = e.clientY;
  }
  function onDragPointerUp(e: PointerEvent): void {
    if (!paletteDrag) return;
    const at = boardRef?.clientToBoard(e.clientX, e.clientY) ?? null;
    if (at) {
      const p = paletteDrag.payload;
      if (p.kind === "template") {
        // Capture the auto-parent area BEFORE the selection moves to the new piece.
        const parent = autoParentTarget(p.template);
        const added = addTemplate(layout, p.template, symmetric, at);
        if (parent) setParentArea(layout, added.id, parent.id);
        selectedId = added.id;
      } else {
        selectedId = addSet(layout, p.set, symmetric, at)?.id ?? selectedId;
      }
    }
    paletteDrag = null;
  }
  function onDragCancel(): void {
    paletteDrag = null;
  }
  function onmove(id: string, position: { x: number; y: number }): void {
    movePiece(layout, id, position);
  }
  function onorient(id: string, patch: { rotation_degrees?: number; mirror?: Mirror }): void {
    orientPiece(layout, id, patch);
  }
  function onlinkgroup(id: string, group: string | undefined): void {
    setLinkGroup(layout, id, group);
  }
  function onparent(id: string, parentId: string | undefined): void {
    setParentArea(layout, id, parentId);
  }
  function onsnapcenter(id: string): void {
    snapToAreaCenter(layout, id);
  }
  function onsnapcorner(id: string): void {
    snapFeatureToAreaCorner(layout, id);
  }
  function onobjectiverole(id: string, role: ObjectiveRole | undefined): void {
    setObjectiveRole(layout, id, role);
  }
  function onDeploymentChange(value: string): void {
    deployment = value || null;
    layout.deployment_pattern_id = deployment ?? undefined;
  }
  function remove(id: string): void {
    const twin = layout.pieces.find((p) => p.id === id)?.twin_id;
    deletePiece(layout, id);
    if (selectedId === id || selectedId === twin) selectedId = null;
  }

  // Delete/Backspace removes the selected piece — but never while the caret is
  // in a text field (the title input, inspector fields), where those keys edit
  // text.
  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if (!selectedId || libraryOpen) return;
    const t = e.target as HTMLElement | null;
    if (
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT" ||
        t.isContentEditable)
    ) {
      return;
    }
    e.preventDefault();
    remove(selectedId);
  }

  let copied = $state(false);
  async function copyJson(): Promise<void> {
    await navigator.clipboard.writeText(exportText);
    copied = true;
    setTimeout(() => (copied = false), 1200);
  }
  function downloadJson(): void {
    const blob = new Blob([exportText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${layout.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
</script>

<svelte:window
  onkeydown={onKeydown}
  onpointermove={onDragPointerMove}
  onpointerup={onDragPointerUp}
  onpointercancel={onDragCancel}
/>

<div class="app">
  <AppHeader title="Layout Editor" tag="11e terrain layouts · portrait" appId="layout-editor">
    {#snippet nav()}
      <button
        class="sym {symmetric ? 'on' : ''}"
        onclick={toggleSymmetry}
        title="Mirror every piece across the board centre (180°)"
      >
        {symmetric ? "⟳ Symmetry on" : "⟳ Symmetry off"}
      </button>
      <button
        class="sym {showKeystones ? 'on' : ''}"
        aria-pressed={showKeystones}
        onclick={() => (showKeystones = !showKeystones)}
        title="Show or hide the pinned keystone dimension lines on the board"
      >
        {showKeystones ? "⌖ Keystones on" : "⌖ Keystones off"}
      </button>
      <button
        class="sym {keystoneFacing ? 'on' : ''}"
        aria-pressed={keystoneFacing}
        onclick={() => (keystoneFacing = !keystoneFacing)}
        title="Rotate keystone labels to face each player (needs a deployment overlay for the divider)"
      >
        {keystoneFacing ? "↻ Facing on" : "↻ Facing off"}
      </button>
      <button class="library-btn" onclick={() => (libraryOpen = true)} title="Browse layouts by mission pairing">
        ⊞ Library
      </button>
      <select
        class="ctrl"
        aria-label="Deployment overlay"
        value={deployment ?? ""}
        onchange={(e) => onDeploymentChange(e.currentTarget.value)}
      >
        <option value="">No deployment</option>
        {#each DEPLOYMENT_PATTERNS as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
      </select>
      <select
        class="ctrl"
        aria-label="Mission pairing"
        value={layout.mission_matchup_id ?? ""}
        onchange={(e) => (layout.mission_matchup_id = e.currentTarget.value || undefined)}
      >
        <option value="">No pairing</option>
        {#each MISSION_MATCHUPS as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
      </select>
      <input
        class="variant"
        type="number"
        min="1"
        step="1"
        placeholder="#"
        aria-label="Layout variant number"
        title="Variant number within the mission pairing"
        value={layout.variant ?? ""}
        oninput={(e) => {
          const v = Number(e.currentTarget.value);
          layout.variant = Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined;
        }}
      />
    {/snippet}
  </AppHeader>

  <main>
    <aside class="rail palette-rail">
      <Palette
        {areas}
        {features}
        {centerExists}
        onadd={add}
        onaddset={addTerrainSet}
        onaddcenter={addCenter}
        ondragstart={onPaletteDragStart}
        ondragstartset={onPaletteDragStartSet}
      />
    </aside>

    <section class="canvas">
      <input
        class="layout-title"
        value={layout.name}
        oninput={(e) => renameLayout(layout, e.currentTarget.value)}
        aria-label="Layout title"
        placeholder="Untitled layout"
      />
      <Board
        bind:this={boardRef}
        {layout}
        {resolved}
        {selectedId}
        {selectedPiece}
        solver={solverViz}
        {zones}
        {divider}
        {markers}
        {showKeystones}
        {keystoneFacing}
        {warnPieceIds}
        onselect={(id) => (selectedId = id)}
        {onmove}
        {onorient}
      />
      {#if warnings.length > 0}
        <div class="warnings" role="status">
          <span class="warn-head">⚠ {warnings.length} to review</span>
          <ul>
            {#each warnings as w, i (i)}
              <li class="warn {w.kind}">{w.message}</li>
            {/each}
          </ul>
        </div>
      {/if}
      <p class="status">
        {layout.pieces.length} pieces · drag to move · rotate/flip handles on the selected piece
        {#if symmetric}· edits mirror across the centre{/if}
      </p>
    </section>

    <aside class="rail side">
      <Inspector
        piece={selectedPiece}
        boardPos={selectedBoardPos}
        {board}
        {areaOptions}
        {attachTargets}
        ondelete={remove}
        {onmove}
        {onorient}
        {onlinkgroup}
        {onparent}
        {onsnapcenter}
        {onsnapcorner}
        {onobjectiverole}
        onsolverhover={(ref) => (solverHover = ref)}
        onsolverlines={(lines) => (solverLines = lines)}
        keystones={selectedKeystones}
        onaddkeystone={(id, k) => addKeystone(layout, id, k)}
        onremovekeystone={(id, i) => removeKeystone(layout, id, i)}
      />
      <section class="export">
        <h2>
          Canonical JSON
          <span class="actions">
            <button onclick={copyJson}>{copied ? "copied" : "copy"}</button>
            <button onclick={downloadJson}>download</button>
          </span>
        </h2>
        <textarea readonly>{exportText}</textarea>
      </section>
    </aside>
  </main>

  {#if paletteDrag}
    <div class="drag-ghost" style:left="{paletteDrag.x}px" style:top="{paletteDrag.y}px">
      {#if paletteDrag.payload.kind === "template"}
        <Thumbnail template={paletteDrag.payload.template} size={48} />
      {:else}
        <SetThumbnail set={paletteDrag.payload.set} size={48} />
      {/if}
    </div>
  {/if}

  <AppFooter
    links={[
      { label: "Salvo", href: SALVO_URL },
      { label: "Mission Matrix", href: MISSION_MATRIX_URL },
    ]}
    version={__DATA_VERSION__}
    build={__BUILD_SHA__}
  />

  <Library
    bind:open={libraryOpen}
    currentId={layout.id}
    onpick={loadLayout}
    onnew={newLayoutFor}
    onblank={newBlankLayout}
  />
  <SupportModal patreonUrl={PATREON_URL} appName="Layout Editor" />
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  main {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr) 380px;
    gap: 0.9rem;
    align-items: stretch;
    padding: 0.7rem 1rem 0.9rem;
  }
  .rail {
    overflow-y: auto;
    min-height: 0;
  }
  .canvas {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }
  .canvas :global(.board) {
    flex: 1 1 auto;
    min-height: 0;
  }
  .layout-title {
    flex: 0 0 auto;
    margin: 0 0 0.5rem;
    width: 100%;
    background: transparent;
    color: var(--text);
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 0.2rem 0.4rem;
    font-family: "Barlow Condensed", sans-serif;
    font-size: 1.35rem;
    letter-spacing: 0.01em;
  }
  .layout-title:hover {
    border-color: var(--rim-strong);
  }
  .layout-title:focus {
    outline: none;
    border-color: var(--accent);
    background: var(--bg);
  }
  .layout-title::placeholder {
    color: var(--text-mute);
  }
  h2 {
    font-family: "Barlow Condensed", sans-serif;
    font-size: 1.1rem;
    margin: 0 0 0.5rem;
  }
  .status {
    color: var(--text-mute);
    font-size: 0.78rem;
    margin: 0.4rem 0 0;
    flex: 0 0 auto;
  }
  .warnings {
    flex: 0 0 auto;
    margin: 0.5rem 0 0;
    padding: 0.5rem 0.7rem;
    border: 1px solid oklch(0.6 0.14 70);
    border-left-width: 3px;
    border-radius: 4px;
    background: oklch(0.7 0.13 70 / 0.12);
    font-size: 0.78rem;
    max-height: 8.5rem;
    overflow-y: auto;
  }
  .warn-head {
    font-weight: 600;
    color: oklch(0.7 0.14 70);
  }
  .warnings ul {
    margin: 0.35rem 0 0;
    padding-left: 1.1rem;
  }
  .warnings li {
    margin: 0.1rem 0;
    color: var(--text-dim);
  }
  .warnings li.collision::marker {
    content: "⤫ ";
  }
  .warnings li.keystone-not-round::marker {
    content: "⌖ ";
  }
  select.ctrl,
  .export textarea {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--rim-strong);
    border-radius: 4px;
    font: inherit;
  }
  select.ctrl {
    padding: 0.25rem 0.4rem;
    font-size: 0.85rem;
  }
  .variant {
    width: 3rem;
    padding: 0.25rem 0.4rem;
    font-size: 0.85rem;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--rim-strong);
    border-radius: 4px;
    font-family: inherit;
  }
  .drag-ghost {
    position: fixed;
    transform: translate(-50%, -50%);
    pointer-events: none;
    opacity: 0.85;
    z-index: 50;
    background: var(--surface-2);
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 0.25rem;
  }
  .library-btn {
    font: inherit;
    font-size: 0.85rem;
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--rim-strong);
    border-radius: 4px;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
  }
  .library-btn:hover {
    border-color: var(--accent);
    background: var(--accent-fill);
  }
  .sym {
    font: inherit;
    font-size: 0.8rem;
    background: var(--surface-2);
    color: var(--text-dim);
    border: 1px solid var(--rim-strong);
    border-radius: 4px;
    padding: 0.25rem 0.55rem;
    cursor: pointer;
  }
  .sym.on {
    border-color: var(--accent);
    background: var(--accent-fill);
    color: var(--accent-strong);
  }
  .export {
    margin-top: 1rem;
  }
  .export h2 {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .actions {
    display: flex;
    gap: 0.3rem;
  }
  .actions button {
    font: inherit;
    font-size: 0.74rem;
    background: var(--surface-2);
    color: var(--text-dim);
    border: 1px solid var(--rim-strong);
    border-radius: 4px;
    padding: 0.15rem 0.5rem;
    cursor: pointer;
  }
  .export textarea {
    width: 100%;
    height: 240px;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.72rem;
    padding: 0.5rem;
    resize: vertical;
  }
</style>
