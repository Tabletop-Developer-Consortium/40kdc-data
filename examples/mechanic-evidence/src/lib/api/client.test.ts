import { describe, expect, it, vi } from "vitest";
import { MechanicGraphApiError, createMechanicGraphClient } from "./client.js";
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
