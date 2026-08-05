<script lang="ts">
  import type { InspectorRecord, MechanicGraphClient } from "./api/types.js";
  import type { GraphStore } from "./graph-store.svelte.js";
  import { edgeKindLabel, nodeKindLabel } from "./graph-presentation.js";
  import ReviewPanel from "./ReviewPanel.svelte";

  let {
    store,
    client,
  }: { store: GraphStore; client: MechanicGraphClient } = $props();
  let copyAnnouncement = $state("");

  async function copy(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      copyAnnouncement = `${label} copied`;
    } catch {
      copyAnnouncement = `${label} could not be copied`;
    }
  }

</script>
  {#snippet records(items: InspectorRecord[])}
    {#if items.length === 0}
      <p class="none">None recorded</p>
    {:else}
      <div class="record-list">
        {#each items as item (item.recordId)}
          <article class="record">
            <header>
              <strong>{item.label.value}</strong>
              <span>{item.kind}{item.state ? ` · ${item.state}` : ""}</span>
            </header>
            {#each item.fields as field (field.name)}
              <dl>
                <dt>{field.name}</dt>
                <dd>{field.value.value}</dd>
              </dl>
            {/each}
          </article>
        {/each}
      </div>
    {/if}
  {/snippet}

<aside class="inspector" aria-label="Evidence inspector">
  <div class="inspector-heading">
    <div>
      <span class="eyebrow">INSPECTOR</span>
      <h2>
        {store.nodeDetail?.label.value ??
          store.selectedEdge?.kind.replaceAll("_", " ") ??
          store.selectedReview?.title.value ??
          "No selection"}
      </h2>
    </div>
    {#if store.nodeDetail?.state}<span class="state">{store.nodeDetail.state}</span>{/if}
  </div>

  {#if store.nodeDetailLoading}
    <div class="inspector-loading" aria-label="Loading node detail">
      {#each Array(6) as _}<span></span>{/each}
    </div>
  {:else if store.nodeDetailError}
    <p class="inspector-error" role="alert">{store.nodeDetailError}</p>
  {:else if store.nodeDetail}
    {@const detail = store.nodeDetail}
    <details open>
      <summary>Identity and hashes</summary>
      <div class="section-body identity">
        {#each [
          ["Node ID", detail.nodeId],
          ["Campaign", detail.campaignId],
          ["Kind", nodeKindLabel(detail.kind)],
          ["State", detail.state ?? "unrecorded"],
          ["Validity", detail.validity ?? "unrecorded"],
          ["Content hash", detail.contentHash],
          ["Lineage hash", detail.lineageHash],
        ] as field (field[0])}
          <dl>
            <dt>{field[0]}</dt>
            <dd><code>{field[1]}</code></dd>
            {#if ["Node ID", "Campaign", "Content hash", "Lineage hash"].includes(field[0])}
              <button type="button" class="copy" onclick={() => void copy(field[1], field[0])}>Copy</button>
            {/if}
          </dl>
        {/each}
      </div>
    </details>

    <details open>
      <summary>Exact lineage</summary>
      <div class="section-body lineage">
        <h3>Parents</h3>
        {#if detail.parentEdges.length === 0}
          <p class="none">None recorded</p>
        {:else}
          {#each detail.parentEdges as edge (edge.edgeId)}
            <button type="button" onclick={() => store.selectNode(edge.sourceNodeId)}>
              <span>{edgeKindLabel(edge.kind)}</span><code>{edge.sourceNodeId}</code>
            </button>
          {/each}
        {/if}
        <h3>Children</h3>
        {#if detail.childEdges.length === 0}
          <p class="none">None recorded</p>
        {:else}
          {#each detail.childEdges as edge (edge.edgeId)}
            <button type="button" onclick={() => store.selectNode(edge.targetNodeId)}>
              <span>{edgeKindLabel(edge.kind)}</span><code>{edge.targetNodeId}</code>
            </button>
          {/each}
        {/if}
      </div>
    </details>

    <details open>
      <summary>Versions</summary>
      <div class="section-body key-values">
        {#if detail.versions.length === 0}
          <p class="none">None recorded</p>
        {:else}
          {#each detail.versions as version (version.name)}
            <dl><dt>{version.name}</dt><dd>{version.value.value}</dd></dl>
          {/each}
        {/if}
      </div>
    </details>

    <details>
      <summary>Leases</summary>
      <div class="section-body">{@render records(detail.leases)}</div>
    </details>
    <details>
      <summary>Checkpoints</summary>
      <div class="section-body">{@render records(detail.checkpoints)}</div>
    </details>
    <details open>
      <summary>Findings</summary>
      <div class="section-body">{@render records(detail.findings)}</div>
    </details>
    <details open>
      <summary>Checks</summary>
      <div class="section-body">{@render records(detail.checks)}</div>
    </details>
    <details open>
      <summary>Invalidation reasons</summary>
      <div class="section-body">
        {#if detail.invalidationReasons.length === 0}
          <p class="none">None recorded</p>
        {:else}
          <ul>
            {#each detail.invalidationReasons as reason}<li>{reason.value}</li>{/each}
          </ul>
        {/if}
      </div>
    </details>
  {:else if store.selectedEdge}
    {@const edge = store.selectedEdge}
    <div class="edge-summary">
      <span class="edge-kind">{edgeKindLabel(edge.kind)}</span>
      <dl><dt>Edge ID</dt><dd><code>{edge.edgeId}</code></dd></dl>
      <dl><dt>From</dt><dd><button type="button" onclick={() => store.selectNode(edge.sourceNodeId)}>{edge.sourceNodeId}</button></dd></dl>
      <dl><dt>To</dt><dd><button type="button" onclick={() => store.selectNode(edge.targetNodeId)}>{edge.targetNodeId}</button></dd></dl>
      <dl><dt>Authority</dt><dd>{edge.authority}</dd></dl>
      <dl><dt>State</dt><dd>{edge.state ?? "unrecorded"}</dd></dl>
    </div>
  {:else if !store.selectedReview}
    <div class="empty-inspector">
      <strong>Select a node or edge</strong>
      <p>Identity, exact lineage, version history, findings, checks, and invalidation state appear here.</p>
    </div>
  {/if}

  {#if store.selectedReview}
    <div class="review-divider"></div>
    <ReviewPanel {store} {client} review={store.selectedReview} />
  {/if}
  <span class="sr-only" aria-live="polite">{copyAnnouncement}</span>
</aside>

<style>
  .inspector {
    min-width: 0;
    min-height: 0;
    overflow: auto;
    background: var(--panel);
  }

  .inspector-heading {
    position: sticky;
    top: 0;
    z-index: 3;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3);
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    box-shadow: var(--shadow-sm);
  }

  .eyebrow,
  .state,
  summary,
  h3,
  dt,
  .edge-kind {
    color: var(--dim);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
  }

  h2 {
    overflow: hidden;
    margin: 2px 0 0;
    font-family: var(--font-heading);
    font-size: var(--text-lg);
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .state {
    color: var(--accent);
  }

  details {
    border-bottom: 1px solid var(--border);
  }

  summary {
    display: flex;
    gap: var(--space-2);
    padding: 9px var(--space-3);
    list-style: none;
    background: var(--panel-surface);
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary::before {
    content: "›";
    color: var(--dim);
    transition: transform 160ms ease-out;
  }

  details[open] summary::before {
    transform: rotate(90deg);
  }

  .section-body,
  .edge-summary,
  .empty-inspector {
    padding: var(--space-3);
  }

  .identity,
  .key-values,
  .edge-summary {
    display: grid;
    gap: var(--space-2);
  }

  dl {
    display: grid;
    grid-template-columns: minmax(84px, 0.35fr) minmax(0, 1fr) auto;
    gap: var(--space-2);
    align-items: baseline;
    margin: 0;
  }

  dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  code {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
  }

  .copy {
    padding: 2px 6px;
    font-size: 9px;
  }

  .lineage {
    display: grid;
    gap: 5px;
  }

  .lineage h3:not(:first-child) {
    margin-top: var(--space-2);
  }

  .lineage h3 {
    margin-block: 0;
  }

  .lineage button {
    display: grid;
    grid-template-columns: 100px minmax(0, 1fr);
    gap: var(--space-2);
    text-align: left;
  }

  .lineage button span {
    color: var(--dim);
    font-size: var(--text-2xs);
  }

  .record-list {
    display: grid;
    gap: var(--space-2);
  }

  .record {
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--panel-2);
  }

  .record header {
    display: flex;
    justify-content: space-between;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }

  .record header strong {
    font-size: var(--text-xs);
  }

  .record header span {
    color: var(--dim);
    font-family: var(--font-mono);
    font-size: 9px;
  }

  .record dl {
    grid-template-columns: 90px minmax(0, 1fr);
    padding-block: 3px;
  }

  ul {
    margin: 0;
    padding-left: 18px;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .none,
  .empty-inspector p {
    margin: 0;
    color: var(--dim);
    font-size: var(--text-xs);
  }

  .empty-inspector {
    display: grid;
    min-height: 180px;
    align-content: center;
    justify-items: center;
    gap: var(--space-2);
    text-align: center;
  }

  .empty-inspector p {
    max-width: 36ch;
    line-height: 1.45;
  }

  .edge-summary .edge-kind {
    color: var(--accent);
  }

  .edge-summary dd button {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .inspector-loading {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-3);
  }

  .inspector-loading span {
    height: 44px;
    border: 1px solid var(--border);
    background: var(--panel-surface);
  }

  .inspector-error {
    margin: var(--space-3);
    color: var(--danger);
    font-size: var(--text-xs);
  }

  .review-divider {
    height: 1px;
    background: var(--accent-dim);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
  }

  @media (prefers-reduced-motion: reduce) {
    summary::before {
      transition: none;
    }
  }
</style>
