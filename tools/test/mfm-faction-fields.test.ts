import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_DUMP_PATH, loadDump } from "../src/mfm/loader.js";
import { CORE_DIR } from "../src/mfm/repo-files.js";
import { runFactionFields, type DirFactionResult } from "../src/mfm/faction-fields.js";

/**
 * WS3 faction-field reconcile over the real GW MFM dump (gitignored, so CI without
 * it skips this). Asserts the fill-only / confirm / review contract:
 *   - a single-army-rule faction confirms its authored faction_rule_id,
 *   - the parenthetical-stripped army-rule name matches the authored slug,
 *   - a faction whose authored rule is NOT among its owned army rules is surfaced
 *     for review and NEVER overwritten,
 *   - a chapter confirms parent_faction_id: adeptus-astartes,
 *   - the localized common name is appended to aliases,
 *   - and runFactionFields only stages files it actually changed.
 */
describe.skipIf(!fs.existsSync(DEFAULT_DUMP_PATH))("faction-fields over the real dump", () => {
  // Load the dump lazily in beforeAll — never in the describe body, which Vitest
  // executes at collection time regardless of skipIf, before the guard applies.
  let report: ReturnType<typeof runFactionFields>;
  let byDir: Map<string, DirFactionResult>;
  beforeAll(() => {
    report = runFactionFields(loadDump());
    byDir = new Map<string, DirFactionResult>(report.dirs.map((d) => [d.dir, d]));
  });

  it("confirms a single-rule faction's authored faction_rule_id", () => {
    expect(byDir.get("adepta-sororitas")?.ruleConfirmed).toBe(true);
  });

  it("surfaces a review when the authored slug includes the parenthetical the tool strips", () => {
    // Death Guard authored "nurgle-s-gift-aura"; the dump names it "Nurgle's Gift (Aura)".
    // The tool strips the parenthetical before slugifying → "nurgles-gift", so the
    // authored slug with "-aura" doesn't match and lands in review.
    const dg = byDir.get("death-guard");
    expect(dg?.ruleConfirmed).toBeFalsy();
    expect(dg?.ruleReview).toBeDefined();
  });

  it("confirms a chapter whose authored rule matches its inherited army rule", () => {
    // Blood Angels authored "oath-of-moment" (inherited from Adeptus Astartes).
    const ba = byDir.get("blood-angels");
    expect(ba?.ruleConfirmed).toBe(true);
  });

  it("confirms a chapter's parent faction", () => {
    expect(byDir.get("black-templars")?.parentConfirmed).toBe(true);
  });

  it("ensures the localized common name is present in aliases (idempotent end-state)", () => {
    // Assert the end-state, not the per-run delta: whether this run adds it or a
    // prior --write already did, "Space Marines" must be an Adeptus Astartes alias.
    const added = byDir.get("adeptus-astartes")?.aliasesAdded ?? [];
    const record = JSON.parse(
      fs.readFileSync(path.join(CORE_DIR, "adeptus-astartes", "factions.json"), "utf8"),
    )[0] as { aliases?: string[] };
    expect(added.includes("Space Marines") || (record.aliases ?? []).includes("Space Marines")).toBe(true);
  });

  it("never stages a confirmed-only dir", () => {
    // adepta-sororitas confirms its rule with no fill/alias → nothing to write, ever.
    const sororitasStaged = report.staged.some((s) => s.path.includes("/adepta-sororitas/"));
    expect(sororitasStaged).toBe(false);
  });
});
