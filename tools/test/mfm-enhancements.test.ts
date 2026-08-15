import { describe, it, expect } from "vitest";
import { MfmDump } from "../src/mfm/loader.js";
import {
  buildEnhCanon,
  buildEnhFieldCanon,
  combatPatrolEnhIds,
  reconcileEnhancementEligibility,
  runEnhancements,
} from "../src/mfm/enhancements.js";

/**
 * Enhancement matching keys on `detachmentScopedId(name, detachment)`. The dump
 * appends parenthetical tags ("(Upgrade)", "(Aura)") to enhancement names, and the
 * repo now KEEPS them (the RAW GW form) — `normalizeName` treats parens as ordinary
 * characters, so a stripped repo name would never match an imported roster line.
 * buildEnhCanon therefore slugs the RAW name (regression guard for the import miss).
 */
function dump(): MfmDump {
  return new MfmDump({
    data: {
      detachment: [
        { id: "det-mm", publicationId: "p", localisations: { en: { name: "Might of the Moritoi" } } },
        {
          id: "det-cp",
          publicationId: "p",
          isCombatPatrol: true,
          localisations: { en: { name: "Synthetic Patrol Cadre" } },
        },
      ],
      enhancement: [
        {
          id: "e1",
          detachmentId: "det-mm",
          basePointsCost: 15,
          localisations: { en: { name: "Auramite Sarcophagus (Upgrade)" } },
        },
        {
          id: "e2",
          detachmentId: "det-mm",
          basePointsCost: 20,
          localisations: { en: { name: "Interred Expertise (Aura)" } },
        },
        {
          id: "e3",
          detachmentId: "det-mm",
          basePointsCost: 10,
          localisations: { en: { name: "Plain Relic" } },
        },
        {
          // A Combat-Patrol-box enhancement under a fabricated detachment so it
          // exists in no repo dir and always lands in the unmatched bucket.
          id: "e-cp",
          detachmentId: "det-cp",
          isCombatPatrol: true,
          basePointsCost: 5,
          localisations: { en: { name: "Synthetic Patrol Relic" } },
        },
      ],
    },
  });
}

const CP_ENH_ID = "synthetic-patrol-relic-synthetic-patrol-cadre";

describe("buildEnhCanon", () => {
  it("keeps trailing parenthetical tags (RAW GW form) so ids match imported roster lines", () => {
    const canon = buildEnhCanon(dump());
    expect(canon.get("auramite-sarcophagus-upgrade-might-of-the-moritoi")).toBe(15);
    expect(canon.get("interred-expertise-aura-might-of-the-moritoi")).toBe(20);
    // the stripped form must NOT be what we key on
    expect(canon.has("auramite-sarcophagus-might-of-the-moritoi")).toBe(false);
  });

  it("leaves untagged names alone", () => {
    expect(buildEnhCanon(dump()).get("plain-relic-might-of-the-moritoi")).toBe(10);
  });
});

/**
 * buildEnhFieldCanon derives the structured fields the dump can supply beyond cost:
 *   - upgrade_tag           ← enhancementType === "upgrade"
 *   - max_targets           ← limit
 *   - exclusion_keywords    ← enhancement_excluded_keyword
 *   - keyword_restrictions       ← legacy union of required-keyword members
 *   - keyword_restriction_groups ← exact OR-of-AND eligibility groups
 */
function fieldsDump(): MfmDump {
  return new MfmDump({
    data: {
      detachment: [{ id: "det", publicationId: "p", localisations: { en: { name: "Chorus of Condemnation" } } }],
      keyword: [{ id: "k-inf", localisations: { en: { name: "Infantry" } } }],
      faction_keyword: [{ id: "fk-as", localisations: { en: { name: "Adepta Sororitas" } } }],
      datasheet: [
        { id: "ds-ex", localisations: { en: { name: "Exorcist" } } },
        { id: "ds-repentia", localisations: { en: { name: "Repentia Squad" } } },
      ],
      enhancement: [
        // wargear upgrade: type=upgrade, limit=3, one group carrying datasheet Exorcist + fkw
        { id: "e-up", detachmentId: "det", enhancementType: "upgrade", limit: 3, basePointsCost: 15, localisations: { en: { name: "Symphonic Payload (Upgrade)" } } },
        // miniature: type=miniature, limit=1, single fkw group + an excluded keyword
        { id: "e-min", detachmentId: "det", enhancementType: "miniature", limit: 1, basePointsCost: 20, localisations: { en: { name: "Plain Relic" } } },
        // multi-group OR: two groups with different members
        { id: "e-multi", detachmentId: "det", enhancementType: "miniature", limit: 1, basePointsCost: 10, localisations: { en: { name: "Split Relic" } } },
      ],
      enhancement_required_keyword_group: [
        { id: "g-up", enhancementId: "e-up", datasheetId: "ds-ex" },
        { id: "g-min", enhancementId: "e-min", datasheetId: null },
        { id: "g-m1", enhancementId: "e-multi", datasheetId: null },
        { id: "g-m2", enhancementId: "e-multi", datasheetId: "ds-ex" },
      ],
      enhancement_required_keyword_group_keyword: [{ enhancementRequiredKeywordGroupId: "g-m1", keywordId: "k-inf" }],
      enhancement_required_keyword_group_faction_keyword: [
        { enhancementRequiredKeywordGroupId: "g-up", factionKeywordId: "fk-as" },
        { enhancementRequiredKeywordGroupId: "g-min", factionKeywordId: "fk-as" },
      ],
      enhancement_excluded_keyword: [{ enhancementId: "e-min", keywordId: "k-inf" }],
      enhancement_bodyguard_group: [
        { id: "bg-min", enhancementId: "e-min", bodyguardType: "leader", factionKeywordId: null },
      ],
      enhancement_bodyguard_group_datasheet: [
        { enhancementBodyguardGroupId: "bg-min", datasheetId: "ds-repentia" },
      ],
    },
  });
}

describe("buildEnhFieldCanon", () => {
  it("derives upgrade_tag, max_targets, exclusions and a datasheet+fkw restriction", () => {
    const canon = buildEnhFieldCanon(fieldsDump());
    const up = canon.get("symphonic-payload-upgrade-chorus-of-condemnation");
    expect(up).toBeDefined();
    expect(up!.upgrade_tag).toBe(true);
    expect(up!.max_targets).toBe(3);
    expect(up!.keyword_restrictions).toEqual(["Adepta Sororitas", "Exorcist"]);
    expect(up!.keyword_restriction_groups).toEqual([["Adepta Sororitas", "Exorcist"]]);
    expect(up!.keywordRestrictionsAmbiguous).toBe(false);
    expect(up!.exclusion_keywords).toBeNull();
  });

  it("maps a miniature enhancement's fkw group and its exclusion", () => {
    const min = buildEnhFieldCanon(fieldsDump()).get("plain-relic-chorus-of-condemnation")!;
    expect(min.upgrade_tag).toBe(false);
    expect(min.max_targets).toBe(1);
    expect(min.keyword_restrictions).toEqual(["Adepta Sororitas"]);
    expect(min.keyword_restriction_groups).toEqual([["Adepta Sororitas"]]);
    expect(min.exclusion_keywords).toEqual(["Infantry"]);
    expect(min.attachment_bodyguard_ids).toEqual(["repentia-squad"]);
  });

  it("preserves divergent groups as explicit alternatives", () => {
    const multi = buildEnhFieldCanon(fieldsDump()).get("split-relic-chorus-of-condemnation")!;
    expect(multi.keywordRestrictionsAmbiguous).toBe(true);
    expect(multi.keyword_restrictions).toEqual(["Exorcist", "Infantry"]);
    expect(multi.keyword_restriction_groups).toEqual([["Infantry"], ["Exorcist"]]);
  });
});

describe("authoritative enhancement eligibility", () => {
  it("replaces contradictory stale fields with the single source group", () => {
    const fields = buildEnhFieldCanon(fieldsDump()).get("plain-relic-chorus-of-condemnation")!;
    const record = {
      id: "stale",
      name: "Fabricated Relic",
      cost: 10,
      keyword_restrictions: ["Stale"],
      keyword_restriction_groups: [["Contradictory"]],
      exclusion_keywords: ["Stale"],
    };

    const result = reconcileEnhancementEligibility(record, fields);

    expect(result.eligibility?.to).toEqual({
      keyword_restrictions: ["Adepta Sororitas"],
      keyword_restriction_groups: null,
    });
    expect(result.exclusions?.to).toEqual(["Infantry"]);
    expect(record).toMatchObject({
      keyword_restrictions: ["Adepta Sororitas"],
      exclusion_keywords: ["Infantry"],
    });
    expect(record).not.toHaveProperty("keyword_restriction_groups");
  });

  it("uses groups only for divergent source alternatives and clears both when absent", () => {
    const multi = buildEnhFieldCanon(fieldsDump()).get("split-relic-chorus-of-condemnation")!;
    const record = {
      id: "stale",
      name: "Fabricated Relic",
      cost: 10,
      keyword_restrictions: ["Stale"],
      keyword_restriction_groups: [["Also stale"]],
      exclusion_keywords: ["Stale"],
    };

    reconcileEnhancementEligibility(record, multi);
    expect(record).toMatchObject({
      keyword_restriction_groups: [["Infantry"], ["Exorcist"]],
    });
    expect(record).not.toHaveProperty("keyword_restrictions");

    reconcileEnhancementEligibility(record, {
      ...multi,
      exclusion_keywords: null,
      keyword_restrictions: null,
      keyword_restriction_groups: null,
    });
    expect(record).not.toHaveProperty("keyword_restrictions");
    expect(record).not.toHaveProperty("keyword_restriction_groups");
    expect(record).not.toHaveProperty("exclusion_keywords");
  });
});

describe("combatPatrolEnhIds", () => {
  it("collects only the Combat-Patrol enhancement ids", () => {
    const cp = combatPatrolEnhIds(dump());
    expect(cp.has(CP_ENH_ID)).toBe(true);
    expect(cp.has("plain-relic-might-of-the-moritoi")).toBe(false);
    expect(cp.size).toBe(1);
  });
});

describe("runEnhancements matched-play seeding", () => {
  it("seeds a source-complete matched-play enhancement and links its detachment", () => {
    const report = runEnhancements(dump(), false);
    const id = "plain-relic-might-of-the-moritoi";
    expect(report.seeded).toContainEqual({
      dir: "adeptus-custodes",
      id,
      name: "Plain Relic",
      detachment_id: "might-of-the-moritoi",
    });
    const enhancements = report.staged
      .find((entry) => entry.path.endsWith("adeptus-custodes/enhancements.json"))
      ?.value as { id: string }[];
    expect(enhancements.some((entry) => entry.id === id)).toBe(true);
    const detachments = report.staged
      .find((entry) => entry.path.endsWith("adeptus-custodes/detachments.json"))
      ?.value as { id: string; enhancement_ids?: string[] }[];
    expect(
      detachments
        .find((entry) => entry.id === "might-of-the-moritoi")
        ?.enhancement_ids,
    ).toContain(id);
  });
});


describe("runEnhancements Combat-Patrol filtering", () => {
  it("holds Combat-Patrol enhancements out of newInDump by default", () => {
    const report = runEnhancements(dump(), false);
    expect(report.newInDump).not.toContain(CP_ENH_ID);
    expect(report.cpExcluded).toContain(CP_ENH_ID);
  });

  it("includes them when --include-combat-patrol is set", () => {
    const report = runEnhancements(dump(), false, { includeCombatPatrol: true });
    expect(report.newInDump).toContain(CP_ENH_ID);
    expect(report.cpExcluded).toHaveLength(0);
  });
});
