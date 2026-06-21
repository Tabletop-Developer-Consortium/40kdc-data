import { describe, it, expect, beforeEach } from "vitest";
import {
  parseSource,
  entryKind,
  entryToText,
  loadIndex,
  _clearMemCache,
  DEFAULT_SOURCE,
  type StoreIndex,
} from "./source-store.js";

describe("parseSource", () => {
  it("resolves owner/repo to a main-branch raw index URL", () => {
    const p = parseSource("wn-mitch/40kdc-abilities");
    expect(p.indexUrl).toBe(
      "https://raw.githubusercontent.com/wn-mitch/40kdc-abilities/main/index.json",
    );
    expect(p.label).toBe("wn-mitch/40kdc-abilities@main");
  });

  it("honours an explicit @ref", () => {
    const p = parseSource("bmerrill17/40kdc-abilities@dev");
    expect(p.indexUrl).toBe(
      "https://raw.githubusercontent.com/bmerrill17/40kdc-abilities/dev/index.json",
    );
    expect(p.label).toBe("bmerrill17/40kdc-abilities@dev");
  });

  it("blank falls back to the default source", () => {
    expect(parseSource("").indexUrl).toBe(parseSource(DEFAULT_SOURCE).indexUrl);
    expect(parseSource("   ").label).toBe(parseSource(DEFAULT_SOURCE).label);
  });

  it("accepts a raw base URL and appends index.json", () => {
    expect(parseSource("https://example.com/store/").indexUrl).toBe(
      "https://example.com/store/index.json",
    );
  });

  it("accepts a direct index.json URL unchanged", () => {
    const url = "https://example.com/store/index.json";
    expect(parseSource(url).indexUrl).toBe(url);
  });

  it("rejects malformed specs", () => {
    expect(() => parseSource("not a repo")).toThrow();
    expect(() => parseSource("toomany/slashes/here")).toThrow();
  });
});

describe("entryKind / entryToText", () => {
  it("classifies a raw_text entry", () => {
    const e = { faction: "necrons", raw_text: "Deals D3 mortal wounds." };
    expect(entryKind(e)).toBe("raw");
    expect(entryToText(e)).toBe("Deals D3 mortal wounds.");
  });

  it("classifies a structured stratagem-shaped entry", () => {
    const e = { when: "Your turn.", target: "One unit.", effect: "It fights." };
    expect(entryKind(e)).toBe("structured");
    expect(entryToText(e)).toBe(
      "WHEN: Your turn.\nTARGET: One unit.\nEFFECT: It fights.",
    );
  });

  it("treats whitespace-only raw_text and missing entries as empty", () => {
    expect(entryKind({ raw_text: "   " })).toBe("empty");
    expect(entryKind(undefined)).toBe("empty");
    expect(entryToText(undefined)).toBe("");
  });
});

describe("loadIndex", () => {
  beforeEach(() => _clearMemCache());

  const sample: StoreIndex = {
    "deep-strike": { faction: "core", raw_text: "Set up in reserves." },
  };

  function fakeFetch(ok: boolean, body: unknown): typeof fetch {
    return (async () =>
      ({
        ok,
        status: ok ? 200 : 404,
        statusText: ok ? "OK" : "Not Found",
        json: async () => body,
      }) as Response) as unknown as typeof fetch;
  }

  it("fetches and counts the index", async () => {
    const res = await loadIndex("owner/repo@x", { fetchImpl: fakeFetch(true, sample) });
    expect(res.count).toBe(1);
    expect(res.index["deep-strike"].raw_text).toBe("Set up in reserves.");
    expect(res.label).toBe("owner/repo@x");
  });

  it("throws on a non-ok response", async () => {
    await expect(
      loadIndex("owner/repo@y", { fetchImpl: fakeFetch(false, null) }),
    ).rejects.toThrow(/404/);
  });

  it("rejects a non-object index", async () => {
    await expect(
      loadIndex("owner/repo@z", { fetchImpl: fakeFetch(true, [1, 2, 3]) }),
    ).rejects.toThrow(/object map/);
  });
});
