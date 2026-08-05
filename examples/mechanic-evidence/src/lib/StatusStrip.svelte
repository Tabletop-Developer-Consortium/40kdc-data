<script lang="ts">
  import type { GraphStore } from "./graph-store.svelte.js";

  let { store }: { store: GraphStore } = $props();
  const lastEvent = $derived(
    store.campaign?.lastEventAt
      ? new Intl.DateTimeFormat(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }).format(new Date(store.campaign.lastEventAt))
      : "none",
  );
</script>

<section class="status-strip" aria-label="Campaign status">
  {#if store.campaign}
    <div class="terminal headline">
      <span class="value">{store.campaign.terminalWorklist} / {store.campaign.worklistSize}</span>
      <span class="label">terminal</span>
      <span class="outcomes">
        {store.campaign.outcomes.converged} converged · {store.campaign.outcomes.improved} improved ·
        {store.campaign.outcomes.needsSchema} needs schema · {store.campaign.outcomes.abandoned} abandoned
      </span>
    </div>
    <div>
      <span class="value state-value">{store.campaign.state}</span>
      <span class="label">campaign</span>
    </div>
    <div>
      <span class="value">{store.campaign.knownTasks.completed} / {store.campaign.knownTasks.total}</span>
      <span class="label">Known tasks completed / known tasks (dynamic)</span>
    </div>
    <div>
      <span class="value">{store.campaign.activeTasks}</span>
      <span class="label">active tasks</span>
    </div>
    <div class:attention={store.campaign.blockingDecisions > 0}>
      <span class="value">{store.campaign.blockingDecisions}</span>
      <span class="label">blocking decisions</span>
    </div>
    <div class:attention={store.campaign.openFindings > 0}>
      <span class="value">{store.campaign.openFindings}</span>
      <span class="label">open findings</span>
    </div>
    <div>
      <span class="value">
        {store.campaign.currentVersionChecks.passed} / {store.campaign.currentVersionChecks.total}
      </span>
      <span class="label">current-version checks</span>
    </div>
    <div>
      <span class="value">
        {store.campaign.shapeRound
          ? `${store.campaign.shapeRound.current} / ${store.campaign.shapeRound.maximum}`
          : "none"}
      </span>
      <span class="label">shape round</span>
    </div>
    <div class="connection" class:healthy={store.connection === "live"} aria-live="polite">
      <span class="connection-dot" aria-hidden="true"></span>
      <span class="value">{store.connection}</span>
      <span class="label">connection</span>
    </div>
    <div>
      <span class="value">#{store.sequence}</span>
      <span class="label">last committed · {lastEvent}</span>
    </div>
  {:else}
    {#each Array(8) as _}
      <div class="skeleton" aria-hidden="true"></div>
    {/each}
    <span class="sr-only">Loading campaign status</span>
  {/if}
</section>

<style>
  .status-strip {
    display: flex;
    min-width: 0;
    height: 64px;
    overflow-x: auto;
    border-bottom: 1px solid var(--border);
    background: var(--panel-surface);
    box-shadow: var(--shadow-sm);
  }

  .status-strip > div {
    display: grid;
    min-width: max-content;
    align-content: center;
    padding: 7px var(--space-3);
    border-right: 1px solid var(--border);
  }

  .status-strip .headline {
    min-width: 320px;
    background: var(--panel);
  }

  .value {
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    line-height: 1.15;
  }

  .headline .value {
    color: var(--accent);
    font-size: var(--text-lg);
    font-weight: 500;
  }

  .state-value {
    text-transform: uppercase;
  }

  .label,
  .outcomes {
    color: var(--dim);
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  .outcomes {
    margin-top: 3px;
    color: var(--muted);
  }

  .attention .value {
    color: var(--warn);
  }

  .connection {
    grid-template-columns: auto 1fr;
    column-gap: 6px;
  }

  .connection .label {
    grid-column: 2;
  }

  .connection-dot {
    align-self: center;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--warn);
    box-shadow: 0 0 0 2px oklch(0.769 0.165 70 / 0.16);
  }

  .healthy .connection-dot {
    background: var(--good);
    box-shadow: 0 0 0 2px oklch(0.723 0.192 150 / 0.16);
  }

  .skeleton {
    width: 128px;
    background: linear-gradient(90deg, var(--panel-surface), var(--panel-hover), var(--panel-surface));
    background-size: 200% 100%;
    animation: skeleton 1.4s linear infinite;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
  }

  @keyframes skeleton {
    to {
      background-position: -200% 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton {
      animation: none;
    }
  }
</style>
