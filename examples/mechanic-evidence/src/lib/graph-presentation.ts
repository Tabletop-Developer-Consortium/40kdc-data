import type { GraphEdge, GraphNodeSummary } from "./api/types.js";

export type NodeTone = "neutral" | "good" | "warning" | "danger" | "subdued";

export interface EvidenceNodeData extends Record<string, unknown> {
  node: GraphNodeSummary;
  kindLabel: string;
  tone: NodeTone;
  knownKind: boolean;
  selected: boolean;
  related: boolean;
}

export interface EdgePresentation {
  label: string;
  knownKind: boolean;
  style: string;
  markerColor: string;
}

const NODE_LABELS: Record<string, string> = {
  source_snapshot: "Source snapshot",
  clause_map: "Clause map",
  mechanic_claim_graph: "Claim graph",
  source_formalization_certificate: "Formalization certificate",
  certified_ability_evidence: "Certified evidence",
  family_charter: "Family charter",
  mechanic_family_abstraction: "Family abstraction",
  construction_plan: "Construction plan",
  candidate_dsl: "Candidate DSL",
  finding: "Finding",
  check_result: "Check result",
  prototype_patch: "Prototype patch",
  certificate: "Certificate",
};

const EDGE_LABELS: Record<string, string> = {
  similar_mechanic: "Similar mechanic",
  generalizes: "Generalizes",
  specializes: "Specializes",
  derived_from: "Derived from",
  satisfies: "Satisfies",
  certified_by: "Certified by",
};

const EDGE_PATTERNS: Record<string, { dash: string; width: number; color: string }> = {
  similar_mechanic: { dash: "2 8", width: 1.2, color: "var(--dim)" },
  generalizes: { dash: "none", width: 1.8, color: "oklch(0.72 0.11 240)" },
  specializes: { dash: "3 4", width: 1.8, color: "oklch(0.72 0.09 315)" },
  derived_from: { dash: "8 4", width: 1.6, color: "var(--muted)" },
  satisfies: { dash: "none", width: 2, color: "var(--good)" },
  certified_by: { dash: "10 3 2 3", width: 2, color: "var(--good)" },
};

export function nodeKindLabel(kind: string): string {
  return NODE_LABELS[kind] ?? kind.replaceAll("_", " ");
}

export function edgeKindLabel(kind: string): string {
  return EDGE_LABELS[kind] ?? kind.replaceAll("_", " ");
}

export function nodeTone(node: GraphNodeSummary): NodeTone {
  const state = `${node.state ?? ""} ${node.validity ?? ""}`.toLowerCase();
  if (/(invalid|superseded|stale)/.test(state)) return "subdued";
  if (/(fail|rejected|blocked|error)/.test(state)) return "danger";
  if (/(warn|pending|provisional|open)/.test(state)) return "warning";
  if (/(valid|passed|certified|accepted|complete|converged)/.test(state)) return "good";
  return "neutral";
}

export function edgePresentation(edge: GraphEdge, highlighted: boolean): EdgePresentation {
  const pattern = EDGE_PATTERNS[edge.kind] ?? {
    dash: "5 5",
    width: 1.4,
    color: "var(--dim)",
  };
  const subdued = /(invalid|superseded|stale)/i.test(edge.state ?? "");
  const authorityOpacity: Record<GraphEdge["authority"], number> = {
    discovery: 0.34,
    provisional: 0.58,
    authoritative: 0.9,
    unknown: 0.46,
  };
  const opacity = subdued ? 0.2 : highlighted ? 1 : authorityOpacity[edge.authority];
  const color = highlighted ? "var(--accent)" : pattern.color;
  return {
    label: edgeKindLabel(edge.kind),
    knownKind: edge.kind in EDGE_LABELS,
    style: `stroke: ${color}; stroke-width: ${highlighted ? pattern.width + 0.8 : pattern.width}; stroke-dasharray: ${pattern.dash}; opacity: ${opacity}`,
    markerColor: color,
  };
}

export function isKnownNodeKind(kind: string): boolean {
  return kind in NODE_LABELS;
}
