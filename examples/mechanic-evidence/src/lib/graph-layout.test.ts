import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNodeSummary } from "./api/types.js";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  layoutInitial,
  reconcilePositions,
} from "./graph-layout.js";

const safeText = (value: string) => ({
  value,
  classification: "community-authored" as const,
});

function node(nodeId: string): GraphNodeSummary {
  return {
    nodeId,
    campaignId: "c010",
    kind: "candidate_dsl",
    label: safeText(nodeId),
    summary: null,
    state: "current",
    validity: "valid",
  };
}

function edge(edgeId: string, sourceNodeId: string, targetNodeId: string): GraphEdge {
  return {
    edgeId,
    sourceNodeId,
    targetNodeId,
    kind: "derived_from",
    authority: "authoritative",
    state: "current",
  };
}

describe("graph layout", () => {
  it("produces the same initial positions regardless of input order", () => {
    const nodes = [node("node-c"), node("node-a"), node("node-b")];
    const edges = [edge("edge-bc", "node-b", "node-c"), edge("edge-ab", "node-a", "node-b")];

    const first = layoutInitial(nodes, edges);
    const second = layoutInitial([...nodes].reverse(), [...edges].reverse());

    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it("keeps surviving coordinates and places additions without overlap", () => {
    const existingNodes = [node("node-a"), node("node-b")];
    const existingEdges = [edge("edge-ab", "node-a", "node-b")];
    const previous = layoutInitial(existingNodes, existingEdges);
    const nextNodes = [...existingNodes, node("node-c"), node("node-d")];
    const nextEdges = [
      ...existingEdges,
      edge("edge-bc", "node-b", "node-c"),
      edge("edge-bd", "node-b", "node-d"),
    ];

    const reconciled = reconcilePositions(nextNodes, nextEdges, previous);

    expect(reconciled.get("node-a")).toEqual(previous.get("node-a"));
    expect(reconciled.get("node-b")).toEqual(previous.get("node-b"));
    const positions = [...reconciled.values()];
    for (let left = 0; left < positions.length; left += 1) {
      for (let right = left + 1; right < positions.length; right += 1) {
        const a = positions[left];
        const b = positions[right];
        const separated =
          a.x + NODE_WIDTH <= b.x ||
          b.x + NODE_WIDTH <= a.x ||
          a.y + NODE_HEIGHT <= b.y ||
          b.y + NODE_HEIGHT <= a.y;
        expect(separated, `positions ${left} and ${right} overlap`).toBe(true);
      }
    }
  });
});
