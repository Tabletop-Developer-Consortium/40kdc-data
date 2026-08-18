import { describe, expect, it, vi } from "vitest";
import { MechanicGraphApiError } from "./api/client.js";
import type {
  AuthorizedSourceExcerpt,
  CampaignProgress,
  DecisionReceipt,
  GlobalGraphSnapshot,
  GraphInvalidation,
  GraphSnapshotQuery,
  MechanicGraphClient,
  ProjectionNode,
  ReviewDecisionInput,
} from "./api/types.js";
import { createGraphStore } from "./graph-store.svelte.js";

function root(): ProjectionNode {
  return { id: "root:mechanic-evidence", kind: "mechanic-evidence-root", label: "Mechanic Evidence", scope: "global", ability_refs: [], campaign_refs: [], metadata: {} };
}

function ability(id: string, faction = "fabricated-faction"): ProjectionNode {
  return {
    id: `ability:${faction}:${id}`,
    kind: "ability",
    label: `${id} — Fabricated Faction (${faction}) · ${id}`,
    scope: "ability",
    ability_refs: [{ faction_id: faction, ability_id: id, label: id, metadata_status: "current", source_kind: "catalog", distance: 0 }],
    campaign_refs: [],
    metadata: { faction_id: faction, ability_id: id, statuses: ["certified"], evidence_count: 1 },
  };
}

function indexSnapshot(): GlobalGraphSnapshot {
  const abilities = [ability("alpha"), ability("beta")];
  return {
    graph_revision: "revision-index",
    root: root().id,
    nodes: [root(), ...abilities],
    edges: abilities.map((node) => ({ id: `edge:${node.id}`, source: root().id, target: node.id, kind: "contains", metadata: {} })),
    page: { next_cursor: null, truncated: false },
    filters: { mode: "index", faction_id: null, ability_id: null, campaign_id: null },
  };
}

function abilitySnapshot(id: string, count = 1, cursor: string | null = null): GlobalGraphSnapshot {
  const selected = ability(id);
  const evidence = Array.from({ length: count }, (_, index): ProjectionNode => ({
    id: `${id}-finding-${index}`,
    kind: "finding",
    label: `finding · ${index}`,
    scope: "ability",
    ability_refs: [{ faction_id: "fabricated-faction", ability_id: id, label: id, metadata_status: "current", source_kind: "direct", distance: 0 }],
    campaign_refs: [index % 2 ? "campaign-2" : "campaign-1"],
    metadata: { statuses: ["resolved"], run_ids: [`run-${index}`], findings: [`finding-${index}`], certificates: [] },
  }));
  return {
    graph_revision: `revision-${id}`,
    root: root().id,
    nodes: [root(), selected, ...evidence],
    edges: [
      { id: `edge:${selected.id}`, source: root().id, target: selected.id, kind: "contains", metadata: {} },
      ...evidence.map((node) => ({ id: `edge:${selected.id}:${node.id}`, source: selected.id, target: node.id, kind: "evidence", metadata: {} })),
    ],
    page: { next_cursor: cursor, truncated: cursor !== null },
    filters: { mode: "ability", faction_id: "fabricated-faction", ability_id: id, campaign_id: null, depth: 4 },
  };
}

function campaignSnapshot(campaignId: string, cursor: string | null = null): GlobalGraphSnapshot {
  const snapshot = abilitySnapshot("alpha", 2, cursor);
  snapshot.graph_revision = `revision-campaign-${campaignId}`;
  snapshot.filters = { mode: "campaign", faction_id: null, ability_id: null, campaign_id: campaignId, depth: 4 };
  for (const node of snapshot.nodes) {
    if (node.kind !== "mechanic-evidence-root") node.campaign_refs = [campaignId];
  }
  return snapshot;
}

function workflowNode(
  id: string,
  outputKind: string,
  workflowTask = "leader-relation",
  workflowLane = "trail",
): ProjectionNode {
  return {
    id,
    kind: "workflow-output",
    label: `${outputKind.replaceAll("-", " ")} output`,
    scope: "ability",
    ability_refs: [{
      faction_id: "fabricated-faction",
      ability_id: "alpha",
      label: "alpha",
      metadata_status: "current",
      source_kind: "direct",
      distance: 3,
    }],
    campaign_refs: ["campaign-1"],
    metadata: {
      output_kind: outputKind,
      workflow_stage: "shape",
      workflow_task: workflowTask,
      workflow_round: "r2",
      workflow_lane: workflowLane,
      task_id: `c011:agent:shape:${workflowTask}:r2:${workflowLane}:${outputKind}:task:1`,
      attempt_id: `c011:agent:shape:${workflowTask}:r2:${workflowLane}:${outputKind}:attempt:1`,
      attempt_number: 1,
      lineage_distance: 3,
    },
  };
}

function lineageSnapshot(): GlobalGraphSnapshot {
  const selected = ability("alpha");
  const source = workflowNode("source-input", "warpsmith", "leader-relation", "shape");
  const psyker = workflowNode("30c8c8a5c370", "psyker");
  const trail = workflowNode("30b4a49f8f1e", "kroot-trail-shaper");
  const sharedInputs = ["flesh-input", "spear-input", "plan-input"].map((id) =>
    workflowNode(id, id.replace("-input", "")),
  );
  const otherDependents = Array.from({ length: 14 }, (_, index) =>
    workflowNode(`dependent-${index.toString().padStart(2, "0")}`, "eversor", "leader-relation", "review"),
  );
  const successors = [trail, ...otherDependents];
  return {
    graph_revision: "revision-lineage",
    root: root().id,
    nodes: [root(), selected, source, psyker, ...sharedInputs, ...successors],
    edges: [
      { id: `edge:${selected.id}`, source: root().id, target: selected.id, kind: "contains", metadata: {} },
      { id: "edge:ability:source", source: selected.id, target: source.id, kind: "evidence", metadata: {} },
      ...sharedInputs.map((node) => ({ id: `edge:ability:${node.id}`, source: selected.id, target: node.id, kind: "evidence", metadata: {} })),
      { id: "edge:source:psyker", source: source.id, target: psyker.id, kind: "derived_from", metadata: {} },
      ...successors.map((node) => ({ id: `edge:psyker:${node.id}`, source: psyker.id, target: node.id, kind: "derived_from", metadata: {} })),
      ...sharedInputs.map((node) => ({ id: `edge:${node.id}:trail`, source: node.id, target: trail.id, kind: "derived_from", metadata: {} })),
    ],
    page: { next_cursor: null, truncated: false },
    filters: { mode: "ability", faction_id: "fabricated-faction", ability_id: "alpha", campaign_id: null, depth: 4 },
  };
}

class FakeClient implements MechanicGraphClient {
  requests: GraphSnapshotQuery[] = [];
  snapshots: Array<GlobalGraphSnapshot | Error | Promise<GlobalGraphSnapshot>> = [];
  signals: AbortSignal[] = [];
  progress: Array<CampaignProgress[] | Error | Promise<CampaignProgress[]>> = [];
  progressSignals: AbortSignal[] = [];
  streams: Array<Omit<GraphSnapshotQuery, "after" | "limit" | "depth">> = [];

  async getGraphSnapshot(query: GraphSnapshotQuery, signal?: AbortSignal): Promise<GlobalGraphSnapshot> {
    this.requests.push(query);
    if (signal) this.signals.push(signal);
    const response = this.snapshots.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("missing fixture response");
    return response;
  }
  async getCampaignProgress(signal?: AbortSignal): Promise<CampaignProgress[]> {
    if (signal) this.progressSignals.push(signal);
    const response = this.progress.shift() ?? [];
    if (response instanceof Error) throw response;
    return response;
  }
  async getGraphUpdates(): Promise<GraphInvalidation> {
    return { graph_revision: "revision", through: 0, affected_ability_ids: [], page: { next_cursor: null, truncated: false } };
  }
  async getReviewSource(_reviewId: string, _signal?: AbortSignal): Promise<AuthorizedSourceExcerpt> { throw new Error("closed"); }
  async submitDecision(_input: ReviewDecisionInput, _signal?: AbortSignal): Promise<DecisionReceipt> { throw new Error("closed"); }
  openGraphStream(query: Omit<GraphSnapshotQuery, "after" | "limit" | "depth">, _onCommit: (notice: Pick<GraphInvalidation, "graph_revision" | "affected_ability_ids">) => void, _onDisconnect: () => void): () => void {
    this.streams.push(query);
    return () => {};
  }
}

function campaignProgress(campaignId: string): CampaignProgress {
  return {
    runId: `run-${campaignId}`,
    campaignId,
    state: "running",
    kind: "authoring",
    target: "fabricated-faction",
    started: "2026-01-01T00:00:00Z",
    finished: null,
    taskStates: { succeeded: 3, queued: 1 },
    taskTotal: 4,
    claimStates: { active: 1 },
    claimTotal: 1,
    findingStates: { open: 1 },
    findingTotal: 1,
    checkStates: { passed: 2 },
    checkTotal: 2,
  };
}

describe("bounded global graph store", () => {
  it("loads only the index initially and does not exhaust pages", async () => {
    const client = new FakeClient();
    const snapshot = indexSnapshot();
    snapshot.page = { next_cursor: "next", truncated: true };
    client.snapshots.push(snapshot);
    const store = createGraphStore(client);
    await store.start();
    expect(client.requests).toEqual([{ mode: "index", limit: 100 }]);
    expect(store.abilityIndex).toHaveLength(2);
    expect(store.nodes.size).toBe(0);
    expect(store.nextCursor).toBe("next");
    store.stop();
  });

  it("aborts stale selections and replaces the renderer data", async () => {
    const client = new FakeClient();
    client.snapshots.push(indexSnapshot());
    const store = createGraphStore(client);
    await store.start();

    let resolveAlpha!: (snapshot: GlobalGraphSnapshot) => void;
    const alphaPromise = new Promise<GlobalGraphSnapshot>((resolve) => { resolveAlpha = resolve; });
    client.snapshots.push(alphaPromise, abilitySnapshot("beta"));
    const alphaLoad = store.selectAbility(store.abilityIndex[0]);
    const alphaSignal = client.signals.at(-1)!;
    await store.selectAbility(store.abilityIndex[1]);
    expect(alphaSignal.aborted).toBe(true);
    resolveAlpha(abilitySnapshot("alpha"));
    await alphaLoad;
    store.setGraphSearch("beta-finding");
    expect(store.graphSearchResults.some((node) => node.id.startsWith("alpha-finding"))).toBe(false);
    expect(store.graphSearchResults.some((node) => node.id.startsWith("beta-finding"))).toBe(true);
    store.stop();
  });

  it("enforces the client-side 400-node cap and exposes truncation", async () => {
    const client = new FakeClient();
    client.snapshots.push(indexSnapshot(), abilitySnapshot("alpha", 410, "next"));
    const store = createGraphStore(client);
    await store.start();
    await store.selectAbility(store.abilityIndex[0]);
    expect(store.projectionNodeCount).toBe(400);
    expect(store.renderedNodeCount).toBe(2);
    expect(store.graphScope).toBe("trace");
    expect(store.truncated).toBe(true);
    store.stop();
  });

  it("debounces ability search and marks stale-cursor failures explicitly", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.snapshots.push(indexSnapshot(), abilitySnapshot("alpha", 1, "next"), new MechanicGraphApiError(409, "stale-cursor"));
    const store = createGraphStore(client);
    await store.start();
    store.setSearch("beta");
    expect(store.filteredAbilities).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(150);
    expect(store.filteredAbilities.map((node) => node.metadata.ability_id)).toEqual(["beta"]);
    await store.selectAbility(store.abilityIndex[0]);
    await store.loadMoreEvidence();
    expect(store.connection).toBe("stale");
    expect(store.diagnostic).toContain("stale-cursor");
    store.stop();
    vi.useRealTimers();
  });

  it("refits an active projection after a real viewport resize without disturbing graph state", async () => {
    const client = new FakeClient();
    client.snapshots.push(indexSnapshot(), abilitySnapshot("alpha"));
    const store = createGraphStore(client);
    await store.start();
    await store.selectAbility(store.abilityIndex[0]);
    store.selectNode("alpha-finding-0");

    const positions = store.positions;
    const selectedNodeId = store.selectedNodeId;
    const selectedProjectionNode = store.selectedProjectionNode;
    const fitRequest = store.fitRequest;
    store.setViewportWidth(store.viewportWidth - 160);

    expect(store.fitRequest).toBe(fitRequest + 1);
    expect(store.positions).toBe(positions);
    expect(store.selectedNodeId).toBe(selectedNodeId);
    expect(store.selectedProjectionNode).toBe(selectedProjectionNode);
    store.stop();
  });


  it("does not request another fit when the viewport width is reported unchanged", async () => {
    const client = new FakeClient();
    client.snapshots.push(indexSnapshot(), abilitySnapshot("alpha"));
    const store = createGraphStore(client);
    await store.start();
    await store.selectAbility(store.abilityIndex[0]);

    const width = store.viewportWidth - 160;
    const fitRequest = store.fitRequest;
    store.setViewportWidth(width);
    store.setViewportWidth(width);

    expect(store.fitRequest).toBe(fitRequest + 1);
    store.stop();
  });

  it("does not request a graph fit before a projection exists", () => {
    const store = createGraphStore(new FakeClient());
    const fitRequest = store.fitRequest;

    store.setViewportWidth(store.viewportWidth - 160);

    expect(store.fitRequest).toBe(fitRequest);
    store.stop();
  });
  it("defaults to a bounded lineage trace and requires an explicit overview", async () => {
    const client = new FakeClient();
    client.snapshots.push(indexSnapshot(), lineageSnapshot());
    const store = createGraphStore(client);
    await store.start();
    await store.selectAbility(store.abilityIndex[0]!);

    expect([...store.nodes.keys()]).toEqual([
      "root:mechanic-evidence",
      "ability:fabricated-faction:alpha",
    ]);
    store.setGraphSearch("psyker");
    expect(store.graphSearchResults.map((node) => node.id)).toContain("30c8c8a5c370");
    store.focusTraceNode("30c8c8a5c370");

    expect(store.graphScope).toBe("trace");
    expect(store.graphSearch).toBe("");
    expect(store.traceSuccessorCount).toBe(15);
    expect(store.traceHiddenSuccessorCount).toBe(3);
    expect(store.nodes.has("source-input")).toBe(true);
    expect(store.nodes.has("30c8c8a5c370")).toBe(true);
    expect(store.centerRequest?.nodeId).toBe("30c8c8a5c370");
    expect(store.nodes.size).toBe(16);
    expect(store.nodes.get("30c8c8a5c370")).toMatchObject({
      outputKind: "psyker",
      workflowTask: "leader-relation",
      workflowLane: "trail",
      attemptNumber: 1,
      lineageDistance: 3,
    });

    store.setGraphScope("overview");
    expect(store.nodes.size).toBe(store.projectionNodeCount);
    expect(store.nodes.size).toBe(22);
    store.setGraphScope("trace");
    expect(store.nodes.size).toBe(16);
    store.stop();
  });

  it("ignores duplicate flow selection reports", async () => {
    const client = new FakeClient();
    client.snapshots.push(indexSnapshot(), lineageSnapshot());
    const store = createGraphStore(client);
    await store.start();
    await store.selectAbility(store.abilityIndex[0]!);

    store.selectNode("root:mechanic-evidence");
    const nodeProjection = store.nodes;
    store.selectNode("root:mechanic-evidence");
    expect(store.nodes).toBe(nodeProjection);

    store.selectEdge("edge:ability:source");
    const edgeProjection = store.nodes;
    store.selectEdge("edge:ability:source");
    expect(store.nodes).toBe(edgeProjection);
    store.stop();
  });

  it("isolates the reported lineage and exposes inspectable relationship semantics", async () => {
    const client = new FakeClient();
    client.snapshots.push(indexSnapshot(), lineageSnapshot());
    const store = createGraphStore(client);
    await store.start();
    await store.selectAbility(store.abilityIndex[0]!);
    store.focusTraceNode("30b4a49f8f1e");

    expect(store.traceBreadcrumbs.at(-1)?.id).toBe("30b4a49f8f1e");
    expect(store.incomingRelationships).toHaveLength(4);
    expect(store.incomingRelationships.map((relationship) => relationship.node.id)).toContain("30c8c8a5c370");
    expect(store.outgoingRelationships).toHaveLength(0);

    store.selectEdge("edge:psyker:30b4a49f8f1e");
    expect(store.selectedEdge).toMatchObject({
      sourceNodeId: "30c8c8a5c370",
      targetNodeId: "30b4a49f8f1e",
      kind: "derived_from",
      authority: "provisional",
    });
    expect(store.selectedEdgeSource?.metadata.output_kind).toBe("psyker");
    expect(store.selectedEdgeTarget?.metadata.output_kind).toBe("kroot-trail-shaper");
    expect(store.selectedEdgeOtherInputCount).toBe(3);
    expect(store.nodes.has("30c8c8a5c370")).toBe(true);
    expect(store.nodes.has("30b4a49f8f1e")).toBe(true);
    store.stop();
  });

});

describe("campaign progress state", () => {
  it("defaults to the first server-ordered campaign", async () => {
    const client = new FakeClient();
    client.snapshots.push(indexSnapshot());
    client.progress.push([campaignProgress("active"), campaignProgress("historical")]);
    const store = createGraphStore(client);

    await store.start();

    expect(store.campaignProgressStatus).toBe("ready");
    expect(store.selectedCampaignProgressId).toBe("active");
    expect(store.selectedCampaignProgress?.campaignId).toBe("active");
    store.stop();
  });

  it("changes campaign context locally without changing the global graph", async () => {
    const client = new FakeClient();
    client.snapshots.push(indexSnapshot());
    client.progress.push([campaignProgress("active"), campaignProgress("historical")]);
    const store = createGraphStore(client);

    await store.start();
    store.selectCampaignProgress("historical");

    expect(store.selectedCampaignProgressId).toBe("historical");
    expect(store.selectedAbility).toBeNull();
    expect(store.graphScope).toBe("trace");
    expect(client.requests).toEqual([{ mode: "index", limit: 100 }]);
    store.stop();
  });

  it("preserves a still-valid selected campaign across refresh", async () => {
    const client = new FakeClient();
    client.snapshots.push(indexSnapshot(), indexSnapshot());
    client.progress.push(
      [campaignProgress("active"), campaignProgress("historical")],
      [campaignProgress("active"), campaignProgress("historical"), campaignProgress("older")],
    );
    const store = createGraphStore(client);

    await store.start();
    store.selectCampaignProgress("historical");
    await store.start();

    expect(store.selectedCampaignProgressId).toBe("historical");
    store.stop();
  });

  it("keeps the global graph live when campaign progress fails", async () => {
    const client = new FakeClient();
    client.snapshots.push(indexSnapshot());
    client.progress.push(new Error("campaign service unavailable"));
    const store = createGraphStore(client);

    await store.start();

    expect(store.connection).toBe("live");
    expect(store.campaignProgressStatus).toBe("error");
    expect(store.campaignProgressDiagnostic).toContain("campaign service unavailable");
    expect(store.abilityIndex).toHaveLength(2);
    store.stop();
  });

  it("ignores invalid campaign selections without changing graph scope", async () => {
    const client = new FakeClient();
    client.snapshots.push(indexSnapshot());
    client.progress.push([campaignProgress("active")]);
    const store = createGraphStore(client);

    await store.start();
    store.selectCampaignProgress("missing");

    expect(store.selectedCampaignProgressId).toBe("active");
    expect(store.graphScope).toBe("trace");
    expect(store.selectedAbility).toBeNull();
    store.stop();
  });

  it("loads the selected campaign graph while keeping global as the default", async () => {
    const client = new FakeClient();
    client.snapshots.push(indexSnapshot(), campaignSnapshot("active"));
    client.progress.push([campaignProgress("active"), campaignProgress("historical")]);
    const store = createGraphStore(client);

    await store.start();
    expect(store.graphScope).toBe("trace");
    expect(store.nodes.size).toBe(0);

    await store.selectCampaign("active");

    expect(client.requests).toEqual([
      { mode: "index", limit: 100 },
      { mode: "campaign", campaign_id: "active", limit: 400, depth: 4 },
    ]);
    expect(client.streams.at(-1)).toEqual({ mode: "campaign", campaign_id: "active" });
    expect(store.graphScope).toBe("trace");
    expect(store.activeCampaignGraphId).toBe("active");
    expect(store.selectedAbility).toBeNull();
    expect(store.abilityIndex.map((node) => node.id)).toEqual(["ability:fabricated-faction:alpha"]);
    expect(store.nodes.size).toBeGreaterThan(0);
    store.stop();
  });

  it("keeps campaign context while drilling into an ability", async () => {
    const client = new FakeClient();
    client.snapshots.push(
      indexSnapshot(),
      campaignSnapshot("active"),
      abilitySnapshot("alpha"),
      campaignSnapshot("active"),
    );
    client.progress.push([campaignProgress("active")]);
    const store = createGraphStore(client);

    await store.start();
    await store.selectCampaign("active");
    await store.selectAbility(store.abilityIndex[0]!);

    expect(client.requests.at(-1)).toEqual({
      mode: "ability",
      faction_id: "fabricated-faction",
      ability_id: "alpha",
      limit: 150,
      depth: 4,
    });
    expect(store.activeCampaignGraphId).toBe("active");
    expect(store.graphScope).toBe("trace");
    expect(store.selectedAbility?.id).toBe("ability:fabricated-faction:alpha");

    await store.selectCampaign("active");

    expect(store.selectedAbility).toBeNull();
    expect(store.activeCampaignGraphId).toBe("active");
    expect(client.requests.at(-1)).toEqual({ mode: "campaign", campaign_id: "active", limit: 400, depth: 4 });
    store.stop();
  });

  it("returns from a campaign projection to the global index", async () => {
    const client = new FakeClient();
    client.snapshots.push(indexSnapshot(), campaignSnapshot("active"), indexSnapshot());
    client.progress.push(
      [campaignProgress("active")],
      [campaignProgress("active")],
    );
    const store = createGraphStore(client);

    await store.start();
    await store.selectCampaign("active");
    await store.showGlobalGraph();

    expect(client.requests.at(-1)).toEqual({ mode: "index", limit: 100 });
    expect(store.graphScope).toBe("trace");
    expect(store.activeCampaignGraphId).toBeNull();
    expect(store.nodes.size).toBe(0);
    expect(store.abilityIndex).toHaveLength(2);
    store.stop();
  });

  it("continues a truncated campaign graph with its campaign cursor", async () => {
    const client = new FakeClient();
    client.snapshots.push(
      indexSnapshot(),
      campaignSnapshot("active", "campaign-next"),
      campaignSnapshot("active"),
    );
    client.progress.push([campaignProgress("active")]);
    const store = createGraphStore(client);

    await store.start();
    await store.selectCampaign("active");
    await store.loadMoreEvidence();

    expect(client.requests.at(-1)).toEqual({
      mode: "campaign",
      campaign_id: "active",
      limit: 400,
      depth: 4,
      after: "campaign-next",
    });
    expect(store.truncated).toBe(false);
    store.stop();
  });

  it("merges a real lineage edge whose parent arrived on the previous page", async () => {
    const firstPage = abilitySnapshot("alpha", 1, "ability-next");
    const parent = { ...firstPage.nodes[2], id: "page-one-parent" };
    firstPage.nodes = [firstPage.nodes[0], firstPage.nodes[1], parent];
    firstPage.edges = [
      firstPage.edges[0],
      { id: "edge:ability:parent", source: firstPage.nodes[1].id, target: parent.id, kind: "evidence", metadata: {} },
    ];
    const secondPage = abilitySnapshot("alpha", 1);
    const child = { ...secondPage.nodes[2], id: "page-two-child" };
    secondPage.nodes = [secondPage.nodes[0], secondPage.nodes[1], child];
    secondPage.edges = [
      secondPage.edges[0],
      { id: "edge:parent:child", source: parent.id, target: child.id, kind: "derived-from", metadata: {} },
    ];
    const client = new FakeClient();
    client.snapshots.push(indexSnapshot(), firstPage, secondPage);
    const store = createGraphStore(client);

    await store.start();
    await store.selectAbility(store.abilityIndex[0]);
    await store.loadMoreEvidence();
    store.selectNode(child.id);

    expect(store.incomingRelationships.map((relationship) => relationship.node.id)).toEqual([parent.id]);
    expect([...store.edges.values()].some((edge) => edge.sourceNodeId === firstPage.nodes[1].id && edge.targetNodeId === child.id)).toBe(false);
    store.stop();
  });

  it("clears the previous cursor before a replacement campaign resolves", async () => {
    const client = new FakeClient();
    const paginatedIndex = indexSnapshot();
    paginatedIndex.page = { next_cursor: "index-next", truncated: true };
    let resolveCampaign!: (snapshot: GlobalGraphSnapshot) => void;
    client.snapshots.push(
      paginatedIndex,
      new Promise<GlobalGraphSnapshot>((resolve) => { resolveCampaign = resolve; }),
    );
    client.progress.push([campaignProgress("active")]);
    const store = createGraphStore(client);

    await store.start();
    const transition = store.selectCampaign("active");

    expect(store.nextCursor).toBeNull();
    expect(store.truncated).toBe(false);
    expect(store.loadingMore).toBe(false);
    expect(client.requests.at(-1)).toEqual({ mode: "campaign", campaign_id: "active", limit: 400, depth: 4 });

    resolveCampaign(campaignSnapshot("active"));
    await transition;
    store.stop();
  });

  it("resets pagination when a scope switch interrupts a page request", async () => {
    const client = new FakeClient();
    let resolvePage!: (snapshot: GlobalGraphSnapshot) => void;
    client.snapshots.push(
      indexSnapshot(),
      campaignSnapshot("active", "campaign-next"),
      new Promise<GlobalGraphSnapshot>((resolve) => { resolvePage = resolve; }),
      campaignSnapshot("historical"),
    );
    client.progress.push([campaignProgress("active"), campaignProgress("historical")]);
    const store = createGraphStore(client);

    await store.start();
    await store.selectCampaign("active");
    const interruptedPage = store.loadMoreEvidence();
    expect(store.loadingMore).toBe(true);

    await store.selectCampaign("historical");

    expect(store.loadingMore).toBe(false);
    expect(store.nextCursor).toBeNull();
    expect(store.truncated).toBe(false);
    expect(store.activeCampaignGraphId).toBe("historical");

    resolvePage(campaignSnapshot("active"));
    await interruptedPage;
    expect(store.loadingMore).toBe(false);
    store.stop();
  });

  it("aborts progress refreshes and ignores their late results after stop", async () => {
    const client = new FakeClient();
    let resolveProgress!: (campaigns: CampaignProgress[]) => void;
    client.snapshots.push(indexSnapshot());
    client.progress.push(new Promise<CampaignProgress[]>((resolve) => { resolveProgress = resolve; }));
    const store = createGraphStore(client);

    await store.start();
    expect(store.campaignProgressStatus).toBe("loading");
    const signal = client.progressSignals[0]!;
    store.stop();
    resolveProgress([campaignProgress("late")]);
    await Promise.resolve();

    expect(signal.aborted).toBe(true);
    expect(store.campaignProgress).toEqual([]);
    expect(store.selectedCampaignProgressId).toBeNull();
  });
});

