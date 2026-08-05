import { MechanicGraphApiError } from "./api/client.js";
import type {
  CampaignSummary,
  FormalizationSummary,
  GlobalGraphSnapshot,
  GraphEdge,
  GraphEvent,
  GraphNodeSummary,
  MechanicGraphClient,
  NodeDetail,
  ProjectionEdge,
  ProjectionNode,
  ReviewItem,
} from "./api/types.js";
import { layoutInitial, type GraphPosition } from "./graph-layout.js";

export type ConnectionState = "loading" | "live" | "stale" | "error";
export type GraphScope = "critical-path" | "campaign";
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
const MAX_RENDERED_NODES = 400;

function messageFor(error: unknown): string {
  if (error instanceof MechanicGraphApiError) return `${error.code} (${error.status})`;
  return error instanceof Error ? error.message : "Graph request failed";
}

function graphNode(node: ProjectionNode): GraphNodeSummary {
  const statuses = Array.isArray(node.metadata.statuses)
    ? node.metadata.statuses.filter((value): value is string => typeof value === "string")
    : [];
  return {
    nodeId: node.id,
    campaignId: node.campaign_refs.join(",") || "global",
    kind: node.kind.replaceAll("-", "_"),
    label: { value: node.label, classification: "identifier" },
    summary: {
      value: `${node.scope} · ${node.ability_refs.length} ability reference${node.ability_refs.length === 1 ? "" : "s"}`,
      classification: "status",
    },
    state: statuses[0] ?? null,
    validity: node.metadata.metadata_status === "missing" ? "missing-metadata" : null,
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

  selectedNodeId = $state<string | null>(null);
  selectedEdgeId = $state<string | null>(null);
  selectedEventSequence = $state<number | null>(null);
  selectedReviewId = $state<string | null>(null);
  nodeDetail = $state<NodeDetail | null>(null);
  nodeDetailLoading = $state(false);
  nodeDetailError = $state<string | null>(null);
  filters = $state<GraphFilters>({ ...DEFAULT_FILTERS });
  graphScope = $state<GraphScope>("critical-path");
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
  private closeStream: (() => void) | null = null;
  private generation = 0;
  private stopped = true;
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

  get selectedEdge(): GraphEdge | null {
    return this.selectedEdgeId ? this.edges.get(this.selectedEdgeId) ?? null : null;
  }

  get selectedNode(): ProjectionNode | null {
    return this.selectedNodeId ? this.projectionNodes.get(this.selectedNodeId) ?? null : null;
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
    const generation = ++this.generation;
    this.abortController = new AbortController();
    try {
      const snapshot = await this.client.getGraphSnapshot({ mode: "index", limit: 100 }, this.abortController.signal);
      if (this.stopped || generation !== this.generation) return;
      this.activateIndex(snapshot, false);
      this.connection = "live";
      this.openIndexStream();
    } catch (error) {
      if (this.ignoreAbort(error, generation)) return;
      this.connection = "error";
      this.diagnostic = messageFor(error);
    }
  }
  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.closeStream?.();
    this.closeStream = null;
    clearTimeout(this.filterTimer ?? undefined);
  }

  setSearch(value: string): void {
    this.search = value;
    this.scheduleFilters();
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
    this.nodes = new Map();
    this.edges = new Map();
    this.positions = new Map();
    try {
      const snapshot = await this.client.getGraphSnapshot({ mode: "ability", faction_id: factionId, ability_id: abilityId, limit: 150, depth: 4 }, this.abortController.signal);
      if (this.stopped || generation !== this.generation) return;
      this.activateAbility(snapshot, false);
      this.connection = "live";
      this.openAbilityStream(factionId, abilityId);
    } catch (error) {
      if (this.ignoreAbort(error, generation)) return;
      this.handleFetchError(error);
    }
  }

  async loadMoreEvidence(): Promise<void> {
    if (!this.selectedAbility || !this.nextCursor || this.loadingMore) return;
    const factionId = String(this.selectedAbility.metadata.faction_id);
    const abilityId = String(this.selectedAbility.metadata.ability_id);
    this.loadingMore = true;
    const generation = ++this.generation;
    this.abortController?.abort();
    this.abortController = new AbortController();
    try {
      const snapshot = await this.client.getGraphSnapshot({ mode: "ability", faction_id: factionId, ability_id: abilityId, limit: 150, depth: 4, after: this.nextCursor }, this.abortController.signal);
      if (this.stopped || generation !== this.generation) return;
      this.activateAbility(snapshot, true);
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
    if (this.selectedAbility) await this.selectAbility(this.selectedAbility);
    else await this.start();
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
    const allowed = new Set(this.projectionNodes.keys());
    this.projectionEdges = new Map([...edges].filter(([, edge]) => allowed.has(edge.source) && allowed.has(edge.target)));
    this.checksum = snapshot.graph_revision;
    this.nextCursor = snapshot.page.next_cursor;
    this.truncated = snapshot.page.truncated || nodes.size > MAX_RENDERED_NODES;
    this.hasProjection = true;
    this.applyVisibleProjection();
  }

  private applyVisibleProjection(): void {
    const root = [...this.projectionNodes.values()].find((node) => node.kind === "mechanic-evidence-root");
    if (!root) {
      this.nodes = new Map();
      this.edges = new Map();
      this.positions = new Map();
      return;
    }
    const outgoing = new Map<string, ProjectionEdge[]>();
    for (const edge of this.projectionEdges.values()) {
      const values = outgoing.get(edge.source) ?? [];
      values.push(edge);
      outgoing.set(edge.source, values);
    }
    const visible = new Set<string>();
    const queue = [root.id];
    while (queue.length && visible.size < MAX_RENDERED_NODES) {
      const nodeId = queue.shift()!;
      if (visible.has(nodeId)) continue;
      visible.add(nodeId);
      const node = this.projectionNodes.get(nodeId);
      if (node && this.isBranch(node) && !this.expandedBranches.has(nodeId)) continue;
      for (const edge of outgoing.get(nodeId) ?? []) queue.push(edge.target);
    }
    const nodes = [...visible].map((id) => this.projectionNodes.get(id)).filter((node): node is ProjectionNode => Boolean(node));
    const edges = [...this.projectionEdges.values()].filter((edge) => visible.has(edge.source) && visible.has(edge.target));
    this.nodes = new Map(nodes.map((node) => [node.id, graphNode(node)]));
    this.edges = new Map(edges.map((edge) => [edge.id, graphEdge(edge)]));
    this.positions = layoutInitial(this.nodes.values(), this.edges.values());
    this.fitRequest += 1;
  }

  private openIndexStream(): void {
    this.closeStream?.();
    this.closeStream = this.client.openGraphStream({ mode: "index" }, (notice) => {
      if (notice.graph_revision !== this.checksum) {
        this.connection = "stale";
        this.diagnostic = "Graph changed. Refresh the index to continue.";
      }
    }, () => {
      if (!this.stopped) this.connection = this.hasProjection ? "stale" : "error";
    });
  }

  private openAbilityStream(factionId: string, abilityId: string): void {
    this.closeStream?.();
    this.closeStream = this.client.openGraphStream({ mode: "ability", faction_id: factionId, ability_id: abilityId }, (notice) => {
      if (notice.graph_revision !== this.checksum) {
        this.connection = "stale";
        this.diagnostic = "Selected evidence changed. Retry to load the current revision.";
      }
    }, () => {
      if (!this.stopped) this.connection = this.hasProjection ? "stale" : "error";
    });
  }

  private ignoreAbort(error: unknown, generation: number): boolean {
    return this.stopped || generation !== this.generation || (error instanceof DOMException && error.name === "AbortError");
  }

  private handleFetchError(error: unknown): void {
    this.connection = error instanceof MechanicGraphApiError && error.status === 409 ? "stale" : "error";
    this.diagnostic = messageFor(error);
  }

  selectNode(nodeId: string): void {
    this.selectedNodeId = nodeId;
    this.selectedEdgeId = null;
    this.selectedProjectionNode = this.projectionNodes.get(nodeId) ?? null;
  }
  selectEdge(edgeId: string): void { this.selectedEdgeId = edgeId; this.selectedNodeId = null; }
  setViewport(value: { x: number; y: number; zoom: number }): void { this.viewport = value; }
  setViewportWidth(width: number): void { this.viewportWidth = width; }
  setFilters(filters: GraphFilters): void { this.filters = filters; }
  resetFilters(): void { this.filters = { ...DEFAULT_FILTERS }; }
  resetLayout(): void { this.positions = layoutInitial(this.nodes.values(), this.edges.values()); this.fitRequest += 1; }
  centerNode(nodeId: string): void { this.centerRequest = { nodeId, token: Date.now() }; }
  setDockHeight(height: number): void { this.dockHeight = Math.max(36, Math.min(420, height)); }
  toggleDock(): void { this.dockHeight = this.dockHeight === 36 ? 260 : 36; }
  expandDock(): void { if (this.dockHeight === 36) this.dockHeight = 260; }
  setInspectorWidth(width: number): void { this.inspectorWidth = Math.max(300, Math.min(620, width)); }
  async selectCampaign(_campaignId: string): Promise<void> {}
  async setGraphScope(scope: GraphScope): Promise<void> { this.graphScope = scope; }
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
