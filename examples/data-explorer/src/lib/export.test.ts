import { afterEach, describe, expect, it, vi } from "vitest";
import { download, toJson, toMarkdown, type FlaggedRecord } from "./export.js";

const records: FlaggedRecord[] = [
  {
    ability_id: "deadly-demise-d3",
    name: "Deadly Demise D3",
    faction_id: "necrons",
    flagged: true,
    note: "Threshold should be 6, not 5.",
    source_text: "When this model is destroyed, roll a D6...",
    dsl: { effect: { type: "dice-gated", threshold: 5 } },
    describer: "On a 5+, deal mortal wounds.",
    reviewed_fingerprint: "abc",
    current_fingerprint: "abc",
    stale: false,
  },
  {
    ability_id: "mystery-ability",
    name: "Mystery Ability",
    faction_id: null,
    flagged: true,
    note: "",
    source_text: "",
    dsl: { effect: null },
    describer: "",
    current_fingerprint: "0",
    stale: false,
  },
];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("download", () => {
  it("keeps consecutive Blob URLs alive until deferred cleanup", () => {
    vi.useFakeTimers();
    const anchors = Array.from({ length: 2 }, () => ({
      href: "",
      download: "",
      click: vi.fn(),
      remove: vi.fn(),
    }));
    const appendChild = vi.fn();
    vi.stubGlobal("document", {
      createElement: vi
        .fn()
        .mockReturnValueOnce(anchors[0])
        .mockReturnValueOnce(anchors[1]),
      body: { appendChild },
    });
    const createObjectURL = vi
      .fn()
      .mockReturnValueOnce("blob:review-1")
      .mockReturnValueOnce("blob:review-2");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    download("ability-dsl-review.md", "first");
    download("ability-dsl-review.md", "second");

    expect(appendChild).toHaveBeenNthCalledWith(1, anchors[0]);
    expect(appendChild).toHaveBeenNthCalledWith(2, anchors[1]);
    expect(anchors.map((anchor) => anchor.href)).toEqual(["blob:review-1", "blob:review-2"]);
    expect(anchors.map((anchor) => anchor.download)).toEqual([
      "ability-dsl-review.md",
      "ability-dsl-review.md",
    ]);
    for (const anchor of anchors) {
      expect(anchor.click).toHaveBeenCalledOnce();
      expect(anchor.remove).toHaveBeenCalledOnce();
    }
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);

    expect(revokeObjectURL).toHaveBeenNthCalledWith(1, "blob:review-1");
    expect(revokeObjectURL).toHaveBeenNthCalledWith(2, "blob:review-2");
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});

describe("toJson", () => {
  it("wraps records with a count and kind tag", () => {
    const parsed = JSON.parse(toJson(records));
    expect(parsed.kind).toBe("ability-dsl-review");
    expect(parsed.count).toBe(2);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].ability_id).toBe("deadly-demise-d3");
  });
});

describe("toMarkdown", () => {
  const md = toMarkdown(records);

  it("includes each ability id, name, note, source, describer and DSL", () => {
    expect(md).toContain("## Deadly Demise D3 `deadly-demise-d3`");
    expect(md).toContain("*Faction:* necrons");
    expect(md).toContain("**Note:** Threshold should be 6, not 5.");
    expect(md).toContain("When this model is destroyed");
    expect(md).toContain("On a 5+, deal mortal wounds.");
    expect(md).toContain('"threshold": 5');
  });

  it("falls back gracefully when source text and describer are empty", () => {
    expect(md).toContain("(no source text available)");
    expect(md).toContain("## Mystery Ability `mystery-ability`");
  });

  it("uses singular/plural correctly in the header", () => {
    expect(toMarkdown([records[0]])).toContain("1 flagged ability.");
    expect(md).toContain("2 flagged abilities.");
  });

  it("marks entries whose describer changed since review", () => {
    const staleRecord: FlaggedRecord = {
      ...records[0],
      reviewed_fingerprint: "old",
      current_fingerprint: "new",
      stale: true,
    };
    const staleMd = toMarkdown([staleRecord]);
    expect(staleMd).toContain("⚠️ (changed since reviewed)");
    expect(staleMd).toContain("re-verify the note still applies");
    // A non-stale entry carries no marker.
    expect(md).not.toContain("⚠️ (changed since reviewed)");
  });
});
