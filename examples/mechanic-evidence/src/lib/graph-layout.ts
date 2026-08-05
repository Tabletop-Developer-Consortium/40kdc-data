import dagre from "@dagrejs/dagre";
import type { GraphEdge, GraphNodeSummary } from "./api/types.js";

export interface GraphPosition {
  x: number;
  y: number;
}

export const NODE_WIDTH = 216;
export const NODE_HEIGHT = 82;
const RANK_GAP = 104;
const NODE_GAP = 36;
const X_STEP = NODE_WIDTH + RANK_GAP;
const Y_STEP = NODE_HEIGHT + NODE_GAP;

export function layoutInitial(
  nodes: Iterable<GraphNodeSummary>,
  edges: Iterable<GraphEdge>,
): Map<string, GraphPosition> {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: "LR",
    ranksep: RANK_GAP,
    nodesep: NODE_GAP,
    marginx: 28,
    marginy: 28,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  const sortedNodes = [...nodes].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const nodeIds = new Set(sortedNodes.map((node) => node.nodeId));
  for (const node of sortedNodes) {
    graph.setNode(node.nodeId, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  const sortedEdges = [...edges].sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  for (const edge of sortedEdges) {
    if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) continue;
    graph.setEdge(edge.sourceNodeId, edge.targetNodeId, {}, edge.edgeId);
  }

  dagre.layout(graph);
  return new Map(
    sortedNodes.map((node) => {
      const position = graph.node(node.nodeId) as { x: number; y: number };
      return [
        node.nodeId,
        {
          x: Math.round(position.x - NODE_WIDTH / 2),
          y: Math.round(position.y - NODE_HEIGHT / 2),
        },
      ];
    }),
  );
}

function overlaps(left: GraphPosition, right: GraphPosition): boolean {
  return !(
    left.x + NODE_WIDTH + NODE_GAP / 2 <= right.x ||
    right.x + NODE_WIDTH + NODE_GAP / 2 <= left.x ||
    left.y + NODE_HEIGHT + NODE_GAP / 2 <= right.y ||
    right.y + NODE_HEIGHT + NODE_GAP / 2 <= left.y
  );
}

export function reconcilePositions(
  nodes: Iterable<GraphNodeSummary>,
  edges: Iterable<GraphEdge>,
  previous: ReadonlyMap<string, GraphPosition>,
): Map<string, GraphPosition> {
  const sortedNodes = [...nodes].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const nodeIds = new Set(sortedNodes.map((node) => node.nodeId));
  const next = new Map<string, GraphPosition>();
  for (const node of sortedNodes) {
    const existing = previous.get(node.nodeId);
    if (existing) next.set(node.nodeId, existing);
  }

  const rightmost = [...next.values()].reduce(
    (maximum, position) => Math.max(maximum, position.x),
    -X_STEP,
  );
  const parents = new Map<string, string[]>();
  for (const edge of [...edges].sort((left, right) => left.edgeId.localeCompare(right.edgeId))) {
    if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) continue;
    const current = parents.get(edge.targetNodeId) ?? [];
    current.push(edge.sourceNodeId);
    parents.set(edge.targetNodeId, current);
  }

  for (const node of sortedNodes) {
    if (next.has(node.nodeId)) continue;
    const positionedParents = (parents.get(node.nodeId) ?? [])
      .map((parentId) => next.get(parentId))
      .filter((position): position is GraphPosition => position !== undefined)
      .sort((left, right) => right.x - left.x || left.y - right.y);
    const nearestParent = positionedParents[0];
    const x = nearestParent ? nearestParent.x + X_STEP : rightmost + X_STEP;
    let y = nearestParent?.y ?? 28;
    let candidate = { x, y };
    while ([...next.values()].some((position) => overlaps(candidate, position))) {
      y += Y_STEP;
      candidate = { x, y };
    }
    next.set(node.nodeId, candidate);
  }
  return next;
}

export function resetLayout(
  nodes: Iterable<GraphNodeSummary>,
  edges: Iterable<GraphEdge>,
): Map<string, GraphPosition> {
  return layoutInitial(nodes, edges);
}
