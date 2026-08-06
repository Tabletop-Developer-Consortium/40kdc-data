import { MechanicGraphApiError } from "./api/client.js";
import type {
  CampaignProgress,
  CampaignSummary,
  FormalizationSummary,
  GlobalGraphSnapshot,
  GraphSnapshotQuery,
  GraphEdge,
  GraphEvent,
  GraphNodeSummary,
  MechanicGraphClient,
  NodeDetail,
  ProjectionEdge,
  ProjectionNode,
  ReviewItem,
  WorkflowProvenance,
} from "./api/types.js";
import { layoutInitial, type GraphPosition } from "./graph-layout.js";

export type ConnectionState = "loading" | "live" | "stale" | "error";
export type GraphScope = "trace" | "overview";
export type DockTab = "events" | "review" | "formalization";
export type MobileTab = "graph" | "inspector" | "activity";

export interface GraphFilters {
  search: string;
  nodeKinds: string[];
  states: string[];
  validities: string[];
  edgeKinds: string[];
  collapseCertified: boolean;
}

export interface ReviewDraft {
  optionId: string;
  rationale: string;
  submitting: boolean;
  awaitingDecisionNodeId: string | null;
  acceptedSequence: number | null;
  error: string | null;
}

export interface GraphRelationship {
  edge: GraphEdge;
  node: ProjectionNode;
}

const DEFAULT_FILTERS: GraphFilters = {
  search: "",
  nodeKinds: [],
  states: [],
  validities: [],
  edgeKinds: [],
  collapseCertified: false,
};
const EMPTY_FORMALIZATION: FormalizationSummary = {
  restriction: 0,
  timingOrder: 0,
  quantifier: 0,
  binding: 0,
  omissionInvention: 0,
  sourceExtraction: 0,
};
const BRANCH_KINDS = /(^|[-_])(run|check|finding)([-_]|$)/;
const TRACE_SUCCESSOR_LIMIT = 12;
const MAX_RENDERED_NODES = 400;

function messageFor(error: unknown): string {
  if (error instanceof MechanicGraphApiError) return `${error.code} (${error.status})`;
  return error instanceof Error ? error.message : "Graph request failed";
}

function graphNode(node: ProjectionNode): GraphNodeSummary {
  const statuses = Array.isArray(node.metadata.statuses)
    ? node.metadata.statuses.filter((value): value is string => typeof value === "string")
    : [];
  const provenance: WorkflowProvenance = {
    outputKind: typeof node.metadata.output_kind === "string" ? node.metadata.output_kind : null,
    taskId: typeof node.metadata.task_id === "string" ? node.metadata.task_id : null,
    attemptId: typeof node.metadata.attempt_id === "string" ? node.metadata.attempt_id : null,
    workflowStage: typeof node.metadata.workflow_stage === "string" ? node.metadata.workflow_stage : null,
    workflowTask: typeof node.metadata.workflow_task === "string" ? node.metadata.workflow_task : null,
    workflowRound: typeof node.metadata.workflow_round === "string" ? node.metadata.workflow_round : null,
    workflowLane: typeof node.metadata.workflow_lane === "string" ? node.metadata.workflow_lane : null,
    attemptNumber: typeof node.metadata.attempt_number === "number" ? node.metadata.attempt_number : null,
    lineageDistance: typeof node.metadata.lineage_distance === "number" ? node.metadata.lineage_distance : null,
  };
  const workflowSummary = [
    provenance.workflowTask,
    provenance.workflowLane,
    provenance.attemptNumber === null ? null : `attempt ${provenance.attemptNumber}`,
  ].filter(Boolean).join(" · ");
  return {
    nodeId: node.id,
    campaignId: node.campaign_refs.join(",") || "global",
    kind: node.kind.replaceAll("-", "_"),
    label: { value: node.label, classification: "identifier" },
    summary: {
      value: workflowSummary || `${node.scope} · ${node.ability_refs.length} ability reference${node.ability_refs.length === 1 ? "" : "s"}`,
      classification: "status",
    },
    state: statuses[0] ?? null,
    validity: node.metadata.metadata_status === "missing" ? "missing-metadata" : null,
    ...provenance,
  };
}

function graphEdge(edge: ProjectionEdge): GraphEdge {
  return {
    edgeId: edge.id,
    sourceNodeId: edge.source,
    targetNodeId: edge.target,
    kind: edge.kind.replaceAll("-", "_"),
    authority: edge.metadata.authorizes_reuse === true ? "authoritative" : "provisional",
    state: null,
  };
}

export class GraphStore {
  campaigns = $state<CampaignSummary[]>([]);
  campaign = $state<CampaignSummary | null>(null);
  nodes = $state<Map<string, GraphNodeSummary>>(new Map());
  edges = $state<Map<string, GraphEdge>>(new Map());
  positions = $state<Map<string, GraphPosition>>(new Map());
  events = $state<GraphEvent[]>([]);
  reviews = $state<ReviewItem[]>([]);
  formalization = $state<FormalizationSummary>({ ...EMPTY_FORMALIZATION });
  sequence = $state(0);
  checksum = $state("");
  connection = $state<ConnectionState>("loading");
  diagnostic = $state<string | null>(null);
  campaignProgress = $state<CampaignProgress[]>([]);
  selectedCampaignProgressId = $state<string | null>(null);
  campaignProgressStatus = $state<"loading" | "ready" | "error">("loading");
  activeCampaignGraphId = $state<string | null>(null);
  campaignProgressDiagnostic = $state<string | null>(null);
  hasProjection = $state(false);
  quarantined = $state(false);

  abilityIndex = $state<ProjectionNode[]>([]);
  selectedAbility = $state<ProjectionNode | null>(null);
  selectedProjectionNode = $state<ProjectionNode | null>(null);
  search = $state("");
  factionFilter = $state("");
  statusFilter = $state("");
  debouncedSearch = $state("");
  debouncedFaction = $state("");
  debouncedStatus = $state("");
  nextCursor = $state<string | null>(null);
  truncated = $state(false);
  loadingMore = $state(false);
  graphSearch = $state("");
  graphSearchResults = $state<ProjectionNode[]>([]);
  projectionNodeCount = $state(0);

  selectedNodeId = $state<string | null>(null);
  selectedEdgeId = $state<string | null>(null);
  traceAnchorId = $state<string | null>(null);
  selectedEventSequence = $state<number | null>(null);
  selectedReviewId = $state<string | null>(null);
  nodeDetail = $state<NodeDetail | null>(null);
  nodeDetailLoading = $state(false);
  nodeDetailError = $state<string | null>(null);
  filters = $state<GraphFilters>({ ...DEFAULT_FILTERS });
  graphScope = $state<GraphScope>("trace");
  viewport = $state({ x: 0, y: 0, zoom: 1 });
  inspectorWidth = $state(380);
  dockHeight = $state(36);
  activeDockTab = $state<DockTab>("events");
  mobileTab = $state<MobileTab>("graph");
  viewportWidth = $state(typeof window === "undefined" ? 1440 : window.innerWidth);
  reviewDrafts = $state<Record<string, ReviewDraft>>({});
  sourceEpoch = $state(0);
  centerRequest = $state<{ nodeId: string; token: number } | null>(null);
  fitRequest = $state(0);

  private abortController: AbortController | null = null;
  private campaignProgressAbortController: AbortController | null = null;
  private closeStream: (() => void) | null = null;
  private generation = 0;
  private stopped = true;
  private campaignProgressGeneration = 0;
  private filterTimer: number | null = null;
  private projectionNodes = new Map<string, ProjectionNode>();
  private projectionEdges = new Map<string, ProjectionEdge>();
  private expandedBranches = new Set<string>();

  constructor(private readonly client: MechanicGraphClient) {}

  get projectionIsStale(): boolean {
    return this.hasProjection && this.connection === "stale";
  }

  get selectedReview(): ReviewItem | null {
    return this.reviews.find((review) => review.reviewId === this.selectedReviewId) ?? null;
  }

  get selectedCampaignProgress(): CampaignProgress | null {
    return this.campaignProgress.find((campaign) => campaign.campaignId === this.selectedCampaignProgressId) ?? null;
  }

  get selectedEdge(): GraphEdge | null {
    return this.selectedEdgeId ? this.edges.get(this.selectedEdgeId) ?? null : null;
  }

  get selectedNode(): ProjectionNode | null {
    return this.selectedNodeId ? this.projectionNodes.get(this.selectedNodeId) ?? null : null;
  }

  get selectedEdgeSource(): ProjectionNode | null {
    return this.selectedEdge ? this.projectionNodes.get(this.selectedEdge.sourceNodeId) ?? null : null;
  }

  get selectedEdgeTarget(): ProjectionNode | null {
    return this.selectedEdge ? this.projectionNodes.get(this.selectedEdge.targetNodeId) ?? null : null;
  }

  get selectedEdgeOtherInputCount(): number {
    if (!this.selectedEdge) return 0;
    return [...this.projectionEdges.values()].filter(
      (edge) => edge.target === this.selectedEdge!.targetNodeId && edge.id !== this.selectedEdge!.edgeId,
    ).length;
  }

  get incomingRelationships(): GraphRelationship[] {
    if (!this.selectedNodeId) return [];
    return [...this.projectionEdges.values()]
      .filter((edge) => edge.target === this.selectedNodeId)
      .sort((left, right) => left.id.localeCompare(right.id))
      .flatMap((edge) => {
        const node = this.projectionNodes.get(edge.source);
        return node ? [{ edge: graphEdge(edge), node }] : [];
      });
  }

  get outgoingRelationships(): GraphRelationship[] {
    if (!this.selectedNodeId) return [];
    return [...this.projectionEdges.values()]
      .filter((edge) => edge.source === this.selectedNodeId)
      .sort((left, right) => left.id.localeCompare(right.id))
      .flatMap((edge) => {
        const node = this.projectionNodes.get(edge.target);
        return node ? [{ edge: graphEdge(edge), node }] : [];
      });
  }


  get traceBreadcrumbs(): ProjectionNode[] {
    const root = [...this.projectionNodes.values()].find((node) => node.kind === "mechanic-evidence-root");
    const targetId = this.traceAnchorId;
    if (!root || !targetId) return [];
    if (root.id === targetId) return [root];
    const outgoing = new Map<string, ProjectionEdge[]>();
    for (const edge of [...this.projectionEdges.values()].sort((left, right) => left.id.localeCompare(right.id))) {
      const values = outgoing.get(edge.source) ?? [];
      values.push(edge);
      outgoing.set(edge.source, values);
    }
    const previous = new Map<string, string>();
    const visited = new Set([root.id]);
    const queue = [root.id];
    while (queue.length > 0 && !visited.has(targetId)) {
      const nodeId = queue.shift()!;
      for (const edge of outgoing.get(nodeId) ?? []) {
        if (visited.has(edge.target)) continue;
        visited.add(edge.target);
        previous.set(edge.target, nodeId);
        queue.push(edge.target);
      }
    }
    if (!visited.has(targetId)) return [this.projectionNodes.get(targetId)].filter((node): node is ProjectionNode => Boolean(node));
    const ids = [targetId];
    while (ids[0] !== root.id) ids.unshift(previous.get(ids[0])!);
    return ids.map((id) => this.projectionNodes.get(id)).filter((node): node is ProjectionNode => Boolean(node));
  }


  get traceSuccessorCount(): number {
    if (!this.traceAnchorId) return 0;
    return [...this.projectionEdges.values()].filter((edge) => edge.source === this.traceAnchorId).length;
  }

  get traceHiddenSuccessorCount(): number {
    return Math.max(0, this.traceSuccessorCount - TRACE_SUCCESSOR_LIMIT);
  }

  get filteredAbilities(): ProjectionNode[] {
    const search = this.debouncedSearch.trim().toLowerCase();
    return this.abilityIndex.filter((ability) => {
      const faction = String(ability.metadata.faction_id ?? "");
      const statuses = Array.isArray(ability.metadata.statuses) ? ability.metadata.statuses : [];
      return (
        (!search || ability.label.toLowerCase().includes(search)) &&
        (!this.debouncedFaction || faction === this.debouncedFaction) &&
        (!this.debouncedStatus || statuses.includes(this.debouncedStatus))
      );
    });
  }

  get factions(): string[] {
    return [...new Set(this.abilityIndex.map((node) => String(node.metadata.faction_id ?? "")).filter(Boolean))].sort();
  }

  get statuses(): string[] {
    return [...new Set(this.abilityIndex.flatMap((node) => Array.isArray(node.metadata.statuses) ? node.metadata.statuses.filter((value): value is string => typeof value === "string") : []))].sort();
  }

  get renderedNodeCount(): number {
    return this.nodes.size;
  }

  async start(): Promise<void> {
    this.stop();
    this.stopped = false;
    this.connection = "loading";
    this.diagnostic = null;
    this.resetPagination();
    const generation = ++this.generation;
    this.abortController = new AbortController();
    void this.loadCampaignProgress();
    try {
      const snapshot = await this.client.getGraphSnapshot({ mode: "index", limit: 100 }, this.abortController.signal);
      if (this.stopped || generation !== this.generation) return;
      this.activateIndex(snapshot, false);
      this.connection = "live";
      this.openGraphStream({ mode: "index" }, "Graph changed. Refresh the index to continue.");
    } catch (error) {
      if (this.ignoreAbort(error, generation)) return;
      this.connection = "error";
      this.diagnostic = messageFor(error);
    }
  }
  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.campaignProgressAbortController?.abort();
    this.campaignProgressAbortController = null;
    this.campaignProgressGeneration += 1;
    this.abortController?.abort();
    this.closeStream?.();
    this.closeStream = null;
    clearTimeout(this.filterTimer ?? undefined);
  }

  setSearch(value: string): void {
    this.search = value;
    this.scheduleFilters();
  }

  setGraphSearch(value: string): void {
    this.graphSearch = value;
    const query = value.trim().toLowerCase();
    this.graphSearchResults = query
      ? [...this.projectionNodes.values()]
          .filter((node) => node.kind !== "mechanic-evidence-root")
          .filter((node) => [
            node.label,
            node.id,
            node.kind,
            node.metadata.output_kind,
            node.metadata.workflow_stage,
            node.metadata.workflow_task,
            node.metadata.workflow_lane,
            node.metadata.task_id,
          ].some((candidate) => typeof candidate === "string" && candidate.toLowerCase().includes(query)))
          .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
          .slice(0, 24)
      : [];
  }

  setFactionFilter(value: string): void {
    this.factionFilter = value;
    this.scheduleFilters();
  }

  setStatusFilter(value: string): void {
    this.statusFilter = value;
    this.scheduleFilters();
  }

  private scheduleFilters(): void {
    clearTimeout(this.filterTimer ?? undefined);
    this.filterTimer = setTimeout(() => {
      this.debouncedSearch = this.search;
      this.debouncedFaction = this.factionFilter;
      this.debouncedStatus = this.statusFilter;
      this.filterTimer = null;
    }, 150);
  }

  async loadMoreIndex(): Promise<void> {
    if (!this.nextCursor || this.loadingMore) return;
    this.loadingMore = true;
    const generation = ++this.generation;
    this.abortController?.abort();
    this.abortController = new AbortController();
    try {
      const snapshot = await this.client.getGraphSnapshot({ mode: "index", limit: 100, after: this.nextCursor }, this.abortController.signal);
      if (this.stopped || generation !== this.generation) return;
      this.activateIndex(snapshot, true);
      this.connection = "live";
    } catch (error) {
      if (this.ignoreAbort(error, generation)) return;
      this.handleFetchError(error);
    } finally {
      if (generation === this.generation) this.loadingMore = false;
    }
  }

  async selectAbility(ability: ProjectionNode): Promise<void> {
    const factionId = String(ability.metadata.faction_id ?? "");
    const abilityId = String(ability.metadata.ability_id ?? "");
    if (!factionId || !abilityId) return;
    this.graphScope = "trace";
    this.graphSearch = "";
    this.graphSearchResults = [];
    this.traceAnchorId = null;
    this.selectedEdgeId = null;
    this.selectedAbility = ability;
    this.selectedNodeId = null;
    this.selectedProjectionNode = null;
    this.expandedBranches = new Set();
    this.closeStream?.();
    this.closeStream = null;
    this.abortController?.abort();
    const generation = ++this.generation;
    this.abortController = new AbortController();
    this.connection = "loading";
    this.diagnostic = null;
    this.clearRenderedProjection();
    this.resetPagination();
    try {
      const snapshot = await this.client.getGraphSnapshot({ mode: "ability", faction_id: factionId, ability_id: abilityId, limit: 150, depth: 4 }, this.abortController.signal);
      if (this.stopped || generation !== this.generation) return;
      this.activateAbility(snapshot, false);
      this.connection = "live";
      this.openGraphStream(
        { mode: "ability", faction_id: factionId, ability_id: abilityId },
        "Selected evidence changed. Retry to load the current revision.",
      );
    } catch (error) {
      if (this.ignoreAbort(error, generation)) return;
      this.handleFetchError(error);
    }
  }

  async loadMoreEvidence(): Promise<void> {
    if ((!this.selectedAbility && !this.activeCampaignGraphId) || !this.nextCursor || this.loadingMore) return;
    const query: GraphSnapshotQuery = this.selectedAbility
      ? {
          mode: "ability",
          faction_id: String(this.selectedAbility.metadata.faction_id),
          ability_id: String(this.selectedAbility.metadata.ability_id),
          limit: 150,
          depth: 4,
          after: this.nextCursor,
        }
      : { mode: "campaign", campaign_id: this.activeCampaignGraphId!, limit: 400, depth: 4, after: this.nextCursor };
    this.loadingMore = true;
    const generation = ++this.generation;
    this.abortController?.abort();
    this.abortController = new AbortController();
    try {
      const snapshot = await this.client.getGraphSnapshot(query, this.abortController.signal);
      if (this.stopped || generation !== this.generation) return;
      if (this.selectedAbility) this.activateAbility(snapshot, true);
      else this.activateCampaign(snapshot, true);
      this.connection = "live";
    } catch (error) {
      if (this.ignoreAbort(error, generation)) return;
      this.handleFetchError(error);
    } finally {
      if (generation === this.generation) this.loadingMore = false;
    }
  }

  toggleBranch(nodeId: string): void {
    if (this.expandedBranches.has(nodeId)) this.expandedBranches.delete(nodeId);
    else this.expandedBranches.add(nodeId);
    this.expandedBranches = new Set(this.expandedBranches);
    this.applyVisibleProjection();
  }

  isBranch(node: ProjectionNode): boolean {
    return BRANCH_KINDS.test(node.kind);
  }

  isBranchExpanded(nodeId: string): boolean {
    return this.expandedBranches.has(nodeId);
  }

  async retry(): Promise<void> {
    if (this.selectedAbility) {
      void this.loadCampaignProgress();
      await this.selectAbility(this.selectedAbility);
    } else if (this.activeCampaignGraphId) {
      void this.loadCampaignProgress();
      await this.selectCampaign(this.activeCampaignGraphId);
    } else {
      await this.start();
    }
  }

  async refreshContext(): Promise<void> { await this.retry(); }

  private activateIndex(snapshot: GlobalGraphSnapshot, append: boolean): void {
    const abilities = snapshot.nodes.filter((node) => node.kind === "ability");
    const merged = append ? new Map(this.abilityIndex.map((node) => [node.id, node])) : new Map<string, ProjectionNode>();
    for (const ability of abilities) merged.set(ability.id, ability);
    this.abilityIndex = [...merged.values()];
    this.checksum = snapshot.graph_revision;
    this.nextCursor = snapshot.page.next_cursor;
    this.truncated = snapshot.page.truncated;
    this.hasProjection = true;
  }

  private activateAbility(snapshot: GlobalGraphSnapshot, append: boolean): void {
    const nodes = append ? new Map(this.projectionNodes) : new Map<string, ProjectionNode>();
    const edges = append ? new Map(this.projectionEdges) : new Map<string, ProjectionEdge>();
    for (const node of snapshot.nodes) nodes.set(node.id, node);
    for (const edge of snapshot.edges) edges.set(edge.id, edge);
    this.projectionNodes = new Map([...nodes].slice(0, MAX_RENDERED_NODES));
    this.projectionNodeCount = this.projectionNodes.size;
    const allowed = new Set(this.projectionNodes.keys());
    this.projectionEdges = new Map([...edges].filter(([, edge]) => allowed.has(edge.source) && allowed.has(edge.target)));
    this.checksum = snapshot.graph_revision;
    this.nextCursor = snapshot.page.next_cursor;
    this.truncated = snapshot.page.truncated || nodes.size > MAX_RENDERED_NODES;
    if (!append) {
      this.traceAnchorId = snapshot.root;
      this.selectedNodeId = snapshot.root;
      this.selectedProjectionNode = this.projectionNodes.get(snapshot.root) ?? null;
    }
    this.hasProjection = true;
    this.applyVisibleProjection();
  }

  private activateCampaign(snapshot: GlobalGraphSnapshot, append: boolean): void {
    const abilities = snapshot.nodes.filter((node) => node.kind === "ability");
    const merged = append ? new Map(this.abilityIndex.map((node) => [node.id, node])) : new Map<string, ProjectionNode>();
    for (const ability of abilities) merged.set(ability.id, ability);
    this.abilityIndex = [...merged.values()];
    this.activateAbility(snapshot, append);
  }

  private clearRenderedProjection(): void {
    this.nodes = new Map();
    this.edges = new Map();
    this.positions = new Map();
    this.projectionNodeCount = 0;
  }

  private resetPagination(): void {
    this.nextCursor = null;
    this.truncated = false;
    this.loadingMore = false;
  }

  private applyVisibleProjection(): void {
    const root = [...this.projectionNodes.values()].find((node) => node.kind === "mechanic-evidence-root");
    if (!root) {
      this.nodes = new Map();
      this.edges = new Map();
      this.positions = new Map();
      return;
    }
    const visible = new Set<string>();
    if (this.graphScope === "overview") {
      for (const nodeId of this.projectionNodes.keys()) visible.add(nodeId);
    } else {
      const anchorId = this.traceAnchorId && this.projectionNodes.has(this.traceAnchorId)
        ? this.traceAnchorId
        : root.id;
      this.traceAnchorId = anchorId;
      const incoming = new Map<string, ProjectionEdge[]>();
      const outgoing = new Map<string, ProjectionEdge[]>();
      for (const edge of [...this.projectionEdges.values()].sort((left, right) => left.id.localeCompare(right.id))) {
        const parents = incoming.get(edge.target) ?? [];
        parents.push(edge);
        incoming.set(edge.target, parents);
        const children = outgoing.get(edge.source) ?? [];
        children.push(edge);
        outgoing.set(edge.source, children);
      }
      const ancestors = [anchorId];
      while (ancestors.length > 0 && visible.size < MAX_RENDERED_NODES) {
        const nodeId = ancestors.shift()!;
        if (visible.has(nodeId)) continue;
        visible.add(nodeId);
        for (const edge of incoming.get(nodeId) ?? []) ancestors.push(edge.source);
      }
      for (const edge of (outgoing.get(anchorId) ?? []).slice(0, TRACE_SUCCESSOR_LIMIT)) {
        visible.add(edge.target);
      }
      visible.add(root.id);
    }
    const nodes = [...visible]
      .map((id) => this.projectionNodes.get(id))
      .filter((node): node is ProjectionNode => Boolean(node));
    const edges = [...this.projectionEdges.values()].filter(
      (edge) => visible.has(edge.source) && visible.has(edge.target),
    );
    this.nodes = new Map(nodes.map((node) => [node.id, graphNode(node)]));
    this.edges = new Map(edges.map((edge) => [edge.id, graphEdge(edge)]));
    this.positions = layoutInitial(this.nodes.values(), this.edges.values());
    this.fitRequest += 1;
  }

  private openGraphStream(
    query: Omit<GraphSnapshotQuery, "after" | "limit" | "depth">,
    staleDiagnostic: string,
  ): void {
    this.closeStream?.();
    this.closeStream = this.client.openGraphStream(query, (notice) => {
      if (notice.graph_revision !== this.checksum) {
        this.connection = "stale";
        this.diagnostic = staleDiagnostic;
      }
    }, () => {
      if (!this.stopped) this.connection = this.hasProjection ? "stale" : "error";
    });
  }

  private async loadCampaignProgress(): Promise<void> {
    this.campaignProgressAbortController?.abort();
    const controller = new AbortController();
    this.campaignProgressAbortController = controller;
    const generation = ++this.campaignProgressGeneration;
    this.campaignProgressStatus = "loading";
    this.campaignProgressDiagnostic = null;
    try {
      const campaigns = await this.client.getCampaignProgress(controller.signal);
      if (this.stopped || generation !== this.campaignProgressGeneration) return;
      const selectedId = this.selectedCampaignProgressId;
      this.campaignProgress = campaigns;
      this.selectedCampaignProgressId = campaigns.some((campaign) => campaign.campaignId === selectedId)
        ? selectedId
        : campaigns[0]?.campaignId ?? null;
      this.campaignProgressStatus = "ready";
    } catch (error) {
      if (this.stopped || generation !== this.campaignProgressGeneration || (error instanceof DOMException && error.name === "AbortError")) return;
      this.campaignProgressStatus = "error";
      this.campaignProgressDiagnostic = messageFor(error);
    }
  }

  private ignoreAbort(error: unknown, generation: number): boolean {
    return this.stopped || generation !== this.generation || (error instanceof DOMException && error.name === "AbortError");
  }

  private handleFetchError(error: unknown): void {
    this.connection = error instanceof MechanicGraphApiError && error.status === 409 ? "stale" : "error";
    this.diagnostic = messageFor(error);
  }

  selectNode(nodeId: string): void {
    const node = this.projectionNodes.get(nodeId);
    if (!node) return;
    if (
      this.selectedNodeId === nodeId &&
      this.selectedEdgeId === null &&
      this.traceAnchorId === nodeId
    ) {
      return;
    }
    this.selectedNodeId = nodeId;
    this.selectedEdgeId = null;
    this.traceAnchorId = nodeId;
    this.selectedProjectionNode = node;
    if (this.graphScope === "trace") this.applyVisibleProjection();
  }

  selectEdge(edgeId: string): void {
    const edge = this.projectionEdges.get(edgeId);
    if (!edge) return;
    if (
      this.selectedEdgeId === edgeId &&
      this.selectedNodeId === null &&
      this.traceAnchorId === edge.target
    ) {
      return;
    }
    this.selectedEdgeId = edgeId;
    this.selectedNodeId = null;
    this.traceAnchorId = edge.target;
    this.selectedProjectionNode = null;
    if (this.graphScope === "trace") this.applyVisibleProjection();
  }

  focusTraceNode(nodeId: string): void {
    if (!this.projectionNodes.has(nodeId)) return;
    this.graphScope = "trace";
    this.graphSearch = "";
    this.graphSearchResults = [];
    this.selectNode(nodeId);
    this.centerNode(nodeId);
  }
  setViewportWidth(width: number): void {
    const nextWidth = Math.round(width);
    if (!Number.isFinite(nextWidth) || nextWidth === this.viewportWidth) return;
    this.viewportWidth = nextWidth;
    if (this.hasProjection) this.fitRequest += 1;
  }
  setFilters(filters: GraphFilters): void { this.filters = filters; }
  resetFilters(): void { this.filters = { ...DEFAULT_FILTERS }; }
  resetLayout(): void { this.positions = layoutInitial(this.nodes.values(), this.edges.values()); this.fitRequest += 1; }
  centerNode(nodeId: string): void { this.centerRequest = { nodeId, token: Date.now() }; }
  setDockHeight(height: number): void { this.dockHeight = Math.max(36, Math.min(420, height)); }
  toggleDock(): void { this.dockHeight = this.dockHeight === 36 ? 260 : 36; }
  expandDock(): void { if (this.dockHeight === 36) this.dockHeight = 260; }
  setInspectorWidth(width: number): void { this.inspectorWidth = Math.max(300, Math.min(620, width)); }
  async selectCampaign(campaignId: string): Promise<void> {
    if (!this.campaignProgress.some((campaign) => campaign.campaignId === campaignId)) return;
    this.selectedCampaignProgressId = campaignId;
    this.graphScope = "trace";
    this.graphSearch = "";
    this.graphSearchResults = [];
    this.traceAnchorId = null;
    this.selectedEdgeId = null;
    this.activeCampaignGraphId = campaignId;
    this.selectedAbility = null;
    this.selectedNodeId = null;
    this.selectedProjectionNode = null;
    this.expandedBranches = new Set();
    this.closeStream?.();
    this.closeStream = null;
    this.abortController?.abort();
    const generation = ++this.generation;
    this.abortController = new AbortController();
    this.connection = "loading";
    this.diagnostic = null;
    this.clearRenderedProjection();
    this.resetPagination();
    try {
      const snapshot = await this.client.getGraphSnapshot(
        { mode: "campaign", campaign_id: campaignId, limit: 400, depth: 4 },
        this.abortController.signal,
      );
      if (this.stopped || generation !== this.generation) return;
      this.activateCampaign(snapshot, false);
      this.connection = "live";
      this.openGraphStream(
        { mode: "campaign", campaign_id: campaignId },
        "Campaign evidence changed. Retry to load the current revision.",
      );
    } catch (error) {
      if (this.ignoreAbort(error, generation)) return;
      this.handleFetchError(error);
    }
  }

  async showGlobalGraph(): Promise<void> {
    this.graphScope = "trace";
    this.activeCampaignGraphId = null;
    this.selectedAbility = null;
    this.selectedNodeId = null;
    this.selectedProjectionNode = null;
    this.projectionNodes = new Map();
    this.projectionEdges = new Map();
    this.clearRenderedProjection();
    await this.start();
  }

  selectCampaignProgress(campaignId: string): void {
    if (this.campaignProgress.some((campaign) => campaign.campaignId === campaignId)) {
      this.selectedCampaignProgressId = campaignId;
    }
  }
  setGraphScope(scope: GraphScope): void {
    if (scope === this.graphScope) return;
    this.graphScope = scope;
    this.applyVisibleProjection();
  }
  canSubmitReview(_review: ReviewItem): boolean { return false; }
  updateDraft(reviewId: string, patch: Partial<ReviewDraft>): void {
    const current = this.reviewDrafts[reviewId] ?? { optionId: "", rationale: "", submitting: false, awaitingDecisionNodeId: null, acceptedSequence: null, error: null };
    this.reviewDrafts = { ...this.reviewDrafts, [reviewId]: { ...current, ...patch } };
  }
  selectEvent(event: GraphEvent | number): void { this.selectedEventSequence = typeof event === "number" ? event : event.sequence; }
  selectReview(review: ReviewItem | string): void { this.selectedReviewId = typeof review === "string" ? review : review.reviewId; }
  requestFit(): void { this.fitRequest += 1; }
  async submitReview(_review: ReviewItem): Promise<void> {}
}

export function createGraphStore(client: MechanicGraphClient): GraphStore {
  return new GraphStore(client);
}
