<script lang="ts">
  import { Handle, Position } from "@xyflow/svelte";
  import type { EvidenceNodeData } from "./graph-presentation.js";

  let { data }: { data: EvidenceNodeData } = $props();
  const shortId = $derived(data.node.nodeId.slice(0, 12));
  const state = $derived(data.node.state ?? data.node.validity ?? "recorded");
  const ports = [0, 1, 2] as const;
</script>

{#each ports as port}
  <Handle
    id={`target-${port}`}
    type="target"
    position={Position.Left}
    isConnectable={false}
    aria-hidden="true"
    role="presentation"
    class="evidence-handle"
    style={`top: ${25 + port * 25}%`}
  />
{/each}
<article
  class:node-selected={data.selected}
  class:node-related={data.related}
  class:unknown-kind={!data.knownKind}
  class:subdued={data.tone === "subdued"}
  class:danger={data.tone === "danger"}
  class:warning={data.tone === "warning"}
  class:good={data.tone === "good"}
  class="evidence-node"
>
  <header>
    <span class="kind">{data.kindLabel}</span>
    <span class="state">{state}</span>
  </header>
  <strong title={data.displayLabel}>{data.displayLabel}</strong>
  {#if data.provenanceSummary}
    <span class="provenance" title={data.provenanceSummary}>{data.provenanceSummary}</span>
  {/if}
  <code title={data.node.nodeId}>{shortId}</code>
</article>
{#each ports as port}
  <Handle
    id={`source-${port}`}
    type="source"
    position={Position.Right}
    isConnectable={false}
    aria-hidden="true"
    role="presentation"
    class="evidence-handle"
    style={`top: ${25 + port * 25}%`}
  />
{/each}

<style>
  :global(.svelte-flow__node-evidence) {
    width: 232px;
    border-radius: var(--radius-md);
    background: transparent;
  }

  :global(.svelte-flow__node-evidence:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  :global(.evidence-handle) {
    width: 7px;
    height: 7px;
    border: 1px solid var(--border-strong);
    background: var(--panel-2);
    opacity: 0.82;
  }

  .evidence-node {
    min-height: 104px;
    overflow: hidden;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--panel);
    box-shadow: var(--shadow-sm);
    transition:
      border-color 170ms ease-out,
      opacity 170ms ease-out,
      transform 170ms ease-out;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: 5px var(--space-2);
    border-bottom: 1px solid var(--border);
    background: var(--panel-surface);
  }

  .kind,
  .state {
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: var(--tracking-wide);
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .kind {
    color: var(--muted);
  }

  .state {
    color: var(--dim);
  }

  strong,
  .provenance,
  code {
    display: block;
    overflow: hidden;
    margin-inline: var(--space-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    margin-top: 9px;
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: 650;
  }

  .provenance {
    margin-top: 4px;
    color: var(--muted);
    font: 10px/1.35 var(--font-mono);
  }

  code {
    margin-block: 5px 9px;
    color: var(--dim);
    font: 9px/1.25 var(--font-mono);
    letter-spacing: .04em;
  }

  .node-selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent), var(--shadow-md);
    transform: translateY(-1px);
  }

  .node-related {
    border-color: var(--accent-dim);
  }

  .good .state {
    color: var(--good);
  }

  .warning .state {
    color: var(--warn);
  }

  .danger .state {
    color: var(--danger);
  }

  .subdued {
    border-color: var(--border);
    opacity: 0.48;
    filter: saturate(0.35);
  }

  .unknown-kind .kind::after {
    content: " · unknown";
    color: var(--warn);
  }

  @media (prefers-reduced-motion: reduce) {
    .evidence-node {
      transition: none;
    }
  }
</style>
