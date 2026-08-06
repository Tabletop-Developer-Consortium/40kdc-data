import { describe, expect, it, vi } from "vitest";
import { MechanicGraphApiError, UnsafeProjectionError, createMechanicGraphClient } from "./client.js";
import type { GlobalGraphSnapshot } from "./types.js";

function snapshot(nodeCount = 2): GlobalGraphSnapshot {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: index === 0 ? "root:mechanic-evidence" : `node-${index}`,
    kind: index === 0 ? "mechanic-evidence-root" : "ability",
    label: index === 0 ? "Mechanic Evidence" : `Ability ${index}`,
    scope: index === 0 ? "global" as const : "ability" as const,
    ability_refs: [],
    campaign_refs: [],
    metadata: {},
  }));
  return {
    graph_revision: "revision-1",
    root: "root:mechanic-evidence",
    nodes,
    edges: [],
    page: { next_cursor: null, truncated: false },
    filters: { mode: "index", faction_id: null, ability_id: null, campaign_id: null },
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function campaignProgress(): unknown {
  return {
    run_id: "run-1",
    campaign_id: "campaign-1",
    state: "running",
    kind: "roundtrip",
    target: "faction:sample",
    started: "2026-08-05T12:00:00Z",
    finished: null,
    task_states: { completed: 3, running: 1 },
    task_total: 4,
    claim_states: { active: 1 },
    claim_total: 1,
    finding_states: { open: 2, resolved: 1 },
    finding_total: 3,
    check_states: { passed: 5, failed: 0 },
    check_total: 5,
  };
}

describe("global graph API client", () => {
  it("uses the bounded index and ability routes", async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => { urls.push(String(url)); return response(snapshot()); });
    const client = createMechanicGraphClient(fetcher);
    await client.getGraphSnapshot({ mode: "index", limit: 100 });
    await client.getGraphSnapshot({ mode: "ability", faction_id: "fabricated-faction", ability_id: "alpha", depth: 4 });
    expect(urls[0]).toBe("/api/v1/graph/snapshot?mode=index&limit=100");
    expect(urls[1]).toBe("/api/v1/graph/snapshot?mode=ability&faction_id=fabricated-faction&ability_id=alpha&depth=4");
  });

  it("returns snake-case campaign progress as typed camel-case summaries", async () => {
    const urls: string[] = [];
    const client = createMechanicGraphClient(async (url: string | URL | Request) => {
      urls.push(String(url));
      return response([campaignProgress()]);
    });

    await expect(client.getCampaignProgress()).resolves.toEqual([
      {
        runId: "run-1",
        campaignId: "campaign-1",
        state: "running",
        kind: "roundtrip",
        target: "faction:sample",
        started: "2026-08-05T12:00:00Z",
        finished: null,
        taskStates: { completed: 3, running: 1 },
        taskTotal: 4,
        claimStates: { active: 1 },
        claimTotal: 1,
        findingStates: { open: 2, resolved: 1 },
        findingTotal: 3,
        checkStates: { passed: 5, failed: 0 },
        checkTotal: 5,
      },
    ]);
    expect(urls).toEqual(["/api/v1/campaigns"]);
  });

  it("returns camel-case campaign progress as typed camel-case summaries", async () => {
    const client = createMechanicGraphClient(async () => response([{
      runId: "run-1",
      campaignId: "campaign-1",
      state: "running",
      kind: "roundtrip",
      target: "faction:sample",
      started: "2026-08-05T12:00:00Z",
      finished: null,
      taskStates: { completed: 3, running: 1 },
      taskTotal: 4,
      claimStates: { active: 1 },
      claimTotal: 1,
      findingStates: { open: 2, resolved: 1 },
      findingTotal: 3,
      checkStates: { passed: 5, failed: 0 },
      checkTotal: 5,
    }]));

    await expect(client.getCampaignProgress()).resolves.toEqual([{
      runId: "run-1",
      campaignId: "campaign-1",
      state: "running",
      kind: "roundtrip",
      target: "faction:sample",
      started: "2026-08-05T12:00:00Z",
      finished: null,
      taskStates: { completed: 3, running: 1 },
      taskTotal: 4,
      claimStates: { active: 1 },
      claimTotal: 1,
      findingStates: { open: 2, resolved: 1 },
      findingTotal: 3,
      checkStates: { passed: 5, failed: 0 },
      checkTotal: 5,
    }]);
  });

  it.each([
    [
      "negative count",
      (value: Record<string, unknown>) => { value.task_states = { completed: -1 }; },
      "expected non-negative integer",
    ],
    [
      "fractional total",
      (value: Record<string, unknown>) => { value.claim_total = 1.5; },
      "expected non-negative integer",
    ],
    [
      "non-object state map",
      (value: Record<string, unknown>) => { value.finding_states = []; },
      "expected object",
    ],
  ])("fails closed on a malformed campaign progress %s", async (_, mutate, error) => {
    const invalid = campaignProgress() as Record<string, unknown>;
    mutate(invalid);
    const client = createMechanicGraphClient(async () => response([invalid]));

    await expect(client.getCampaignProgress()).rejects.toThrow(error);
  });

  it.each([
    ["task", (value: Record<string, unknown>) => { value.task_total = 5; }],
    ["claim", (value: Record<string, unknown>) => { value.claim_total = 2; }],
    ["finding", (value: Record<string, unknown>) => { value.finding_total = 4; }],
    ["check", (value: Record<string, unknown>) => { value.check_total = 6; }],
  ])("fails closed when %s totals contradict their state counts", async (_, mutate) => {
    const invalid = campaignProgress() as Record<string, unknown>;
    mutate(invalid);
    const client = createMechanicGraphClient(async () => response([invalid]));

    await expect(client.getCampaignProgress()).rejects.toBeInstanceOf(UnsafeProjectionError);
  });

  it("fails closed on unsafe campaign progress payloads", async () => {
    const unsafe = campaignProgress() as Record<string, unknown>;
    unsafe.raw_text = "prohibited source payload";
    const client = createMechanicGraphClient(async () => response([unsafe]));

    await expect(client.getCampaignProgress()).rejects.toThrow();
  });

  it("rejects an oversized or unsafe projection", async () => {
    const oversized = snapshot(401);
    const client = createMechanicGraphClient(async () => response(oversized));
    await expect(client.getGraphSnapshot({ mode: "index" })).rejects.toThrow("400-node cap");

    const unsafe = snapshot();
    (unsafe.nodes[1].metadata as Record<string, unknown>).raw_text = "fabricated prohibited field";
    const unsafeClient = createMechanicGraphClient(async () => response(unsafe));
    await expect(unsafeClient.getGraphSnapshot({ mode: "index" })).rejects.toThrow();
  });

  it("preserves stale revision errors", async () => {
    const client = createMechanicGraphClient(async () => response({ code: "stale-cursor", graph_revision: "revision-2" }, 409));
    await expect(client.getGraphSnapshot({ mode: "index", after: "cursor" })).rejects.toEqual(new MechanicGraphApiError(409, "stale-cursor"));
  });

  it("opens the bounded invalidation stream rather than a campaign snapshot stream", () => {
    let url = "";
    const stream = { onmessage: null as ((event: MessageEvent<string>) => void) | null, onerror: null as (() => void) | null, close: vi.fn() };
    const client = createMechanicGraphClient(async () => response(snapshot()), (value) => { url = value; return stream as unknown as EventSource; });
    const notice = vi.fn();
    const close = client.openGraphStream({ mode: "ability", faction_id: "fabricated-faction", ability_id: "alpha" }, notice, vi.fn());
    expect(url).toBe("/api/v1/graph/stream?mode=ability&faction_id=fabricated-faction&ability_id=alpha");
    stream.onmessage?.({ data: JSON.stringify({ graph_revision: "revision-2", affected_ability_ids: [{ faction_id: "fabricated-faction", ability_id: "alpha" }] }) } as MessageEvent<string>);
    expect(notice).toHaveBeenCalledOnce();
    close();
    expect(stream.close).toHaveBeenCalledOnce();
  });
});
