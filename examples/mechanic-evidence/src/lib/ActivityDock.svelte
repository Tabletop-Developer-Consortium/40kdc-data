<script lang="ts">
  import type { GraphEvent } from "./api/types.js";
  import type { DockTab, GraphStore } from "./graph-store.svelte.js";
  import ResizeHandle from "./ResizeHandle.svelte";

  let { store }: { store: GraphStore } = $props();
  type EventFilter = "all" | "failures" | "decisions" | "leases" | "checks" | "repository";
  let eventFilter = $state<EventFilter>("all");

  const filteredEvents = $derived.by(() =>
    store.events.filter((event) => {
      if (eventFilter === "all") return true;
      const category = `${event.category} ${event.type}`.toLowerCase();
      const patterns: Record<Exclude<EventFilter, "all">, RegExp> = {
        failures: /fail|error|reject|invalid|block/,
        decisions: /decision|review|adjudicat/,
        leases: /lease|worker|claim/,
        checks: /check|validat|test|gate/,
        repository: /repository|apply|patch|commit/,
      };
      return patterns[eventFilter].test(category);
    }),
  );

  function activate(tab: DockTab): void {
    store.activeDockTab = tab;
    store.expandDock();
  }

  function eventTime(event: GraphEvent): string {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(event.occurredAt));
  }
</script>

<section
  class="activity-dock"
  class:collapsed={store.dockHeight === 36}
  style:height={`${store.dockHeight}px`}
  aria-label="Campaign activity"
>
  {#if store.dockHeight !== 36}
    <ResizeHandle
      orientation="horizontal"
      label="Resize activity dock"
      value={store.dockHeight}
      minimum={180}
      maximum={420}
      onDelta={(delta) => store.setDockHeight(store.dockHeight - delta)}
      onReset={() => (store.dockHeight = 260)}
    />
  {/if}
  <div class="dock-tabs" role="tablist" aria-label="Activity views">
    <button
      type="button"
      role="tab"
      aria-selected={store.activeDockTab === "events"}
      class:active={store.activeDockTab === "events"}
      onclick={() => activate("events")}
    >Events <span>{store.events.length}</span></button>
    <button
      type="button"
      role="tab"
      aria-selected={store.activeDockTab === "review"}
      class:active={store.activeDockTab === "review"}
      onclick={() => activate("review")}
    >Review queue <span>{store.reviews.length}</span></button>
    <button
      type="button"
      role="tab"
      aria-selected={store.activeDockTab === "formalization"}
      class:active={store.activeDockTab === "formalization"}
      onclick={() => activate("formalization")}
    >Formalization</button>
    <button class="dock-toggle" type="button" onclick={() => store.toggleDock()}>
      {store.dockHeight === 36 ? "Expand" : "Collapse"}
    </button>
  </div>

  {#if store.dockHeight !== 36}
    <div class="dock-content">
      {#if store.activeDockTab === "events"}
        <div class="event-toolbar" aria-label="Event filters">
          {#each ["all", "failures", "decisions", "leases", "checks", "repository"] as filter}
            <button
              type="button"
              class:active={eventFilter === filter}
              onclick={() => (eventFilter = filter as EventFilter)}
            >{filter}</button>
          {/each}
        </div>
        <div class="event-list">
          {#if filteredEvents.length === 0}
            <p class="dock-empty">No matching committed events.</p>
          {:else}
            {#each filteredEvents as event (event.eventId)}
              <button
                type="button"
                class:selected={store.selectedEventSequence === event.sequence}
                onclick={() => store.selectEvent(event)}
              >
                <code>#{event.sequence}</code>
                <span class="event-type">{event.type.replaceAll("_", " ")}</span>
                <span class="event-summary">{event.summary.value}</span>
                <span class="event-time">{eventTime(event)}</span>
              </button>
            {/each}
          {/if}
        </div>
      {:else if store.activeDockTab === "review"}
        <div class="review-list">
          {#if store.reviews.length === 0}
            <p class="dock-empty">No review items block this projection.</p>
          {:else}
            {#each store.reviews as review (review.reviewId)}
              <button
                type="button"
                class:selected={store.selectedReviewId === review.reviewId}
                onclick={() => store.selectReview(review)}
              >
                <span class="review-kind">{review.kind.replaceAll("-", " ")}</span>
                <strong>{review.title.value}</strong>
                <span>{review.summary.value}</span>
                <code>{review.affectedNodeIds.length} affected · {review.capabilities.canSubmit ? "authorized" : "inspect only"}</code>
              </button>
            {/each}
          {/if}
        </div>
      {:else}
        <div class="formalization-grid">
          {#each [
            ["Restriction", store.formalization.restriction],
            ["Timing / order", store.formalization.timingOrder],
            ["Quantifier", store.formalization.quantifier],
            ["Binding", store.formalization.binding],
            ["Omission / invention", store.formalization.omissionInvention],
            ["Source extraction", store.formalization.sourceExtraction],
          ] as row (row[0])}
            <div><span>{row[0]}</span><strong>{row[1]}</strong></div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .activity-dock {
    display: grid;
    min-height: 36px;
    grid-template-rows: auto 36px minmax(0, 1fr);
    border-top: 1px solid var(--border);
    background: var(--panel);
    box-shadow: 0 -8px 20px oklch(0.08 0.004 286 / 0.55);
  }

  .activity-dock.collapsed {
    grid-template-rows: 36px;
  }

  .dock-tabs {
    display: flex;
    min-width: 0;
    align-items: stretch;
    border-bottom: 1px solid var(--border);
    background: var(--panel-surface);
  }

  .dock-tabs button {
    min-width: 0;
    padding: 0 var(--space-3);
    border: 0;
    border-right: 1px solid var(--border);
    border-radius: 0;
    background: transparent;
    color: var(--dim);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
  }

  .dock-tabs button.active {
    box-shadow: inset 0 -2px 0 var(--accent);
    color: var(--accent);
  }

  .dock-tabs span {
    margin-left: 4px;
    color: var(--muted);
  }

  .dock-tabs .dock-toggle {
    margin-left: auto;
    border-left: 1px solid var(--border);
    border-right: 0;
  }

  .dock-content {
    min-height: 0;
    overflow: auto;
  }

  .event-toolbar {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    gap: 4px;
    padding: 6px var(--space-3);
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }

  .event-toolbar button {
    padding: 3px 7px;
    border-color: var(--border);
    font-size: var(--text-2xs);
    text-transform: capitalize;
  }

  .event-toolbar button.active {
    border-color: var(--accent);
    color: var(--accent);
  }

  .event-list,
  .review-list {
    display: grid;
  }

  .event-list > button {
    display: grid;
    grid-template-columns: 62px 150px minmax(0, 1fr) 90px;
    gap: var(--space-2);
    align-items: baseline;
    padding: 7px var(--space-3);
    border: 0;
    border-bottom: 1px solid var(--border-subtle);
    border-radius: 0;
    background: transparent;
    text-align: left;
  }

  .event-list > button:hover,
  .review-list > button:hover,
  .event-list > button.selected,
  .review-list > button.selected {
    background: var(--panel-hover);
  }

  .event-list > button.selected,
  .review-list > button.selected {
    box-shadow: inset 0 0 0 1px var(--accent-dim);
  }

  code,
  .event-time,
  .review-kind {
    color: var(--dim);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
  }

  .event-type {
    overflow: hidden;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .event-summary {
    overflow: hidden;
    color: var(--text);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .review-list {
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1px;
    background: var(--border-subtle);
  }

  .review-list > button {
    display: grid;
    gap: 3px;
    padding: var(--space-3);
    border: 0;
    border-radius: 0;
    background: var(--panel);
    text-align: left;
  }

  .review-list strong {
    color: var(--text);
    font-size: var(--text-sm);
  }

  .review-list span:not(.review-kind) {
    overflow: hidden;
    color: var(--muted);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .formalization-grid {
    display: grid;
    grid-template-columns: repeat(6, minmax(130px, 1fr));
    min-height: 100%;
  }

  .formalization-grid > div {
    display: grid;
    place-content: center;
    gap: var(--space-2);
    border-right: 1px solid var(--border);
    text-align: center;
  }

  .formalization-grid span {
    color: var(--dim);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
  }

  .formalization-grid strong {
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-xl);
  }

  .dock-empty {
    margin: var(--space-4);
    color: var(--dim);
    font-size: var(--text-xs);
  }
</style>
