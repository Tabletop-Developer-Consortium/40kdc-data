import { describe, expect, it, vi } from "vitest";
import { MechanicGraphApiError } from "./api/client.js";
import type {
  AuthorizedSourceExcerpt,
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

class FakeClient implements MechanicGraphClient {
  requests: GraphSnapshotQuery[] = [];
  snapshots: Array<GlobalGraphSnapshot | Error | Promise<GlobalGraphSnapshot>> = [];
  signals: AbortSignal[] = [];

  async getGraphSnapshot(query: GraphSnapshotQuery, signal?: AbortSignal): Promise<GlobalGraphSnapshot> {
    this.requests.push(query);
    if (signal) this.signals.push(signal);
    const response = this.snapshots.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("missing fixture response");
    return response;
  }
  async getGraphUpdates(): Promise<GraphInvalidation> {
    return { graph_revision: "revision", through: 0, affected_ability_ids: [], page: { next_cursor: null, truncated: false } };
  }
  async getReviewSource(_reviewId: string, _signal?: AbortSignal): Promise<AuthorizedSourceExcerpt> { throw new Error("closed"); }
  async submitDecision(_input: ReviewDecisionInput, _signal?: AbortSignal): Promise<DecisionReceipt> { throw new Error("closed"); }
  openGraphStream(_query: Omit<GraphSnapshotQuery, "after" | "limit" | "depth">, _onCommit: (notice: Pick<GraphInvalidation, "graph_revision" | "affected_ability_ids">) => void, _onDisconnect: () => void): () => void { return () => {}; }
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
    expect([...store.nodes.keys()].some((id) => id.startsWith("alpha-finding"))).toBe(false);
    expect([...store.nodes.keys()].some((id) => id.startsWith("beta-finding"))).toBe(true);
    store.stop();
  });

  it("enforces the client-side 400-node cap and exposes truncation", async () => {
    const client = new FakeClient();
    client.snapshots.push(indexSnapshot(), abilitySnapshot("alpha", 410, "next"));
    const store = createGraphStore(client);
    await store.start();
    await store.selectAbility(store.abilityIndex[0]);
    expect(store.renderedNodeCount).toBe(400);
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
});
