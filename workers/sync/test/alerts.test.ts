/**
 * Discord capacity alerts: the guard that keeps them optional, the payload
 * shape and status handling in sendDiscordAlert, and SyncRegistry's contract
 * that a REJECTED alert must not persist the dedupe marker (a marker written
 * on a failed send would blackhole the next 15 minutes of capacity alarms).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { sendDiscordAlert } from "../src/alerts";
import type { SyncRegistry } from "../src/sync-registry";

const HOOK = "https://discord.test/api/webhooks/1/token";
const LINES = ["**at capacity**", "20/20 rooms in use."];

/** Replace global fetch with a recorder; restored by restoreAllMocks. */
function stubFetch(reply: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(reply());
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sendDiscordAlert", () => {
  it("no-ops without the webhook secret and never touches the network", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await expect(sendDiscordAlert({}, LINES)).resolves.toBe(false);
    await expect(sendDiscordAlert({ DISCORD_WEBHOOK_URL: "" }, LINES)).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("POSTs newline-joined {content} to the webhook and reports 204 as delivered", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await expect(sendDiscordAlert({ DISCORD_WEBHOOK_URL: HOOK }, LINES)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(HOOK);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ content: LINES.join("\n") });
  });

  it("reports a rejected webhook as undelivered rather than silently succeeding", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(() => new Response("Unknown Webhook", { status: 404 }));
    await expect(sendDiscordAlert({ DISCORD_WEBHOOK_URL: HOOK }, LINES)).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    // The webhook URL is the credential — it must never reach the log.
    expect(warn.mock.calls.flat().join(" ")).not.toContain(HOOK);
  });

  it("swallows a transport failure without throwing at the caller", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", () => Promise.reject(new Error("timed out")));
    await expect(sendDiscordAlert({ DISCORD_WEBHOOK_URL: HOOK }, LINES)).resolves.toBe(false);
  });
});

describe("SyncRegistry capacity-alert dedupe", () => {
  // A dedicated instance name PER TEST: `isolatedStorage` is off and the
  // "global" singleton is shared with the session-create and doc-live suites,
  // so a shared instance would leak this suite's `last_cap_alert` marker both
  // between these tests and into the others.
  const stub = (name: string) =>
    env.SYNC_REGISTRY.get(env.SYNC_REGISTRY.idFromName(`alerts-test-${name}`));

  /** Drive the private alert path and wait for its POST to settle. */
  async function alert(name: string): Promise<string | undefined> {
    return runInDurableObject(stub(name), async (instance: SyncRegistry) => {
      (instance as unknown as { maybeCapacityAlert(n: number): void }).maybeCapacityAlert(20);
      // Let the fetch + .then(marker write) + .finally(flag reset) chain run.
      await new Promise((r) => setTimeout(r, 0));
      const ctx = (instance as unknown as { ctx: DurableObjectState }).ctx;
      return ctx.storage.sql
        .exec<{ v: string }>("SELECT v FROM meta WHERE k = 'last_cap_alert'")
        .toArray()[0]?.v;
    });
  }

  it("does not persist the dedupe marker when Discord rejects the alert", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(() => new Response("Unknown Webhook", { status: 404 }));
    expect(await alert("rejected")).toBeUndefined();
  });

  it("persists the dedupe marker once Discord accepts the alert", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    const marker = await alert("accepted");
    expect(marker).toBeDefined();
    expect(Number(marker)).toBeGreaterThan(0);
  });

  it("suppresses a repeat alert inside the dedupe window", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await alert("window");
    await alert("window");
    expect(calls).toHaveLength(1);
  });
});
