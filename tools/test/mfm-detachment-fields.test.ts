import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_DUMP_PATH, loadDump, MfmDump } from "../src/mfm/loader.js";
import { CORE_DIR } from "../src/mfm/repo-files.js";
import {
  applyAuthoritativeDetachmentFields,
  runDetachmentFields,
  requiredKeywordsForDetachment,
  tagsForDetachment,
  ruleIdsForDetachment,
  type DetFieldsReport,
  type DirDetFieldResult,
} from "../src/mfm/detachment-fields.js";

/**
 * WS2 detachment-field reconcile. The derivation helpers are unit-tested with
 * synthetic fixtures (no dump needed); the whole-repo reconcile is dump-guarded
 * (the dump is gitignored, so CI without it skips those).
 */

/** Minimal synthetic dump: a chapter-locked detachment, a roster-wide one, an
 *  umbrella (parent-keyword) broadening, and a unique-keyword tag. */
function fixture(): MfmDump {
  return new MfmDump({
    data: {
      faction_keyword: [
        { id: "fk-astartes", localisations: { en: { name: "Adeptus Astartes" } } },
        { id: "fk-iron", localisations: { en: { name: "Iron Hands" } } },
        { id: "fk-asuryani", localisations: { en: { name: "Asuryani" } } },
        { id: "fk-aeldari", localisations: { en: { name: "Aeldari" } } },
      ],
      keyword: [{ id: "kw-battlesuit", localisations: { en: { name: "Battlesuit" } } }],
      publication: [
        { id: "pub-astartes", factionKeywordId: "fk-astartes" },
        { id: "pub-asuryani", factionKeywordId: "fk-asuryani" },
      ],
      detachment: [
        // chapter-locked: owned by Adeptus Astartes, applies to Iron Hands only.
        { id: "d-lock", publicationId: "pub-astartes", detachmentPointsCost: 2, isCombatPatrol: false, localisations: { en: { name: "Hammer of Avernii" } } },
        // roster-wide: owned by Adeptus Astartes, applicability enumerates the roster + a chapter.
        { id: "d-wide", publicationId: "pub-astartes", detachmentPointsCost: 2, isCombatPatrol: false, localisations: { en: { name: "Gladius Task Force" } } },
        // umbrella broadening: owned by Asuryani, applies to Aeldari (the roster).
        { id: "d-umbrella", publicationId: "pub-asuryani", detachmentPointsCost: 0, isCombatPatrol: true, localisations: { en: { name: "Kygharil's Protectors" } } },
        // tagged: owned by Adeptus Astartes, carries a unique mutual-exclusivity keyword.
        { id: "d-tag", publicationId: "pub-astartes", detachmentPointsCost: 2, isCombatPatrol: false, localisations: { en: { name: "Solar Spearhead" } } },
      ],
      detachment_faction_keyword: [
        { detachmentId: "d-lock", factionKeywordId: "fk-iron" },
        { detachmentId: "d-wide", factionKeywordId: "fk-astartes" },
        { detachmentId: "d-wide", factionKeywordId: "fk-iron" },
        { detachmentId: "d-umbrella", factionKeywordId: "fk-aeldari" },
      ],
      detachment_unique_keyword: [{ detachmentId: "d-tag", keywordId: "kw-battlesuit" }],
    },
  });
}

describe("detachment-field derivation (synthetic)", () => {
  const dump = fixture();

  it("locks a detachment to the sub-faction keyword absent from the roster", () => {
    expect(requiredKeywordsForDetachment(dump, "d-lock")).toEqual(["Iron Hands"]);
  });

  it("treats a roster-wide enumeration (ownership keyword present) as no restriction", () => {
    expect(requiredKeywordsForDetachment(dump, "d-wide")).toBeNull();
  });

  it("treats an umbrella/roster keyword as a broadening, not a lock", () => {
    // Owned by Asuryani, applicable to the whole Aeldari roster → requiring "Aeldari"
    // is trivially satisfied, so no restriction is emitted.
    expect(requiredKeywordsForDetachment(dump, "d-umbrella")).toBeNull();
  });

  it("derives a lowercase mutual-exclusivity tag slug from the unique keyword", () => {
    expect(tagsForDetachment(dump, "d-tag")).toEqual(["battlesuit"]);
    expect(tagsForDetachment(dump, "d-lock")).toEqual([]);
  });

  it("collects an unresolved faction-keyword id rather than emitting a null label", () => {
    const d = new MfmDump({
      data: {
        faction_keyword: [{ id: "fk-astartes", localisations: { en: { name: "Adeptus Astartes" } } }],
        publication: [{ id: "pub", factionKeywordId: "fk-astartes" }],
        detachment: [{ id: "d", publicationId: "pub", detachmentPointsCost: 2, isCombatPatrol: false, localisations: { en: { name: "X" } } }],
        detachment_faction_keyword: [{ detachmentId: "d", factionKeywordId: "fk-missing" }],
      },
    });
    const unresolved: string[] = [];
    expect(requiredKeywordsForDetachment(d, "d", unresolved)).toBeNull();
    expect(unresolved).toContain("fk-missing");
  });
});
describe("authoritative detachment field reconciliation", () => {
  it("clears stale source fields while preserving unrelated restrictions", () => {
    const detachment = {
      tags: ["onslaught"],
      restrictions: {
        required_keywords: ["Stale Chapter"],
        excluded_keywords: ["Excluded Unit"],
        notes: "Fabricated restriction note",
      },
    };

    expect(applyAuthoritativeDetachmentFields(detachment, [], [])).toEqual({
      tagsChanged: true,
      requiredKeywordsChanged: true,
    });
    expect(detachment).toEqual({
      tags: [],
      restrictions: {
        required_keywords: [],
        excluded_keywords: ["Excluded Unit"],
        notes: "Fabricated restriction note",
      },
    });
    expect(applyAuthoritativeDetachmentFields(detachment, [], [])).toEqual({
      tagsChanged: false,
      requiredKeywordsChanged: false,
    });
  });
});


describe("detachment-rule id derivation (synthetic)", () => {
  it("slugs each dump rule display name to a sorted, de-duplicated bare id", () => {
    const dump = new MfmDump({
      data: {
        detachment: [{ id: "d", localisations: { en: { name: "X" } } }],
        detachment_rule: [
          { id: "r1", detachmentId: "d", displayOrder: 1, localisations: { en: { name: "Warp Rifts" } } },
          { id: "r2", detachmentId: "d", displayOrder: 0, localisations: { en: { name: "Prey on the Weak" } } },
          // apostrophe/diacritic normalization mirrors the authored ability-id form.
          { id: "r3", detachmentId: "d", displayOrder: 2, localisations: { en: { name: "Vulkan’s Quest" } } },
        ],
      },
    });
    expect(ruleIdsForDetachment(dump, "d")).toEqual(["prey-on-the-weak", "vulkans-quest", "warp-rifts"]);
  });

  it("returns an empty list when the detachment has no dump rule", () => {
    const dump = new MfmDump({
      data: { detachment: [{ id: "d", localisations: { en: { name: "X" } } }], detachment_rule: [] },
    });
    expect(ruleIdsForDetachment(dump, "d")).toEqual([]);
  });
});

describe.skipIf(!fs.existsSync(DEFAULT_DUMP_PATH))("detachment-fields over the real dump", () => {
  // Load the dump lazily in beforeAll — never in the describe body, which Vitest
  // executes at collection time regardless of skipIf, before the guard applies.
  let report: DetFieldsReport;
  let byDir: Map<string, DirDetFieldResult>;
  beforeAll(() => {
    report = runDetachmentFields(loadDump());
    byDir = new Map<string, DirDetFieldResult>(report.dirs.map((d) => [d.dir, d]));
  });
  // `sum` reads `report` lazily — only ever called inside it() bodies (post-beforeAll).
  const sum = (f: (d: DirDetFieldResult) => number) => report.dirs.reduce((a, d) => a + f(d), 0);

  it("reconciles mutual-exclusivity tags authoritatively", () => {
    expect(sum((d) => d.tagsChanged.length + d.tagsConfirmed)).toBeGreaterThan(0);
  });

  it("locks chapter-specific detachments in their routed directories", () => {
    expect(byDir.get("iron-hands")?.matched).toBeGreaterThan(0);
    const hammer = JSON.parse(
      fs.readFileSync(path.join(CORE_DIR, "iron-hands", "detachments.json"), "utf8"),
    ).find((d: { id: string }) => d.id === "hammer-of-avernii") as { restrictions?: { required_keywords?: string[] } };
    expect(hammer.restrictions?.required_keywords).toEqual(["Iron Hands"]);
  });

  it("does not spuriously lock the Aeldari Combat-Patrol detachment to its own roster", () => {
    const aeldari = byDir.get("aeldari");
    expect(aeldari?.reqChanged.some((r) => r.id === "kygharils-protectors" && r.to.length > 0)).not.toBe(true);
  });

  it("only stages dirs it actually changed", () => {
    for (const s of report.staged) expect(s.path).toMatch(/detachments\.json$/);
  });

  it("verifies detachment_rule links against the dump — confirm-heavy, no invented fills", () => {
    // The rule abilities are already authored, so the reconcile confirms the vast
    // majority and never invents a link (a fill only fires when a slug resolves to
    // an authored ability, which none currently need).
    expect(sum((d) => d.ruleConfirmed)).toBeGreaterThan(100);
    expect(sum((d) => d.ruleFilled.length)).toBe(0);
  });

  it("surfaces authored rule links the dump disagrees with, never overwriting them", () => {
    const reviews = report.dirs.flatMap((d) => d.ruleReview);
    // Armoured Infantry: the dump lists a second rule (order) the repo has not linked.
    const armoured = reviews.find((r) => r.id === "armoured-infantry");
    expect(armoured?.derived).toEqual(["order", "squadron-command"]);
    expect(armoured?.authored).toEqual(["squadron-command"]);
    // The authored value on disk is untouched (surfaced, not overwritten).
    const rec = JSON.parse(
      fs.readFileSync(path.join(CORE_DIR, "astra-militarum", "detachments.json"), "utf8"),
    ).find((d: { id: string }) => d.id === "armoured-infantry") as {
      detachment_rule_id?: string;
      detachment_rule_ids?: string[];
    };
    expect(rec.detachment_rule_id ?? rec.detachment_rule_ids?.join()).not.toContain("order");
    // The two scoped-vs-bare id-form drifts are also surfaced (not auto-normalized).
    expect(reviews.some((r) => r.id === "murdertalon-raiders")).toBe(true);
    expect(reviews.some((r) => r.id === "more-dakka")).toBe(true);
  });

  it("surfaces detachments whose dump rule has no authored ability as a worklist", () => {
    // The new 11e chapter detachments carry a dump rule the repo has not authored an
    // ability for yet — reported, never filled (prose is authored separately).
    expect(sum((d) => d.ruleUnauthored.length)).toBeGreaterThan(0);
  });
});
