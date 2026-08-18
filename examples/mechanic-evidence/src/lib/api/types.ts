export interface BrowserSafeText {
  value: string;
  classification: "identifier" | "status" | "community-authored";
}

export interface CampaignSummary {
  campaignId: string;
  runId: string;
  state: string;
  terminalWorklist: number;
  worklistSize: number;
  outcomes: {
    converged: number;
    improved: number;
    needsSchema: number;
    abandoned: number;
    inProgress: number;
    pending: number;
  };
  knownTasks: { completed: number; total: number; denominator: "dynamic" };
  activeTasks: number;
  blockingDecisions: number;
  openFindings: number;
  currentVersionChecks: { passed: number; total: number };
  shapeRound: { current: number; maximum: number } | null;
  lastSequence: number;
  lastEventAt: string | null;
  updatedAt: string;
}

export interface CampaignProgress {
  runId: string;
  campaignId: string;
  state: string;
  kind: string | null;
  target: string | null;
  started: string | null;
  finished: string | null;
  taskStates: Record<string, number>;
  taskTotal: number;
  claimStates: Record<string, number>;
  claimTotal: number;
  findingStates: Record<string, number>;
  findingTotal: number;
  checkStates: Record<string, number>;
  checkTotal: number;
}


export interface GraphNodeSummary extends WorkflowProvenance {
  nodeId: string;
  campaignId: string;
  kind: string;
  label: BrowserSafeText;
  summary: BrowserSafeText | null;
  state: string | null;
  validity: string | null;
}

export interface WorkflowProvenance {
  outputKind?: string | null;
  taskId?: string | null;
  attemptId?: string | null;
  workflowStage?: string | null;
  workflowTask?: string | null;
  workflowRound?: string | null;
  workflowLane?: string | null;
  attemptNumber?: number | null;
  lineageDistance?: number | null;
}

export interface GraphEdge {
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: string;
  authority: "discovery" | "provisional" | "authoritative" | "unknown";
  state: string | null;
}

export interface GraphSnapshot {
  contractVersion: 1;
  campaign: CampaignSummary;
  sequence: number;
  projectionChecksum: string;
  nodes: GraphNodeSummary[];
  edges: GraphEdge[];
}

export interface ProjectionDelta {
  contractVersion: 1;
  fromSequence: number;
  throughSequence: number;
  projectionChecksum: string;
  campaign: CampaignSummary;
  upsertNodes: GraphNodeSummary[];
  removeNodeIds: string[];
  upsertEdges: GraphEdge[];
  removeEdgeIds: string[];
  events: GraphEvent[];
  reviewQueue: ReviewItem[];
  formalization: FormalizationSummary;
  status?: string;
}

export interface ReviewDecisionInput {
  reviewId: string;
  optionId: string;
  rationale: string;
  affectedNodeIds: string[];
  precondition: { sequence: number; projectionChecksum: string };
  clientRequestId: string;
}

export interface InspectorRecord {
  recordId: string;
  kind: string;
  state: string | null;
  label: BrowserSafeText;
  fields: Array<{ name: string; value: BrowserSafeText }>;
}

export interface NodeDetail extends GraphNodeSummary {
  contentHash: string;
  lineageHash: string;
  versions: Array<{ name: string; value: BrowserSafeText }>;
  parentEdges: GraphEdge[];
  childEdges: GraphEdge[];
  leases: InspectorRecord[];
  checkpoints: InspectorRecord[];
  findings: InspectorRecord[];
  checks: InspectorRecord[];
  invalidationReasons: BrowserSafeText[];
}

export interface GraphEvent {
  sequence: number;
  eventId: string;
  type: string;
  category: string;
  occurredAt: string;
  affectedNodeIds: string[];
  summary: BrowserSafeText;
  projectionChecksum: string;
}

export type ReviewKind =
  | "formalization-exception"
  | "blocking-decision"
  | "apply-reconciliation";

export interface ReviewItem {
  reviewId: string;
  kind: ReviewKind;
  state: string;
  title: BrowserSafeText;
  summary: BrowserSafeText;
  options: Array<{
    optionId: string;
    label: BrowserSafeText;
    description: BrowserSafeText;
  }>;
  affectedNodeIds: string[];
  capabilities: { canSubmit: boolean; canLoadSource: boolean };
  precondition: { sequence: number; projectionChecksum: string };
}

export interface FormalizationSummary {
  restriction: number;
  timingOrder: number;
  quantifier: number;
  binding: number;
  omissionInvention: number;
  sourceExtraction: number;
}

export interface AuthorizedSourceExcerpt {
  reviewId: string;
  clauseId: string;
  text: string;
  expiresAt: string;
}

export interface CommitNotice {
  sequence: number;
  projectionChecksum: string;
}

export interface DecisionReceipt {
  decisionNodeId: string;
  acceptedSequence: number;
  projectionChecksum: string;
}

export interface AbilityReference {
  faction_id: string;
  ability_id: string;
  label: string;
  metadata_status: "current" | "missing";
  source_kind: string;
  distance: number;
}

export interface ProjectionNodeMetadata extends Record<string, unknown> {
  output_kind?: string;
  task_id?: string;
  attempt_id?: string;
  workflow_stage?: string;
  workflow_task?: string;
  workflow_round?: string;
  workflow_lane?: string;
  attempt_number?: number;
  lineage_distance?: number;
}

export interface ProjectionNode {
  id: string;
  kind: string;
  label: string;
  scope: "global" | "ability" | "family";
  ability_refs: AbilityReference[];
  campaign_refs: string[];
  metadata: ProjectionNodeMetadata;
}

export interface ProjectionEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  metadata: Record<string, unknown>;
}

export interface GlobalGraphSnapshot {
  graph_revision: string;
  root: string;
  nodes: ProjectionNode[];
  edges: ProjectionEdge[];
  page: { next_cursor: string | null; truncated: boolean };
  filters: {
    mode: "index" | "ability" | "campaign";
    faction_id: string | null;
    ability_id: string | null;
    campaign_id: string | null;
    depth?: number;
  };
}

export interface GraphSnapshotQuery {
  mode: "index" | "ability" | "campaign";
  faction_id?: string;
  ability_id?: string;
  campaign_id?: string;
  after?: string;
  limit?: number;
  depth?: number;
}

export interface GraphInvalidation {
  graph_revision: string;
  through: number;
  affected_ability_ids: Array<{ faction_id: string; ability_id: string }>;
  page: { next_cursor: string | null; truncated: boolean };
}

export interface MechanicGraphClient {
  getCampaignProgress(signal?: AbortSignal): Promise<CampaignProgress[]>;
  getGraphSnapshot(query: GraphSnapshotQuery, signal?: AbortSignal): Promise<GlobalGraphSnapshot>;
  getGraphUpdates(
    query: Omit<GraphSnapshotQuery, "after" | "depth">,
    since: number,
    signal?: AbortSignal,
  ): Promise<GraphInvalidation>;
  getReviewSource(reviewId: string, signal?: AbortSignal): Promise<AuthorizedSourceExcerpt>;
  submitDecision(
    input: ReviewDecisionInput,
    signal?: AbortSignal,
  ): Promise<DecisionReceipt>;
  openGraphStream(
    query: Omit<GraphSnapshotQuery, "after" | "limit" | "depth">,
    onCommit: (notice: Pick<GraphInvalidation, "graph_revision" | "affected_ability_ids">) => void,
    onDisconnect: () => void,
  ): () => void;
}

export const KNOWN_NODE_KINDS = [
  "source_snapshot",
  "clause_map",
  "mechanic_claim_graph",
  "source_formalization_certificate",
  "certified_ability_evidence",
  "family_charter",
  "mechanic_family_abstraction",
  "construction_plan",
  "candidate_dsl",
  "finding",
  "check_result",
  "prototype_patch",
  "certificate",
  "workflow_output",
  "ability",
  "mechanic_evidence_root",
] as const;

export const KNOWN_EDGE_KINDS = [
  "similar_mechanic",
  "generalizes",
  "specializes",
  "derived_from",
  "satisfies",
  "certified_by",
  "evidence",
  "contains",
] as const;

export function knownNodeKind(kind: string): boolean {
  return (KNOWN_NODE_KINDS as readonly string[]).includes(kind);
}

export function knownEdgeKind(kind: string): boolean {
  return (KNOWN_EDGE_KINDS as readonly string[]).includes(kind);
}
