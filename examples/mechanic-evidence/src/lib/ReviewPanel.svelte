<script lang="ts">
  import type { AuthorizedSourceExcerpt, MechanicGraphClient, ReviewItem } from "./api/types.js";
  import type { GraphStore, ReviewDraft } from "./graph-store.svelte.js";

  let {
    store,
    client,
    review,
  }: { store: GraphStore; client: MechanicGraphClient; review: ReviewItem } = $props();

  const emptyDraft: ReviewDraft = {
    optionId: "",
    rationale: "",
    error: null,
    submitting: false,
    awaitingDecisionNodeId: null,
    acceptedSequence: null,
  };
  const draft = $derived(store.reviewDrafts[review.reviewId] ?? emptyDraft);
  const preconditionsMatch = $derived(
    review.precondition.sequence === store.sequence &&
      review.precondition.projectionChecksum === store.checksum,
  );
  const canSubmit = $derived(store.canSubmitReview(review));
  const hasRequiredInput = $derived(Boolean(draft.optionId && draft.rationale.trim()));

  let source = $state<AuthorizedSourceExcerpt | null>(null);
  let sourceOpen = $state(false);
  let sourceLoading = $state(false);
  let sourceError = $state<string | null>(null);

  $effect(() => {
    review.reviewId;
    store.sourceEpoch;
    source = null;
    sourceOpen = false;
    sourceLoading = false;
    sourceError = null;
  });

  async function showSource(): Promise<void> {
    if (!review.capabilities.canLoadSource || sourceLoading) return;
    const reviewId = review.reviewId;
    const epoch = store.sourceEpoch;
    sourceLoading = true;
    sourceError = null;
    try {
      const excerpt = await client.getReviewSource(reviewId);
      if (review.reviewId !== reviewId || store.sourceEpoch !== epoch) return;
      source = excerpt;
      sourceOpen = true;
    } catch {
      if (review.reviewId === reviewId && store.sourceEpoch === epoch) {
        sourceError = "Authorized source excerpt unavailable.";
      }
    } finally {
      if (review.reviewId === reviewId && store.sourceEpoch === epoch) sourceLoading = false;
    }
  }

  function closeSource(): void {
    source = null;
    sourceOpen = false;
    sourceError = null;
  }

  function keyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && sourceOpen) closeSource();
  }
</script>

<svelte:window onkeydown={keyDown} />

<section class="review-panel" aria-labelledby="review-title-{review.reviewId}">
  <header>
    <div>
      <span class="review-kind">{review.kind.replaceAll("-", " ")}</span>
      <h3 id="review-title-{review.reviewId}">{review.title.value}</h3>
    </div>
    <span class="review-state">{review.state}</span>
  </header>
  <p>{review.summary.value}</p>

  <div class="context-grid">
    <div>
      <span>Affected IDs</span>
      <code>{review.affectedNodeIds.join(", ") || "none"}</code>
    </div>
    <div>
      <span>Precondition</span>
      <code>#{review.precondition.sequence} · {review.precondition.projectionChecksum}</code>
    </div>
  </div>

  {#if review.capabilities.canLoadSource}
    <div class="source-actions">
      <button type="button" disabled={sourceLoading} onclick={() => void showSource()}>
        {sourceLoading ? "Loading source" : "Show source"}
      </button>
      <span>Authorized, private, memory-only</span>
    </div>
  {/if}
  {#if sourceError}<p class="form-error" role="alert">{sourceError}</p>{/if}
  {#if sourceOpen && source}
    <section class="private-source" aria-label="Private authorized source excerpt">
      <header>
        <strong>PRIVATE SOURCE · {source.clauseId}</strong>
        <button type="button" onclick={closeSource}>Close</button>
      </header>
      <p>{source.text}</p>
      <small>Expires {source.expiresAt}. Cleared when this panel closes.</small>
    </section>
  {/if}

  {#if review.capabilities.canSubmit}
    <form class="decision-controls" onsubmit={(event) => { event.preventDefault(); void store.submitReview(review); }}>
      <fieldset disabled={draft.submitting || draft.awaitingDecisionNodeId !== null}>
        <legend>Server-provided decision</legend>
        {#each review.options as option (option.optionId)}
          <label class="review-option">
            <input
              type="radio"
              name="review-{review.reviewId}"
              value={option.optionId}
              checked={draft.optionId === option.optionId}
              onchange={() => store.updateDraft(review.reviewId, { optionId: option.optionId })}
            />
            <span>
              <strong>{option.label.value}</strong>
              <small>{option.description.value}</small>
            </span>
          </label>
        {/each}
        <label class="rationale">
          Rationale <span aria-hidden="true">*</span>
          <textarea
            required
            rows="3"
            value={draft.rationale}
            oninput={(event) =>
              store.updateDraft(review.reviewId, { rationale: event.currentTarget.value })}
          ></textarea>
        </label>
      </fieldset>
      {#if !preconditionsMatch}
        <p class="form-warning">Projection changed. Refresh context before submitting.</p>
      {:else if store.connection !== "live"}
        <p class="form-warning">Submission disabled while the projection is {store.connection}.</p>
      {/if}
      {#if draft.error}
        <p class="form-error" role="alert">{draft.error}</p>
        <button type="button" onclick={() => void store.refreshContext()}>Refresh context</button>
      {/if}
      {#if draft.awaitingDecisionNodeId}
        <p class="awaiting" aria-live="polite">
          Accepted at #{draft.acceptedSequence}. Draft clears after decision event
          <code>{draft.awaitingDecisionNodeId}</code> arrives.
        </p>
      {/if}
      <button
        class="primary"
        type="submit"
        disabled={!canSubmit || !hasRequiredInput || draft.submitting || draft.awaitingDecisionNodeId !== null}
      >
        {draft.submitting ? "Submitting" : "Submit immutable decision"}
      </button>
    </form>
    <p class="wide-required">Review actions require a wider viewport.</p>
  {:else}
    <div class="read-only-review">
      <strong>Inspection only</strong>
      <span>Submission capability was not granted.</span>
      {#each review.options as option (option.optionId)}
        <p><b>{option.label.value}:</b> {option.description.value}</p>
      {/each}
    </div>
  {/if}
</section>

<style>
  .review-panel {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-3);
  }

  .review-panel > header,
  .private-source > header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
  }

  h3 {
    margin: 2px 0 0;
    font-family: var(--font-heading);
    font-size: var(--text-md);
    text-transform: uppercase;
  }

  .review-kind,
  .review-state,
  .context-grid span,
  legend,
  .rationale {
    color: var(--dim);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
  }

  .review-state {
    color: var(--warn);
  }

  .review-panel > p {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-xs);
    line-height: 1.45;
  }

  .context-grid {
    display: grid;
    gap: var(--space-2);
  }

  .context-grid > div {
    display: grid;
    gap: 3px;
  }

  code {
    overflow-wrap: anywhere;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
  }

  .source-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .source-actions span {
    color: var(--dim);
    font-size: var(--text-2xs);
  }

  .private-source {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--warn);
    border-radius: var(--radius-md);
    background: oklch(0.22 0.02 70);
    box-shadow: var(--shadow-md);
  }

  .private-source strong,
  .private-source small {
    color: var(--warn);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
  }

  .private-source p {
    margin: 0;
    color: var(--text);
    font-size: var(--text-sm);
    line-height: 1.5;
    white-space: pre-wrap;
  }

  form,
  fieldset {
    display: grid;
    gap: var(--space-2);
  }

  fieldset {
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  legend {
    margin-bottom: var(--space-2);
  }

  .review-option {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--space-2);
    align-items: start;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--panel-2);
  }

  .review-option:has(input:checked) {
    border-color: var(--accent);
    background: var(--accent-fill);
  }

  .review-option span,
  .rationale {
    display: grid;
    gap: 3px;
  }

  .review-option strong {
    color: var(--text);
    font-size: var(--text-xs);
  }

  .review-option small {
    color: var(--muted);
    font-size: var(--text-2xs);
    line-height: 1.4;
  }

  textarea {
    width: 100%;
    resize: vertical;
    text-transform: none;
  }

  .form-warning,
  .form-error,
  .awaiting {
    margin: 0;
    font-size: var(--text-xs);
  }

  .form-warning {
    color: var(--warn);
  }

  .form-error {
    color: var(--danger);
  }

  .awaiting {
    color: var(--good);
  }

  .read-only-review {
    display: grid;
    gap: 4px;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--panel-2);
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .read-only-review strong {
    color: var(--text);
  }

  .read-only-review p {
    margin: 4px 0 0;
  }

  .wide-required {
    display: none;
    color: var(--warn) !important;
  }

  @media (max-width: 899px) {
    .decision-controls {
      display: none;
    }

    .wide-required {
      display: block;
    }
  }
</style>
