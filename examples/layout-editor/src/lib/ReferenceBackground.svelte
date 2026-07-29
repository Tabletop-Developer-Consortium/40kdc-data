<!--
  Reference background for the board: either a page of the Event Companion PDF, or a photo
  or screenshot the user picks.

  The photo source exists for cross-checking against another renderer — a Battlemaster
  card face is exactly the 60×44 board with no margin, so dropping one in behind the
  layout makes a disagreement obvious by eye. That is also why the image is stretched to
  the board rather than letterboxed.

  Both sources feed the same single `onimage` slot, so choosing one clears the other; the
  fit controls (turn / nudge / zoom) then apply to whichever is showing. Everything here is
  session-only — no upload, no persistence.
-->
<script lang="ts">
  import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
  import workerUrl from "pdfjs-dist/build/pdf.worker.min.js?url";
  import { eventCompanionPage, type EditLayout, type ReferenceFit } from "./model.js";

  GlobalWorkerOptions.workerSrc = workerUrl;

  interface Props {
    layout: Pick<EditLayout, "mission_matchup_id" | "variant">;
    onimage: (image: string | null) => void;
    opacity?: number;
    /** Opacity of the editor's terrain/grid overlay, kept in the session only. */
    terrainOpacity?: number;
    fit?: ReferenceFit;
  }

  let {
    layout,
    onimage,
    opacity = $bindable(0.45),
    terrainOpacity = $bindable(1),
    fit = $bindable<ReferenceFit>({ quarterTurns: 0, offsetX: 0, offsetY: 0, scale: 1 }),
  }: Props = $props();

  /** Name of the chosen photo, or null when the background is the PDF (or absent). */
  let photoName = $state<string | null>(null);
  let hasImage = $state(false);

  const NUDGE_LIMIT = 40;
  const turns = $derived(((Math.round(fit.quarterTurns ?? 0) % 4) + 4) % 4);

  function turn(by: number): void {
    fit = { ...fit, quarterTurns: (((fit.quarterTurns ?? 0) + by) % 4 + 4) % 4 };
  }
  function setFit(patch: Partial<ReferenceFit>): void {
    fit = { ...fit, ...patch };
  }
  function resetFit(): void {
    fit = { quarterTurns: 0, offsetX: 0, offsetY: 0, scale: 1 };
  }
  const clampNum = (raw: string, lo: number, hi: number, fallback: number): number => {
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  let documentProxy = $state<PDFDocumentProxy | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let currentUrl: string | null = null;
  let renderTask: RenderTask | null = null;
  let renderGeneration = 0;

  const pageNumber = $derived(eventCompanionPage(layout));

  // The Companion layout cards place the 44×60 board art in this fixed A4-page
  // rectangle. Crop in page-relative coordinates so rendering still follows
  // PDF.js's chosen scale, then counter-rotate for Board's existing 90° layer.
  const BOARD_CROP = {
    x: 127.69082641601562 / 595.2760009765625,
    y: 276.6623229980469 / 841.8900146484375,
    width: (468.4483337402344 - 127.69082641601562) / 595.2760009765625,
    height: (741.4985961914062 - 276.6623229980469) / 841.8900146484375,
  } as const;

  function cropAndCounterRotate(source: HTMLCanvasElement): HTMLCanvasElement {
    const sx = Math.round(source.width * BOARD_CROP.x);
    const sy = Math.round(source.height * BOARD_CROP.y);
    const sw = Math.round(source.width * BOARD_CROP.width);
    const sh = Math.round(source.height * BOARD_CROP.height);
    if (sw <= 0 || sh <= 0 || sx < 0 || sy < 0 || sx + sw > source.width || sy + sh > source.height) {
      throw new Error("reference board crop is outside the PDF page");
    }
    const board = document.createElement("canvas");
    board.width = sh;
    board.height = sw;
    const context = board.getContext("2d");
    if (!context) throw new Error("canvas unavailable");
    context.translate(0, sw);
    context.rotate(-Math.PI / 2);
    context.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
    return board;
  }

  /** Hand a new object URL to the board, revoking whatever it replaces. */
  function publish(url: string | null): void {
    hasImage = url !== null;
    onimage(url);
    if (currentUrl && currentUrl !== url) URL.revokeObjectURL(currentUrl);
    currentUrl = url;
  }

  function clearImage(): void {
    publish(null);
  }

  async function destroyDocument(): Promise<void> {
    renderGeneration += 1;
    renderTask?.cancel();
    renderTask = null;
    const previous = documentProxy;
    documentProxy = null;
    if (previous) {
      previous.cleanup();
      await previous.destroy();
    }
  }

  async function selectFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    error = null;
    await destroyDocument();
    clearImage();
    photoName = null;
    if (!file) return;
    if (file.type !== "application/pdf") {
      error = "Choose a PDF file.";
      input.value = "";
      return;
    }

    loading = true;
    try {
      documentProxy = await getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    } catch {
      error = "This PDF could not be opened.";
      documentProxy = null;
    } finally {
      loading = false;
    }
  }

  /**
   * Take a photo or screenshot as the background.
   *
   * Unlike the PDF this is not gated on the layout having an Event Companion page — that
   * page number is derived from the matchup and means nothing for a photo, which has to
   * work on custom layouts too. Choosing one tears down any loaded PDF, since both feed
   * the same single background slot.
   */
  async function selectPhoto(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    error = null;
    await destroyDocument();
    clearImage();
    photoName = null;
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      error = "Choose an image file.";
      input.value = "";
      return;
    }
    photoName = file.name;
    publish(URL.createObjectURL(file));
  }

  $effect(() => {
    const pdf = documentProxy;
    const page = pageNumber;
    const generation = ++renderGeneration;
    renderTask?.cancel();
    renderTask = null;

    if (!pdf || page === null) {
      // Only clear when the PDF owns the background — a chosen photo must survive
      // switching to a layout that has no Companion page.
      if (!photoName) clearImage();
      return;
    }

    void (async () => {
      try {
        const pdfPage = await pdf.getPage(page);
        if (generation !== renderGeneration) return;
        const viewport = pdfPage.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("canvas unavailable");
        renderTask = pdfPage.render({ canvasContext: context, viewport });
        await renderTask.promise;
        pdfPage.cleanup();
        if (generation !== renderGeneration) return;
        const boardCanvas = cropAndCounterRotate(canvas);
        const blob = await new Promise<Blob | null>((resolve) => boardCanvas.toBlob(resolve, "image/png"));
        if (!blob || generation !== renderGeneration) return;
        publish(URL.createObjectURL(blob));
      } catch (caught) {
        if ((caught as { name?: string }).name !== "RenderingCancelledException" && generation === renderGeneration) {
          error = `Page ${page} could not be rendered.`;
          clearImage();
        }
      } finally {
        if (generation === renderGeneration) renderTask = null;
      }
    })();
  });

  $effect(() => () => {
    void destroyDocument();
    clearImage();
  });
</script>

<section class="reference-background" aria-label="Reference background">
  <label>
    Event Companion PDF
    <input type="file" accept="application/pdf" onchange={selectFile} disabled={pageNumber === null} />
  </label>
  <label>
    Photo / screenshot
    <input type="file" accept="image/*" onchange={selectPhoto} />
  </label>
  <label>
    Reference opacity
    <input type="range" min="0.10" max="0.90" step="0.05" bind:value={opacity} disabled={!hasImage} />
    <output>{Math.round(opacity * 100)}%</output>
  </label>
  <label>
    Terrain opacity
    <input
      type="range"
      min="0.10"
      max="1"
      step="0.05"
      aria-label="Terrain opacity"
      bind:value={terrainOpacity}
    />
    <output>{Math.round(terrainOpacity * 100)}%</output>
  </label>

  {#if hasImage}
    <div class="fit" role="group" aria-label="Fit the reference to the board">
      <span class="fit-label">Turn</span>
      <button type="button" onclick={() => turn(-1)} title="Turn a quarter turn anticlockwise">↶</button>
      <button type="button" onclick={() => turn(1)} title="Turn a quarter turn clockwise">↷</button>
      <output class="deg">{turns * 90}°</output>

      <label class="num">
        X
        <input
          type="number"
          step="0.25"
          min={-NUDGE_LIMIT}
          max={NUDGE_LIMIT}
          value={fit.offsetX ?? 0}
          oninput={(e) => setFit({ offsetX: clampNum(e.currentTarget.value, -NUDGE_LIMIT, NUDGE_LIMIT, 0) })}
        />
      </label>
      <label class="num">
        Y
        <input
          type="number"
          step="0.25"
          min={-NUDGE_LIMIT}
          max={NUDGE_LIMIT}
          value={fit.offsetY ?? 0}
          oninput={(e) => setFit({ offsetY: clampNum(e.currentTarget.value, -NUDGE_LIMIT, NUDGE_LIMIT, 0) })}
        />
      </label>
      <label class="num">
        Zoom
        <input
          type="number"
          step="0.01"
          min="0.1"
          max="5"
          value={fit.scale ?? 1}
          oninput={(e) => setFit({ scale: clampNum(e.currentTarget.value, 0.1, 5, 1) })}
        />
      </label>
      <button type="button" onclick={resetFit}>Reset fit</button>
    </div>
  {/if}

  {#if loading}
    <p>Loading reference PDF…</p>
  {:else if error}
    <p class="error" role="status">{error}</p>
  {:else if photoName}
    <p>{photoName} — nudge in inches, as shown. Kept in this browser session only.</p>
  {:else if pageNumber === null}
    <p>No Event Companion drawing matches this layout — a photo still works.</p>
  {:else}
    <p>Page {pageNumber}. Kept in this browser session only.</p>
  {/if}
</section>

<style>
  .reference-background {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
    margin: 0 0 0.65rem;
    color: var(--ink-muted);
    font-size: 0.78rem;
  }

  label { display: inline-flex; align-items: center; gap: 0.4rem; }
  input[type="file"] { max-width: 12rem; }
  input[type="range"] { inline-size: 6rem; }
  output { min-inline-size: 2.4rem; font-variant-numeric: tabular-nums; }
  p { margin: 0; flex-basis: 100%; }

  .fit {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.15rem 0.45rem;
    border: 1px solid var(--rule, #3a4150);
    border-radius: 0.35rem;
  }
  .fit-label { opacity: 0.8; }
  .fit button {
    min-inline-size: 1.6rem;
    padding: 0.1rem 0.35rem;
    font: inherit;
    color: inherit;
    background: transparent;
    border: 1px solid var(--rule, #3a4150);
    border-radius: 0.25rem;
    cursor: pointer;
  }
  .fit button:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
  .deg { min-inline-size: 2.6rem; text-align: right; }
  .num { gap: 0.25rem; }
  .num input { inline-size: 4.2rem; font: inherit; font-variant-numeric: tabular-nums; }
  .error { color: var(--danger, #9d3029); }
</style>
