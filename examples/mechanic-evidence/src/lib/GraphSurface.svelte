<script lang="ts">
  import {
    Background,
    BackgroundVariant,
    Controls,
    MarkerType,
    MiniMap,
    SvelteFlow,
    useSvelteFlow,
    type Edge,
    type Node,
  } from "@xyflow/svelte";
  import type { GraphEdge, GraphNodeSummary } from "./api/types.js";
  import EvidenceNode from "./EvidenceNode.svelte";
  import type { GraphStore } from "./graph-store.svelte.js";
  import {
    edgeDirectionLabel,
    edgePresentation,
    isKnownNodeKind,
    nodeDisplayLabel,
    nodeKindLabel,
    nodeProvenanceSummary,
    nodeTone,
    type EvidenceNodeData,
  } from "./graph-presentation.js";
  import { NODE_HEIGHT, NODE_WIDTH } from "./graph-layout.js";

  let { store }: { store: GraphStore } = $props();

  type FlowNode = Node<EvidenceNodeData, "evidence">;
  type FlowEdge = Edge<{ record: GraphEdge }, "smoothstep">;
  const nodeTypes = { evidence: EvidenceNode };
  const readOnlyAriaLabelConfig = {
    "node.a11yDescription.default": "Read-only evidence node.",
    "node.a11yDescription.keyboardDisabled":
      "Read-only graph. Press Enter or Space to select a node and inspect its safe evidence details.",
    "edge.a11yDescription.default":
      "Read-only evidence relationship. Press Enter or Space to inspect its direction, authority, and endpoints.",
    "controls.ariaLabel": "Graph view controls",
  };
  const { fitView } = useSvelteFlow<FlowNode, FlowEdge>();
  const motionDuration =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 0
      : 180;
  let initialized = $state(false);
  let handledFitRequest = 0;
  let handledCenterToken = 0;

  const relatedNodeIds = $derived.by(() => {
    const related = new Set<string>();
    if (store.selectedEdge) {
      related.add(store.selectedEdge.sourceNodeId);
      related.add(store.selectedEdge.targetNodeId);
    }
    if (!store.selectedNodeId) return related;
    for (const edge of store.edges.values()) {
      if (edge.sourceNodeId === store.selectedNodeId) related.add(edge.targetNodeId);
      if (edge.targetNodeId === store.selectedNodeId) related.add(edge.sourceNodeId);
    }
    return related;
  });

  const filteredNodeIds = $derived.by(() => {
    const ids = new Set<string>();
    const search = store.filters.search.trim().toLowerCase();
    for (const node of store.nodes.values()) {
      if (node.nodeId === store.selectedNodeId) {
        ids.add(node.nodeId);
        continue;
      }
      if (
        store.filters.collapseCertified &&
        ["source_formalization_certificate", "certified_ability_evidence", "certificate"].includes(
          node.kind,
        )
      ) {
        continue;
      }
      if (
        search &&
        !node.nodeId.toLowerCase().includes(search) &&
        !node.label.value.toLowerCase().includes(search)
      ) {
        continue;
      }
      if (store.filters.nodeKinds.length && !store.filters.nodeKinds.includes(node.kind)) continue;
      if (
        store.filters.states.length &&
        !store.filters.states.includes(node.state ?? "unrecorded")
      ) {
        continue;
      }
      if (
        store.filters.validities.length &&
        !store.filters.validities.includes(node.validity ?? "unrecorded")
      ) {
        continue;
      }
      ids.add(node.nodeId);
    }
    return ids;
  });

  const edgePorts = $derived.by(() => {
    const assignments = new Map<string, { source: number; target: number }>();
    const sourceCounts = new Map<string, number>();
    const targetCounts = new Map<string, number>();
    for (const edge of [...store.edges.values()].sort((left, right) => left.edgeId.localeCompare(right.edgeId))) {
      const source = sourceCounts.get(edge.sourceNodeId) ?? 0;
      const target = targetCounts.get(edge.targetNodeId) ?? 0;
      assignments.set(edge.edgeId, { source: source % 3, target: target % 3 });
      sourceCounts.set(edge.sourceNodeId, source + 1);
      targetCounts.set(edge.targetNodeId, target + 1);
    }
    return assignments;
  });

  const flowNodes = $derived.by((): FlowNode[] =>
    [...store.nodes.values()]
      .filter((node) => filteredNodeIds.has(node.nodeId))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
      .map((node) => ({
        id: node.nodeId,
        type: "evidence",
        position: store.positions.get(node.nodeId) ?? { x: 0, y: 0 },
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        selected: store.selectedNodeId === node.nodeId,
        focusable: true,
        selectable: true,
        deletable: false,
        ariaRole: "button",
        ariaLabel: `${nodeKindLabel(node.kind)} ${node.label.value}, ${node.state ?? node.validity ?? "recorded"}`,
        domAttributes: {
          "aria-pressed": store.selectedNodeId === node.nodeId,
          "data-selected": store.selectedNodeId === node.nodeId ? "true" : "false",
        },
        data: {
          node,
          kindLabel: nodeKindLabel(node.kind),
          displayLabel: nodeDisplayLabel(node),
          provenanceSummary: nodeProvenanceSummary(node),
          tone: nodeTone(node),
          knownKind: isKnownNodeKind(node.kind),
          selected: store.selectedNodeId === node.nodeId,
          related: relatedNodeIds.has(node.nodeId),
        },
      })),
  );

  const flowEdges = $derived.by((): FlowEdge[] =>
    [...store.edges.values()]
      .filter(
        (edge) =>
          filteredNodeIds.has(edge.sourceNodeId) &&
          filteredNodeIds.has(edge.targetNodeId) &&
          (!store.filters.edgeKinds.length || store.filters.edgeKinds.includes(edge.kind)),
      )
      .sort((left, right) => left.edgeId.localeCompare(right.edgeId))
      .map((edge) => {
        const highlighted =
          store.selectedEdgeId === edge.edgeId ||
          (store.selectedNodeId !== null &&
            (edge.sourceNodeId === store.selectedNodeId || edge.targetNodeId === store.selectedNodeId));
        const presentation = edgePresentation(edge, highlighted);
        const source = store.nodes.get(edge.sourceNodeId);
        const target = store.nodes.get(edge.targetNodeId);
        const ports = edgePorts.get(edge.edgeId) ?? { source: 0, target: 0 };
        return {
          id: edge.edgeId,
          source: edge.sourceNodeId,
          target: edge.targetNodeId,
          sourceHandle: `source-${ports.source}`,
          targetHandle: `target-${ports.target}`,
          type: "smoothstep",
          data: { record: edge },
          selected: store.selectedEdgeId === edge.edgeId,
          selectable: true,
          focusable: true,
          deletable: false,
          ariaRole: "button",
          ariaLabel: `${source ? nodeDisplayLabel(source) : edge.sourceNodeId} ${edgeDirectionLabel(edge.kind)} ${target ? nodeDisplayLabel(target) : edge.targetNodeId}, ${edge.authority}`,
          label: store.graphScope === "trace" || highlighted ? presentation.label : undefined,
          labelStyle: "fill: var(--text); font: 600 10px/1 var(--font-mono); letter-spacing: .04em",
          labelBgStyle: "fill: var(--panel-2); fill-opacity: .94",
          labelBgPadding: [4, 3],
          labelBgBorderRadius: 3,
          style: presentation.style,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: presentation.markerColor,
            width: 16,
            height: 16,
          },
          interactionWidth: 22,
        };
      }),
  );


  $effect(() => {
    const request = store.fitRequest;
    if (!initialized || request === handledFitRequest || flowNodes.length === 0) return;
    handledFitRequest = request;
    queueMicrotask(() =>
      void fitView({ nodes: flowNodes, padding: 0.2, minZoom: store.graphScope === "trace" ? 0.72 : 0.42, maxZoom: 1.12, duration: motionDuration }),
    );
  });

  $effect(() => {
    const request = store.centerRequest;
    if (
      !initialized ||
      !request ||
      request.token === handledCenterToken ||
      !store.nodes.has(request.nodeId)
    ) {
      return;
    }
    const target = flowNodes.find((node) => node.id === request.nodeId);
    if (!target) return;
    handledCenterToken = request.token;
    const timer = setTimeout(() => {
      if (store.centerRequest?.token !== request.token) return;
      void fitView({
        nodes: [target],
        padding: 0.35,
        minZoom: 0.85,
        maxZoom: 1.12,
        duration: motionDuration,
      });
    }, motionDuration + 32);
    return () => clearTimeout(timer);
  });
</script>

<div class="graph-surface" class:stale={store.projectionIsStale}>
  {#if flowNodes.length > 0}
    <SvelteFlow
      nodes={flowNodes}
      edges={flowEdges}
      {nodeTypes}
      bind:viewport={store.viewport}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={true}
      edgesFocusable={true}
      elementsSelectable={true}
      onlyRenderVisibleElements={true}
      minZoom={0.45}
      maxZoom={1.8}
      deleteKey={null}
      multiSelectionKey={null}
      selectionKey={null}
      ariaLabelConfig={readOnlyAriaLabelConfig}
      oninit={() => (initialized = true)}
      onnodeclick={({ node }) => store.selectNode(node.id)}
      onedgeclick={({ edge }) => store.selectEdge(edge.id)}
      onselectionchange={({ nodes, edges }) => {
        if (nodes[0]) store.selectNode(nodes[0].id);
        else if (edges[0]) store.selectEdge(edges[0].id);
      }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} patternColor="var(--grid)" />
      <MiniMap
        ariaLabel="Current graph overview"
        bgColor="var(--panel-2)"
        nodeColor="var(--border-strong)"
        nodeStrokeColor="var(--muted)"
        maskColor="oklch(0.12 0.004 286 / 0.68)"
        pannable={true}
        zoomable={true}
      />
      <Controls showLock={false} />
    </SvelteFlow>
  {:else if store.hasProjection}
    <div class="filtered-empty">
      <strong>No nodes match the active filters</strong>
      <p>Search, node, state, validity, edge, or certified-subgraph filters excluded this campaign.</p>
      <button type="button" onclick={() => store.resetFilters()}>Reset filters</button>
    </div>
  {/if}
  {#if store.projectionIsStale}
    <div class="stale-watermark" aria-hidden="true">LAST VERIFIED · STALE</div>
  {/if}
</div>

<style>
  .graph-surface {
    position: relative;
    min-width: 0;
    min-height: 0;
    background: var(--bg-dark);
  }

  .graph-surface.stale :global(.svelte-flow__viewport) {
    filter: saturate(0.55);
  }

  :global(.svelte-flow) {
    background: var(--bg-dark);
  }

  :global(.svelte-flow__minimap) {
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
  }

  :global(.svelte-flow__controls) {
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
  }

  :global(.svelte-flow__controls-button) {
    min-width: 32px;
    min-height: 32px;
    border-bottom-color: var(--border);
    background: var(--panel);
    color: var(--text);
    fill: currentColor;
  }

  :global(.svelte-flow__controls-button:hover) {
    background: var(--panel-hover);
  }

  :global(.svelte-flow__edge:focus-visible) {
    outline: none;
  }

  :global(.svelte-flow__edge:focus-visible .svelte-flow__edge-path) {
    stroke: var(--accent);
    stroke-width: 3px;
  }

  :global(.svelte-flow__edge-text) {
    paint-order: stroke;
    stroke: var(--panel-2);
    stroke-width: 2px;
  }

  .filtered-empty {
    position: absolute;
    inset: 0;
    display: grid;
    align-content: center;
    justify-items: center;
    padding: var(--space-5);
    text-align: center;
  }

  .filtered-empty strong {
    font-family: var(--font-heading);
    font-size: var(--text-lg);
    text-transform: uppercase;
  }

  .filtered-empty p {
    max-width: 52ch;
    color: var(--muted);
    font-size: var(--text-sm);
  }

  .filtered-empty button {
    margin-top: var(--space-2);
  }

  .stale-watermark {
    position: absolute;
    top: var(--space-3);
    left: 50%;
    z-index: 5;
    padding: 4px 8px;
    transform: translateX(-50%);
    border: 1px solid var(--warn);
    border-radius: var(--radius-sm);
    background: var(--panel-2);
    color: var(--warn);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wider);
  }
</style>
