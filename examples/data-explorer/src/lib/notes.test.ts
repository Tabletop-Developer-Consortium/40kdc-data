import { describe, it, expect, beforeEach } from "vitest";
import { notes, fingerprintText } from "./notes.svelte.js";

beforeEach(() => notes.clearAll());

describe("fingerprintText", () => {
  it("is deterministic and distinguishes different text", () => {
    expect(fingerprintText("hello")).toBe(fingerprintText("hello"));
    expect(fingerprintText("hello")).not.toBe(fingerprintText("world"));
    expect(typeof fingerprintText("")).toBe("string");
  });
});

describe("flag/note fingerprinting + staleness", () => {
  it("records a fingerprint on flag and is not stale against the same describer", () => {
    notes.toggleFlag("a", "describer text");
    expect(notes.isFlagged("a")).toBe(true);
    expect(notes.get("a").fingerprint).toBe(fingerprintText("describer text"));
    expect(notes.isStale("a", "describer text")).toBe(false);
  });

  it("becomes stale when the describer changes", () => {
    notes.toggleFlag("a", "old text");
    expect(notes.isStale("a", "new text")).toBe(true);
  });

  it("records a fingerprint on setNote", () => {
    notes.setNote("a", "fix this", "describer v1");
    expect(notes.get("a").note).toBe("fix this");
    expect(notes.isStale("a", "describer v1")).toBe(false);
    expect(notes.isStale("a", "describer v2")).toBe(true);
  });

  it("reaffirm re-baselines and clears staleness while keeping the flag", () => {
    notes.toggleFlag("a", "v1");
    expect(notes.isStale("a", "v2")).toBe(true);
    notes.reaffirm("a", "v2");
    expect(notes.isStale("a", "v2")).toBe(false);
    expect(notes.isFlagged("a")).toBe(true);
  });

  it("clear removes a single entry without touching others", () => {
    notes.toggleFlag("a", "x");
    notes.toggleFlag("b", "y");
    notes.clear("a");
    expect(notes.isFlagged("a")).toBe(false);
    expect(notes.isFlagged("b")).toBe(true);
  });

  it("treats a legacy record with no fingerprint as a neutral baseline (never stale)", () => {
    // Simulate localStorage written before fingerprints existed.
    notes.map = { legacy: { flagged: true, note: "old note" } };
    expect(notes.isStale("legacy", "any current describer")).toBe(false);
  });

  it("an unknown id is never stale", () => {
    expect(notes.isStale("nope", "x")).toBe(false);
  });
});
