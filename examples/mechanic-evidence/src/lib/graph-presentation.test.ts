import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNodeSummary } from "./api/types.js";
import {
  edgePresentation,
  edgeRelationshipDescription,
  isKnownNodeKind,
  nodeDisplayLabel,
  nodeProvenanceSummary,
} from "./graph-presentation.js";

function workflowNode(): GraphNodeSummary {
  return {
    nodeId: "30c8c8a5c370",
    campaignId: "c011",
    kind: "workflow_output",
    label: { value: "psyker output", classification: "identifier" },
    summary: null,
    state: null,
    validity: null,
    outputKind: "psyker",
    workflowTask: "leader-relation",
    workflowLane: "trail",
    attemptNumber: 1,
  };
}

function edge(kind: string): GraphEdge {
  return {
    edgeId: `edge:${kind}`,
    sourceNodeId: "30c8c8a5c370",
    targetNodeId: "30b4a49f8f1e",
    kind,
    authority: "provisional",
    state: null,
  };
}

describe("human graph presentation", () => {
  it("covers every node and edge kind emitted by the live campaign projection", () => {
    for (const kind of ["workflow_output", "ability", "construction_plan", "mechanic_evidence_root"]) {
      expect(isKnownNodeKind(kind), kind).toBe(true);
    }
    for (const kind of ["derived_from", "evidence", "contains"]) {
      const presentation = edgePresentation(edge(kind), false);
      expect(presentation.knownKind, kind).toBe(true);
      expect(presentation.label.length, kind).toBeGreaterThan(0);
    }
  });

  it("makes workflow provenance primary and hashes secondary", () => {
    const node = workflowNode();
    expect(nodeDisplayLabel(node)).toBe("Psyker output");
    expect(nodeProvenanceSummary(node)).toBe("leader-relation · trail · attempt 1");
    expect(nodeDisplayLabel(node)).not.toContain(node.nodeId);
  });

  it("describes dependency direction from target back to its source", () => {
    expect(edgeRelationshipDescription(
      edge("derived_from"),
      "Psyker output",
      "Kroot trail shaper output",
    )).toBe("Kroot trail shaper output was derived from Psyker output.");
  });
});
