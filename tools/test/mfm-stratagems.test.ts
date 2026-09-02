import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_DUMP_PATH, loadDump, MfmDump } from "../src/mfm/loader.js";
import { CORE_DIR } from "../src/mfm/repo-files.js";
import { nameToId, detachmentScopedId } from "../src/converters/id-generator.js";
import { buildStratCanon, runStratagems, deriveTrigger, type StratagemCanon } from "../src/mfm/stratagems.js";
import { seedStratagems } from "../src/mfm/seed-stratagems.js";

/**
 * WS4 stratagem field reconcile. The canon derivation (dump row → first-class
 * player_turn/type/category) is unit-tested with synthetic fixtures; the
 * whole-repo reconcile is dump-guarded (the dump is gitignored, so CI without it
 * skips those). The load-bearing contract this pins: phases are NEVER written from
 * the buggy `stratagem_phase` index — authored phases win.
 */

/** Minimal synthetic dump: a detachment-scoped battle tactic, a core stratagem
 *  with a null category, and a detachment-scoped opponent-turn epic deed. */
function fixture(): MfmDump {
  return new MfmDump({
    data: {
      detachment: [
        { id: "d1", localisations: { en: { name: "Bastion Task Force" } } },
      ],
      stratagem: [
        {
          id: "s1",
          key: "eitherPlayer",
          category: "battleTactic",
          cpCost: "1",
          detachmentId: "d1",
          localisations: { en: { name: "Codex Discipline", whenRules: "Your Shooting phase or the Fight phase." } },
        },
        {
          id: "s2",
          key: "yourTurn",
          category: null,
          cpCost: "1",
          detachmentId: null,
          localisations: { en: { name: "Insane Bravery", whenRules: "Battle-shock step of your Command phase." } },
        },
        {
          id: "s3",
          key: "opponentsTurn",
          category: "epicDeed",
          cpCost: "2",
          detachmentId: "d1",
          localisations: { en: { name: "Sudden Reprisal", whenRules: "Your opponent's Movement phase." } },
        },
      ],
    },
  });
}

describe("stratagem canon derivation (synthetic)", () => {
  const canon = buildStratCanon(fixture());

  it("maps the first-class key to player_turn (eitherPlayer => either)", () => {
    const c = canon.get(detachmentScopedId("Codex Discipline", "Bastion Task Force"))!;
    expect(c.player_turn).toBe("either");
    expect(c.type).toBe("battle-tactic");
    expect(c.category).toBe("detachment");
    expect(c.cp_cost).toBe(1);
  });

  it("treats a null detachmentId as the core category and a null category as no type", () => {
    const c = canon.get(nameToId("Insane Bravery"))!;
    expect(c.player_turn).toBe("your-turn");
    expect(c.category).toBe("core");
    expect(c.type).toBeNull();
  });

  it("maps opponentsTurn => opponent-turn and epicDeed => epic-deed", () => {
    const c = canon.get(detachmentScopedId("Sudden Reprisal", "Bastion Task Force"))!;
    expect(c.player_turn).toBe("opponent-turn");
    expect(c.type).toBe("epic-deed");
  });

  it("derives review-only phases from whenRules prose (both phases of an 'or' idiom)", () => {
    const c = canon.get(detachmentScopedId("Codex Discipline", "Bastion Task Force"))!;
    expect(c.phases_review).toEqual(expect.arrayContaining(["shooting", "fight"]));
  });
});

describe("deriveTrigger (phases review)", () => {
  it("returns null phases when prose is absent", () => {
    expect(deriveTrigger(null).phases).toBeNull();
  });
  it("collects every named phase in the prose", () => {
    expect(deriveTrigger("Your Movement phase or Charge phase.").phases).toEqual(
      expect.arrayContaining(["movement", "charge"]),
    );
  });
});

describe.skipIf(!fs.existsSync(DEFAULT_DUMP_PATH))("stratagem reconcile over the real dump", () => {
  // Load the dump lazily in beforeAll — never in the describe body, which Vitest
  // executes at collection time regardless of skipIf, before the guard applies.
  let dump: MfmDump;
  let canon: Map<string, StratagemCanon>;
  beforeAll(() => {
    dump = loadDump();
    canon = buildStratCanon(dump);
  });

  it("derives player_turn/type/category for a known detachment stratagem", () => {
    const c = canon.get("codex-discipline-bastion-task-force")!;
    expect(c.player_turn).toBe("either");
    expect(c.type).toBe("battle-tactic");
    expect(c.category).toBe("detachment");
  });

  it("never overwrites authored phases from the buggy stratagem_phase index", () => {
    // Insane Bravery is a core (detachment-less) Command-phase battle-shock
    // stratagem in the root store; stratagem_phase wrongly tags it chargePhase.
    // The reconcile must leave authored phases intact.
    const file = path.join(CORE_DIR, "stratagems.json");
    const rec = JSON.parse(fs.readFileSync(file, "utf8")).find(
      (s: { id: string }) => s.id === "insane-bravery",
    ) as { phases: string[] };
    expect(rec.phases).toEqual(["command"]);
  });

  it("reflects the applied dump player_turn in the data (idempotent end-state)", () => {
    const file = path.join(CORE_DIR, "adeptus-astartes", "stratagems.json");
    const rec = JSON.parse(fs.readFileSync(file, "utf8")).find(
      (s: { id: string }) => s.id === "codex-discipline-bastion-task-force",
    ) as { player_turn: string };
    expect(rec.player_turn).toBe("either");
  });

  it("never writes a type that conflicts with an authored one (fill-only contract)", () => {
    const report = runStratagems(dump, false);
    const conflicts = report.dirs.reduce((a, d) => a + d.typeConflict.length, 0);
    expect(conflicts).toBe(0);
  });

  it("only stages stratagems.json files", () => {
    const report = runStratagems(dump, false);
    for (const s of report.staged) expect(s.path).toMatch(/stratagems\.json$/);
  });
});

describe.skipIf(!fs.existsSync(DEFAULT_DUMP_PATH))("seedStratagems over the real dump", () => {
  // Load the dump lazily in beforeAll — never in the describe body, which Vitest
  // executes at collection time regardless of skipIf, before the guard applies.
  let dump: MfmDump;
  let report: ReturnType<typeof seedStratagems>;
  beforeAll(() => {
    dump = loadDump();
    report = seedStratagems(dump);
  });

  it("is idempotent — the competitive set is already seeded (0 new)", () => {
    expect(report.seeded.length).toBe(0);
    for (const s of report.staged) expect(s.path).toMatch(/stratagems\.json$/);
  });

  it("is idempotent after the complete sync includes Combat Patrol records", () => {
    expect(report.heldBackCombatPatrol).toEqual([]);
    expect(seedStratagems(dump, { includeCombatPatrol: true }).seeded).toEqual([]);
  });

  it("does not re-seed entries excluded by current Codex rosters", () => {
    expect(report.skippedOutsideRoster).toContain("krump-em-ardmob");
  });
  it("skips coreless dump stratagems (universal core set is complete; spelling mismatches)", () => {
    // The dump's one-word "Counteroffensive" must NOT seed a duplicate of the
    // authored core "counter-offensive"; coreless rows are held for manual review.
    expect(report.skippedCoreless).toContain("counteroffensive");
  });

  it("persists legal provisional skeletons from the completed sync", () => {
    const file = path.join(CORE_DIR, "adepta-sororitas", "stratagems.json");
    const records = JSON.parse(fs.readFileSync(file, "utf8")) as {
      category: string;
      phases: string[];
      timing: string;
      player_turn: string;
      game_version: { dataslate: string };
    }[];
    const rec = records.find((record) => record.game_version.dataslate === "pre-launch-provisional");
    expect(rec).toBeDefined();
    expect(rec!.category).toBe("detachment");
    expect(rec!.phases.length).toBeGreaterThan(0);
    expect(rec!.timing).toBe("once-per-phase");
    expect(["your-turn", "opponent-turn", "either"]).toContain(rec!.player_turn);
  });
});
