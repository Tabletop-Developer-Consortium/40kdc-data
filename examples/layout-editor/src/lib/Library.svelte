<script lang="ts">
  import { SvelteMap } from "svelte/reactivity";
  import {
    DISPOSITIONS,
    dispositionLabel,
    pairKey,
    canonicalMatchupId,
    libraryIndex,
    layoutWarningsFor,
    type LayoutWarning,
    type LibraryEntry,
  } from "./model.js";
  import LayoutThumb from "./LayoutThumb.svelte";

  /**
   * The layout library: a coverage grid over the 15 unordered disposition
   * pairings × 3 variant slots (45 layouts when complete), plus an Unassigned
   * shelf for layouts that predate matchup tagging. Built on a native <dialog>
   * for free Escape/backdrop/focus handling, sized near-fullscreen.
   */
  interface Props {
    open?: boolean;
    /** Id of the layout currently in the editor, highlighted in the grid. */
    currentId?: string | null;
    onpick: (layoutId: string) => void;
    onnew: (matchupId: string, variant: number) => void;
    onblank: () => void;
  }
  let { open = $bindable(false), currentId = null, onpick, onnew, onblank }: Props = $props();

  let dialogEl = $state<HTMLDialogElement | null>(null);
  $effect(() => {
    const el = dialogEl;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  });
  function onBackdropClick(e: MouseEvent): void {
    if (e.target === dialogEl) open = false;
  }

  const VARIANTS = [1, 2, 3];
  // The index is rebuilt each time the overlay opens; cheap (thumb resolution is
  // memoized in the model) and keeps the grid honest if the dataset ever reloads.
  const index = $derived(open ? libraryIndex() : null);

  const warningResults = new SvelteMap<string, LayoutWarning[]>();
  let warningScanDone = $state(0);
  let warningScanTotal = $state(0);

  // Collision checks over detailed Battlemaster outlines are exact but costly.
  // Let the dialog paint first, then scan one layout per idle callback so opening
  // the library never becomes one multi-second main-thread task.
  $effect(() => {
    const current = index;
    if (!open || !current) return;

    const ids = new Set<string>();
    for (const cell of current.cells.values()) {
      for (const claimants of cell.byVariant.values()) {
        for (const entry of claimants) ids.add(entry.id);
      }
      for (const entry of cell.unnumbered) ids.add(entry.id);
    }
    for (const entry of current.unassigned) ids.add(entry.id);
    const remaining = [...ids].filter((id) => !warningResults.has(id));
    warningScanTotal = ids.size;
    warningScanDone = ids.size - remaining.length;
    let cancelled = false;
    let idleId: number | undefined;
    let timeoutId: number | undefined;
    let frameId: number | undefined;

    function schedule(): void {
      if (typeof window.requestIdleCallback === "function") {
        idleId = window.requestIdleCallback(scan, { timeout: 250 });
      } else {
        // Safari has no requestIdleCallback. Cross a frame boundary before
        // queuing each scan so the dialog and later progress updates paint.
        frameId = window.requestAnimationFrame(() => {
          frameId = undefined;
          timeoutId = window.setTimeout(scan, 0);
        });
      }
    }
    function scan(): void {
      if (cancelled) return;
      const id = remaining.shift();
      if (!id) return;
      warningResults.set(id, layoutWarningsFor(id));
      warningScanDone += 1;
      if (remaining.length > 0) schedule();
    }
    schedule();

    return () => {
      cancelled = true;
      if (idleId !== undefined) window.cancelIdleCallback(idleId);
      if (frameId !== undefined) window.cancelAnimationFrame(frameId);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  });

  /** The 15 unordered pairing cells, upper-triangle order. */
  const pairs = DISPOSITIONS.flatMap((a, i) =>
    DISPOSITIONS.slice(i).map((b) => ({
      a,
      b,
      key: pairKey(a, b),
      label: a === b ? `${dispositionLabel(a)} (mirror)` : `${dispositionLabel(a)} vs ${dispositionLabel(b)}`,
    })),
  );

  function entriesAt(key: string, variant: number): LibraryEntry[] {
    return index?.cells.get(key)?.byVariant.get(variant) ?? [];
  }
  function unnumberedAt(key: string): LibraryEntry[] {
    return index?.cells.get(key)?.unnumbered ?? [];
  }
  /** Variant slots beyond 3 that are actually occupied (never hidden, just rare). */
  function extraVariants(key: string): number[] {
    const cell = index?.cells.get(key);
    if (!cell) return [];
    return [...cell.byVariant.keys()].filter((v) => v > 3).sort((x, y) => x - y);
  }

  const filled = $derived(
    index ? [...index.cells.values()].reduce((n, c) => n + c.byVariant.size, 0) : 0,
  );

  /** Whether a scanned library layout has any "needs review" warning. */
  function needsReview(id: string): boolean {
    return (warningResults.get(id)?.length ?? 0) > 0;
  }
  /** Multi-line tooltip listing a scanned layout's warnings. */
  function reviewTitle(id: string): string {
    const warnings = warningResults.get(id) ?? [];
    return warnings.length
      ? `${warnings.length} to review:\n${warnings.map((warning) => `• ${warning.message}`).join("\n")}`
      : "";
  }
  /** Count of distinct layouts in the grid that need review (for the header). */
  const flaggedCount = $derived.by(() => {
    if (!index) return 0;
    const seen = new Set<string>();
    let n = 0;
    const bump = (e: LibraryEntry): void => {
      if (seen.has(e.id)) return;
      seen.add(e.id);
      if (needsReview(e.id)) n++;
    };
    for (const cell of index.cells.values()) {
      for (const list of cell.byVariant.values()) list.forEach(bump);
      cell.unnumbered.forEach(bump);
    }
    index.unassigned.forEach(bump);
    return n;
  });

  function pick(id: string): void {
    open = false;
    onpick(id);
  }
  function fresh(a: string, b: string, variant: number): void {
    const matchupId = canonicalMatchupId(a, b);
    if (!matchupId) return;
    open = false;
    onnew(matchupId, variant);
  }
  function blank(): void {
    open = false;
    onblank();
  }
</script>

<dialog bind:this={dialogEl} onclose={() => (open = false)} onclick={onBackdropClick}>
  <div class="panel" role="document">
    <header>
      <h2>Layout Library</h2>
      <span class="coverage">{filled} / 45 slots</span>
      {#if warningScanDone < warningScanTotal}
        <span class="review-count">Checking layouts {warningScanDone}/{warningScanTotal}</span>
      {:else if flaggedCount > 0}
        <span class="review-count" title="Layouts with overlapping pieces or off-grid keystones">
          ⚠ {flaggedCount} to review
        </span>
      {/if}
      <span class="spacer"></span>
      <button type="button" class="blank" onclick={blank}>＋ Blank layout</button>
      <button type="button" class="close" aria-label="Close" onclick={() => (open = false)}>×</button>
    </header>

    <div class="body">
      <div class="matrix">
        {#each pairs as pair (pair.key)}
          <section class="cell">
            <h3>{pair.label}</h3>
            <div class="slots">
              {#each VARIANTS as v (v)}
                {@const entries = entriesAt(pair.key, v)}
                {#if entries.length === 0}
                  <button
                    type="button"
                    class="slot empty"
                    title="New layout: {pair.label} {v}"
                    onclick={() => fresh(pair.a, pair.b, v)}
                  >
                    <span class="num">{v}</span>
                    <span class="plus">＋</span>
                  </button>
                {:else}
                  {#each entries as e (e.id)}
                    <button
                      type="button"
                      class="slot filled {entries.length > 1 ? 'collision' : ''} {e.id === currentId
                        ? 'current'
                        : ''}"
                      title={entries.length > 1 ? `${e.name} — duplicate variant ${v}` : e.name}
                      onclick={() => pick(e.id)}
                    >
                      <span class="num">{v}</span>
                      {#if needsReview(e.id)}<span class="review-badge" title={reviewTitle(e.id)}>⚠</span>{/if}
                      <LayoutThumb layoutId={e.id} patternId={e.deploymentPatternId} />
                      <span class="name">{e.name}</span>
                    </button>
                  {/each}
                {/if}
              {/each}
              {#each extraVariants(pair.key) as v (v)}
                {#each entriesAt(pair.key, v) as e (e.id)}
                  <button
                    type="button"
                    class="slot filled {e.id === currentId ? 'current' : ''}"
                    title={e.name}
                    onclick={() => pick(e.id)}
                  >
                    <span class="num">{v}</span>
                    {#if needsReview(e.id)}<span class="review-badge" title={reviewTitle(e.id)}>⚠</span>{/if}
                    <LayoutThumb layoutId={e.id} patternId={e.deploymentPatternId} />
                    <span class="name">{e.name}</span>
                  </button>
                {/each}
              {/each}
            </div>
            {#if unnumberedAt(pair.key).length > 0}
              <div class="unnumbered">
                {#each unnumberedAt(pair.key) as e (e.id)}
                  <button type="button" class="chip" title="{e.name} — no variant number" onclick={() => pick(e.id)}>
                    #? {e.name}
                  </button>
                {/each}
              </div>
            {/if}
          </section>
        {/each}
      </div>

      {#if index && index.unassigned.length > 0}
        <section class="unassigned">
          <h3>Unassigned <span class="hint">no mission pairing</span></h3>
          <div class="shelf">
            {#each index.unassigned as e (e.id)}
              <button
                type="button"
                class="slot filled wide {e.id === currentId ? 'current' : ''}"
                title={e.name}
                onclick={() => pick(e.id)}
              >
                {#if needsReview(e.id)}<span class="review-badge" title={reviewTitle(e.id)}>⚠</span>{/if}
                <LayoutThumb layoutId={e.id} patternId={e.deploymentPatternId} />
                <span class="name">{e.name}</span>
              </button>
            {/each}
          </div>
        </section>
      {/if}
    </div>
  </div>
</dialog>

<style>
  dialog {
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text);
    width: min(96vw, 1500px);
    max-width: none;
    height: min(94vh, 1000px);
    max-height: none;
    margin: auto;
  }
  dialog::backdrop {
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(2px);
  }
  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--surface-1);
    border: 1px solid var(--rim);
    border-radius: 8px;
    overflow: hidden;
  }
  header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.7rem 1rem;
    border-bottom: 1px solid var(--rim);
    background: var(--bg);
  }
  h2 {
    margin: 0;
    font-family: "Barlow Condensed", sans-serif;
    font-size: 1.3rem;
    letter-spacing: 0.02em;
  }
  .coverage {
    color: var(--text-mute);
    font-size: 0.85rem;
  }
  .review-count {
    font-size: 0.85rem;
    font-weight: 600;
    color: oklch(0.72 0.16 70);
  }
  .spacer {
    flex: 1 1 auto;
  }
  .blank {
    font: inherit;
    font-size: 0.85rem;
    background: var(--surface-2);
    color: var(--text-dim);
    border: 1px solid var(--rim-strong);
    border-radius: 4px;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
  }
  .blank:hover {
    border-color: var(--accent);
    color: var(--text);
  }
  .close {
    font: inherit;
    font-size: 1.25rem;
    line-height: 1;
    width: 1.9rem;
    height: 1.9rem;
    display: grid;
    place-items: center;
    background: var(--bg);
    color: var(--text-dim);
    border: 1px solid var(--rim-strong);
    border-radius: 4px;
    cursor: pointer;
  }
  .close:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 0.9rem 1rem 1.1rem;
  }
  .matrix {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(270px, 1fr));
    gap: 0.7rem;
  }
  .cell {
    background: var(--bg);
    border: 1px solid var(--rim);
    border-radius: 6px;
    padding: 0.55rem 0.6rem 0.6rem;
  }
  .cell h3,
  .unassigned h3 {
    margin: 0 0 0.45rem;
    font-family: "Barlow Condensed", sans-serif;
    font-size: 0.95rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    color: var(--text-dim);
    text-transform: uppercase;
  }
  .slots {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.45rem;
  }
  .slot {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.4rem 0.4rem 0.35rem;
    background: var(--surface-2);
    border: 1px solid var(--rim-strong);
    border-radius: 5px;
    cursor: pointer;
    color: var(--text-dim);
    font: inherit;
    min-height: 7.2rem;
    transition:
      border-color 120ms ease-out,
      background 120ms ease-out;
  }
  .slot:hover {
    border-color: var(--accent);
    background: var(--accent-fill);
  }
  .slot.empty {
    align-items: center;
    justify-content: center;
    background: transparent;
    border-style: dashed;
    color: var(--text-mute);
  }
  .slot.empty .plus {
    font-size: 1.3rem;
  }
  .slot.collision {
    border-color: var(--danger-rim);
  }
  .slot.current {
    border-color: var(--accent-strong);
    box-shadow: 0 0 0 1px var(--accent-strong);
  }
  .slot .num {
    position: absolute;
    top: 0.25rem;
    left: 0.35rem;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.68rem;
    color: var(--text-mute);
    z-index: 1;
  }
  .slot .review-badge {
    position: absolute;
    top: 0.15rem;
    right: 0.25rem;
    z-index: 1;
    font-size: 0.8rem;
    line-height: 1;
    color: oklch(0.72 0.16 70);
    text-shadow: 0 0 2px rgba(0, 0, 0, 0.6);
    pointer-events: none;
  }
  .slot .name {
    font-size: 0.7rem;
    line-height: 1.15;
    text-align: center;
  }
  .slot.wide {
    width: 9.5rem;
  }
  .unnumbered {
    margin-top: 0.4rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .chip {
    font: inherit;
    font-size: 0.7rem;
    background: var(--surface-2);
    color: var(--text-dim);
    border: 1px solid var(--danger-rim);
    border-radius: 999px;
    padding: 0.1rem 0.5rem;
    cursor: pointer;
  }
  .unassigned {
    margin-top: 1rem;
    border-top: 1px solid var(--rim);
    padding-top: 0.7rem;
  }
  .unassigned .hint {
    text-transform: none;
    color: var(--text-mute);
    font-weight: 400;
    margin-left: 0.4rem;
  }
  .shelf {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
