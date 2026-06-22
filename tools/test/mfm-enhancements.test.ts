import { describe, it, expect } from "vitest";
import { MfmDump } from "../src/mfm/loader.js";
import { buildEnhCanon, combatPatrolEnhIds, runEnhancements } from "../src/mfm/enhancements.js";

/**
 * Enhancement matching keys on `detachmentScopedId(name, detachment)`. The dump
 * appends parenthetical tags ("(Upgrade)", "(Aura)") to enhancement names that
 * the repo id omits — buildEnhCanon must strip them, or upgrade-tag enhancements
 * silently fail to match (regression guard for the systematic miss found in 3A).
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
  it("strips trailing parenthetical tags so upgrade/aura enhancements match repo ids", () => {
    const canon = buildEnhCanon(dump());
    expect(canon.get("auramite-sarcophagus-might-of-the-moritoi")).toBe(15);
    expect(canon.get("interred-expertise-might-of-the-moritoi")).toBe(20);
    // the tagged form must NOT be what we key on
    expect(canon.has("auramite-sarcophagus-upgrade-might-of-the-moritoi")).toBe(false);
  });

  it("leaves untagged names alone", () => {
    expect(buildEnhCanon(dump()).get("plain-relic-might-of-the-moritoi")).toBe(10);
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
