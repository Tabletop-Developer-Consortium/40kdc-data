/**
 * Yellowscribe (.ros) serializer unit tests. Asserts the BattleScribe XML the
 * roszParser reads: the required gameSystemId, unit/model/upgrade nesting, stat
 * conventions, TOTAL weapon counts, keyword labels, describer-sourced ability
 * text, deterministic ids, and the loadout-group vs flat-wargear fallback.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Dataset } from "../../src/data/dataset.js";
import { exportRoster } from "../../src/export/index.js";
import { yellowscribeSerializer } from "../../src/export/yellowscribe.js";
import type { Roster } from "../../src/import/types.js";

const ds = Dataset.embedded();

const seed = (caseName: string): Roster =>
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`../../../conformance/roster/${caseName}/expected.roster.json`, import.meta.url),
      ),
      "utf8",
    ),
  ) as Roster;

// A rich case: multi-model Chaos Terminators with a decomposed loadout, plus a
// single-model Daemon Prince with ranged + melee (multi-profile) weapons.
const terminators = seed("we-terminators");

describe("yellowscribeSerializer", () => {
  it("emits the BattleScribe 10e gameSystemId (Yellowscribe rejects otherwise)", () => {
    const out = yellowscribeSerializer.serialize(terminators, ds);
    expect(out.startsWith('<?xml version="1.0" encoding="utf-8"?>\n')).toBe(true);
    expect(out).toContain('gameSystemId="sys-352e-adc2-7639-d6a9"');
    expect(out.endsWith("\n")).toBe(true);
  });

  it("nests unit > model > upgrade selections with the right type attributes", () => {
    const out = yellowscribeSerializer.serialize(terminators, ds);
    expect(out).toContain('type="unit"');
    expect(out).toContain('type="model"');
    expect(out).toContain('type="upgrade"');
  });

  it("renders unit stat conventions (M with \", Sv/Ld with +)", () => {
    const out = yellowscribeSerializer.serialize(terminators, ds);
    expect(out).toMatch(/<characteristic name="M">\d+"<\/characteristic>/);
    expect(out).toMatch(/<characteristic name="SV">\d+\+<\/characteristic>/);
    expect(out).toMatch(/<characteristic name="LD">\d+\+<\/characteristic>/);
  });

  it("distinguishes ranged (BS) from melee (WS + Melee range)", () => {
    const out = yellowscribeSerializer.serialize(terminators, ds);
    expect(out).toContain('typeName="Ranged Weapons"');
    expect(out).toContain('typeName="Melee Weapons"');
    expect(out).toContain('<characteristic name="BS">');
    expect(out).toContain('<characteristic name="WS">');
    expect(out).toContain('<characteristic name="Range">Melee</characteristic>');
  });

  it("emits weapon counts as TOTALS (perModel x modelCount)", () => {
    const out = yellowscribeSerializer.serialize(terminators, ds);
    // The 4-model Terminator group carries a Combi-weapon each → total 4.
    expect(out).toMatch(/name="World Eaters Terminator" type="model" number="4"/);
    expect(out).toMatch(/name="Combi-weapon" type="upgrade" number="4"/);
  });

  it("labels rated weapon keywords (Rapid Fire 1)", () => {
    const out = yellowscribeSerializer.serialize(terminators, ds);
    expect(out).toContain("Rapid Fire 1");
  });

  it("sources ability text from the describer and XML-escapes it", () => {
    const out = yellowscribeSerializer.serialize(terminators, ds);
    expect(out).toContain('typeName="Abilities"');
    expect(out).toContain('<characteristic name="Description">');
    // Describer prose contains `>` (e.g. "on a 6+"), which must be escaped.
    expect(out).toContain("&gt;");
    // The invuln save is emitted as a numeric-fact ability.
    expect(out).toMatch(/<characteristic name="Description">\d+\+ invulnerable save<\/characteristic>/);
  });

  it("emits faction keywords with the Faction: prefix", () => {
    const out = yellowscribeSerializer.serialize(terminators, ds);
    expect(out).toContain('<category name="Faction: World Eaters"/>');
  });

  it("is deterministic and reachable via exportRoster with the dataset arg", () => {
    const a = yellowscribeSerializer.serialize(terminators, ds);
    const b = exportRoster(terminators, "yellowscribe", ds);
    expect(a).toBe(b);
    expect(exportRoster(terminators, "yellowscribe", ds)).toBe(a);
  });

  it("throws if the dataset arg is omitted for a Dataset-backed format", () => {
    expect(() => exportRoster(terminators, "yellowscribe")).toThrow(/requires a dataset/);
  });

  it("falls back to a single model selection when a unit has no loadout_groups", () => {
    // Build a minimal roster whose unit carries flat wargear and no groups.
    const base = terminators.units[0];
    const roster: Roster = {
      ...terminators,
      units: [{ ...base, loadout_groups: undefined }],
    };
    const out = yellowscribeSerializer.serialize(roster, ds);
    const modelSelections = out.match(/type="model"/g) ?? [];
    expect(modelSelections.length).toBe(1);
  });
});
