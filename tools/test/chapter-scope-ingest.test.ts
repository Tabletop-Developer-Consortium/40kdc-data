import { describe, it, expect } from "vitest";
import { MfmDump } from "../src/mfm/loader.js";
import { buildChapterScopeCanon } from "../src/mfm/chapter-scope.js";

/**
 * The chapter-scope ingest derives Space Marine chapter access from the dump
 * (issue #36). `buildChapterScopeCanon` is the pure seam under test — the two
 * derivation rules over `datasheet_faction_keyword` +
 * `faction_keyword_excluded_datasheet`:
 *   - faction_keywords: collapse to generic `[Adeptus Astartes]` whenever a
 *     generic datasheet exists for a name (the Black Templars exclude-and-replace
 *     twins); keep the chapter keyword only when every datasheet is chapter-locked.
 *   - excluded_faction_keywords: a chapter that excludes a generic datasheet with
 *     NO same-name replacement bars it (Librarians for BT, Terminator Squad for
 *     Deathwatch); a chapter with a same-name twin does NOT (the twin collapses).
 * A synthetic dump keeps it runnable without _private/dump.json.
 */
function dump(): MfmDump {
  return new MfmDump({
    data: {
      faction_keyword: [
        { id: "fk-aa", parentFactionKeywordId: null, localisations: { en: { name: "Adeptus Astartes" } } },
        { id: "fk-bt", parentFactionKeywordId: "fk-aa", localisations: { en: { name: "Black Templars" } } },
        { id: "fk-dw", parentFactionKeywordId: "fk-aa", localisations: { en: { name: "Deathwatch" } } },
        // Not a child of Adeptus Astartes — its exclusions must be ignored.
        { id: "fk-gk", parentFactionKeywordId: null, localisations: { en: { name: "Grey Knights" } } },
      ],
      datasheet: [
        { id: "ds-rep-g", isLegends: false, localisations: { en: { name: "Repulsor" } } },
        { id: "ds-rep-bt", isLegends: false, localisations: { en: { name: "Repulsor" } } },
        { id: "ds-hel", isLegends: false, localisations: { en: { name: "High Marshal Helbrecht" } } },
        { id: "ds-lib", isLegends: false, localisations: { en: { name: "Librarian" } } },
        { id: "ds-term", isLegends: false, localisations: { en: { name: "Terminator Squad" } } },
      ],
      datasheet_faction_keyword: [
        { id: "x1", displayOrder: 1, datasheetId: "ds-rep-g", factionKeywordId: "fk-aa" },
        { id: "x2", displayOrder: 1, datasheetId: "ds-rep-bt", factionKeywordId: "fk-aa" },
        { id: "x3", displayOrder: 2, datasheetId: "ds-rep-bt", factionKeywordId: "fk-bt" },
        { id: "x4", displayOrder: 1, datasheetId: "ds-hel", factionKeywordId: "fk-aa" },
        { id: "x5", displayOrder: 2, datasheetId: "ds-hel", factionKeywordId: "fk-bt" },
        { id: "x6", displayOrder: 1, datasheetId: "ds-lib", factionKeywordId: "fk-aa" },
        { id: "x7", displayOrder: 1, datasheetId: "ds-term", factionKeywordId: "fk-aa" },
      ],
      faction_keyword_excluded_datasheet: [
        // BT excludes generic Repulsor but a BT twin exists → exclude-and-replace, NOT a bar.
        { factionKeywordId: "fk-bt", datasheetId: "ds-rep-g" },
        // BT excludes Librarian with no replacement → genuine bar.
        { factionKeywordId: "fk-bt", datasheetId: "ds-lib" },
        // Deathwatch excludes the generic Terminator Squad (its replacement is renamed) → bar.
        { factionKeywordId: "fk-dw", datasheetId: "ds-term" },
      ],
    },
  });
}

describe("buildChapterScopeCanon", () => {
  it("collapses an exclude-and-replace twin to generic faction_keywords (issue #36)", () => {
    const canon = buildChapterScopeCanon(dump());
    expect(canon.get("repulsor")).toEqual({
      name: "Repulsor",
      factionKeywords: ["Adeptus Astartes"],
      excludedKeywords: [],
    });
  });

  it("keeps the chapter keyword when every datasheet is chapter-locked", () => {
    const canon = buildChapterScopeCanon(dump());
    expect(canon.get("high-marshal-helbrecht")).toEqual({
      name: "High Marshal Helbrecht",
      factionKeywords: ["Adeptus Astartes", "Black Templars"],
      excludedKeywords: [],
    });
  });

  it("bars a generic unit a chapter excludes with no same-name replacement", () => {
    const canon = buildChapterScopeCanon(dump());
    expect(canon.get("librarian")).toEqual({
      name: "Librarian",
      factionKeywords: ["Adeptus Astartes"],
      excludedKeywords: ["Black Templars"],
    });
    expect(canon.get("terminator-squad")).toEqual({
      name: "Terminator Squad",
      factionKeywords: ["Adeptus Astartes"],
      excludedKeywords: ["Deathwatch"],
    });
  });

  it("ignores exclusions from factions that are not children of Adeptus Astartes", () => {
    const canon = buildChapterScopeCanon(dump());
    // Grey Knights is not a chapter; even if it appeared in the exclusion table
    // it must never produce a bar on an Adeptus Astartes unit.
    for (const scope of canon.values()) {
      expect(scope.excludedKeywords).not.toContain("Grey Knights");
    }
  });
});
