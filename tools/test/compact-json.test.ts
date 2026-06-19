import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { formatCompact } from "../src/compact-json.js";

/**
 * The compact serializer exists so a tool that rewrites a hand-authored core file
 * touches only the values it changed. That guarantee holds ONLY while
 * `formatCompact(JSON.parse(text)) === text` for the files it may write — so pin
 * that byte-for-byte round-trip here. If a future hand edit adopts a shape the
 * formatter doesn't reproduce, this fails loudly before a tool reflows the file.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE = join(REPO_ROOT, "data", "core");

const ROUND_TRIP_FILES = [
  "secondary-cards.json",
  "missions.json",
  "mission-matchups.json",
  "force-dispositions.json",
];

describe("formatCompact", () => {
  for (const f of ROUND_TRIP_FILES) {
    it(`round-trips ${f} byte-for-byte`, () => {
      const text = readFileSync(join(CORE, f), "utf8");
      expect(formatCompact(JSON.parse(text))).toBe(text);
    });
  }

  it("keeps scalar arrays inline but breaks arrays of objects", () => {
    const out = formatCompact([{ tags: ["a", "b"], items: [{ n: 1 }] }]);
    expect(out).toContain('"tags": ["a", "b"]');
    expect(out).toContain('"items": [\n');
  });

  it("renders a property-value object inline and an array element as a block", () => {
    const out = formatCompact([{ trigger: { timing: "end-of-turn" }, vp: 2 }]);
    // entity (array element) is a block: keys on their own lines
    expect(out).toBe('[\n  {\n    "trigger": { "timing": "end-of-turn" },\n    "vp": 2\n  }\n]\n');
  });

  it("produces the hugging hybrid for an inline object with a breaking array", () => {
    const out = formatCompact([{ when: { op: "or", operands: [{ a: 1 }, { b: 2 }] }, vp: 5 }]);
    expect(out).toContain('"when": { "op": "or", "operands": [\n');
    expect(out).toContain("] },\n");
  });
});
