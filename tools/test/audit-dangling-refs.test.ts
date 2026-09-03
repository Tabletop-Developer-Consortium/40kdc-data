import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReferenceVocabularies,
  collectDanglingAbilityReferences,
  DATA_ROOT,
  formatDanglingRefs,
  normalizeKeyword,
  runDanglingRefsAudit,
  type DanglingReference,
} from "../src/audit-dangling-refs.js";

const KEYWORD_DISPUTE_NOTE =
  'Dangling reference: condition gates on keyword "A", which no unit in the dataset has, so the gate never fires and the effect is dead; the intended keyword is unrecoverable from the encoding.';
const STRATAGEM_DISPUTE_NOTE =
  'Dangling reference: references stratagem id "fire-overwatch-or-heroic", which no stratagem file defines; the intended stratagem is unrecoverable from the encoding.';

/** Create an isolated `data/` root so no test depends on the production tree. */
function setupDataRoot(): string {
  const base = mkdtempSync(join(tmpdir(), "audit-dangling-refs-"));
  const root = join(base, "data");
  for (const sub of [
    "core/alpha",
    "core/beta",
    "core/_example",
    "enrichment/alpha",
    "enrichment/beta",
    "enrichment/_core",
  ]) {
    mkdirSync(join(root, sub), { recursive: true });
  }
  return root;
}

function write(root: string, rel: string, data: unknown): void {
  writeFileSync(join(root, rel), `${JSON.stringify(data, null, 2)}\n`);
}

/** A minimal but realistic core vocabulary covering all four keyword sources. */
function writeCoreVocabulary(root: string): void {
  write(root, "core/alpha/units.json", [
    { id: "alpha-hero", keywords: ["INFANTRY", "Character"], faction_keywords: ["Alpha Legion"] },
  ]);
  write(root, "core/beta/units.json", [
    { id: "beta-brute", keywords: ["MONSTER"], faction_keywords: ["Beta Host"] },
  ]);
  write(root, "core/alpha/factions.json", [
    { id: "alpha", keywords: ["Alpha Faction Label"] },
  ]);
  write(root, "core/unit-keywords.json", [
    { id: "feel-no-pain", name: "Feel No Pain" },
  ]);
  write(root, "core/weapon-keywords.json", [
    { id: "lethal-hits", name: "Lethal Hits" },
  ]);
  write(root, "core/stratagems.json", [{ id: "counter-offensive" }]);
  write(root, "core/alpha/stratagems.json", [{ id: "go-to-ground-alpha" }]);
  // Scratch/example directories must not widen the accepted vocabulary.
  write(root, "core/_example/units.json", [{ id: "x", keywords: ["EXAMPLE ONLY"] }]);
  write(root, "core/_example/stratagems.json", [{ id: "example-only-stratagem" }]);
}

function keywordCondition(type: string, keyword: string): unknown {
  return { type, parameters: { keyword } };
}

/** A realistic `conditional` effect whose gate gates on one keyword. */
function keywordGate(type: string, keyword: string): unknown {
  return {
    type: "conditional",
    condition: keywordCondition(type, keyword),
    effect: { type: "modify-stat", modifier: { stat: "toughness", value: 1 } },
  };
}

describe("normalizeKeyword", () => {
  it("trims, removes all whitespace, and lowercases", () => {
    expect(normalizeKeyword("  Feel No Pain ")).toBe("feelnopain");
    expect(normalizeKeyword("VEHICLE")).toBe("vehicle");
    expect(normalizeKeyword("Adeptus\tAstartes\nGuard")).toBe("adeptusastartesguard");
  });

  it("does not fold punctuation or diacritics", () => {
    expect(normalizeKeyword("Emperor’s Children")).toBe("emperor’schildren");
    expect(normalizeKeyword("Twin-linked")).toBe("twin-linked");
    expect(normalizeKeyword("twinlinked")).not.toBe(normalizeKeyword("twin-linked"));
  });
});

describe("buildReferenceVocabularies", () => {
  let root: string;

  beforeEach(() => {
    root = setupDataRoot();
    writeCoreVocabulary(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("collects normalized keywords from unit, faction, and both catalogs", async () => {
    const { keywords } = await buildReferenceVocabularies(root);
    // unit keywords and faction_keywords
    expect(keywords.has("infantry")).toBe(true);
    expect(keywords.has("character")).toBe(true);
    expect(keywords.has("alphalegion")).toBe(true);
    expect(keywords.has("monster")).toBe(true);
    // faction record keywords
    expect(keywords.has("alphafactionlabel")).toBe(true);
    // unit-keyword catalog ids and names
    expect(keywords.has("feel-no-pain")).toBe(true);
    expect(keywords.has("feelnopain")).toBe(true);
    // weapon-keyword catalog ids and names
    expect(keywords.has("lethal-hits")).toBe(true);
    expect(keywords.has("lethalhits")).toBe(true);
  });

  it("collects stratagem ids from the root and every faction file, exactly", async () => {
    const { stratagems } = await buildReferenceVocabularies(root);
    expect([...stratagems].sort()).toEqual(["counter-offensive", "go-to-ground-alpha"]);
    expect(stratagems.has("Counter-Offensive")).toBe(false);
  });

  it("ignores underscore-prefixed scratch directories", async () => {
    const { keywords, stratagems } = await buildReferenceVocabularies(root);
    expect(keywords.has("exampleonly")).toBe(false);
    expect(stratagems.has("example-only-stratagem")).toBe(false);
  });

  it("skips unreadable and non-array files instead of throwing", async () => {
    writeFileSync(join(root, "core/beta/factions.json"), "{ not json");
    write(root, "core/beta/stratagems.json", { id: "not-an-array" });
    const { keywords, stratagems } = await buildReferenceVocabularies(root);
    expect(keywords.has("infantry")).toBe(true);
    expect(stratagems.has("not-an-array")).toBe(false);
  });
});

describe("collectDanglingAbilityReferences", () => {
  let root: string;

  beforeEach(() => {
    root = setupDataRoot();
    writeCoreVocabulary(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves keywords supplied by any of the four vocabulary sources", async () => {
    write(root, "enrichment/alpha/abilities.json", [
      { ability_id: "unit-label", effect: keywordCondition("unit-has-keyword", "infantry") },
      { ability_id: "faction-label", effect: keywordCondition("target-has-keyword", "ALPHA LEGION") },
      { ability_id: "faction-record-label", effect: keywordCondition("unit-has-keyword", "Alpha Faction Label") },
      { ability_id: "unit-catalog", effect: keywordCondition("unit-has-keyword", "Feel No Pain") },
      { ability_id: "weapon-catalog", effect: keywordCondition("target-has-keyword", "lethal-hits") },
    ]);
    expect(await collectDanglingAbilityReferences(root)).toEqual([]);
  });

  it("reports unresolved keyword operands with their exact DSL location", async () => {
    write(root, "enrichment/alpha/abilities.json", [
      { ability_id: "resolved", effect: keywordGate("unit-has-keyword", "MONSTER") },
      { ability_id: "dangling", effect: keywordGate("target-has-keyword", "A") },
    ]);
    expect(await collectDanglingAbilityReferences(root)).toEqual([
      {
        kind: "keyword",
        reference_type: "target-has-keyword",
        source_file: "enrichment/alpha/abilities.json",
        ability_id: "dangling",
        path: "/1/effect/condition/parameters/keyword",
        value: "A",
      },
    ]);
  });

  it("finds references nested under every recursive DSL wrapper", async () => {
    write(root, "enrichment/alpha/abilities.json", [
      {
        ability_id: "nested",
        trigger: { condition: keywordCondition("unit-has-keyword", "TRIGGERED") },
        effect: {
          type: "sequence",
          steps: [
            {
              type: "conditional",
              condition: {
                type: "and",
                operands: [
                  keywordCondition("target-has-keyword", "OPERAND"),
                  { type: "not", operands: [keywordCondition("unit-has-keyword", "DEEP")] },
                ],
              },
              effect: { type: "cp-refund", modifier: { stratagem: "not-a-stratagem" } },
            },
          ],
        },
      },
    ]);
    const findings = await collectDanglingAbilityReferences(root);
    expect(findings.map((finding) => finding.path)).toEqual([
      "/0/effect/steps/0/condition/operands/0/parameters/keyword",
      "/0/effect/steps/0/condition/operands/1/operands/0/parameters/keyword",
      "/0/effect/steps/0/effect/modifier/stratagem",
      "/0/trigger/condition/parameters/keyword",
    ]);
    expect(findings.map((finding) => finding.value)).toEqual([
      "OPERAND",
      "DEEP",
      "not-a-stratagem",
      "TRIGGERED",
    ]);
  });

  it("treats only supported node types as references", async () => {
    write(root, "enrichment/alpha/abilities.json", [
      {
        ability_id: "lookalikes",
        // A bare `keyword` property with no keyword-condition parent.
        applies_to: { keyword: "NOT A REFERENCE" },
        effect: {
          type: "sequence",
          steps: [
            // A condition type outside the supported pair.
            { type: "unit-has-role", parameters: { keyword: "ALSO NOT A REFERENCE" } },
            // An effect that carries a stratagem string as display text.
            { type: "ability-grant", modifier: { stratagem: "display text only" } },
            // Non-string operands stay out of the report.
            { type: "target-has-keyword", parameters: { keyword: ["A"] } },
          ],
        },
      },
    ]);
    expect(await collectDanglingAbilityReferences(root)).toEqual([]);
  });

  it("compares stratagem ids exactly while keyword matching normalizes", async () => {
    write(root, "enrichment/alpha/abilities.json", [
      { ability_id: "exact", effect: { type: "cp-refund", modifier: { stratagem: "counter-offensive" } } },
      { ability_id: "wrong-case", effect: { type: "cp-refund", modifier: { stratagem: "Counter-Offensive" } } },
      {
        ability_id: "cost-modifier",
        effect: { type: "stratagem-cost-modifier", modifier: { stratagem: "counter offensive" } },
      },
    ]);
    const findings = await collectDanglingAbilityReferences(root);
    expect(findings.map((finding) => [finding.ability_id, finding.reference_type, finding.value])).toEqual([
      ["cost-modifier", "stratagem-cost-modifier", "counter offensive"],
      ["wrong-case", "cp-refund", "Counter-Offensive"],
    ]);
    expect(findings.every((finding) => finding.kind === "stratagem")).toBe(true);
  });

  it("audits the shared _core enrichment pool and sorts findings deterministically", async () => {
    write(root, "enrichment/_core/abilities.json", [
      { ability_id: "shared", effect: keywordCondition("unit-has-keyword", "SHARED MARKER") },
    ]);
    write(root, "enrichment/beta/abilities.json", [
      { ability_id: "zulu", effect: keywordCondition("unit-has-keyword", "ZULU") },
      { ability_id: "alfa", effect: keywordCondition("unit-has-keyword", "ALFA") },
    ]);
    write(root, "enrichment/alpha/abilities.json", [
      { ability_id: "mike", effect: keywordCondition("unit-has-keyword", "MIKE") },
    ]);
    const findings = await collectDanglingAbilityReferences(root);
    expect(findings.map((finding) => [finding.source_file, finding.ability_id])).toEqual([
      ["enrichment/_core/abilities.json", "shared"],
      ["enrichment/alpha/abilities.json", "mike"],
      ["enrichment/beta/abilities.json", "alfa"],
      ["enrichment/beta/abilities.json", "zulu"],
    ]);
    // Repeating the scan yields byte-identical output.
    expect(await collectDanglingAbilityReferences(root)).toEqual(findings);
  });

  it("leaves malformed and non-array ability files to the structural validator", async () => {
    writeFileSync(join(root, "enrichment/alpha/abilities.json"), "[ { broken");
    write(root, "enrichment/beta/abilities.json", { ability_id: "not-an-array" });
    write(root, "enrichment/_core/abilities.json", [
      { ability_id: "readable", effect: keywordCondition("unit-has-keyword", "MISSING") },
    ]);
    const findings = await collectDanglingAbilityReferences(root);
    expect(findings.map((finding) => finding.ability_id)).toEqual(["readable"]);
  });
});

describe("runDanglingRefsAudit", () => {
  let root: string;
  let previousExitCode: number | string | undefined;

  beforeEach(() => {
    root = setupDataRoot();
    writeCoreVocabulary(root);
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
  });

  it("prints a clean report and leaves the exit status untouched", async () => {
    write(root, "enrichment/alpha/abilities.json", [
      { ability_id: "resolved", effect: keywordCondition("unit-has-keyword", "INFANTRY") },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runDanglingRefsAudit(root);
    expect(log.mock.calls.map(([line]) => line)).toContain("No dangling ability references.");
    expect(process.exitCode).toBeUndefined();
  });

  it("prints every diagnostic and fails the process when findings exist", async () => {
    write(root, "enrichment/alpha/abilities.json", [
      { ability_id: "dangling-keyword", effect: keywordGate("target-has-keyword", "A") },
      {
        ability_id: "dangling-stratagem",
        effect: { type: "cp-refund", modifier: { stratagem: "fire-overwatch-or-heroic" } },
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runDanglingRefsAudit(root);
    const output = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("enrichment/alpha/abilities.json");
    expect(output).toContain(
      '  dangling-keyword /0/effect/condition/parameters/keyword keyword (target-has-keyword) → "A"',
    );
    expect(output).toContain(
      '  dangling-stratagem /1/effect/modifier/stratagem stratagem (cp-refund) → "fire-overwatch-or-heroic"',
    );
    expect(output).toContain("2 dangling ability reference(s): 1 keyword, 1 stratagem.");
    expect(process.exitCode).toBe(1);
  });
});

describe("formatDanglingRefs", () => {
  it("groups findings by source file and summarizes both reference classes", () => {
    const findings: DanglingReference[] = [
      {
        kind: "keyword",
        reference_type: "target-has-keyword",
        source_file: "enrichment/alpha/abilities.json",
        ability_id: "one",
        path: "/0/effect/condition/parameters/keyword",
        value: "A",
      },
      {
        kind: "stratagem",
        reference_type: "stratagem-cost-modifier",
        source_file: "enrichment/beta/abilities.json",
        ability_id: "two",
        path: "/3/effect/modifier/stratagem",
        value: "missing-stratagem",
      },
    ];
    const lines = formatDanglingRefs(findings, "/tmp/example/data");
    expect(lines[0]).toBe("40kdc Dangling Ability References");
    expect(lines[1]).toBe("Data root: /tmp/example/data");
    expect(lines).toContain("enrichment/alpha/abilities.json");
    expect(lines).toContain("enrichment/beta/abilities.json");
    expect(lines.at(-1)).toBe("2 dangling ability reference(s): 1 keyword, 1 stratagem.");
  });
});

describe("production dangling-reference disputes", () => {
  it("marks every confirmed defect without changing its dangling operand", async () => {
    const confirmed = (await collectDanglingAbilityReferences()).filter(
      (finding) =>
        (finding.kind === "keyword" && finding.value === "A") ||
        (finding.kind === "stratagem" && finding.value === "fire-overwatch-or-heroic"),
    );
    const keywordFindings = confirmed.filter(
      (finding) => finding.kind === "keyword" && finding.value === "A",
    );
    const stratagemFindings = confirmed.filter(
      (finding) => finding.kind === "stratagem" && finding.value === "fire-overwatch-or-heroic",
    );

    expect(
      new Set(keywordFindings.map((finding) => `${finding.source_file}:${finding.ability_id}`)).size,
    ).toBe(51);
    expect(stratagemFindings).toHaveLength(19);

    for (const finding of confirmed) {
      const abilities = JSON.parse(
        readFileSync(join(DATA_ROOT, finding.source_file), "utf-8"),
      ) as Array<Record<string, unknown>>;
      const index = Number(finding.path.split("/")[1]);
      const ability = abilities[index];
      const expectedNote =
        finding.kind === "keyword" ? KEYWORD_DISPUTE_NOTE : STRATAGEM_DISPUTE_NOTE;

      expect(ability?.ability_id).toBe(finding.ability_id);
      expect(ability?.disputed).toBe(true);
      expect(ability?.dispute_notes).toBe(expectedNote);
    }
  });
});
