<script lang="ts">
  import { Handle, Position } from "@xyflow/svelte";
  import type { EvidenceNodeData } from "./graph-presentation.js";

  let { data }: { data: EvidenceNodeData } = $props();
  const shortId = $derived(
    data.node.nodeId.length > 18
      ? `${data.node.nodeId.slice(0, 10)}…${data.node.nodeId.slice(-5)}`
      : data.node.nodeId,
  );
  const state = $derived(data.node.state ?? data.node.validity ?? "recorded");
</script>

<Handle type="target" position={Position.Left} isConnectable={false} class="evidence-handle" />
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
  <strong title={data.node.nodeId}>{shortId}</strong>
  <span class="label">{data.node.label.value}</span>
  {#if data.node.summary}
    <p>{data.node.summary.value}</p>
  {/if}
</article>
<Handle type="source" position={Position.Right} isConnectable={false} class="evidence-handle" />

<style>
  :global(.svelte-flow__node-evidence) {
    width: 216px;
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
    min-height: 82px;
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
    font-size: 9px;
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
  .label,
  p {
    display: block;
    margin-inline: var(--space-2);
  }

  strong {
    margin-top: 7px;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    font-weight: 500;
  }

  .label {
    overflow: hidden;
    margin-top: 2px;
    color: var(--muted);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  p {
    display: -webkit-box;
    overflow: hidden;
    margin-block: 4px 7px;
    color: var(--dim);
    font-size: 10px;
    line-height: 1.25;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
    line-clamp: 1;
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
